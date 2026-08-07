import { google, type gmail_v1 } from "googleapis";
import { randomBytes } from "node:crypto";
import type { MailClient, ThreadSnapshot } from "./types";

export function buildQuery(sinceMs: number): string {
  return `after:${Math.floor(sinceMs / 1000) - 1} -in:spam -in:trash`;
}

export function buildForwardRaw(opts: {
  to: string; from: string; subject: string; comment: string; originalRawB64url: string;
}): string {
  const boundary = "fwd-" + randomBytes(12).toString("hex");
  const original = Buffer.from(opts.originalRawB64url, "base64url").toString("utf8");
  const mime = [
    `From: ${opts.from}`, `To: ${opts.to}`, `Subject: ${opts.subject}`, "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", opts.comment, "",
    `--${boundary}`, "Content-Type: message/rfc822", "Content-Disposition: attachment", "",
    original, `--${boundary}--`, "",
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

function authClient() {
  // Primary: OAuth refresh token granted directly by pro@agency.example (single-mailbox
  // blast radius; user declined domain-wide delegation — spec §2, 2026-08-06).
  if (process.env.GOOGLE_OAUTH_CLIENT_ID) {
    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET
    );
    oauth2.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
    return oauth2;
  }
  // Alternative: service account with domain-wide delegation.
  return new google.auth.JWT({
    email: process.env.GOOGLE_SA_EMAIL,
    key: process.env.GOOGLE_SA_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    scopes: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
    ],
    subject: process.env.GMAIL_USER, // impersonate pro@agency.example via DWD
  });
}

function monthsAgoQuery(months: number, sent?: boolean): string {
  const sinceMs = Date.now() - months * 30 * 86_400_000;
  const q = `after:${Math.floor(sinceMs / 1000)}`;
  return sent ? `in:sent ${q}` : q;
}

export function makeGmail(api?: gmail_v1.Gmail): MailClient {
  const gmail = api ?? google.gmail({ version: "v1", auth: authClient() });
  let labelMap: Map<string, string> | null = null; // name -> id

  async function loadLabelMap(): Promise<Map<string, string>> {
    if (!labelMap) {
      const { data } = await gmail.users.labels.list({ userId: "me" });
      labelMap = new Map((data.labels ?? []).map((l) => [l.name!, l.id!]));
    }
    return labelMap;
  }

  async function labelIds(names: string[]): Promise<string[]> {
    const map = await loadLabelMap();
    return names.map((n) => {
      const id = map.get(n);
      if (!id) throw new Error(`unknown Gmail label: ${n}`);
      return id;
    });
  }

  function headerOf(payload: gmail_v1.Schema$MessagePart | undefined, name: string): string {
    return (
      payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? ""
    );
  }

  function snapshotFromThread(threadId: string, thread: gmail_v1.Schema$Thread, opts?: { sent?: boolean }): ThreadSnapshot | null {
    const messages = thread.messages ?? [];
    const msg = opts?.sent ? messages[messages.length - 1] : messages[0];
    if (!msg) return null;
    return {
      threadId,
      from: headerOf(msg.payload, "From"),
      to: headerOf(msg.payload, "To").split(/\s*,\s*/).filter(Boolean),
      subject: headerOf(msg.payload, "Subject"),
      listId: headerOf(msg.payload, "List-Id") || null,
      attachments: collectFilenames(msg.payload),
      bodyText: collectText(msg.payload),
      internalDateMs: Number(msg.internalDate ?? 0),
      references: headerOf(msg.payload, "References").split(/\s+/).filter(Boolean),
    };
  }

  return {
    async listNewThreads(sinceMs, opts) {
      const out: ThreadSnapshot[] = [];
      let pageToken: string | undefined;
      const q = opts?.sent ? `in:sent ${buildQuery(sinceMs)}` : buildQuery(sinceMs);
      do {
        const { data } = await gmail.users.threads.list({
          userId: "me", q, maxResults: 100, pageToken,
        });
        for (const t of data.threads ?? []) {
          const { data: full } = await gmail.users.threads.get({ userId: "me", id: t.id!, format: "full" });
          const snap = snapshotFromThread(t.id!, full, opts);
          if (snap) out.push(snap);
        }
        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken);
      return out;
    },

    async *listHistory(opts) {
      let pageToken: string | undefined;
      let yielded = 0;
      const q = monthsAgoQuery(opts.months, opts.sent);
      do {
        const { data } = await gmail.users.threads.list({
          userId: "me", q, maxResults: 100, pageToken,
        });
        for (const t of data.threads ?? []) {
          if (yielded >= opts.maxThreads) return;
          const { data: full } = await gmail.users.threads.get({ userId: "me", id: t.id!, format: "full" });
          const snap = snapshotFromThread(t.id!, full, opts);
          if (snap) {
            yield snap;
            yielded++;
          }
        }
        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken && yielded < opts.maxThreads);
    },

    async ensureCategories(names) {
      const map = await loadLabelMap();
      for (const name of names) {
        if (map.has(name)) continue;
        try {
          const { data } = await gmail.users.labels.create({
            userId: "me", requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
          });
          map.set(name, data.id!);
        } catch (e: unknown) {
          // 409/duplicate: another actor created it concurrently — treat as success.
          const code = (e as { code?: number; status?: number })?.code ?? (e as { status?: number })?.status;
          const message = e instanceof Error ? e.message : String(e);
          if (code === 409 || /duplicate/i.test(message)) {
            const { data } = await gmail.users.labels.list({ userId: "me" });
            labelMap = new Map((data.labels ?? []).map((l) => [l.name!, l.id!]));
          } else {
            throw e;
          }
        }
      }
    },

    async applyCategories(threadId, names) {
      await gmail.users.threads.modify({
        userId: "me", id: threadId, requestBody: { addLabelIds: await labelIds(names) },
      });
    },

    async forward(threadId, to, contextBody) {
      const { data: full } = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
      const first = full.messages?.[0];
      if (!first?.id) throw new Error(`thread ${threadId} has no messages`);
      const { data: rawMsg } = await gmail.users.messages.get({ userId: "me", id: first.id, format: "raw" });
      const subject = headerOf(first.payload, "Subject") || "(no subject)";
      const raw = buildForwardRaw({
        to, from: process.env.GMAIL_USER!, subject: `Fwd: ${subject}`,
        comment: contextBody, originalRawB64url: rawMsg.raw!,
      });
      await gmail.users.messages.send({ userId: "me", requestBody: { raw, threadId } });
    },

    async sendMessage(to, subject, body) {
      const mime = [`From: ${process.env.GMAIL_USER}`, `To: ${to}`, `Subject: ${subject}`, "", body].join("\r\n");
      await gmail.users.messages.send({
        userId: "me", requestBody: { raw: Buffer.from(mime, "utf8").toString("base64url") },
      });
    },
  };
}

// Byte-array vs base64 lesson from Phase 0 does not apply here (googleapis returns
// base64url strings) — but decode defensively and never let one bad part throw.
function collectText(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  const stack = [payload]; let plain = ""; let html = "";
  while (stack.length) {
    const p = stack.pop()!;
    if (p.mimeType === "message/rfc822") continue;
    for (const c of p.parts ?? []) stack.push(c);
    if (p.body?.data && !p.filename) {
      const text = Buffer.from(p.body.data, "base64url").toString("utf8");
      if (!plain && p.mimeType === "text/plain") plain = text;
      else if (!html && p.mimeType === "text/html") html = text;
    }
  }
  return plain || html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
}

function collectFilenames(payload: gmail_v1.Schema$MessagePart | undefined): string[] {
  if (!payload) return [];
  const out: string[] = []; const stack = [payload];
  while (stack.length) {
    const p = stack.pop()!;
    for (const c of p.parts ?? []) stack.push(c);
    if (p.filename) out.push(p.filename);
  }
  return out;
}

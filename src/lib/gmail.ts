import { google, type gmail_v1 } from "googleapis";
import { randomBytes } from "node:crypto";
import type { ThreadSnapshot } from "./normalize";

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

export interface GmailClient {
  listNewThreads(sinceMs: number): Promise<ThreadSnapshot[]>;
  applyLabels(threadId: string, labelNames: string[]): Promise<void>;
  forward(threadId: string, to: string): Promise<void>;
  sendAlert(to: string, subject: string, body: string): Promise<void>;
}

export function makeGmail(api?: gmail_v1.Gmail): GmailClient {
  const gmail = api ?? google.gmail({ version: "v1", auth: authClient() });
  let labelMap: Map<string, string> | null = null; // name -> id

  async function labelIds(names: string[]): Promise<string[]> {
    if (!labelMap) {
      const { data } = await gmail.users.labels.list({ userId: "me" });
      labelMap = new Map((data.labels ?? []).map((l) => [l.name!, l.id!]));
    }
    return names.map((n) => {
      const id = labelMap!.get(n);
      if (!id) throw new Error(`unknown Gmail label: ${n}`);
      return id;
    });
  }

  return {
    async listNewThreads(sinceMs) {
      const out: ThreadSnapshot[] = [];
      let pageToken: string | undefined;
      do {
        const { data } = await gmail.users.threads.list({
          userId: "me", q: buildQuery(sinceMs), maxResults: 100, pageToken,
        });
        for (const t of data.threads ?? []) {
          const { data: full } = await gmail.users.threads.get({ userId: "me", id: t.id!, format: "full" });
          const first = full.messages?.[0];
          if (!first) continue;
          const h = (name: string) =>
            first.payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
          out.push({
            threadId: t.id!,
            from: h("From"),
            subject: h("Subject"),
            listId: h("List-Id") || null,
            attachments: collectFilenames(first.payload),
            bodyText: collectText(first.payload),
            internalDateMs: Number(first.internalDate ?? 0),
          });
        }
        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken);
      return out;
    },

    async applyLabels(threadId, labelNames) {
      await gmail.users.threads.modify({
        userId: "me", id: threadId, requestBody: { addLabelIds: await labelIds(labelNames) },
      });
    },

    async forward(threadId, to) {
      const { data: full } = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
      const first = full.messages?.[0];
      if (!first?.id) throw new Error(`thread ${threadId} has no messages`);
      const { data: rawMsg } = await gmail.users.messages.get({ userId: "me", id: first.id, format: "raw" });
      const subject =
        first.payload?.headers?.find((x) => x.name?.toLowerCase() === "subject")?.value ?? "(no subject)";
      const raw = buildForwardRaw({
        to, from: process.env.GMAIL_USER!, subject: `Fwd: ${subject}`,
        comment: "Auto-forwarded by triage.", originalRawB64url: rawMsg.raw!,
      });
      await gmail.users.messages.send({ userId: "me", requestBody: { raw, threadId } });
    },

    async sendAlert(to, subject, body) {
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

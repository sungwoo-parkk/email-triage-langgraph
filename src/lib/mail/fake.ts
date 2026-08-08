import type { MailClient, ThreadSnapshot } from "./types";

export function makeFakeMail(seed: { inbox?: ThreadSnapshot[]; sent?: ThreadSnapshot[] } = {}) {
  const inbox = [...(seed.inbox ?? [])];
  const sent = [...(seed.sent ?? [])];
  const known = new Set<string>();
  const labels = new Map<string, string[]>();
  const log: string[] = [];
  // forward() below needs a "when" for the snapshot it pushes into `sent`. Real Gmail
  // stamps that with the send time; here it's a deterministic counter (no Date.now(), so
  // fixture-driven tests stay reproducible) seeded just past the latest seeded sent date so
  // system-sent forwards sort after any pre-existing sent history, then ticks forward once
  // per forward() call.
  let nextForwardMs = (sent.length ? Math.max(...sent.map((t) => t.internalDateMs)) : 0) + 1;

  const client: MailClient & { log: string[]; labels: Map<string, string[]>; pushInbox(t: ThreadSnapshot): void; pushSent(t: ThreadSnapshot): void } = {
    log, labels,
    pushInbox: (t) => inbox.push(t),
    pushSent: (t) => sent.push(t),
    async listNewThreads(sinceMs, opts) {
      return (opts?.sent ? sent : inbox).filter((t) => t.internalDateMs > sinceMs);
    },
    async *listHistory(opts) {
      const src = opts.sent ? sent : inbox;
      for (const t of src.slice(0, opts.maxThreads)) yield t;
    },
    async ensureCategories(names) { names.forEach((n) => known.add(n)); log.push(`ensure:${names.join(",")}`); },
    async applyCategories(threadId, names) {
      for (const n of names) if (!known.has(n)) throw new Error(`unknown category: ${n}`);
      labels.set(threadId, [...(labels.get(threadId) ?? []), ...names]);
      log.push(`categories:${threadId}:${[...names].sort().join("|")}`);
    },
    async forward(threadId, to, contextBody) {
      log.push(`forward:${threadId}:${to}:${contextBody.slice(0, 40)}`);
      // Mirrors real Gmail: sending a forward also drops a copy in Sent, which is exactly
      // what lets observer.ts's TRIAGE_MARKER filter (finding C2) be exercised in tests -
      // without this, the self-poisoning correction loop the marker guards against was
      // unreachable from makeFakeMail-backed tests.
      sent.push({
        threadId, from: "", to: [to], subject: `Fwd: ${threadId}`, listId: null,
        attachments: [], bodyText: contextBody, internalDateMs: nextForwardMs++, references: [],
      });
    },
    async sendMessage(to, subject) { log.push(`send:${to}:${subject}`); },
  };
  return client;
}

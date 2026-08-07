import type { MailClient, ThreadSnapshot } from "./types";

export function makeFakeMail(seed: { inbox?: ThreadSnapshot[]; sent?: ThreadSnapshot[] } = {}) {
  const inbox = [...(seed.inbox ?? [])];
  const sent = [...(seed.sent ?? [])];
  const known = new Set<string>();
  const labels = new Map<string, string[]>();
  const log: string[] = [];

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
    async forward(threadId, to, contextBody) { log.push(`forward:${threadId}:${to}:${contextBody.slice(0, 40)}`); },
    async sendMessage(to, subject) { log.push(`send:${to}:${subject}`); },
  };
  return client;
}

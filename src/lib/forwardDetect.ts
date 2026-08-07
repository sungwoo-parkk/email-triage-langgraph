import type { ThreadSnapshot } from "./mail/types";
import type { Routee } from "./officeConfig";
import { extractAddr } from "./normalize";

export interface GoldLabel {
  threadId: string;
  categoryId: string;
  evidence: "same-thread" | "subject-match";
  sentMessageDateMs: number;
}

const FOURTEEN_DAYS = 14 * 86_400_000;

export function subjectCore(s: string): string {
  return s.replace(/^(\s*(\[[^\]]+\]|fwd?:|fw:|re:)\s*)+/i, "").trim();
}

export function detectForwards(sent: ThreadSnapshot[], inbox: ThreadSnapshot[], routees: Routee[]): GoldLabel[] {
  const routeeByEmail = new Map(routees.map((r) => [r.email.toLowerCase(), r.id]));
  const inboxById = new Map(inbox.map((t) => [t.threadId, t]));
  const inboxBySubject = new Map<string, ThreadSnapshot[]>();
  for (const t of inbox) {
    const key = subjectCore(t.subject).toLowerCase();
    if (key) (inboxBySubject.get(key) ?? inboxBySubject.set(key, []).get(key)!).push(t);
  }

  const best = new Map<string, GoldLabel>();
  const consider = (g: GoldLabel) => {
    const prev = best.get(g.threadId);
    if (!prev || g.sentMessageDateMs < prev.sentMessageDateMs) best.set(g.threadId, g);
  };

  for (const s of [...sent].sort((a, b) => a.internalDateMs - b.internalDateMs)) {
    const routeeId = s.to.map((a) => routeeByEmail.get(extractAddr(a))).find(Boolean);
    if (!routeeId) continue;

    const sameThread = inboxById.get(s.threadId);
    if (sameThread) {
      consider({ threadId: s.threadId, categoryId: routeeId, evidence: "same-thread", sentMessageDateMs: s.internalDateMs });
      continue;
    }
    const key = subjectCore(s.subject).toLowerCase();
    for (const orig of inboxBySubject.get(key) ?? []) {
      const delta = s.internalDateMs - orig.internalDateMs;
      if (delta >= 0 && delta <= FOURTEEN_DAYS)
        consider({ threadId: orig.threadId, categoryId: routeeId, evidence: "subject-match", sentMessageDateMs: s.internalDateMs });
    }
  }
  return [...best.values()];
}

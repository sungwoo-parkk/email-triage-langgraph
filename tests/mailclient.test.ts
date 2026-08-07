import { describe, it, expect } from "vitest";
import { makeFakeMail } from "@/lib/mail/fake";
import type { MailClient, ThreadSnapshot } from "@/lib/mail/types";

function snap(threadId: string, over: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return { threadId, from: "a@b.example", to: [], subject: "s", listId: null,
    attachments: [], bodyText: "b", internalDateMs: 1000, references: [], ...over };
}

export function runContractTests(name: string, make: () => MailClient & { log: string[] }) {
  describe(`MailClient contract: ${name}`, () => {
    it("listHistory yields sent mail only when sent=true", async () => {
      const m = make();
      const seen: string[] = [];
      for await (const t of m.listHistory({ months: 6, maxThreads: 100, sent: true })) seen.push(t.threadId);
      expect(seen.every((id) => id.startsWith("sent-"))).toBe(true);
    });
    it("applyCategories requires ensureCategories first (unknown category throws)", async () => {
      const m = make();
      await expect(m.applyCategories("t1", ["triage/jo"])).rejects.toThrow(/unknown/i);
      await m.ensureCategories(["triage/jo"]);
      await expect(m.applyCategories("t1", ["triage/jo"])).resolves.toBeUndefined();
    });
    it("forward includes the context body and records the action", async () => {
      const m = make();
      await m.forward("t1", "jo@x.example", "PROPOSED: jo (high) — invoice question");
      expect(m.log.some((l) => l.includes("forward") && l.includes("jo@x.example"))).toBe(true);
    });
  });
}

runContractTests("fake", () =>
  makeFakeMail({ inbox: [snap("in-1")], sent: [snap("sent-1", { to: ["jo@x.example"] })] })
);

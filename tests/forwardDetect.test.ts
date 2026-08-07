import { describe, it, expect } from "vitest";
import { detectForwards, subjectCore } from "@/lib/forwardDetect";
import type { ThreadSnapshot } from "@/lib/mail/types";

const routees = [
  { id: "jo", name: "Jo", email: "jo@office.example", description: "billing" },
  { id: "sales", name: "Sales", email: "sales@office.example", description: "sales" },
];

function t(threadId: string, over: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return { threadId, from: "cust@x.example", to: [], subject: "Invoice 42 overdue", listId: null,
    attachments: [], bodyText: "", internalDateMs: 1_000_000, references: [], ...over };
}

describe("subjectCore", () => {
  it("strips forward/reply chains and bracket prefixes", () => {
    expect(subjectCore("Fwd: FW: [EXTERNAL] Re: Invoice 42 overdue ")).toBe("Invoice 42 overdue");
  });
});

describe("detectForwards", () => {
  it("detects a same-thread forward to a routee", () => {
    const inbox = [t("t1")];
    const sent = [t("t1", { from: "info@office.example", to: ["jo@office.example"], internalDateMs: 1_100_000 })];
    expect(detectForwards(sent, inbox, routees)).toEqual([
      { threadId: "t1", categoryId: "jo", evidence: "same-thread", sentMessageDateMs: 1_100_000 },
    ]);
  });
  it("detects a cross-thread forward by subject within 14 days", () => {
    const inbox = [t("t2", { subject: "Need a quote for 40 chairs" })];
    const sent = [t("s9", { to: ["sales@office.example"], subject: "Fwd: Need a quote for 40 chairs",
      internalDateMs: 1_000_000 + 3 * 86_400_000 })];
    expect(detectForwards(sent, inbox, routees)[0]).toMatchObject({ threadId: "t2", categoryId: "sales", evidence: "subject-match" });
  });
  it("ignores forwards to non-routees and stale subject matches", () => {
    const inbox = [t("t3")];
    const sent = [
      t("t3", { to: ["friend@elsewhere.example"], internalDateMs: 1_100_000 }),
      t("s1", { to: ["jo@office.example"], subject: "Fwd: Invoice 42 overdue", internalDateMs: 1_000_000 + 20 * 86_400_000 }),
    ];
    expect(detectForwards(sent, inbox, routees)).toEqual([]);
  });
  it("keeps only the earliest forward per thread", () => {
    const inbox = [t("t4")];
    const sent = [
      t("t4", { to: ["sales@office.example"], internalDateMs: 1_300_000 }),
      t("t4", { to: ["jo@office.example"], internalDateMs: 1_200_000 }),
    ];
    const gold = detectForwards(sent, inbox, routees);
    expect(gold).toHaveLength(1);
    expect(gold[0].categoryId).toBe("jo");
  });
});

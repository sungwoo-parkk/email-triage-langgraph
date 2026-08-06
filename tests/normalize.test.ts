import { describe, it, expect } from "vitest";
import { normalize, extractAddr } from "@/lib/normalize";

const base = {
  threadId: "t1", from: "Jane Doe <JANE@Acme.com>", subject: "[EXTERNAL] cancellation request",
  listId: null, attachments: ["BOP-LPR-signed.pdf"],
  bodyText: "Please  cancel\r\n\r\n\r\nthe policy.  " + "x".repeat(3000),
  internalDateMs: 1_754_400_000_000,
};

describe("normalize", () => {
  it("extracts and lowercases the bare address and domain", () => {
    const n = normalize(base);
    expect(n.fromAddr).toBe("jane@acme.com");
    expect(n.fromDomain).toBe("acme.com");
  });
  it("handles bare addresses without angle brackets", () => {
    expect(extractAddr("  pro@agency.example ")).toBe("pro@agency.example");
  });
  it("collapses whitespace and caps body excerpt at 1200 chars", () => {
    const n = normalize(base);
    expect(n.bodyExcerpt.length).toBe(1200);
    expect(n.bodyExcerpt).not.toMatch(/\r|\n{3,}| {2,}/);
  });
  it("passes through subject, listId, attachments, dates", () => {
    const n = normalize(base);
    expect(n.subject).toBe(base.subject);
    expect(n.listId).toBe(null);
    expect(n.attachments).toEqual(["BOP-LPR-signed.pdf"]);
    expect(n.internalDateMs).toBe(base.internalDateMs);
  });
  it("passes through non-null listId unchanged", () => {
    const withListId = { ...base, listId: "<quit.agency.example>" };
    const n = normalize(withListId);
    expect(n.listId).toBe("<quit.agency.example>");
  });
});

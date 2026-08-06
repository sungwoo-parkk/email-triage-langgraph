import { describe, it, expect } from "vitest";
import { matchRules, applyStructuralRules, type Rule } from "@/lib/rules";
import { normalize } from "@/lib/normalize";

const rules: Rule[] = [
  { id: 1, patternType: "sender_domain", pattern: "dxc.com", labels: ["3-KR", "3-KR/DOCS&NOTICE"], forwardTo: null, complete: true },
  { id: 2, patternType: "subject_template", pattern: "USLI Renewal Quote", labels: ["6-RENEWAL QUOTE-USLI"], forwardTo: null, complete: true },
  { id: 3, patternType: "sender_exact", pattern: "quit@agency.example", labels: ["disregard"], forwardTo: null, complete: true },
  { id: 4, patternType: "sender_domain", pattern: "granadainsurance.com", labels: ["Billing"], forwardTo: "invoice@agency.example", complete: false },
];

function email(from: string, subject = "hello", listId: string | null = null) {
  return normalize({ threadId: "t", from, subject, listId, attachments: [], bodyText: "", internalDateMs: 0 });
}

describe("matchRules", () => {
  it("matches by sender domain and reports complete", () => {
    const r = matchRules(email("ny_agent_copy@dxc.com"), rules);
    expect(r.labels.sort()).toEqual(["3-KR", "3-KR/DOCS&NOTICE"]);
    expect(r.complete).toBe(true);
  });
  it("matches subject template as case-insensitive prefix (ignoring [EXTERNAL] etc.)", () => {
    const r = matchRules(email("a@b.com", "[EXTERNAL] USLI Renewal Quote for X"), rules);
    expect(r.labels).toContain("6-RENEWAL QUOTE-USLI");
  });
  it("partial rules never report complete", () => {
    const r = matchRules(email("billing@granadainsurance.com"), rules);
    expect(r.complete).toBe(false);
    expect(r.forwards).toEqual(["invoice@agency.example"]);
  });
  it("no match yields empty incomplete outcome", () => {
    const r = matchRules(email("someone@unknown.com"), rules);
    expect(r.hits).toEqual([]);
    expect(r.complete).toBe(false);
  });
});

describe("applyStructuralRules", () => {
  it("Cancelllation co-emits 3-KR/DOCS&NOTICE (spec 4.2)", () => {
    expect(applyStructuralRules(["Cancelllation"]).sort()).toEqual(["3-KR/DOCS&NOTICE", "Cancelllation"].sort());
  });
  it("is idempotent and preserves other labels", () => {
    const once = applyStructuralRules(["Cancelllation", "3-KR"]);
    expect(applyStructuralRules(once)).toEqual(once);
  });
});

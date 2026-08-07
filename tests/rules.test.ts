import { describe, it, expect } from "vitest";
import { matchRules, applyStructuralRules, loadActiveRules, type Rule } from "@/lib/rules";
import { normalize } from "@/lib/normalize";

const rules: Rule[] = [
  { id: 1, patternType: "sender_domain", pattern: "dxc.com", labels: ["3-KR", "3-KR/DOCS&NOTICE"], forwardTo: null, complete: true },
  { id: 2, patternType: "subject_template", pattern: "USLI Renewal Quote", labels: ["6-RENEWAL QUOTE-USLI"], forwardTo: null, complete: true },
  { id: 3, patternType: "sender_exact", pattern: "quit@agency.example", labels: ["disregard"], forwardTo: null, complete: true },
  { id: 4, patternType: "sender_domain", pattern: "granadainsurance.com", labels: ["Billing"], forwardTo: "invoice@agency.example", complete: false },
  { id: 5, patternType: "list_id", pattern: "quit.agency.example", labels: ["disregard"], forwardTo: null, complete: true },
];

function email(from: string, subject = "hello", listId: string | null = null) {
  return normalize({ threadId: "t", from, to: [], subject, listId, attachments: [], bodyText: "", internalDateMs: 0, references: [] });
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
  it("matches sender_exact with case-insensitive lowercasing", () => {
    const r = matchRules(email("QUIT@agency.example"), rules);
    expect(r.labels).toContain("disregard");
  });
  it("matches list_id when listId is present", () => {
    const r = matchRules(email("a@b.com", "hello", "<quit.agency.example>"), rules);
    expect(r.labels).toContain("disregard");
  });
  it("does not match list_id when listId is null", () => {
    const r = matchRules(email("a@b.com", "hello", null), rules);
    expect(r.labels).not.toContain("disregard");
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

describe("loadActiveRules", () => {
  it("parses label_set when it is a JSON string", async () => {
    let capturedSql = "";
    const db = {
      query: async (sql: string) => {
        capturedSql = sql;
        return {
          rows: [
            { id: "1", pattern_type: "sender_exact", pattern: "test@example.com", label_set: '["3-KR"]', forward_to: null, complete: true },
          ],
        };
      },
    };
    const result = await loadActiveRules(db as any);
    expect(result).toEqual([
      { id: 1, patternType: "sender_exact", pattern: "test@example.com", labels: ["3-KR"], forwardTo: null, complete: true },
    ]);
    expect(capturedSql).toContain("where active");
  });

  it("passes through label_set when it is already an array", async () => {
    let capturedSql = "";
    const db = {
      query: async (sql: string) => {
        capturedSql = sql;
        return {
          rows: [
            { id: "2", pattern_type: "sender_domain", pattern: "example.com", label_set: ["3-KR", "DOCS"], forward_to: "admin@example.com", complete: false },
          ],
        };
      },
    };
    const result = await loadActiveRules(db as any);
    expect(result).toEqual([
      { id: 2, patternType: "sender_domain", pattern: "example.com", labels: ["3-KR", "DOCS"], forwardTo: "admin@example.com", complete: false },
    ]);
    expect(capturedSql).toContain("where active");
  });

  it("correctly maps all columns (pattern_type→patternType, forward_to→forwardTo, id→Number)", async () => {
    const db = {
      query: async (sql: string) => {
        return {
          rows: [
            { id: "99", pattern_type: "list_id", pattern: "lists.example.com", label_set: '["Newsletter"]', forward_to: "archive@example.com", complete: true },
          ],
        };
      },
    };
    const result = await loadActiveRules(db as any);
    expect(result[0].id).toBe(99);
    expect(typeof result[0].id).toBe("number");
    expect(result[0].patternType).toBe("list_id");
    expect(result[0].forwardTo).toBe("archive@example.com");
    expect(result[0].complete).toBe(true);
  });
});

import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { decide, recordDecision } from "@/lib/decide";
import { normalize } from "@/lib/normalize";

const cfg = { stage: "shadow" as const, autoActLabels: ["3-KR", "3-KR/DOCS&NOTICE", "4-CAN REQ", "Cancelllation"] };
const noRules = { hits: [], labels: [], forwards: [], complete: false };

function pgliteAdapter(p: PGlite): Querier {
  return {
    query: async (sql, params) => {
      // Use exec for non-parameterized DDL
      if (!params || params.length === 0) {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith("CREATE") || (trimmed.startsWith("INSERT") && !trimmed.includes("RETURNING"))) {
          await p.exec(sql);
          return { rows: [] };
        }
      }
      // Use query for parameterized queries or SELECT or RETURNING
      return p.query(sql, params as any[]) as any;
    },
  };
}

describe("decide", () => {
  it("complete rule hit decides without LLM at rule confidence", () => {
    const d = decide({ hits: [{} as any], labels: ["3-KR", "3-KR/DOCS&NOTICE"], forwards: [], complete: true }, null, cfg);
    expect(d.status).toBe("decided");
    expect(d.confidence).toBe("rule");
    expect(d.tasks[0].labels.sort()).toEqual(["3-KR", "3-KR/DOCS&NOTICE"]);
  });

  it("high-confidence LLM output within autoActLabels decides", () => {
    const d = decide(noRules, { tasks: [{ labels: ["4-CAN REQ"], forward_to: "none" }], confidence: "high", rationale: "" }, cfg);
    expect(d.status).toBe("decided");
    expect(d.actionsPlanned).toEqual([{ kind: "labels", labels: ["4-CAN REQ"] }]);
  });

  it("medium/low confidence routes to review", () => {
    const d = decide(noRules, { tasks: [{ labels: ["4-CAN REQ"], forward_to: "none" }], confidence: "medium", rationale: "" }, cfg);
    expect(d.status).toBe("needs_review");
    expect(d.actionsPlanned).toEqual([]);
  });

  it("labels outside autoActLabels route to review even at high confidence", () => {
    const d = decide(noRules, { tasks: [{ labels: ["5-UW"], forward_to: "none" }], confidence: "high", rationale: "" }, cfg);
    expect(d.status).toBe("needs_review");
  });

  it("applies the structural co-emit and plans forwards per task", () => {
    const d = decide(noRules, { tasks: [{ labels: ["Cancelllation"], forward_to: "invoice@agency.example" }], confidence: "high", rationale: "" }, cfg);
    expect(d.tasks[0].labels).toContain("3-KR/DOCS&NOTICE");
    expect(d.actionsPlanned).toContainEqual({ kind: "forward", to: "invoice@agency.example" });
  });

  it("null LLM output (classifier failure) routes to review", () => {
    const d = decide(noRules, null, cfg);
    expect(d.status).toBe("needs_review");
  });
});

describe("recordDecision", () => {
  beforeAll(async () => {
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
  });

  it("upserts thread and writes a decision row", async () => {
    const email = normalize({ threadId: "t9", from: "a@b.com", subject: "s", listId: null, attachments: [], bodyText: "b", internalDateMs: 5 });
    const d = decide(noRules, null, cfg);
    const id = await recordDecision(getDb(), email, noRules, null, d, "shadow");
    const { rows } = await getDb().query(`select * from decisions where id = $1`, [id]);
    expect(rows[0].status).toBe("needs_review");
    expect(rows[0].stage).toBe("shadow");
    const t = await getDb().query(`select * from threads where thread_id = 't9'`);
    expect(t.rows.length).toBe(1);
  });
});

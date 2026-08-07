import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { decide, recordDecision } from "@/lib/decide";
import { normalize } from "@/lib/normalize";
import { loadOfficeConfig, deriveVocabulary, configHash } from "@/lib/officeConfig";

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

const officeCfg = loadOfficeConfig("examples/hartley/triage.config.json");
const vocab = deriveVocabulary(officeCfg);
const REVIEW = "jo@hartleysons.example";
const noRules = { hits: [], labels: [], forwards: [], complete: false };
const cfg = { stage: "shadow" as const, autoActLabels: ["jo", "sales", "junk"] };

describe("decide (config-driven)", () => {
  it("high-confidence allowed category decides with label + forward resolved from config", () => {
    const d = decide(vocab, REVIEW, noRules, { tasks: [{ category: "sales" }], confidence: "high", rationale: "" }, cfg);
    expect(d.status).toBe("decided");
    expect(d.tasks[0]).toEqual({ categoryId: "sales", label: "triage/sales", forwardTo: "sales@hartleysons.example" });
    expect(d.actionsPlanned).toEqual([
      { kind: "categories", labels: ["triage/sales"] },
      { kind: "forward", to: "sales@hartleysons.example" },
    ]);
  });
  it("junk decides with no forward", () => {
    const d = decide(vocab, REVIEW, noRules, { tasks: [{ category: "junk" }], confidence: "high", rationale: "" }, cfg);
    expect(d.actionsPlanned).toEqual([{ kind: "categories", labels: ["triage/junk"] }]);
  });
  it("categories outside the allow-list plan a review-forward", () => {
    const d = decide(vocab, REVIEW, noRules, { tasks: [{ category: "support" }], confidence: "high", rationale: "" }, cfg);
    expect(d.status).toBe("needs_review");
    expect(d.actionsPlanned).toEqual([{ kind: "review-forward", to: REVIEW }]);
  });
  it("medium confidence and null classifications also review-forward", () => {
    for (const llm of [null, { tasks: [{ category: "jo" }], confidence: "medium" as const, rationale: "" }]) {
      const d = decide(vocab, REVIEW, noRules, llm, cfg);
      expect(d.status).toBe("needs_review");
      expect(d.actionsPlanned).toEqual([{ kind: "review-forward", to: REVIEW }]);
    }
  });
  it("rule-complete hits decide at rule confidence using category ids from the rules table", () => {
    const d = decide(vocab, REVIEW, { hits: [{} as any], labels: ["jo"], forwards: [], complete: true }, null, cfg);
    expect(d.confidence).toBe("rule");
    expect(d.tasks[0].forwardTo).toBe("jo@hartleysons.example");
  });
});

describe("recordDecision", () => {
  beforeAll(async () => {
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
  });

  it("upserts thread and writes a decision row with config_hash", async () => {
    const email = normalize({ threadId: "t9", from: "a@b.com", to: [], subject: "s", listId: null, attachments: [], bodyText: "b", internalDateMs: 5, references: [] });
    const d = decide(vocab, REVIEW, noRules, null, cfg);
    const hash = configHash(officeCfg);
    const id = await recordDecision(getDb(), email, noRules, null, d, "shadow", hash);
    const { rows } = await getDb().query(`select * from decisions where id = $1`, [id]);
    expect(rows[0].status).toBe("needs_review");
    expect(rows[0].stage).toBe("shadow");
    expect(rows[0].config_hash).toBe(hash);
    const t = await getDb().query(`select * from threads where thread_id = 't9'`);
    expect(t.rows.length).toBe(1);
  });

  it("round-trips confidence 'rule' for complete-rule decision", async () => {
    const email = normalize({ threadId: "t-rule", from: "rule@example.com", to: [], subject: "s", listId: null, attachments: [], bodyText: "b", internalDateMs: 5, references: [] });
    const completeRule = { hits: [{ id: 1 } as any], labels: ["sales"], forwards: [], complete: true };
    const d = decide(vocab, REVIEW, completeRule, null, cfg);
    const id = await recordDecision(getDb(), email, completeRule, null, d, "shadow", configHash(officeCfg));
    const { rows } = await getDb().query(`select * from decisions where id = $1`, [id]);
    expect(rows[0].confidence).toBe("rule");
  });

  it("threads upsert is idempotent (calling recordDecision twice does not throw)", async () => {
    const email = normalize({ threadId: "t-idempotent", from: "test@example.com", to: [], subject: "s", listId: null, attachments: [], bodyText: "b", internalDateMs: 5, references: [] });
    const d = decide(vocab, REVIEW, noRules, null, cfg);
    const hash = configHash(officeCfg);
    const id1 = await recordDecision(getDb(), email, noRules, null, d, "shadow", hash);
    const id2 = await recordDecision(getDb(), email, noRules, null, d, "shadow", hash);
    expect(typeof id1).toBe("number");
    expect(typeof id2).toBe("number");
    const t = await getDb().query(`select * from threads where thread_id = 't-idempotent'`);
    expect(t.rows.length).toBe(1);
  });
});

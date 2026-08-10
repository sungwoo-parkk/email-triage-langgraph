import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { loadOfficeConfig, deriveVocabulary, setOfficeConfig } from "@/lib/officeConfig";
import { decide, recordDecision } from "@/lib/decide";
import { normalize } from "@/lib/normalize";

// Same adapter as tests/observer.test.ts: PGlite's parameterized query() cannot run
// multi-statement DDL, so no-param CREATE/INSERT/ALTER goes through exec().
function pgliteAdapter(p: PGlite): Querier {
  return {
    query: async (sql, params) => {
      if (!params || params.length === 0) {
        const t = sql.trim().toUpperCase();
        if (t.startsWith("CREATE") || t.startsWith("INSERT") || t.startsWith("ALTER")) {
          await p.exec(sql);
          return { rows: [] };
        }
      }
      return p.query(sql, params as any[]) as any;
    },
  };
}

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600_000;
const cfg = loadOfficeConfig("examples/hartley/triage.config.json");
const vocab = deriveVocabulary(cfg);
const REVIEW = cfg.review.recipient;
const noRules = { hits: [], labels: [], forwards: [], complete: false };

// Real decide()/recordDecision() pipeline at high confidence, then backdate created_at
// (defaults to now()) so tests control which 7-day window a decision falls in.
async function seedHighConfidence(db: Querier, threadId: string, categories: string[], createdAtMs = NOW): Promise<number> {
  const email = normalize({
    threadId, from: "a@vendor.example", to: [], subject: `${threadId} subject`, listId: null,
    attachments: [], bodyText: "body", internalDateMs: createdAtMs, references: [],
  });
  const llm = { tasks: categories.map((c) => ({ category: c })), confidence: "high" as const, rationale: "test" };
  const d = decide(vocab, REVIEW, noRules, llm, { stage: "shadow" as const, autoActLabels: categories });
  const id = await recordDecision(db, email, noRules, llm, d, "shadow", null);
  await db.query(`update decisions set created_at = to_timestamp($1 / 1000.0) where id = $2`, [createdAtMs, id]);
  return id;
}

async function observe(db: Querier, decisionId: number, threadId: string, categoryId: string): Promise<void> {
  await db.query(
    `insert into observations (thread_id, decision_id, category_id) values ($1,$2,$3)
     on conflict (decision_id, category_id) do nothing`,
    [threadId, decisionId, categoryId]);
}

describe("migration 005: v_agreement exact-set semantics", () => {
  beforeEach(async () => {
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
    await setOfficeConfig(getDb(), cfg);
  });

  it("a decision with no observation is unmeasured (absent from v_agreement)", async () => {
    await seedHighConfidence(getDb(), "t1", ["sales"]);
    const { rows } = await getDb().query(`select * from v_agreement`);
    expect(rows).toHaveLength(0);
  });

  it("matching single-category observation agrees", async () => {
    const id = await seedHighConfidence(getDb(), "t1", ["sales"]);
    await observe(getDb(), id, "t1", "sales");
    const { rows } = await getDb().query(`select agreed from v_agreement where decision_id = $1`, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].agreed).toBe(true);
  });

  it("an observed subset of a multi-task prediction is NOT agreement; the late second forward flips it", async () => {
    const id = await seedHighConfidence(getDb(), "t1", ["sales", "support"]);
    await observe(getDb(), id, "t1", "sales");
    let r = await getDb().query(`select agreed from v_agreement where decision_id = $1`, [id]);
    expect(r.rows[0].agreed).toBe(false); // subset ≠ exact set
    await observe(getDb(), id, "t1", "support"); // human forwards the second desk days later
    r = await getDb().query(`select agreed from v_agreement where decision_id = $1`, [id]);
    expect(r.rows[0].agreed).toBe(true); // read-time recompute — no reconciliation job
  });

  it("an observed category outside the prediction is disagreement", async () => {
    const id = await seedHighConfidence(getDb(), "t1", ["sales"]);
    await observe(getDb(), id, "t1", "support");
    const { rows } = await getDb().query(`select agreed, predicted, observed from v_agreement where decision_id = $1`, [id]);
    expect(rows[0].agreed).toBe(false);
  });

  it("duplicate observations dedupe via the unique constraint", async () => {
    const id = await seedHighConfidence(getDb(), "t1", ["sales"]);
    await observe(getDb(), id, "t1", "sales");
    await observe(getDb(), id, "t1", "sales");
    const { rows } = await getDb().query(`select count(*)::int as n from observations`);
    expect(rows[0].n).toBe(1);
  });

  it("v_category_stats counts predicted/observed/match per category over measured decisions only", async () => {
    const a = await seedHighConfidence(getDb(), "t1", ["sales"]);          // measured, match
    await observe(getDb(), a, "t1", "sales");
    const b = await seedHighConfidence(getDb(), "t2", ["sales"]);          // measured, miss -> observed support
    await observe(getDb(), b, "t2", "support");
    await seedHighConfidence(getDb(), "t3", ["sales"]);                    // unmeasured — must not count
    const { rows } = await getDb().query(`select * from v_category_stats order by category_id`);
    const sales = rows.find((r: any) => r.category_id === "sales");
    const support = rows.find((r: any) => r.category_id === "support");
    expect(Number(sales.predicted_n)).toBe(2);  // t1 + t2 (t3 unmeasured)
    expect(Number(sales.observed_n)).toBe(1);   // t1 only
    expect(Number(sales.match_n)).toBe(1);
    expect(Number(support.predicted_n)).toBe(0);
    expect(Number(support.observed_n)).toBe(1); // t2's human forward
    expect(Number(support.match_n)).toBe(0);
  });
});

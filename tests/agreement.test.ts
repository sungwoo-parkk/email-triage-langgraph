import { describe, it, expect, beforeEach, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { loadOfficeConfig, deriveVocabulary, setOfficeConfig } from "@/lib/officeConfig";
import { decide, recordDecision } from "@/lib/decide";
import { normalize } from "@/lib/normalize";
import { agreementWindow, gateEvidence, renderEvidence, recordForcedPromotion, MIN_WINDOW_N } from "@/lib/agreement";
import { getConfig } from "@/lib/config";
import { parseCliArgs } from "@/cli/main";
import { run as promoteRun } from "@/cli/commands/promote";

// confirm()/ask() read stdin, which vitest has no TTY for; both resolve to the same
// src/cli/confirm.ts whether imported as "../confirm" or "@/cli/confirm", so this
// mock intercepts promote's import.
vi.mock("@/cli/confirm", () => ({
  confirm: async () => true,
  ask: async () => "mocked reason",
}));

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

describe("agreement gate (spec 2026-08-10 §2.4)", () => {
  beforeEach(async () => {
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
    await setOfficeConfig(getDb(), cfg);
  });

  // Seeds `total` measured high-confidence decisions into a window, `agreeing` of them agreed.
  async function seedWindow(prefix: string, baseMs: number, total: number, agreeing: number) {
    for (let i = 0; i < total; i++) {
      const id = await seedHighConfidence(getDb(), `${prefix}-${i}`, ["sales"], baseMs + i * 60_000);
      await observe(getDb(), id, `${prefix}-${i}`, i < agreeing ? "sales" : "support");
    }
  }

  it("agreementWindow honors [since, until) on decision created_at", async () => {
    const id = await seedHighConfidence(getDb(), "edge", ["sales"], NOW - 8 * DAY);
    await observe(getDb(), id, "edge", "sales");
    const older = await agreementWindow(getDb(), NOW - 14 * DAY, NOW - 7 * DAY);
    const newer = await agreementWindow(getDb(), NOW - 7 * DAY, NOW);
    expect(older.n).toBe(1);
    expect(newer.n).toBe(0);
  });

  it("low/medium-confidence and rule decisions never enter the gate population", async () => {
    // needs_review path: llm=null -> confidence "low", final_tasks [] — observed but filtered out.
    const email = normalize({ threadId: "t-low", from: "a@vendor.example", to: [], subject: "s", listId: null, attachments: [], bodyText: "b", internalDateMs: NOW - DAY, references: [] });
    const d = decide(vocab, REVIEW, noRules, null, { stage: "shadow" as const, autoActLabels: [] });
    const id = await recordDecision(getDb(), email, noRules, null, d, "shadow", null);
    await observe(getDb(), id, "t-low", "sales");
    expect((await agreementWindow(getDb(), NOW - 14 * DAY, NOW)).n).toBe(0);
  });

  it("both windows at n>=25 and >=85% -> gate MET; window under sample floor -> NOT met even at 100%", async () => {
    await seedWindow("w1", NOW - 13 * DAY, 25, 23); // 92% older window
    await seedWindow("w2", NOW - 6 * DAY, 25, 22);  // 88% newer window
    const met = await gateEvidence(getDb(), NOW);
    expect(met.windows[0].met).toBe(true);
    expect(met.windows[1].met).toBe(true);
    expect(met.met).toBe(true);
  });

  it("a window at 84% fails the gate", async () => {
    await seedWindow("w1", NOW - 13 * DAY, 25, 25);
    await seedWindow("w2", NOW - 6 * DAY, 25, 21); // 84% < 85%
    const e = await gateEvidence(getDb(), NOW);
    expect(e.windows[1].met).toBe(false);
    expect(e.met).toBe(false);
  });

  it("a 100% window under MIN_WINDOW_N fails; unmeasured decisions are counted and excluded", async () => {
    await seedWindow("w1", NOW - 13 * DAY, MIN_WINDOW_N - 1, MIN_WINDOW_N - 1); // 24/24 = 100%, n too small
    await seedWindow("w2", NOW - 6 * DAY, 25, 25);
    await seedHighConfidence(getDb(), "untouched", ["sales"], NOW - 3 * DAY); // no observation
    const e = await gateEvidence(getDb(), NOW);
    expect(e.windows[0].met).toBe(false);
    expect(e.met).toBe(false);
    expect(e.unmeasured).toBe(1);
    expect(e.overall.n).toBe(49); // untouched thread is NOT in the denominator
  });

  it("renderEvidence states the verdict and the honest-denominator rule", async () => {
    const e = await gateEvidence(getDb(), NOW);
    const text = renderEvidence(e);
    expect(text).toContain("NOT met");
    expect(text).toContain("unmeasured");
  });

  it("recordForcedPromotion writes the audit record and getConfig still parses", async () => {
    const e = await gateEvidence(getDb(), NOW);
    await recordForcedPromotion(getDb(), "shadow", "assisted", "two-week vacation backlog skews the window", e);
    const { rows } = await getDb().query(`select value from app_config where key = 'promotion_override'`);
    const v = typeof rows[0].value === "string" ? JSON.parse(rows[0].value) : rows[0].value;
    expect(v.from).toBe("shadow");
    expect(v.to).toBe("assisted");
    expect(v.reason).toContain("vacation");
    expect(v.evidence.met).toBe(false);
    expect((await getConfig(getDb())).stage).toBe("shadow"); // unknown key stripped, schema still parses
  });

  it("unmeasured honors [since, until) on decision created_at; excludes future decisions", async () => {
    // high-confidence decision inside the 14-day span, no observation -> unmeasured
    await seedHighConfidence(getDb(), "inside", ["sales"], NOW - 3 * DAY);
    // high-confidence decision AFTER evaluation instant (future/clock skew) -> NOT counted in unmeasured
    await seedHighConfidence(getDb(), "future", ["sales"], NOW + DAY);
    const e = await gateEvidence(getDb(), NOW);
    expect(e.unmeasured).toBe(1); // only the "inside" decision
  });
});

describe("triage promote: evidence-gated shadow -> assisted", () => {
  beforeEach(async () => {
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
    await setOfficeConfig(getDb(), cfg);
    process.env.DATABASE_URL = "postgres://unused-tests-inject-via-setDb";
  });

  it("parseCliArgs understands --force (default false)", () => {
    expect(parseCliArgs(["promote", "--force"]).force).toBe(true);
    expect(parseCliArgs(["promote"]).force).toBe(false);
  });

  it("refuses shadow -> assisted when the gate is not met and --force is absent", async () => {
    await expect(
      promoteRun({ command: "promote", dryRun: false, config: undefined, force: false })
    ).rejects.toThrow(/gate NOT met/i);
    // Stage unchanged: refusal happens before any confirm/write.
    expect((await getConfig(getDb())).stage).toBe("shadow");
  });

  it("end to end: a sustained two-window shadow record promotes without --force (spec §5.1)", async () => {
    // promoteRun evaluates the gate at Date.now(), so seed relative to the real clock
    // here (not the fixed NOW constant the pure window tests use).
    const now = Date.now();
    // Two weeks of measured agreement above the bar in BOTH windows...
    for (let i = 0; i < 25; i++) {
      const a = await seedHighConfidence(getDb(), `e2e-w1-${i}`, ["sales"], now - 13 * DAY + i * 60_000);
      await observe(getDb(), a, `e2e-w1-${i}`, i < 23 ? "sales" : "support"); // 92%
      const b = await seedHighConfidence(getDb(), `e2e-w2-${i}`, ["sales"], now - 6 * DAY + i * 60_000);
      await observe(getDb(), b, `e2e-w2-${i}`, i < 22 ? "sales" : "support"); // 88%
    }
    // ...means promote (confirm mocked to yes) flips the stage with no override recorded.
    await promoteRun({ command: "promote", dryRun: false, config: undefined, force: false });
    expect((await getConfig(getDb())).stage).toBe("assisted");
    expect((await getDb().query(`select 1 from app_config where key='promotion_override'`)).rows).toHaveLength(0);
  });
});

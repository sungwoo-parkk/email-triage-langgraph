# Shadow-Agreement Gate + Gemini-Tier Eval Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the shadow→assisted promotion gate as a measured, enforced, auditable mechanism (observations table + `v_agreement`/`v_category_stats` views + gate logic wired into promote/status/digest), and a reproducible Gemini-tier eval matrix committed to docs.

**Architecture:** Feature 1 records every human forward the observer matches into a new `observations` table and computes exact-set agreement at read time via SQL views, so late-arriving forwards reconcile for free; a small `agreement.ts` module turns the views into gate evidence consumed by three renderers. Feature 2 refactors `evals/run.ts` into an exported `runEval()`, surfaces token usage through `classify.ts`, and adds a matrix runner that regenerates a markdown table between markers in `docs/evals.md`.

**Tech Stack:** TypeScript ESM (tsx), Next.js repo layout, Postgres (PGlite in tests), Zod, LangChain `initChatModel`, LangSmith `evaluate()`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-10-shadow-agreement-and-eval-matrix-design.md` — read it first.

## Global Constraints

- Tests run zero-credential on PGlite via the `pgliteAdapter` pattern (`tests/observer.test.ts:17-30`); never require `DATABASE_URL`, `GEMINI_API_KEY`, or `LANGSMITH_API_KEY` in `npm test`.
- TDD every task: failing test → minimal implementation → pass → commit.
- Gate constants (spec §2.4, exact values): `GATE_RATE = 0.85`, `MIN_WINDOW_N = 25`, window = 7 days; gate met ⇔ **both** trailing 7-day windows have `n ≥ 25` and `rate ≥ 0.85`.
- Honest denominator (spec §2.1): only decisions with ≥1 observation are measured; untouched decisions are "unmeasured," never agreement.
- High-confidence = `decisions.confidence = 'high'` (the `classify.ts:12` enum value; `'rule'` rows are excluded).
- Judges stay pinned to `GEMINI_JUDGE_MODEL` (default `gemini-3.6-flash`, `evals/evaluators.ts:57`) for every matrix row.
- The 77.3% blind-test figure, `phase0/`, and blind-test methodology are never touched.
- No new npm dependencies.
- The `corrections` table and learned-rule promotion logic (`observer.ts:54-97`) are untouched.
- Commit after every task; commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `migrations/005_agreement.sql` | Create | `observations` table, `v_agreement`, `v_category_stats` |
| `src/lib/agreement.ts` | Create | Window math, gate evidence, evidence rendering, forced-promotion audit |
| `src/lib/observer.ts` | Modify | Insert an observation per matched human forward |
| `src/cli/main.ts` | Modify | `--force` flag on `CliArgs` |
| `src/cli/confirm.ts` | Modify | Add free-text `ask()` |
| `src/cli/commands/promote.ts` | Modify | Enforce gate shadow→assisted, `--force` + audit |
| `src/cli/commands/status.ts` | Modify | Replace proxy with real evidence |
| `src/lib/digest.ts` | Modify | Shadow-agreement digest line |
| `src/lib/classify.ts` | Modify | Surface `usage_metadata` |
| `evals/run.ts` | Modify | Export `runEval()`, `--model`, `--json`, import guard |
| `evals/evaluators.ts` | Modify | `inputTokens`/`outputTokens` evaluators |
| `evals/matrixTable.ts` | Create | Pure table render + marker replace + cost math |
| `evals/matrix.ts` | Create | Sequential tier runner, doc regeneration |
| `docs/evals.md`, `README.md`, `docs/architecture.md`, `docs/operations.md` | Modify | Docs touch-points (spec §2.5, §3.4) |
| `tests/agreement.test.ts`, `tests/matrixTable.test.ts` | Create | New suites |
| `tests/observer.test.ts`, `tests/digest.test.ts`, `tests/classify.test.ts` | Modify | Additive describes |

---

### Task 1: Migration 005 — observations table + agreement views

**Files:**
- Create: `migrations/005_agreement.sql`
- Test: `tests/agreement.test.ts` (new)

**Interfaces:**
- Consumes: `decisions.final_tasks` (jsonb array of `TriageTask { categoryId, label, forwardTo }`, `src/lib/decide.ts:8`), `decisions.confidence`, `runMigrations` (applies `migrations/*.sql` in name order).
- Produces: table `observations(id, thread_id, decision_id, category_id, source, observed_at, unique(decision_id, category_id))`; view `v_agreement(decision_id, thread_id, created_at, confidence, predicted text[], observed text[], agreed boolean)` containing **only** decisions with ≥1 observation; view `v_category_stats(category_id, predicted_n, observed_n, match_n)` scoped to measured decisions.

- [ ] **Step 1: Write the failing test**

Create `tests/agreement.test.ts`. The adapter and seeding helpers mirror `tests/observer.test.ts` (same PGlite quirk: multi-statement DDL goes through `exec()`); `seedHighConfidence` drives the real `decide()`/`recordDecision()` pipeline then backdates `created_at` (which defaults to `now()`) so window tests can place decisions in time.

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agreement.test.ts`
Expected: FAIL — `relation "observations" does not exist` (or `v_agreement` missing).

- [ ] **Step 3: Write the migration**

Create `migrations/005_agreement.sql`:

```sql
-- Shadow-agreement measurement (spec: docs/superpowers/specs/2026-08-10-shadow-agreement-and-eval-matrix-design.md).
-- observations = the MEASUREMENT signal (every matched human forward, agree or disagree);
-- corrections (004) stays the LEARNING signal. Agreement is computed at read time by
-- v_agreement so late-arriving forwards on multi-request threads reconcile for free.

create table if not exists observations (
  id          bigint generated always as identity primary key,
  thread_id   text not null,
  decision_id bigint not null references decisions(id),
  category_id text not null,
  source      text not null default 'sent-forward',
  observed_at timestamptz not null default now(),
  unique (decision_id, category_id)
);
create index if not exists observations_decision_idx on observations(decision_id);

-- One row per decision with >=1 observation ("measured"). Decisions no human touched are
-- deliberately absent: unmeasured, never agreement (the honest-denominator rule).
create or replace view v_agreement as
select d.id as decision_id,
       d.thread_id,
       d.created_at,
       d.confidence,
       coalesce(p.predicted, array[]::text[]) as predicted,
       o.observed,
       coalesce(p.predicted, array[]::text[]) = o.observed as agreed
from decisions d
cross join lateral (
  select array_agg(distinct (t->>'categoryId') order by (t->>'categoryId')) as predicted
  from jsonb_array_elements(d.final_tasks) as t
) p
cross join lateral (
  select array_agg(distinct obs.category_id order by obs.category_id) as observed
  from observations obs
  where obs.decision_id = d.id
) o
where o.observed is not null;

-- Per-category breakdown over measured decisions (feeds autoActLabels with evidence).
create or replace view v_category_stats as
with predicted as (
  select d.id as decision_id, (t->>'categoryId') as category_id
  from decisions d, jsonb_array_elements(d.final_tasks) as t
  where exists (select 1 from observations o where o.decision_id = d.id)
),
observed as (
  select o.decision_id, o.category_id from observations o
)
select coalesce(p.category_id, ob.category_id) as category_id,
       count(p.category_id) as predicted_n,
       count(ob.category_id) as observed_n,
       count(*) filter (where p.category_id is not null and ob.category_id is not null) as match_n
from predicted p
full outer join observed ob
  on ob.decision_id = p.decision_id and ob.category_id = p.category_id
group by 1;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agreement.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the whole suite (migration must not break anything)**

Run: `npm test`
Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add migrations/005_agreement.sql tests/agreement.test.ts
git commit -m "feat: observations table + v_agreement/v_category_stats views (migration 005)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Observer records every matched forward as an observation

**Files:**
- Modify: `src/lib/observer.ts:33-46` (the `detectForwards` loop)
- Test: `tests/observer.test.ts` (additive describe)

**Interfaces:**
- Consumes: `observations` table (Task 1).
- Produces: one `observations` row per matched human forward (agreement AND disagreement), inserted before the agreement-`continue`. Return type of `observeSentMail` is unchanged (`{ corrections, promoted }`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/observer.test.ts` (uses the file's existing `pgliteAdapter`, `seedDecided`, `seedNeedsReview`, `snap`, `makeFakeMail`, `NOW`, `cfg`, `REVIEW`, `TRIAGE_MARKER` imports/helpers):

```ts
describe("observeSentMail: observations (measurement signal, spec 2026-08-10)", () => {
  beforeEach(async () => {
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
    await setOfficeConfig(getDb(), cfg);
  });

  it("an agreeing forward records an observation and still no correction", async () => {
    const decisionId = await seedDecided(getDb(), "t-agree", "sales");
    const mail = makeFakeMail({ sent: [snap("t-agree", { to: ["sales@hartleysons.example"], internalDateMs: NOW - 1000 })] });
    await observeSentMail(getDb(), mail, cfg, NOW);
    const obs = await getDb().query(`select decision_id, category_id from observations where thread_id='t-agree'`);
    expect(obs.rows).toEqual([{ decision_id: decisionId, category_id: "sales" }]);
    expect((await getDb().query(`select 1 from corrections where thread_id='t-agree'`)).rows).toHaveLength(0);
    // Stitch: the observer-written row is what v_agreement measures (observer -> view chain).
    const va = await getDb().query(`select agreed from v_agreement where thread_id='t-agree'`);
    expect(va.rows).toHaveLength(1);
    expect(va.rows[0].agreed).toBe(true);
  });

  it("a contradicting forward records BOTH an observation and a correction", async () => {
    await seedDecided(getDb(), "t-contra", "sales");
    const mail = makeFakeMail({ sent: [snap("t-contra", { to: ["support@hartleysons.example"], internalDateMs: NOW - 1000 })] });
    await observeSentMail(getDb(), mail, cfg, NOW);
    expect((await getDb().query(`select category_id from observations where thread_id='t-contra'`)).rows[0].category_id).toBe("support");
    expect((await getDb().query(`select category_id from corrections where thread_id='t-contra'`)).rows[0].category_id).toBe("support");
  });

  it("re-observing the same forward does not duplicate the observation", async () => {
    await seedDecided(getDb(), "t-dupe", "sales");
    const mail = makeFakeMail({ sent: [snap("t-dupe", { to: ["sales@hartleysons.example"], internalDateMs: NOW - 1000 })] });
    await observeSentMail(getDb(), mail, cfg, NOW);
    mail.pushSent(snap("t-dupe", { to: ["sales@hartleysons.example"], internalDateMs: NOW - 500 }));
    await observeSentMail(getDb(), mail, cfg, NOW);
    expect((await getDb().query(`select count(*)::int as n from observations where thread_id='t-dupe'`)).rows[0].n).toBe(1);
  });

  it("a TRIAGE_MARKER (system-sent) forward records no observation", async () => {
    await seedDecided(getDb(), "t-sys", "sales");
    const mail = makeFakeMail({
      sent: [snap("t-sys", { to: ["sales@hartleysons.example"], bodyText: `${TRIAGE_MARKER} context`, internalDateMs: NOW - 1000 })],
    });
    await observeSentMail(getDb(), mail, cfg, NOW);
    expect((await getDb().query(`select 1 from observations where thread_id='t-sys'`)).rows).toHaveLength(0);
  });

  it("a forward of an unknown thread records no observation", async () => {
    const mail = makeFakeMail({ sent: [snap("t-unknown", { to: ["sales@hartleysons.example"], internalDateMs: NOW - 1000 })] });
    await observeSentMail(getDb(), mail, cfg, NOW);
    expect((await getDb().query(`select count(*)::int as n from observations`)).rows[0].n).toBe(0);
  });
});
```

Note: `seedDecided` returns the decision id — check its current return (`return recordDecision(...)` already returns the id promise). If the first test's `decision_id` comes back as a string through the adapter, coerce: `expect(Number(obs.rows[0].decision_id)).toBe(decisionId)`.

- [ ] **Step 2: Run to verify the new describe fails**

Run: `npx vitest run tests/observer.test.ts`
Expected: the 5 new tests FAIL (no rows in `observations`); the 8 existing tests still pass.

- [ ] **Step 3: Implement the insert**

In `src/lib/observer.ts`, inside the loop, immediately after the `if (!dec.rows.length) continue;` line (`observer.ts:36`), insert:

```ts
    // Measurement signal (spec 2026-08-10): every matched human forward is recorded,
    // agreement or not — v_agreement's denominator is decisions with >=1 observation.
    // Corrections below stay the learning signal, untouched.
    await db.query(
      `insert into observations (thread_id, decision_id, category_id) values ($1,$2,$3)
       on conflict (decision_id, category_id) do nothing`,
      [g.threadId, dec.rows[0].id, g.categoryId]);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/observer.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/observer.ts tests/observer.test.ts
git commit -m "feat: observer records every matched human forward as an observation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: agreement.ts — window math, gate evidence, rendering, forced-promotion audit

**Files:**
- Create: `src/lib/agreement.ts`
- Test: `tests/agreement.test.ts` (additive describe)

**Interfaces:**
- Consumes: `v_agreement` (Task 1), `Querier` (`src/lib/db.ts:3`), `setConfigKey` (`src/lib/config.ts:26`).
- Produces (exact signatures — Tasks 4–6 import these):

```ts
export const GATE_RATE = 0.85;
export const MIN_WINDOW_N = 25;
export const WINDOW_MS = 7 * 24 * 3600_000;
export interface WindowEvidence { sinceMs: number; untilMs: number; n: number; agreed: number; rate: number | null; met: boolean }
export interface GateEvidence {
  windows: [WindowEvidence, WindowEvidence]; // [older (days 14-8), newer (days 7-0)]
  overall: { n: number; agreed: number; rate: number | null };
  unmeasured: number;
  met: boolean;
}
export async function agreementWindow(db: Querier, sinceMs: number, untilMs: number): Promise<{ n: number; agreed: number; rate: number | null }>
export async function gateEvidence(db: Querier, nowMs: number): Promise<GateEvidence>
export function renderEvidence(e: GateEvidence): string
export async function recordForcedPromotion(db: Querier, from: string, to: string, reason: string, evidence: GateEvidence): Promise<void>
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/agreement.test.ts` (helpers from Task 1 are in scope; add `import { agreementWindow, gateEvidence, renderEvidence, recordForcedPromotion, MIN_WINDOW_N } from "@/lib/agreement";` and `import { getConfig } from "@/lib/config";` at the top):

```ts
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
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/agreement.test.ts`
Expected: new describe FAILS with "Cannot find module '@/lib/agreement'"; Task 1 describe still passes.

- [ ] **Step 3: Implement `src/lib/agreement.ts`**

```ts
import type { Querier } from "./db";
import { setConfigKey } from "./config";

// Spec 2026-08-10 §2.4: gate met <=> BOTH trailing 7-day windows have n >= MIN_WINDOW_N
// and rate >= GATE_RATE. status.ts/promote.ts consume these constants — never duplicate them.
export const GATE_RATE = 0.85;
export const MIN_WINDOW_N = 25;
export const WINDOW_MS = 7 * 24 * 3600_000;

export interface WindowEvidence { sinceMs: number; untilMs: number; n: number; agreed: number; rate: number | null; met: boolean }
export interface GateEvidence {
  windows: [WindowEvidence, WindowEvidence];
  overall: { n: number; agreed: number; rate: number | null };
  unmeasured: number;
  met: boolean;
}

export async function agreementWindow(db: Querier, sinceMs: number, untilMs: number): Promise<{ n: number; agreed: number; rate: number | null }> {
  const { rows } = await db.query(
    `select count(*)::int as n, count(*) filter (where agreed)::int as agreed
     from v_agreement
     where confidence = 'high'
       and created_at >= to_timestamp($1 / 1000.0)
       and created_at <  to_timestamp($2 / 1000.0)`,
    [sinceMs, untilMs]
  );
  const n = Number(rows[0]?.n ?? 0);
  const agreed = Number(rows[0]?.agreed ?? 0);
  return { n, agreed, rate: n ? agreed / n : null };
}

export async function gateEvidence(db: Querier, nowMs: number): Promise<GateEvidence> {
  const spans = [
    { sinceMs: nowMs - 2 * WINDOW_MS, untilMs: nowMs - WINDOW_MS },
    { sinceMs: nowMs - WINDOW_MS, untilMs: nowMs },
  ] as const;
  const windows = (await Promise.all(spans.map(async (s) => {
    const r = await agreementWindow(db, s.sinceMs, s.untilMs);
    return { ...s, ...r, met: r.n >= MIN_WINDOW_N && (r.rate ?? 0) >= GATE_RATE };
  }))) as [WindowEvidence, WindowEvidence];
  const overall = await agreementWindow(db, spans[0].sinceMs, spans[1].untilMs);
  const { rows } = await db.query(
    `select count(*)::int as n from decisions d
     where d.confidence = 'high'
       and d.created_at >= to_timestamp($1 / 1000.0)
       and not exists (select 1 from observations o where o.decision_id = d.id)`,
    [spans[0].sinceMs]
  );
  return { windows, overall, unmeasured: Number(rows[0]?.n ?? 0), met: windows[0].met && windows[1].met };
}

export function renderEvidence(e: GateEvidence): string {
  const pct = (r: number | null) => (r === null ? "n/a" : `${Math.round(r * 100)}%`);
  const w = (label: string, x: WindowEvidence) =>
    `  ${label}: ${x.n} measured high-confidence decision${x.n === 1 ? "" : "s"}, ${pct(x.rate)} exact-set agreement ` +
    (x.met ? "[MET]" : `[NOT met — needs n >= ${MIN_WINDOW_N} and >= ${Math.round(GATE_RATE * 100)}%]`);
  return [
    `Promotion gate (shadow -> assisted): exact label-set agreement on high-confidence decisions,`,
    `measured only where a human outcome was observed — unmeasured threads never count as agreement.`,
    w("Days 14-8", e.windows[0]),
    w("Days 7-0 ", e.windows[1]),
    `  Overall 14 days: ${e.overall.n} measured, ${pct(e.overall.rate)} agreement; ${e.unmeasured} high-confidence decision${e.unmeasured === 1 ? "" : "s"} unmeasured.`,
    `  Gate: ${e.met ? "MET — sustained across both windows." : "NOT met."}`,
  ].join("\n");
}

export async function recordForcedPromotion(db: Querier, from: string, to: string, reason: string, evidence: GateEvidence): Promise<void> {
  await setConfigKey(db, "promotion_override", { at: new Date().toISOString(), from, to, reason, evidence });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/agreement.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agreement.ts tests/agreement.test.ts
git commit -m "feat: agreement gate evidence - windows, sustained rule, render, forced-promotion audit

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Enforce the gate in `triage promote` (+ `--force`, `ask()`)

**Files:**
- Modify: `src/cli/main.ts` (add `force` to `CliArgs`)
- Modify: `src/cli/confirm.ts` (add `ask()`)
- Modify: `src/cli/commands/promote.ts`
- Test: `tests/agreement.test.ts` (additive describe)

**Interfaces:**
- Consumes: `gateEvidence`, `renderEvidence`, `recordForcedPromotion`, `MIN_WINDOW_N` (Task 3).
- Produces: `CliArgs` gains `force: boolean` (every `commands/*.run` receives it); `confirm.ts` exports `ask(message: string): Promise<string>` (trimmed free-text answer).

- [ ] **Step 1: Write the failing tests**

Append to `tests/agreement.test.ts` (add `vi` to the file's vitest import, plus `import { parseCliArgs } from "@/cli/main";` and `import { run as promoteRun } from "@/cli/commands/promote";` at the top — importing `main.ts` is safe in vitest because its `main()` call is guarded by `process.argv[1]?.endsWith("main.ts")`). Also add this module mock at the top of the file, after the imports — `confirm()`/`ask()` read stdin, which vitest has no TTY for; both resolve to the same `src/cli/confirm.ts` whether imported as `../confirm` or `@/cli/confirm`, so the mock intercepts promote's import:

```ts
vi.mock("@/cli/confirm", () => ({
  confirm: async () => true,
  ask: async () => "mocked reason",
}));
```

```ts
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
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/agreement.test.ts`
Expected: FAIL — `parseCliArgs` has no `force`; promote resolves without throwing.

- [ ] **Step 3: Implement**

`src/cli/main.ts` — replace the interface and parser:

```ts
export interface CliArgs { command: "init" | "status" | "promote" | "pause"; dryRun: boolean; config: string | undefined; force: boolean }

export function parseCliArgs(argv: string[]): CliArgs {
  const { positionals, values } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      config: { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  const command = positionals[0];
  if (!["init", "status", "promote", "pause"].includes(command ?? ""))
    throw new Error(`unknown command: ${command ?? "(none)"} — expected init | status | promote | pause`);
  return { command: command as CliArgs["command"], dryRun: values["dry-run"]!, config: values.config, force: values.force! };
}
```

`src/cli/confirm.ts` — append:

```ts
/** Prompts for a free-text answer on the terminal. Returns the trimmed reply ("" if empty). */
export async function ask(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${message} `)).trim();
  } finally {
    rl.close();
  }
}
```

`src/cli/commands/promote.ts` — full new content:

```ts
import type { CliArgs } from "../main";
import { getDb } from "../../lib/db";
import { getConfig, setConfigKey } from "../../lib/config";
import { confirm, ask } from "../confirm";
import { gateEvidence, renderEvidence, recordForcedPromotion, MIN_WINDOW_N, GATE_RATE } from "../../lib/agreement";

// Single-step-only map: shadow can promote to assisted, assisted to autonomous — there is no
// entry that lets shadow jump straight to autonomous, so that jump is structurally impossible
// here, not just discouraged.
const NEXT: Record<string, "assisted" | "autonomous" | undefined> = {
  shadow: "assisted",
  assisted: "autonomous",
};

export async function run(args: CliArgs): Promise<void> {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is not set — set it in .env (see .env.example) before running `triage promote`.");

  const db = getDb();
  const cfg = await getConfig(db);
  const next = NEXT[cfg.stage];
  if (!next) throw new Error(`already at "autonomous" — there is no further stage to promote to.`);

  // shadow -> assisted is evidence-gated (spec 2026-08-10 §2.5). assisted -> autonomous
  // keeps confirm-only behavior: its correction-rate gate is out of this spec's scope.
  if (cfg.stage === "shadow") {
    const evidence = await gateEvidence(db, Date.now());
    console.log(renderEvidence(evidence));
    if (!evidence.met) {
      if (!args.force)
        throw new Error(
          `promotion gate NOT met — shadow -> assisted requires both trailing 7-day windows at ` +
          `>= ${MIN_WINDOW_N} measured high-confidence decisions and >= ${Math.round(GATE_RATE * 100)}% agreement. ` +
          `Re-run with --force to override; the override and your reason are recorded.`
        );
      const reason = await ask("Gate not met. Reason for forcing promotion (recorded to the audit log):");
      if (!reason) {
        console.log("No reason given — cancelled.");
        return;
      }
      await recordForcedPromotion(db, cfg.stage, next, reason, evidence);
      console.log("Override recorded to app_config.promotion_override.");
    }
  }

  console.log(`Current stage: ${cfg.stage}`);
  console.log(`Promote to:    ${next}`);
  if (!(await confirm(`Promote from "${cfg.stage}" to "${next}"?`))) {
    console.log("Cancelled.");
    return;
  }

  await setConfigKey(db, "stage", next);
  console.log(`Promoted to "${next}".`);
}
```

- [ ] **Step 4: Run to verify pass, then run the whole suite**

Run: `npx vitest run tests/agreement.test.ts` then `npm test`
Expected: PASS. Watch for other tests constructing `CliArgs` literals — if any fail on the new `force` field, add `force: false` to those literals.

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.ts src/cli/confirm.ts src/cli/commands/promote.ts tests/agreement.test.ts
git commit -m "feat: evidence-gated triage promote with audited --force override

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `triage status` renders real evidence (proxy removed)

**Files:**
- Modify: `src/cli/commands/status.ts`
- Test: `tests/agreement.test.ts` (additive describe)

**Interfaces:**
- Consumes: `gateEvidence`, `renderEvidence` (Task 3).
- Produces: shadow-stage `triage status` output = `renderEvidence()` text; the `1 − corrections/decisions` proxy and the local `PROMOTION_GATE_AGREEMENT` constant are deleted. Assisted-stage output unchanged.

- [ ] **Step 1: Write the failing test**

Append to `tests/agreement.test.ts` (add `import { vi } from "vitest";` to the vitest import and `import { run as statusRun } from "@/cli/commands/status";`):

```ts
describe("triage status: shadow stage shows measured evidence, not the proxy", () => {
  beforeEach(async () => {
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
    await setOfficeConfig(getDb(), cfg);
    process.env.DATABASE_URL = "postgres://unused-tests-inject-via-setDb";
  });

  it("prints window evidence and never the (1 - correction rate) proxy line", async () => {
    const id = await seedHighConfidence(getDb(), "t-status", ["sales"], NOW - 2 * DAY);
    await observe(getDb(), id, "t-status", "sales");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    try {
      await statusRun({ command: "status", dryRun: false, config: undefined, force: false });
    } finally {
      spy.mockRestore();
    }
    const out = logs.join("\n");
    expect(out).toContain("measured high-confidence decision");
    expect(out).toContain("NOT met"); // 1 measured decision can't clear n >= 25
    expect(out).not.toContain("agreement proxy");
    expect(out).not.toMatch(/Observed over the last 7 days: \d+% agreement/);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/agreement.test.ts`
Expected: FAIL — current status prints the proxy wording, not "measured high-confidence decision".

- [ ] **Step 3: Implement**

In `src/cli/commands/status.ts`:
1. Add `import { gateEvidence, renderEvidence } from "../../lib/agreement";`.
2. Delete the `PROMOTION_GATE_AGREEMENT` constant and its comment lines referencing the shadow gate (keep `ASSISTED_CORRECTION_RATE_GATE` and its comment).
3. Replace the entire `if (cfg.stage === "shadow") { ... }` block with:

```ts
  if (cfg.stage === "shadow") {
    console.log(renderEvidence(await gateEvidence(getDb(), Date.now())));
  } else if (cfg.stage === "assisted") {
```

(The assisted and top-stage branches are unchanged.)

- [ ] **Step 4: Run to verify pass, then the whole suite**

Run: `npx vitest run tests/agreement.test.ts` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/status.ts tests/agreement.test.ts
git commit -m "feat: triage status renders measured shadow-agreement evidence, drops the proxy

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Digest line for shadow agreement

**Files:**
- Modify: `src/lib/digest.ts`
- Test: `tests/digest.test.ts` (additive describe)

**Interfaces:**
- Consumes: `agreementWindow` (Task 3), `getConfig` (`src/lib/config.ts:20`).
- Produces: `buildDigest(db, sinceMs, nowMs = Date.now())` — third parameter added with a default, so every existing caller keeps working. While stage is `shadow`, the body gains one agreement line.

- [ ] **Step 1: Write the failing test**

Append to `tests/digest.test.ts` a fully self-contained describe (its own helpers — do not assume the file's existing ones; reuse its imports where present, otherwise add: `PGlite`, `setDb/getDb/Querier`, `runMigrations`, `loadOfficeConfig/deriveVocabulary/setOfficeConfig`, `decide/recordDecision`, `normalize`, `setConfigKey`, `buildDigest`):

```ts
describe("buildDigest: shadow-agreement line (spec 2026-08-10 §2.5)", () => {
  const NOW2 = 1_800_000_000_000;
  const DAY2 = 24 * 3600_000;
  const cfg2 = loadOfficeConfig("examples/hartley/triage.config.json");
  const vocab2 = deriveVocabulary(cfg2);
  const noRules2 = { hits: [], labels: [], forwards: [], complete: false };

  function adapter(p: PGlite): Querier {
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

  async function seedMeasured(db: Querier, threadId: string, createdAtMs: number) {
    const email = normalize({ threadId, from: "a@vendor.example", to: [], subject: "s", listId: null, attachments: [], bodyText: "b", internalDateMs: createdAtMs, references: [] });
    const llm = { tasks: [{ category: "sales" }], confidence: "high" as const, rationale: "t" };
    const d = decide(vocab2, cfg2.review.recipient, noRules2, llm, { stage: "shadow" as const, autoActLabels: ["sales"] });
    const id = await recordDecision(db, email, noRules2, llm, d, "shadow", null);
    await db.query(`update decisions set created_at = to_timestamp($1 / 1000.0) where id = $2`, [createdAtMs, id]);
    await db.query(`insert into observations (thread_id, decision_id, category_id) values ($1,$2,$3)`, [threadId, id, "sales"]);
  }

  beforeEach(async () => {
    const p = new PGlite();
    setDb(adapter(p));
    await runMigrations(getDb());
    await setOfficeConfig(getDb(), cfg2);
  });

  it("shadow stage with a measured decision includes the agreement line", async () => {
    await seedMeasured(getDb(), "t-dig", NOW2 - 2 * DAY2);
    const { body } = await buildDigest(getDb(), NOW2 - DAY2, NOW2);
    expect(body).toMatch(/Shadow agreement \(last 14 days\): 100% over 1 measured high-confidence decision/);
  });

  it("shadow stage with nothing measured says so honestly", async () => {
    const { body } = await buildDigest(getDb(), NOW2 - DAY2, NOW2);
    expect(body).toContain("Shadow agreement (last 14 days): nothing measured yet");
  });

  it("non-shadow stage omits the line", async () => {
    await setConfigKey(getDb(), "stage", "assisted");
    const { body } = await buildDigest(getDb(), NOW2 - DAY2, NOW2);
    expect(body).not.toContain("Shadow agreement");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/digest.test.ts`
Expected: new describe FAILS (no agreement line; `buildDigest` ignores the third argument).

- [ ] **Step 3: Implement**

In `src/lib/digest.ts`: add imports `import { getConfig } from "./config";` and `import { agreementWindow } from "./agreement";`. Change the signature to `export async function buildDigest(db: Querier, sinceMs: number, nowMs = Date.now())` and, immediately after the corrections `lines.push(...)` (the current last push), append:

```ts
  // Spec 2026-08-10 §2.5: while shadowing, surface the measured 14-day agreement (or its
  // honest absence) so the office sees the promotion evidence accumulate without running status.
  const appCfg = await getConfig(db);
  if (appCfg.stage === "shadow") {
    const w = await agreementWindow(db, nowMs - 14 * 24 * 3600_000, nowMs);
    lines.push(
      "",
      w.n
        ? `Shadow agreement (last 14 days): ${Math.round((w.rate ?? 0) * 100)}% over ${w.n} measured high-confidence decision${w.n === 1 ? "" : "s"} — run \`triage status\` for the promotion gate.`
        : `Shadow agreement (last 14 days): nothing measured yet — no human forwards have matched a recorded decision.`
    );
  }
```

- [ ] **Step 4: Run to verify pass, then the whole suite**

Run: `npx vitest run tests/digest.test.ts` then `npm test`
Expected: PASS (existing digest tests unaffected — the new parameter defaults).

- [ ] **Step 5: Commit**

```bash
git add src/lib/digest.ts tests/digest.test.ts
git commit -m "feat: daily digest surfaces measured 14-day shadow agreement

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Feature-1 docs — architecture.md + operations.md

**Files:**
- Modify: `docs/architecture.md`, `docs/operations.md`

**Interfaces:** none (prose only). Spec §2.5 docs bullet.

- [ ] **Step 1: architecture.md**

Find the paragraph describing the correction observer (`grep -n "observer\|corrections" docs/architecture.md`). Immediately after it, insert this paragraph verbatim:

> Alongside `corrections` (the learning signal), every matched human forward is also recorded in `observations` (the measurement signal). `v_agreement` compares each decision's predicted category set against the humanly-observed set at read time — so a late second forward on a multi-request thread reconciles automatically — and `v_category_stats` breaks the same comparison down per category. Decisions no human ever touched are unmeasured, never counted as agreement; the shadow→assisted promotion gate reads only this measured population (see `src/lib/agreement.ts`).

- [ ] **Step 2: operations.md**

Find the stages paragraph (`grep -n "Stages:" docs/operations.md`, currently line 24). Immediately after it, insert verbatim:

> `triage promote` from shadow is evidence-gated: it prints the measured agreement windows and refuses unless both trailing 7-day windows have ≥25 measured high-confidence decisions at ≥85% exact-set agreement. `--force` overrides after recording your stated reason and the full evidence to `app_config.promotion_override` — the override is auditable, never silent.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md docs/operations.md
git commit -m "docs: observations/measurement signal and the evidence-gated promote

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: classify.ts surfaces usage_metadata

**Files:**
- Modify: `src/lib/classify.ts`
- Test: `tests/classify.test.ts` (additive describe)

**Interfaces:**
- Consumes: LangChain `withStructuredOutput(schema, { includeRaw: true })` → `invoke` resolves `{ raw: AIMessage, parsed: T }`; `AIMessage.usage_metadata = { input_tokens, output_tokens, total_tokens }`.
- Produces: the classifier function now resolves `Classification & { usage_metadata?: { input_tokens: number; output_tokens: number } }`. Injected fake models returning a plain parsed object (every existing test) keep working — the wrapper falls back when there is no `parsed` key. Export type alias `ClassificationWithUsage`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/classify.test.ts` (reuse its existing imports of `makeClassifier`/config; if it has no hartley config loaded, add `loadOfficeConfig` and `normalize` imports as in other suites):

```ts
describe("classifier usage_metadata passthrough (spec 2026-08-10 §3.2)", () => {
  const ucfg = loadOfficeConfig("examples/hartley/triage.config.json");
  const email = normalize({
    threadId: "t-usage", from: "a@vendor.example", to: [], subject: "s", listId: null,
    attachments: [], bodyText: "b", internalDateMs: 0, references: [],
  });
  const noRules = { hits: [], labels: [], forwards: [], complete: false };
  const parsed = { tasks: [{ category: "sales" }], confidence: "high", rationale: "r" };

  it("surfaces usage_metadata when the model returns includeRaw shape", async () => {
    const model = { invoke: async () => ({ parsed, raw: { usage_metadata: { input_tokens: 1200, output_tokens: 40, total_tokens: 1240 } } }) };
    const c = await makeClassifier(ucfg, [], model)(email, noRules);
    expect(c.tasks[0].category).toBe("sales");
    expect(c.usage_metadata).toEqual({ input_tokens: 1200, output_tokens: 40 });
  });

  it("a plain parsed object (fakes, older providers) still works, without usage", async () => {
    const model = { invoke: async () => parsed };
    const c = await makeClassifier(ucfg, [], model)(email, noRules);
    expect(c.tasks[0].category).toBe("sales");
    expect(c.usage_metadata).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/classify.test.ts`
Expected: first new test FAILS — `schema.parse` throws on the `{ parsed, raw }` wrapper (it isn't a Classification).

- [ ] **Step 3: Implement**

In `src/lib/classify.ts`:

1. In `defaultModel`, change the last line to request the raw message alongside the parsed output:

```ts
  return llm.withStructuredOutput(schema, { includeRaw: true }) as unknown as ClassifierModel;
```

2. Replace `makeClassifier`'s return with a wrapper that unwraps either shape (and export the widened type):

```ts
export type ClassificationWithUsage = Classification & {
  usage_metadata?: { input_tokens: number; output_tokens: number };
};

export function makeClassifier(cfg: OfficeConfig, exemplars: Exemplar[], model?: ClassifierModel) {
  const schema = makeClassificationSchema(cfg);
  const system = buildSystemPrompt(cfg, exemplars);
  let m: ClassifierModel | undefined = model;
  // includeRaw providers resolve { parsed, raw }; injected fakes and older providers resolve
  // the parsed object directly. Unwrap either, validate the parsed half, re-attach usage.
  const unwrap = (res: unknown): ClassificationWithUsage => {
    const r = res as any;
    const isWrapped = r && typeof r === "object" && "parsed" in r && "raw" in r;
    const parsed = schema.parse(isWrapped ? r.parsed : r);
    const u = isWrapped ? r.raw?.usage_metadata : undefined;
    return typeof u?.input_tokens === "number" && typeof u?.output_tokens === "number"
      ? { ...parsed, usage_metadata: { input_tokens: u.input_tokens, output_tokens: u.output_tokens } }
      : parsed;
  };
  return async (email: NormalizedEmail, ruleEvidence: RuleOutcome): Promise<ClassificationWithUsage> => {
    m ??= await defaultModel(cfg, schema);
    const messages: [string, string][] = [["system", system], ["human", emailPrompt(email, ruleEvidence)]];
    try { return unwrap(await m.invoke(messages)); }
    catch { return unwrap(await m.invoke(messages)); } // one retry, then throw
  };
}
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS — graph/decide consumers read `tasks`/`confidence`/`rationale`, which are unchanged; `recordDecision` will now also persist `usage_metadata` inside `llm_output` jsonb, which is additive.

- [ ] **Step 5: Commit**

```bash
git add src/lib/classify.ts tests/classify.test.ts
git commit -m "feat: classifier surfaces model usage_metadata via includeRaw

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: run.ts → exported `runEval` with `--model` / `--json`; token evaluators

**Files:**
- Modify: `evals/run.ts`, `evals/evaluators.ts`

**Interfaces:**
- Consumes: `ClassificationWithUsage` (Task 8).
- Produces (Task 11 imports these):

```ts
// evals/run.ts
export interface EvalOptions { model?: string; limit?: number | null; judges?: boolean; sync?: boolean }
export interface EvalSummary { model: string; promptVersion: string; experimentName: string; metrics: Record<string, { mean: number; n: number }> }
export async function runEval(opts?: EvalOptions): Promise<EvalSummary>
// evals/evaluators.ts
export function inputTokens(run: any, _example: any): { key: "input_tokens"; score: number | null; comment: string }
export function outputTokens(run: any, _example: any): { key: "output_tokens"; score: number | null; comment: string }
```

- [ ] **Step 1: Add the token evaluators**

Append to `evals/evaluators.ts`:

```ts
// Free programmatic passthroughs: the target attaches usage_metadata (src/lib/classify.ts,
// includeRaw). score is the raw token count (null when the provider sent no usage), so the
// experiment mean IS mean tokens/email — the matrix's cost input. Never estimated.
export function inputTokens(run: any, _example: any) {
  const t = run.outputs?.usage_metadata?.input_tokens;
  return { key: "input_tokens", score: typeof t === "number" ? t : null, comment: typeof t === "number" ? `${t} input tokens` : "no usage_metadata" };
}

export function outputTokens(run: any, _example: any) {
  const t = run.outputs?.usage_metadata?.output_tokens;
  return { key: "output_tokens", score: typeof t === "number" ? t : null, comment: typeof t === "number" ? `${t} output tokens` : "no usage_metadata" };
}
```

- [ ] **Step 2: Refactor run.ts**

Restructure `evals/run.ts` — dataset code (`LABEL_TO_CATEGORY`, `translateTask`, `translateGolden`, `ensureDataset`) is untouched; `main()` becomes `runEval()` + a thin CLI. Replace everything from `async function main()` down with:

```ts
export interface EvalOptions { model?: string; limit?: number | null; judges?: boolean; sync?: boolean }
export interface EvalSummary { model: string; promptVersion: string; experimentName: string; metrics: Record<string, { mean: number; n: number }> }

export async function runEval(opts: EvalOptions = {}): Promise<EvalSummary> {
  const { limit = null, judges = true, sync = false } = opts;
  // Always the flagship example office (fixed dataset, regression tracking) — only the
  // model may vary per call; every Gemini tier shares cfg.llm.apiKeyEnv (GEMINI_API_KEY).
  const cfg = loadOfficeConfig(path.join(HERE, "..", "examples/agency/triage.config.json"));
  if (opts.model) cfg.llm.model = opts.model;
  for (const v of ["LANGSMITH_API_KEY", cfg.llm.apiKeyEnv]) {
    if (!process.env[v]) throw new Error(`${v} is required`);
  }

  const client = new Client();
  await ensureDataset(client, sync);

  const classifier = makeClassifier(cfg, []);
  const target = async (inputs: Record<string, any>) => {
    const email = normalize({
      threadId: inputs.threadId, from: inputs.from, to: [], subject: inputs.subject,
      listId: inputs.listId ?? null, attachments: inputs.attachments ?? [],
      bodyText: inputs.body ?? "", internalDateMs: 0, references: [],
    });
    const t0 = Date.now();
    const c = await classifier(email, { hits: [], labels: [], forwards: [], complete: false });
    return { ...c, latency_ms: Date.now() - t0 };
  };

  const evaluators: any[] = [exactSetMatch, taskCountMatch, forwardMatch, latencySeconds, inputTokens, outputTokens];
  if (judges) evaluators.push(faithfulness, instructionFollowing);

  let promptVersion = "unversioned";
  try { promptVersion = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: path.join(HERE, "..") }).toString().trim(); } catch {}
  const model = cfg.llm.model;

  const data = limit ? client.listExamples({ datasetName: DATASET, limit }) : DATASET;
  const results = await evaluate(target, {
    data: data as any,
    evaluators,
    experimentPrefix: `${model}@${promptVersion}`,
    maxConcurrency: 4,
    metadata: { model, promptVersion, judges: String(judges) },
  });

  const sums = new Map<string, { total: number; n: number }>();
  for (const r of results.results) {
    for (const er of r.evaluationResults?.results ?? []) {
      const s = sums.get(er.key) ?? { total: 0, n: 0 };
      if (typeof er.score === "number") { s.total += er.score; s.n++; }
      sums.set(er.key, s);
    }
  }
  const metrics: EvalSummary["metrics"] = {};
  for (const [key, { total, n }] of sums) metrics[key] = { mean: n ? total / n : NaN, n };
  return { model, promptVersion, experimentName: results.experimentName, metrics };
}

function fmt(key: string, mean: number): string {
  if (key === "latency_s") return `${mean.toFixed(2)}s mean`;
  if (key.endsWith("_tokens")) return `${Math.round(mean)} mean`;
  return `${(mean * 100).toFixed(1)}%`;
}

async function cli() {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const summary = await runEval({
    model: flag("--model"),
    limit: flag("--limit") ? Number(flag("--limit")) : null,
    judges: !args.includes("--no-judges"),
    sync: args.includes("--sync"),
  });
  console.log(`\nexperiment: ${summary.experimentName}`);
  for (const key of Object.keys(summary.metrics).sort())
    console.log(`  ${key.padEnd(22)} ${fmt(key, summary.metrics[key].mean)}  (n=${summary.metrics[key].n})`);
  const jsonPath = flag("--json");
  if (jsonPath) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
    console.log(`wrote ${jsonPath}`);
  }
  console.log(`\nview: https://smith.langchain.com -> Datasets & Experiments -> ${DATASET}`);
}

// Import guard (matches src/cli/main.ts): evals/matrix.ts imports runEval — the CLI must not
// fire on import.
if (process.argv[1]?.endsWith("run.ts")) cli().then(() => process.exit(0)).catch((e) => { console.error("EVAL FAILED:", e); process.exit(1); });
```

Also add `inputTokens, outputTokens` to the existing `./evaluators` import list at the top of the file.

- [ ] **Step 3: Typecheck + suite**

Run: `npx tsc --noEmit` and `npm test`
Expected: clean; the suite never imports `evals/` so nothing else moves.

- [ ] **Step 4 (requires `.env` keys — GEMINI_API_KEY + LANGSMITH_API_KEY; skip in CI): smoke-verify the flags**

Run: `npm run eval -- --limit 2 --no-judges --json "$TEMP/eval-smoke.json"` then inspect the JSON.
Expected: exit 0; JSON has `model: "google_genai:gemini-3.6-flash"`, numeric `metrics.exact_set_match.mean`, and `metrics.input_tokens.mean > 0` (proves Task 8's usage passthrough works live). If `input_tokens` is missing here, stop and debug Task 8 before continuing — the cost column depends on it.

- [ ] **Step 5: Commit**

```bash
git add evals/run.ts evals/evaluators.ts
git commit -m "feat: exported runEval with --model/--json + token-usage evaluators

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: matrixTable.ts pure helpers + tests

**Files:**
- Create: `evals/matrixTable.ts`
- Test: `tests/matrixTable.test.ts` (new)

**Interfaces:**
- Produces (Task 11 imports these):

```ts
export interface TierRow {
  model: string;
  ok: boolean;
  error?: string;
  metrics?: Record<string, { mean: number; n: number }>;
  price: { inPerM: number; outPerM: number } | null;
}
export function costPer1k(row: TierRow): string          // "$0.55" or "—" (never estimated)
export function renderMatrixTable(rows: TierRow[], priceAsOf: string): string
export function replaceBetweenMarkers(doc: string, start: string, end: string, content: string): string
```

- [ ] **Step 1: Write the failing tests**

Create `tests/matrixTable.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { costPer1k, renderMatrixTable, replaceBetweenMarkers, type TierRow } from "../evals/matrixTable";

const okRow: TierRow = {
  model: "google_genai:gemini-3.6-flash",
  ok: true,
  price: { inPerM: 0.3, outPerM: 2.5 },
  metrics: {
    exact_set_match: { mean: 0.91, n: 67 },
    task_count_match: { mean: 1, n: 67 },
    forward_match: { mean: 1, n: 67 },
    faithfulness: { mean: 0.97, n: 67 },
    instruction_following: { mean: 0.974, n: 67 },
    latency_s: { mean: 2.63, n: 67 },
    input_tokens: { mean: 1000, n: 67 },
    output_tokens: { mean: 100, n: 67 },
  },
};

describe("costPer1k", () => {
  it("computes measured tokens x price per 1K emails", () => {
    // (1000*0.3/1e6 + 100*2.5/1e6) * 1000 = 0.55
    expect(costPer1k(okRow)).toBe("$0.55");
  });
  it("is em-dash when usage is missing — never estimated", () => {
    const { input_tokens, output_tokens, ...rest } = okRow.metrics!;
    expect(costPer1k({ ...okRow, metrics: rest })).toBe("—");
  });
  it("is em-dash when the price map has no entry", () => {
    expect(costPer1k({ ...okRow, price: null })).toBe("—");
  });
});

describe("renderMatrixTable", () => {
  it("renders metric percentages, latency, cost, and the as-of footnote", () => {
    const t = renderMatrixTable([okRow], "2026-08");
    expect(t).toContain("| gemini-3.6-flash | 91.0% | 100.0% | 100.0% | 97.0% | 97.4% | 2.63s | $0.55 |");
    expect(t).toContain("as of 2026-08");
    expect(t).toContain("GEMINI_JUDGE_MODEL");
  });
  it("renders a failed tier as a failed row, not fabricated numbers", () => {
    const t = renderMatrixTable([{ model: "google_genai:gemini-3.6-pro", ok: false, error: "429 quota", price: null }], "2026-08");
    expect(t).toContain("_run failed: 429 quota_");
    expect(t).not.toContain("NaN");
  });
});

describe("replaceBetweenMarkers", () => {
  const doc = "before\n<!-- eval-matrix:start -->\nold\n<!-- eval-matrix:end -->\nafter";
  it("replaces only the region between markers and is idempotent", () => {
    const once = replaceBetweenMarkers(doc, "<!-- eval-matrix:start -->", "<!-- eval-matrix:end -->", "NEW");
    expect(once).toContain("before");
    expect(once).toContain("after");
    expect(once).toContain("NEW");
    expect(once).not.toContain("old");
    const twice = replaceBetweenMarkers(once, "<!-- eval-matrix:start -->", "<!-- eval-matrix:end -->", "NEW");
    expect(twice).toBe(once);
  });
  it("throws when the markers are absent (protects the committed doc)", () => {
    expect(() => replaceBetweenMarkers("no markers here", "<!-- eval-matrix:start -->", "<!-- eval-matrix:end -->", "x")).toThrow(/markers/);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/matrixTable.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `evals/matrixTable.ts`**

```ts
/** Pure helpers for the eval matrix (no I/O, no LangSmith) so table shape and cost math are unit-testable. */
export interface TierRow {
  model: string;
  ok: boolean;
  error?: string;
  metrics?: Record<string, { mean: number; n: number }>;
  price: { inPerM: number; outPerM: number } | null;
}

const pct = (m?: { mean: number }) => (m && Number.isFinite(m.mean) ? `${(m.mean * 100).toFixed(1)}%` : "—");

export function costPer1k(row: TierRow): string {
  const inT = row.metrics?.input_tokens?.mean;
  const outT = row.metrics?.output_tokens?.mean;
  if (!row.price || typeof inT !== "number" || typeof outT !== "number" || !Number.isFinite(inT) || !Number.isFinite(outT)) return "—";
  const usd = ((inT * row.price.inPerM) / 1e6 + (outT * row.price.outPerM) / 1e6) * 1000;
  return `$${usd.toFixed(2)}`;
}

export function renderMatrixTable(rows: TierRow[], priceAsOf: string): string {
  const header =
    `| Model | Exact-set | Task-split | Forward | Faithfulness | Instr.-following | Latency (mean) | Cost / 1K emails |\n` +
    `|---|---|---|---|---|---|---|---|`;
  const body = rows.map((r) => {
    const name = r.model.replace(/^google_genai:/, "");
    if (!r.ok) return `| ${name} | _run failed: ${r.error ?? "unknown"}_ | | | | | | |`;
    const m = r.metrics ?? {};
    const lat = m.latency_s && Number.isFinite(m.latency_s.mean) ? `${m.latency_s.mean.toFixed(2)}s` : "—";
    return `| ${name} | ${pct(m.exact_set_match)} | ${pct(m.task_count_match)} | ${pct(m.forward_match)} | ${pct(m.faithfulness)} | ${pct(m.instruction_following)} | ${lat} | ${costPer1k(r)} |`;
  }).join("\n");
  const foot = `\n_Cost = measured mean tokens/email × published prices as of ${priceAsOf}; judges pinned to \`GEMINI_JUDGE_MODEL\` for every row; “—” = usage or price unavailable (never estimated)._`;
  return `${header}\n${body}\n${foot}`;
}

export function replaceBetweenMarkers(doc: string, start: string, end: string, content: string): string {
  const s = doc.indexOf(start);
  const e = doc.indexOf(end);
  if (s < 0 || e < 0 || e < s) throw new Error(`markers not found in doc: ${start} … ${end}`);
  return doc.slice(0, s + start.length) + "\n" + content + "\n" + doc.slice(e);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/matrixTable.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add evals/matrixTable.ts tests/matrixTable.test.ts
git commit -m "feat: pure matrix-table renderer with honest cost math

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: matrix.ts runner + npm script + verified tier ids/prices

**Files:**
- Create: `evals/matrix.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `runEval` (Task 9), `renderMatrixTable`/`replaceBetweenMarkers`/`TierRow` (Task 10).
- Produces: `npm run eval-matrix` — sequential tier runs, regenerates the marker region in `docs/evals.md` (Task 12 adds the markers; until then the runner exits with the markers-not-found error, which is correct fail-closed behavior).

- [ ] **Step 1 (requires GEMINI_API_KEY): verify the tier model ids against the live models API**

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY&pageSize=200" | grep -o '"name": *"models/gemini-3.6[^"]*"' | sort -u
```

Expected: entries for the flash-lite, flash, and pro tiers of the current generation. Record the three exact ids. If a tier name differs from `gemini-3.6-flash-lite` / `gemini-3.6-flash` / `gemini-3.6-pro`, use the listed id in Step 3's `TIERS` (keep `google_genai:` prefixes) — never guess an id the API didn't list.

- [ ] **Step 2: look up current prices**

Open https://ai.google.dev/gemini-api/docs/pricing and record, for each of the three tier ids from Step 1: input $/1M tokens and output $/1M tokens (standard tier, non-batch). These go into `PRICES` in Step 3 in this exact shape (numbers below are format examples — use the page's real values):

```ts
"google_genai:gemini-3.6-flash": { inPerM: 0.30, outPerM: 2.50 },
```

Set `PRICE_AS_OF` to the current year-month (`"2026-08"`).

- [ ] **Step 3: Implement `evals/matrix.ts`**

```ts
/**
 * Gemini-tier eval matrix (spec 2026-08-10 §3.3): the identical golden set + pinned judges
 * per tier, sequentially (rate-limit friendly), then regenerate the table between
 * eval-matrix markers in docs/evals.md.
 *
 *   npm run eval-matrix
 *   EVAL_MATRIX_MODELS="google_genai:a,google_genai:b" npm run eval-matrix   # override tiers
 *
 * Requires LANGSMITH_API_KEY + GEMINI_API_KEY. Fail-closed: the doc is rewritten only if
 * the baseline tier succeeded; any tier failure exits non-zero.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runEval } from "./run";
import { renderMatrixTable, replaceBetweenMarkers, type TierRow } from "./matrixTable";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVALS_DOC = path.join(HERE, "..", "docs", "evals.md");
const START = "<!-- eval-matrix:start -->";
const END = "<!-- eval-matrix:end -->";

const BASELINE = "google_genai:gemini-3.6-flash"; // ids verified against the models API (plan Task 11 step 1)
const TIERS = process.env.EVAL_MATRIX_MODELS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [
  "google_genai:gemini-3.6-flash-lite",
  BASELINE,
  "google_genai:gemini-3.6-pro",
];

// USD per 1M tokens, from https://ai.google.dev/gemini-api/docs/pricing (plan Task 11 step 2).
// A tier with no entry renders its cost as "—" — never estimated.
const PRICE_AS_OF = "2026-08";
const PRICES: Record<string, { inPerM: number; outPerM: number }> = {
  // filled in step 2 — three entries, one per tier id
};

async function main() {
  for (const v of ["LANGSMITH_API_KEY", "GEMINI_API_KEY"]) {
    if (!process.env[v]) { console.error(`${v} is required`); process.exit(1); }
  }
  const rows: TierRow[] = [];
  for (const model of TIERS) {
    console.log(`\n=== ${model} ===`);
    try {
      const s = await runEval({ model, judges: true });
      rows.push({ model, ok: true, metrics: s.metrics, price: PRICES[model] ?? null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`tier failed: ${model}: ${msg}`);
      rows.push({ model, ok: false, error: msg, price: PRICES[model] ?? null });
    }
  }
  if (!rows.find((r) => r.model === BASELINE)?.ok) {
    console.error(`baseline ${BASELINE} failed — docs table NOT rewritten`);
    process.exit(1);
  }
  const doc = readFileSync(EVALS_DOC, "utf8");
  writeFileSync(EVALS_DOC, replaceBetweenMarkers(doc, START, END, renderMatrixTable(rows, PRICE_AS_OF)));
  console.log(`\nwrote matrix table to ${EVALS_DOC}`);
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

main();
```

- [ ] **Step 4: Add the npm script**

In `package.json` scripts, after `"eval"`:

```json
"eval-matrix": "npx tsx --env-file=.env evals/matrix.ts",
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. (No live run yet — the doc markers land in Task 12.)

- [ ] **Step 6: Commit**

```bash
git add evals/matrix.ts package.json
git commit -m "feat: eval-matrix runner - sequential Gemini tiers, fail-closed doc regeneration

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: docs/evals.md section, README pointer, live matrix run

**Files:**
- Modify: `docs/evals.md`, `README.md`

**Interfaces:** consumes the markers contract from Task 11 (`<!-- eval-matrix:start/end -->`).

- [ ] **Step 1: Add the Model selection section**

In `docs/evals.md`, insert after the `## Metrics` section (i.e., before `## Running`):

```markdown
## Model selection (Gemini tiers)

Same dataset, same judges (pinned to `GEMINI_JUDGE_MODEL`), same prompt — only the tier
under test changes, so row differences are attributable to the model alone. The production
choice stays evidence-based: the baseline tier must justify its cost/latency against its
siblings on the identical golden set. Regenerate with `npm run eval-matrix` (sequential,
fail-closed: the table is only rewritten when the baseline row succeeds).

<!-- eval-matrix:start -->
_Not yet generated — run `npm run eval-matrix`._
<!-- eval-matrix:end -->
```

- [ ] **Step 2: README pointer row**

In `README.md`'s "Evidence: the case study" table (line ~64), add a final row:

```markdown
| Gemini tier comparison (flash-lite / flash / pro, identical golden set + pinned judges) | see [docs/evals.md → Model selection](docs/evals.md#model-selection-gemini-tiers) |
```

- [ ] **Step 3 (requires keys; ~3× the single-run eval spend — deliberate, confirm with the owner before running): generate the real table**

Run: `npm run eval-matrix`
Expected: three sequential experiment runs; exit 0; the marker region in `docs/evals.md` now holds the real table with no `NaN` and a cost value in every row whose tier had both usage and a price entry. If a non-baseline tier fails on quota, the table records the failed row and the command exits 1 — rerun later; do not hand-edit numbers in.

- [ ] **Step 4: Full suite one last time**

Run: `npm test`
Expected: all suites pass (the two new files + four extended ones included).

- [ ] **Step 5: Commit**

```bash
git add docs/evals.md README.md
git commit -m "docs: model-selection matrix section + README evidence pointer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Spec-coverage map (self-check)

| Spec section | Task |
|---|---|
| §2.2 schema + views | 1 |
| §2.3 observer insert | 2 |
| §2.4 gate logic + constants | 3 |
| §2.5 promote / status / digest / docs | 4 / 5 / 6 / 7 |
| §2.6 error handling | 1 (fail-closed views), 3 (n=0 verdict), 4 (refusal path) |
| §2.7 testing incl. fixture-driven end-to-end | 1–6 (agreement.test.ts drives real decide/observer/views/gate zero-credential) |
| §3.1 runEval / --model / --json / pinned judges | 9 |
| §3.2 usage_metadata | 8 |
| §3.3 matrix runner, fail-closed doc write | 10, 11 |
| §3.4 docs artifact + README + 77.3% untouched | 12 (+ Global Constraints) |
| §3.5 pure-function tests, CI-free live runs | 10, 9 step 4 / 12 step 3 flagged |
| §5 success criteria | 1–6 (tests), 4–5 (CLI), 11–12 (one-command matrix), 7+12 (docs) |

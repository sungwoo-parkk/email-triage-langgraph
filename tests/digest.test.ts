import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { loadOfficeConfig, deriveVocabulary, setOfficeConfig } from "@/lib/officeConfig";
import { decide, recordDecision } from "@/lib/decide";
import { executeDecision, makeContextBodyFor } from "@/lib/act";
import { makeFakeMail } from "@/lib/mail/fake";
import { normalize } from "@/lib/normalize";
import { buildDigest } from "@/lib/digest";

// Same PGlite adapter as tests/observer.test.ts: parameterized query() can't run
// multi-statement DDL, so param-less CREATE/INSERT/ALTER go through exec() instead.
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
const cfg = loadOfficeConfig("examples/hartley/triage.config.json");
const vocab = deriveVocabulary(cfg);
const REVIEW = cfg.review.recipient;
const noRules = { hits: [], labels: [], forwards: [], complete: false };

// Mirrors tests/observer.test.ts's seedDecided/seedNeedsReview: real decide()/
// recordDecision() pipeline so final_tasks/status are genuine, not hand-rolled.
// Produces a "decided" row that stays decided (shadow-stage intent, nothing sent) -
// this is the "recorded only" half of the routed/recorded-only split under test.
async function seedDecided(db: Querier, threadId: string, categoryId: string, internalDateMs = NOW) {
  const email = normalize({
    threadId, from: "a@vendor.example", to: [], subject: `${threadId} subject`, listId: null,
    attachments: [], bodyText: "body", internalDateMs, references: [],
  });
  const llm = { tasks: [{ category: categoryId }], confidence: "high" as const, rationale: "test" };
  const appCfg = { stage: "shadow" as const, autoActLabels: [categoryId] };
  const d = decide(vocab, REVIEW, noRules, llm, appCfg);
  return recordDecision(db, email, noRules, llm, d, "shadow", null);
}

// A genuinely EXECUTED decision, same as tests/act.test.ts's "autonomous executes
// routee forwards" case: seed a decided row, then run it through the real
// executeDecision with a fake mail client in autonomous stage so it actually lands on
// status "acted" - buildDigest's "routed" count must only trust rows like this one.
async function seedActed(db: Querier, threadId: string, categoryId: string, internalDateMs = NOW) {
  const id = await seedDecided(db, threadId, categoryId, internalDateMs);
  const ctx = { vocab, contextBodyFor: makeContextBodyFor(db, vocab) };
  await executeDecision(db, makeFakeMail(), id, { stage: "autonomous", autoActLabels: [] }, ctx);
  return id;
}

async function seedNeedsReview(db: Querier, threadId: string, internalDateMs = NOW) {
  const email = normalize({
    threadId, from: "a@vendor.example", to: [], subject: `${threadId} subject`, listId: null,
    attachments: [], bodyText: "body", internalDateMs, references: [],
  });
  const appCfg = { stage: "shadow" as const, autoActLabels: [] };
  const d = decide(vocab, REVIEW, noRules, null, appCfg);
  return recordDecision(db, email, noRules, null, d, "shadow", null);
}

// decide()/recordDecision() never produce status "failed" (that only happens in
// act.ts's executeDecision catch block) - mirror that shape with a direct update,
// same as the brief allows for corrections.
async function seedFailed(db: Querier, threadId: string, detail: string) {
  const id = await seedDecided(db, threadId, "sales");
  await db.query(`update decisions set status = 'failed', error_detail = $2 where id = $1`, [id, detail]);
  return id;
}

describe("buildDigest", () => {
  let sinceMs: number;

  beforeEach(async () => {
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
    await setOfficeConfig(getDb(), cfg);
    // decisions.created_at is DB-generated (real now()), a different clock from the
    // fictional NOW constant used for internalDateMs below - sinceMs has to live on
    // the real clock too, or every row (inserted at real "now") falls outside it.
    sinceMs = Date.now() - 3600_000;

    await seedActed(getDb(), "a1", "jo"); // the only row that should count as "routed"

    await seedDecided(getDb(), "d1", "jo");
    const d2 = await seedDecided(getDb(), "d2", "sales"); // decided but never executed (shadow intent)

    await seedNeedsReview(getDb(), "r1");
    await seedNeedsReview(getDb(), "r2");

    await seedFailed(getDb(), "f1", "forward to sales@hartleysons.example failed: connection reset");

    await getDb().query(
      `insert into corrections (thread_id, decision_id, category_id, observed_from) values ($1,$2,$3,'sent-forward')`,
      ["d2", d2, "support"]
    );
  });

  it("counts by status and reports the office-day totals in the subject", async () => {
    const { subject } = await buildDigest(getDb(), sinceMs);
    // "routed" only trusts acted rows (a1) - the two merely-decided rows (d1, d2) are
    // shadow-stage proposals that never actually sent or labeled anything.
    expect(subject).toBe("[triage] daily digest — 1 routed, 2 waiting, 1 errors");
  });

  it("lists failure detail, the pending-review count, corrections, and the shadow-recorded-only line in the body", async () => {
    const { body } = await buildDigest(getDb(), sinceMs);
    expect(body).toContain("connection reset");
    expect(body).toMatch(/2 (waiting for|pending|needing) review/i);
    expect(body).toMatch(/1 correction/i);
    // decided-but-not-acted rows (d1, d2) get their own truthful line, not folded
    // into "routed" - must not claim anything was actually sent or labeled.
    expect(body).toMatch(/shadow/i);
    expect(body).toMatch(/nothing was sent or labeled/i);
    expect(body).toMatch(/2 would have been auto-routed/i);
  });

  it("omits the shadow-recorded-only line when nothing is merely decided", async () => {
    // A fresh DB with only an acted row and no bare "decided" leftovers.
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
    await setOfficeConfig(getDb(), cfg);
    await seedActed(getDb(), "only-acted", "jo");
    const since = Date.now() - 3600_000;
    const { subject, body } = await buildDigest(getDb(), since);
    expect(subject).toBe("[triage] daily digest — 1 routed, 0 waiting, 0 errors");
    expect(body).not.toMatch(/would have been auto-routed/i);
  });

  it("only counts activity since the given timestamp", async () => {
    // recordDecision (and executeDecision's status update) always stamp created_at via
    // the DB's now(), so backdating a seeded row (to simulate activity from before the
    // digest window) needs a direct update - same allowance the brief gives corrections
    // seeding. This exercises the filter on the "acted"/routed bucket specifically,
    // since that's the count the fix round narrowed.
    const oldId = await seedActed(getDb(), "old", "jo");
    await getDb().query(`update decisions set created_at = now() - interval '2 hours' where id = $1`, [oldId]);
    const { subject } = await buildDigest(getDb(), sinceMs);
    expect(subject).toBe("[triage] daily digest — 1 routed, 2 waiting, 1 errors"); // "old" predates sinceMs
  });
});

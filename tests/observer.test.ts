import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { loadOfficeConfig, deriveVocabulary, setOfficeConfig } from "@/lib/officeConfig";
import { decide, recordDecision } from "@/lib/decide";
import { normalize } from "@/lib/normalize";
import { makeFakeMail } from "@/lib/mail/fake";
import type { ThreadSnapshot } from "@/lib/mail/types";
import { observeSentMail } from "@/lib/observer";
import { executeDecision, makeContextBodyFor } from "@/lib/act";
import { TRIAGE_MARKER } from "@/lib/review";

// Same adapter as tests/officeStore.test.ts (migration 004's own suite): PGlite's
// parameterized query() cannot run multi-statement DDL, so CREATE/INSERT/ALTER with
// no params go through exec() instead.
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
const REVIEW = cfg.review.recipient; // "jo@hartleysons.example"
const noRules = { hits: [], labels: [], forwards: [], complete: false };
const appCfg = { stage: "shadow" as const, autoActLabels: [] };

function snap(threadId: string, over: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    threadId, from: "a@vendor.example", to: [], subject: `${threadId} subject`, listId: null,
    attachments: [], bodyText: "", internalDateMs: NOW, references: [], ...over,
  };
}

// Mirrors tests/act.test.ts / tests/decide.test.ts: seed threads + decisions via the
// real decide()/recordDecision() pipeline rather than hand-rolled SQL, so final_tasks
// is a genuine TriageTask[] (Task 7 shape). llm=null -> decide() returns status
// "needs_review" with tasks: [] (mirrors a thread awaiting human review).
async function seedNeedsReview(db: Querier, threadId: string, fromAddr = "a@vendor.example", internalDateMs = NOW - 10_000) {
  const email = normalize({
    threadId, from: fromAddr, to: [], subject: `${threadId} subject`, listId: null,
    attachments: [], bodyText: "body", internalDateMs, references: [],
  });
  const d = decide(vocab, REVIEW, noRules, null, appCfg);
  return recordDecision(db, email, noRules, null, d, "shadow", null);
}

// Same real decide()/recordDecision() pipeline, but with a high-confidence LLM
// classification and categoryId in autoActLabels so decide() lands on status
// "decided" with a resolved TriageTask routed to categoryId — exercises the
// status !== "needs_review" half of the observer's correction condition.
async function seedDecided(db: Querier, threadId: string, categoryId: string, fromAddr = "a@vendor.example", internalDateMs = NOW - 10_000) {
  const email = normalize({
    threadId, from: fromAddr, to: [], subject: `${threadId} subject`, listId: null,
    attachments: [], bodyText: "body", internalDateMs, references: [],
  });
  const llm = { tasks: [{ category: categoryId }], confidence: "high" as const, rationale: "test" };
  const decidedCfg = { stage: "shadow" as const, autoActLabels: [categoryId] };
  const d = decide(vocab, REVIEW, noRules, llm, decidedCfg);
  return recordDecision(db, email, noRules, llm, d, "shadow", null);
}

describe("observeSentMail", () => {
  beforeEach(async () => {
    // Fresh PGlite per test so ingest_state row 2's checkpoint (and the corrections/
    // rules tables) never leak across tests.
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
    await setOfficeConfig(getDb(), cfg);
    for (const id of ["t1", "t2", "t3", "t4", "t5"]) await seedNeedsReview(getDb(), id);
  });

  it("records a correction when the reviewer forwards a reviewed thread to a routee", async () => {
    const mail = makeFakeMail({ sent: [snap("t1", { to: ["jo@hartleysons.example"], internalDateMs: NOW - 1000 })] });
    const r = await observeSentMail(getDb(), mail, cfg, NOW);
    expect(r.corrections).toBe(1);
    const { rows } = await getDb().query(`select category_id from corrections where thread_id='t1'`);
    expect(rows[0].category_id).toBe("jo");
  });

  it("ignores forwards of unknown threads and non-routee recipients", async () => {
    const mail = makeFakeMail({
      sent: [
        snap("nope", { to: ["jo@hartleysons.example"], internalDateMs: NOW - 1000 }),
        snap("t2", { to: ["stranger@elsewhere.example"], internalDateMs: NOW - 1000 }),
      ],
    });
    expect((await observeSentMail(getDb(), mail, cfg, NOW)).corrections).toBe(0);
  });

  it("advances the sent checkpoint so a correction is not double-counted", async () => {
    const mail = makeFakeMail({ sent: [snap("t1", { to: ["jo@hartleysons.example"], internalDateMs: NOW - 1000 })] });
    await observeSentMail(getDb(), mail, cfg, NOW);
    expect((await observeSentMail(getDb(), mail, cfg, NOW)).corrections).toBe(0);
  });

  it("promotes a learned sender_exact rule after 3 consistent corrections", async () => {
    // t1, t2, t3 all come from a@vendor.example (seeded in beforeEach) and all get
    // forwarded to jo. Three separate observer runs, each with a later internalDateMs,
    // mirror three ingest cycles picking up one new reviewer-forward at a time.
    const mail = makeFakeMail();
    const threadIds = ["t1", "t2", "t3"];
    for (const [i, threadId] of threadIds.entries()) {
      mail.pushSent(snap(threadId, { to: ["jo@hartleysons.example"], internalDateMs: NOW - 3000 + i * 1000 }));
      const r = await observeSentMail(getDb(), mail, cfg, NOW);
      expect(r.corrections).toBe(1); // exactly the newly-visible thread each run
    }

    const { rows } = await getDb().query(`select pattern, source, label_set from rules where pattern='a@vendor.example'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("learned");
    // jsonb columns come back already parsed as JS values through this adapter (see
    // tests/seed.test.ts, tests/act.test.ts) rather than as JSON strings, so guard both.
    const labelSet = typeof rows[0].label_set === "string" ? JSON.parse(rows[0].label_set) : rows[0].label_set;
    expect(labelSet).toEqual(["jo"]);
  });

  it("agreement with a decided routing is not a correction", async () => {
    await seedDecided(getDb(), "t-agree", "sales");
    const mail = makeFakeMail({ sent: [snap("t-agree", { to: ["sales@hartleysons.example"], internalDateMs: NOW - 1000 })] });
    const r = await observeSentMail(getDb(), mail, cfg, NOW);
    expect(r.corrections).toBe(0);
    const { rows } = await getDb().query(`select 1 from corrections where thread_id='t-agree'`);
    expect(rows).toHaveLength(0);
  });

  it("a forward that contradicts a decided routing IS a correction", async () => {
    await seedDecided(getDb(), "t-contra", "sales");
    const mail = makeFakeMail({ sent: [snap("t-contra", { to: ["support@hartleysons.example"], internalDateMs: NOW - 1000 })] });
    const r = await observeSentMail(getDb(), mail, cfg, NOW);
    expect(r.corrections).toBe(1);
    const { rows } = await getDb().query(`select category_id from corrections where thread_id='t-contra'`);
    expect(rows[0].category_id).toBe("support");
  });
});

// Finding C2: at assisted+ stage, act.ts review-forwards a needs_review decision to
// cfg.review.recipient - and review.recipient is typically ALSO a routee (the Hartley
// example's "jo" is both). Left unfiltered, observeSentMail mistook that system-generated
// forward for a human correction: 3 needs_review threads from one sender was enough to mint
// a bogus purity-1.0 learned rule from a "correction" no human ever made. The fix is to skip
// any sent snapshot whose body carries TRIAGE_MARKER (review.ts's buildContextBody always
// opens with it) - these two tests prove the real act layer's own forward is now excluded,
// while a genuine human forward (no marker) still counts.
describe("observeSentMail: system review-forwards are not human corrections (finding C2)", () => {
  beforeEach(async () => {
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
    await setOfficeConfig(getDb(), cfg);
  });

  it("a review-forward the real act layer sends at assisted stage does NOT create a correction", async () => {
    const decisionId = await seedNeedsReview(getDb(), "t-poison");
    // Seed the fake mail's sent history near NOW so its deterministic forward-date counter
    // (see src/lib/mail/fake.ts) starts near NOW too, landing the act layer's forward inside
    // the window observeSentMail will scan below.
    const mail = makeFakeMail({ sent: [snap("seed", { to: ["nobody@nowhere.example"], internalDateMs: NOW - 2000 })] });
    const ctx = { vocab, contextBodyFor: makeContextBodyFor(getDb(), vocab) };

    await executeDecision(getDb(), mail, decisionId, { stage: "assisted", autoActLabels: [] }, ctx);
    const forwarded = mail.log.find((l) => l.startsWith(`forward:t-poison:${REVIEW}:`));
    expect(forwarded).toBeTruthy(); // sanity: the review-forward actually ran and reached the reviewer
    expect(forwarded).toContain(TRIAGE_MARKER);

    const r = await observeSentMail(getDb(), mail, cfg, NOW);
    expect(r.corrections).toBe(0);
    const { rows } = await getDb().query(`select 1 from corrections where thread_id='t-poison'`);
    expect(rows).toHaveLength(0);
  });

  it("a genuine human forward (no TRIAGE_MARKER) of the same shape still records a correction", async () => {
    await seedNeedsReview(getDb(), "t-human");
    const mail = makeFakeMail({
      sent: [snap("t-human", { to: [REVIEW], bodyText: "Jo - can you take this one? Thanks - reception", internalDateMs: NOW - 1000 })],
    });
    const r = await observeSentMail(getDb(), mail, cfg, NOW);
    expect(r.corrections).toBe(1);
    const { rows } = await getDb().query(`select category_id from corrections where thread_id='t-human'`);
    expect(rows[0].category_id).toBe("jo");
  });
});

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

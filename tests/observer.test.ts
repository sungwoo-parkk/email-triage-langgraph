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
});

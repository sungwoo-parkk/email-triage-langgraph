import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { executeDecision, makeContextBodyFor } from "@/lib/act";
import { recordDecision, decide } from "@/lib/decide";
import { normalize } from "@/lib/normalize";
import { makeFakeMail } from "@/lib/mail/fake";
import { loadOfficeConfig, deriveVocabulary, setOfficeConfig, configHash, type Vocabulary } from "@/lib/officeConfig";
import type { MailClient } from "@/lib/mail/types";

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
const REVIEW = officeCfg.review.recipient; // "jo@hartleysons.example"
const HASH = configHash(officeCfg);

// A "decided" decision (category allowed -> categories + routee forward) and a
// "needs_review" decision (category outside the allow-list -> review-forward only),
// both produced the same way the real graph would via decide()/recordDecision().
async function seedDecided(threadId: string): Promise<number> {
  const email = normalize({ threadId, from: "cust@x.example", to: [], subject: "quote request", listId: null, attachments: [], bodyText: "please send a quote for a new policy", internalDateMs: 1, references: [] });
  const rule = { hits: [], labels: [], forwards: [], complete: false };
  const llm = { tasks: [{ category: "sales" }], confidence: "high" as const, rationale: "wants pricing" };
  const cfg = { stage: "shadow" as const, autoActLabels: ["sales"] };
  const d = decide(vocab, REVIEW, rule, llm, cfg);
  return recordDecision(getDb(), email, rule, llm, d, "shadow", HASH);
}

async function seedNeedsReview(threadId: string): Promise<number> {
  const email = normalize({ threadId, from: "cust@x.example", to: [], subject: "order problem", listId: null, attachments: [], bodyText: "my order arrived broken", internalDateMs: 1, references: [] });
  const rule = { hits: [], labels: [], forwards: [], complete: false };
  const llm = { tasks: [{ category: "support" }], confidence: "high" as const, rationale: "broken order" };
  const cfg = { stage: "shadow" as const, autoActLabels: ["sales"] }; // "support" not allowed -> review
  const d = decide(vocab, REVIEW, rule, llm, cfg);
  return recordDecision(getDb(), email, rule, llm, d, "shadow", HASH);
}

describe("executeDecision", () => {
  let ctx: { vocab: Vocabulary; contextBodyFor(decisionId: number): Promise<string> };

  beforeEach(async () => {
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
    await setOfficeConfig(getDb(), officeCfg);
    ctx = { vocab, contextBodyFor: makeContextBodyFor(getDb(), vocab) };
  });

  it("shadow executes nothing", async () => {
    const id = await seedDecided("s1");
    const mail = makeFakeMail();
    await executeDecision(getDb(), mail, id, { stage: "shadow", autoActLabels: [] }, ctx);
    expect(mail.log).toEqual([]);
    const { rows } = await getDb().query(`select status from decisions where id=$1`, [id]);
    expect(rows[0].status).toBe("decided");
  });

  it("assisted applies categories and review-forwards, never routee forwards", async () => {
    const decidedId = await seedDecided("s2");
    const reviewId = await seedNeedsReview("s3");
    const mail = makeFakeMail();
    const cfg = { stage: "assisted" as const, autoActLabels: [] };

    await executeDecision(getDb(), mail, decidedId, cfg, ctx);
    expect(mail.log.some((l) => l.startsWith("categories:s2:triage/sales"))).toBe(true);
    expect(mail.log.some((l) => l.startsWith("forward:s2:"))).toBe(false); // routee forward blocked in assisted

    await executeDecision(getDb(), mail, reviewId, cfg, ctx);
    const reviewForward = mail.log.find((l) => l.startsWith(`forward:s3:${REVIEW}:`));
    expect(reviewForward).toBeTruthy();

    const { rows } = await getDb().query(`select status from decisions where id=$1`, [reviewId]);
    expect(rows[0].status).toBe("needs_review"); // review-forward ran, but a human still has to look
  });

  it("autonomous executes routee forwards with the context body", async () => {
    const id = await seedDecided("s4");
    const mail = makeFakeMail();
    await executeDecision(getDb(), mail, id, { stage: "autonomous", autoActLabels: [] }, ctx);
    const fwd = mail.log.find((l) => l.startsWith("forward:s4:sales@hartleysons.example:"));
    expect(fwd).toBeTruthy();
    expect(fwd).toContain("[triage]"); // Task 3 carry-forward: no empty-string forward bodies
    const { rows } = await getDb().query(`select status from decisions where id=$1`, [id]);
    expect(rows[0].status).toBe("acted");
  });

  it("remains idempotent per action across re-runs", async () => {
    const id = await seedDecided("s5");
    const mail = makeFakeMail();
    const cfg = { stage: "autonomous" as const, autoActLabels: [] };
    await executeDecision(getDb(), mail, id, cfg, ctx);
    const first = [...mail.log];
    await executeDecision(getDb(), mail, id, cfg, ctx); // second run must be a no-op
    expect(mail.log).toEqual(first);
  });

  it("a failing forward marks the decision failed but keeps executed categories recorded", async () => {
    const id = await seedDecided("s6");
    const failingMail: MailClient = {
      listNewThreads: async () => [], listHistory: async function* () {}, ensureCategories: async () => {},
      applyCategories: async () => {},
      forward: async () => { throw new Error("smtp down"); }, sendMessage: async () => {},
    };
    await executeDecision(getDb(), failingMail, id, { stage: "autonomous", autoActLabels: [] }, ctx);
    const { rows } = await getDb().query(`select status, actions_executed, error_detail from decisions where id=$1`, [id]);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error_detail).toBe("smtp down");
    const executed = typeof rows[0].actions_executed === "string" ? JSON.parse(rows[0].actions_executed) : rows[0].actions_executed;
    expect(executed.some((a: any) => a.kind === "categories")).toBe(true);
  });
});

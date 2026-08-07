/**
 * Zero-credential demo: runs six representative emails from the example office's own
 * mail history (examples/hartley/history.json) through the REAL triage pipeline (rules
 * engine -> classifier -> decide gate -> record -> act) on an in-memory Postgres
 * (PGlite). Gmail is faked; the classifier is canned unless you pass --live with
 * GEMINI_API_KEY set (examples/hartley/triage.config.json's configured model).
 *
 *   npm run demo            # fully offline, no keys needed
 *   npm run demo -- --live  # real Gemini classification of the same emails
 */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "../src/lib/db";
import { runMigrations } from "../src/lib/migrate";
import { buildTriageGraph } from "../src/graph/triage";
import type { ThreadSnapshot } from "../src/lib/mail/types";
import { setConfigKey, getConfig } from "../src/lib/config";
import { executeDecision, makeContextBodyFor } from "../src/lib/act";
import type { MailClient } from "../src/lib/mail/types";
import { makeClassifier, type Classification } from "../src/lib/classify";
import { loadOfficeConfig, setOfficeConfig, deriveVocabulary } from "../src/lib/officeConfig";

const officeCfg = loadOfficeConfig("examples/hartley/triage.config.json");
const history = JSON.parse(readFileSync("examples/hartley/history.json", "utf8")) as {
  inbox: ThreadSnapshot[]; sent: ThreadSnapshot[];
};
const byThreadId = new Map(history.inbox.map((t) => [t.threadId, t]));
const snap = (threadId: string): ThreadSnapshot => {
  const t = byThreadId.get(threadId);
  if (!t) throw new Error(`demo fixture: no such thread in examples/hartley/history.json: ${threadId}`);
  return t;
};

// A real office's autoActLabels come from the onboarding eval (see `triage init`'s mining
// pipeline), never hand-curated. This demo skips that pipeline for speed and just states
// the outcome directly - "jo" and "sales" measured strong, "support" and the builtin
// "junk" stay review-only - so the shadow/autonomous narrative below has something to
// contrast against.
const AUTO_ACT_IDS = ["jo", "sales"];

interface Fixture { threadId: string; canned: Classification | "rule-handles-this"; note: string }

const FIXTURES: Fixture[] = [
  {
    threadId: "hartley-vendor-03",
    note: "vendor statement -> deterministic mined rule (sender_domain officesupply.example), LLM never called",
    canned: "rule-handles-this",
  },
  {
    threadId: "hartley-quote-01",
    note: "clear quote request -> sales desk, strong category, auto-decides",
    canned: { tasks: [{ category: "sales" }], confidence: "high", rationale: "New quote request for chairs; routes to the sales desk." },
  },
  {
    threadId: "hartley-newsletter-01",
    note: "trade newsletter -> junk is review-only even at high confidence (never auto-acted)",
    canned: { tasks: [{ category: "junk" }], confidence: "high", rationale: "Marketing newsletter, no action needed." },
  },
  {
    threadId: "hartley-support-01",
    note: "order-status question -> support desk, measured weaker, stays review-only for now",
    canned: { tasks: [{ category: "support" }], confidence: "high", rationale: "Order status inquiry; routes to the support desk." },
  },
  {
    threadId: "hartley-mix-03",
    note: "genuinely ambiguous invoice question -> honest medium confidence routes to a human",
    canned: { tasks: [{ category: "jo" }], confidence: "medium", rationale: "Possible invoice discrepancy; amount doesn't clearly match a known order." },
  },
  {
    threadId: "hartley-mix-15",
    note: "two requests in one email -> two tasks; the weaker one (support) holds back the whole decision",
    canned: {
      tasks: [{ category: "sales" }, { category: "support" }],
      confidence: "high",
      rationale: "A new quote request plus an unrelated order-status check.",
    },
  },
];

function fakeGmail(log: string[]): MailClient {
  return {
    listNewThreads: async () => [],
    listHistory: async function* () {},
    ensureCategories: async () => {},
    applyCategories: async (id, labels) => { log.push(`  gmail.applyCategories   ${id}  [${labels.join(", ")}]`); },
    forward: async (id, to, contextBody) => { log.push(`  gmail.forward       ${id}  -> ${to}  (${contextBody.slice(0, 40)}...)`); },
    sendMessage: async () => { log.push("  gmail.sendMessage"); },
  };
}

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

async function main() {
  const live = process.argv.includes("--live");
  if (live && !process.env[officeCfg.llm.apiKeyEnv]) {
    console.error(`--live requires ${officeCfg.llm.apiKeyEnv}`); process.exit(1);
  }

  const p = new PGlite();
  // Same adapter as the test suite: exec for multi-statement DDL, query otherwise.
  setDb({
    query: async (sql, params) => {
      if (!params || params.length === 0) {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith("CREATE") || trimmed.startsWith("INSERT") || trimmed.startsWith("ALTER")) {
          await p.exec(sql);
          return { rows: [] };
        }
      }
      return p.query(sql, params as any[]) as any;
    },
  } satisfies Querier);
  const db = getDb();
  await runMigrations(db);
  await setOfficeConfig(db, officeCfg);
  await setConfigKey(db, "autoActLabels", AUTO_ACT_IDS);
  // The mined-gold rule `triage init` would have produced from this office's own mail
  // history (validated against examples/hartley/history.json: 8/8 pure, support 8 - see
  // Step 1 of the Task 11 brief). Inserted directly here so the demo stays offline.
  await db.query(
    `insert into rules (pattern_type, pattern, label_set, complete, purity, support, source)
     values ('sender_domain', 'officesupply.example', '["jo"]', true, 1.0, 8, 'mined-gold')`
  );

  const canned = new Map(FIXTURES.map((f) => [f.threadId, f.canned]));
  const classify = live
    ? makeClassifier(officeCfg, [])
    : async (email: { threadId: string }) => {
        const c = canned.get(email.threadId);
        if (c === "rule-handles-this") throw new Error(`LLM called for ${email.threadId} - the rule should have handled it`);
        return c as Classification;
      };

  const gmailLog: string[] = [];
  const graph = buildTriageGraph({ db, mail: fakeGmail(gmailLog), classify: classify as any });

  console.log(`\n=== TRIAGE DEMO: ${officeCfg.office.name} ${live ? "(live Gemini)" : "(offline, canned classifier)"} ===\n`);
  console.log("STAGE: shadow - the pipeline decides and records, Gmail is never touched.\n");
  console.log(`  ${pad("FROM", 34)} ${pad("SUBJECT", 40)} ${pad("LABELS", 24)} ${pad("FWD", 30)} ${pad("CONF", 6)} STATUS`);
  console.log("  " + "-".repeat(140));

  const ids: number[] = [];
  let sampleReviewDecisionId: number | null = null;
  for (const f of FIXTURES) {
    const email = snap(f.threadId);
    const id = await graph.run(await normalizeSnap(email));
    ids.push(id);
    const { rows } = await db.query(`select final_tasks, confidence, status from decisions where id = $1`, [id]);
    const tasks = typeof rows[0].final_tasks === "string" ? JSON.parse(rows[0].final_tasks) : rows[0].final_tasks;
    const labels = [...new Set(tasks.map((t: any) => t.label))].join(", ");
    const fwd = tasks.map((t: any) => t.forwardTo).filter(Boolean).join(", ") || "-";
    if (rows[0].status === "needs_review" && sampleReviewDecisionId === null) sampleReviewDecisionId = id;
    console.log(`  ${pad(email.from.replace(/^.*</, "").replace(/>$/, ""), 34)} ${pad(email.subject, 40)} ${pad(labels || "-", 24)} ${pad(fwd, 30)} ${pad(rows[0].confidence, 6)} ${rows[0].status}`);
    console.log(`  ${pad("", 34)} > ${f.note}`);
  }

  console.log(`\n  Gmail API calls so far (shadow): ${gmailLog.length}  <- zero writes, by construction\n`);

  console.log("STAGE: autonomous - same decisions, now the act layer executes what the stage permits.\n");
  await setConfigKey(db, "stage", "autonomous");
  const cfg = await getConfig(db);
  const vocab = deriveVocabulary(officeCfg);
  const contextBodyFor = makeContextBodyFor(db, vocab);
  const ctx = { vocab, contextBodyFor };
  for (const id of ids) await executeDecision(db, fakeGmail(gmailLog), id, cfg, ctx);
  gmailLog.forEach((l) => console.log(l));
  console.log(`\n  Executed ${gmailLog.length} Gmail action(s). needs_review decisions still send a review-forward (a`);
  console.log(`  planned action, gated like any other) but their status stays needs_review for a human.`);

  if (sampleReviewDecisionId !== null) {
    console.log(`\n  Sample review-forward context body (decision #${sampleReviewDecisionId}):\n`);
    console.log((await contextBodyFor(sampleReviewDecisionId)).split("\n").map((l) => `    ${l}`).join("\n"));
  }

  const before = gmailLog.length;
  for (const id of ids) await executeDecision(db, fakeGmail(gmailLog), id, cfg, ctx);
  console.log(`\n  Re-running all decisions executes ${gmailLog.length - before} action(s) - idempotency: a retry can never double-send.\n`);
}

async function normalizeSnap(s: ThreadSnapshot) {
  const { normalize } = await import("../src/lib/normalize");
  return normalize(s);
}

main().then(() => process.exit(0)).catch((e) => { console.error("DEMO FAILED:", e); process.exit(1); });

/**
 * Zero-credential demo: runs synthetic insurance emails through the REAL triage
 * pipeline (rules engine -> classifier -> decide gate -> record -> act) on an
 * in-memory Postgres (PGlite). Gmail is faked; the classifier is canned unless
 * you pass --live with GEMINI_API_KEY set.
 *
 *   npm run demo            # fully offline, no keys needed
 *   npm run demo -- --live  # real Gemini classification of the same emails
 */
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "../src/lib/db";
import { runMigrations } from "../src/lib/migrate";
import { buildTriageGraph } from "../src/graph/triage";
import type { ThreadSnapshot } from "../src/lib/normalize";
import { setConfigKey, getConfig } from "../src/lib/config";
import { executeDecision } from "../src/lib/act";
import type { MailClient } from "../src/lib/mail/types";
import { makeClassifier, type Classification } from "../src/lib/classify";

interface Fixture { snap: ThreadSnapshot; canned: Classification | "rule-handles-this"; note: string }

const FIXTURES: Fixture[] = [
  {
    note: "carrier print feed -> deterministic rule, LLM never called",
    snap: { threadId: "demo-1", from: "DB Agent Copy <ny_agent_copy@dxc.com>", subject: "Agent Copy of Print - Policy DP2201984",
      listId: null, attachments: ["DP2201984.pdf"], bodyText: "Attached is the agent copy of the policy print.", internalDateMs: 1, to: [], references: [] },
    canned: "rule-handles-this",
  },
  {
    note: "carrier cancellation notice -> structural co-emit adds DOCS&NOTICE",
    snap: { threadId: "demo-2", from: "Policy Services <policyservices@lighthouse-mutual.example>", subject: "Cancellation Endorsement - Policy CP8811223 - RIVERSIDE HARDWARE LLC",
      listId: null, attachments: ["cancellation-endorsement.pdf"], bodyText: "Please find the cancellation endorsement effective 09/15 for nonpayment of premium.", internalDateMs: 2, to: [], references: [] },
    canned: { tasks: [{ labels: ["Cancelllation"], forward_to: "none" }], confidence: "high", rationale: "Carrier-issued cancellation endorsement." },
  },
  {
    note: "loss run request -> strong category, auto-decides",
    snap: { threadId: "demo-3", from: "Amy Torres <amy@harborpoint-ins.example>", subject: "Loss runs needed - GOLDEN WOK RESTAURANT INC",
      listId: null, attachments: [], bodyText: "Hi team, could you send 3 years of loss runs for the above insured? Renewal marketing.", internalDateMs: 3, to: [], references: [] },
    canned: { tasks: [{ labels: ["7-Loss Run Req", "3-KR"], forward_to: "none" }], confidence: "high", rationale: "Broker requests claims history." },
  },
  {
    note: "NY workers-comp certificate -> strong category, auto-decides",
    snap: { threadId: "demo-4", from: "CSR Desk <csr@midtowncoverage.example>", subject: "C105 for GREEN GARDEN DELI CORP WWC1122334",
      listId: null, attachments: ["cert-holder.png"], bodyText: "Please provide C-105.2 with the below certificate holder. Thank you.", internalDateMs: 4, to: [], references: [] },
    canned: { tasks: [{ labels: ["8-C-105.2", "3-KR"], forward_to: "none" }], confidence: "high", rationale: "NY WC certificate request (WWC prefix)." },
  },
  {
    note: "carrier invoice -> Billing is review-only even at high confidence",
    snap: { threadId: "demo-5", from: "AR <billing@lighthouse-mutual.example>", subject: "Commission statement and invoice - August",
      listId: null, attachments: ["invoice-0826.pdf"], bodyText: "Your monthly statement is attached. Amount due: $4,120.55 by 09/01.", internalDateMs: 5, to: [], references: [] },
    canned: { tasks: [{ labels: ["Billing", "3-KR"], forward_to: "invoice@agency.example" }], confidence: "high", rationale: "Carrier invoice for the agency." },
  },
  {
    note: "two requests in one email -> two tasks; weaker one holds the whole decision",
    snap: { threadId: "demo-6", from: "Gina Park <gina@queensbridge-brokers.example>", subject: "MAPLE CLEANERS - address change + cancel BOP",
      listId: null, attachments: ["signed-LPR.pdf"], bodyText: "Two things: update the mailing address to 44-02 Main St, and cancel the BOP effective 9/30 - signed LPR attached.", internalDateMs: 6, to: [], references: [] },
    canned: { tasks: [
      { labels: ["3-Endorsement", "3-KR"], forward_to: "none" },
      { labels: ["4-CAN REQ", "3-KR"], forward_to: "none" },
    ], confidence: "high", rationale: "Endorsement request plus broker cancellation request." },
  },
  {
    note: "NHO homeowners endorsement -> desk-convention forward",
    snap: { threadId: "demo-7", from: "Leo Chan <leo@brightpath-brokerage.example>", subject: "NHO - add mortgagee clause - 88 GARDEN AVE",
      listId: null, attachments: [], bodyText: "Please add the mortgagee clause below to the homeowners policy and send the updated dec page.", internalDateMs: 7, to: [], references: [] },
    canned: { tasks: [{ labels: ["2-NY/Endorsement", "2-NY"], forward_to: "express@agency.example" }], confidence: "high", rationale: "NHO book endorsement; express desk convention." },
  },
  {
    note: "newsletter -> disregard is review-only (never auto-acted)",
    snap: { threadId: "demo-8", from: "Insurance Weekly <news@insuranceweekly.example>", subject: "5 trends reshaping commercial lines",
      listId: "<news.insuranceweekly.example>", attachments: [], bodyText: "This week in insurance: markets, MGAs, and more. Unsubscribe anytime.", internalDateMs: 8, to: [], references: [] },
    canned: { tasks: [{ labels: ["disregard"], forward_to: "none" }], confidence: "high", rationale: "Marketing newsletter, no action." },
  },
  {
    note: "genuinely ambiguous -> honest medium confidence routes to humans",
    snap: { threadId: "demo-9", from: "info@oldclient.example", subject: "question about my policy",
      listId: null, attachments: [], bodyText: "Hi, I had a question about what my policy covers, can someone call me back?", internalDateMs: 9, to: [], references: [] },
    canned: { tasks: [{ labels: ["2-NY"], forward_to: "none" }], confidence: "medium", rationale: "Unclear request; front-office judgment needed." },
  },
];

function fakeGmail(log: string[]): MailClient {
  return {
    listNewThreads: async () => [],
    listHistory: async function* () {},
    ensureCategories: async () => {},
    applyCategories: async (id, labels) => { log.push(`  gmail.applyCategories   ${id}  [${labels.join(", ")}]`); },
    forward: async (id, to) => { log.push(`  gmail.forward       ${id}  -> ${to}`); },
    sendMessage: async () => { log.push("  gmail.sendMessage"); },
  };
}

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

async function main() {
  const live = process.argv.includes("--live");
  if (live && !process.env.GEMINI_API_KEY) {
    console.error("--live requires GEMINI_API_KEY"); process.exit(1);
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
  await db.query(
    `insert into rules (pattern_type, pattern, label_set, complete, source)
     values ('sender_domain', 'dxc.com', '["3-KR","3-KR/DOCS&NOTICE"]', true, 'phase0')`
  );

  const canned = new Map(FIXTURES.map((f) => [f.snap.threadId, f.canned]));
  const classify = live
    ? makeClassifier()
    : async (email: { threadId: string }) => {
        const c = canned.get(email.threadId);
        if (c === "rule-handles-this") throw new Error(`LLM called for ${email.threadId} - the rule should have handled it`);
        return c as Classification;
      };

  const gmailLog: string[] = [];
  const graph = buildTriageGraph({ db, gmail: fakeGmail(gmailLog), classify: classify as any });

  console.log(`\n=== EMAIL TRIAGE DEMO ${live ? "(live Gemini)" : "(offline, canned classifier)"} ===\n`);
  console.log("STAGE: shadow - the pipeline decides and records, Gmail is never touched.\n");
  console.log(`  ${pad("FROM", 34)} ${pad("SUBJECT", 40)} ${pad("LABELS", 38)} ${pad("FWD", 18)} ${pad("CONF", 6)} STATUS`);
  console.log("  " + "-".repeat(148));

  const ids: number[] = [];
  for (const f of FIXTURES) {
    const id = await graph.run(await normalizeSnap(f.snap));
    ids.push(id);
    const { rows } = await db.query(`select final_tasks, confidence, status from decisions where id = $1`, [id]);
    const tasks = typeof rows[0].final_tasks === "string" ? JSON.parse(rows[0].final_tasks) : rows[0].final_tasks;
    const labels = [...new Set(tasks.flatMap((t: any) => t.labels))].join(", ");
    const fwd = tasks.map((t: any) => t.forwardTo).filter(Boolean).join(", ") || "-";
    console.log(`  ${pad(f.snap.from.replace(/^.*</, "").replace(/>$/, ""), 34)} ${pad(f.snap.subject, 40)} ${pad(labels || "-", 38)} ${pad(fwd, 18)} ${pad(rows[0].confidence, 6)} ${rows[0].status}`);
    console.log(`  ${pad("", 34)} > ${f.note}`);
  }

  console.log(`\n  Gmail API calls so far (shadow): ${gmailLog.length}  <- zero writes, by construction\n`);

  console.log("STAGE: autonomous - same decisions, now the act layer executes what the stage permits.\n");
  await setConfigKey(db, "stage", "autonomous");
  const cfg = await getConfig(db);
  for (const id of ids) await executeDecision(db, fakeGmail(gmailLog), id, cfg);
  gmailLog.forEach((l) => console.log(l));
  console.log(`\n  Executed ${gmailLog.length} Gmail action(s). needs_review decisions executed nothing - they wait for a human.`);

  const before = gmailLog.length;
  for (const id of ids) await executeDecision(db, fakeGmail(gmailLog), id, cfg);
  console.log(`  Re-running all decisions executes ${gmailLog.length - before} action(s) - idempotency: a retry can never double-send.\n`);
}

async function normalizeSnap(s: ThreadSnapshot) {
  const { normalize } = await import("../src/lib/normalize");
  return normalize(s);
}

main().then(() => process.exit(0)).catch((e) => { console.error("DEMO FAILED:", e); process.exit(1); });

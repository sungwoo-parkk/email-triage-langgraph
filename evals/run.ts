/**
 * Runs the golden-dataset eval as a LangSmith experiment.
 *
 *   npm run eval                 # full 67-example run with judges
 *   npm run eval -- --limit 3    # smoke run on 3 examples
 *   npm run eval -- --no-judges  # programmatic evaluators only (no judge tokens)
 *   npm run eval -- --sync       # re-upload dataset.json to LangSmith first
 *
 * Requires: LANGSMITH_API_KEY, GEMINI_API_KEY (classification + judges).
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "langsmith";

const HERE = path.dirname(fileURLToPath(import.meta.url));
import { evaluate } from "langsmith/evaluation";
import { normalize } from "../src/lib/normalize";
import { makeClassifier } from "../src/lib/classify";
import { loadOfficeConfig } from "../src/lib/officeConfig";
import {
  exactSetMatch, taskCountMatch, forwardMatch, latencySeconds,
  faithfulness, instructionFollowing,
} from "./evaluators";

const DATASET = "email-triage-goldens";

/**
 * evals/dataset.json is a frozen historical record: the 67 golden emails as they were
 * labeled against the original pro@agency.example dispatcher's 42-label Gmail vocabulary (the
 * case study — see docs/case-study/). The live classifier now emits a single office-config
 * category id per task (examples/agency/triage.config.json), so this table translates each
 * golden Gmail label set to the equivalent category id before upload, without touching the
 * historical fixture file itself.
 *
 * Two label-space quirks collapse on translation:
 * - "3-KR" and "2-NY" were Gmail *bucket* labels dispatchers applied alongside a specific
 *   child label purely for folder nesting — never a second work item. Dropped.
 * - "Cancelllation" always co-shipped with "3-KR/DOCS&NOTICE" under the same bucketing
 *   convention (a carrier cancellation notice IS a document delivery, in Gmail-label terms).
 *   The category-id taxonomy has no such rider concept — a cancellation notice is just
 *   "carrier-cancellation" — so the companion bucket label is dropped here too.
 */
const LABEL_TO_CATEGORY: Record<string, string> = {
  "2-NY": "front-office",
  "2-NY/Endorsement": "nho-endorsement",
  "2-NY/Recommendation": "recommendation",
  "3-Endorsement": "commercial-endorsement",
  "3-KR/DOCS&NOTICE": "carrier-docs",
  "3-KR/POLICY REQUEST": "policy-doc-request",
  "4-CAN REQ": "cancel-request",
  "7-Loss Run Req": "loss-run-request",
  "8-C-105.2": "wc-certificate",
  "Cancelllation": "carrier-cancellation",
  "6-RENEWAL QUOTE-USLI": "usli-renewal-quote",
  "3-KR/USLI RENEWAL QUOTE": "usli-renewal-quote",
  "Undelivered Email": "undelivered",
  "disregard": "junk",
};

function translateTask(task: { labels: string[]; forward_to: string }): { category: string } {
  // "Billing" alone doesn't say which category — the golden's forward_to (a Gmail-era
  // per-task field, not the new schema's shape) disambiguates it.
  if (task.labels.length === 1 && task.labels[0] === "Billing")
    return { category: task.forward_to === "invoice@agency.example" ? "carrier-invoice" : "payment-matter" };

  let labels = task.labels.filter((l) => l !== "3-KR");
  if (labels.includes("Cancelllation")) labels = labels.filter((l) => l !== "3-KR/DOCS&NOTICE");
  if (labels.length > 1 && labels.includes("2-NY")) labels = labels.filter((l) => l !== "2-NY");
  if (labels.length !== 1)
    throw new Error(`translateTask: ambiguous label set after translation: ${JSON.stringify(task.labels)}`);
  const category = LABEL_TO_CATEGORY[labels[0]];
  if (!category) throw new Error(`translateTask: no category mapping for label "${labels[0]}"`);
  return { category };
}

function translateGolden(raw: any[]): { inputs: any; outputs: any }[] {
  return raw.map((r) => ({
    inputs: r.inputs,
    outputs: {
      tasks: r.outputs.tasks.map(translateTask),
      request_count: r.outputs.request_count,
      note: r.outputs.note,
    },
  }));
}

async function ensureDataset(client: Client, sync: boolean): Promise<void> {
  const exists = await client.hasDataset({ datasetName: DATASET });
  if (exists && !sync) return;
  if (exists && sync) await client.deleteDataset({ datasetName: DATASET });
  const raw = JSON.parse(readFileSync(path.join(HERE, "dataset.json"), "utf8"));
  const translated = translateGolden(raw);
  await client.createDataset(DATASET, { description: "Synthetic golden emails for the triage classifier (fictional; see evals/dataset.json). Labels translated from the historical case-study Gmail vocabulary to examples/agency/triage.config.json category ids at upload time — see evals/run.ts." });
  await client.createExamples({
    inputs: translated.map((r) => r.inputs),
    outputs: translated.map((r) => r.outputs),
    datasetName: DATASET,
  });
  console.log(`dataset "${DATASET}" uploaded: ${translated.length} examples`);
}

async function main() {
  // The case-study eval always targets examples/agency/triage.config.json (the flagship,
  // hardest-taxonomy example office — see docs/case-study/) so it exercises the same
  // classifier surface (office-config category ids) that any other office's onboarding
  // eval does, on a fixed dataset for regression tracking across model/prompt changes.
  const cfg = loadOfficeConfig(path.join(HERE, "..", "examples/agency/triage.config.json"));
  for (const v of ["LANGSMITH_API_KEY", cfg.llm.apiKeyEnv]) {
    if (!process.env[v]) { console.error(`${v} is required`); process.exit(1); }
  }
  const args = process.argv.slice(2);
  const noJudges = args.includes("--no-judges");
  const sync = args.includes("--sync");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : null;

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

  const evaluators: any[] = [exactSetMatch, taskCountMatch, forwardMatch, latencySeconds];
  if (!noJudges) evaluators.push(faithfulness, instructionFollowing);

  let promptVersion = "unversioned";
  try { promptVersion = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: path.join(HERE, "..") }).toString().trim(); } catch {}
  const model = cfg.llm.model;

  const data = limit
    ? client.listExamples({ datasetName: DATASET, limit })
    : DATASET;

  const results = await evaluate(target, {
    data: data as any,
    evaluators,
    experimentPrefix: `${model}@${promptVersion}`,
    maxConcurrency: 4,
    metadata: { model, promptVersion, judges: String(!noJudges) },
  });

  // Aggregate mean per metric for the console summary. evaluate() has already
  // consumed the async iterator; the materialized rows live on results.results.
  const sums = new Map<string, { total: number; n: number }>();
  for (const r of results.results) {
    for (const er of r.evaluationResults?.results ?? []) {
      const s = sums.get(er.key) ?? { total: 0, n: 0 };
      if (typeof er.score === "number") { s.total += er.score; s.n++; }
      sums.set(er.key, s);
    }
  }
  console.log(`\nexperiment: ${results.experimentName}`);
  for (const [key, { total, n }] of [...sums.entries()].sort()) {
    const mean = n ? total / n : NaN;
    console.log(`  ${key.padEnd(22)} ${key === "latency_s" ? mean.toFixed(2) + "s mean" : (mean * 100).toFixed(1) + "%"}  (n=${n})`);
  }
  console.log(`\nview: https://smith.langchain.com -> Datasets & Experiments -> ${DATASET}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("EVAL FAILED:", e); process.exit(1); });

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
  faithfulness, instructionFollowing, inputTokens, outputTokens,
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

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
import {
  exactSetMatch, taskCountMatch, forwardMatch, coEmitCompliance, latencySeconds,
  faithfulness, instructionFollowing,
} from "./evaluators";

const DATASET = "email-triage-goldens";

async function ensureDataset(client: Client, sync: boolean): Promise<void> {
  const exists = await client.hasDataset({ datasetName: DATASET });
  if (exists && !sync) return;
  if (exists && sync) await client.deleteDataset({ datasetName: DATASET });
  const raw = JSON.parse(readFileSync(path.join(HERE, "dataset.json"), "utf8"));
  await client.createDataset(DATASET, { description: "Synthetic golden emails for the triage classifier (fictional; see evals/dataset.json)" });
  await client.createExamples({
    inputs: raw.map((r: any) => r.inputs),
    outputs: raw.map((r: any) => r.outputs),
    datasetName: DATASET,
  });
  console.log(`dataset "${DATASET}" uploaded: ${raw.length} examples`);
}

async function main() {
  for (const v of ["LANGSMITH_API_KEY", "GEMINI_API_KEY"]) {
    if (!process.env[v]) { console.error(`${v} is required`); process.exit(1); }
  }
  const args = process.argv.slice(2);
  const noJudges = args.includes("--no-judges");
  const sync = args.includes("--sync");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : null;

  const client = new Client();
  await ensureDataset(client, sync);

  const classifier = makeClassifier();
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

  const evaluators: any[] = [exactSetMatch, taskCountMatch, forwardMatch, coEmitCompliance, latencySeconds];
  if (!noJudges) evaluators.push(faithfulness, instructionFollowing);

  let promptVersion = "unversioned";
  try { promptVersion = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: path.join(HERE, "..") }).toString().trim(); } catch {}
  const model = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";

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

/**
 * Sequential Gemini-tier eval runner with fail-closed doc regeneration.
 *
 *   npm run eval-matrix              # run all configured tiers, update evals/README.md
 *   EVAL_MATRIX_MODELS=... npm run eval-matrix   # override tier list (comma-separated)
 *
 * Requires: LANGSMITH_API_KEY, GEMINI_API_KEY (classification + judges).
 * Baseline-tier failure → doc NOT rewritten, exit 1.
 * Any tier failure → exit 1.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runEval, type EvalSummary } from "./run";
import { renderMatrixTable, replaceBetweenMarkers, type TierRow } from "./matrixTable";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const BASELINE = "google_genai:gemini-3.6-flash"; // ids verified against the live models API 2026-08-10 (controller)
const TIERS = process.env.EVAL_MATRIX_MODELS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [
  "google_genai:gemini-3.5-flash-lite",
  BASELINE,
  "google_genai:gemini-3.1-pro-preview",
];

// USD per 1M tokens, https://ai.google.dev/gemini-api/docs/pricing (page updated 2026-08-05).
// gemini-3.1-pro-preview uses its <=200k-token prompt tier — classification prompts are far below that.
// A tier with no entry renders its cost as "—" — never estimated.
const PRICE_AS_OF = "2026-08";
const PRICES: Record<string, { inPerM: number; outPerM: number }> = {
  "google_genai:gemini-3.5-flash-lite": { inPerM: 0.30, outPerM: 2.50 },
  "google_genai:gemini-3.6-flash": { inPerM: 1.50, outPerM: 7.50 },
  "google_genai:gemini-3.1-pro-preview": { inPerM: 2.00, outPerM: 12.00 },
};

async function matrix(): Promise<void> {
  const rows: TierRow[] = [];

  // Sequential tier loop: if baseline fails, don't rewrite doc and exit 1.
  // Any tier failure exits 1.
  for (let i = 0; i < TIERS.length; i++) {
    const model = TIERS[i];
    const isBaseline = model === BASELINE;

    try {
      console.log(`running eval on tier ${i + 1}/${TIERS.length}: ${model}`);
      const summary: EvalSummary = await runEval({ model, judges: true });
      const row: TierRow = {
        model,
        ok: true,
        metrics: summary.metrics,
        price: PRICES[model] ?? null,
      };
      rows.push(row);
      console.log(`  ✓ ${model} complete`);
    } catch (err) {
      const error = String(err instanceof Error ? err.message : err);
      console.error(`  ✗ ${model} failed: ${error}`);
      const row: TierRow = {
        model,
        ok: false,
        error: error.slice(0, 100),
        price: PRICES[model] ?? null,
      };
      rows.push(row);

      // Baseline failure: don't rewrite doc, exit 1.
      if (isBaseline) {
        console.error("MATRIX FAILED: baseline tier failed; doc not rewritten");
        process.exit(1);
      }
      // Any tier failure: exit 1.
      console.error("MATRIX FAILED: tier failed");
      process.exit(1);
    }
  }

  // All tiers passed: update the doc.
  try {
    const markdown = renderMatrixTable(rows, PRICE_AS_OF);
    const docPath = path.join(HERE, "..", "evals", "README.md");
    const doc = readFileSync(docPath, "utf8");
    const updated = replaceBetweenMarkers(
      doc,
      "<!-- eval-matrix:start -->",
      "<!-- eval-matrix:end -->",
      markdown
    );
    writeFileSync(docPath, updated, "utf8");
    console.log(`\nupdated ${docPath}`);
  } catch (err) {
    console.error("MATRIX FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith("matrix.ts")) matrix().then(() => process.exit(0)).catch((e) => { console.error("MATRIX FAILED:", e); process.exit(1); });

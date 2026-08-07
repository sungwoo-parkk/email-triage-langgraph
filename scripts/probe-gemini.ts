import { loadOfficeConfig } from "../src/lib/officeConfig";
import { makeClassifier } from "../src/lib/classify";

// Deliberately pinned to the AGY case-study config (docs/case-study/): the probe email
// below is a two-request insurance thread (endorsement + cancellation) built to exercise
// that taxonomy's multi-task split, so it only makes sense against AGY's categories. To
// probe a different office's live model, point loadOfficeConfig at that office's
// triage.config.json and swap in a representative email for its own vocabulary.
const cfg = loadOfficeConfig(process.argv[2] ?? "examples/agency/triage.config.json");

async function main() {
  const classify = makeClassifier(cfg, []);
  const result = await classify(
    { threadId: "probe", fromAddr: "vicky@oakmontins.com", fromDomain: "oakmontins.com", to: [],
      subject: "cancellation request for MY NY Leading Company LLC", listId: null,
      attachments: ["BOP-LPR-signed.pdf"],
      bodyExcerpt: "Please update the mailing address and cancel the policy effective 6/30/2026. Attach signed LPR.",
      internalDateMs: 0, references: [] },
    { hits: [], labels: [], forwards: [], complete: false }
  );
  console.log("PROBE OK:", JSON.stringify(result, null, 2));
  if (result.tasks.length < 2) console.warn("NOTE: expected 2 tasks (endorsement + cancellation) — check prompt quality");
}
main().catch((e) => { console.error(`PROBE FAILED (check llm.model / ${cfg.llm.apiKeyEnv}):`, e.message); process.exit(1); });

import { loadOfficeConfig } from "../src/lib/officeConfig";
import { makeClassifier } from "../src/lib/classify";

// TEMPORARY (Task 6): pinned to the AGY example config; Task 11 makes CLI scripts
// office-config-driven (path/office picked at the command line).
const cfg = loadOfficeConfig("examples/agency/triage.config.json");

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

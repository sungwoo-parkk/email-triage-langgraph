import { readFileSync, writeFileSync } from "node:fs";
import { loadOfficeConfig } from "../src/lib/officeConfig";
import { makeClassifier } from "../src/lib/classify";
import { normalize } from "../src/lib/normalize";

// TEMPORARY (Task 6): the classifier now predicts office-config category ids directly
// (see src/lib/classify.ts), so the old Gmail-label -> phase0-category mapping this
// script used to do is gone. Task 11 redoes blind-test scoring against the new taxonomy.
const cfg = loadOfficeConfig("examples/agency/triage.config.json");

async function main() {
  const classify = makeClassifier(cfg, []);
  const preds: any[] = [];
  for (let b = 0; b < 4; b++) {
    const batch = JSON.parse(readFileSync(`phase0/analysis/blindtest/batch-${b}.json`, "utf8"));
    for (const r of batch) {
      const email = normalize({
        threadId: r.threadId, from: r.from ?? "", to: [], subject: r.subject ?? "",
        listId: r.listId ?? null, attachments: r.attachments ?? [], bodyText: r.body ?? "", internalDateMs: 0, references: [],
      });
      const c = await classify(email, { hits: [], labels: [], forwards: [], complete: false });
      const categories = [...new Set(c.tasks.map((t) => t.category))];
      preds.push({ threadId: r.threadId, categories, confidence: c.confidence });
      console.log(`${preds.length}/88 ${r.threadId} -> ${categories.join(",")} (${c.confidence})`);
    }
  }
  writeFileSync("phase0/analysis/blindtest/predictions-gemini.json", JSON.stringify(preds, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });

import { readFileSync, writeFileSync } from "node:fs";
import { makeClassifier } from "../src/lib/classify";
import { normalize } from "../src/lib/normalize";

// Mirror of CATEGORIES in phase0/make_blindtest.py — keep in sync.
const CATEGORIES: Record<string, string[]> = {
  "cancellation-request": ["4-CAN REQ"],
  "loss-run-request": ["7-Loss Run Req"],
  "wc-certificate": ["8-C-105.2"],
  "policy-document-request": ["3-KR/POLICY REQUEST"],
  "endorsement-request": ["2-NY/Endorsement", "3-Endorsement"],
  "recommendation-compliance": ["2-NY/Recommendation"],
  "billing-money": ["Billing"],
  "carrier-cancellation-notice": ["Cancelllation"],
  "carrier-docs-filing": ["3-KR/DOCS&NOTICE"],
  "usli-renewal-quote": ["6-RENEWAL QUOTE-USLI", "3-KR/USLI RENEWAL QUOTE"],
};

function categoriesOf(labels: string[]): string[] {
  const out = new Set<string>();
  for (const [cat, raws] of Object.entries(CATEGORIES))
    if (raws.some((r) => labels.includes(r))) out.add(cat);
  if (labels.some((l) => l.toLowerCase().startsWith("disregard"))) out.add("junk-no-action");
  return [...out].sort();
}

async function main() {
  const classify = makeClassifier();
  const preds: any[] = [];
  for (let b = 0; b < 4; b++) {
    const batch = JSON.parse(readFileSync(`phase0/analysis/blindtest/batch-${b}.json`, "utf8"));
    for (const r of batch) {
      const email = normalize({
        threadId: r.threadId, from: r.from ?? "", to: [], subject: r.subject ?? "",
        listId: r.listId ?? null, attachments: r.attachments ?? [], bodyText: r.body ?? "", internalDateMs: 0, references: [],
      });
      const c = await classify(email, { hits: [], labels: [], forwards: [], complete: false });
      const labels = [...new Set(c.tasks.flatMap((t) => t.labels))];
      preds.push({ threadId: r.threadId, categories: categoriesOf(labels), confidence: c.confidence });
      console.log(`${preds.length}/88 ${r.threadId} -> ${categoriesOf(labels).join(",")} (${c.confidence})`);
    }
  }
  writeFileSync("phase0/analysis/blindtest/predictions-gemini.json", JSON.stringify(preds, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });

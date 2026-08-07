import { makeClassifier } from "../src/lib/classify";

async function main() {
  const classify = makeClassifier();
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
main().catch((e) => { console.error("PROBE FAILED (check GEMINI_MODEL id / GEMINI_API_KEY):", e.message); process.exit(1); });

import type { EvalReport } from "./onboardEval";
import type { MinedRule } from "./mining";

export interface ReportInput {
  office: string;
  evalReport: EvalReport | null;
  rules: MinedRule[];
  samples: { subject: string; from: string; categoryIds: string[] }[];
  floor: number;
}

// Escape untrusted text (office names, subject lines, sender addresses) before it lands
// in the HTML - this report is emailed/opened directly, so it's the only XSS boundary.
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const label = (categoryId: string) => `triage/${categoryId}`;

function warningBlock(reason: string): string {
  return `<div class="warning">
    <strong>Review-only for now.</strong> ${esc(reason)}
    Automation starts review-only. The system will still organize and propose; nothing
    sends automatically until measured agreement improves.
  </div>`;
}

function categoryTable(evalReport: EvalReport): string {
  const rows = evalReport.perCategory.map((c) => {
    const strong = evalReport.strongCategoryIds.includes(c.categoryId);
    return `<tr>
      <td>${esc(label(c.categoryId))}</td>
      <td>${pct(c.f1)}</td>
      <td>${c.support}</td>
      <td><span class="chip ${strong ? "chip-strong" : "chip-review"}">${strong ? "auto-route" : "review-only"}</span></td>
    </tr>`;
  }).join("");
  return `<table>
    <thead><tr><th>Category</th><th>Accuracy (F1)</th><th>Sample size</th><th>Status</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4">No categories evaluated yet.</td></tr>`}</tbody>
  </table>`;
}

function rulesTable(rules: MinedRule[]): string {
  const rows = rules.map((r) => `<tr>
    <td>${esc(r.pattern)}</td>
    <td>${r.categoryIds.map((c) => esc(label(c))).join(", ")}</td>
    <td>${pct(r.purity)} / ${r.support}</td>
    <td>${esc(r.tier)}</td>
  </tr>`).join("");
  return `<table>
    <thead><tr><th>Sender pattern</th><th>Routes to</th><th>Purity / seen</th><th>Confidence</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4">No shortcuts learned yet.</td></tr>`}</tbody>
  </table>`;
}

function samplesList(samples: ReportInput["samples"]): string {
  if (!samples.length) return `<p class="muted">No sample emails to show yet.</p>`;
  const items = samples.map((s) => `<li>
    <strong>${esc(s.subject)}</strong> from ${esc(s.from)}
    &rarr; ${s.categoryIds.map((c) => esc(label(c))).join(", ") || "(no category)"}
  </li>`).join("");
  return `<ul class="samples">${items}</ul>`;
}

/** One self-contained HTML page: inline styles, no scripts, no external requests. */
export function renderReport(input: ReportInput): string {
  const { office, evalReport, rules, samples, floor } = input;
  const belowFloor = evalReport === null || evalReport.overallAgreement < floor;
  const agreementLine = evalReport
    ? `Out of ${evalReport.evaluated} past emails checked by hand, the system agreed on ${pct(evalReport.overallAgreement)} of them`
      + (evalReport.failures ? ` (${evalReport.failures} could not be scored)` : "") + "."
    : "No evaluation has run yet.";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(office)} — Email triage report</title>
<style>
  :root { --accent: #2563eb; --ink: #1f2430; --muted: #6b7280; --line: #e5e7eb; --bg: #f8fafc; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1rem; background: var(--bg); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.5;
  }
  main { max-width: 720px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 2rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { margin: 0 0 .25rem; font-size: 1.5rem; }
  h2 { margin-top: 2rem; font-size: 1.1rem; color: var(--accent); }
  .subtitle { color: var(--muted); margin: 0 0 1.5rem; }
  .headline { font-size: 1.1rem; margin: 1rem 0; }
  table { width: 100%; border-collapse: collapse; margin-top: .5rem; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line); font-size: .95rem; }
  th { color: var(--muted); font-weight: 600; }
  .chip { display: inline-block; padding: .15rem .6rem; border-radius: 999px; font-size: .8rem; font-weight: 600; }
  .chip-strong { background: #dcfce7; color: #166534; }
  .chip-review { background: #fef3c7; color: #92400e; }
  .warning { border: 2px solid #f59e0b; background: #fffbeb; border-radius: 8px; padding: 1rem 1.25rem; margin: 1.5rem 0; }
  .muted { color: var(--muted); }
  ul.samples { padding-left: 1.2rem; }
  ul.samples li { margin-bottom: .5rem; }
  footer { margin-top: 2rem; color: var(--muted); font-size: .85rem; }
</style>
</head>
<body>
<main>
  <h1>${esc(office)}</h1>
  <p class="subtitle">Email triage report</p>
  <p class="headline">${agreementLine}</p>
  ${belowFloor ? warningBlock(evalReport === null
    ? "There isn't enough measured history yet to trust automatic routing."
    : `Measured agreement is below the ${pct(floor)} bar this office needs before anything routes on its own.`) : ""}
  <h2>How each category is doing</h2>
  ${evalReport ? categoryTable(evalReport) : `<p class="muted">Nothing to show until the first evaluation runs.</p>`}
  <h2>Shortcuts the system has learned</h2>
  ${rulesTable(rules)}
  <h2>What would have happened</h2>
  <p class="muted">A few recent emails and where they would have been routed:</p>
  ${samplesList(samples)}
  <footer>Categories marked auto-route meet the bar to run without a human in the loop; everything else stays review-only until it does.</footer>
</main>
</body>
</html>`;
}

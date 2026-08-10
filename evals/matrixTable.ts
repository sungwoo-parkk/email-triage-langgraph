/** Pure helpers for the eval matrix (no I/O, no LangSmith) so table shape and cost math are unit-testable. */
export interface TierRow {
  model: string;
  ok: boolean;
  error?: string;
  metrics?: Record<string, { mean: number; n: number }>;
  price: { inPerM: number; outPerM: number } | null;
}

const pct = (m?: { mean: number }) => (m && Number.isFinite(m.mean) ? `${(m.mean * 100).toFixed(1)}%` : "—");

export function costPer1k(row: TierRow): string {
  const inT = row.metrics?.input_tokens?.mean;
  const outT = row.metrics?.output_tokens?.mean;
  if (!row.price || typeof inT !== "number" || typeof outT !== "number" || !Number.isFinite(inT) || !Number.isFinite(outT)) return "—";
  const usd = ((inT * row.price.inPerM) / 1e6 + (outT * row.price.outPerM) / 1e6) * 1000;
  return `$${usd.toFixed(2)}`;
}

export function renderMatrixTable(rows: TierRow[], priceAsOf: string): string {
  const header =
    `| Model | Exact-set | Task-split | Forward | Faithfulness | Instr.-following | Latency (mean) | Cost / 1K emails |\n` +
    `|---|---|---|---|---|---|---|---|`;
  const body = rows.map((r) => {
    const name = r.model.replace(/^google_genai:/, "");
    if (!r.ok) return `| ${name} | _run failed: ${r.error ?? "unknown"}_ | | | | | | |`;
    const m = r.metrics ?? {};
    const lat = m.latency_s && Number.isFinite(m.latency_s.mean) ? `${m.latency_s.mean.toFixed(2)}s` : "—";
    return `| ${name} | ${pct(m.exact_set_match)} | ${pct(m.task_count_match)} | ${pct(m.forward_match)} | ${pct(m.faithfulness)} | ${pct(m.instruction_following)} | ${lat} | ${costPer1k(r)} |`;
  }).join("\n");
  const foot = `\n_Cost = measured mean tokens/email × published prices as of ${priceAsOf}; judges pinned to \`GEMINI_JUDGE_MODEL\` for every row; "—" = usage or price unavailable (never estimated)._`;
  return `${header}\n${body}\n${foot}`;
}

export function replaceBetweenMarkers(doc: string, start: string, end: string, content: string): string {
  const s = doc.indexOf(start);
  const e = doc.indexOf(end);
  if (s < 0 || e < 0 || e < s) throw new Error(`markers not found in doc: ${start} … ${end}`);
  return doc.slice(0, s + start.length) + "\n" + content + "\n" + doc.slice(e);
}

import type { Querier } from "./db";
import { setConfigKey } from "./config";

// Spec 2026-08-10 §2.4: gate met <=> BOTH trailing 7-day windows have n >= MIN_WINDOW_N
// and rate >= GATE_RATE. status.ts/promote.ts consume these constants — never duplicate them.
export const GATE_RATE = 0.85;
export const MIN_WINDOW_N = 25;
export const WINDOW_MS = 7 * 24 * 3600_000;

export interface WindowEvidence { sinceMs: number; untilMs: number; n: number; agreed: number; rate: number | null; met: boolean }
export interface GateEvidence {
  windows: [WindowEvidence, WindowEvidence];
  overall: { n: number; agreed: number; rate: number | null };
  unmeasured: number;
  met: boolean;
}

export async function agreementWindow(db: Querier, sinceMs: number, untilMs: number): Promise<{ n: number; agreed: number; rate: number | null }> {
  const { rows } = await db.query(
    `select count(*)::int as n, count(*) filter (where agreed)::int as agreed
     from v_agreement
     where confidence = 'high'
       and created_at >= to_timestamp($1 / 1000.0)
       and created_at <  to_timestamp($2 / 1000.0)`,
    [sinceMs, untilMs]
  );
  const n = Number(rows[0]?.n ?? 0);
  const agreed = Number(rows[0]?.agreed ?? 0);
  return { n, agreed, rate: n ? agreed / n : null };
}

export async function gateEvidence(db: Querier, nowMs: number): Promise<GateEvidence> {
  const spans = [
    { sinceMs: nowMs - 2 * WINDOW_MS, untilMs: nowMs - WINDOW_MS },
    { sinceMs: nowMs - WINDOW_MS, untilMs: nowMs },
  ] as const;
  const windows = (await Promise.all(spans.map(async (s) => {
    const r = await agreementWindow(db, s.sinceMs, s.untilMs);
    return { ...s, ...r, met: r.n >= MIN_WINDOW_N && (r.rate ?? 0) >= GATE_RATE };
  }))) as [WindowEvidence, WindowEvidence];
  const overall = await agreementWindow(db, spans[0].sinceMs, spans[1].untilMs);
  const { rows } = await db.query(
    `select count(*)::int as n from decisions d
     where d.confidence = 'high'
       and d.created_at >= to_timestamp($1 / 1000.0)
       and d.created_at <  to_timestamp($2 / 1000.0)
       and not exists (select 1 from observations o where o.decision_id = d.id)`,
    [spans[0].sinceMs, spans[1].untilMs]
  );
  return { windows, overall, unmeasured: Number(rows[0]?.n ?? 0), met: windows[0].met && windows[1].met };
}

export function renderEvidence(e: GateEvidence): string {
  const pct = (r: number | null) => (r === null ? "n/a" : `${Math.round(r * 100)}%`);
  const w = (label: string, x: WindowEvidence) =>
    `  ${label}: ${x.n} measured high-confidence decision${x.n === 1 ? "" : "s"}, ${pct(x.rate)} exact-set agreement ` +
    (x.met ? "[MET]" : `[NOT met — needs n >= ${MIN_WINDOW_N} and >= ${Math.round(GATE_RATE * 100)}%]`);
  return [
    `Promotion gate (shadow -> assisted): exact label-set agreement on high-confidence decisions,`,
    `measured only where a human outcome was observed — unmeasured threads never count as agreement.`,
    w("Days 14-8", e.windows[0]),
    w("Days 7-0 ", e.windows[1]),
    `  Overall 14 days: ${e.overall.n} measured, ${pct(e.overall.rate)} agreement; ${e.unmeasured} high-confidence decision${e.unmeasured === 1 ? "" : "s"} unmeasured.`,
    `  Gate: ${e.met ? "MET — sustained across both windows." : "NOT met."}`,
  ].join("\n");
}

export async function recordForcedPromotion(db: Querier, from: string, to: string, reason: string, evidence: GateEvidence): Promise<void> {
  await setConfigKey(db, "promotion_override", { at: new Date().toISOString(), from, to, reason, evidence });
}

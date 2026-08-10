import type { CliArgs } from "../main";
import { getDb, type Querier } from "../../lib/db";
import { getConfig } from "../../lib/config";
import { gateEvidence, renderEvidence } from "../../lib/agreement";

const pct = (n: number) => `${Math.round(n * 100)}%`;

// Promotion gates are two DIFFERENT metrics at two different stages — never conflate them with
// each other or with mine.ts's EVAL_FLOOR (that one gates the onboarding report, not staging).
// Spec: docs/superpowers/specs/2026-08-05-email-triage-design.md §5.
const ASSISTED_CORRECTION_RATE_GATE = 0.05; // assisted -> autonomous: <5% correction rate on auto-labels, over 2 weeks

async function loadStatus(db: Querier) {
  const cfg = await getConfig(db);

  const { rows: statusRows } = await db.query(
    `select status, count(*)::int as n from decisions where created_at > now() - interval '7 days' group by status`
  );
  const byStatus: Record<string, number> = Object.fromEntries(statusRows.map((r: any) => [r.status, r.n]));

  const { rows: correctionRows } = await db.query(
    `select count(*)::int as n from corrections where created_at > now() - interval '7 days'`
  );
  const corrections: number = correctionRows[0]?.n ?? 0;

  return { cfg, byStatus, corrections };
}

export async function run(_args: CliArgs): Promise<void> {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is not set — set it in .env (see .env.example) before running `triage status`.");

  let cfg, byStatus, corrections;
  try {
    ({ cfg, byStatus, corrections } = await loadStatus(getDb()));
  } catch (e) {
    throw new Error(`Could not read status from the database — check DATABASE_URL. (${e instanceof Error ? e.message : String(e)})`);
  }

  const decided = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const correctionRate = decided > 0 ? corrections / decided : null;

  console.log(`Stage: ${cfg.stage}`);
  console.log(`\nDecisions in the last 7 days:`);
  for (const s of ["decided", "needs_review", "acted", "failed"]) console.log(`  ${s}: ${byStatus[s] ?? 0}`);
  console.log(`  corrections: ${corrections}`);
  console.log(
    correctionRate === null
      ? `\nNo decisions in the last 7 days yet — nothing to measure.`
      : `\nCorrection rate (corrections / decisions) over the last 7 days: ${pct(correctionRate)}`
  );

  console.log();
  if (cfg.stage === "shadow") {
    console.log(renderEvidence(await gateEvidence(getDb(), Date.now())));
  } else if (cfg.stage === "assisted") {
    // The spec's gate here is a correction rate, not an agreement percentage — do not restate
    // it as one. Our window (7 days) is also shorter than the spec's (2 weeks), so this stays
    // informational: no MET/NOT MET verdict.
    console.log(`Promotion gate (assisted -> autonomous): correction rate below ${pct(ASSISTED_CORRECTION_RATE_GATE)} on auto-applied labels, over two weeks.`);
    console.log(
      correctionRate === null
        ? `  Not enough data yet to say whether this is met.`
        : `  Observed over the last 7 days: ${corrections} correction(s) / ${decided} decision(s) = ${pct(correctionRate)} correction rate. (The spec measures this over two weeks; this is a shorter sample, so no MET/NOT MET verdict.)`
    );
  } else {
    console.log(`Stage "${cfg.stage}" is the top stage — there is no further promotion gate.`);
  }
}

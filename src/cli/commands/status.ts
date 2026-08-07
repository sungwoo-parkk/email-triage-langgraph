import type { CliArgs } from "../main";
import { getDb, type Querier } from "../../lib/db";
import { getConfig } from "../../lib/config";
import { PROMOTION_FLOOR } from "../steps/mine";

const pct = (n: number) => `${Math.round(n * 100)}%`;

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
  const agreementRate = decided > 0 ? 1 - corrections / decided : null;
  const gateMet = agreementRate !== null && agreementRate >= PROMOTION_FLOOR;

  console.log(`Stage: ${cfg.stage}`);
  console.log(`\nDecisions in the last 7 days:`);
  for (const s of ["decided", "needs_review", "acted", "failed"]) console.log(`  ${s}: ${byStatus[s] ?? 0}`);
  console.log(`  corrections: ${corrections}`);

  console.log(
    agreementRate === null
      ? `\nNo decisions in the last 7 days yet — nothing to measure.`
      : `\nAgreement rate (1 - corrections / decisions): ${pct(agreementRate)}`
  );

  console.log(
    gateMet
      ? `\nPromotion gate: MET — agreement is at or above the ${pct(PROMOTION_FLOOR)} bar. "triage promote" is available.`
      : `\nPromotion gate: NOT met — needs ${pct(PROMOTION_FLOOR)} agreement (measured over at least a week) before promoting past shadow.`
  );
}

import type { CliArgs } from "../main";
import { getDb } from "../../lib/db";
import { getConfig, setConfigKey } from "../../lib/config";
import { confirm, ask } from "../confirm";
import { gateEvidence, renderEvidence, recordForcedPromotion, MIN_WINDOW_N, GATE_RATE } from "../../lib/agreement";

// Single-step-only map: shadow can promote to assisted, assisted to autonomous — there is no
// entry that lets shadow jump straight to autonomous, so that jump is structurally impossible
// here, not just discouraged.
const NEXT: Record<string, "assisted" | "autonomous" | undefined> = {
  shadow: "assisted",
  assisted: "autonomous",
};

export async function run(args: CliArgs): Promise<void> {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is not set — set it in .env (see .env.example) before running `triage promote`.");

  const db = getDb();
  const cfg = await getConfig(db);
  const next = NEXT[cfg.stage];
  if (!next) throw new Error(`already at "autonomous" — there is no further stage to promote to.`);

  // shadow -> assisted is evidence-gated (spec 2026-08-10 §2.5). assisted -> autonomous
  // keeps confirm-only behavior: its correction-rate gate is out of this spec's scope.
  if (cfg.stage === "shadow") {
    const evidence = await gateEvidence(db, Date.now());
    console.log(renderEvidence(evidence));
    if (!evidence.met) {
      if (!args.force)
        throw new Error(
          `promotion gate NOT met — shadow -> assisted requires both trailing 7-day windows at ` +
          `>= ${MIN_WINDOW_N} measured high-confidence decisions and >= ${Math.round(GATE_RATE * 100)}% agreement. ` +
          `Re-run with --force to override; the override and your reason are recorded.`
        );
      const reason = await ask("Gate not met. Reason for forcing promotion (recorded to the audit log):");
      if (!reason) {
        console.log("No reason given — cancelled.");
        return;
      }
      await recordForcedPromotion(db, cfg.stage, next, reason, evidence);
      console.log("Override recorded to app_config.promotion_override.");
    }
  }

  console.log(`Current stage: ${cfg.stage}`);
  console.log(`Promote to:    ${next}`);
  if (!(await confirm(`Promote from "${cfg.stage}" to "${next}"?`))) {
    console.log("Cancelled.");
    return;
  }

  await setConfigKey(db, "stage", next);
  console.log(`Promoted to "${next}".`);
}

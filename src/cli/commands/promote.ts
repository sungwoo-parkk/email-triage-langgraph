import type { CliArgs } from "../main";
import { getDb } from "../../lib/db";
import { getConfig, setConfigKey } from "../../lib/config";
import { confirm } from "../confirm";

// Single-step-only map: shadow can promote to assisted, assisted to autonomous — there is no
// entry that lets shadow jump straight to autonomous, so that jump is structurally impossible
// here, not just discouraged.
const NEXT: Record<string, "assisted" | "autonomous" | undefined> = {
  shadow: "assisted",
  assisted: "autonomous",
};

export async function run(_args: CliArgs): Promise<void> {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is not set — set it in .env (see .env.example) before running `triage promote`.");

  const db = getDb();
  const cfg = await getConfig(db);
  const next = NEXT[cfg.stage];
  if (!next) throw new Error(`already at "autonomous" — there is no further stage to promote to.`);

  console.log(`Current stage: ${cfg.stage}`);
  console.log(`Promote to:    ${next}`);
  if (!(await confirm(`Promote from "${cfg.stage}" to "${next}"?`))) {
    console.log("Cancelled.");
    return;
  }

  await setConfigKey(db, "stage", next);
  console.log(`Promoted to "${next}".`);
}

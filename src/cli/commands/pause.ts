import type { CliArgs } from "../main";
import { getDb } from "../../lib/db";
import { getConfig, setConfigKey } from "../../lib/config";
import { confirm } from "../confirm";

export async function run(_args: CliArgs): Promise<void> {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is not set — set it in .env (see .env.example) before running `triage pause`.");

  const db = getDb();
  const cfg = await getConfig(db);
  if (cfg.stage === "shadow") {
    console.log(`Already in "shadow" — nothing to pause.`);
    return;
  }

  console.log(`Current stage: ${cfg.stage}`);
  if (!(await confirm(`Pause back to "shadow"? All automation stops immediately; decisions keep being recorded, nothing routes or sends on its own.`))) {
    console.log("Cancelled.");
    return;
  }

  await setConfigKey(db, "stage", "shadow");
  console.log(`Paused to "shadow".`);
}

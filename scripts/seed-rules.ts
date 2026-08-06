import { readFileSync } from "node:fs";
import { getDb } from "../src/lib/db";
import { runMigrations } from "../src/lib/migrate";
import { extractSeedRules, seedRules } from "../src/lib/seed";

async function main() {
  const statsPath = process.argv[2] ?? "phase0/analysis/stats.json";
  const stats = JSON.parse(readFileSync(statsPath, "utf8"));
  const db = getDb();
  await runMigrations(db);
  const seeds = extractSeedRules(stats);
  const n = await seedRules(db, seeds);
  console.log(`seeded ${n} new rules (${seeds.length} candidates met thresholds)`);
}
main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });

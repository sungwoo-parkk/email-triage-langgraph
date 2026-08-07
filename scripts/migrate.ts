import { getDb } from "../src/lib/db";
import { runMigrations } from "../src/lib/migrate";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  await runMigrations(getDb());
  console.log("migrations applied");
}
main().then(() => process.exit(0)).catch((e) => { console.error("MIGRATE FAILED:", e.message); process.exit(1); });

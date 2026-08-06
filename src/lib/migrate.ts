import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Querier } from "./db";

export async function runMigrations(db: Querier, dir = path.join(process.cwd(), "migrations")): Promise<void> {
  await db.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const { rows } = await db.query(`select 1 from schema_migrations where name = $1`, [f]);
    if (rows.length) continue;
    await db.query(readFileSync(path.join(dir, f), "utf8"));
    await db.query(`insert into schema_migrations (name) values ($1)`, [f]);
  }
}

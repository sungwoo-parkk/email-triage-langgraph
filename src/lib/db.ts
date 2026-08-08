import { Pool } from "pg";

export interface Querier {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

let db: Querier | null = null;

export function setDb(q: Querier): void {
  db = q;
}

/**
 * Drops the memoized singleton so the next getDb() call constructs fresh. Needed at deploy
 * time (finding C4): DATABASE_URL doesn't exist until Neon is provisioned mid-`triage init`,
 * so any getDb() call before that point pins a pool to a dead/missing connection string
 * forever - migrations then fail against it even after the real DATABASE_URL is pulled down.
 * Call this immediately after DATABASE_URL changes, then call getDb() to pick up the new value.
 */
export function resetDb(): void {
  db = null;
}

export function getDb(): Querier {
  if (!db) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = { query: (sql, params) => pool.query(sql, params as any[]) };
  }
  return db;
}

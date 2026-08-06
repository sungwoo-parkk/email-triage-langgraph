import { Pool } from "pg";

export interface Querier {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

let db: Querier | null = null;

export function setDb(q: Querier): void {
  db = q;
}

export function getDb(): Querier {
  if (!db) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = { query: (sql, params) => pool.query(sql, params as any[]) };
  }
  return db;
}

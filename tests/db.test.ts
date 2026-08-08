import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, resetDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";

function pgliteAdapter(p: PGlite): Querier {
  return {
    query: async (sql, params) => {
      // Use exec for non-parameterized DDL (migration content may have multiple statements)
      if (!params || params.length === 0) {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith("CREATE") || trimmed.startsWith("INSERT") || trimmed.startsWith("ALTER")) {
          await p.exec(sql);
          return { rows: [] };
        }
      }
      // Use query for parameterized queries or SELECT
      return p.query(sql, params as any[]) as any;
    },
  };
}

describe("schema", () => {
  beforeAll(async () => {
    setDb(pgliteAdapter(new PGlite()));
    await runMigrations(getDb());
  });

  it("creates all tables", async () => {
    const { rows } = await getDb().query(
      `select table_name from information_schema.tables where table_schema='public' order by 1`
    );
    const names = rows.map((r: any) => r.table_name);
    for (const t of ["threads", "decisions", "reviews", "rules", "app_config", "ingest_state", "schema_migrations"])
      expect(names).toContain(t);
  });

  it("is idempotent", async () => {
    await runMigrations(getDb()); // second run must not throw
  });

  it("enforces rule pattern types", async () => {
    await expect(
      getDb().query(`insert into rules (pattern_type, pattern, label_set) values ('bogus','x','[]')`)
    ).rejects.toThrow();
  });
});

// Finding C4: init.ts used to capture getDb() before DATABASE_URL existed (Neon is
// provisioned mid-`triage init`), pinning db.ts's module-level singleton to a pool built
// from a dead/missing connection string. Migrations then failed post-provisioning even
// though the real DATABASE_URL had since been pulled down - resetDb() plus calling getDb()
// again afterward is the fix; these tests prove the singleton semantics resetDb() depends on.
describe("resetDb", () => {
  it("clears the cached singleton so the next getDb() call resolves fresh instead of reusing a stale handle", () => {
    const stale: Querier = { query: async () => ({ rows: [] }) };
    setDb(stale);
    expect(getDb()).toBe(stale); // memoized: repeated getDb() calls return the same instance

    resetDb();
    // No fake installed post-reset: getDb() falls through to constructing `new Pool(...)`
    // from whatever DATABASE_URL is in process.env *right now* - proving resetDb() actually
    // dropped the memoized handle (a still-cached stale pool would instead keep returning
    // `stale` here, since getDb() short-circuits on the memoized value).
    expect(getDb()).not.toBe(stale);

    // Once something is set again post-reset, getDb() honors THAT - exactly deploy.ts's
    // sequence: resetDb() right after DATABASE_URL changes, then getDb() at that point.
    const fresh: Querier = { query: async () => ({ rows: [] }) };
    setDb(fresh);
    expect(getDb()).toBe(fresh);
  });
});

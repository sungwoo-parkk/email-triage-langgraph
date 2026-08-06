import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";

function pgliteAdapter(p: PGlite): Querier {
  return {
    query: async (sql, params) => {
      // Use exec for non-parameterized DDL (migration content may have multiple statements)
      if (!params || params.length === 0) {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith("CREATE") || trimmed.startsWith("INSERT")) {
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

import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { getConfig, setConfigKey } from "@/lib/config";

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

describe("config", () => {
  beforeAll(async () => {
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
  });

  it("defaults stage to shadow", async () => {
    const cfg = await getConfig(getDb());
    expect(cfg.stage).toBe("shadow");
  });

  it("round-trips a stage change", async () => {
    await setConfigKey(getDb(), "stage", "assisted");
    expect((await getConfig(getDb())).stage).toBe("assisted");
  });

  it("rejects invalid stage values", async () => {
    await setConfigKey(getDb(), "stage", "yolo");
    await expect(getConfig(getDb())).rejects.toThrow();
  });
});

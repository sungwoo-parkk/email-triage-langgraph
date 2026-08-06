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

describe("config: autoActLabels defaults", () => {
  beforeAll(async () => {
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
  });

  it("defaults autoActLabels to the strong-category list", async () => {
    const cfg = await getConfig(getDb());
    const expected = [
      "2-NY",
      "2-NY/Endorsement",
      "2-NY/Recommendation",
      "3-Endorsement",
      "3-KR",
      "3-KR/DOCS&NOTICE",
      "3-KR/POLICY REQUEST",
      "3-KR/USLI RENEWAL QUOTE",
      "4-CAN REQ",
      "6-RENEWAL QUOTE-USLI",
      "7-Loss Run Req",
      "8-C-105.2",
      "Cancelllation",
    ].sort();
    expect(cfg.autoActLabels.sort()).toEqual(expected);
  });
});

describe("config: autoActLabels override", () => {
  beforeAll(async () => {
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
  });

  it("round-trips an autoActLabels override", async () => {
    await setConfigKey(getDb(), "autoActLabels", ["3-KR"]);
    const cfg = await getConfig(getDb());
    expect(cfg.autoActLabels).toEqual(["3-KR"]);
  });
});

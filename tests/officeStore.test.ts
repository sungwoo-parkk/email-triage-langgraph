import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { getOfficeConfig, setOfficeConfig, loadOfficeConfig } from "@/lib/officeConfig";

function pgliteAdapter(p: PGlite): Querier {
  return {
    query: async (sql, params) => {
      if (!params || params.length === 0) {
        const t = sql.trim().toUpperCase();
        if (t.startsWith("CREATE") || t.startsWith("INSERT") || t.startsWith("ALTER")) { await p.exec(sql); return { rows: [] }; }
      }
      return p.query(sql, params as any[]) as any;
    },
  };
}

describe("migration 004", () => {
  beforeAll(async () => {
    setDb(pgliteAdapter(new PGlite()));
    await runMigrations(getDb());
  });

  it("creates corrections and exemplars and the sent checkpoint row", async () => {
    const { rows } = await getDb().query(
      `select table_name from information_schema.tables where table_schema='public'`);
    const names = rows.map((r: any) => r.table_name);
    expect(names).toContain("corrections");
    expect(names).toContain("exemplars");
    const cp = await getDb().query(`select checkpoint_ms from ingest_state where id = 2`);
    expect(cp.rows.length).toBe(1);
  });

  it("decisions has config_hash", async () => {
    const { rows } = await getDb().query(
      `select column_name from information_schema.columns where table_name='decisions'`);
    expect(rows.map((r: any) => r.column_name)).toContain("config_hash");
  });

  it("round-trips the office config and enforces the vocabulary lock", async () => {
    const cfg = loadOfficeConfig("examples/hartley/triage.config.json");
    await setOfficeConfig(getDb(), cfg);
    const back = await getOfficeConfig(getDb());
    expect(back?.office.name).toBe("Hartley & Sons");
    const shrunk = { ...cfg, routees: cfg.routees.slice(0, 1) };
    await expect(setOfficeConfig(getDb(), shrunk as any)).rejects.toThrow(/vocabulary lock/);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { getConfig } from "@/lib/config";
import { loadOfficeConfig } from "@/lib/officeConfig";
import { seedDatabase } from "@/cli/steps/deploy";
import type { Artifacts } from "@/cli/steps/mine";

// Same adapter pattern used across tests/config.test.ts, tests/db.test.ts, etc.
function pgliteAdapter(p: PGlite): Querier {
  return {
    query: async (sql, params) => {
      if (!params || params.length === 0) {
        const t = sql.trim().toUpperCase();
        if (t.startsWith("CREATE") || t.startsWith("INSERT") || t.startsWith("ALTER")) {
          await p.exec(sql);
          return { rows: [] };
        }
      }
      return p.query(sql, params as any[]) as any;
    },
  };
}

const cfg = loadOfficeConfig("examples/hartley/triage.config.json");

function artifacts(overrides: Partial<Artifacts> = {}): Artifacts {
  return {
    minedRules: [], exemplars: [], holdout: [], evalReport: null, reportHtml: "<html></html>",
    ...overrides,
  };
}

// Finding C1: onboardEval's strongCategoryIds was display-only — the HTML report told the
// office these categories would auto-route, but nothing ever wrote the runtime allow-list
// (config.autoActLabels) that decide() actually checks, so every LLM decision stayed
// needs_review forever, even after promotion. seedDatabase (the DB-writing half of
// runDeploy, pulled out so it's testable without mocking the Vercel CLI / confirm()
// prompts) now seeds it from the same eval report the onboarding HTML renders.
describe("seedDatabase (deploy): autoActLabels seeding", () => {
  beforeEach(async () => {
    setDb(pgliteAdapter(new PGlite()));
    await runMigrations(getDb());
  });

  it("seeds the runtime autoActLabels allow-list from the onboarding eval's strong categories", async () => {
    const art = artifacts({
      evalReport: {
        overallAgreement: 0.9,
        perCategory: [
          { categoryId: "jo", precision: 1, recall: 1, f1: 0.95, support: 8 },
          { categoryId: "sales", precision: 0.9, recall: 0.9, f1: 0.9, support: 6 },
        ],
        strongCategoryIds: ["jo", "sales"],
        evaluated: 14,
        failures: 0,
      },
    });

    await seedDatabase(getDb(), cfg, art);

    expect((await getConfig(getDb())).autoActLabels).toEqual(["jo", "sales"]);
  });

  it("defaults to an empty allow-list when there is no eval report yet (e.g. too little labeled mail for a holdout)", async () => {
    await seedDatabase(getDb(), cfg, artifacts({ evalReport: null }));
    expect((await getConfig(getDb())).autoActLabels).toEqual([]);
  });

  it("also seeds office config and mined rules, so seedDatabase is a full drop-in for runDeploy's old inline sequence", async () => {
    const art = artifacts({
      minedRules: [{ patternType: "sender_domain", pattern: "officesupply.example", categoryIds: ["jo"], purity: 1, support: 8, tier: "mined-gold" }],
      exemplars: [{ categoryId: "jo", fromAddr: "statements@officesupply.example", subject: "Statement", bodyExcerpt: "Amount due.", tier: "gold" }],
    });
    const { insertedRules } = await seedDatabase(getDb(), cfg, art);
    expect(insertedRules).toBe(1);

    const { rows: ruleRows } = await getDb().query(`select pattern from rules where source = 'mined-gold'`);
    expect(ruleRows).toHaveLength(1);
    const { rows: exemplarRows } = await getDb().query(`select category_id from exemplars`);
    expect(exemplarRows).toHaveLength(1);
    const { rows: cfgRows } = await getDb().query(`select value from app_config where key = 'office_config'`);
    expect(cfgRows).toHaveLength(1);
  });
});

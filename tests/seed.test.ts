import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { extractSeedRules, seedRules } from "@/lib/seed";

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

const stats = {
  rule_candidates: {
    sender_domain_labelset: [
      { key: "dxc.com", n: 160, top_label: "3-KR + 3-KR/DOCS&NOTICE", purity: 0.994 },
      { key: "attuneinsurance.com", n: 33, top_label: "3-KR + 3-KR/DOCS&NOTICE", purity: 0.758 }, // below 0.9
      { key: "enews.wealthmanagement.com", n: 20, top_label: "(done/disregard only)", purity: 1.0 }, // sentinel
      { key: "smallco.com", n: 4, top_label: "2-NY", purity: 1.0 }, // below support
    ],
    sender_exact_labelset: [
      { key: "policyprocessing@usli.com", n: 19, top_label: "3-KR + 3-KR/DOCS&NOTICE", purity: 1.0 },
      { key: "flaky@x.com", n: 6, top_label: "2-NY", purity: 0.9 }, // below 0.95 exact threshold
      { key: "lowsupport@example.com", n: 4, top_label: "2-NY", purity: 1.0 }, // below exact support (n<5)
    ],
    list_id_labelset: [
      { key: "<quit.agency.example>", n: 68, top_label: "disregard", purity: 0.985 },
      { key: "<lowpurity.example>", n: 10, top_label: "Y", purity: 0.85 }, // below list_id purity (0.85 < 0.9)
      { key: "<lowsupport.example>", n: 4, top_label: "Y", purity: 0.95 }, // below list_id support (n<5)
    ],
  },
};

describe("extractSeedRules", () => {
  it("applies spec 4.2 thresholds and skips sentinel label-sets", () => {
    const seeds = extractSeedRules(stats);
    const patterns = seeds.map((s) => s.pattern);
    expect(patterns).toContain("dxc.com");
    expect(patterns).toContain("policyprocessing@usli.com");
    expect(patterns).toContain("<quit.agency.example>");
    expect(patterns).not.toContain("attuneinsurance.com");
    expect(patterns).not.toContain("smallco.com");
    expect(patterns).not.toContain("flaky@x.com");
    expect(patterns).not.toContain("lowsupport@example.com");
    expect(patterns).not.toContain("enews.wealthmanagement.com");
    expect(patterns).not.toContain("<lowpurity.example>");
    expect(patterns).not.toContain("<lowsupport.example>");
  });
  it("splits label sets on ' + '", () => {
    const dxc = extractSeedRules(stats).find((s) => s.pattern === "dxc.com")!;
    expect(dxc.labels.sort()).toEqual(["3-KR", "3-KR/DOCS&NOTICE"]);
  });
});

describe("seedRules", () => {
  beforeAll(async () => {
    setDb(pgliteAdapter(new PGlite()));
    await runMigrations(getDb());
  });

  it("inserts N seed rules and returns N; rows have correct properties", async () => {
    const seeds = [
      { patternType: "sender_domain" as const, pattern: "test1.com", labels: ["2-NY"], purity: 0.95, support: 10 },
      { patternType: "sender_exact" as const, pattern: "test@test.com", labels: ["Y"], purity: 0.98, support: 5 },
    ];
    const inserted = await seedRules(getDb(), seeds);
    expect(inserted).toBe(2);

    const { rows } = await getDb().query(`select pattern_type, pattern, label_set, source, complete from rules where source='phase0' order by pattern`);
    expect(rows).toHaveLength(2);
    expect(rows[0].pattern_type).toBe("sender_domain");
    expect(rows[0].pattern).toBe("test1.com");
    expect(rows[0].label_set).toEqual(["2-NY"]);
    expect(rows[0].source).toBe("phase0");
    expect(rows[0].complete).toBe(true);

    expect(rows[1].pattern_type).toBe("sender_exact");
    expect(rows[1].pattern).toBe("test@test.com");
    expect(rows[1].label_set).toEqual(["Y"]);
    expect(rows[1].source).toBe("phase0");
    expect(rows[1].complete).toBe(true);
  });

  it("re-running seedRules with same seeds returns 0 (ON CONFLICT DO NOTHING)", async () => {
    const seeds = [
      { patternType: "sender_domain" as const, pattern: "test1.com", labels: ["2-NY"], purity: 0.95, support: 10 },
    ];
    const inserted = await seedRules(getDb(), seeds);
    expect(inserted).toBe(0);

    const { rows } = await getDb().query(`select count(*) as cnt from rules where source='phase0'`);
    expect(rows[0].cnt).toBe(2); // unchanged from previous test
  });

  it("inserting one new + one duplicate seed returns 1", async () => {
    const seeds = [
      { patternType: "sender_domain" as const, pattern: "test1.com", labels: ["2-NY"], purity: 0.95, support: 10 }, // duplicate
      { patternType: "list_id" as const, pattern: "<new.test>", labels: ["disregard"], purity: 0.9, support: 5 }, // new
    ];
    const inserted = await seedRules(getDb(), seeds);
    expect(inserted).toBe(1);

    const { rows } = await getDb().query(`select count(*) as cnt from rules where source='phase0'`);
    expect(rows[0].cnt).toBe(3); // 2 from before + 1 new
  });
});

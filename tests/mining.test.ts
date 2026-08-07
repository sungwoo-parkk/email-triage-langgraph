import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { normalize } from "@/lib/normalize";
import { stratifiedSample, labelWithLLM, splitHoldout, minePatterns, seedMinedRules, type LabeledThread } from "@/lib/mining";

function email(threadId: string, from: string, dateMs: number, subject = "s") {
  return normalize({ threadId, from, to: [], subject, listId: null, attachments: [], bodyText: "b", internalDateMs: dateMs, references: [] });
}
function labeled(threadId: string, from: string, categoryIds: string[], tier: "gold" | "llm"): LabeledThread {
  return { email: email(threadId, from, 1), categoryIds, tier };
}

describe("stratifiedSample", () => {
  it("caps per-domain dominance", () => {
    const noisy = Array.from({ length: 90 }, (_, i) => email(`n${i}`, "news@spam.example", i));
    const rare = Array.from({ length: 10 }, (_, i) => email(`r${i}`, `p${i}@rare${i}.example`, i));
    const sample = stratifiedSample([...noisy, ...rare], 20);
    const spam = sample.filter((e) => e.fromDomain === "spam.example").length;
    expect(sample).toHaveLength(20);
    expect(spam).toBeLessThan(15);
    expect(sample.filter((e) => e.fromDomain !== "spam.example").length).toBe(10);
  });
});

describe("labelWithLLM", () => {
  it("labels threads and skip-counts failures", async () => {
    const threads = [email("a", "x@y.example", 1), email("b", "boom@y.example", 2)];
    const { labeled: out, failures } = await labelWithLLM(async (e) => {
      if (e.fromAddr.startsWith("boom")) throw new Error("llm down");
      return { tasks: [{ category: "jo" }] };
    }, threads);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ categoryIds: ["jo"], tier: "llm" });
    expect(failures).toBe(1);
  });
});

describe("splitHoldout", () => {
  it("prefers gold, respects min, and excludes holdout from train", () => {
    const gold = Array.from({ length: 40 }, (_, i) => labeled(`g${i}`, "a@b.example", ["jo"], "gold"));
    const silver = Array.from({ length: 160 }, (_, i) => labeled(`s${i}`, "c@d.example", ["sales"], "llm"));
    const { train, holdout } = splitHoldout([...gold, ...silver]);
    expect(holdout).toHaveLength(40); // 20% of 200
    expect(holdout.filter((l) => l.tier === "gold").length).toBe(40); // gold-first fills it entirely
    const holdoutIds = new Set(holdout.map((l) => l.email.threadId));
    expect(train.every((l) => !holdoutIds.has(l.email.threadId))).toBe(true);
  });
  it("returns an empty holdout below the minimum", () => {
    const few = Array.from({ length: 20 }, (_, i) => labeled(`g${i}`, "a@b.example", ["jo"], "gold"));
    expect(splitHoldout(few).holdout).toHaveLength(0);
  });
});

describe("minePatterns", () => {
  it("applies tier thresholds", () => {
    const goldDomain = Array.from({ length: 6 }, (_, i) => labeled(`gd${i}`, `p${i}@carrier.example`, ["jo"], "gold"));
    const llmDomainThin = Array.from({ length: 6 }, (_, i) => labeled(`ld${i}`, `p${i}@thin.example`, ["sales"], "llm"));
    const llmDomainFat = Array.from({ length: 12 }, (_, i) => labeled(`lf${i}`, `p${i}@fat.example`, ["sales"], "llm"));
    const impure = [...Array.from({ length: 9 }, (_, i) => labeled(`i${i}`, `p${i}@mixed.example`, ["jo"], "llm")),
                    ...Array.from({ length: 6 }, (_, i) => labeled(`j${i}`, `q${i}@mixed.example`, ["sales"], "llm"))];
    const rules = minePatterns([...goldDomain, ...llmDomainThin, ...llmDomainFat, ...impure]);
    const patterns = rules.map((r) => r.pattern);
    expect(patterns).toContain("carrier.example");   // gold tier: support 6 >= 5
    expect(patterns).not.toContain("thin.example");   // llm tier: support 6 < 10
    expect(patterns).toContain("fat.example");        // llm tier: support 12 >= 10
    expect(patterns).not.toContain("mixed.example");  // purity 0.6 < 0.9
    expect(rules.find((r) => r.pattern === "carrier.example")?.tier).toBe("mined-gold");
  });
});

describe("seedMinedRules", () => {
  beforeAll(async () => {
    const p = new PGlite();
    setDb({ query: async (sql, params) => {
      if (!params?.length) { const t = sql.trim().toUpperCase();
        if (t.startsWith("CREATE") || t.startsWith("INSERT") || t.startsWith("ALTER")) { await p.exec(sql); return { rows: [] }; } }
      return p.query(sql, params as any[]) as any;
    } });
    await runMigrations(getDb());
  });
  it("inserts and is idempotent", async () => {
    const rules = [{ patternType: "sender_domain" as const, pattern: "carrier.example", categoryIds: ["jo"], purity: 1, support: 6, tier: "mined-gold" as const }];
    expect(await seedMinedRules(getDb(), rules)).toBe(1);
    expect(await seedMinedRules(getDb(), rules)).toBe(0);
  });
});

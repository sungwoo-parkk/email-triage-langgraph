import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { loadOfficeConfig } from "@/lib/officeConfig";
import { buildSystemPrompt, pickExemplars, loadExemplars, PROVIDER_PACKAGES } from "@/lib/promptgen";
import { normalize } from "@/lib/normalize";

// Same adapter pattern used across tests/config.test.ts, tests/db.test.ts, etc.: PGlite's
// parameterized query() cannot run multi-statement DDL, so DDL/param-less INSERTs go
// through exec() instead.
function pgliteAdapter(p: PGlite): Querier {
  return {
    query: async (sql, params) => {
      if (!params || params.length === 0) {
        const t = sql.trim().toUpperCase();
        if (t.startsWith("CREATE") || t.startsWith("INSERT")) { await p.exec(sql); return { rows: [] }; }
      }
      return p.query(sql, params as any[]) as any;
    },
  };
}

const cfg = loadOfficeConfig("examples/hartley/triage.config.json");
const labeled = (id: string, cat: string, tier: "gold" | "llm") => ({
  email: normalize({ threadId: id, from: `c${id}@x.example`, to: [], subject: `subj-${id}`, listId: null,
    attachments: [], bodyText: `body-${id}`, internalDateMs: 1, references: [] }),
  categoryIds: [cat], tier,
});

describe("buildSystemPrompt", () => {
  it("includes every category id with its description and the confidence rubric", () => {
    const p = buildSystemPrompt(cfg, []);
    for (const id of ["jo", "sales", "support", "junk"]) expect(p).toContain(`"${id}"`);
    expect(p).toContain("Billing, invoices");
    expect(p).toMatch(/high.*certainly agree/i);
  });
  it("includes exemplars under their category", () => {
    const p = buildSystemPrompt(cfg, pickExemplars([labeled("1", "sales", "gold")]));
    expect(p).toContain("subj-1");
  });
});

describe("pickExemplars", () => {
  it("prefers gold and caps per category", () => {
    const pool = [labeled("g1", "jo", "gold"), labeled("l1", "jo", "llm"), labeled("l2", "jo", "llm"), labeled("l3", "jo", "llm")];
    const ex = pickExemplars(pool, 2);
    expect(ex).toHaveLength(2);
    expect(ex[0].tier).toBe("gold");
  });
});

describe("PROVIDER_PACKAGES", () => {
  it("maps the supported providers", () => {
    expect(PROVIDER_PACKAGES["anthropic"]).toBe("@langchain/anthropic");
    expect(PROVIDER_PACKAGES["google_genai"]).toBe("@langchain/google-genai");
  });
});

// Finding I1: the `exemplars` table was written at deploy (deploy.ts's seedExemplars) but
// never read anywhere at runtime — the ingest route built makeClassifier(officeCfg, [])
// unconditionally, so production ran an unpersonalized prompt while the onboarding report's
// eval numbers came from the exemplar-tuned classifier.
describe("loadExemplars", () => {
  beforeEach(async () => {
    setDb(pgliteAdapter(new PGlite()));
    await runMigrations(getDb());
  });

  it("round-trips exemplar rows written the same way deploy.ts's seedExemplars writes them", async () => {
    await getDb().query(
      `insert into exemplars (category_id, from_addr, subject, body_excerpt, tier) values ($1,$2,$3,$4,$5)`,
      ["jo", "statements@officesupply.example", "Monthly statement #1001", "Amount due: $412.55.", "gold"]
    );
    await getDb().query(
      `insert into exemplars (category_id, from_addr, subject, body_excerpt, tier) values ($1,$2,$3,$4,$5)`,
      ["sales", "sam@brightline-consulting.example", "Need quote for 12 desks", "We need a quote.", "llm"]
    );

    const exemplars = await loadExemplars(getDb());
    expect(exemplars).toHaveLength(2);
    expect(exemplars).toContainEqual({
      categoryId: "jo", fromAddr: "statements@officesupply.example",
      subject: "Monthly statement #1001", bodyExcerpt: "Amount due: $412.55.", tier: "gold",
    });
    expect(exemplars).toContainEqual({
      categoryId: "sales", fromAddr: "sam@brightline-consulting.example",
      subject: "Need quote for 12 desks", bodyExcerpt: "We need a quote.", tier: "llm",
    });
  });

  it("returns an empty array when nothing has been seeded yet", async () => {
    expect(await loadExemplars(getDb())).toEqual([]);
  });
});

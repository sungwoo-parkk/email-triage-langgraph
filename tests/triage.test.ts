import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { buildTriageGraph } from "@/graph/triage";
import { normalize } from "@/lib/normalize";
import { loadOfficeConfig, setOfficeConfig } from "@/lib/officeConfig";
import { setConfigKey } from "@/lib/config";
import type { MailClient } from "@/lib/mail/types";

// PGlite's parameterized query() rejects multi-statement SQL (our migration files
// contain several `create table` statements per file), so DDL and RETURNING-less
// INSERTs must go through exec() instead. Same adapter used by tests/act.test.ts,
// tests/config.test.ts, tests/db.test.ts, tests/decide.test.ts, tests/seed.test.ts.
function pgliteAdapter(p: PGlite): Querier {
  return {
    query: async (sql, params) => {
      if (!params || params.length === 0) {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith("CREATE") || (trimmed.startsWith("INSERT") && !trimmed.includes("RETURNING"))) {
          await p.exec(sql);
          return { rows: [] };
        }
      }
      return p.query(sql, params as any[]) as any;
    },
  };
}

const officeCfg = loadOfficeConfig("examples/hartley/triage.config.json");

const silentMail: MailClient = {
  listNewThreads: async () => [], listHistory: async function* () {}, ensureCategories: async () => {},
  applyCategories: async () => { throw new Error("must not act in shadow"); },
  forward: async () => { throw new Error("must not act in shadow"); }, sendMessage: async () => {},
};

function email(threadId: string, from: string, subject: string, body: string) {
  return normalize({ threadId, from, to: [], subject, listId: null, attachments: [], bodyText: body, internalDateMs: 10, references: [] });
}

describe("triage graph (shadow stage)", () => {
  beforeEach(async () => {
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
    await setOfficeConfig(getDb(), officeCfg);
    // Hartley's category ids ("jo", "sales", "junk") differ from this repo's original
    // AGY default autoActLabels list, so tests set an explicit allow-list rather than
    // depend on config.ts's (still-AGY-shaped) DEFAULTS.
    await setConfigKey(getDb(), "autoActLabels", ["jo", "sales", "junk"]);
    await getDb().query(
      `insert into rules (pattern_type, pattern, label_set, complete, source)
       values ('sender_domain','dxc.com','["jo"]', true, 'phase0')`
    );
  });

  it("complete rule hit skips the classifier entirely", async () => {
    let llmCalls = 0;
    const g = buildTriageGraph({ db: getDb(), mail: silentMail,
      classify: async () => { llmCalls++; throw new Error("should not be called"); } });
    const id = await g.run(email("g1", "ny_agent_copy@dxc.com", "Agent Copy of Print", "Hello"));
    const { rows } = await getDb().query(`select * from decisions where id=$1`, [id]);
    expect(llmCalls).toBe(0);
    expect(rows[0].confidence).toBe("rule");
    expect(rows[0].status).toBe("decided");
  });

  it("rule miss classifies via LLM and records llm_output", async () => {
    // "sales" is in the autoActLabels override set above -> decides automatically.
    const g = buildTriageGraph({ db: getDb(), mail: silentMail,
      classify: async () => ({ tasks: [{ category: "sales" }], confidence: "high", rationale: "r" }) });
    const id = await g.run(email("g2", "vicky@oakmont.example", "quote please", "need pricing for a new order"));
    const { rows } = await getDb().query(`select llm_output, status from decisions where id=$1`, [id]);
    expect(rows[0].llm_output).toBeTruthy();
    expect(rows[0].status).toBe("decided");
  });

  it("classifier failure fails toward review, never toward action", async () => {
    const g = buildTriageGraph({ db: getDb(), mail: silentMail,
      classify: async () => { throw new Error("gemini down"); } });
    const id = await g.run(email("g3", "x@y.com", "hmm", "??"));
    const { rows } = await getDb().query(`select status from decisions where id=$1`, [id]);
    expect(rows[0].status).toBe("needs_review");
  });
});

describe("triage graph (assisted stage: needs_review still reaches act)", () => {
  beforeEach(async () => {
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
    await setOfficeConfig(getDb(), officeCfg);
    await setConfigKey(getDb(), "autoActLabels", ["jo", "sales", "junk"]);
    await setConfigKey(getDb(), "stage", "assisted");
  });

  it("a needs_review decision still executes its planned review-forward", async () => {
    const seen: string[] = [];
    const mail: MailClient = {
      listNewThreads: async () => [], listHistory: async function* () {}, ensureCategories: async () => {},
      applyCategories: async () => { throw new Error("categories should not run for this decision"); },
      forward: async (threadId, to) => { seen.push(`${threadId}:${to}`); },
      sendMessage: async () => {},
    };
    // "support" is not in the autoActLabels override -> needs_review with a planned
    // review-forward, per the record->act edge now being unconditional.
    const g = buildTriageGraph({ db: getDb(), mail,
      classify: async () => ({ tasks: [{ category: "support" }], confidence: "high", rationale: "r" }) });
    const id = await g.run(email("g4", "z@w.example", "help please", "??"));
    const { rows } = await getDb().query(`select status from decisions where id=$1`, [id]);
    expect(rows[0].status).toBe("needs_review");
    expect(seen).toEqual([`g4:${officeCfg.review.recipient}`]);
  });
});

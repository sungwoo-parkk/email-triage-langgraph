import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { buildTriageGraph } from "@/graph/triage";
import { normalize } from "@/lib/normalize";
import type { GmailClient } from "@/lib/gmail";

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

const silentGmail: GmailClient = {
  listNewThreads: async () => [], applyLabels: async () => { throw new Error("must not act in shadow"); },
  forward: async () => { throw new Error("must not act in shadow"); }, sendAlert: async () => {},
};

function email(threadId: string, from: string, subject: string, body: string) {
  return normalize({ threadId, from, subject, listId: null, attachments: [], bodyText: body, internalDateMs: 10 });
}

describe("triage graph (shadow stage)", () => {
  beforeEach(async () => {
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
    await getDb().query(
      `insert into rules (pattern_type, pattern, label_set, complete, source)
       values ('sender_domain','dxc.com','["3-KR","3-KR/DOCS&NOTICE"]', true, 'phase0')`
    );
  });

  it("complete rule hit skips the classifier entirely", async () => {
    let llmCalls = 0;
    const g = buildTriageGraph({ db: getDb(), gmail: silentGmail,
      classify: async () => { llmCalls++; throw new Error("should not be called"); } });
    const id = await g.run(email("g1", "ny_agent_copy@dxc.com", "Agent Copy of Print", "Hello"));
    const { rows } = await getDb().query(`select * from decisions where id=$1`, [id]);
    expect(llmCalls).toBe(0);
    expect(rows[0].confidence).toBe("rule");
    expect(rows[0].status).toBe("decided");
  });

  it("rule miss classifies via LLM and records llm_output", async () => {
    // 7-Loss Run Req is in the default autoActLabels strong list (4-CAN REQ no longer is)
    const g = buildTriageGraph({ db: getDb(), gmail: silentGmail,
      classify: async () => ({ tasks: [{ labels: ["7-Loss Run Req"], forward_to: "none" }], confidence: "high", rationale: "r" }) });
    const id = await g.run(email("g2", "vicky@oakmont.com", "loss runs please", "need claims history for renewal"));
    const { rows } = await getDb().query(`select llm_output, status from decisions where id=$1`, [id]);
    expect(rows[0].llm_output).toBeTruthy();
    expect(rows[0].status).toBe("decided");
  });

  it("classifier failure fails toward review, never toward action", async () => {
    const g = buildTriageGraph({ db: getDb(), gmail: silentGmail,
      classify: async () => { throw new Error("gemini down"); } });
    const id = await g.run(email("g3", "x@y.com", "hmm", "??"));
    const { rows } = await getDb().query(`select status from decisions where id=$1`, [id]);
    expect(rows[0].status).toBe("needs_review");
  });
});

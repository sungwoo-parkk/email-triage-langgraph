import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { runIngestBatch } from "@/lib/ingest";
import type { NormalizedEmail, ThreadSnapshot } from "@/lib/normalize";

// Same adapter used across tests/act.test.ts, tests/config.test.ts, tests/db.test.ts,
// tests/decide.test.ts, tests/seed.test.ts, tests/triage.test.ts: PGlite's parameterized
// query() cannot run the multi-statement DDL in our migration files, so DDL and
// RETURNING-less INSERTs must go through exec() instead.
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

function snap(threadId: string, internalDateMs: number): ThreadSnapshot {
  return { threadId, from: "a@b.com", subject: "s", listId: null, attachments: [], bodyText: "body", internalDateMs };
}

describe("runIngestBatch", () => {
  beforeEach(async () => {
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
  });

  it("clean batch: all processed, checkpoint = max internalDateMs", async () => {
    let nextId = 1;
    const calls: string[] = [];
    const graph = { run: async (email: NormalizedEmail) => { calls.push(email.threadId); return nextId++; } };
    const snaps = [snap("a1", 100), snap("a2", 300), snap("a3", 200)];

    const result = await runIngestBatch(getDb(), graph, snaps, 0, "shadow");

    expect(result.processed).toBe(3);
    expect(result.failures).toBe(0);
    expect(result.checkpointMs).toBe(300);
    expect(calls.sort()).toEqual(["a1", "a2", "a3"]);
  });

  it("one thread's run() throws: others processed, checkpoint clamped below the failed thread's date", async () => {
    let nextId = 1;
    const graph = {
      run: async (email: NormalizedEmail) => {
        if (email.threadId === "bad") throw new Error("boom");
        return nextId++;
      },
    };
    // "bad" is earlier than the succeeding thread — a naive max() would race the
    // checkpoint past the still-unresolved failure.
    const snaps = [snap("bad", 100), snap("good", 500)];

    const result = await runIngestBatch(getDb(), graph, snaps, 0, "shadow");

    expect(result.processed).toBe(1);
    expect(result.failures).toBe(1);
    expect(result.checkpointMs).toBe(99); // clamped to bad.internalDateMs - 1

    const { rows } = await getDb().query(`select count, last_error from ingest_failures where thread_id = $1`, ["bad"]);
    expect(Number(rows[0].count)).toBe(1);
    expect(rows[0].last_error).toBe("boom");

    // never poison-stubbed before 3 strikes
    const decided = await getDb().query(`select 1 from decisions where thread_id = $1`, ["bad"]);
    expect(decided.rows).toEqual([]);
  });

  it("after 3 failing runs of the same thread, it is poison-stubbed and a 4th run skips it via dedupe", async () => {
    const calls: string[] = [];
    const graph = {
      run: async (email: NormalizedEmail) => {
        calls.push(email.threadId);
        throw new Error("always fails");
      },
    };
    const snaps = [snap("poison1", 1000)];

    const r1 = await runIngestBatch(getDb(), graph, snaps, 0, "shadow");
    expect(r1.failures).toBe(1);
    expect(r1.checkpointMs).toBe(0); // unresolved: checkpoint held back

    const r2 = await runIngestBatch(getDb(), graph, snaps, r1.checkpointMs, "shadow");
    expect(r2.failures).toBe(1);
    expect(r2.checkpointMs).toBe(0);

    const r3 = await runIngestBatch(getDb(), graph, snaps, r2.checkpointMs, "shadow");
    expect(r3.failures).toBe(1);
    expect(r3.checkpointMs).toBe(1000); // poison-stubbed on the 3rd strike: safe to pass

    const { rows } = await getDb().query(`select status, error_detail from decisions where thread_id = $1`, ["poison1"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error_detail).toMatch(/^ingest poisoned:/);

    expect(calls.length).toBe(3);
    const r4 = await runIngestBatch(getDb(), graph, snaps, r3.checkpointMs, "shadow");
    expect(r4.processed).toBe(0);
    expect(r4.failures).toBe(0);
    expect(calls.length).toBe(3); // graph.run not called again — skipped via dedupe
  });

  it("dedupe: a thread with an existing decisions row is skipped without calling graph.run", async () => {
    await getDb().query(
      `insert into threads (thread_id, from_addr, subject, attachments, list_id, body_excerpt, internal_date_ms)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      ["dup1", "a@b.com", "s", "[]", null, "", 50]
    );
    await getDb().query(
      `insert into decisions (thread_id, stage, rule_hits, final_tasks, actions_planned, status)
       values ($1,$2,'[]','[]','[]','decided')`,
      ["dup1", "shadow"]
    );

    const calls: string[] = [];
    const graph = { run: async (email: NormalizedEmail) => { calls.push(email.threadId); return 1; } };

    const result = await runIngestBatch(getDb(), graph, [snap("dup1", 999)], 0, "shadow");

    expect(result.processed).toBe(0);
    expect(result.failures).toBe(0);
    expect(calls).toEqual([]);
  });
});

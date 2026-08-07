import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { executeDecision } from "@/lib/act";
import { recordDecision, decide } from "@/lib/decide";
import { normalize } from "@/lib/normalize";
import type { MailClient } from "@/lib/mail/types";

function pgliteAdapter(p: PGlite): Querier {
  return {
    query: async (sql, params) => {
      // Use exec for non-parameterized DDL
      if (!params || params.length === 0) {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith("CREATE") || (trimmed.startsWith("INSERT") && !trimmed.includes("RETURNING"))) {
          await p.exec(sql);
          return { rows: [] };
        }
      }
      // Use query for parameterized queries or SELECT or RETURNING
      return p.query(sql, params as any[]) as any;
    },
  };
}

function fakeGmail() {
  const calls: string[] = [];
  const g: MailClient = {
    listNewThreads: async () => [],
    listHistory: async function* () {},
    ensureCategories: async () => {},
    applyCategories: async (id, labels) => { calls.push(`labels:${id}:${labels.sort().join("|")}`); },
    forward: async (id, to) => { calls.push(`forward:${id}:${to}`); },
    sendMessage: async () => { calls.push("alert"); },
  };
  return { g, calls };
}

const highDecision = () =>
  decide({ hits: [], labels: [], forwards: [], complete: false },
    { tasks: [{ labels: ["4-CAN REQ"], forward_to: "invoice@agency.example" }], confidence: "high", rationale: "" },
    { stage: "shadow", autoActLabels: ["4-CAN REQ", "3-KR/DOCS&NOTICE"] });

async function seed(threadId: string) {
  const email = normalize({ threadId, from: "a@b.com", to: [], subject: "s", listId: null, attachments: [], bodyText: "", internalDateMs: 1, references: [] });
  return recordDecision(getDb(), email, { hits: [], labels: [], forwards: [], complete: false }, null, highDecision(), "test");
}

describe("executeDecision", () => {
  beforeEach(async () => {
    const p = new PGlite();
    setDb(pgliteAdapter(p));
    await runMigrations(getDb());
  });

  it("shadow stage executes nothing", async () => {
    const id = await seed("s1");
    const { g, calls } = fakeGmail();
    await executeDecision(getDb(), g, id, { stage: "shadow", autoActLabels: [] });
    expect(calls).toEqual([]);
    const { rows } = await getDb().query(`select status from decisions where id=$1`, [id]);
    expect(rows[0].status).toBe("decided");
  });

  it("assisted stage applies labels but never forwards", async () => {
    const id = await seed("s2");
    const { g, calls } = fakeGmail();
    await executeDecision(getDb(), g, id, { stage: "assisted", autoActLabels: [] });
    expect(calls).toEqual(["labels:s2:4-CAN REQ"]);
  });

  it("autonomous stage applies labels and forwards, and is idempotent", async () => {
    const id = await seed("s3");
    const { g, calls } = fakeGmail();
    const cfg = { stage: "autonomous" as const, autoActLabels: [] };
    await executeDecision(getDb(), g, id, cfg);
    await executeDecision(getDb(), g, id, cfg); // second run must be a no-op
    expect(calls).toEqual(["labels:s3:4-CAN REQ", "forward:s3:invoice@agency.example"]);
    const { rows } = await getDb().query(`select status, actions_executed from decisions where id=$1`, [id]);
    expect(rows[0].status).toBe("acted");
  });

  it("a failing forward marks the decision failed but keeps executed labels recorded", async () => {
    const id = await seed("s4");
    const g: MailClient = {
      listNewThreads: async () => [], listHistory: async function* () {}, ensureCategories: async () => {},
      applyCategories: async () => {},
      forward: async () => { throw new Error("smtp down"); }, sendMessage: async () => {},
    };
    await executeDecision(getDb(), g, id, { stage: "autonomous", autoActLabels: [] });
    const { rows } = await getDb().query(`select status, actions_executed, error_detail from decisions where id=$1`, [id]);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error_detail).toBe("smtp down");
    const executed = typeof rows[0].actions_executed === "string" ? JSON.parse(rows[0].actions_executed) : rows[0].actions_executed;
    expect(executed.some((a: any) => a.kind === "labels")).toBe(true);
  });
});

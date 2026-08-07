import { describe, it, expect } from "vitest";
import { loadOfficeConfig } from "@/lib/officeConfig";
import { makeClassifier, makeClassificationSchema } from "@/lib/classify";
import { normalize } from "@/lib/normalize";

const cfg = loadOfficeConfig("examples/hartley/triage.config.json");
const email = normalize({ threadId: "t", from: "cust@x.example", to: [], subject: "invoice overdue",
  listId: null, attachments: [], bodyText: "please fix my invoice", internalDateMs: 0, references: [] });
const noRules = { hits: [], labels: [], forwards: [], complete: false };

describe("runtime classification schema", () => {
  const schema = makeClassificationSchema(cfg);
  it("accepts category ids from the office vocabulary", () => {
    expect(() => schema.parse({ tasks: [{ category: "jo" }], confidence: "high", rationale: "" })).not.toThrow();
  });
  it("rejects ids outside the vocabulary", () => {
    expect(() => schema.parse({ tasks: [{ category: "ceo" }], confidence: "high", rationale: "" })).toThrow();
  });
});

describe("makeClassifier", () => {
  it("returns schema-valid output from the model", async () => {
    const fake = { invoke: async () => ({ tasks: [{ category: "jo" }], confidence: "high", rationale: "billing" }) };
    const c = await makeClassifier(cfg, [], fake)(email, noRules);
    expect(c.tasks[0].category).toBe("jo");
  });
  it("retries once, then throws", async () => {
    let calls = 0;
    const flaky = { invoke: async () => { calls++; throw new Error("boom"); } };
    await expect(makeClassifier(cfg, [], flaky)(email, noRules)).rejects.toThrow("boom");
    expect(calls).toBe(2);
  });
  it("passes rule evidence into the human message", async () => {
    let seen = "";
    const spy = { invoke: async (m: [string, string][]) => { seen = m[1][1]; return { tasks: [{ category: "jo" }], confidence: "high", rationale: "" }; } };
    await makeClassifier(cfg, [], spy)(email, { hits: [{} as any], labels: ["jo"], forwards: [], complete: false });
    expect(seen).toContain("rules already suggest");
  });
});

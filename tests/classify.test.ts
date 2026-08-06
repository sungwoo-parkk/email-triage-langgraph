import { describe, it, expect } from "vitest";
import { makeClassifier, ClassificationSchema } from "@/lib/classify";
import { normalize } from "@/lib/normalize";

const email = normalize({
  threadId: "t", from: "vicky@oakmont.com", subject: "cancellation request",
  listId: null, attachments: ["LPR.pdf"], bodyText: "Please cancel effective 6/30 and update mailing address.",
  internalDateMs: 0,
});
const noRules = { hits: [], labels: [], forwards: [], complete: false };

describe("classifier", () => {
  it("returns schema-valid output from the model", async () => {
    const fake = { invoke: async () => ({
      tasks: [{ labels: ["4-CAN REQ"], forward_to: "none" }], confidence: "high", rationale: "cancel + LPR",
    }) };
    const c = await makeClassifier(fake)(email, noRules);
    expect(c.tasks[0].labels).toEqual(["4-CAN REQ"]);
    expect(c.confidence).toBe("high");
  });

  it("retries once on failure, then throws", async () => {
    let calls = 0;
    const flaky = { invoke: async () => { calls++; throw new Error("boom"); } };
    await expect(makeClassifier(flaky)(email, noRules)).rejects.toThrow("boom");
    expect(calls).toBe(2);
  });

  it("rejects labels outside the classifiable vocabulary", () => {
    const bad = { tasks: [{ labels: ["*1-DONE/DONE-P4"], forward_to: "none" }], confidence: "high", rationale: "" };
    expect(() => ClassificationSchema.parse(bad)).toThrow();
  });

  it("rejects forward targets outside desk aliases", () => {
    const bad = { tasks: [{ labels: ["Billing"], forward_to: "vy@agency.example" }], confidence: "high", rationale: "" };
    expect(() => ClassificationSchema.parse(bad)).toThrow();
  });
});

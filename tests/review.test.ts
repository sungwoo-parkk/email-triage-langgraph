import { describe, it, expect } from "vitest";
import { buildContextBody } from "@/lib/review";
import { loadOfficeConfig, deriveVocabulary } from "@/lib/officeConfig";
import { normalize } from "@/lib/normalize";

const vocab = deriveVocabulary(loadOfficeConfig("examples/hartley/triage.config.json"));
const email = normalize({ threadId: "t", from: "cust@x.example", to: [], subject: "invoice overdue",
  listId: null, attachments: [], bodyText: "b", internalDateMs: 0, references: [] });

describe("buildContextBody", () => {
  it("context body names the proposal, confidence, rationale, and the correction instruction", () => {
    const body = buildContextBody(email, {
      tasks: [{ categoryId: "jo", label: "triage/jo", forwardTo: "jo@hartleysons.example" }],
      confidence: "medium", status: "needs_review", actionsPlanned: [], rationale: "looks like billing",
    } as any, vocab);
    expect(body).toContain("[triage]");
    expect(body).toContain("Jo"); // human-readable name, not just the id
    expect(body).toContain("medium");
    expect(body).toContain("looks like billing");
    expect(body).toMatch(/forward this email to the right person/i);
  });

  it("falls back to a no-proposal line when the decision has no tasks", () => {
    const body = buildContextBody(email, {
      tasks: [], confidence: "low", status: "needs_review", actionsPlanned: [],
    } as any, vocab);
    expect(body).toContain("no proposal");
  });
});

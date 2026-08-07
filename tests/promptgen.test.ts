import { describe, it, expect } from "vitest";
import { loadOfficeConfig } from "@/lib/officeConfig";
import { buildSystemPrompt, pickExemplars, PROVIDER_PACKAGES } from "@/lib/promptgen";
import { normalize } from "@/lib/normalize";

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

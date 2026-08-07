import { describe, it, expect } from "vitest";
import { parseOfficeConfig, loadOfficeConfig, deriveVocabulary, assertVocabularyCompatible, configHash } from "@/lib/officeConfig";

const base = {
  version: 1,
  office: { name: "Hartley & Sons", mailbox: "info@hartleysons.example" },
  routees: [
    { id: "jo", name: "Jo Hartley", email: "jo@hartleysons.example", description: "Billing, invoices, refunds" },
    { id: "sales", name: "Sales desk", email: "sales@hartleysons.example", description: "Quotes, new orders" },
  ],
  categories: [],
  review: { recipient: "jo@hartleysons.example" },
  llm: { model: "anthropic:claude-sonnet-5", apiKeyEnv: "ANTHROPIC_API_KEY" },
  mining: { months: 6, maxThreads: 5000 },
};

describe("parseOfficeConfig", () => {
  it("accepts a valid config and injects the builtin junk category", () => {
    const cfg = parseOfficeConfig(base);
    expect(cfg.categories.some((c) => c.id === "junk")).toBe(true);
  });
  it("rejects duplicate ids across routees and categories", () => {
    expect(() => parseOfficeConfig({ ...base, categories: [{ id: "jo", description: "dupe", route: null }] })).toThrow(/duplicate/i);
  });
  it("rejects an llm model without a provider prefix", () => {
    expect(() => parseOfficeConfig({ ...base, llm: { model: "gpt-4o", apiKeyEnv: "X" } })).toThrow(/provider:model/i);
  });
  it("rejects a category routing to an unknown routee", () => {
    expect(() => parseOfficeConfig({ ...base, categories: [{ id: "legal", description: "x", route: "nobody" }] })).toThrow(/unknown routee/i);
  });
});

describe("deriveVocabulary", () => {
  const vocab = deriveVocabulary(parseOfficeConfig(base));
  it("makes every routee a category plus builtins", () => {
    expect(vocab.categoryIds.sort()).toEqual(["jo", "junk", "sales"]);
  });
  it("namespaces label names", () => {
    expect(vocab.labelFor("jo")).toBe("triage/jo");
  });
  it("routes routee categories to their email and junk to null", () => {
    expect(vocab.routeFor("sales")).toBe("sales@hartleysons.example");
    expect(vocab.routeFor("junk")).toBeNull();
  });
});

describe("vocabulary lock and hash", () => {
  it("throws when an id disappears", () => {
    const next = { ...base, routees: base.routees.slice(0, 1) };
    expect(() => assertVocabularyCompatible(parseOfficeConfig(base), parseOfficeConfig(next))).toThrow(/sales/);
  });
  it("allows additions and is order-insensitive for hashing", () => {
    const reordered = { ...base, routees: [...base.routees].reverse() };
    expect(configHash(parseOfficeConfig(base))).toBe(configHash(parseOfficeConfig(reordered)));
  });
});

describe("example configs", () => {
  it("both example office configs parse", () => {
    expect(() => loadOfficeConfig("examples/hartley/triage.config.json")).not.toThrow();
    expect(() => loadOfficeConfig("examples/agency/triage.config.json")).not.toThrow();
  });
});

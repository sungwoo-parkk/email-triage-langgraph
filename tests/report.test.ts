import { describe, it, expect } from "vitest";
import type { EvalReport } from "@/lib/onboardEval";
import type { MinedRule } from "@/lib/mining";
import { renderReport } from "@/lib/report";

const evalReport: EvalReport = {
  overallAgreement: 0.9,
  perCategory: [
    { categoryId: "jo", precision: 1, recall: 1, f1: 1, support: 10 },
    { categoryId: "sales", precision: 0.75, recall: 0.75, f1: 0.75, support: 8 },
  ],
  strongCategoryIds: ["jo"],
  evaluated: 20,
  failures: 1,
};

const rules: MinedRule[] = [
  { patternType: "sender_domain", pattern: "carrier.example", categoryIds: ["jo"], purity: 0.95, support: 6, tier: "mined-gold" },
];

const samples = [
  { subject: "Invoice #123", from: "billing@carrier.example", categoryIds: ["jo"] },
];

describe("renderReport", () => {
  it("renders a self-contained page with the strong/review-only split", () => {
    const html = renderReport({ office: "Hartley & Sons", evalReport, rules, samples, floor: 0.7 });
    expect(html).toContain("Hartley");
    expect(html).toContain("triage/jo");
    expect(html).not.toMatch(/https?:\/\/(?!smith)/); // no external requests (allow doc links if any -> keep none, simplest: no http at all)
    expect(html).toMatch(/auto-route/i);
  });

  it("shows the warning block below the floor", () => {
    const html = renderReport({ office: "X", evalReport: { ...evalReport, overallAgreement: 0.5 }, rules: [], samples: [], floor: 0.7 });
    expect(html).toMatch(/review-only/i);
  });

  it("shows the warning block when there is no eval report yet", () => {
    const html = renderReport({ office: "X", evalReport: null, rules: [], samples: [], floor: 0.7 });
    expect(html).toMatch(/review-only/i);
    expect(html).not.toMatch(/https?:\/\//);
  });
});

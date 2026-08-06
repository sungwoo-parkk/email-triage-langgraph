import { describe, it, expect } from "vitest";
import { extractSeedRules } from "@/lib/seed";

const stats = {
  rule_candidates: {
    sender_domain_labelset: [
      { key: "dxc.com", n: 160, top_label: "3-KR + 3-KR/DOCS&NOTICE", purity: 0.994 },
      { key: "attuneinsurance.com", n: 33, top_label: "3-KR + 3-KR/DOCS&NOTICE", purity: 0.758 }, // below 0.9
      { key: "enews.wealthmanagement.com", n: 20, top_label: "(done/disregard only)", purity: 1.0 }, // sentinel
      { key: "smallco.com", n: 4, top_label: "2-NY", purity: 1.0 }, // below support
    ],
    sender_exact_labelset: [
      { key: "policyprocessing@usli.com", n: 19, top_label: "3-KR + 3-KR/DOCS&NOTICE", purity: 1.0 },
      { key: "flaky@x.com", n: 6, top_label: "2-NY", purity: 0.9 }, // below 0.95 exact threshold
    ],
    list_id_labelset: [
      { key: "<quit.agency.example>", n: 68, top_label: "disregard", purity: 0.985 },
    ],
  },
};

describe("extractSeedRules", () => {
  it("applies spec 4.2 thresholds and skips sentinel label-sets", () => {
    const seeds = extractSeedRules(stats);
    const patterns = seeds.map((s) => s.pattern);
    expect(patterns).toContain("dxc.com");
    expect(patterns).toContain("policyprocessing@usli.com");
    expect(patterns).toContain("<quit.agency.example>");
    expect(patterns).not.toContain("attuneinsurance.com");
    expect(patterns).not.toContain("smallco.com");
    expect(patterns).not.toContain("flaky@x.com");
    expect(patterns).not.toContain("enews.wealthmanagement.com");
  });
  it("splits label sets on ' + '", () => {
    const dxc = extractSeedRules(stats).find((s) => s.pattern === "dxc.com")!;
    expect(dxc.labels.sort()).toEqual(["3-KR", "3-KR/DOCS&NOTICE"]);
  });
});

import { describe, it, expect } from "vitest";
import { costPer1k, renderMatrixTable, replaceBetweenMarkers, type TierRow } from "../evals/matrixTable";

const okRow: TierRow = {
  model: "google_genai:gemini-3.6-flash",
  ok: true,
  price: { inPerM: 0.3, outPerM: 2.5 },
  metrics: {
    exact_set_match: { mean: 0.91, n: 67 },
    task_count_match: { mean: 1, n: 67 },
    forward_match: { mean: 1, n: 67 },
    faithfulness: { mean: 0.97, n: 67 },
    instruction_following: { mean: 0.974, n: 67 },
    latency_s: { mean: 2.63, n: 67 },
    input_tokens: { mean: 1000, n: 67 },
    output_tokens: { mean: 100, n: 67 },
  },
};

describe("costPer1k", () => {
  it("computes measured tokens x price per 1K emails", () => {
    // (1000*0.3/1e6 + 100*2.5/1e6) * 1000 = 0.55
    expect(costPer1k(okRow)).toBe("$0.55");
  });
  it("is em-dash when usage is missing — never estimated", () => {
    const { input_tokens, output_tokens, ...rest } = okRow.metrics!;
    expect(costPer1k({ ...okRow, metrics: rest })).toBe("—");
  });
  it("is em-dash when the price map has no entry", () => {
    expect(costPer1k({ ...okRow, price: null })).toBe("—");
  });
});

describe("renderMatrixTable", () => {
  it("renders metric percentages, latency, cost, and the as-of footnote", () => {
    const t = renderMatrixTable([okRow], "2026-08");
    expect(t).toContain("| gemini-3.6-flash | 91.0% | 100.0% | 100.0% | 97.0% | 97.4% | 2.63s | $0.55 |");
    expect(t).toContain("as of 2026-08");
    expect(t).toContain("GEMINI_JUDGE_MODEL");
  });
  it("renders a failed tier as a failed row, not fabricated numbers", () => {
    const t = renderMatrixTable([{ model: "google_genai:gemini-3.6-pro", ok: false, error: "429 quota", price: null }], "2026-08");
    expect(t).toContain("_run failed: 429 quota_");
    expect(t).not.toContain("NaN");
  });
});

describe("replaceBetweenMarkers", () => {
  const doc = "before\n<!-- eval-matrix:start -->\nold\n<!-- eval-matrix:end -->\nafter";
  it("replaces only the region between markers and is idempotent", () => {
    const once = replaceBetweenMarkers(doc, "<!-- eval-matrix:start -->", "<!-- eval-matrix:end -->", "NEW");
    expect(once).toContain("before");
    expect(once).toContain("after");
    expect(once).toContain("NEW");
    expect(once).not.toContain("old");
    const twice = replaceBetweenMarkers(once, "<!-- eval-matrix:start -->", "<!-- eval-matrix:end -->", "NEW");
    expect(twice).toBe(once);
  });
  it("throws when the markers are absent (protects the committed doc)", () => {
    expect(() => replaceBetweenMarkers("no markers here", "<!-- eval-matrix:start -->", "<!-- eval-matrix:end -->", "x")).toThrow(/markers/);
  });
});

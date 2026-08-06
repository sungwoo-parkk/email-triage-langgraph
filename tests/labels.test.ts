import { describe, it, expect } from "vitest";
import { ALL_LABELS, CLASSIFIABLE_LABELS, isDoneLabel, DESK_ALIASES } from "@/lib/labels";

describe("label vocabulary", () => {
  it("preserves the Cancelllation misspelling (load-bearing)", () => {
    expect(ALL_LABELS).toContain("Cancelllation");
    expect(ALL_LABELS).not.toContain("Cancellation");
  });
  it("has exactly 42 labels", () => {
    expect(ALL_LABELS.length).toBe(42);
  });
  it("excludes DONE-family labels from the classifier vocabulary", () => {
    expect(CLASSIFIABLE_LABELS.every((l) => !isDoneLabel(l))).toBe(true);
    expect(CLASSIFIABLE_LABELS).toContain("3-KR/DOCS&NOTICE");
    expect(CLASSIFIABLE_LABELS).not.toContain("*1-DONE/DONE-P4");
  });
  it("locks the desk aliases", () => {
    expect([...DESK_ALIASES]).toEqual(["invoice@agency.example", "accounting@agency.example", "express@agency.example"]);
  });
});

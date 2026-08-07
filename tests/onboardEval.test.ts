import { describe, it, expect } from "vitest";
import { normalize } from "@/lib/normalize";
import type { LabeledThread } from "@/lib/mining";
import type { Classification } from "@/lib/classify";
import { runHoldoutEval } from "@/lib/onboardEval";

function labeled(threadId: string, categoryIds: string[]): LabeledThread {
  return {
    email: normalize({
      threadId, from: `a@${threadId}.example`, to: [], subject: `${threadId} subject`, listId: null,
      attachments: [], bodyText: "body", internalDateMs: 1, references: [],
    }),
    categoryIds,
    tier: "gold",
  };
}

// 10 jo-labeled + 10 sales-labeled threads.
const joHoldout = Array.from({ length: 10 }, (_, i) => labeled(`jo${i}`, ["jo"]));
const salesHoldout = Array.from({ length: 10 }, (_, i) => labeled(`sales${i}`, ["sales"]));
const holdout = [...joHoldout, ...salesHoldout];

// Perfect on jo; on sales, correct for the first 6 and wrong (mis-labeled "misc",
// a category outside {jo,sales}) for the remaining 4 - keeps jo's precision at 1
// while dragging sales's recall down to 0.6 (support 10, f1 0.75 < strong bar).
async function stub(email: { threadId: string }): Promise<Classification> {
  if (email.threadId.startsWith("jo")) return { tasks: [{ category: "jo" }], confidence: "high", rationale: "" };
  const i = Number(email.threadId.replace("sales", ""));
  const category = i < 6 ? "sales" : "misc";
  return { tasks: [{ category }], confidence: "high", rationale: "" };
}

describe("runHoldoutEval", () => {
  it("scores per-category F1 and flags strong categories", async () => {
    const report = await runHoldoutEval(stub, holdout);
    expect(report.overallAgreement).toBeCloseTo(16 / 20);
    const jo = report.perCategory.find((c) => c.categoryId === "jo")!;
    expect(jo.f1).toBe(1);
    expect(report.strongCategoryIds).toContain("jo");
    expect(report.strongCategoryIds).not.toContain("sales");
  });

  it("counts classify failures without aborting", async () => {
    const report = await runHoldoutEval(async () => { throw new Error("x"); }, holdout.slice(0, 3));
    expect(report.failures).toBe(3);
    expect(report.evaluated).toBe(0);
  });
});

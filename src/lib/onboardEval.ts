import type { LabeledThread } from "./mining";
import type { Classification } from "./classify";
import type { NormalizedEmail } from "./normalize";

export interface CategoryStat { categoryId: string; precision: number; recall: number; f1: number; support: number }
export interface EvalReport { overallAgreement: number; perCategory: CategoryStat[]; strongCategoryIds: string[]; evaluated: number; failures: number }

export async function runHoldoutEval(
  classify: (e: NormalizedEmail) => Promise<Classification>,
  holdout: LabeledThread[]
): Promise<EvalReport> {
  let exact = 0, evaluated = 0, failures = 0;
  const tp = new Map<string, number>(), fp = new Map<string, number>(), fn = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const h of holdout) {
    let got: Set<string>;
    try { got = new Set((await classify(h.email)).tasks.map((t) => t.category)); }
    catch { failures++; continue; }
    evaluated++;
    const want = new Set(h.categoryIds);
    if (got.size === want.size && [...got].every((g) => want.has(g))) exact++;
    for (const g of got) want.has(g) ? bump(tp, g) : bump(fp, g);
    for (const w of want) if (!got.has(w)) bump(fn, w);
  }
  const cats = new Set([...tp.keys(), ...fp.keys(), ...fn.keys()]);
  const perCategory = [...cats].map((c) => {
    const t = tp.get(c) ?? 0, f = fp.get(c) ?? 0, n = fn.get(c) ?? 0;
    const precision = t + f ? t / (t + f) : 0, recall = t + n ? t / (t + n) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { categoryId: c, precision, recall, f1, support: t + n };
  }).sort((a, b) => b.f1 - a.f1);
  return {
    overallAgreement: evaluated ? exact / evaluated : 0,
    perCategory,
    strongCategoryIds: perCategory.filter((c) => c.f1 >= 0.86 && c.support >= 5).map((c) => c.categoryId),
    evaluated, failures,
  };
}

"""Score blind-test predictions against the answer key.

Usage: python score_blindtest.py analysis/blindtest/predictions.json
"""

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

BASE = Path(__file__).parent / "analysis" / "blindtest"


def main(pred_path):
    key = json.loads((BASE / "key.json").read_text(encoding="utf-8"))
    preds = json.loads(Path(pred_path).read_text(encoding="utf-8"))
    if isinstance(preds, dict):
        preds = preds["predictions"]
    by_id = {p["threadId"]: p for p in preds}

    exact = 0
    jaccard_sum = 0.0
    conf_stats = defaultdict(lambda: [0, 0])  # conf -> [exact, total]
    cat_tp, cat_fp, cat_fn = Counter(), Counter(), Counter()
    misses = []

    for tid, truth in key.items():
        t = set(truth["categories"]) or {"other"}
        p = by_id.get(tid)
        pset = set(p["categories"]) if p else set()
        inter, union = len(t & pset), len(t | pset)
        jaccard_sum += inter / union if union else 1.0
        ok = t == pset
        exact += ok
        if p:
            conf_stats[p["confidence"]][0] += ok
            conf_stats[p["confidence"]][1] += 1
        for c in pset & t:
            cat_tp[c] += 1
        for c in pset - t:
            cat_fp[c] += 1
        for c in t - pset:
            cat_fn[c] += 1
        if not ok:
            misses.append({
                "threadId": tid, "truth": sorted(t), "pred": sorted(pset),
                "confidence": p["confidence"] if p else None,
                "rationale": (p or {}).get("rationale", ""),
            })

    n = len(key)
    print(f"threads: {n}   predictions: {len(by_id)}")
    print(f"exact set match: {exact}/{n} = {exact/n:.1%}")
    print(f"mean jaccard:    {jaccard_sum/n:.3f}")
    print("\nby confidence (exact-match rate):")
    for conf in ("high", "medium", "low"):
        e, t = conf_stats[conf]
        if t:
            print(f"  {conf:6s}: {e}/{t} = {e/t:.1%}")
    print("\nper category (P / R / F1 / support):")
    cats = sorted(set(cat_tp) | set(cat_fp) | set(cat_fn))
    for c in cats:
        tp, fp, fn = cat_tp[c], cat_fp[c], cat_fn[c]
        prec = tp / (tp + fp) if tp + fp else 0
        rec = tp / (tp + fn) if tp + fn else 0
        f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0
        print(f"  {c:28s} {prec:.2f} / {rec:.2f} / {f1:.2f}  (n={tp+fn})")
    (BASE / "misses.json").write_text(
        json.dumps(misses, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\n{len(misses)} misses written to {BASE / 'misses.json'}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else BASE / "predictions.json")

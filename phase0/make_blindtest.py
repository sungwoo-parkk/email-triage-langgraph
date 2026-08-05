"""Build a blind classification test from the held-out eval split.

Emits analysis/blindtest/batch-{0..3}.json (records WITHOUT labels or
outbound routing — only what the dispatcher sees on arrival) and key.json
(the hidden answer key). Eval-split threads only, so no overlap with the
samples the qualitative agents already read.
"""

import json
import random
import re
from collections import defaultdict
from pathlib import Path

BASE = Path(__file__).parent
DATA = BASE / "data" / "pro-inbox-extract"
OUT = BASE / "analysis" / "blindtest"
SEED = 20260805
PER_CATEGORY = 8
BATCHES = 4

# Target categories -> the raw queue labels that count as that category.
CATEGORIES = {
    "cancellation-request": ["4-CAN REQ"],
    "loss-run-request": ["7-Loss Run Req"],
    "wc-certificate": ["8-C-105.2"],
    "policy-document-request": ["3-KR/POLICY REQUEST"],
    "endorsement-request": ["2-NY/Endorsement", "3-Endorsement"],
    "recommendation-compliance": ["2-NY/Recommendation"],
    "billing-money": ["Billing"],
    "carrier-cancellation-notice": ["Cancelllation"],
    "carrier-docs-filing": ["3-KR/DOCS&NOTICE"],
    "usli-renewal-quote": ["6-RENEWAL QUOTE-USLI", "3-KR/USLI RENEWAL QUOTE"],
    "junk-no-action": [],  # disregard family, matched below
}


def cats_of(labels):
    out = set()
    for cat, raws in CATEGORIES.items():
        if any(l in labels for l in raws):
            out.add(cat)
    if any(l.lower().startswith("disregard") for l in labels):
        out.add("junk-no-action")
    return sorted(out)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    by_id = {}
    for f in sorted(DATA.glob("extract-*.json")):
        for r in json.loads(f.read_text(encoding="utf-8")):
            by_id[r["threadId"]] = r
    eval_ids = set(json.loads(
        (BASE / "analysis" / "evalset.json").read_text(encoding="utf-8"))["threadIds"])

    pools = defaultdict(list)
    for tid in eval_ids:
        r = by_id.get(tid)
        if not r or "error" in r:
            continue
        for c in cats_of(r.get("labels") or []):
            pools[c].append(r)

    rng = random.Random(SEED)
    chosen, seen = [], set()
    for cat, pool in sorted(pools.items()):
        rng.shuffle(pool)
        picked = 0
        for r in pool:
            if r["threadId"] in seen or picked >= PER_CATEGORY:
                continue
            seen.add(r["threadId"])
            chosen.append(r)
            picked += 1
    rng.shuffle(chosen)

    key = {}
    blind = []
    for r in chosen:
        key[r["threadId"]] = {
            "labels": r.get("labels") or [],
            "categories": cats_of(r.get("labels") or []),
        }
        blind.append({
            "threadId": r["threadId"],
            "from": r.get("from"),
            "subject": r.get("subject"),
            "listId": r.get("listIdHeader") or None,
            "attachments": r.get("attachments"),
            "body": re.sub(r"\s+", " ", (r.get("body") or ""))[:1200],
        })

    per = (len(blind) + BATCHES - 1) // BATCHES
    for i in range(BATCHES):
        batch = blind[i * per:(i + 1) * per]
        (OUT / f"batch-{i}.json").write_text(
            json.dumps(batch, indent=1, ensure_ascii=False), encoding="utf-8")
    (OUT / "key.json").write_text(
        json.dumps(key, indent=1, ensure_ascii=False), encoding="utf-8")
    from collections import Counter
    dist = Counter(c for v in key.values() for c in v["categories"])
    print(f"blind test: {len(blind)} threads in {BATCHES} batches; "
          f"category distribution: {dict(dist)}")


if __name__ == "__main__":
    main()

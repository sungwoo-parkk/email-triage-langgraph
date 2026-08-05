"""Phase 0 analysis of the pro@agency.example stratified extract.

Reads phase0/data/pro-inbox-extract/, dedupes by threadId (newest wins),
and emits:
  analysis/stats.json    - full machine-readable statistics
  analysis/report.md     - human-readable summary
  analysis/samples/*.json- per-label record samples for qualitative review
  analysis/evalset.json  - held-out eval thread ids (seeded, 15%)
"""

import json
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

DATA = Path(__file__).parent / "data" / "pro-inbox-extract"
OUT = Path(__file__).parent / "analysis"
SAMPLES = OUT / "samples"
EVAL_FRACTION = 0.15
SEED = 20260804

# True per-label thread totals from the live mailbox (diagnose2, 2026-08-04),
# for reweighting context next to sample counts.
TRUE_TOTALS = {
    "3-KR": 212582, "3-KR/DOCS&NOTICE": 175738, "2-NY": 147235,
    "*1-DONE/DONE-P4": 102166, "*1-DONE/1-DONE-P1": 85132,
    "disregard": 64616, "*1-DONE/DONE-P2": 60149, "DONE-P5": 48842,
    "6-RENEWAL QUOTE-USLI": 24884, "*1-DONE": 21998,
    "*1-DONE/DONE-P3": 21179, "4-CAN REQ": 12160, "7-Loss Run Req": 7945,
    "2-NY/Endorsement": 5544, "Billing": 5278, "Cancelllation": 4484,
    "DONE-P6": 3987, "*1-DONE/DONE-P4/S5": 3699,
    "disregard/confirmed done in EPIC": 3547, "*1-DONE/DONE-P4/S4": 3504,
    "DONE-P8": 3321, "DONE-P7": 3104, "2-NY/Recommendation": 2832,
    "3-KR/USLI RENEWAL QUOTE": 2379, "3-Endorsement": 1923,
    "3-KR/POLICY REQUEST": 1835, "*1-DONE/DONE-P4/S2": 1443,
    "*1-DONE/DONE-P4/S3": 1429, "8-C-105.2": 1276,
    "*1-DONE/DONE-P4/S1": 712, "DONE-P9": 220, "5-UW": 141,
    "Forward to EHA": 28, "Undelivered Email": 17, "P10-double check": 11,
    "Done - P11": 10, "P10 Done": 8, "ONLY UPDATE EPIC": 2,
    "STAFF-P12": 1, "Y": 1, "0- NY Pro Training": 0, "1- NY to F/up": 0,
}

ADDR_RE = re.compile(r"<([^>]+)>")
STOP = set("""re fw fwd fyi the a an and or of for to from in on at is are was
be with your you our we this that it as by please new has have""".split())


def addr(header: str) -> str:
    m = ADDR_RE.search(header or "")
    return (m.group(1) if m else (header or "")).strip().lower()


def domain(a: str) -> str:
    return a.rsplit("@", 1)[-1] if "@" in a else a


def family(label: str) -> str:
    low = label.lower()
    if low.startswith("disregard"):
        return "disregard"
    if "done" in low:
        return "done"
    return "queue"


def person_of(label: str) -> str:
    seg = label.split("/")[-1]
    seg = re.sub(r"(?i)\*?1?-?done\s*-?\s*", "", seg).strip(" -")
    return seg if seg else "(generic)"


def tokens(subject: str):
    for t in re.findall(r"[a-zA-Z][a-zA-Z0-9&.-]{2,}", (subject or "").lower()):
        if t not in STOP:
            yield t


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "unnamed"


def load_records():
    files = sorted(DATA.glob("extract-*.json"))
    if not files:
        sys.exit(f"no extract files under {DATA}")
    by_id = {}
    raw = 0
    for f in files:  # name-sorted: later files overwrite -> newest copy wins
        for rec in json.loads(f.read_text(encoding="utf-8")):
            raw += 1
            by_id[rec["threadId"]] = rec
    return list(by_id.values()), raw, len(files)


def main():
    OUT.mkdir(exist_ok=True)
    SAMPLES.mkdir(exist_ok=True)
    records, raw_count, n_files = load_records()
    errors = [r for r in records if "error" in r]
    recs = [r for r in records if "error" not in r]

    label_counts = Counter()
    fam_counts = Counter()
    queue_person = Counter()      # (queue label, person) co-occurrence
    per_label = defaultdict(lambda: {
        "senders": Counter(), "domains": Counter(), "listids": Counter(),
        "subj": Counter(), "attach_ext": Counter(), "fwd_targets": Counter(),
        "n": 0, "empty_body": 0, "msgcount": 0, "fwd_threads": 0,
    })
    domain_labels = defaultdict(Counter)   # sender domain -> queue labels
    sender_labels = defaultdict(Counter)   # exact sender -> queue labels
    listid_labels = defaultdict(Counter)   # list-id -> queue labels
    # label-SET signatures: threads often carry label pairs (e.g. 3-KR +
    # 3-KR/DOCS&NOTICE); routing consistency must be scored on the full set
    # or a perfectly deterministic sender shows up as two 0.5-purity rows.
    domain_sigs = defaultdict(Counter)
    sender_sigs = defaultdict(Counter)
    listid_sigs = defaultdict(Counter)
    windows = Counter()
    all_fwd_targets = Counter()

    for r in recs:
        labels = r.get("labels") or []
        qlabels = [l for l in labels if family(l) == "queue"] or ["(unlabeled)"] \
            if not labels else [l for l in labels if family(l) == "queue"]
        if not labels:
            qlabels = ["(unlabeled)"]
        elif not qlabels:
            qlabels = ["(done/disregard only)"]
        persons = sorted({person_of(l) for l in labels if family(l) == "done"})
        for l in labels:
            label_counts[l] += 1
            fam_counts[family(l)] += 1
        if not labels:
            fam_counts["unlabeled"] += 1

        a = addr(r.get("from", ""))
        dom = domain(a)
        lid = (r.get("listIdHeader") or "").strip()
        windows[(r.get("firstDate") or "?")[:7]] += 1

        fwd_targets = set()
        for ob in r.get("outbound", []):
            for t in re.split(r"[,;]", ob.get("to", "") or ""):
                ta = addr(t)
                if ta and ta not in ("pro@agency.example",):
                    fwd_targets.add(ta)
        for t in fwd_targets:
            all_fwd_targets[t] += 1

        for ql in qlabels:
            s = per_label[ql]
            s["n"] += 1
            s["senders"][a] += 1
            s["domains"][dom] += 1
            if lid:
                s["listids"][lid] += 1
            for tk in set(tokens(r.get("subject", ""))):
                s["subj"][tk] += 1
            for att in r.get("attachments", []):
                ext = att.rsplit(".", 1)[-1].lower() if "." in att else "(none)"
                s["attach_ext"][ext] += 1
            if not (r.get("body") or "").strip():
                s["empty_body"] += 1
            s["msgcount"] += r.get("messageCount", 0)
            if fwd_targets:
                s["fwd_threads"] += 1
                for t in fwd_targets:
                    s["fwd_targets"][t] += 1
            domain_labels[dom][ql] += 1
            sender_labels[a][ql] += 1
            if lid:
                listid_labels[lid][ql] += 1
            for p in persons:
                queue_person[(ql, p)] += 1

        sig = " + ".join(sorted(qlabels))
        domain_sigs[dom][sig] += 1
        sender_sigs[a][sig] += 1
        if lid:
            listid_sigs[lid][sig] += 1

    # -- deterministic rule candidates: high-purity keys ------------------
    def rule_candidates(key_labels, min_n):
        out = []
        for key, cnt in key_labels.items():
            n = sum(cnt.values())
            if n < min_n:
                continue
            top, topn = cnt.most_common(1)[0]
            out.append({
                "key": key, "n": n, "top_label": top,
                "purity": round(topn / n, 3),
                "distribution": dict(cnt.most_common(5)),
            })
        return sorted(out, key=lambda x: (-x["purity"], -x["n"]))

    rules = {
        "sender_domain": rule_candidates(domain_labels, 10),
        "sender_exact": rule_candidates(sender_labels, 5),
        "list_id": rule_candidates(listid_labels, 5),
        "sender_domain_labelset": rule_candidates(domain_sigs, 10),
        "sender_exact_labelset": rule_candidates(sender_sigs, 5),
        "list_id_labelset": rule_candidates(listid_sigs, 5),
    }

    # -- filter decoding: infer Label_N -> name by matching criteria ------
    filter_files = sorted(DATA.glob("filters-*.json"))
    filters_decoded = []
    if filter_files:
        filters = json.loads(filter_files[0].read_text(encoding="utf-8"))
        for f in filters:
            crit = f.get("criteria", {})
            cf = (crit.get("from") or "").lower()
            phrase = (crit.get("subject") or crit.get("query") or "").strip('"').lower()
            hits = Counter()
            for r in recs:
                if cf and cf not in addr(r.get("from", "")):
                    continue
                if phrase and phrase not in (r.get("subject", "") or "").lower() \
                        and phrase not in (r.get("body", "") or "").lower():
                    continue
                if not cf and not phrase:
                    continue
                for l in r.get("labels") or []:
                    hits[l] += 1
            filters_decoded.append({
                "criteria": crit,
                "adds": f.get("action", {}).get("addLabelIds", []),
                "matched_sample_threads": sum(hits.values()),
                "observed_labels": dict(hits.most_common(5)),
            })

    # -- eval set ---------------------------------------------------------
    rng = random.Random(SEED)
    eval_ids = sorted(
        r["threadId"] for r in recs if rng.random() < EVAL_FRACTION
    )
    (OUT / "evalset.json").write_text(json.dumps({
        "seed": SEED, "fraction": EVAL_FRACTION, "count": len(eval_ids),
        "threadIds": eval_ids,
    }, indent=1), encoding="utf-8")
    eval_set = set(eval_ids)

    # -- per-label samples for qualitative agent review (non-eval only) ---
    sample_index = {}
    for ql, s in per_label.items():
        pool = [r for r in recs
                if r["threadId"] not in eval_set
                and (ql in (r.get("labels") or [])
                     or (ql == "(unlabeled)" and not r.get("labels"))
                     or (ql == "(done/disregard only)" and r.get("labels")
                         and not [l for l in r["labels"] if family(l) == "queue"]))]
        rng2 = random.Random(SEED + hash(ql) % 10000)
        rng2.shuffle(pool)
        picked = [{
            "subject": r.get("subject"), "from": r.get("from"),
            "listId": r.get("listIdHeader") or None,
            "attachments": r.get("attachments"),
            "labels": r.get("labels"),
            "outboundTo": [ob.get("to") for ob in r.get("outbound", [])][:3],
            "body": (r.get("body") or "")[:600],
        } for r in pool[:25]]
        fn = f"{slug(ql)}.json"
        (SAMPLES / fn).write_text(
            json.dumps(picked, indent=1, ensure_ascii=False), encoding="utf-8")
        sample_index[ql] = {"file": fn, "sampled": len(picked), "in_sample_total": s["n"]}

    # -- assemble stats ---------------------------------------------------
    def top(c, n=15):
        return dict(Counter(c).most_common(n))

    stats = {
        "raw_records": raw_count, "files": n_files,
        "unique_threads": len(records), "error_stubs": len(errors),
        "usable": len(recs),
        "family_counts": dict(fam_counts),
        "sample_label_counts": dict(label_counts.most_common()),
        "true_label_totals": TRUE_TOTALS,
        "month_coverage": dict(sorted(windows.items())),
        "queue_person_pairs": [
            {"queue": q, "person": p, "n": n}
            for (q, p), n in queue_person.most_common(60)
        ],
        "forward_targets_overall": top(all_fwd_targets, 25),
        "per_label": {
            ql: {
                "n": s["n"],
                "top_domains": top(s["domains"]),
                "top_senders": top(s["senders"], 10),
                "top_listids": top(s["listids"], 8),
                "top_subject_tokens": top(s["subj"], 20),
                "attach_ext": top(s["attach_ext"], 8),
                "empty_body_rate": round(s["empty_body"] / s["n"], 3) if s["n"] else 0,
                "avg_messages": round(s["msgcount"] / s["n"], 2) if s["n"] else 0,
                "forwarded_share": round(s["fwd_threads"] / s["n"], 3) if s["n"] else 0,
                "top_forward_targets": top(s["fwd_targets"], 8),
            } for ql, s in sorted(per_label.items(), key=lambda kv: -kv[1]["n"])
        },
        "rule_candidates": rules,
        "filters_decoded": filters_decoded,
        "eval_set_size": len(eval_ids),
        "samples": sample_index,
    }
    (OUT / "stats.json").write_text(
        json.dumps(stats, indent=1, ensure_ascii=False), encoding="utf-8")

    # -- report -----------------------------------------------------------
    L = []
    L.append("# Phase 0 analysis — pro@agency.example sample\n")
    L.append(f"- Records: {raw_count} raw -> {len(records)} unique threads "
             f"({len(errors)} error stubs) across {n_files} files")
    L.append(f"- Families: {dict(fam_counts)}")
    L.append(f"- Eval set held out: {len(eval_ids)} threads (seed {SEED})\n")
    L.append("## Queue labels in sample (n / true mailbox total)")
    for ql, s in sorted(per_label.items(), key=lambda kv: -kv[1]["n"]):
        L.append(f"- {ql}: {s['n']} sampled / {TRUE_TOTALS.get(ql, '?')} true")
    L.append("\n## Top rule candidates by LABEL-SET (sender domain, n>=10)")
    for rc in rules["sender_domain_labelset"][:30]:
        L.append(f"- {rc['key']} -> {rc['top_label']} "
                 f"(purity {rc['purity']}, n={rc['n']})")
    L.append("\n## Exact-sender label-set rules (n>=5, purity>=0.8)")
    for rc in rules["sender_exact_labelset"]:
        if rc["purity"] >= 0.8:
            L.append(f"- {rc['key']} -> {rc['top_label']} "
                     f"(purity {rc['purity']}, n={rc['n']})")
    L.append("\n## Top high-purity rule candidates (sender domain, n>=10)")
    for rc in rules["sender_domain"][:25]:
        L.append(f"- {rc['key']} -> {rc['top_label']} "
                 f"(purity {rc['purity']}, n={rc['n']})")
    L.append("\n## List-Id rule candidates (n>=5)")
    for rc in rules["list_id"][:15]:
        L.append(f"- {rc['key']} -> {rc['top_label']} "
                 f"(purity {rc['purity']}, n={rc['n']})")
    L.append("\n## Queue -> person (top pairs)")
    for row in stats["queue_person_pairs"][:25]:
        L.append(f"- {row['queue']} -> {row['person']}: {row['n']}")
    L.append("\n## Forward targets (overall)")
    for t, n in stats["forward_targets_overall"].items():
        L.append(f"- {t}: {n}")
    L.append("\n## Filters decoded (criteria -> observed labels in sample)")
    for fd in filters_decoded:
        L.append(f"- {json.dumps(fd['criteria'], ensure_ascii=False)} "
                 f"=> adds {fd['adds']} | observed {fd['observed_labels']}")
    L.append("\n## Month coverage")
    L.append(", ".join(f"{m}:{n}" for m, n in sorted(windows.items())))
    (OUT / "report.md").write_text("\n".join(L), encoding="utf-8")

    print(f"unique={len(records)} usable={len(recs)} stubs={len(errors)} "
          f"labels={len(label_counts)} eval={len(eval_ids)}")
    print(f"wrote {OUT / 'stats.json'}, report.md, evalset.json, "
          f"{len(sample_index)} sample files")


if __name__ == "__main__":
    main()

# Evaluation & observability

How classifier quality is measured across model versions and prompt changes. Companion to [architecture.md](architecture.md); run infrastructure lives in [`evals/`](../evals/).

## Two datasets, two roles

| Dataset | Where | Role |
|---|---|---|
| **88-thread blind test** (real mail) | `phase0/analysis/` — PII, gitignored, local only | The real-world promotion gate (≥76.8% exact-set match; spec §7) |
| **67-email golden set** (synthetic, fictional) | [`evals/dataset.json`](../evals/dataset.json) — committed, public | Regression + quality tracking; runnable by anyone with keys |

The golden set covers all major categories plus the hard cases: multi-request emails, review-only categories, junk, a bounce, and near-miss traps (a *reinstatement* notice that must NOT be classified as a cancellation; an *endorsement copy request* that is a document request, not an endorsement).

## Metrics

Runs execute as **LangSmith experiments** (`npm run eval`), so every model/prompt version is a side-by-side comparison with per-example drill-down and traces.

| Metric | Type | What it measures | Baseline (gemini-3.6-flash, 2026-08-07) |
|---|---|---|---|
| `exact_set_match` | code | Predicted label set == golden (after structural normalization; USLI label pair canonicalized) | **91.0%** |
| `task_count_match` | code | Multi-request emails split into the right number of tasks | **100%** |
| `forward_match` | code | Desk-alias forwarding conventions | **100%** |
| `co_emit_compliance` | code | Model itself co-emits `3-KR/DOCS&NOTICE` with `Cancelllation` (checked pre-patch) | **100%** |
| `latency_s` | code | End-to-end classify latency | **2.63s mean** |
| `faithfulness` | LLM judge | Rationale grounded in the email — no fabricated details | **97.0%** |
| `instruction_following` | LLM judge | 4-point rubric: task splitting, companion labels, forward conventions, confidence honesty | **97.4%** |

Label hallucination is not a metric because it is structurally impossible: the zod enum locks output to the 42-label vocabulary. Once entity extraction lands (ADR-12), extraction hallucination becomes a *programmatic* metric (extracted policy number either appears in the source or it doesn't).

## Running

```bash
npm run eval                 # full 67-example experiment with judges (~$0.15)
npm run eval -- --limit 3    # smoke run
npm run eval -- --no-judges  # free: programmatic metrics only
npm run eval -- --sync       # re-upload evals/dataset.json to LangSmith first
```

Requires `LANGSMITH_API_KEY` + `GEMINI_API_KEY` in `.env`. `LANGSMITH_TRACING=true` also traces every run (node waterfall, tokens, cost) into the `email-triage` project. Experiments are named `<model>@<git-sha>` so the comparison view maps directly to commits. CI: the `eval` workflow is manual-dispatch (Actions → Eval → Run) to keep token spend deliberate.

**The merge rule (unchanged from the spec):** any change to the prompt, model, or thresholds re-runs the eval; no category regresses materially and the blind-test gate stays ≥76.8%.

## A worked lesson in judge calibration

The first run of the instruction-following judge scored 89.9% — and nearly every failure was the **judge being wrong**: given only a two-line rubric, it invented a plausible-sounding but false convention ("cancellation requests carry `3-KR/DOCS&NOTICE`" — that label belongs to *carrier* documents; broker cancel requests ride with `3-KR`). The faithfulness judge similarly flagged the classifier *describing its own routing decision* as an "unsupported claim."

Fix: the judges now receive the authoritative companion-label conventions table and explicit scope rules. Same classifier outputs, recalibrated judges: 89.9% → 97.4% and 86.6% → 97.0%. The residual failures are real. Moral: **an uncalibrated judge measures its own priors, not your system** — judge prompts need the same evidence-grounding discipline as the classifier prompt.

## Golden review status

Draft goldens were LLM-authored and are under owner review. The current 6 `exact_set_match` disagreements reduce to 3 open convention questions:

1. Does `2-NY/Endorsement` ride with bare `2-NY`? (4 of 6 disagreements; model omits it, draft goldens include it)
2. Does a broker's return-premium inquiry carry `2-NY` alongside `Billing`? (1)
3. Is a *pending cancellation for inspection non-compliance* a `Cancelllation` notice or `2-NY/Recommendation` enforcement? (1 — genuinely ambiguous even for humans)

Resolutions get encoded into `evals/dataset.json` (and, where the model is right, into the taxonomy prompt), then `npm run eval -- --sync`.

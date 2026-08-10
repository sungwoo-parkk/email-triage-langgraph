# Evaluation & observability

How classifier quality is measured across model versions and prompt changes. Companion to
[architecture.md](architecture.md); run infrastructure lives in [`evals/`](../evals/). This
harness is office-config-driven — any office can run it against its own config once it has
mined history — but the numbers below are the case study's ([`docs/case-study/`](case-study/README.md)):
`npm run eval` targets [`examples/agency/triage.config.json`](../examples/agency/triage.config.json),
the flagship example office, so every model/prompt change is measured against a fixed,
committed dataset for regression tracking.

## Two datasets, two roles

| Dataset | Where | Role |
|---|---|---|
| **88-thread blind test** (real mail) | `phase0/analysis/` — PII, gitignored, local only | The real-world promotion gate that shadow-moded the case study (≥76.8% exact-set match; [design-spec.md](case-study/design-spec.md) §7) |
| **67-email golden set** (synthetic, fictional) | [`evals/dataset.json`](../evals/dataset.json) — committed, public | Regression + quality tracking; runnable by anyone with keys |

The golden set covers all major categories plus the hard cases: multi-request emails, review-only categories, junk, a bounce, and near-miss traps (a *reinstatement* notice that must NOT be classified as a cancellation; an *endorsement copy request* that is a document request, not an endorsement). Its labels are still written in AGY's original 42-label Gmail vocabulary (a frozen historical record — see [`docs/case-study/`](case-study/README.md)); `evals/run.ts` translates them to `examples/agency/triage.config.json`'s category ids at upload time (its `LABEL_TO_CATEGORY` table) so the harness grades the classifier's actual current output shape.

## Metrics

Runs execute as **LangSmith experiments** (`npm run eval`), so every model/prompt version is a side-by-side comparison with per-example drill-down and traces.

| Metric | Type | What it measures | Baseline (gemini-3.6-flash, 2026-08-07) |
|---|---|---|---|
| `exact_set_match` | code | Predicted category-id set == golden's (both sides in `examples/agency/triage.config.json`'s category-id space) | **91.0%** |
| `task_count_match` | code | Multi-request emails split into the right number of tasks | **100%** |
| `forward_match` | code | Desk routing derived from each side's categories via the config's `route` field | **100%** |
| `latency_s` | code | End-to-end classify latency | **2.63s mean** |
| `faithfulness` | LLM judge | Rationale grounded in the email — no fabricated details | **97.0%** |
| `instruction_following` | LLM judge | 4-point rubric: task splitting, companion labels, forward conventions, confidence honesty | **97.4%** |

These are the last full measurements taken under the historical label-shaped harness (2026-08-07, pre-translation); a `--sync` run re-uploads the translated dataset and re-measures on the identical model/prompt, so the numbers are expected to hold — the translation changes only how both sides are compared, not what the classifier predicts. Re-verified narrowly (3-example smoke run, `--no-judges`) as part of this translation: `exact_set_match`/`forward_match`/`task_count_match` all 100% on that subset.

Label hallucination is not a metric because it is structurally impossible: the zod enum is built from the office config at runtime and locks output to its category vocabulary (14 categories + `junk` for this example office). Once entity extraction lands (ADR-12), extraction hallucination becomes a *programmatic* metric (extracted policy number either appears in the source or it doesn't).

## Model selection (Gemini tiers)

Same dataset, same judges (pinned to `GEMINI_JUDGE_MODEL`), same prompt — only the tier
under test changes, so row differences are attributable to the model alone. The production
choice stays evidence-based: the baseline tier must justify its cost/latency against its
siblings on the identical golden set. Regenerate with `npm run eval-matrix` (sequential,
fail-closed: the table is only rewritten when the baseline row succeeds).

Tiers compared: `gemini-3.5-flash-lite`, `gemini-3.6-flash` (the production baseline), and `gemini-3.1-pro-preview` — the current lite/flash/pro siblings verified against the models API.

<!-- eval-matrix:start -->
_Not yet generated — run `npm run eval-matrix`._
<!-- eval-matrix:end -->

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

## Golden review status (historical)

The open convention questions this section used to track (e.g. "does `2-NY/Endorsement`
ride with bare `2-NY`?") were about Gmail's *label-bucketing* convention — a specific label
plus a companion "bucket" label filed alongside it for folder nesting, never a second work
item. The office-config category-id taxonomy has no bucket-label concept at all: a task is
exactly one category id, full stop. `evals/run.ts`'s translation table resolves the
bucketing mechanically (drops the bucket, keeps the specific id — see its `translateTask`)
rather than through further owner review, so this class of disagreement can no longer
recur. Genuinely ambiguous *content* questions (e.g. a borderline cancellation-vs-recommendation
case) remain owner-reviewable the normal way: edit `evals/dataset.json`, then `npm run eval -- --sync`.

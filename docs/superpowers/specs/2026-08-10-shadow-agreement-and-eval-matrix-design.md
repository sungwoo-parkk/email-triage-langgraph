# Shadow-agreement measurement + Gemini-tier eval matrix — design

**Date:** 2026-08-10
**Status:** approved (brainstorming session, this date)
**Builds on:** `docs/case-study/design-spec.md` §4–5 (the promised `v_agreement` / `v_category_stats` views and the ≥85% shadow gate), `docs/superpowers/specs/2026-08-07-small-office-triage-design.md` §Stages.

## 1. Goal

Two features, one theme: replace claims with measurements.

1. **Shadow-agreement measurement** — implement the shadow→assisted promotion gate
   (≥85% exact label-set agreement on high-confidence decisions, sustained two weeks)
   as a measured, enforced, auditable mechanism instead of a documented intention.
2. **Gemini-tier eval matrix** — run the existing 67-example golden set across Gemini
   model tiers and commit a reproducible accuracy/latency/cost comparison table to docs.

Scope decisions fixed during brainstorming:

- **Build now, reconnect later.** The live mailbox connection stays retired; everything
  here is validated on fixtures and integration tests. No OAuth or deploy work.
- **Gemini only.** The matrix compares tiers within Gemini (the only provisioned key).
  Cross-vendor rows are out of scope; the BYO-LLM abstraction remains a config-surface
  claim, not a measured one.
- **Enforced gate.** `triage promote` refuses shadow→assisted without evidence;
  `--force` overrides with a logged reason.

## 2. Feature 1: shadow-agreement measurement

### 2.1 The defect being fixed

`triage status` currently proxies agreement as `1 − corrections/decisions`. The proxy
is structurally flattering: `observer.ts` records only *disagreements* (corrections),
so every thread no human ever forwarded silently counts as agreement. The proxy is also
not exact-set, not scoped to high-confidence decisions, and has no sustained-window
logic. The spec'd views (`v_agreement`, `v_category_stats`) were never built.

**Honest-denominator rule (core semantic):** agreement is computed only over decisions
with at least one observed human outcome. Untouched threads are reported as *unmeasured
volume*, never as agreement.

### 2.2 Schema — migration `005_agreement.sql`

```sql
create table if not exists observations (
  id          bigint generated always as identity primary key,
  thread_id   text not null,
  decision_id bigint not null references decisions(id),
  category_id text not null,
  source      text not null default 'sent-forward',
  observed_at timestamptz not null default now(),
  unique (decision_id, category_id)
);
create index if not exists observations_decision_idx on observations(decision_id);
```

- **`v_agreement`** — one row per decision having ≥1 observation: decision id,
  `created_at`, `confidence`, predicted category set (distinct `categoryId`s from
  `final_tasks`), observed category set (distinct `category_id`s from `observations`),
  and `agreed` = exact set equality (sorted-array comparison). Read-time computation is
  deliberate: a late-arriving second forward on a multi-request thread flips `agreed`
  on the next read — no reconciliation job exists or is needed.
- **`v_category_stats`** — per category: predicted count, observed count, match count
  over measured decisions (per-category precision/recall to justify `autoActLabels`
  with evidence).

`corrections` and the learned-rule promotion loop are untouched: corrections stay the
*learning* signal; observations are the *measurement* signal. A human forward typically
produces a row in both.

### 2.3 Observer change — `src/lib/observer.ts`

Inside the existing `detectForwards` loop, insert into `observations`
(`on conflict do nothing`) for **every** matched forward, before the early-`continue`
that currently discards agreements. The existing `TRIAGE_MARKER` filter already
excludes system-sent forwards, so self-observation is impossible by construction.
No other observer behavior changes.

### 2.4 Gate logic — `src/lib/agreement.ts` (new)

- `agreementWindow(db, sinceMs, untilMs)` → `{ n, agreed, rate }` over decisions with
  `confidence = 'high'` (the `classify.ts` enum value) created in the window and
  present in `v_agreement`.
- `gateEvidence(db, nowMs)` → evaluates the two independent trailing 7-day windows
  `[now−14d, now−7d)` and `[now−7d, now]`. **Gate met ⇔ both windows have `n ≥ 25`
  and `rate ≥ 0.85`.** That is the operational meaning of "sustained two weeks."
  Returns a structured evidence object: per-window `{n, agreed, rate}`, overall 14-day
  rate, unmeasured-decision count, and the met/not-met verdict — the single source all
  three consumers render.

Constants (`MIN_WINDOW_N = 25`, `GATE_RATE = 0.85`) live in `agreement.ts`; `status.ts`
re-exports/consumes them rather than duplicating (it currently hardcodes `0.85`).

### 2.5 CLI + digest wiring

- **`triage promote`** (shadow→assisted only): print the evidence table; refuse when
  the gate is not met. `--force` prompts for a reason (via the existing `confirm`
  machinery) and writes `{at, from, to, reason, evidence}` to `app_config` under
  `promotion_override` before promoting — the audit trail survives the override.
  The assisted→autonomous gate (correction-rate <5%) is **out of scope**; current
  confirm-only behavior stands.
- **`triage status`**: the shadow-stage block drops the proxy and renders real
  evidence: per-window rate and sample size, MET/NOT MET per window, unmeasured
  volume. The assisted-stage correction-rate display is unchanged.
- **Digest**: while in shadow, one added line with the current 14-day evidence summary.
- **Docs**: `docs/architecture.md`'s observer description gains the observations table
  (measurement signal vs. corrections' learning signal); `docs/operations.md`'s stage
  section notes that shadow→assisted promotion is now evidence-gated with an audited
  `--force` override.

### 2.6 Error handling

- Observer DB failures already propagate to the caller's existing error path; the
  observation insert adds no new failure mode (`on conflict do nothing` absorbs dupes).
- `gateEvidence` with zero measured decisions returns `n = 0` windows and a not-met
  verdict — `status` renders "not enough data," `promote` refuses with that message.
- Views are plain SQL over existing tables; migration runs identically on Postgres and
  PGlite (the test runtime).

### 2.7 Testing

- `observer.test.ts` (extend): agreements now recorded as observations; disagreements
  still produce corrections; `TRIAGE_MARKER` exclusion holds; repeat observation
  dedupes.
- `agreement.test.ts` (new): exact-set semantics — multi-task thread where the second
  forward arrives later flips `agreed`; observed-subset-of-predicted ≠ agreement;
  window boundary math; min-sample and both-windows-sustained logic.
- Promote tests (extend `cli.test.ts`): refusal below gate; `--force` writes the
  audit record and promotes; single-step map unchanged.
- Integration (extend the clone-to-shadow proof): simulate a two-week shadow period
  through the fake mail client — decisions accumulate, human forwards observed in both
  windows, gate flips to met, `promote` succeeds.

All tests run on PGlite with zero credentials, per the suite's existing convention.

## 3. Feature 2: Gemini-tier eval matrix

### 3.1 Harness changes — `evals/run.ts`

- Refactor the body into an exported `runEval({ model?, limit?, judges, sync })`;
  the existing CLI becomes a thin wrapper.
- `--model <id>` overrides `cfg.llm.model` (all Gemini tiers share `GEMINI_API_KEY`,
  so `apiKeyEnv` is unchanged).
- `--json <path>` writes `{ model, promptVersion, metrics: { key: { mean, n } } }`.
- Judges stay pinned to `GEMINI_JUDGE_MODEL` (default `gemini-3.6-flash`) regardless
  of the model under test — judge bias constant across matrix rows.

### 3.2 Token usage for the cost column — `src/lib/classify.ts`

The classifier surfaces the underlying model response's `usage_metadata`
(input/output tokens) alongside its parsed output. The eval target aggregates mean
tokens/email per tier. If a tier's response lacks usage metadata, its cost cell renders
"—", never an estimate.

### 3.3 Matrix runner — `evals/matrix.ts`, `npm run eval-matrix`

- Tiers: flash-lite, flash (the production baseline), pro. Exact model ids are
  confirmed against the models API at implementation time, not hardcoded from memory.
- Runs sequentially (rate-limit friendly), full 67 examples, judges on.
- Regenerates a markdown table between `<!-- eval-matrix:start -->` /
  `<!-- eval-matrix:end -->` markers in `docs/evals.md`. Columns: exact-set match,
  task-split, forward-convention, faithfulness, instruction-following, mean latency,
  estimated cost per 1,000 emails.
- Cost = measured mean tokens/email × a static price map in `matrix.ts`, labeled with
  its as-of date in the generated table's footnote.
- A failed tier run (quota, rate limit) marks its row failed, remaining tiers still
  run, process exits non-zero, and the committed table is only rewritten if at least
  the baseline row succeeded.

### 3.4 Docs artifact

- `docs/evals.md` gains a **Model selection** section: the generated table plus a
  three-sentence method note (same dataset, same judges, same prompt; what trade-off
  was decided and why).
- README's Evidence table gets one pointer row to that section.
- **The 77.3% blind-test figure is never touched.** All new numbers are labeled as
  golden-set results (synthetic, LangSmith) so resume, repo, and interview stay
  consistent.

### 3.5 Testing

- Table renderer and cost math are pure functions with unit tests.
- Marker-replacement logic tested against a fixture doc (idempotent regeneration;
  content outside markers untouched).
- Live matrix runs require `GEMINI_API_KEY` and are excluded from CI, matching
  `npm run eval`'s existing convention.

## 4. Out of scope

- Gmail OAuth / deployment / live shadow-run operation (build now, reconnect later).
- The assisted→autonomous promotion gate.
- Cross-vendor eval rows (Anthropic, OpenAI, Groq, Ollama).
- Reading human-applied *labels* as a second ground-truth source — forwards only;
  labels do not exist in the generic office model.
- Any change to blind-test methodology or numbers.

## 5. Success criteria

1. `npm test` passes with the new suites; the integration proof demonstrates
   fixture-driven gate-met promotion end to end, zero credentials.
2. `triage status` in shadow renders measured evidence (no proxy); `triage promote`
   refuses without evidence and audits `--force`.
3. `npm run eval-matrix` regenerates the docs table in one command from a clean
   checkout with only `GEMINI_API_KEY` and `LANGSMITH_API_KEY` set.
4. Docs updated: evals.md model-selection section, README pointer row, and the
   architecture/operations pages mention the observations table where they describe
   the observer.

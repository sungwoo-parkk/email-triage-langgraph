# Engineer onboarding

Goal: productive in under an hour. Architecture context: [architecture.md](architecture.md). House rules are at the bottom — read them before your first PR.

## Setup (5 minutes)

```bash
git clone <repo> && cd test
npm install
npm test                       # all tests pass with NO credentials — DB is in-memory PGlite
npm run demo                   # the real pipeline against the example office, offline
npm run triage -- init --dry-run   # the onboarding CLI against examples/hartley/, offline
```

That's the whole dev loop for most changes. Credentials are only needed to touch a live LLM/Gmail:

```bash
cp .env.example .env
# GEMINI_API_KEY     → Google AI key (ask the owner) — enables probe-gemini, eval-blindtest,
#                       the case-study `npm run eval` (or any office's own LLM key — see
#                       examples/*/triage.config.json's llm.apiKeyEnv)
# GOOGLE_OAUTH_*     → see operations.md; enables probe-gmail. Most dev work never needs this.
```

Scripts auto-load `.env` (via node `--env-file`) — no manual exporting.

## The 90-second tour

Read in this order; each module is small and single-purpose:

1. `src/lib/officeConfig.ts` — `triage.config.json`'s schema and the `Vocabulary` every other module derives from it (category ids, labels, routing, the vocabulary-lock check). Start here: nothing office-specific is compiled in anywhere else.
2. `src/lib/normalize.ts` — the `NormalizedEmail` shape every other module consumes.
3. `src/lib/rules.ts` — deterministic matching against the `rules` table.
4. `src/lib/classify.ts` + `promptgen.ts` — the LLM call; the zod output schema (built from the office's config) IS the safety boundary.
5. `src/lib/decide.ts` — the gate: confidence + `autoActLabels` allow-list → `decided` or `needs_review`.
6. `src/lib/act.ts` — stage gating + per-action idempotency.
7. `src/graph/triage.ts` — wires the above into the LangGraph; topology enforces record-before-act.
8. `src/lib/ingest.ts` — checkpointing, dedupe, poison-thread handling (the subtlest file; the comment at the top explains it).
9. `src/lib/mining.ts` + `src/cli/steps/mine.ts` — the onboarding pipeline: mines an office's own mail history into rules, exemplars, and a per-office eval (`npm run triage -- init --dry-run` runs this offline against `examples/hartley/`).

Tests mirror modules (`tests/<module>.test.ts`) and are the best usage examples. They inject fakes for Gmail (`makeGmail(api?)`), the classifier model, and the DB (`setDb` + PGlite) — no network, no mocks-of-mocks.

## Common tasks

**Add a deterministic rule** — it's data, not code. See "Rules maintenance" in [operations.md](operations.md). A durable pattern worth version control belongs in the mining thresholds (`THRESHOLDS` in `src/lib/mining.ts`) or `examples/*/history.json`, not hand-inserted.

**Change the prompt template or a config's model** — a `promptgen.ts` change affects every office; edit it, then you MUST re-run the case-study eval before merge (it's the one committed, reproducible regression check):

```bash
npm run eval -- --sync            # LangSmith golden set (examples/agency/triage.config.json)
npm run eval-blindtest            # local: re-scores the frozen 88-thread phase-0 blind test
```

Gate (case study): golden exact-set stays ≥ current baseline, no category F1 drops materially, blind-test exact-set ≥ 76.8% (`docs/case-study/design-spec.md` §7). Record new numbers in `docs/evals.md` / `docs/case-study/`. If you're changing a single *office's* model choice instead (its `llm.model` in `triage.config.json`), that office re-runs its own onboarding eval (`npm run triage -- init --dry-run` locally, or `reconfigure` once it exists) rather than the case study's.

**Add a schema change** — new numbered file in `migrations/` (forward-only, idempotent `create … if not exists` style). `runMigrations` applies in filename order; tests get it via PGlite automatically.

**Touch anything in `src/lib/mail/gmail.ts`** — pure builders (`buildQuery`, `buildForwardRaw`) have unit tests; API behavior is validated by `npm run probe-gmail` (live). Run the probe before trusting any Gmail change — that's a hard rule here.

## House rules (violating these breaks production or trust)

1. **Vocabulary is locked once written.** Renaming or removing a category/routee id is an explicit migration, never a silent edit — `assertVocabularyCompatible` (`src/lib/officeConfig.ts`) enforces it; `tests/officeConfig.test.ts` covers it. The case study's `Cancelllation` misspelling is the canonical example of why: it's the dispatchers' real vocabulary, preserved verbatim as a category id, not "fixed."
2. **Completion/lifecycle disposition is always human.** The category vocabulary has no "done" concept to emit — this system only classifies and routes; a human always closes the loop in their own inbox.
3. **Record before act.** No code path may touch Gmail before the decision row exists. The graph enforces this; don't add a shortcut.
4. **Fail toward humans.** A caught error routes to `needs_review` or a visible `failed` status — never a silent catch, never a guessed action.
5. **Forwards go only to a routee's configured address or the review recipient** — never a person-typed address, never outside the office's own config. The runtime zod enum (built from the office's config) is the enforcement point.
6. **`phase0/data/` and `phase0/analysis/` contain insured PII.** Gitignored — never commit, never paste into issues/PRs/LLM prompts outside this repo's tooling.
7. **Idempotency is load-bearing** in `act.ts` and `ingest.ts`. If you change retry or checkpoint logic, re-read the header comment in `ingest.ts` and keep the "duplicates over holes" property.
8. **Live probes before unattended operation** — after any change to a Gmail/provider or LLM integration path, run the relevant probe. Four careful code reviews once missed what one probe caught.

## Glossary

| Term | Meaning |
|---|---|
| Routee | A person/desk in an office's config; every routee is automatically a category (forward with context) |
| Category | A unit of the classifier's output vocabulary — one routee, or an office-defined work type (e.g. AGY's `carrier-docs`) |
| Category id | The stable, config-defined identifier for a category (e.g. `jo`, `carrier-docs`); what the classifier actually emits |
| Gold / silver label | Onboarding ground truth tiers — gold: observed from the office's own sent-mail forwards; silver: LLM-labeled sample of the remainder (`src/lib/mining.ts`) |
| Complete rule hit | Rule outcome that fully resolves a thread — skips the LLM |
| `autoActLabels` | Per-category allow-list (category ids); anything outside it always goes to review |
| Stage | `shadow` / `assisted` / `autonomous` — what `act` may do |
| Poison thread | Thread that crashed the graph 3× and was stubbed as `failed` |
| Queue label (case study only) | AGY's original Gmail label encoding work type + owning team (e.g. `3-KR/DOCS&NOTICE`), preserved as `examples/agency/triage.config.json`'s category ids |
| NHO / DP / CP (case study only) | AGY's book-of-business codes: NHO homeowners → NY desk; DP/CP commercial → KR |

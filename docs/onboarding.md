# Engineer onboarding

Goal: productive in under an hour. Architecture context: [architecture.md](architecture.md). House rules are at the bottom — read them before your first PR.

## Setup (5 minutes)

```bash
git clone <repo> && cd test
npm install
npm test          # 67 tests should pass with NO credentials — DB is in-memory PGlite
```

That's the whole dev loop for most changes. Credentials are only needed to touch live Gmail/Gemini:

```bash
cp .env.example .env
# GEMINI_API_KEY     → Google AI key (ask the owner) — enables probe-gemini, eval-blindtest
# GOOGLE_OAUTH_*     → see operations.md; enables probe-gmail. Most dev work never needs this.
```

Scripts auto-load `.env` (via node `--env-file`) — no manual exporting.

## The 90-second tour

Read in this order; each module is small and single-purpose:

1. `src/lib/normalize.ts` — the `NormalizedEmail` shape every other module consumes.
2. `src/lib/rules.ts` — deterministic matching; note `applyStructuralRules`.
3. `src/lib/classify.ts` + `prompt.ts` — the Gemini call; the zod schema IS the safety boundary.
4. `src/lib/decide.ts` — the gate: confidence + `autoActLabels` allow-list → `decided` or `needs_review`.
5. `src/lib/act.ts` — stage gating + per-action idempotency.
6. `src/graph/triage.ts` — wires the above into the LangGraph; topology enforces record-before-act.
7. `src/lib/ingest.ts` — checkpointing, dedupe, poison-thread handling (the subtlest file; the comment at the top explains it).

Tests mirror modules (`tests/<module>.test.ts`) and are the best usage examples. They inject fakes for Gmail (`makeGmail(api?)`), the classifier model, and the DB (`setDb` + PGlite) — no network, no mocks-of-mocks.

## Common tasks

**Add a deterministic rule** — it's data, not code. See "Rules maintenance" in [operations.md](operations.md). If it's a durable pattern worth version control, add it to the seed thresholds discussion instead of hand-inserting.

**Change the prompt or model** — edit `src/lib/prompt.ts` / `GEMINI_MODEL`, then you MUST re-run the eval before merge:

```bash
npm run eval-blindtest && cd phase0 && PYTHONIOENCODING=utf-8 python score_blindtest.py analysis/blindtest/predictions-gemini.json
```

Gate: exact-set ≥ 76.8%, no category F1 drops materially. Also: `scripts/eval-blindtest.ts` mirrors `CATEGORIES` from `phase0/make_blindtest.py` — keep them in sync.

**Add a schema change** — new numbered file in `migrations/` (forward-only, idempotent `create … if not exists` style). `runMigrations` applies in filename order; tests get it via PGlite automatically.

**Touch anything in `src/lib/gmail.ts`** — pure builders (`buildQuery`, `buildForwardRaw`) have unit tests; API behavior is validated by `npm run probe-gmail` (live). Run the probe before trusting any Gmail change — that's a hard rule here.

## House rules (violating these breaks production or trust)

1. **Never "fix" `Cancelllation`** or any label spelling. The vocabulary is the dispatchers' 42 labels verbatim; a test enforces it (`tests/labels.test.ts`).
2. **The classifier must never emit DONE-family labels.** Completion is human. The schema excludes them — keep it that way.
3. **Record before act.** No code path may touch Gmail before the decision row exists. The graph enforces this; don't add a shortcut.
4. **Fail toward humans.** A caught error routes to `needs_review` or a visible `failed` status — never a silent catch, never a guessed action.
5. **Forwards go to desk aliases only** (`invoice@`, `accounting@`, `express@agency.example`). The schema enum is the enforcement point.
6. **`phase0/data/` and `phase0/analysis/` contain insured PII.** Gitignored — never commit, never paste into issues/PRs/LLM prompts outside this repo's tooling.
7. **Idempotency is load-bearing** in `act.ts` and `ingest.ts`. If you change retry or checkpoint logic, re-read the header comment in `ingest.ts` and keep the "duplicates over holes" property.
8. **Live probes before unattended operation** — after any change to a Gmail or Gemini integration path, run the relevant probe. Four careful code reviews once missed what one probe caught.

## Glossary

| Term | Meaning |
|---|---|
| Queue label | A Gmail label encoding work type + owning team (e.g. `3-KR/DOCS&NOTICE`) |
| Desk alias | Shared mailbox for a function (`invoice@agency.example`), the only legal forward targets |
| Complete rule hit | Rule outcome that fully resolves a thread — skips the LLM |
| `autoActLabels` | Per-category allow-list; labels outside it always go to review |
| Stage | `shadow` / `assisted` / `autonomous` — what `act` may do |
| Poison thread | Thread that crashed the graph 3× and was stubbed as `failed` |
| NHO / DP / CP | Book-of-business codes: NHO homeowners → NY desk; DP/CP commercial → KR |

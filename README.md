# Email Triage — pro@agency.example

Automated classification and dispatch for AGY's operations intake mailbox. Every inbound thread is labeled with the dispatcher's existing 42-label Gmail vocabulary and, where the desk convention requires it, forwarded to the owning desk alias — with humans reviewing everything the system isn't sure about.

**Status (2026-08-07):** deployed to production at `agency-triage.vercel.app` (Neon Postgres, 36 rules seeded, OAuth live, first ingest verified: 7 threads, 0 failures, 0 Gmail writes). Gemini eval gate **passed** (77.3% raw ≥ 76.8%). One item pending before the shadow-mode clock starts: **cron scheduling** (Vercel Hobby allows only daily crons — upgrade to Pro or wire an external scheduler; until then, ingestion is manual-trigger only).

## Start here, by role

| You are | Read |
|---|---|
| Engineer joining the project | [docs/onboarding.md](docs/onboarding.md) |
| SWE / system designer reviewing the design | [docs/architecture.md](docs/architecture.md) |
| Operator on call (alerts, failures, stage changes) | [docs/operations.md](docs/operations.md) |
| PM / stakeholder (goals, rollout, metrics) | [docs/product.md](docs/product.md) |
| "Why is it built this way?" | [docs/decisions.md](docs/decisions.md) |

Deeper background: the approved design spec ([docs/superpowers/specs/2026-08-05-email-triage-design.md](docs/superpowers/specs/2026-08-05-email-triage-design.md)) and the implementation plan ([docs/superpowers/plans/2026-08-06-triage-core-service.md](docs/superpowers/plans/2026-08-06-triage-core-service.md)).

## Sixty-second overview

```
Gmail (pro@agency.example)
  │  cron poll, every 2 min
  ▼
ingest ──► LangGraph: rules ──► [classify (Gemini)] ──► decide ──► record (Postgres) ──► act (stage-gated)
                                                                        │                    │
                                                                needs_review ──► human       └─► Gmail labels + forwards
```

- **Rules first.** High-purity sender/subject rules (mined from a 6,875-thread study) fully resolve ~half the volume without an LLM call.
- **LLM for the residual.** Gemini 3.6 Flash emits schema-locked multi-label output — it cannot invent a label or emit a human-only `DONE` marker.
- **Audit before action.** Every decision is written to Postgres *before* any Gmail action executes. No un-audited writes are possible.
- **Fail toward humans.** Uncertainty, classifier failure, or weak-category output all route to the review queue. The staged rollout (shadow → assisted → autonomous) automates irreversible actions (forwards) last.

## Quickstart (dev)

```bash
npm install
npm test                 # 67 tests, in-memory Postgres (PGlite) — no credentials needed
cp .env.example .env     # then fill in what you have; see docs/onboarding.md
```

## Repo layout

```
src/graph/     LangGraph pipeline wiring
src/lib/       ingest, rules, classify, decide, act, gmail, config, labels, db
src/app/api/   cron endpoints (ingest, watchdog)
scripts/       one-time + operational scripts (authorize-gmail, probes, seeding, eval)
migrations/    SQL schema (system of record)
tests/         Vitest suite mirroring src modules
docs/          this documentation set + spec/plan
phase0/        mailbox study + eval data — contains insured PII, gitignored, never commit
```

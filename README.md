# Email Triage — an LLM dispatch pipeline for a real insurance inbox

![CI](https://github.com/sungwoo-parkk/email-triage-langgraph/actions/workflows/ci.yml/badge.svg)

An end-to-end email triage system built for a real insurance agency's intake mailbox (~4,700 threads/month): every inbound thread is classified into the dispatchers' existing 42-label Gmail vocabulary — by deterministic rules where possible, Gemini where not — and forwarded to the owning desk, with humans reviewing everything the system isn't sure about. Built with **LangGraph.js**, **Gemini structured output**, **Next.js on Vercel**, and **Neon Postgres**.

> Personal project. It ran against the real mailbox exactly once (7 threads, 0 failures, 0 Gmail writes — shadow mode) before the live connection was retired; the design, eval numbers, and phase-0 study are all real.

## Try it in 30 seconds — no API keys

```bash
npm install
npm run demo    # 9 synthetic insurance emails through the real pipeline, offline
npm test        # 67 tests on in-memory Postgres (PGlite)
```

The demo runs the actual graph, rules engine, decide gate, and act layer — it shows a rule hit skipping the LLM, the allow-list holding back a high-confidence `Billing` call, a two-request email producing two tasks, shadow mode making zero Gmail calls, and the idempotent act layer refusing to double-send on retry. Pass `-- --live` with `GEMINI_API_KEY` set to classify the same emails with real Gemini.

## What this demonstrates

- **LangGraph topology as a safety mechanism** — the graph edge ordering makes it structurally impossible to touch Gmail before the decision is written to Postgres, and impossible for a `needs_review` decision to act at all ([src/graph/triage.ts](src/graph/triage.ts)).
- **Schema-locked LLM output** — Gemini's response is constrained by a zod enum to the exact 42-label vocabulary (including a load-bearing misspelling); it cannot invent a label or emit a human-only completion marker ([src/lib/classify.ts](src/lib/classify.ts)).
- **Evidence-driven automation** — a 6,875-thread mailbox study seeded the rules engine (36 high-purity patterns absorb ~half the volume LLM-free), and an 88-thread blind test **gates** the model: measured 77.3% exact label-set match vs a 76.8% promotion gate, with per-category F1 deciding which categories may auto-act ([docs/decisions.md](docs/decisions.md)).
- **Fail-toward-humans design** — per-category allow-lists over model-stated confidence, retry-then-review on classifier failure, 3-strike poison-thread stubbing, duplicates-over-holes checkpointing, per-action idempotency, staged rollout with forwards automated last ([docs/architecture.md](docs/architecture.md)).
- **Zero-credential testability** — the entire pipeline runs against injected fakes and PGlite in-memory Postgres: 67 tests and the full demo need no keys, no Docker, no services.
- **Serverless production shape** — Vercel crons + Fluid compute, Neon via the Vercel Marketplace, per-mailbox OAuth (domain-wide delegation deliberately declined — [ADR-9](docs/decisions.md)).

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

# Inbox Triage

![CI](https://github.com/sungwoo-parkk/email-triage-langgraph/actions/workflows/ci.yml/badge.svg)

Self-hosted email triage for a small office's shared inbox (`info@`, `office@`, `support@`, …). Point it at your mailbox, answer a five-minute interview, and it mines your own mail history into deterministic rules and a personalized LLM classifier — then triages everything in **shadow mode** (records what it *would* do; zero mailbox writes) until a measured eval and a staged rollout earn it the right to act. No hosted service, no maintainer-operated infrastructure, no vendor lock: it runs on your own Vercel + Postgres + choice of LLM.

> Proven on a real 425,000-thread insurance-agency mailbox before generalizing into this product — 77.3% blind-test accuracy against real dispatcher decisions. See [Evidence](#evidence-the-case-study) below.

## Try it in 60 seconds — no API keys

```bash
git clone <repo> && cd <repo>
npm install
npm run triage -- init --dry-run   # the real onboarding pipeline, against a synthetic office
npm test                            # 125 tests, in-memory Postgres, zero credentials
npm run demo                        # the triage pipeline itself, end to end, offline
```

`init --dry-run` runs the actual onboarding pipeline — mine history, silver-label the residual, mine deterministic rules, build a prompt from your own exemplars, evaluate on a held-out slice — against [`examples/hartley/`](examples/hartley/), a synthetic small office (an office-furniture retailer) with three months of fixture mail. It opens a self-contained local HTML report: overall agreement, per-category strong/review-only split, the rules it mined, and a sample of what would have auto-routed. That's the same report a real office gets on day one, just pointed at fixtures instead of a live mailbox.

## What it does

1. **Reads your intake mailbox** the way a person would — sender, subject, attachments, body — and classifies every thread into *your* categories, generated from your config, not a fixed taxonomy.
2. **Learns your rules for free.** It mines your own sent-mail history for patterns you already forward the same way every time (a vendor, a newsletter, a repeat client) and turns them into deterministic rules that skip the LLM entirely — about half of real-world volume in the case study.
3. **Routes with context, not just a label** — a forward to the right desk/person with a plain-English rationale attached, or a review-forward to you when it isn't sure.
4. **Never acts blind.** Every decision is written to Postgres *before* any mailbox action executes; nothing auto-sends until the classifier's stated confidence, a per-category allow-list earned by measurement, and the current rollout stage all agree it should.
5. **Learns from your corrections, passively.** Forward a misrouted email the way you always have — no dashboard, no buttons — and the system observes it from your sent mail and promotes the pattern into a rule.

## Bring your own LLM

Any [`initChatModel`](https://js.langchain.com/docs/how_to/chat_models_universal_init/)-supported provider works — set `llm.model` in `triage.config.json` as `provider:model`, plus the matching key:

| Provider | `llm.model` example | API key env |
|---|---|---|
| Google Gemini | `google_genai:gemini-3.6-flash` | `GEMINI_API_KEY` |
| Anthropic | `anthropic:claude-sonnet-5` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai:gpt-5` | `OPENAI_API_KEY` |
| Mistral | `mistralai:mistral-large-latest` | `MISTRAL_API_KEY` |
| Groq | `groq:llama-3.3-70b-versatile` | `GROQ_API_KEY` |
| Ollama (local) | `ollama:llama3` | *(none — runs locally)* |

The onboarding interview asks for this once; the classifier's prompt and output schema are generated from your config at runtime — nothing is hardcoded to one vendor's taxonomy or model.

## Safety, in short

**Fail toward humans, never fail-open.** A runtime schema locks the classifier to *your* categories — it cannot invent one or route outside your config. Every decision is recorded before any action runs, so nothing un-audited is possible. Auto-action requires both stated high confidence *and* a per-category allow-list earned by measurement, not model self-report. Actions are idempotent — a retry can never double-send. And the riskiest capability, sending mail, is automated last, behind a staged rollout (shadow → assisted → autonomous) with a one-line kill switch. Full detail: [docs/architecture.md](docs/architecture.md).

## Start here, by role

| You are | Read |
|---|---|
| Engineer joining the project | [docs/onboarding.md](docs/onboarding.md) |
| SWE / system designer reviewing the design | [docs/architecture.md](docs/architecture.md) |
| Operator on call (alerts, failures, stage changes) | [docs/operations.md](docs/operations.md) |
| PM / stakeholder (goals, rollout, metrics) | [docs/product.md](docs/product.md) |
| "Why is it built this way?" | [docs/decisions.md](docs/decisions.md) |

Deeper background: the product spec ([`docs/superpowers/specs/2026-08-07-small-office-triage-design.md`](docs/superpowers/specs/2026-08-07-small-office-triage-design.md)) and the case-study spec + plan linked below.

## Evidence: the case study

This system was built once, for real, against a single real mailbox — `pro@agency.example`, an insurance agency's ~4,700-thread/month intake — before generalizing into the config-driven product above. That build is now the [case study](docs/case-study/README.md), and its example config (`examples/agency/triage.config.json`) is the flagship "hard case" — a 14-category, three-desk, real-world taxonomy any simpler office's config is a simplification of.

| Measurement | Result |
|---|---|
| Deterministic rules absorb, LLM-free | ~half of monthly volume |
| 88-thread blind test vs. real dispatcher decisions (`gemini-3.6-flash`) | **77.3%** exact label-set match — clears the 76.8% promotion gate, +10.3 points over the phase-0 baseline on the identical scorer |
| 67-example synthetic golden set (ongoing CI regression, LangSmith) | 91.0% exact-set match, 100% task-split accuracy, 100% forward-convention accuracy |
| LLM-judge quality checks | 97.0% faithfulness (no fabricated rationale), 97.4% instruction-following |
| One-time live shadow-mode run | 7/7 threads triaged, 0 failures, 0 mailbox writes |
| Gemini tier comparison (3.5-flash-lite / 3.6-flash / 3.1-pro-preview, identical golden set + pinned judges) | see [docs/evals.md → Model selection](docs/evals.md#model-selection-gemini-tiers) |

Full numbers and method: [docs/case-study/README.md](docs/case-study/README.md), [docs/evals.md](docs/evals.md), and the original [design spec](docs/case-study/design-spec.md) §7.

## Roadmap

| Milestone | Status | Contents |
|---|---|---|
| **M1** | **This repo, current** | Config-core pipeline, onboarding CLI end-to-end (Gmail), mining + per-office eval with the HTML report, email-native review + correction observer, daily digest |
| **M2** | Next | Microsoft 365 via Microsoft Graph — the same one-sitting onboarding flow, Entra device-code auth, behind the same `MailClient` contract tests Gmail already runs |
| **M3** | Evidence-driven | Polish from first external users: correction-loop tuning, docs hardening, revisit the UI question only if real usage shows a trigger (see the product spec §14) |

## Quickstart (dev)

```bash
npm install
npm test                 # in-memory Postgres (PGlite) — no credentials needed
cp .env.example .env     # then fill in what you have; see docs/onboarding.md
```

Zero-credential by design: the full pipeline, the mining/eval pipeline, and `npm run demo` all run against injected fakes and PGlite. Credentials are only needed to touch a live LLM or a live mailbox (`npm run probe-gemini`, `npm run probe-gmail`, `npm run eval`, or a real `triage init`).

## Repo layout

```
src/cli/       the `triage` CLI (init, status, promote, pause) — the onboarding pipeline
src/graph/     LangGraph pipeline wiring
src/lib/       officeConfig, mining, classify, decide, act, mail/ (Gmail + fake), db
src/app/api/   cron endpoints (ingest, watchdog, digest)
examples/      example office configs + mail-history fixtures (hartley/, agency/)
scripts/       one-time + operational scripts (authorize-gmail, probes, blind-test eval)
migrations/    SQL schema (system of record)
tests/         Vitest suite mirroring src modules
evals/         LangSmith eval harness + the committed golden dataset
docs/          this documentation set + case-study/, specs, and plans
phase0/        the case study's mailbox study + blind-test data — contains insured PII, gitignored, never commit
```

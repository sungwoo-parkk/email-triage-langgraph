# Case study: `pro@agency.example`

This product started as a single-tenant build for one real business: the intake mailbox of
AGY, an insurance agency (~4,700 threads/month, a NY front office plus a KR back-office
processing center). It proved the automation pattern — deterministic rules for the
patterned bulk, an LLM for the residual, staged trust with human review — against a real
425,000-thread mailbox before the project generalized into the config-driven, self-hosted
product this repo now ships. AGY's taxonomy became [`examples/agency/triage.config.json`](../../examples/agency/triage.config.json),
the flagship "hard case" example office: a 14-category, misspelled-label, three-desk
taxonomy that any simpler office's config is a simplification of.

It ran against the real mailbox exactly once — 7 threads, 0 failures, 0 Gmail writes
(shadow mode) — before the live connection was retired. The design, eval numbers, and
phase-0 study below are all real measurements, not illustrative figures.

## The phase-0 method

Before writing a line of pipeline code, a stratified sample of 6,875 threads from the
mailbox's history was pulled and analyzed: the existing 22 Gmail filters were decoded into
an explicit label taxonomy, per-label purity/support of sender and list-id patterns was
measured, and an 88-thread held-out blind test was built against dispatcher ground truth.
That study is what the product's onboarding pipeline (`triage init`) now does automatically
for any office, in minutes instead of a manual research pass — see
[`docs/superpowers/specs/2026-08-07-small-office-triage-design.md`](../superpowers/specs/2026-08-07-small-office-triage-design.md) §4.

## Measured numbers

| Measurement | Result |
|---|---|
| Deterministic rules absorb, LLM-free | ~half of monthly volume (36 high-purity sender/list patterns, purity ≥0.9) |
| 88-thread blind test, phase-0 baseline (Claude family, unadjusted scorer) | 67.0% exact label-set match (59/88) |
| 88-thread blind test, production model (`gemini-3.6-flash`, 2026-08-06) | **77.3% exact label-set match (68/88)** — clears the ≥76.8% promotion gate; +10.3 points over the Claude baseline on the identical scorer |
| Strong categories (F1 ≥ 0.86) eligible for auto-action at launch | 8 of 14 |
| 67-example synthetic golden set, LangSmith (ongoing regression suite) | 91.0% exact-set match, 100% task-split accuracy, 100% forward-convention accuracy, 97.0% faithfulness (judge), 97.4% instruction-following (judge) |
| One-time live shadow-mode run | 7/7 threads triaged, 0 failures, 0 Gmail writes |

Full detail: [design-spec.md](design-spec.md) §7 (the pre-launch blind test) and
[`docs/evals.md`](../evals.md) (the ongoing golden-set methodology and judge calibration
story — the same harness now runs against `examples/agency/triage.config.json` as this
product's CI regression check).

## What carried forward, what became configuration

The safety machinery — record-before-act graph topology, staged rollout, schema-locked
output, idempotent actions, poison-thread handling, duplicates-over-holes checkpointing, a
dead-man watchdog — is unchanged; see [`docs/architecture.md`](../architecture.md) and
[`docs/decisions.md`](../decisions.md) (the ADRs below still hold, now read as decisions
about the *pipeline*, not about AGY specifically). What was hardcoded became per-office
configuration: the 42-label vocabulary, the three desk aliases, and the Gemini-only model
choice are now `examples/agency/triage.config.json` — one example office among others (see
[`examples/hartley/`](../../examples/hartley/) for a small-office example built for this
generalization).

## Further reading

- [design-spec.md](design-spec.md) — the original approved design spec (moved here
  verbatim from `docs/superpowers/specs/2026-08-05-email-triage-design.md`).
- [`docs/superpowers/plans/2026-08-06-triage-core-service.md`](../superpowers/plans/2026-08-06-triage-core-service.md) —
  the implementation plan that built it, task by task.
- [`docs/superpowers/specs/2026-08-07-small-office-triage-design.md`](../superpowers/specs/2026-08-07-small-office-triage-design.md) —
  the product spec that generalized this build (§1: *"AGY... becomes the flagship case
  study. Its architecture, safety machinery, and eval methodology carry forward; its
  hardcoded specifics become per-office configuration."*).

# Product overview

Audience: PMs and stakeholders. The technical companion is [architecture.md](architecture.md).

## The problem

`pro@agency.example` receives ~4,700 threads/month. Today, dispatchers (aided by 22 Gmail filters) read each thread, apply queue labels that encode work type and owning team (NY front office vs KR processing center), forward it to the right desk, and later mark it done. The categorization step is high-volume, repetitive, and measurable — a phase-0 study of 6,875 threads showed most of it follows patterns a machine can learn or even hard-code.

## What we automate — and what stays human

| Step | Owner |
|---|---|
| Classify (apply queue labels) | **System**, when confident; humans otherwise |
| Dispatch (forward to desk alias) | **System**, only in the final rollout stage |
| Review uncertain mail | **Human** — the review queue |
| Mark work done / lifecycle disposition | **Human**, always (the classifier cannot even emit DONE labels) |

The system never routes to individuals — only to desk aliases (`invoice@`, `accounting@`, `express@agency.example`). Person-level routing is an open business decision (phase 2).

## Rollout: three stages, gated by evidence

Reversibility ordering: labels are trivially undone; a sent forward is not. So forwards are automated **last**.

| Stage | System may | Promotion gate to next |
|---|---|---|
| **0 · Shadow** ← current | Record decisions only; zero Gmail writes | ≥85% agreement with dispatchers on high-confidence decisions, sustained 2 weeks; ≥99% ingestion coverage; zero unexplained errors |
| **1 · Assisted** | Auto-apply labels on high confidence | Correction rate <5% on auto-labels over 2 weeks |
| **2 · Autonomous** | Auto-label + auto-forward; daily action digest | Steady state |

Stage changes are manual and owner-approved. A one-line kill switch reverts any stage to shadow instantly.

## Evidence so far

- **Phase 0 (study):** 6,875-thread stratified sample of the 425K-thread mailbox; decoded the existing filter set; identified high-purity sender rules (e.g. the DXC carrier feed maps to one label set at 99.4% purity, n=160).
- **Pre-launch eval (2026-08-06, gate PASSED):** the production model (Gemini 3.6 Flash) scored **77.3%** exact label-set match on an 88-thread blind test against held-out dispatcher decisions — above the 76.8% gate, and **+10.3 points** over the phase-0 Claude baseline on the identical scorer. Eight categories measured F1 ≥ 0.89 and are eligible for automation; broker cancellations, billing, and junk detection stay human-reviewed for now.

## Success criteria (from the spec)

1. Shadow-mode agreement ≥85% on high-confidence decisions, sustained 2 weeks.
2. In autonomous stage: ≥60% of inbound fully auto-triaged with correction rate <5%; the rest in the review queue with same-day human turnaround.
3. Zero un-audited actions — every label/forward traceable to a recorded decision with rationale.
4. Dispatcher time on routine categorization measurably reduced (owner-assessed after 1 month autonomous).

## What the review queue asks of humans

Low-confidence and weak-category mail lands in a queue (SQL today; dashboard is the next build). A reviewer confirms or corrects the proposed labels/forward. Corrections are stored and feed two improvement loops: recurring correction patterns get promoted into deterministic rules, and aggregate stats drive prompt/threshold tuning — each pass shrinks the residual the LLM must handle.

## Cost

~80 LLM-classified threads/day ≈ **$10/month** at current Gemini Flash pricing (rules absorb ~half the volume for free). Eval re-runs cost cents. Vercel + Postgres on starter tiers.

## Roadmap after v1

- **Review dashboard** (next plan): queue UI, audit log search, agreement metrics.
- **Phase 2 — EPIC integration** (Applied Epic SDK, confirmed feasible): auto-filing carrier docs, closure verification against the agency management system.
- Person-level routing, label hygiene, filter consolidation, reply drafting — each pending a business decision, none blocking v1.

## Risks being managed

| Risk | Mitigation |
|---|---|
| Wrong automated action erodes trust | Staged rollout; per-category allow-list; audit-before-act; forwards last |
| Model regression after a prompt/model change | Frozen 88-thread blind test re-run as a merge gate |
| Silent outage | Dead-man watchdog (15 min) + checkpoint design that can't lose mail |
| Key/token revocation (e.g. password change) | Watchdog surfaces within 15 min; re-auth is a 2-minute script |
| PII exposure | Study data gitignored; live system stores only the excerpt needed for audit/review |

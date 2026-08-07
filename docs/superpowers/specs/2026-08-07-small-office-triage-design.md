# Small-Office Email Triage — Product Design Spec

- **Date:** 2026-08-07
- **Status:** Design approved section-by-section in review; pending final owner review
- **Owner:** Sungwoo Park
- **Supersedes scope of:** `2026-08-05-email-triage-design.md` (the pro@agency.example build), which becomes the flagship case study. Its architecture, safety machinery, and eval methodology carry forward; its hardcoded specifics become per-office configuration.

## 1. Background and goals

Small offices with a public intake inbox (info@, office@, contact@) almost always route it the same way: a person reads everything and forwards each email to whoever handles it. The pro@agency.example build proved the automation pattern on a 425K-thread real-world inbox: deterministic rules absorb the patterned bulk for free, an LLM classifies the residual, and staged trust with human review makes automation safe (measured 77.3% blind-test accuracy, 91.0% on synthetic goldens; see `docs/case-study/`).

**Goal:** open-source, self-hosted tooling that gives any small office that system in one sitting: connect the inbox, answer a five-minute interview, let the tool mine the inbox's own history into deterministic rules and a personalized classifier, measure accuracy on that same history, and deploy in shadow mode — with the office's choice of LLM and no infrastructure the maintainer operates.

**Non-goals (v1):** hosted multi-tenant service; a web UI; person-level workload balancing; reply drafting; non-Gmail/non-M365 providers.

## 2. Confirmed decisions

| Decision | Value |
|---|---|
| Approach | **A — config-core refactor**: single pipeline + single deployable; all office-specifics live in per-office config; prompt and output schema generated at runtime. Library split (Approach B) deferred until external embedding demand exists |
| Packaging | **Self-hosted, CLI-guided** (`npx triage init`): office's own Vercel + Neon free tiers, own LLM key. No maintainer-operated infrastructure |
| Providers | **Gmail/Workspace first (M1), Microsoft 365 via Graph second (M2)** behind one `MailClient` interface with frozen contract tests |
| LLM | **Office's choice** via LangChain `initChatModel` `provider:model` string; office supplies its own key |
| Ground truth at onboarding | **Layered**: owner config (taxonomy) + gold (observed historical forwards in sent mail) + silver (LLM-labeled history sample); purity mining runs over both tiers, rules tagged by evidence tier |
| UI | **None in v1 — email is the UI**: uncertain mail forwarded to a review recipient with proposed routing + rationale in the body; corrections observed passively from sent mail; daily digest email |
| Auto-act eligibility | Never hand-configured. Measured: onboarding eval seeds it; live corrections update it |
| Repo | Evolve `email-triage-langgraph` in place; AGY artifacts move to `docs/case-study/` + an example config |
| Safety spine | Unchanged from the case study: record-before-act graph topology, staged rollout (shadow → assisted → autonomous), schema-locked output, idempotent actions, poison-thread handling, duplicates-over-holes checkpointing, dead-man watchdog |

## 3. Architecture

Same runtime shape as the case study — cron ingest → LangGraph (`rules → [classify] → decide → record → act`) → Postgres system of record — plus two new subsystems and one generalization:

```
npx triage init (CLI, one sitting)
  connect → configure → mine history → generate prompt+schema → evaluate → deploy (shadow)

runtime (per office deployment)
  ingest ─► rules ─►(miss)─► classify (office's LLM) ─► decide ─► record ─► act
                                                            │                └► forward w/ context ► routee
                                                     needs_review ─► forward w/ context ► review recipient
  sent-mail observer ─► corrections (gold) ─► rules promotion
```

- **New: onboarding CLI** (§4) — the product's heart.
- **New: sent-mail observer** (§8) — the passive correction loop; reuses the mining forward-detector continuously.
- **Generalized: config-driven core** (§5) — taxonomy, routing, prompt, and output schema derive from `triage.config.json` at runtime; nothing office-specific is compiled in.

## 4. Onboarding pipeline (`npx triage init`)

1. **Connect** — provider picker; OAuth loopback flow (Gmail: existing `authorize-gmail` generalized; M365: Entra device-code flow). Verifies the mailbox identity; token stays in the office's local `.env`.
2. **Configure** — interview producing `triage.config.json` (§5): routees with one-line descriptions, review recipient, LLM `provider:model` + key env name. ~5 minutes.
3. **Mine history** — pull last `mining.months` (default 6) of inbox + sent mail, capped at `mining.maxThreads` (default 5,000):
   - **Gold:** forwards detected in sent mail (Fwd:/FW: subject prefix + thread references/in-reply-to) whose recipient matches a routee ⇒ human routing decisions.
   - **Silver:** office's LLM classifies a sample of the remainder against the config taxonomy, stratified by sender domain and spread across the time window (so one chatty newsletter can't dominate the sample).
   - **Purity mining:** phase0 algorithm generalized — `sender_exact` / `sender_domain` / `list_id` / `subject_template` patterns meeting purity/support thresholds (defaults from the case study: domain ≥0.9/10, exact ≥0.95/5) become rules, `source: mined-gold` or `mined-llm`; gold-backed rules start with higher trust.
4. **Generate** — taxonomy prompt assembled from config descriptions + few-shot exemplars drawn from the office's own high-confidence mined history; zod output schema built from config (categories enum + routee-address forward enum).
5. **Evaluate** — a held-out slice of mined ground truth (gold preferred; default 20% of labeled threads, min 30, capped 200) is excluded from rule mining and becomes the office's personal blind test. CLI reports per-category agreement in plain language and seeds `autoActLabels` from categories that measure strong. Below a floor (~70% overall) the deploy proceeds with **everything review-only** and a plain warning.
6. **Deploy** — productized version of the case study's deployment automation: Vercel link, Neon provision via Marketplace, env push, migrations + mined-rule seeding, deploy, smoke ingest. Lands in **shadow**.

## 5. Config schema (`triage.config.json`, zod-validated, versioned)

```jsonc
{
  "version": 1,
  "office": { "name": "Hartley & Sons", "mailbox": "info@hartleysons.com" },
  "routees": [
    { "id": "jo", "name": "Jo Hartley", "email": "jo@hartleysons.com",
      "description": "Billing, invoices, payment and refund questions" },
    { "id": "sales", "name": "Sales desk", "email": "sales@hartleysons.com",
      "description": "Quotes, new orders, product availability" }
  ],
  "categories": [
    { "id": "junk", "description": "Newsletters, marketing, autoreplies", "route": null }
  ],
  "review": { "recipient": "jo@hartleysons.com" },
  "llm": { "model": "anthropic:claude-sonnet-5", "apiKeyEnv": "ANTHROPIC_API_KEY" },
  "mining": { "months": 6, "maxThreads": 5000 }
}
```

Semantics:

- Every routee is automatically a category whose action is *forward to that routee with context in the body*. `categories` adds non-routing labels; `junk` and `needs_review` are built-ins.
- **Multi-task per email stays** (case-study data: ~10% of real mail is legitimately multi-request). One forward per task.
- Vocabulary is verbatim-locked once written (the case study's `Cancelllation` lesson as a config-validation rule): renames are explicit migrations, never silent edits.
- `autoActLabels` and `stage` live in the DB (runtime state), not the config file.
- Config hash is recorded on every decision row for auditability across config changes.

## 6. Provider abstraction

```ts
interface MailClient {
  listNewThreads(sinceMs: number): Promise<ThreadSnapshot[]>
  listHistory(opts: { months: number; maxThreads: number; sent?: boolean }): AsyncIterable<ThreadSnapshot>
  ensureCategories(names: string[]): Promise<void>
  applyCategories(threadId: string, names: string[]): Promise<void>
  forward(threadId: string, to: string, contextBody: string): Promise<void>
  sendMessage(to: string, subject: string, body: string): Promise<void>
}
```

- **Gmail (M1):** extends the existing probe-tested client; labels native; `listHistory` pages date-windowed `threads.list`; forward = existing RFC822 builder with the context body.
- **Microsoft Graph (M2):** Entra app + device-code flow (CLI shows a code; no admin console); Outlook **categories** map to labels; `conversationId` threading normalized into `ThreadSnapshot`; forward via Graph `createForward`/`send`.
- The interface + contract-test suite freeze in M1 against the Gmail implementation; Graph implements against them. Everything downstream of `normalize()` is provider-blind.

## 7. Runtime safety and staged rollout

Inherited unchanged: graph edge ordering makes an un-audited action impossible; decide gates on stated confidence **and** the measured allow-list; act is stage-gated and per-action idempotent; ingest is poison-guarded with duplicates-over-holes checkpointing; a watchdog alerts on silence.

Re-anchored for this product:

- **Schema enforcement moves to runtime**: zod enums built from config at startup. A model on any provider cannot invent a category or route outside routees + review recipient.
- **Stages:** shadow = record only; assisted = apply labels/categories; autonomous = forwards with context. Same measured promotion gates as the case study, surfaced in plain language by `npx triage status`; `npx triage promote` / `npx triage pause` write the stage flag (pause = kill switch).

## 8. Email-native review and the passive correction loop

- `needs_review` decisions forward to `review.recipient`, subject-tagged `[triage]`, with proposed routing, rationale, and confidence in the body and the original attached. The reviewer routes it the way they always have: by forwarding it onward.
- The **sent-mail observer** (the mining forward-detector, running continuously on the ingest cron) sees that onward forward, matches it to the reviewed thread, and records the correction as **gold**. Corrections that accumulate past purity/support thresholds are promoted into deterministic rules automatically (`source: learned`). Reviewing mail *is* the training signal; no buttons exist.
- **Daily digest** to the review recipient: auto-routed counts, pending review, errors. The dead-man alert rides the same channel.

## 9. Error handling

Fail toward humans, never fail-open — inherited posture, extended to onboarding:

- Mining: unparseable threads skip-and-count; LLM-labeling failures shrink silver rather than aborting; a mining run that yields zero rules still produces a working (LLM-only) deployment.
- Onboarding eval below floor: deploy proceeds, everything review-only, warning shown. The office still gets organized mail; automation waits for evidence.
- Runtime: classifier failure → retry once → review (unchanged); provider API failures → systemic abort-and-retry vs thread-local 3-strike stubs (unchanged); observer mis-matches (a forward that matches no reviewed thread) are ignored, never guessed.

## 10. Testing

- The zero-credential story is preserved: PGlite + injected fakes; the full pipeline, mining, and generation testable with no keys.
- Existing 67 tests migrate to config-driven fixtures using an `examples/` office; new suites: forward-detection (subject-prefix + thread-reference matching, both providers), purity mining over synthetic histories, config validation (including vocabulary lock), prompt/schema generation, MailClient contract tests (Gmail M1, Graph M2 against the same suite).
- Eval harness becomes per-office (their held-out history is their dataset). The 67 synthetic goldens remain as the example office's CI eval with the calibrated judges (see `docs/evals.md`).
- Live probes remain a hard gate before unattended operation, per provider.

## 11. Repo transition

- AGY spec, phase0 methodology, and measured results move to `docs/case-study/`; the 42-label vocabulary and desk aliases become an example config demonstrating a complex real-world taxonomy.
- `scripts/demo.ts` becomes the example office's demo; README repositions around the product with the case study as evidence.
- Nothing in git history changes; the showcase value is preserved and repositioned.

## 12. Milestones

| Milestone | Contents | Definition of done |
|---|---|---|
| **M1** | Config-core refactor, onboarding CLI end-to-end (Gmail), mining + generation + per-office eval, email-native review + correction observer, digest | A stranger's office can go from clone to shadow mode in one sitting using only the README |
| **M2** | Microsoft Graph provider against frozen contract tests; Entra device-code onboarding path | Same sitting, M365 mailbox |
| **M3** | Polish from first external users: correction-loop tuning, docs hardening, revisit the UI question with evidence | Driven by real usage reports |

## 13. Success criteria

1. **Time-to-shadow ≤ 1 hour** for a non-developer-assisted office (M1, Gmail), measured by a fresh-machine walkthrough.
2. Onboarding eval produces per-category numbers on the office's own history, and auto-act eligibility is exclusively measurement-derived.
3. The passive correction loop demonstrably promotes at least one learned rule in the example-office integration test.
4. Zero-credential `npm test` and `npm run demo` continue to pass for any cloner; the safety invariants (record-before-act, schema lock, idempotency) keep their structural tests.
5. The case study remains reproducible: its config + goldens keep the current CI eval green.

## 14. Open items (deferred, not blockers)

- Non-forwarding offices (reply-only routing) — observe reply-to-sender patterns as a future gold source.
- Shared-inbox tools overlap (Front, Missive) — positioning note for the README, not a feature decision.
- Config-change migrations (routee departs; category rename) — v1 rule: explicit `npx triage reconfigure` re-runs generation + eval; history keeps old vocabulary.
- IMAP/other providers; hosted offering; UI — all post-M3, evidence-driven.

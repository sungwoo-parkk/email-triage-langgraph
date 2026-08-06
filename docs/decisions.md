# Decision log (ADRs)

Lightweight records of the decisions the design hinges on. Format: context → decision → consequences. Full reasoning lives in the [spec](superpowers/specs/2026-08-05-email-triage-design.md); this is the quick-reference index.

## ADR-1 · Rules first, LLM only for the residual

**Context:** Phase 0 showed the carrier-feed bulk is deterministic — e.g. `dxc.com` senders map to one label set at 99.4% purity (n=160). LLM calls cost money and add variance.
**Decision:** A data-driven rules engine runs first; a *complete* rule hit skips the classifier entirely (~50% of volume). Partial hits pass evidence into the prompt.
**Consequences:** Half the volume is free, instant, and deterministic. Rules are rows in Postgres (`source: phase0/learned/manual`), so the boundary between "hard-coded" and "learned" shifts without deploys.

## ADR-2 · LangGraph.js as the pipeline spine

**Context:** The pipeline is a small DAG today, but phase 2 adds agentic subgraphs (EPIC filing) needing durable multi-step runs.
**Decision:** Model the pipeline as a LangGraph `StateGraph` now; keep the Postgres checkpointer dormant until phase 2.
**Consequences:** Graph topology encodes invariants (record precedes act; classify only on rule miss). Some ceremony for a five-node graph — accepted as the price of the phase-2 path.

## ADR-3 · Gemini 3.6 Flash, schema-enforced (owner choice)

**Context:** Owner has Gemini API access; cost target ~$10/month; the task is high-volume classification, not generation.
**Decision:** `gemini-3.6-flash` with `withStructuredOutput` (zod). Confidence low/medium → humans, not a bigger model. Escalation to Pro tier is a config change (`GEMINI_MODEL`), used only if the eval gate fails.
**Consequences:** Measured 2026-08-06: 77.3% raw exact-set on the blind test — gate passed, +10.3 over the phase-0 Claude predictions raw. Schema enforcement means a malformed response is a retry-then-review, never a parsed guess.

## ADR-4 · Multi-label task output, one forward per task

**Context:** ~10% of threads legitimately contain multiple requests (e.g. endorsement + cancellation in one email).
**Decision:** The classifier emits `tasks: [{labels[], forward_to}]` — label sets plus at most one forward each — matching dispatcher practice.
**Consequences:** No forced single-label distortion; the decide/act layers handle sets everywhere (dedupe at the action level).

## ADR-5 · The 42-label vocabulary, verbatim

**Context:** Labels are the dispatchers' shared language and feed downstream reports. One label is misspelled (`Cancelllation`); two USLI renewal-quote labels coexist.
**Decision:** Adopt all 42 verbatim; retire nothing; a unit test asserts the misspelling. The classifier's enum excludes only the DONE family (human-only).
**Consequences:** Zero migration burden on staff; system output is indistinguishable from dispatcher output. Label hygiene deferred to a business decision.

## ADR-6 · Desk aliases only — no person-level routing

**Context:** Phase 0 found no content signal predicting *which person* gets a thread; roster is fluid.
**Decision:** v1 forwards only to `invoice@`, `accounting@`, `express@agency.example`. The schema enum enforces it.
**Consequences:** A misroute lands on a desk, not a person's silence. Person routing waits for a business decision + roster.

## ADR-7 · Postgres decision row before any Gmail action

**Context:** Trust requires answering "what did the system do and why" for every action, including after crashes.
**Decision:** `record` precedes `act` in the graph; `act` reads the persisted row and marks each action executed immediately after success.
**Consequences:** Un-audited actions are structurally impossible; retries are idempotent (a forward can never double-send); the audit log doubles as the ops dashboard's data.

## ADR-8 · Staged rollout; forwards automated last

**Context:** Labels are reversible; sent email is not.
**Decision:** shadow (record only) → assisted (labels) → autonomous (labels + forwards), each promotion gated on measured agreement/correction rates; one-key kill switch to shadow.
**Consequences:** The system earns each capability with evidence. Slowest possible path to full automation — intentionally.

## ADR-9 · Per-mailbox OAuth instead of domain-wide delegation

**Context (2026-08-06):** The default Google-recommended pattern for server-side Gmail access is a service account with domain-wide delegation — but a DWD key can impersonate **every** mailbox in the workspace for its scopes. Owner declined that blast radius.
**Decision:** OAuth refresh token granted directly by `pro@agency.example` (Internal consent screen, Desktop client, `authorize-gmail` script verifies the consenting mailbox). DWD code path retained but unused.
**Consequences:** Compromise of our credentials exposes one mailbox, not the domain; the grant is visible/revocable on the account's security page. Cost: a password change on pro@ revokes the token (watchdog alarms; re-auth is a 2-minute script), and the one-time consent needs a human browser session.

## ADR-10 · Dedupe by `decisions`, checkpoint clamping, 3-strike poison stubs

**Context:** The naive poll-and-checkpoint loop either loses threads (checkpoint passes a failure) or wedges forever (checkpoint waits on a permanently-crashing thread). An early version deduped by `threads`, which a crash between writes could leave "seen but never triaged."
**Decision:** Dedupe keys off `decisions` (written last); checkpoint advances only past durably-recorded threads and is clamped below any failing thread; after 3 failures a thread is stubbed as a visible `failed` decision and released.
**Consequences:** Duplicates over holes — re-processing is safe, dropping is impossible; a poison thread costs at most 3 retries and a human look, not an outage.

## ADR-11 · Per-category allow-list over model-stated confidence

**Context:** The blind test showed confidence output is honest but blunt (86/88 rated "high"); some categories are measurably weaker than others at identical stated confidence.
**Decision:** Auto-action requires stated `high` confidence **and** every label in `autoActLabels` — a config allow-list seeded from measured per-category F1 (≥ 0.86 bar). `4-CAN REQ` (0.82), `Billing` (0.74), junk detection: review-only.
**Consequences:** The safety load rests on measurement, not model self-report. The allow-list is runtime config — categories graduate by evidence without a deploy.

## ADR-12 · Epic-driven person routing — phase 2, person + desk (decided direction)

**Context (2026-08-06):** v1 forwards only to desk aliases (ADR-6) because email content carries no person signal. But Applied Epic *does* hold the truth — an account manager / CSR field per client/policy — and SDK access is confirmed available. The owner wants data-driven routing to the right person.
**Decision:** After the desk-alias rollout reaches stable autonomous operation: (1) extend the classifier schema to extract policy number and insured name; (2) add an Epic lookup node between `classify` and `decide` that resolves the account owner; (3) forwards target the **person and the owning desk alias together**; (4) Epic lookup failure or no-match falls back to desk-only routing — never blocks, never guesses; (5) person-forwards start review-only and graduate through the same measured gates as every other capability.
**Consequences:** Routing comes from the system of record instead of convention; stale Epic assignments are caught by the desk copy rather than failing silently; the pipeline gains its first external data dependency, contained by the fallback. Timing keeps v1's risk profile untouched.

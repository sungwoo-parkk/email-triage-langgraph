# Email Triage Automation for pro@agency.example — Design Spec

- **Date:** 2026-08-05
- **Status:** Approved section-by-section in design review; pending final owner review
- **Owner:** Sungwoo Park (agency.example)
- **Evidence base:** Phase 0 study, `phase0/analysis/` (6,875-thread stratified sample of a 425K-thread mailbox, blind classification test, decoded filter set, per-label qualitative characterization)

## 1. Background and goals

`pro@agency.example` is the operations intake mailbox of AGY (insurance agency; NY front office + KR back-office processing center). ~4,700 threads/month arrive. Today, humans (aided by 22 Gmail filters) triage each thread by:

1. applying **queue labels** encoding work type and owning team (`2-NY`, `3-KR`, `4-CAN REQ`, `Cancelllation` [sic — spelling is load-bearing], …),
2. **forwarding** the thread to an individual or desk alias, and
3. closing with a `*1-DONE/DONE-<person>` label.

**Goal:** automate steps 1–2 — classification and dispatch — with human review for low-confidence mail, while leaving completion marking (step 3) and lifecycle disposition with humans. Dogfood-first, single tenant, built for later integrations (Applied Epic SDK confirmed possible).

**Measured feasibility (Phase 0 blind test, 88 held-out threads):** 81.8% exact label-set match (arrival-time adjusted), 87.1% at high confidence; 7 categories at F1 ≥ 0.86. Deterministic sender rules cover the carrier-feed bulk (e.g. `dxc.com` → `{3-KR, 3-KR/DOCS&NOTICE}` at 99.4% purity, n=160). Note: baseline measured with a Claude-family model; Gemini baseline to be measured pre-launch (§7).

## 2. Confirmed decisions

| Decision | Value |
|---|---|
| Architecture | Approach B: hosted service (Next.js on Vercel), TypeScript, single codebase |
| Orchestration | **LangGraph.js** as the pipeline spine (user decision, for long-term integrations) |
| Classifier model | **Gemini 3.6 Flash** via `@langchain/google-genai` (user decision; API key available). Gemini 3.1 Pro reserved as optional escalation; low confidence routes to humans, not to a bigger model |
| Output contract | **Multi-label**: emit label sets + one forward per task, matching current practice (~10% of threads are legitimately multi-task) |
| Label vocabulary | Existing 42 labels **verbatim**, including `Cancelllation` misspelling and both USLI renewal-quote labels; nothing retired for now |
| Routing granularity | Queue labels + desk aliases only. No person-level routing in v1 (business decision deferred; person assignment shows no content signal) |
| Desk aliases (confirmed stable) | carrier invoices → `invoice@agency.example`; broker/insured payment matters → `accounting@agency.example`; NHO endorsements/quotes → `express@agency.example`; `kr2pod@` = KR2 processing pod |
| Team logic | KR = back-office commodity processing regardless of book; NY = front-office judgment work; book decides shared functions (NHO → NY, DP/CP commercial → KR). No written prefix table exists — learned from data |
| Gmail access | Google Cloud service account with domain-wide delegation on pro@agency.example (fallback: OAuth refresh token) |
| EPIC integration | Phase 2, via Applied Epic SDK (confirmed possible); v1 does not block on it |
| Review surface | Web dashboard (review queue + audit log + metrics) in the same app |

## 3. Architecture

One Vercel-hosted Next.js app; Postgres (provisioned via Vercel Marketplace at setup); LangGraph.js state graph as the classification pipeline; Gmail API for ingestion and actions.

```
ingest → normalize → rules ──(full hit)──────────────→ decide → act (Gmail)
                        └──(miss/partial)→ classify ──↑       └→ review-queue (dashboard)
```

- **Nodes share a state object** (thread snapshot + accumulated evidence + proposed label set + confidence). The conditional edge after `rules` implements "LLM only for the residual" (~50% of volume).
- **Every decision is written to Postgres before any action executes.** The database is the system of record for "what did the system do and why."
- **Phase-2 boundary:** the `act` node is a thin, pluggable action layer (today: Gmail labels + forwards). EPIC becomes an agentic subgraph off `act`, enabled by LangGraph's Postgres checkpointer (dormant in v1). LangSmith tracing is a later env-var opt-in; the Postgres audit log remains the system of record.

## 4. Components

### 4.1 Ingestion

- Vercel cron every 2 minutes → Gmail API (`threads.list`) for threads newer than the stored checkpoint → dedupe against `threads` table → one graph run per new thread.
- Hardening carried over from the Phase 0 extractor (verified live): persist checkpoint only **after** durable writes (duplicates over holes; dedupe by threadId); error triage tiers — systemic errors (quota/rate/server) abort the run for the next cron to retry, thread-local errors get 3-strike stubbing surfaced in the dashboard; a dead-man alert fires if no ingest run has succeeded in 15 minutes.
- Smoke-test rule (lesson from Phase 0: four review rounds missed what one live probe found): every Gmail integration path gets a live probe command run before unattended operation.

### 4.2 Rules engine

- Rules are **data** (Postgres `rules` table), not code: pattern type (`sender_exact`, `sender_domain`, `list_id`, `subject_template`), pattern, emitted label set, measured purity/support, source (`phase0` / `learned` / `manual`), active flag.
- Seeded from the Phase 0 high-purity tables (label-set purity ≥ 0.9, support ≥ 10; exact senders ≥ 0.95, support ≥ 5) plus the 22 existing Gmail filters' semantics.
- A rule hit with full coverage skips the LLM. Partial hits (rule proposes some labels; e.g. carrier doc that may also warrant `Billing`) pass their evidence into `classify` via graph state.
- Structural taxonomy rule: `Cancelllation` (carrier cancellation notice) auto-co-emits `3-KR/DOCS&NOTICE` (dispatcher practice, confirmed by blind-test miss analysis).

### 4.3 Classify node (Gemini 3.6 Flash)

- Binding: `@langchain/google-genai` inside the LangGraph node; `GEMINI_API_KEY` in Vercel env.
- Input: exactly what the dispatcher sees at arrival — sender, subject, attachment names, List-Id, body excerpt (~1,200 chars) — plus rule-partial evidence.
- Output: **schema-enforced JSON** (Gemini `responseSchema`): `{ tasks: [{ labels: [<enum of the 42 label names>], forward_to: <enum of desk aliases | none> }], confidence: high|medium|low, rationale: string }`. The label enum locks the vocabulary (incl. `Cancelllation`).
- Prompt: versioned in-repo; category definitions derived from the Phase 0 qualitative characterizations; Gemini context caching discounts the repeated prefix.
- Cost: ~80 LLM-classified threads/day ≈ **~$10/month** at $1.50/$7.50 per MTok. Eval re-runs use Gemini batch mode (50% off).
- Timeout/retry: one retry on transient failure or schema-invalid output, then route to review queue (fail toward humans; see §6).

### 4.4 Decide node

- Confidence thresholds are **per-category** config, calibrated from the Gemini eval run (§7), stored in versioned config with the stage flag.
- High confidence → `act`. Otherwise → review queue. Categories measured weak stay review-only regardless of stated confidence until eval proves otherwise.

### 4.5 Act node (Gmail action layer)

- Applies the decided label set (`threads.modify`) and sends one forward per task to the mapped desk alias (RFC822 forward: original quoted, attachments included, sent as pro@).
- Idempotency: actions execute only if the `decisions` row shows them unexecuted; a retry can never double-send a forward. Labels are idempotent by nature.
- Stage flag gates what `act` may do: `shadow` = record only; `assisted` = labels only; `autonomous` = labels + forwards.

### 4.6 Database schema (Postgres)

- `threads` — one row per ingested thread: threadId (PK), snapshot (from, subject, attachments, listId, body excerpt), first_seen.
- `decisions` — audit log / system of record: thread_id, stage, rule_hits (jsonb), llm_output (jsonb: tasks/confidence/rationale/model/tokens), final_label_set (jsonb), actions_planned / actions_executed (jsonb, timestamps), status.
- `reviews` — human corrections: decision_id, corrected task set, reviewer, note, created_at.
- `rules` — see §4.2.
- `checkpoints` — LangGraph Postgres checkpointer tables (dormant until phase 2).
- Views: `v_agreement` (live agreement vs dispatcher during shadow; the promotion gate metric) and `v_category_stats` (per-category precision/recall + confidence calibration).

### 4.7 Dashboard (v1 scope)

- **Review queue:** low-confidence decisions — email preview, proposed task set, one-click confirm (applies to Gmail) or correct (applies corrected set + writes `reviews` row).
- **Audit log:** searchable decision history.
- **Metrics:** agreement rate (shadow gate), per-category stats, calibration curve.
- Access: Google sign-in restricted to agency.example accounts.

## 5. Rollout stages and promotion gates

| Stage | System behavior | Promotion gate |
|---|---|---|
| 0. Shadow (~2 weeks) | Full pipeline on live mail; zero Gmail writes; decisions recorded | ≥85% exact label-set agreement on high-confidence decisions; ≥99% ingestion coverage; zero unexplained errors |
| 1. Assisted | Auto-apply **labels** on high confidence; forwards remain human; review queue live | Correction rate <5% on auto-labels over 2 weeks |
| 2. Autonomous | Auto-label + auto-forward high confidence; review queue for the rest; daily action digest | Steady state |

- Ordering rationale: labels are trivially reversible; sent forwards are not — forwarding is automated last.
- Kill switch: one config flag reverts any stage to shadow instantly.
- Stage changes are manual, owner-approved, evidence-attached.

## 6. Error handling

Principle: **fail toward humans, never fail-open.** The designed failure mode is an unclassified email reaching the review queue; a wrong automated action is the failure mode the design spends its complexity preventing.

- LLM failure/timeout/schema-invalid: retry once → review queue.
- Gmail action failure: decision marked failed, surfaced in dashboard; forward-idempotency guard prevents double-sends on retry.
- Ingestion: transient errors retry on next cron; poison threads 3-strike-stub with dashboard surfacing; checkpoint ordering guarantees duplicates-not-holes.
- Dead-man alert on ingestion silence (15 min); daily digest includes error counts.
- No silent catch blocks: every anomaly lands in `decisions.status` or a dashboard-visible stub.

## 7. Testing and evaluation

- **Pre-launch Gemini baseline:** re-run the 88-thread blind test and the 1,111-thread held-out eval (both from Phase 0, `phase0/analysis/`) through the existing scorer with Gemini 3.6 Flash; calibrate per-category thresholds from its confidence outputs. Gate: Gemini's adjusted exact-set match on the blind test must land within 5 points of the Phase 0 baseline (i.e. ≥76.8%) before shadow mode starts; if it falls short, prompt iteration or model escalation happens *before* any live-mail stage.
- **CI:** rules engine unit tests on fixtures mined from Phase 0 data; eval-set scoring on every prompt/threshold/model change with a regression gate (no category F1 drops materially without explicit sign-off); a dedicated test asserts the `Cancelllation` spelling and full label vocabulary.
- **Live:** shadow mode is the continuous integration test against reality; `v_agreement` is its readout.
- **Review loop as tuning data:** `reviews` rows feed periodic prompt/rules refinement; high-purity correction patterns can be promoted into `rules` (source=`learned`) via the dashboard.

## 8. Phase 2 roadmap (out of v1 scope)

- **EPIC integration** (Applied Epic SDK): agentic subgraph off `act` — e.g. auto-filing carrier docs, bounce disposition, "confirmed done in EPIC" closure verification. Enabled by activating the LangGraph Postgres checkpointer for durable multi-step runs.
- **LangSmith** tracing/evals as env-var opt-in.
- Person-level routing (pending business decision + roster), USLI label canonicalization (pending business decision), label hygiene, Gmail filter consolidation (the 22 filters can eventually be subsumed by the rules table), reply drafting, productization/multi-tenant.

## 9. Success criteria

1. Shadow-mode agreement ≥85% on high-confidence decisions, sustained 2 weeks.
2. In autonomous stage: ≥60% of inbound fully auto-triaged (labels + forward) with correction rate <5%; the remainder in the review queue with same-day human turnaround.
3. Zero un-audited actions: every label/forward traceable to a `decisions` row with rationale.
4. Dispatcher time on routine categorization measurably reduced (owner-assessed after 1 month of autonomous operation).

## 10. Open items (explicitly deferred, not blockers)

- USLI renewal-quote canonical label + current stream ownership (business decision).
- Person-level routing and current roster (business decision).
- EPIC SDK access details (credentials, environment) — needed at phase 2 start, not before.
- Data handling note: Phase 0 extract data (`phase0/data/`, `phase0/analysis/`) contains insured PII — keep out of version control; live system stores only body excerpts needed for audit/review.

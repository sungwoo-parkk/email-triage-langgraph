# Operations runbook

Audience: whoever is on call. Assumes access to the Vercel project, the production Postgres, and the `pro@agency.example` Google account.

> Current state: **not yet deployed** (plan Task 12 in progress). Sections marked ⏳ apply once the service is live; they are written now so day one has a runbook.

## Quick reference

| Thing | Where |
|---|---|
| Stage flag / kill switch | `app_config` table, key `stage` |
| Audit log | `decisions` table |
| Ingest health | `ingest_state.last_success_at`; watchdog cron |
| Poison threads | `ingest_failures` (3+ strikes ⇒ stubbed `failed` decision) |
| Live probes | `npm run probe-gmail`, `npm run probe-gemini` |
| Re-authorize Gmail | `npm run authorize-gmail` (as pro@agency.example) |

## Stage changes and the kill switch

Stages: `shadow` (record only) → `assisted` (labels only) → `autonomous` (labels + forwards). Changes are manual, owner-approved, evidence-attached (promotion gates in [product.md](product.md)).

```sql
-- Set the stage (value is JSON — keep the quotes):
insert into app_config (key, value) values ('stage', '"assisted"'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();

-- KILL SWITCH — revert to shadow instantly:
insert into app_config (key, value) values ('stage', '"shadow"'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();
```

Takes effect on the next graph run (≤2 min). No deploy needed.

## ⏳ Alert: watchdog email ("ingestion silent")

Fires when no ingest run has succeeded in 15 minutes.

1. Check Vercel → Crons: is `/api/cron/ingest` firing? Check function logs for the error.
2. `401 unauthorized` in logs → `CRON_SECRET` mismatch between Vercel cron config and env.
3. Gmail `invalid_grant` → the OAuth refresh token was revoked (commonly: pro@'s password changed). Re-run `npm run authorize-gmail`, update `GOOGLE_OAUTH_REFRESH_TOKEN` in Vercel env, redeploy.
4. Gemini quota/5xx → systemic errors abort the run by design; the next cron retries. Sustained: check billing/quota on the GCP project.
5. Database connection errors → check the Postgres provider status page / connection limits.

The checkpoint design means an outage never loses mail: on recovery, ingestion resumes from the last durable checkpoint (duplicates are deduped; holes are impossible).

## ⏳ Failed decisions

```sql
-- Recent failures with cause:
select id, thread_id, status, error_detail, created_at
from decisions where status = 'failed' order by created_at desc limit 20;
```

- `ingest poisoned: …` — the thread crashed the graph 3 times and was stubbed. Triage it by hand in Gmail; the error detail says why it crashed (fix the bug; the thread will not retry automatically).
- Act-layer failures (e.g. a forward bounced at the API) — the decision stops at the failed action; already-executed actions are recorded in `actions_executed`. After fixing the cause you may re-run the decision by calling `executeDecision` (idempotent — completed actions are skipped), or handle the thread manually and leave the row as the audit trail.

## ⏳ Review queue

Until the dashboard ships, the queue is a query:

```sql
select d.id, t.from_addr, t.subject, d.final_tasks, d.confidence, d.created_at
from decisions d join threads t on t.thread_id = d.thread_id
where d.status = 'needs_review' order by d.created_at asc;
```

Humans triage these in Gmail as they do today. (In shadow stage *everything* is effectively human-handled anyway; `needs_review` volume is the number to watch for staffing.)

## Rules maintenance

Rules are data. Adding a manual rule (example: a new carrier's document feed):

```sql
insert into rules (pattern_type, pattern, label_set, complete, source, active)
values ('sender_domain', 'newcarrier.com', '["3-KR","3-KR/DOCS&NOTICE"]', true, 'manual', true);
```

- `complete = true` means a hit fully resolves the thread and skips the LLM — only set it when you're confident the label set is always right for this pattern.
- Deactivate (don't delete) a bad rule: `update rules set active = false where id = …;`
- Re-seed from phase-0 stats (idempotent, `on conflict do nothing`): `npm run seed-rules`.

## Prompt / model changes

Any change to `src/lib/prompt.ts`, the model ID, or thresholds requires re-running the eval **before merge**:

```bash
npm run eval-blindtest     # 88 Gemini calls, a few minutes
cd phase0 && PYTHONIOENCODING=utf-8 python score_blindtest.py analysis/blindtest/predictions-gemini.json
```

Regression gate: no category F1 drops materially and the exact-set match stays ≥ 76.8% (spec §7). Record new numbers in the spec.

## ⏳ Deploy / rollback

- Deploy: `vercel deploy --prod` (CI-less for now; run the test suite first: `npm test`).
- Rollback: Vercel dashboard → previous deployment → Promote. The DB schema is forward-only migrations; coordinate schema changes with deploys.
- After any deploy touching Gmail or Gemini paths: run both probes before walking away (phase-0 lesson — four review rounds missed what one live probe found).

## Secrets inventory

| Env var | What / where it comes from |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | GCP OAuth Desktop client (Internal consent screen) |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | `npm run authorize-gmail`, consented by pro@agency.example |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Google AI key; model pinned `gemini-3.6-flash` |
| `DATABASE_URL` | Vercel Marketplace Postgres |
| `CRON_SECRET` | Random; must match Vercel cron config |
| `ALERT_EMAIL` | Where the watchdog complains |

Rotation notes: OAuth token — re-run authorize script. Gemini key — GCP console, update env, redeploy. `CRON_SECRET` — update env and cron config together.

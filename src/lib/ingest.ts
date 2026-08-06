import type { Querier } from "./db";
import { normalize, type NormalizedEmail, type ThreadSnapshot } from "./normalize";

export interface IngestBatchResult {
  processed: number;
  checkpointMs: number;
  failures: number;
}

/**
 * Processes one batch of Gmail thread snapshots through the triage graph, hardened
 * against poison threads: a thread whose graph.run() call deterministically throws
 * must never wedge the checkpoint forever, and must never be silently dropped.
 *
 * Dedupe is keyed off `decisions` (not `threads`) because recordDecision writes the
 * `threads` row before the `decisions` row — a crash between those two writes would
 * otherwise leave a thread permanently "seen" but never triaged.
 *
 * On a per-thread failure: the failure is counted in `ingest_failures`. Below 3
 * strikes, the checkpoint is clamped to just before that thread's internalDateMs so
 * the thread is re-fetched and retried on the next run (a re-fetch is safe because
 * dedupe-by-decisions skips anything that did complete). At 3 strikes, the thread is
 * "poison stubbed": a `threads` row (if missing) and a `decisions` row with
 * status 'failed' are written directly, so the thread is (a) considered resolved by
 * the dedupe check going forward and (b) visible to humans for manual review, and the
 * checkpoint is allowed to advance past it.
 */
export async function runIngestBatch(
  db: Querier,
  graph: { run(email: NormalizedEmail): Promise<number> },
  snapshots: ThreadSnapshot[],
  prevCheckpointMs: number,
  stage: string
): Promise<IngestBatchResult> {
  let processed = 0;
  let failures = 0;
  let maxSeen = prevCheckpointMs;
  let clampMs = Infinity;

  for (const snap of snapshots) {
    const seen = await db.query(`select 1 from decisions where thread_id = $1`, [snap.threadId]);
    if (seen.rows.length) continue; // already triaged (or poison-stubbed) — dedupe

    try {
      await graph.run(normalize(snap));
      processed++;
      maxSeen = Math.max(maxSeen, snap.internalDateMs);
    } catch (e) {
      failures++;
      const detail = e instanceof Error ? e.message : String(e);
      console.error(`ingest: thread ${snap.threadId} failed:`, detail);

      const { rows } = await db.query(
        `insert into ingest_failures (thread_id, count, last_error, updated_at)
         values ($1, 1, $2, now())
         on conflict (thread_id) do update
           set count = ingest_failures.count + 1, last_error = $2, updated_at = now()
         returning count`,
        [snap.threadId, detail]
      );
      const strikes = Number(rows[0].count);

      if (strikes >= 3) {
        await poisonStub(db, snap, stage, detail);
        maxSeen = Math.max(maxSeen, snap.internalDateMs); // resolved (as failed); safe to pass
      } else {
        // never let the checkpoint pass an unresolved thread
        clampMs = Math.min(clampMs, snap.internalDateMs - 1);
      }
    }
  }

  const checkpointMs = Math.max(prevCheckpointMs, Math.min(maxSeen, clampMs));
  return { processed, checkpointMs, failures };
}

async function poisonStub(db: Querier, snap: ThreadSnapshot, stage: string, detail: string): Promise<void> {
  const email = normalize(snap);
  await db.query(
    `insert into threads (thread_id, from_addr, subject, attachments, list_id, body_excerpt, internal_date_ms)
     values ($1,$2,$3,$4,$5,$6,$7) on conflict (thread_id) do nothing`,
    [email.threadId, email.fromAddr, email.subject, JSON.stringify(email.attachments),
     email.listId, email.bodyExcerpt, email.internalDateMs]
  );
  await db.query(
    `insert into decisions (thread_id, stage, rule_hits, final_tasks, actions_planned, status, error_detail)
     values ($1, $2, '[]', '[]', '[]', 'failed', $3)`,
    [snap.threadId, stage, `ingest poisoned: ${detail}`]
  );
}

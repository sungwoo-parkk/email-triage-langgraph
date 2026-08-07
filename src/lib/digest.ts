import type { Querier } from "./db";

interface StatusCounts { decided: number; acted: number; needs_review: number; failed: number }

async function countsByStatus(db: Querier, sinceMs: number): Promise<StatusCounts> {
  const { rows } = await db.query(
    `select status, count(*) as n from decisions where created_at >= to_timestamp($1 / 1000.0) group by status`,
    [sinceMs]
  );
  const counts: StatusCounts = { decided: 0, acted: 0, needs_review: 0, failed: 0 };
  for (const r of rows as any[]) {
    const status = r.status as keyof StatusCounts;
    if (status in counts) counts[status] = Number(r.n);
  }
  return counts;
}

async function recentFailures(db: Querier, sinceMs: number): Promise<{ threadId: string; detail: string | null }[]> {
  const { rows } = await db.query(
    `select thread_id, error_detail from decisions
     where status = 'failed' and created_at >= to_timestamp($1 / 1000.0)
     order by created_at`,
    [sinceMs]
  );
  return (rows as any[]).map((r) => ({ threadId: r.thread_id, detail: r.error_detail ?? null }));
}

async function correctionsCount(db: Querier, sinceMs: number): Promise<number> {
  const { rows } = await db.query(
    `select count(*) as n from corrections where created_at >= to_timestamp($1 / 1000.0)`,
    [sinceMs]
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Plain-text daily digest: how many emails routed themselves, how many are waiting on
 * a human, how many errored out (with detail), and how many corrections the office
 * made - built from three queries against `decisions`/`corrections` since `sinceMs`.
 */
export async function buildDigest(db: Querier, sinceMs: number): Promise<{ subject: string; body: string }> {
  const counts = await countsByStatus(db, sinceMs);
  const failures = await recentFailures(db, sinceMs);
  const corrections = await correctionsCount(db, sinceMs);

  const routed = counts.decided + counts.acted;
  const waiting = counts.needs_review;
  const errors = counts.failed;

  const subject = `[triage] daily digest — ${routed} routed, ${waiting} waiting, ${errors} errors`;

  const lines = [
    `Daily triage digest`,
    ``,
    `${routed} routed automatically.`,
    `${waiting} waiting for review.`,
    `${errors} failed and need a look.`,
    ``,
  ];

  if (failures.length) {
    lines.push(`Failures:`);
    for (const f of failures) lines.push(`  - ${f.threadId}: ${f.detail ?? "no detail recorded"}`);
    lines.push(``);
  }

  lines.push(
    corrections
      ? `${corrections} correction${corrections === 1 ? "" : "s"} observed from forwarded mail - the system is learning from them.`
      : `No corrections observed.`
  );

  return { subject, body: lines.join("\n") };
}

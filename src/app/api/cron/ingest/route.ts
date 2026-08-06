import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { makeGmail } from "@/lib/gmail";
import { makeClassifier } from "@/lib/classify";
import { buildTriageGraph } from "@/graph/triage";
import { normalize } from "@/lib/normalize";

export const maxDuration = 300;

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = getDb();
  const gmail = makeGmail();
  const graph = buildTriageGraph({ db, gmail, classify: makeClassifier() });

  const { rows } = await db.query(`select checkpoint_ms from ingest_state where id = 1`);
  const checkpoint = Number(rows[0].checkpoint_ms);
  const snapshots = await gmail.listNewThreads(checkpoint || Date.now() - 10 * 60 * 1000);

  let processed = 0, maxSeen = checkpoint;
  for (const snap of snapshots) {
    const seen = await db.query(`select 1 from threads where thread_id = $1`, [snap.threadId]);
    if (seen.rows.length) continue; // overlap dedupe (duplicates-over-holes)
    await graph.run(normalize(snap));
    processed++;
    maxSeen = Math.max(maxSeen, snap.internalDateMs);
  }
  // checkpoint advances only after all rows are durably written
  await db.query(
    `update ingest_state set checkpoint_ms = $1, last_success_at = now() where id = 1`, [maxSeen]
  );
  return NextResponse.json({ processed, checkpoint: maxSeen });
}

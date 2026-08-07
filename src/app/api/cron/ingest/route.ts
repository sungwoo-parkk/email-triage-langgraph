import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { makeGmail } from "@/lib/mail/gmail";
import { makeClassifier } from "@/lib/classify";
import { getOfficeConfig } from "@/lib/officeConfig";
import { buildTriageGraph } from "@/graph/triage";
import { getConfig } from "@/lib/config";
import { runIngestBatch } from "@/lib/ingest";

export const maxDuration = 300;

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = getDb();
  const officeCfg = await getOfficeConfig(db);
  if (!officeCfg) return NextResponse.json({ error: "office not configured" }, { status: 500 });
  const gmail = makeGmail();
  const graph = buildTriageGraph({ db, mail: gmail, classify: makeClassifier(officeCfg, []) });

  const { rows } = await db.query(`select checkpoint_ms from ingest_state where id = 1`);
  const checkpoint = Number(rows[0].checkpoint_ms);
  const snapshots = await gmail.listNewThreads(checkpoint || Date.now() - 10 * 60 * 1000);

  const cfg = await getConfig(db);
  const { processed, checkpointMs, failures } = await runIngestBatch(db, graph, snapshots, checkpoint, cfg.stage);

  // checkpoint advances only after all rows are durably written
  await db.query(
    `update ingest_state set checkpoint_ms = $1, last_success_at = now() where id = 1`, [checkpointMs]
  );
  return NextResponse.json({ processed, checkpoint: checkpointMs, failures });
}

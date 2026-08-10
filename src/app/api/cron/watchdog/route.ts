import { cronAuthorized } from "@/lib/cronAuth";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { makeGmail } from "@/lib/mail/gmail";
import { getOfficeConfig } from "@/lib/officeConfig";

export async function GET(req: Request) {
  if (!cronAuthorized(req))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb();
  // Config is the single source of truth for who gets alerted (no more ALERT_EMAIL
  // env var); a not-yet-onboarded deployment has no office config, so fail quiet
  // instead of alerting nobody or throwing.
  const officeCfg = await getOfficeConfig(db);
  if (!officeCfg) return NextResponse.json({ ok: true, note: "no office config" });

  const { rows } = await db.query(`select last_success_at from ingest_state where id = 1`);
  const last = rows[0]?.last_success_at ? new Date(rows[0].last_success_at).getTime() : 0;
  const silentMin = (Date.now() - last) / 60000;
  if (silentMin > 15) {
    await makeGmail().sendMessage(officeCfg.review.recipient, "[triage] ingestion silent",
      `No successful ingest run for ${Math.round(silentMin)} minutes.`);
    return NextResponse.json({ alerted: true, silentMin });
  }
  return NextResponse.json({ ok: true, silentMin });
}

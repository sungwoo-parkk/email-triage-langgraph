import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { makeGmail } from "@/lib/mail/gmail";

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { rows } = await getDb().query(`select last_success_at from ingest_state where id = 1`);
  const last = rows[0]?.last_success_at ? new Date(rows[0].last_success_at).getTime() : 0;
  const silentMin = (Date.now() - last) / 60000;
  if (silentMin > 15 && process.env.ALERT_EMAIL) {
    await makeGmail().sendMessage(process.env.ALERT_EMAIL, "[triage] ingestion silent",
      `No successful ingest run for ${Math.round(silentMin)} minutes.`);
    return NextResponse.json({ alerted: true, silentMin });
  }
  return NextResponse.json({ ok: true, silentMin });
}

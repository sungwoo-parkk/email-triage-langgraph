import { cronAuthorized } from "@/lib/cronAuth";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { makeGmail } from "@/lib/mail/gmail";
import { getOfficeConfig } from "@/lib/officeConfig";
import { buildDigest } from "@/lib/digest";

export async function GET(req: Request) {
  if (!cronAuthorized(req))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb();
  const officeCfg = await getOfficeConfig(db);
  if (!officeCfg) return NextResponse.json({ ok: true, note: "no office config" });

  const sinceMs = Date.now() - 24 * 3600_000;
  const { subject, body } = await buildDigest(db, sinceMs);
  await makeGmail().sendMessage(officeCfg.review.recipient, subject, body);
  return NextResponse.json({ ok: true, subject });
}

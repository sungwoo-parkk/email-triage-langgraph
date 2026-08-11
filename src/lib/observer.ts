import type { Querier } from "./db";
import type { MailClient, ThreadSnapshot } from "./mail/types";
import type { OfficeConfig } from "./officeConfig";
import { detectForwards } from "./forwardDetect";
import { TRIAGE_MARKER } from "./review";

export async function observeSentMail(db: Querier, mail: MailClient, cfg: OfficeConfig, nowMs: number) {
  const { rows } = await db.query(`select checkpoint_ms from ingest_state where id = 2`);
  const since = Number(rows[0]?.checkpoint_ms ?? 0) || nowMs - 24 * 3600_000;

  const sent = await mail.listNewThreads(since, { sent: true });
  if (!sent.length) return { corrections: 0, promoted: 0 };

  // At assisted+ stage, act.ts's own review-forwards (to cfg.review.recipient) land in this
  // same sent-mail feed - and review.recipient is typically ALSO a routee address (e.g. the
  // Hartley example's "jo"), so an unfiltered scan mistakes the system's own automated
  // forward for a human correction. 3 needs_review threads from one sender is then enough
  // to mint a bogus purity-1.0 learned rule from a "correction" no human ever made. Every
  // system-sent forward (review-forward or routee forward) starts with TRIAGE_MARKER
  // (review.ts's buildContextBody); a genuine human forward never does. Still counted
  // toward the checkpoint below - just excluded from correction detection - so they aren't
  // re-fetched forever.
  const humanSent = sent.filter((s) => !s.bodyText.includes(TRIAGE_MARKER));

  // Only threads the system knows about can be corrected.
  const known = await db.query(`select thread_id, from_addr, subject, internal_date_ms from threads`);
  const inbox: ThreadSnapshot[] = known.rows.map((r: any) => ({
    threadId: r.thread_id, from: r.from_addr, to: [], subject: r.subject, listId: null,
    attachments: [], bodyText: "", internalDateMs: Number(r.internal_date_ms), references: [],
  }));

  let corrections = 0;
  for (const g of detectForwards(humanSent, inbox, cfg.routees)) {
    const dec = await db.query(
      `select id, final_tasks, status from decisions where thread_id = $1 order by id desc limit 1`, [g.threadId]);
    if (!dec.rows.length) continue;
    // Measurement signal (spec 2026-08-10): every matched human forward is recorded,
    // agreement or not — v_agreement's denominator is decisions with >=1 observation.
    // Corrections below stay the learning signal, untouched.
    await db.query(
      `insert into observations (thread_id, decision_id, category_id) values ($1,$2,$3)
       on conflict (decision_id, category_id) do nothing`,
      [g.threadId, dec.rows[0].id, g.categoryId]);
    const tasks = typeof dec.rows[0].final_tasks === "string" ? JSON.parse(dec.rows[0].final_tasks) : dec.rows[0].final_tasks;
    const already = (tasks as any[]).some((t) => t.categoryId === g.categoryId);
    if (dec.rows[0].status !== "needs_review" && already) continue; // agreement, not a correction
    const dupe = await db.query(`select 1 from corrections where thread_id = $1 and category_id = $2`, [g.threadId, g.categoryId]);
    if (dupe.rows.length) continue;
    await db.query(
      `insert into corrections (thread_id, decision_id, category_id, observed_from) values ($1,$2,$3,'sent-forward')`,
      [g.threadId, dec.rows[0].id, g.categoryId]);
    corrections++;
  }

  const maxSent = Math.max(...sent.map((s) => s.internalDateMs), since);
  await db.query(`update ingest_state set checkpoint_ms = $1, last_success_at = now() where id = 2`, [maxSent]);
  const promoted = await promoteLearnedRules(db, cfg);
  return { corrections, promoted };
}

export async function promoteLearnedRules(db: Querier, _cfg: OfficeConfig): Promise<number> {
  const { rows } = await db.query(`
    select t.from_addr, c.category_id, count(*) as n
    from corrections c join threads t on t.thread_id = c.thread_id
    group by 1, 2`);
  let promoted = 0;
  const byAddr = new Map<string, { total: number; top: { cat: string; n: number } }>();
  for (const r of rows as any[]) {
    const cur = byAddr.get(r.from_addr) ?? { total: 0, top: { cat: "", n: 0 } };
    cur.total += Number(r.n);
    if (Number(r.n) > cur.top.n) cur.top = { cat: r.category_id, n: Number(r.n) };
    byAddr.set(r.from_addr, cur);
  }
  for (const [addr, { total, top }] of byAddr) {
    if (top.n >= 3 && top.n / total === 1) {
      const res = await db.query(
        `insert into rules (pattern_type, pattern, label_set, complete, purity, support, source)
         values ('sender_exact', $1, $2, true, 1, $3, 'learned') on conflict (pattern_type, pattern) do nothing returning id`,
        [addr, JSON.stringify([top.cat]), top.n]);
      promoted += res.rows.length;
    }
  }
  // sender_domain: same aggregation keyed on split_part(from_addr,'@',2), support >= 5, purity >= 0.9
  const dom = await db.query(`
    select split_part(t.from_addr,'@',2) as domain, c.category_id, count(*) as n
    from corrections c join threads t on t.thread_id = c.thread_id group by 1, 2`);
  const byDom = new Map<string, { total: number; top: { cat: string; n: number } }>();
  for (const r of dom.rows as any[]) {
    const cur = byDom.get(r.domain) ?? { total: 0, top: { cat: "", n: 0 } };
    cur.total += Number(r.n);
    if (Number(r.n) > cur.top.n) cur.top = { cat: r.category_id, n: Number(r.n) };
    byDom.set(r.domain, cur);
  }
  for (const [domain, { total, top }] of byDom) {
    if (top.n >= 5 && top.n / total >= 0.9) {
      const res = await db.query(
        `insert into rules (pattern_type, pattern, label_set, complete, purity, support, source)
         values ('sender_domain', $1, $2, true, $3, $4, 'learned') on conflict (pattern_type, pattern) do nothing returning id`,
        [domain, JSON.stringify([top.cat]), top.n / total, total]);
      promoted += res.rows.length;
    }
  }
  return promoted;
}

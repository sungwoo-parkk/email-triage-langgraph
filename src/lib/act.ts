import type { Querier } from "./db";
import type { MailClient } from "./mail/types";
import type { Action, Decision } from "./decide";
import type { AppConfig } from "./config";
import type { Vocabulary } from "./officeConfig";
import type { NormalizedEmail } from "./normalize";
import { buildContextBody } from "./review";

function permitted(action: Action, stage: AppConfig["stage"]): boolean {
  if (stage === "shadow") return false;
  if (stage === "assisted") return action.kind === "categories" || action.kind === "review-forward";
  return true; // autonomous
}

const keyOf = (a: Action) => JSON.stringify(a);
const parseJson = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;

/**
 * Builds the contextBodyFor(decisionId) callback executeDecision's ctx needs to send a
 * real forward body: it re-derives the Decision + NormalizedEmail from the decisions/
 * threads rows (not from in-memory state, since act can run independently of decide/
 * record - e.g. a retry) and renders it through review.ts's buildContextBody.
 */
export function makeContextBodyFor(db: Querier, vocab: Vocabulary): (decisionId: number) => Promise<string> {
  return async (decisionId: number): Promise<string> => {
    const { rows } = await db.query(
      `select d.confidence, d.status, d.final_tasks, d.actions_planned, d.llm_output,
              t.thread_id, t.from_addr, t.subject, t.list_id, t.attachments, t.body_excerpt, t.internal_date_ms
       from decisions d join threads t on t.thread_id = d.thread_id where d.id = $1`,
      [decisionId]
    );
    const row = rows[0];
    if (!row) throw new Error(`contextBodyFor: no decision ${decisionId}`);
    const llmOutput = row.llm_output ? parseJson<{ rationale?: string }>(row.llm_output) : null;
    const decision: Decision = {
      tasks: parseJson(row.final_tasks),
      confidence: row.confidence,
      status: row.status,
      actionsPlanned: parseJson(row.actions_planned),
      rationale: llmOutput?.rationale,
    };
    const email: NormalizedEmail = {
      threadId: row.thread_id,
      fromAddr: row.from_addr,
      fromDomain: row.from_addr.includes("@") ? row.from_addr.split("@").pop()! : row.from_addr,
      to: [],
      subject: row.subject,
      listId: row.list_id,
      attachments: parseJson(row.attachments),
      bodyExcerpt: row.body_excerpt,
      internalDateMs: Number(row.internal_date_ms),
      references: [],
    };
    return buildContextBody(email, decision, vocab);
  };
}

export async function executeDecision(
  db: Querier, mail: MailClient, decisionId: number, cfg: AppConfig,
  ctx: { vocab: Vocabulary; contextBodyFor(decisionId: number): Promise<string> }
): Promise<void> {
  const { rows } = await db.query(
    `select thread_id, status, actions_planned, actions_executed from decisions where id = $1`, [decisionId]
  );
  const row = rows[0];
  // needs_review decisions still reach this point (record -> act is unconditional) so
  // their planned review-forward can execute once the stage permits it; only the
  // per-action `permitted()` gate below decides what actually runs.
  if (!row) return;
  const planned: Action[] = parseJson(row.actions_planned);
  const executed: Action[] = parseJson(row.actions_executed);
  const done = new Set(executed.map(keyOf));

  let failed = false;
  for (const action of planned) {
    if (!permitted(action, cfg.stage) || done.has(keyOf(action))) continue;
    try {
      if (action.kind === "categories") {
        await mail.ensureCategories(action.labels);
        await mail.applyCategories(row.thread_id, action.labels);
      } else {
        // "forward" (routee) and "review-forward" (internal reviewer) both resolve to
        // the same MailClient primitive; the stage gate above is what tells them apart.
        await mail.forward(row.thread_id, action.to, await ctx.contextBodyFor(decisionId));
      }
      executed.push(action);
      // record immediately after success: a crash between actions can only skip, never repeat
      await db.query(`update decisions set actions_executed = $2 where id = $1`,
        [decisionId, JSON.stringify(executed)]);
    } catch (e) {
      failed = true;
      const detail = e instanceof Error ? e.message : String(e);
      console.error(`executeDecision ${decisionId} failed:`, detail);
      await db.query(`update decisions set status = 'failed', error_detail = $2 where id = $1`,
        [decisionId, detail]);
      break; // fail toward humans: stop acting, dashboard will surface it
    }
  }
  // needs_review decisions stay needs_review even after their review-forward executes -
  // a human still has to correct/confirm; only originally-decided rows graduate to 'acted'.
  if (!failed && cfg.stage !== "shadow" && row.status === "decided") {
    await db.query(`update decisions set status = 'acted' where id = $1`, [decisionId]);
  }
}

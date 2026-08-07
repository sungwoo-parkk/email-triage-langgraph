import type { Querier } from "./db";
import type { MailClient } from "./mail/types";
import type { Action } from "./decide";
import type { AppConfig } from "./config";

function permitted(action: Action, stage: AppConfig["stage"]): boolean {
  if (stage === "shadow") return false;
  if (stage === "assisted") return action.kind === "labels";
  return true; // autonomous
}

const keyOf = (a: Action) => JSON.stringify(a);

export async function executeDecision(
  db: Querier, gmail: MailClient, decisionId: number, cfg: AppConfig
): Promise<void> {
  const { rows } = await db.query(
    `select thread_id, status, actions_planned, actions_executed from decisions where id = $1`, [decisionId]
  );
  const row = rows[0];
  if (!row || row.status === "needs_review") return;
  const planned: Action[] = typeof row.actions_planned === "string" ? JSON.parse(row.actions_planned) : row.actions_planned;
  const executed: Action[] = typeof row.actions_executed === "string" ? JSON.parse(row.actions_executed) : row.actions_executed;
  const done = new Set(executed.map(keyOf));

  let failed = false;
  for (const action of planned) {
    if (!permitted(action, cfg.stage) || done.has(keyOf(action))) continue;
    try {
      if (action.kind === "labels") await gmail.applyCategories(row.thread_id, action.labels);
      else await gmail.forward(row.thread_id, action.to, "");
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
  if (!failed && cfg.stage !== "shadow") {
    await db.query(`update decisions set status = 'acted' where id = $1`, [decisionId]);
  }
}

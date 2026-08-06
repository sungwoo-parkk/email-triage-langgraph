import type { Querier } from "./db";
import type { NormalizedEmail } from "./normalize";
import { applyStructuralRules, type RuleOutcome } from "./rules";
import type { Classification } from "./classify";
import type { AppConfig } from "./config";

export interface TriageTask { labels: string[]; forwardTo: string | null }
export type Action = { kind: "labels"; labels: string[] } | { kind: "forward"; to: string };
export interface Decision {
  tasks: TriageTask[];
  confidence: "high" | "medium" | "low" | "rule";
  status: "decided" | "needs_review";
  actionsPlanned: Action[];
}

function planActions(tasks: TriageTask[]): Action[] {
  const labels = [...new Set(tasks.flatMap((t) => t.labels))];
  const actions: Action[] = labels.length ? [{ kind: "labels", labels }] : [];
  for (const t of tasks) if (t.forwardTo) actions.push({ kind: "forward", to: t.forwardTo });
  return actions;
}

export function decide(rule: RuleOutcome, llm: Classification | null, cfg: AppConfig): Decision {
  if (rule.complete) {
    const tasks: TriageTask[] = [{ labels: applyStructuralRules(rule.labels), forwardTo: rule.forwards[0] ?? null }];
    return { tasks, confidence: "rule", status: "decided", actionsPlanned: planActions(tasks) };
  }
  if (!llm) return { tasks: [], confidence: "low", status: "needs_review", actionsPlanned: [] };

  const tasks: TriageTask[] = llm.tasks.map((t) => ({
    labels: applyStructuralRules([...new Set([...t.labels, ...rule.labels])]),
    forwardTo: t.forward_to === "none" ? null : t.forward_to,
  }));
  const allowed = new Set(cfg.autoActLabels);
  const eligible = llm.confidence === "high" && tasks.every((t) => t.labels.every((l) => allowed.has(l)));
  return {
    tasks,
    confidence: llm.confidence,
    status: eligible ? "decided" : "needs_review",
    actionsPlanned: eligible ? planActions(tasks) : [],
  };
}

export async function recordDecision(
  db: Querier, email: NormalizedEmail, rule: RuleOutcome,
  llm: Classification | null, decision: Decision, stage: string
): Promise<number> {
  await db.query(
    "insert into threads (thread_id, from_addr, subject, attachments, list_id, body_excerpt, internal_date_ms) values ($1,$2,$3,$4,$5,$6,$7) on conflict (thread_id) do nothing",
    [email.threadId, email.fromAddr, email.subject, JSON.stringify(email.attachments),
     email.listId, email.bodyExcerpt, email.internalDateMs]
  );
  const { rows } = await db.query(
    "insert into decisions (thread_id, stage, rule_hits, llm_output, final_tasks, confidence, status, actions_planned) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
    [email.threadId, stage, JSON.stringify(rule.hits.map((h) => h.id ?? null)),
     llm ? JSON.stringify(llm) : null, JSON.stringify(decision.tasks),
     decision.confidence, decision.status, JSON.stringify(decision.actionsPlanned)]
  );
  return Number(rows[0].id);
}

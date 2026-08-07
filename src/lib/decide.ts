import type { Querier } from "./db";
import type { NormalizedEmail } from "./normalize";
import type { RuleOutcome } from "./rules";
import type { Classification } from "./classify";
import type { AppConfig } from "./config";
import type { Vocabulary } from "./officeConfig";

export interface TriageTask { categoryId: string; label: string; forwardTo: string | null }
export type Action =
  | { kind: "categories"; labels: string[] }
  | { kind: "forward"; to: string }
  | { kind: "review-forward"; to: string };
export interface Decision {
  tasks: TriageTask[];
  confidence: "high" | "medium" | "low" | "rule";
  status: "decided" | "needs_review";
  actionsPlanned: Action[];
  rationale?: string;
}

function resolveTasks(vocab: Vocabulary, categoryIds: string[]): TriageTask[] {
  return [...new Set(categoryIds)].map((id) => ({ categoryId: id, label: vocab.labelFor(id), forwardTo: vocab.routeFor(id) }));
}

function planActions(tasks: TriageTask[]): Action[] {
  const labels = [...new Set(tasks.map((t) => t.label))];
  const actions: Action[] = labels.length ? [{ kind: "categories", labels }] : [];
  for (const t of tasks) if (t.forwardTo) actions.push({ kind: "forward", to: t.forwardTo });
  return actions;
}

/**
 * rule-complete hits decide without the LLM at confidence "rule"; otherwise the LLM's
 * per-task category ids (merged with any rule-partial labels) decide at "high"
 * confidence when every category is in cfg.autoActLabels, else the decision is
 * needs_review with a planned review-forward — the review-forward is a planned action
 * like any other; the stage gate in act.ts decides whether it actually executes.
 */
export function decide(
  vocab: Vocabulary, reviewRecipient: string, rule: RuleOutcome, llm: Classification | null, cfg: AppConfig
): Decision {
  if (rule.complete) {
    const tasks = resolveTasks(vocab, rule.labels);
    return { tasks, confidence: "rule", status: "decided", actionsPlanned: planActions(tasks) };
  }
  const review = (conf: Decision["confidence"], tasks: TriageTask[] = [], rationale?: string): Decision =>
    ({ tasks, confidence: conf, status: "needs_review", actionsPlanned: [{ kind: "review-forward", to: reviewRecipient }], rationale });
  if (!llm) return review("low");
  const tasks = resolveTasks(vocab, [...llm.tasks.map((t) => t.category), ...rule.labels]);
  const allowed = new Set(cfg.autoActLabels);
  const eligible = llm.confidence === "high" && tasks.every((t) => allowed.has(t.categoryId));
  return eligible
    ? { tasks, confidence: llm.confidence, status: "decided", actionsPlanned: planActions(tasks), rationale: llm.rationale }
    : review(llm.confidence, tasks, llm.rationale);
}

export async function recordDecision(
  db: Querier, email: NormalizedEmail, rule: RuleOutcome,
  llm: Classification | null, decision: Decision, stage: string, configHash: string | null
): Promise<number> {
  await db.query(
    "insert into threads (thread_id, from_addr, subject, attachments, list_id, body_excerpt, internal_date_ms) values ($1,$2,$3,$4,$5,$6,$7) on conflict (thread_id) do nothing",
    [email.threadId, email.fromAddr, email.subject, JSON.stringify(email.attachments),
     email.listId, email.bodyExcerpt, email.internalDateMs]
  );
  const { rows } = await db.query(
    "insert into decisions (thread_id, stage, rule_hits, llm_output, final_tasks, confidence, status, actions_planned, config_hash) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id",
    [email.threadId, stage, JSON.stringify(rule.hits.map((h) => h.id ?? null)),
     llm ? JSON.stringify(llm) : null, JSON.stringify(decision.tasks),
     decision.confidence, decision.status, JSON.stringify(decision.actionsPlanned), configHash]
  );
  return Number(rows[0].id);
}

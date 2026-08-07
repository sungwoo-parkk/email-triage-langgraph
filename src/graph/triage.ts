import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import type { Querier } from "@/lib/db";
import type { MailClient } from "@/lib/mail/types";
import type { NormalizedEmail } from "@/lib/normalize";
import { loadActiveRules, matchRules, type RuleOutcome } from "@/lib/rules";
import type { Classification } from "@/lib/classify";
import { decide, recordDecision, type Decision } from "@/lib/decide";
import { executeDecision } from "@/lib/act";
import { getConfig, type AppConfig } from "@/lib/config";

const TriageState = Annotation.Root({
  email: Annotation<NormalizedEmail>,
  cfg: Annotation<AppConfig>,
  ruleResult: Annotation<RuleOutcome | null>({ reducer: (_, b) => b, default: () => null }),
  classification: Annotation<Classification | null>({ reducer: (_, b) => b, default: () => null }),
  decision: Annotation<Decision | null>({ reducer: (_, b) => b, default: () => null }),
  decisionId: Annotation<number | null>({ reducer: (_, b) => b, default: () => null }),
});

export function buildTriageGraph(deps: {
  db: Querier;
  gmail: MailClient;
  classify: (e: NormalizedEmail, r: RuleOutcome) => Promise<Classification>;
}) {
  const graph = new StateGraph(TriageState)
    .addNode("rules", async (s) => {
      const rules = await loadActiveRules(deps.db);
      return { ruleResult: matchRules(s.email, rules) };
    })
    .addNode("classify", async (s) => {
      try {
        return { classification: await deps.classify(s.email, s.ruleResult!) };
      } catch {
        return { classification: null }; // fail toward review (decide handles null)
      }
    })
    .addNode("decide", async (s) => ({ decision: decide(s.ruleResult!, s.classification, s.cfg) }))
    .addNode("record", async (s) => ({
      decisionId: await recordDecision(deps.db, s.email, s.ruleResult!, s.classification, s.decision!, s.cfg.stage),
    }))
    .addNode("act", async (s) => {
      await executeDecision(deps.db, deps.gmail, s.decisionId!, s.cfg);
      return {};
    })
    .addEdge(START, "rules")
    .addConditionalEdges("rules", (s) => (s.ruleResult!.complete ? "decide" : "classify"))
    .addEdge("classify", "decide")
    .addEdge("decide", "record")
    // record ALWAYS precedes act (spec: DB write before any Gmail action)
    .addConditionalEdges("record", (s) => (s.decision!.status === "needs_review" ? END : "act"))
    .addEdge("act", END)
    .compile();

  return {
    async run(email: NormalizedEmail): Promise<number> {
      const cfg = await getConfig(deps.db);
      const out = await graph.invoke({ email, cfg });
      return out.decisionId!;
    },
  };
}

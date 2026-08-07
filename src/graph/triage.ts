import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import type { Querier } from "@/lib/db";
import type { MailClient } from "@/lib/mail/types";
import type { NormalizedEmail } from "@/lib/normalize";
import { loadActiveRules, matchRules, type RuleOutcome } from "@/lib/rules";
import type { Classification } from "@/lib/classify";
import { decide, recordDecision, type Decision } from "@/lib/decide";
import { executeDecision, makeContextBodyFor } from "@/lib/act";
import { getConfig, type AppConfig } from "@/lib/config";
import { getOfficeConfig, deriveVocabulary, configHash, type Vocabulary } from "@/lib/officeConfig";

const TriageState = Annotation.Root({
  email: Annotation<NormalizedEmail>,
  cfg: Annotation<AppConfig>,
  vocab: Annotation<Vocabulary>,
  reviewRecipient: Annotation<string>,
  configHash: Annotation<string>,
  ruleResult: Annotation<RuleOutcome | null>({ reducer: (_, b) => b, default: () => null }),
  classification: Annotation<Classification | null>({ reducer: (_, b) => b, default: () => null }),
  decision: Annotation<Decision | null>({ reducer: (_, b) => b, default: () => null }),
  decisionId: Annotation<number | null>({ reducer: (_, b) => b, default: () => null }),
});

export function buildTriageGraph(deps: {
  db: Querier;
  mail: MailClient;
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
    .addNode("decide", async (s) => ({
      decision: decide(s.vocab, s.reviewRecipient, s.ruleResult!, s.classification, s.cfg),
    }))
    .addNode("record", async (s) => ({
      decisionId: await recordDecision(
        deps.db, s.email, s.ruleResult!, s.classification, s.decision!, s.cfg.stage, s.configHash
      ),
    }))
    .addNode("act", async (s) => {
      const ctx = { vocab: s.vocab, contextBodyFor: makeContextBodyFor(deps.db, s.vocab) };
      await executeDecision(deps.db, deps.mail, s.decisionId!, s.cfg, ctx);
      return {};
    })
    .addEdge(START, "rules")
    .addConditionalEdges("rules", (s) => (s.ruleResult!.complete ? "decide" : "classify"))
    .addEdge("classify", "decide")
    .addEdge("decide", "record")
    // record ALWAYS precedes act (spec: DB write before any Gmail action). needs_review
    // decisions now reach act too - their review-forward is a planned action like any
    // other, and act.ts's stage gate (not this edge) decides whether it executes.
    .addEdge("record", "act")
    .addEdge("act", END)
    .compile();

  return {
    async run(email: NormalizedEmail): Promise<number> {
      const cfg = await getConfig(deps.db);
      const officeCfg = await getOfficeConfig(deps.db);
      if (!officeCfg) throw new Error("triage graph: office is not configured (setOfficeConfig first)");
      // Office config is read once per run(), not per node, so every node in this
      // invocation sees the same vocabulary/reviewRecipient/configHash snapshot.
      const vocab = deriveVocabulary(officeCfg);
      const out = await graph.invoke({
        email, cfg, vocab, reviewRecipient: officeCfg.review.recipient, configHash: configHash(officeCfg),
      });
      return out.decisionId!;
    },
  };
}

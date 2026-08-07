import { z } from "zod";
import type { OfficeConfig } from "./officeConfig";
import { deriveVocabulary } from "./officeConfig";
import type { NormalizedEmail } from "./normalize";
import type { RuleOutcome } from "./rules";
import { buildSystemPrompt, emailPrompt, type Exemplar } from "./promptgen";

export function makeClassificationSchema(cfg: OfficeConfig) {
  const ids = deriveVocabulary(cfg).categoryIds as [string, ...string[]];
  return z.object({
    tasks: z.array(z.object({ category: z.enum(ids) })).min(1),
    confidence: z.enum(["high", "medium", "low"]),
    rationale: z.string(),
  });
}
export type Classification = z.infer<ReturnType<typeof makeClassificationSchema>>;

export interface ClassifierModel { invoke(messages: [string, string][]): Promise<unknown> }

async function defaultModel(cfg: OfficeConfig, schema: ReturnType<typeof makeClassificationSchema>): Promise<ClassifierModel> {
  const { initChatModel } = await import("langchain/chat_models/universal");
  const apiKey = process.env[cfg.llm.apiKeyEnv];
  if (!apiKey) throw new Error(`${cfg.llm.apiKeyEnv} is not set (required by llm.model=${cfg.llm.model})`);
  const llm = await initChatModel(cfg.llm.model, { temperature: 0, apiKey });
  return llm.withStructuredOutput(schema) as unknown as ClassifierModel;
}

export function makeClassifier(cfg: OfficeConfig, exemplars: Exemplar[], model?: ClassifierModel) {
  const schema = makeClassificationSchema(cfg);
  const system = buildSystemPrompt(cfg, exemplars);
  let m: ClassifierModel | undefined = model;
  return async (email: NormalizedEmail, ruleEvidence: RuleOutcome): Promise<Classification> => {
    m ??= await defaultModel(cfg, schema);
    const messages: [string, string][] = [["system", system], ["human", emailPrompt(email, ruleEvidence)]];
    try { return schema.parse(await m.invoke(messages)); }
    catch { return schema.parse(await m.invoke(messages)); } // one retry, then throw
  };
}

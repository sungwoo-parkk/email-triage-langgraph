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

// LangChain's own initChatModel provider registry spells Google's Gemini API
// "google-genai" (hyphenated); this app's config/PROVIDER_PACKAGES convention spells
// every provider id with underscores ("google_genai", "azure_openai", ...) to match how
// office owners type it in the onboarding interview. initChatModel infers the provider by
// splitting cfg.llm.model on ":" and checking its OWN key spelling — an unrecognized
// prefix (like our underscored "google_genai") isn't split off at all, so the whole
// "provider:model" string is handed to Gemini's own prefix-sniffing as if it were a bare
// model name, which fails. Translate explicitly instead of relying on that inference.
const LANGCHAIN_PROVIDER_ALIASES: Record<string, string> = { google_genai: "google-genai" };

async function defaultModel(cfg: OfficeConfig, schema: ReturnType<typeof makeClassificationSchema>): Promise<ClassifierModel> {
  const { initChatModel } = await import("langchain/chat_models/universal");
  const apiKey = process.env[cfg.llm.apiKeyEnv];
  if (!apiKey) throw new Error(`${cfg.llm.apiKeyEnv} is not set (required by llm.model=${cfg.llm.model})`);
  const [providerId, ...rest] = cfg.llm.model.split(":");
  const modelId = rest.join(":");
  const modelProvider = LANGCHAIN_PROVIDER_ALIASES[providerId] ?? providerId;
  const llm = await initChatModel(modelId, { modelProvider, temperature: 0, apiKey });
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

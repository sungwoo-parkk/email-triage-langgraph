import { z } from "zod";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { CLASSIFIABLE_LABELS, DESK_ALIASES } from "./labels";
import type { NormalizedEmail } from "./normalize";
import type { RuleOutcome } from "./rules";
import { TAXONOMY_PROMPT, emailPrompt } from "./prompt";

const labelEnum = z.enum(CLASSIFIABLE_LABELS as [string, ...string[]]);
const forwardEnum = z.enum([...DESK_ALIASES, "none"] as [string, ...string[]]);

export const ClassificationSchema = z.object({
  tasks: z.array(z.object({ labels: z.array(labelEnum).min(1), forward_to: forwardEnum })).min(1),
  confidence: z.enum(["high", "medium", "low"]),
  rationale: z.string(),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export interface ClassifierModel {
  invoke(messages: [string, string][]): Promise<unknown>;
}

function defaultModel(): ClassifierModel {
  const llm = new ChatGoogleGenerativeAI({
    model: process.env.GEMINI_MODEL ?? "gemini-3.6-flash",
    temperature: 0,
    apiKey: process.env.GEMINI_API_KEY,
  });
  return llm.withStructuredOutput(ClassificationSchema) as unknown as ClassifierModel;
}

export function makeClassifier(model?: ClassifierModel) {
  const m = model ?? defaultModel();
  return async (email: NormalizedEmail, ruleEvidence: RuleOutcome): Promise<Classification> => {
    const messages: [string, string][] = [
      ["system", TAXONOMY_PROMPT],
      ["human", emailPrompt(email, ruleEvidence)],
    ];
    try {
      return ClassificationSchema.parse(await m.invoke(messages));
    } catch {
      return ClassificationSchema.parse(await m.invoke(messages)); // one retry, then throw
    }
  };
}

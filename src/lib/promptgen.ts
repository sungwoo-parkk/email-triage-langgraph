import type { OfficeConfig } from "./officeConfig";
import { deriveVocabulary } from "./officeConfig";
import type { LabeledThread } from "./mining";

export interface Exemplar { categoryId: string; fromAddr: string; subject: string; bodyExcerpt: string; tier: "gold" | "llm" }

export const PROVIDER_PACKAGES: Record<string, string> = {
  openai: "@langchain/openai",
  anthropic: "@langchain/anthropic",
  google_genai: "@langchain/google-genai",
  mistralai: "@langchain/mistralai",
  groq: "@langchain/groq",
  ollama: "@langchain/ollama",
};

export function pickExemplars(labeled: LabeledThread[], perCategory = 2): Exemplar[] {
  const byCat = new Map<string, Exemplar[]>();
  const sorted = [...labeled].sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "gold" ? -1 : 1));
  for (const l of sorted) {
    if (l.categoryIds.length !== 1) continue; // unambiguous exemplars only
    const cat = l.categoryIds[0];
    const list = byCat.get(cat) ?? byCat.set(cat, []).get(cat)!;
    if (list.length < perCategory)
      list.push({ categoryId: cat, fromAddr: l.email.fromAddr, subject: l.email.subject,
        bodyExcerpt: l.email.bodyExcerpt.slice(0, 300), tier: l.tier });
  }
  return [...byCat.values()].flat();
}

export function buildSystemPrompt(cfg: OfficeConfig, exemplars: Exemplar[]): string {
  const vocab = deriveVocabulary(cfg);
  const catalog = vocab.categoryIds
    .map((id) => `- "${id}": ${vocab.describe(id)}`)
    .join("\n");
  const examples = exemplars.length
    ? "\n\nEXAMPLES from this office's own mail:\n" + exemplars
        .map((e) => `[${e.categoryId}] From: ${e.fromAddr} | Subject: ${e.subject}\n${e.bodyExcerpt}`)
        .join("\n---\n")
    : "";
  return `You triage inbound email for ${cfg.office.name} (${cfg.office.mailbox}).
Assign every email one task per distinct request, each task naming exactly one category id.

Categories:
${catalog}

Confidence: "high" only when a typical dispatcher at this office would certainly agree;
"medium" when plausible alternatives exist; "low" when genuinely unsure. Uncertain mail is
reviewed by a human - prefer honest "medium"/"low" over guessed "high".${examples}`;
}

export function emailPrompt(e: { fromAddr: string; subject: string; listId: string | null; attachments: string[]; bodyExcerpt: string },
  ruleEvidence: { labels: string[] }): string {
  return [
    `From: ${e.fromAddr}`, `Subject: ${e.subject}`, `List-Id: ${e.listId ?? "(none)"}`,
    `Attachments: ${e.attachments.join(", ") || "(none)"}`,
    ruleEvidence.labels.length ? `Deterministic rules already suggest: ${ruleEvidence.labels.join(", ")}` : "",
    ``, `Body:`, e.bodyExcerpt || "(empty)",
  ].filter(Boolean).join("\n");
}

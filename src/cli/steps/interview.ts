import { createInterface } from "node:readline/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseOfficeConfig, type OfficeConfig } from "../../lib/officeConfig";

export interface RouteeAnswer { name: string; email: string; description: string }

export interface InterviewAnswers {
  officeName: string;
  mailbox: string;
  routees: RouteeAnswer[];
  reviewRecipient: string;
  llmModel: string; // "provider:model", e.g. "anthropic:claude-sonnet-5"
  mining?: { months?: number; maxThreads?: number };
}

// Provider prefix (the part of llm.model before ":") -> the env var that must hold its API key.
// Mirrors promptgen.ts's PROVIDER_PACKAGES key set; kept separate because the two maps serve
// different concerns (npm package to install vs. env var to read a credential from).
const PROVIDER_API_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google_genai: "GEMINI_API_KEY",
  mistralai: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  ollama: "OLLAMA_UNUSED",
};

export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

/** Pure: turns interview answers into a validated OfficeConfig. No I/O. */
export function interviewToConfig(answers: InterviewAnswers): OfficeConfig {
  const provider = answers.llmModel.split(":")[0];
  const apiKeyEnv = PROVIDER_API_KEY_ENV[provider];
  if (!apiKeyEnv)
    throw new Error(`unknown LLM provider "${provider}" in llm model "${answers.llmModel}" — expected one of ${Object.keys(PROVIDER_API_KEY_ENV).join(", ")}`);

  const routees = answers.routees.map((r) => ({
    id: slugify(r.name), name: r.name, email: r.email, description: r.description,
  }));

  return parseOfficeConfig({
    version: 1,
    office: { name: answers.officeName, mailbox: answers.mailbox },
    routees,
    categories: [],
    review: { recipient: answers.reviewRecipient },
    llm: { model: answers.llmModel, apiKeyEnv },
    mining: answers.mining ?? {},
  });
}

async function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return (await rl.question(question)).trim();
}

/** Interactive wrapper: collects the same answers interviewToConfig needs, then writes triage.config.json. */
export async function runInterview(configPath = path.join(process.cwd(), "triage.config.json")): Promise<OfficeConfig> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Let's set up email triage for your office.\n");
    const officeName = await ask(rl, "Office name: ");
    const mailbox = await ask(rl, "Shared mailbox to triage (e.g. info@yourfirm.example): ");

    const routees: RouteeAnswer[] = [];
    console.log("\nNow the people/desks mail gets routed to. Leave the name blank when you're done.\n");
    for (;;) {
      const name = await ask(rl, `Routee ${routees.length + 1} name (blank to finish): `);
      if (!name) break;
      const email = await ask(rl, `  ${name}'s email: `);
      const description = await ask(rl, `  What kind of mail goes to ${name}? `);
      routees.push({ name, email, description });
    }
    if (!routees.length) throw new Error("at least one routee is required");

    const reviewRecipient = await ask(rl, "\nWho should review email the system is unsure about? (email): ");
    const llmModel = await ask(rl, "LLM model to classify with (provider:model, e.g. anthropic:claude-sonnet-5): ");

    const cfg = interviewToConfig({ officeName, mailbox, routees, reviewRecipient, llmModel });

    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
    console.log(`\nWrote ${configPath} — please review:\n`);
    console.log(JSON.stringify(cfg, null, 2));
    return cfg;
  } finally {
    rl.close();
  }
}

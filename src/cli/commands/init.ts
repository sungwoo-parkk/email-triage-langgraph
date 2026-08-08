import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { CliArgs } from "../main";
import { runInterview } from "../steps/interview";
import { connectStep } from "../steps/connect";
import { runMiningPipeline, writeArtifacts, withNoRules, type ClassifyFn } from "../steps/mine";
import { runDeploy } from "../steps/deploy";
import { loadOfficeConfig, deriveVocabulary, type OfficeConfig } from "../../lib/officeConfig";
import { makeClassifier } from "../../lib/classify";
import { makeGmail } from "../../lib/mail/gmail";
import { makeFakeMail } from "../../lib/mail/fake";
import type { ThreadSnapshot } from "../../lib/mail/types";
import { getDb } from "../../lib/db";

const ARTIFACTS_DIR = path.join(process.cwd(), ".triage");
const DRY_RUN_HISTORY = path.join(process.cwd(), "examples/hartley/history.json");
const DRY_RUN_CONFIG = path.join(process.cwd(), "examples/hartley/triage.config.json");

export async function run(args: CliArgs): Promise<void> {
  if (args.dryRun) return runDryRun();

  const cfg: OfficeConfig = args.config ? loadOfficeConfig(args.config) : await runInterview();

  console.log(`\n=== Connecting Gmail for ${cfg.office.mailbox} ===`);
  await connectStep(cfg);

  console.log(`\n=== Mining ${cfg.office.name}'s mail history ===`);
  const mail = makeGmail();
  const silverClassify = withNoRules(makeClassifier(cfg, []));
  const artifacts = await runMiningPipeline(mail, cfg, silverClassify);
  writeArtifacts(ARTIFACTS_DIR, artifacts);
  console.log(`\nWrote artifacts to ${ARTIFACTS_DIR}`);

  console.log(`\n=== Deploying ===`);
  await runDeploy({ db: getDb(), cfg, artifactsDir: ARTIFACTS_DIR, secrets: gatherSecrets(cfg) });
}

function gatherSecrets(cfg: OfficeConfig): Record<string, string> {
  const keys = [
    "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN",
    "GMAIL_USER", cfg.llm.apiKeyEnv, "CRON_SECRET",
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  if (!out.CRON_SECRET) out.CRON_SECRET = randomBytes(24).toString("hex");
  return out;
}

/**
 * `--dry-run`: swaps makeGmail() for makeFakeMail() seeded from examples/hartley/history.json
 * and skips deploy — the README's zero-credential demo path. Silver-labeling uses a small
 * offline heuristic classifier (offlineClassify below), never the real `llm.model` call:
 * makeClassifier(cfg, []) requires cfg.llm.apiKeyEnv to be set, which would silently spend
 * real API credits on every run of the one command the README promises needs "no API keys."
 */
async function runDryRun(): Promise<void> {
  if (!existsSync(DRY_RUN_HISTORY))
    throw new Error("dry-run requires examples/hartley/history.json (added in a later task)");

  const raw = JSON.parse(readFileSync(DRY_RUN_HISTORY, "utf8")) as { inbox?: ThreadSnapshot[]; sent?: ThreadSnapshot[] };
  const cfg = loadOfficeConfig(DRY_RUN_CONFIG);
  const mail = makeFakeMail(raw);
  // Eval must stay offline too - runMiningPipeline's holdout scorer defaults to a real
  // model call (see Task 12 report), which would silently break --dry-run's "no API keys"
  // promise the moment a real office's history is large enough to produce a holdout.
  const artifacts = await runMiningPipeline(mail, cfg, offlineClassify(cfg), console.log, offlineClassify(cfg));
  writeArtifacts(ARTIFACTS_DIR, artifacts);
  console.log(`\nDry run complete. Wrote artifacts to ${ARTIFACTS_DIR} (deploy skipped — this was --dry-run).`);
  console.log(`Open ${path.join(ARTIFACTS_DIR, "triage-report.html")} to see the report.`);
}

/**
 * Keyword-heuristic stand-in for the real classifier, used only by --dry-run. It's a rough
 * approximation of what examples/hartley's own LLM (google_genai:gemini-3.6-flash) would
 * say about examples/hartley/history.json's fixture mail — good enough to demonstrate the
 * pipeline's shape (rules mined, a report rendered) offline; not a claim about real
 * classification quality. A real `triage init` (no --dry-run) always uses
 * makeClassifier(cfg, []), the actual model call.
 *
 * Exported so tests (Task 12's integration test) can reuse it instead of duplicating a
 * near-identical keyword stub.
 */
export function offlineClassify(cfg: OfficeConfig): ClassifyFn {
  const vocab = deriveVocabulary(cfg);
  return async (email) => {
    if (email.listId)
      return { tasks: [{ category: "junk" }], confidence: "high", rationale: "Carries a List-Id header — a newsletter or automated list, not a request." };
    const text = `${email.subject} ${email.bodyExcerpt}`.toLowerCase();
    const categories = new Set<string>();
    if (/quote|pricing|price|availability|in stock/.test(text)) categories.add("sales");
    if (/order|status|return|damaged|missing|complaint|wrong|shipped|delivered|refund/.test(text)) categories.add("support");
    if (/invoice|billing|payment|balance|statement/.test(text)) categories.add("jo");
    const known = [...categories].filter((c) => vocab.categoryIds.includes(c));
    if (known.length)
      return { tasks: known.map((category) => ({ category })), confidence: "high", rationale: "Offline heuristic classifier (--dry-run only; no LLM call)." };
    return { tasks: [{ category: "support" }], confidence: "medium", rationale: "Offline heuristic classifier found no clear keyword match (--dry-run only; no LLM call)." };
  };
}

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { CliArgs } from "../main";
import { runInterview } from "../steps/interview";
import { connectStep } from "../steps/connect";
import { runMiningPipeline, writeArtifacts, withNoRules } from "../steps/mine";
import { runDeploy } from "../steps/deploy";
import { loadOfficeConfig, type OfficeConfig } from "../../lib/officeConfig";
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
 * and skips deploy — the README's zero-credential demo path. That fixture is added in a later
 * task (Task 11); until then this fails clearly instead of throwing an fs ENOENT deep in a
 * pipeline nobody asked it to run.
 */
async function runDryRun(): Promise<void> {
  if (!existsSync(DRY_RUN_HISTORY))
    throw new Error("dry-run requires examples/hartley/history.json (added in a later task)");

  const raw = JSON.parse(readFileSync(DRY_RUN_HISTORY, "utf8")) as { inbox?: ThreadSnapshot[]; sent?: ThreadSnapshot[] };
  const cfg = loadOfficeConfig(DRY_RUN_CONFIG);
  const mail = makeFakeMail(raw);
  const classify = withNoRules(makeClassifier(cfg, []));
  const artifacts = await runMiningPipeline(mail, cfg, classify);
  writeArtifacts(ARTIFACTS_DIR, artifacts);
  console.log(`\nDry run complete. Wrote artifacts to ${ARTIFACTS_DIR} (deploy skipped — this was --dry-run).`);
  console.log(`Open ${path.join(ARTIFACTS_DIR, "triage-report.html")} to see the report.`);
}

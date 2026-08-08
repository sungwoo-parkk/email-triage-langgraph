// The productized version of the case study's Task-12 deploy sequence: link the Vercel
// project, provision Neon, push secrets, migrate + seed from the mining artifacts, deploy to
// production, and smoke-test the deployed ingest endpoint once. Every external command is
// printed before it runs and gated on an explicit confirmation; every external command runs
// through execFileSync with an argument array (never a shell string); every secret goes over
// stdin, never argv, never a console.log.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { confirm } from "../confirm";
import type { Querier } from "../../lib/db";
import { resetDb } from "../../lib/db";
import type { OfficeConfig } from "../../lib/officeConfig";
import { setOfficeConfig } from "../../lib/officeConfig";
import { runMigrations } from "../../lib/migrate";
import { seedMinedRules } from "../../lib/mining";
import { setConfigKey } from "../../lib/config";
import { readArtifacts, type Artifacts } from "./mine";

async function step(description: string, cmd: string, args: string[]): Promise<void> {
  console.log(`\n> ${description}`);
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  if (!(await confirm("Run this now?"))) throw new Error(`deploy aborted at: ${description}`);
  execFileSync(cmd, args, { stdio: "inherit" });
}

/** Pushes a secret to Vercel env without ever putting the value in argv or a log line. */
async function pushEnv(key: string, value: string, target = "production"): Promise<void> {
  console.log(`\n> Push ${key} to Vercel (${target})`);
  console.log(`  $ vercel env add ${key} ${target}   [value piped via stdin, not shown]`);
  if (!(await confirm("Run this now?"))) throw new Error(`deploy aborted while pushing ${key}`);
  execFileSync("vercel", ["env", "add", key, target], { input: `${value}\n`, stdio: ["pipe", "inherit", "inherit"] });
}

function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!m) continue;
    let value = (m[2] ?? "").trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    process.env[m[1]] = value;
  }
}

async function seedExemplars(db: Querier, exemplars: { categoryId: string; fromAddr: string; subject: string; bodyExcerpt: string; tier: string }[]): Promise<void> {
  for (const e of exemplars) {
    await db.query(
      `insert into exemplars (category_id, from_addr, subject, body_excerpt, tier) values ($1, $2, $3, $4, $5)`,
      [e.categoryId, e.fromAddr, e.subject, e.bodyExcerpt, e.tier]
    );
  }
}

/**
 * The DB-writing half of deploy, pulled out of runDeploy so it's testable without mocking
 * the Vercel CLI / interactive confirm() prompts that surround it.
 */
export async function seedDatabase(db: Querier, cfg: OfficeConfig, artifacts: Artifacts): Promise<{ insertedRules: number }> {
  await runMigrations(db);
  await setOfficeConfig(db, cfg);
  const insertedRules = await seedMinedRules(db, artifacts.minedRules);
  await seedExemplars(db, artifacts.exemplars);
  // Finding C1: strongCategoryIds was display-only - the onboarding report told the office
  // these categories would auto-route, but nothing ever wrote the runtime allow-list
  // (config.autoActLabels) that decide() actually checks, so every LLM decision stayed
  // needs_review forever even after promotion. Seed it here from the same eval the report
  // renders. Live correction-driven updates to this allow-list (as opposed to the *rules*
  // table, which promoteLearnedRules in observer.ts already grows from corrections) are a
  // follow-up - spec §2's second half.
  await setConfigKey(db, "autoActLabels", artifacts.evalReport?.strongCategoryIds ?? []);
  return { insertedRules };
}

async function deployToProduction(): Promise<string> {
  console.log(`\n> Deploy to production`);
  console.log(`  $ vercel deploy --prod`);
  if (!(await confirm("Run this now?"))) throw new Error("deploy aborted before the production deploy");
  const output = execFileSync("vercel", ["deploy", "--prod"], { encoding: "utf8" });
  process.stdout.write(output);
  const url = output.trim().split("\n").pop()?.trim();
  if (!url || !url.startsWith("http"))
    throw new Error("could not read a deployment URL from `vercel deploy --prod` output — check the log above and finish the smoke test by hand.");
  return url;
}

async function smokeIngest(deployUrl: string, cronSecret: string): Promise<void> {
  console.log(`\n> Smoke-test the deployed ingest endpoint`);
  console.log(`  GET ${deployUrl}/api/cron/ingest   [Authorization header, secret not shown]`);
  if (!(await confirm("Run this now?"))) throw new Error("deploy aborted before the smoke ingest");
  const res = await fetch(`${deployUrl}/api/cron/ingest`, { headers: { authorization: `Bearer ${cronSecret}` } });
  if (!res.ok) throw new Error(`smoke ingest failed: HTTP ${res.status}`);
  console.log(`  smoke ingest OK (HTTP ${res.status})`);
}

export interface DeployOptions {
  /**
   * Lazily resolves the DB handle - call it only after DATABASE_URL exists (see resetDb()
   * below). Finding C4: init.ts used to pass an already-resolved `getDb()` Querier here,
   * captured before Neon was provisioned; that pins a pool to a dead/missing connection
   * string that migrations then fail against, even after the real DATABASE_URL is pulled
   * down later in this same function.
   */
  getDb: () => Querier;
  cfg: OfficeConfig;
  artifactsDir: string;
  /** env vars to push to Vercel — e.g. GOOGLE_OAUTH_*, GMAIL_USER, the LLM apiKeyEnv, CRON_SECRET. */
  secrets: Record<string, string>;
}

export async function runDeploy(opts: DeployOptions): Promise<void> {
  const { cfg, artifactsDir, secrets } = opts;

  await step("Link this project to Vercel", "vercel", ["link", "--yes"]);
  await step("Provision Neon Postgres via the Vercel Marketplace", "vercel", ["integration", "add", "neon"]);

  for (const [key, value] of Object.entries(secrets)) await pushEnv(key, value);

  console.log(`\n> Pull the provisioned DATABASE_URL (and other env) back down locally`);
  if (!(await confirm("Run this now?"))) throw new Error("deploy aborted before pulling env");
  execFileSync("vercel", ["env", "pull", ".env"], { stdio: "inherit" });
  loadEnvFile(path.join(process.cwd(), ".env"));

  // DATABASE_URL now exists in process.env for the first time this process has seen it
  // (Neon was just provisioned above, a few lines up). Drop any pool getDb() may have built
  // earlier — pre-provisioning — before resolving the real one (finding C4).
  resetDb();
  const db = opts.getDb();

  console.log(`\n> Run database migrations and seed from the mined artifacts`);
  const artifacts = readArtifacts(artifactsDir);
  const { insertedRules } = await seedDatabase(db, cfg, artifacts);
  console.log(`  seeded office config, ${insertedRules} rule(s), ${artifacts.exemplars.length} exemplar(s).`);

  const deployUrl = await deployToProduction();

  const cronSecret = secrets.CRON_SECRET ?? process.env.CRON_SECRET;
  if (cronSecret) await smokeIngest(deployUrl, cronSecret);
  else console.log(`\n> Skipping the smoke ingest — no CRON_SECRET available to authenticate it.`);

  console.log(`\nShadow mode is live. Open \`triage-report.html\` — that's what your office can expect.`);
}

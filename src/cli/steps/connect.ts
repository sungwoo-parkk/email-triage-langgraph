// Gmail connection step, extracted from the original scripts/authorize-gmail.ts (which is
// now a thin wrapper over authorizeGmail below) and parameterized by mailbox instead of a
// hardcoded pro@agency.example. Also installs the LLM provider package the office's config needs.
import http from "node:http";
import { existsSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { google } from "googleapis";
import type { OfficeConfig } from "../../lib/officeConfig";
import { PROVIDER_PACKAGES } from "../../lib/promptgen";

const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}`;
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

/**
 * Loopback OAuth flow: opens a local server on PORT, prints the consent URL, waits for the
 * redirect, exchanges the code for tokens, and verifies the authorized mailbox matches the
 * one the office config names (not just whoever happened to be signed in in the browser).
 * Returns the refresh token on success.
 */
export async function authorizeGmail(mailbox: string, log: (msg: string) => void = console.log): Promise<string> {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!id || !secret)
    throw new Error("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first (in .env) — see docs/onboarding.md.");

  const oauth2 = new google.auth.OAuth2(id, secret, REDIRECT);
  const url = oauth2.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });

  log(`\n1. Open this URL in a browser and sign in as ${mailbox}:\n`);
  log(url);
  log(`\n2. Approve access — you'll be redirected to ${REDIRECT}\n`);

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", REDIRECT);
      const code = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      if (!code && !err) { res.end(); return; } // favicon etc.
      res.end(code ? "Authorized — you can close this tab." : `Error: ${err}`);
      server.close();
      code ? resolve(code) : reject(new Error(err ?? "no code returned"));
    }).listen(PORT);
  });

  const { tokens } = await oauth2.getToken(code);
  const refreshToken = tokens.refresh_token;
  if (!refreshToken)
    throw new Error("no refresh_token returned — revoke the app's prior grant at myaccount.google.com/permissions and re-run");
  oauth2.setCredentials(tokens);

  // Verify we authorized the intended mailbox, not whoever was signed in.
  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  const { data } = await gmail.users.getProfile({ userId: "me" });
  if (data.emailAddress?.toLowerCase() !== mailbox.toLowerCase())
    throw new Error(`authorized ${data.emailAddress}, expected ${mailbox} — sign in as the target mailbox and re-run`);

  log(`AUTHORIZED as ${data.emailAddress}.`);
  return refreshToken;
}

/** Appends/updates a KEY=VALUE line in .env, creating the file if it doesn't exist yet. */
export function appendEnvVar(key: string, value: string, envPath = path.join(process.cwd(), ".env")): void {
  const line = `${key}=${value}`;
  if (!existsSync(envPath)) {
    writeFileSync(envPath, line + "\n");
  } else {
    const content = readFileSync(envPath, "utf8");
    if (new RegExp(`^${key}=`, "m").test(content)) {
      writeFileSync(envPath, content.replace(new RegExp(`^${key}=.*$`, "m"), line));
    } else {
      appendFileSync(envPath, (content.length && !content.endsWith("\n") ? "\n" : "") + line + "\n");
    }
  }
  console.log(`Added ${key} to ${envPath} (confirm it looks right before committing anything near it — .env is gitignored, but double-check).`);
}

function isPackageInstalled(pkg: string): boolean {
  return existsSync(path.join(process.cwd(), "node_modules", pkg));
}

/** npm i's the provider package the office's configured LLM model needs, if it isn't already present. */
export function ensureProviderPackage(model: string): void {
  const provider = model.split(":")[0];
  const pkg = PROVIDER_PACKAGES[provider];
  if (!pkg) throw new Error(`unknown LLM provider "${provider}" — expected one of ${Object.keys(PROVIDER_PACKAGES).join(", ")}`);
  if (isPackageInstalled(pkg)) return;
  console.log(`Installing ${pkg} for llm.model=${model}...`);
  execFileSync("npm", ["i", pkg], { stdio: "inherit" });
}

/** Full connect step used by `triage init`: authorize Gmail, persist the token, install the LLM package. */
export async function connectStep(cfg: OfficeConfig): Promise<void> {
  const refreshToken = await authorizeGmail(cfg.office.mailbox);
  appendEnvVar("GOOGLE_OAUTH_REFRESH_TOKEN", refreshToken);
  ensureProviderPackage(cfg.llm.model);
}

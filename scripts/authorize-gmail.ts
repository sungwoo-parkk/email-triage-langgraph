// One-time OAuth authorization for a single mailbox — run on a machine with a browser.
// Prereqs in .env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET (Desktop-app client from
// GCP; consent screen set to Internal). Prints the refresh token to add to .env / Vercel env.
// Re-run if the mailbox's password ever changes (Google revokes Gmail-scope refresh tokens on
// password change). The loopback flow itself now lives in src/cli/steps/connect.ts, shared with
// `triage init`'s connect step — this script is a thin wrapper for standalone/manual use.
import { authorizeGmail } from "../src/cli/steps/connect";

async function main() {
  const mailbox = process.env.GMAIL_USER ?? "pro@agency.example";
  const refreshToken = await authorizeGmail(mailbox);
  console.log(`\nAdd to .env (and Vercel env):\n`);
  console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${refreshToken}`);
}

main().catch((e) => { console.error("AUTHORIZE FAILED:", e.message); process.exit(1); });

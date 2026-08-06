// One-time OAuth authorization for pro@agency.example — run on a machine with a browser.
// Prereqs in .env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET (Desktop-app
// client from GCP; consent screen set to Internal). Prints the refresh token to add
// to .env / Vercel env. Re-run if pro@'s password ever changes (Google revokes
// Gmail-scope refresh tokens on password change).
import http from "node:http";
import { google } from "googleapis";

const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}`;
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

async function main() {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!id || !secret) {
    console.error("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first.");
    process.exit(1);
  }
  const oauth2 = new google.auth.OAuth2(id, secret, REDIRECT);
  const url = oauth2.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });

  console.log(`\n1. Open this URL in a browser and sign in as ${process.env.GMAIL_USER ?? "pro@agency.example"}:\n`);
  console.log(url);
  console.log(`\n2. Approve access — you'll be redirected to ${REDIRECT}\n`);

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
  if (!tokens.refresh_token)
    throw new Error("no refresh_token returned — revoke the app's prior grant at myaccount.google.com/permissions and re-run");
  oauth2.setCredentials(tokens);

  // Verify we authorized the intended mailbox, not whoever was signed in.
  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  const { data } = await gmail.users.getProfile({ userId: "me" });
  const expected = process.env.GMAIL_USER ?? "pro@agency.example";
  if (data.emailAddress?.toLowerCase() !== expected.toLowerCase())
    throw new Error(`authorized ${data.emailAddress}, expected ${expected} — sign in as the target mailbox and re-run`);

  console.log(`AUTHORIZED as ${data.emailAddress}. Add to .env (and Vercel env):\n`);
  console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`);
}

main().catch((e) => { console.error("AUTHORIZE FAILED:", e.message); process.exit(1); });

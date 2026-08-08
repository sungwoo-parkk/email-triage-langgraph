import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEnvVar } from "@/cli/steps/connect";

// Finding C3: connect.ts used to write GOOGLE_OAUTH_REFRESH_TOKEN to .env only. .env is
// loaded once, at process start (`--env-file-if-exists=.env`); a var written mid-run was
// invisible to process.env for the rest of that same run, so the already-running `triage
// init` process crashed the moment makeGmail() read process.env right after the OAuth
// dance the user had just completed. The fix is one assignment in appendEnvVar - these
// tests exercise it directly via its injectable envPath parameter (no real .env touched).
describe("appendEnvVar", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "triage-connect-"));
  const envPath = path.join(dir, ".env");

  afterEach(() => {
    delete process.env.TRIAGE_TEST_TOKEN;
  });

  it("writes the KEY=VALUE line to the given .env path", () => {
    appendEnvVar("TRIAGE_TEST_TOKEN", "abc123", envPath);
    expect(readFileSync(envPath, "utf8")).toContain("TRIAGE_TEST_TOKEN=abc123");
  });

  it("also sets process.env immediately, so the same already-running process can read it without a restart", () => {
    delete process.env.TRIAGE_TEST_TOKEN;
    appendEnvVar("TRIAGE_TEST_TOKEN", "xyz789", envPath);
    expect(process.env.TRIAGE_TEST_TOKEN).toBe("xyz789");
  });

  it("updates an existing key in place, in both the file and process.env, without duplicating the line", () => {
    appendEnvVar("TRIAGE_TEST_TOKEN", "first", envPath);
    appendEnvVar("TRIAGE_TEST_TOKEN", "second", envPath);
    const matches = readFileSync(envPath, "utf8").match(/TRIAGE_TEST_TOKEN=.*/g);
    expect(matches).toHaveLength(1);
    expect(matches![0]).toBe("TRIAGE_TEST_TOKEN=second");
    expect(process.env.TRIAGE_TEST_TOKEN).toBe("second");
  });
});

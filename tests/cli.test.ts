import { describe, it, expect } from "vitest";
import { parseCliArgs } from "@/cli/main";
import { interviewToConfig } from "@/cli/steps/interview";
import { writeArtifacts, readArtifacts } from "@/cli/steps/mine";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("parseCliArgs", () => {
  it("routes commands and flags", () => {
    expect(parseCliArgs(["init", "--dry-run"])).toEqual({ command: "init", dryRun: true, config: undefined, force: false });
    expect(parseCliArgs(["promote"])).toEqual({ command: "promote", dryRun: false, config: undefined, force: false });
    expect(() => parseCliArgs(["dance"])).toThrow(/unknown command/i);
  });
});

describe("interviewToConfig", () => {
  it("builds a valid office config from interview answers", () => {
    const cfg = interviewToConfig({
      officeName: "Hartley & Sons", mailbox: "info@hartleysons.example",
      routees: [{ name: "Jo Hartley", email: "jo@hartleysons.example", description: "Billing and invoices" }],
      reviewRecipient: "jo@hartleysons.example", llmModel: "anthropic:claude-sonnet-5",
    });
    expect(cfg.routees[0].id).toBe("jo-hartley"); // slugified
    expect(cfg.llm.apiKeyEnv).toBe("ANTHROPIC_API_KEY"); // derived from provider
    expect(cfg.categories.some((c) => c.id === "junk")).toBe(true);
  });
});

describe("artifacts round-trip", () => {
  it("writes and reads the .triage artifacts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "triage-"));
    const artifacts = {
      minedRules: [{ patternType: "sender_domain" as const, pattern: "x.example", categoryIds: ["jo"], purity: 1, support: 6, tier: "mined-gold" as const }],
      exemplars: [], holdout: [], evalReport: null, reportHtml: "<h1>r</h1>",
    };
    writeArtifacts(dir, artifacts as any);
    expect(readArtifacts(dir).minedRules[0].pattern).toBe("x.example");
  });
});

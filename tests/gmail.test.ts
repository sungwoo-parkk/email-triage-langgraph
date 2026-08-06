import { describe, it, expect } from "vitest";
import { buildQuery, buildForwardRaw } from "@/lib/gmail";

describe("buildQuery", () => {
  it("converts ms checkpoint to epoch-seconds after: with 1s overlap", () => {
    // 1_754_400_123_456 ms -> 1_754_400_123 s; overlap-1 => after:1754400122
    expect(buildQuery(1_754_400_123_456)).toBe("after:1754400122 -in:spam -in:trash");
  });
});

describe("buildForwardRaw", () => {
  it("builds base64url multipart MIME with the original attached as message/rfc822", () => {
    const raw = buildForwardRaw({
      to: "invoice@agency.example", from: "pro@agency.example", subject: "Fwd: March invoice",
      comment: "Auto-forwarded by triage.", originalRawB64url: Buffer.from("MIME-orig").toString("base64url"),
    });
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: invoice@agency.example");
    expect(decoded).toContain("From: pro@agency.example");
    expect(decoded).toContain("Subject: Fwd: March invoice");
    expect(decoded).toContain("Content-Type: message/rfc822");
    expect(decoded).toContain("MIME-orig");
    expect(raw).not.toMatch(/[+/=]/); // base64url, not base64
  });
});

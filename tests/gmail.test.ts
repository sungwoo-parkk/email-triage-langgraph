import { describe, it, expect } from "vitest";
import { buildQuery, buildForwardRaw } from "@/lib/gmail";

describe("buildQuery", () => {
  it("converts ms checkpoint to epoch-seconds after: with 1s overlap", () => {
    // 1_754_400_123_456 ms -> 1_754_400_123 s; overlap-1 => after:1754400122
    expect(buildQuery(1_754_400_123_456)).toBe("after:1754400122 -in:spam -in:trash");
  });
});

describe("buildForwardRaw", () => {
  const fwdOpts = {
    to: "invoice@agency.example", from: "pro@agency.example", subject: "Fwd: March invoice",
    comment: "Auto-forwarded by triage.", originalRawB64url: Buffer.from("MIME-orig").toString("base64url"),
  };

  it("builds base64url multipart MIME with the original attached as message/rfc822", () => {
    const raw = buildForwardRaw(fwdOpts);
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: invoice@agency.example");
    expect(decoded).toContain("From: pro@agency.example");
    expect(decoded).toContain("Subject: Fwd: March invoice");
    expect(decoded).toContain("Content-Type: message/rfc822");
    expect(decoded).toContain("MIME-orig");
    expect(raw).not.toMatch(/[+/=]/); // base64url, not base64
  });

  it("uses a boundary that actually delimits the MIME parts", () => {
    const raw = buildForwardRaw(fwdOpts);
    const decoded = Buffer.from(raw, "base64url").toString("utf8");

    const headerMatch = decoded.match(/Content-Type: multipart\/mixed; boundary="([^"]+)"/);
    expect(headerMatch).not.toBeNull();
    const boundary = headerMatch![1];

    // The boundary line (--boundary) must delimit at least two parts, and the
    // MIME must be closed with a terminating --boundary-- line.
    const delimiterOccurrences = decoded.split(`--${boundary}\r\n`).length - 1;
    expect(delimiterOccurrences).toBeGreaterThanOrEqual(2);
    expect(decoded).toContain(`--${boundary}--`);
  });

  it("generates a different boundary on each call (no static/predictable boundary)", () => {
    const raw1 = buildForwardRaw(fwdOpts);
    const raw2 = buildForwardRaw(fwdOpts);
    const decoded1 = Buffer.from(raw1, "base64url").toString("utf8");
    const decoded2 = Buffer.from(raw2, "base64url").toString("utf8");

    const boundary1 = decoded1.match(/Content-Type: multipart\/mixed; boundary="([^"]+)"/)![1];
    const boundary2 = decoded2.match(/Content-Type: multipart\/mixed; boundary="([^"]+)"/)![1];

    expect(boundary1).not.toBe(boundary2);
  });
});

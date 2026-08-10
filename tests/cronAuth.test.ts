import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { cronAuthorized } from "@/lib/cronAuth";

const ORIGINAL = process.env.CRON_SECRET;
const req = (auth?: string) =>
  new Request("http://x.example/cron", { headers: auth ? { authorization: auth } : {} });

describe("cronAuthorized", () => {
  beforeEach(() => { delete process.env.CRON_SECRET; });
  afterAll(() => { if (ORIGINAL) process.env.CRON_SECRET = ORIGINAL; });

  it('fails closed when CRON_SECRET is unset — "Bearer undefined" must NOT authenticate', () => {
    expect(cronAuthorized(req("Bearer undefined"))).toBe(false);
    expect(cronAuthorized(req())).toBe(false);
  });

  it("fails closed when CRON_SECRET is empty", () => {
    process.env.CRON_SECRET = "";
    expect(cronAuthorized(req("Bearer "))).toBe(false);
  });

  it("accepts only the exact bearer token when set", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(cronAuthorized(req("Bearer s3cret"))).toBe(true);
    expect(cronAuthorized(req("Bearer wrong"))).toBe(false);
    expect(cronAuthorized(req())).toBe(false);
  });
});

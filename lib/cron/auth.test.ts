import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isCronAuthorized } from "./auth.ts";

function reqWith(headers: Record<string, string>): Request {
  return new Request("https://example.com/api/reminders", { headers });
}

describe("cron authorization", () => {
  it("accepts a matching bearer token", () => {
    process.env.CRON_SECRET = "s3cret";
    assert.equal(isCronAuthorized(reqWith({ authorization: "Bearer s3cret" })), true);
  });

  it("rejects a wrong bearer token even with x-vercel-cron absent", () => {
    process.env.CRON_SECRET = "s3cret";
    assert.equal(isCronAuthorized(reqWith({ authorization: "Bearer wrong" })), false);
  });

  it("accepts Vercel Cron's automatic x-vercel-cron header", () => {
    process.env.CRON_SECRET = "s3cret";
    assert.equal(isCronAuthorized(reqWith({ "x-vercel-cron": "1" })), true);
  });

  it("stays open when no secret is configured (legacy behavior)", () => {
    delete process.env.CRON_SECRET;
    assert.equal(isCronAuthorized(reqWith({})), true);
  });
});

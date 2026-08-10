import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAdminSessionToken,
  isValidAdminSessionToken,
  verifyAdminPassword,
} from "./session.ts";
import { prepareKnowledgeForPrompt } from "./knowledge-format.ts";

describe("admin auth", () => {
  it("accepts the configured password and rejects others", () => {
    process.env.ADMIN_PASSWORD = "test-pass-123";
    process.env.ADMIN_SESSION_SECRET = "test-secret";
    assert.equal(verifyAdminPassword("test-pass-123"), true);
    assert.equal(verifyAdminPassword("wrong"), false);
  });

  it("builds and validates a session token", () => {
    process.env.ADMIN_PASSWORD = "test-pass-123";
    process.env.ADMIN_SESSION_SECRET = "test-secret";
    const now = Date.UTC(2026, 7, 10, 12, 0, 0);
    const token = buildAdminSessionToken(now);
    assert.equal(isValidAdminSessionToken(token, now + 1000), true);
    assert.equal(
      isValidAdminSessionToken(token, now + 8 * 24 * 60 * 60 * 1000),
      false,
    );
    assert.equal(isValidAdminSessionToken("v1.1.bad", now), false);
  });
});

describe("knowledge prep", () => {
  it("strips markdown noise for the model prompt", () => {
    const prepared = prepareKnowledgeForPrompt("## Hello\n**Bold** — dash");
    assert.match(prepared, /Hello/);
    assert.match(prepared, /Bold/);
    assert.doesNotMatch(prepared, /\*\*/);
    assert.match(prepared, /dash/);
  });
});

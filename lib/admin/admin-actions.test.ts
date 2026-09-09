import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  setPendingAdminAction,
  getPendingAdminAction,
  consumePendingAdminAction,
  clearPendingAdminAction,
} from "./admin-actions.ts";

describe("Pending Admin Action Store", () => {
  const testAdminPhone = "+999000000008";

  it("registers and consumes pending daily rundown action when admin replies 'Yes'", async () => {
    await clearPendingAdminAction(testAdminPhone);

    await setPendingAdminAction(testAdminPhone, "daily_rundown", {
      dateStr: "2026-09-09",
      customMessage: "Test Daily Rundown Content",
    });

    const pending = await getPendingAdminAction(testAdminPhone);
    assert.ok(pending, "must find pending action");
    assert.equal(pending.type, "daily_rundown");

    // Consume with "Yes"
    const res = await consumePendingAdminAction(testAdminPhone, "Yes");
    assert.equal(res.handled, true);
    assert.match(res.responseMessage || "", /rundown|Google Chat/i);

    // After consuming, action must be cleared
    const cleared = await getPendingAdminAction(testAdminPhone);
    assert.equal(cleared, null, "action must be cleared after execution");
  });

  it("cancels pending action without execution when admin replies 'Cancel' or 'No'", async () => {
    await clearPendingAdminAction(testAdminPhone);

    await setPendingAdminAction(testAdminPhone, "weekly_report", {
      summaryText: "Test Weekly Report Content",
    });

    const res = await consumePendingAdminAction(testAdminPhone, "Cancel");
    assert.equal(res.handled, true);
    assert.match(res.responseMessage || "", /cancelled/i);

    const cleared = await getPendingAdminAction(testAdminPhone);
    assert.equal(cleared, null);
  });

  it("returns handled: false when no pending action exists", async () => {
    await clearPendingAdminAction(testAdminPhone);

    const res = await consumePendingAdminAction(testAdminPhone, "Yes");
    assert.equal(res.handled, false);
  });
});

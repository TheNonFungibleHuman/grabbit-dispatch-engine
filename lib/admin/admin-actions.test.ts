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

  it("stale pending action never hijacks a bare 'Yes' (Uwase hijack regression)", async () => {
    const { writeJson } = await import("../blob/json-store.ts");
    await clearPendingAdminAction(testAdminPhone);

    // Simulate the real incident: rundown preview registered 1 hour ago (still
    // inside its expiry window), then the admin answers a BOOKING question with
    // a bare "Yes". That reply must reach the agent, not the report poster.
    await writeJson("grabbit/ops/pending-admin-actions.json", {
      actions: {
        "999000000008": {
          type: "daily_rundown",
          payload: { dateStr: "2026-09-17" },
          createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          expiresAt: Date.now() + 30 * 60 * 1000,
        },
      },
    });

    const bookingYes = await consumePendingAdminAction(testAdminPhone, "Yes");
    assert.equal(bookingYes.handled, false, "a stale preview must never consume a bare 'Yes'");
    const cleared = await getPendingAdminAction(testAdminPhone);
    assert.equal(cleared, null, "stale action must be cleared so the agent owns the conversation");

    // A FRESH preview still works: immediate 'Yes' posts the report (0 LLM tokens)
    await setPendingAdminAction(testAdminPhone, "daily_rundown", { dateStr: "2026-09-17" });
    const freshYes = await consumePendingAdminAction(testAdminPhone, "Yes");
    assert.equal(freshYes.handled, true, "a fresh preview must still accept an immediate confirmation");

    // Explicit booking instructions always pass through, even with a fresh preview
    await setPendingAdminAction(testAdminPhone, "daily_rundown", { dateStr: "2026-09-17" });
    const res2 = await consumePendingAdminAction(testAdminPhone, "Book Uwase trip for 8:45am");
    assert.equal(res2.handled, false);

    const res3 = await consumePendingAdminAction(testAdminPhone, "Reassign to Moses");
    assert.equal(res3.handled, false);

  });


  it("does NOT consume sentences that merely start with 'yes'", async () => {
    await clearPendingAdminAction(testAdminPhone);
    await setPendingAdminAction(testAdminPhone, "daily_rundown", { dateStr: "2026-09-17" });

    // "Yes Gabby is the one who booked..." is an answer about a booking, not a report approval
    const res = await consumePendingAdminAction(testAdminPhone, "Yes Gabby is the one who booked 12:30 pm");
    assert.equal(res.handled, false);
  });

  it("still consumes bare confirmations for report posting", async () => {
    await clearPendingAdminAction(testAdminPhone);
    await setPendingAdminAction(testAdminPhone, "daily_rundown", { dateStr: "2026-09-17" });

    const res = await consumePendingAdminAction(testAdminPhone, "go ahead");
    assert.equal(res.handled, true);
  });
});

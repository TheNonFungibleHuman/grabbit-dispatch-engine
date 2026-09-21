import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldSendLateReminder, shouldSendRideReminder } from "./reminders.ts";

describe("25-minute ride reminder window", () => {
  it("fires inside the 15-30 minute band", () => {
    assert.equal(shouldSendRideReminder(12 * 60, 12 * 60 - 25), true);
    assert.equal(shouldSendRideReminder(18 * 60, 18 * 60 - 20), true);
  });

  it("is inclusive at both boundaries", () => {
    assert.equal(shouldSendRideReminder(600, 585), true);
    assert.equal(shouldSendRideReminder(600, 570), true);
  });

  it("stays quiet outside the band", () => {
    assert.equal(shouldSendRideReminder(600, 586), false);
    assert.equal(shouldSendRideReminder(600, 569), false);
    assert.equal(shouldSendRideReminder(600, 600), false);
  });

  it("does not fire for already-passed or next-day slots", () => {
    assert.equal(shouldSendRideReminder(10, 23 * 60 + 55), false);
    assert.equal(shouldSendRideReminder(23 * 60 + 50, 10), false);
  });
});

describe("late catch-up reminder band (scheduler-delay resilience)", () => {
  it("fires when the scheduler first sees the booking 5-14 minutes out", () => {
    assert.equal(shouldSendLateReminder(600, 595), true); // 5 min
    assert.equal(shouldSendLateReminder(600, 586), true); // 14 min
  });

  it("does not double-fire inside the primary band (it owns the send)", () => {
    assert.equal(shouldSendLateReminder(600, 585), false); // 15 min — primary
    assert.equal(shouldSendLateReminder(600, 570), false); // 30 min — primary
  });

  it("stays quiet too early or too late", () => {
    assert.equal(shouldSendLateReminder(600, 569), false); // > 30... 31 min early
    assert.equal(shouldSendLateReminder(600, 601), false); // passed
  });
});

describe("processDailyRundownCron window check", () => {
  it("rejects times outside 8:30pm - 9:15pm Mauritius time", async () => {
    const { processDailyRundownCron } = await import("./daily-rundown.ts");
    // 12:00 PM Mauritius (08:00 UTC)
    const midday = new Date("2026-08-25T08:00:00.000Z");
    const res = await processDailyRundownCron(midday);
    assert.equal(res.triggered, false);
    assert.match(res.reason || "", /Not 8:30 PM Mauritius time/);
  });
});


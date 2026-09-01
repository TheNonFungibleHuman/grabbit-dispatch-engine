import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateDailyTripsRundown } from "./daily-rundown.ts";
import { generateWeeklyExecutiveReport } from "./weekly-report.ts";
import { ADMIN_PHONES } from "../riders/config.ts";

describe("rundown_dual_admin", () => {
  it("includes all authorized admin phones in recipients", () => {
    assert.ok(ADMIN_PHONES.includes("+999000000008"));
    assert.ok(ADMIN_PHONES.includes("+9990000000003"));
    assert.ok(ADMIN_PHONES.length >= 2);
  });

  it("generates daily trips rundown summary text cleanly", async () => {
    const rundown = await generateDailyTripsRundown("2026-09-01");
    assert.ok(rundown.summaryText);
    assert.ok(rundown.googleChatText);
    assert.match(rundown.summaryText, /Grabbit Daily Operations & Fares Rundown/i);
  });

  it("generates weekly executive report summary cleanly", async () => {
    const report = await generateWeeklyExecutiveReport(new Date("2026-09-01T12:00:00Z"));
    assert.ok(report.summaryText);
    assert.match(report.summaryText, /GRABBIT WEEKLY EXECUTIVE OPERATIONS & REVENUE REPORT/i);
    assert.ok(report.startDateIso);
    assert.ok(report.endDateIso);
  });
});

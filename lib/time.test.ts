import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addDaysIso,
  customerDateLabel,
  mauritiusClockLabel,
  mauritiusDateIso,
  mauritiusMinutesOfDay,
  mauritiusWeekday,
  resolveRelativeDateWord,
} from "./time.ts";
import { getRiderForTargetSlot } from "./schedule/availability.ts";

describe("mauritiusDateIso", () => {
  it("rolls to the next Mauritius day before midnight UTC", () => {
    const instant = new Date("2026-08-10T20:30:00.000Z");
    assert.equal(mauritiusDateIso(instant), "2026-08-11");
  });

  it("matches UTC date during the Mauritian working day", () => {
    const instant = new Date("2026-08-10T09:00:00.000Z");
    assert.equal(mauritiusDateIso(instant), "2026-08-10");
  });

  it("supports day offsets across month boundaries", () => {
    const instant = new Date("2026-08-31T15:00:00.000Z");
    assert.equal(mauritiusDateIso(instant, 1), "2026-09-01");
  });
});

describe("addDaysIso", () => {
  it("crosses months and years safely on pure date math", () => {
    assert.equal(addDaysIso("2026-12-31", 1), "2027-01-01");
    assert.equal(addDaysIso("2026-03-01", -1), "2026-02-28");
    assert.equal(addDaysIso("2026-08-24", 0), "2026-08-24");
  });
});

describe("mauritiusMinutesOfDay", () => {
  it("converts known instants correctly", () => {
    assert.equal(mauritiusMinutesOfDay(new Date("2026-08-10T03:30:00.000Z")), 7 * 60 + 30);
    assert.equal(mauritiusMinutesOfDay(new Date("2026-08-10T21:30:00.000Z")), 1 * 60 + 30);
    assert.equal(mauritiusMinutesOfDay(new Date("2026-08-10T16:00:00.000Z")), 20 * 60);
  });
});

describe("mauritiusClockLabel", () => {
  it("renders a 12-hour AM/PM label", () => {
    assert.match(mauritiusClockLabel(new Date("2026-08-10T09:05:00.000Z")), /1:05\s?PM/i);
    assert.match(mauritiusClockLabel(new Date("2026-08-10T04:45:00.000Z")), /8:45\s?AM/i);
  });
});

describe("resolveRelativeDateWord", () => {
  it("resolves today/tomorrow in Mauritius terms, not UTC", () => {
    const now = new Date("2026-08-10T21:30:00.000Z");
    assert.equal(resolveRelativeDateWord("today", now), "2026-08-11");
    assert.equal(resolveRelativeDateWord("tomorrow", now), "2026-08-12");
    assert.equal(resolveRelativeDateWord("nonsense", now), null);
  });
});

describe("customerDateLabel", () => {
  it("says 'today' for same-day bookings in Mauritius terms", () => {
    const now = new Date("2026-09-18T06:00:00.000Z"); // 10:00 MUT, Fri 18 Sept
    assert.equal(customerDateLabel("2026-09-18", now), "today");
  });

  it("restates weekday and date for tomorrow bookings", () => {
    const now = new Date("2026-09-18T06:00:00.000Z"); // Fri 18 Sept MUT
    assert.equal(customerDateLabel("2026-09-19", now), "tomorrow, Saturday 19 Sept");
  });

  it("uses Mauritius midnight, not UTC, when deciding 'tomorrow'", () => {
    const now = new Date("2026-09-18T21:30:00.000Z"); // already Sat 19 Sept 01:30 MUT
    assert.equal(customerDateLabel("2026-09-19", now), "today");
    assert.equal(customerDateLabel("2026-09-20", now), "tomorrow, Sunday 20 Sept");
  });

  it("restates plain weekday + date for bookings beyond tomorrow", () => {
    const now = new Date("2026-09-18T06:00:00.000Z");
    assert.equal(customerDateLabel("2026-09-21", now), "Monday 21 Sept");
  });

  it("crosses month boundaries safely", () => {
    const now = new Date("2026-09-30T06:00:00.000Z"); // Wed 30 Sept MUT
    assert.equal(customerDateLabel("2026-10-01", now), "tomorrow, Thursday 1 Oct");
  });

  it("falls back to the raw string for malformed dates", () => {
    const now = new Date("2026-09-18T06:00:00.000Z");
    assert.equal(customerDateLabel("not-a-date", now), "not-a-date");
  });
});

describe("mauritiusWeekday", () => {
  it("rolls the weekday at Mauritius midnight, not UTC midnight", () => {
    assert.equal(mauritiusWeekday(new Date("2026-08-16T21:00:00.000Z")), 1); // Sun 21:00 UTC = Mon 01:00 MUT
    assert.equal(mauritiusWeekday(new Date("2026-08-10T03:30:00.000Z")), 1); // Mon
    assert.equal(mauritiusWeekday(new Date("2026-08-11T12:00:00.000Z")), 2); // Tue
    assert.equal(mauritiusWeekday(new Date("2026-08-12T12:00:00.000Z")), 3); // Wed
    assert.equal(mauritiusWeekday(new Date("2026-08-13T12:00:00.000Z")), 4); // Thu
    assert.equal(mauritiusWeekday(new Date("2026-08-14T12:00:00.000Z")), 5); // Fri
    assert.equal(mauritiusWeekday(new Date("2026-08-15T15:00:00.000Z")), 6); // Sat
    assert.equal(mauritiusWeekday(new Date("2026-08-16T12:00:00.000Z")), 0); // Sun
  });
});


describe("getRiderForTargetSlot relative-date regression", () => {
  it("resolves 'tomorrow' using Mauritius midnight, not UTC midnight", async () => {
    const now = new Date("2026-08-10T21:30:00.000Z");
    const result = await getRiderForTargetSlot({
      targetDate: "tomorrow",
      targetTime: "12:00 pm",
      now,
    });
    assert.ok(result.slotKey.startsWith("2026-08-12_"), `expected MU tomorrow (08-12), got ${result.slotKey}`);
  });
});

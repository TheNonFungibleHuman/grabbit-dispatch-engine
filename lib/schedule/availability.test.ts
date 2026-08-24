import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateAvailability,
  isUnavailableCell,
  parseRiderScheduleCsv,
  parseTimeSlotLabel,
  ridersFromCell,
} from "./model.ts";

const sampleCsv = `TIME SLOT,MON,TUES,WED,THURS,FRI,SAT,SUN
8:00 am to 9:00 am,"MOSES, SHERIF",No Rider Available,MOSES,MOSES,MOSES,SHERIF,SHERIF
12:00 pm - 1:00 pm,MOSES,THIERRY(Delivery),MOSES,MOSES,MOSES,THIERRY(Delivery),No Rider Available
5:00 pm -6:00 pm,SHERIF,No Rider Available,SHERIF,No Rider Available,No Rider Available,THIERRY(Delivery),THIERRY(Delivery)
`;

describe("rider schedule parsing", () => {
  it("parses slot bounds and rider cells", () => {
    assert.deepEqual(parseTimeSlotLabel("8:00 am to 9:00 am"), {
      startMinutes: 8 * 60,
      endMinutes: 9 * 60,
    });
    assert.deepEqual(parseTimeSlotLabel("1:00 pm -2:00 pm"), {
      startMinutes: 13 * 60,
      endMinutes: 14 * 60,
    });
    assert.equal(isUnavailableCell("No Rider Available"), true);
    assert.deepEqual(ridersFromCell("MOSES, SHERIF"), ["MOSES", "SHERIF"]);

    const slots = parseRiderScheduleCsv(sampleCsv);
    assert.equal(slots.length, 3);
    assert.equal(slots[0]?.byDay.TUES, "No Rider Available");
  });

  it("marks Tuesday 08:30 as closed and suggests later open slots", () => {
    // 2026-08-11 is a Tuesday.
    const now = new Date("2026-08-11T04:30:00.000Z"); // 08:30 Mauritius (UTC+4)
    const snap = evaluateAvailability(parseRiderScheduleCsv(sampleCsv), now);
    assert.equal(snap.weekday, "TUES");
    assert.equal(snap.openNow, false);
    assert.equal(snap.nextOpenSlots[0]?.label, "12:00 pm - 1:00 pm");
  });

  it("marks Monday 08:30 as open", () => {
    // 2026-08-10 is a Monday.
    const now = new Date("2026-08-10T04:30:00.000Z"); // 08:30 Mauritius
    const snap = evaluateAvailability(parseRiderScheduleCsv(sampleCsv), now);
    assert.equal(snap.weekday, "MON");
    assert.equal(snap.openNow, true);
    assert.ok(snap.ridersNow.includes("MOSES"));
  });

  it("lists tomorrow's exact open slots when asked from Monday", () => {
    // Monday evening Mauritius.
    const now = new Date("2026-08-10T16:00:00.000Z"); // 20:00 Mauritius Monday
    const snap = evaluateAvailability(parseRiderScheduleCsv(sampleCsv), now);
    assert.equal(snap.weekday, "MON");
    const tomorrow = snap.upcomingDays.find((day) => day.daysAhead === 1);
    assert.equal(tomorrow?.weekday, "TUES");
    assert.deepEqual(
      tomorrow?.openSlots.map((slot) => slot.label),
      ["12:00 pm - 1:00 pm"],
    );
    assert.match(snap.summaryForAgent, /tomorrow \(TUES\) open slots/i);
    assert.match(snap.summaryForAgent, /12:00 pm - 1:00 pm — THIERRY/);
    assert.doesNotMatch(
      snap.summaryForAgent,
      /tomorrow \(TUES\)[^\n]*8:00 am to 9:00 am/,
    );
  });

  it("evaluates all 7 days of the week including Thursday and Friday", () => {
    const now = new Date("2026-08-10T04:30:00.000Z"); // Monday
    const snap = evaluateAvailability(parseRiderScheduleCsv(sampleCsv), now);
    assert.equal(snap.upcomingDays.length, 7);
    
    const thursday = snap.upcomingDays.find((d) => d.weekday === "THURS");
    assert.ok(thursday);
    assert.equal(thursday?.openSlots.some((s) => s.label === "8:00 am to 9:00 am"), true);

    const friday = snap.upcomingDays.find((d) => d.weekday === "FRI");
    assert.ok(friday);
    assert.equal(friday?.openSlots.some((s) => s.label === "8:00 am to 9:00 am"), true);

    assert.match(snap.summaryForAgent, /in 3 days \(THURS\)/i);
    assert.match(snap.summaryForAgent, /in 4 days \(FRI\)/i);
  });
});

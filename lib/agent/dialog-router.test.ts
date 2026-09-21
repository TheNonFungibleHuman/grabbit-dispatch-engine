import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeCustomerMessage, isDialogRouterEnabled } from "./dialog-router.ts";
import type { ChatTranscript, TranscriptEntry } from "./transcript.ts";

function entry(text: string, minutesAgo = 2): TranscriptEntry {
  return {
    at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    role: "customer",
    text,
  };
}

function transcript(entries: TranscriptEntry[]): ChatTranscript {
  return { senderPhone: "99900000012", updatedAt: new Date().toISOString(), entries };
}

describe("dialog router", () => {
  it("is enabled by default and disabled via env", () => {
    delete process.env.GRABBIT_DIALOG_ROUTER;
    assert.equal(isDialogRouterEnabled(), true);
    process.env.GRABBIT_DIALOG_ROUTER = "0";
    assert.equal(isDialogRouterEnabled(), false);
    process.env.GRABBIT_DIALOG_ROUTER = "off";
    assert.equal(isDialogRouterEnabled(), false);
    delete process.env.GRABBIT_DIALOG_ROUTER;
  });

  it("falls through when no intake exists", () => {
    const decision = routeCustomerMessage({
      text: "Hello",
      transcript: transcript([entry("Hello", 0)]),
    });
    assert.equal(decision.handled, false);
    assert.match(decision.reason, /^intake_incomplete/);
  });

  it("answers a single missing slot deterministically", () => {
    const decision = routeCustomerMessage({
      text: "tomorrow at 8:15 am",
      transcript: transcript([
        entry("I need a ride from ALCHE Campus to Mahogany tomorrow at 8:15 am", 3),
        entry("tomorrow at 8:15 am", 0),
      ]),
    });
    assert.equal(decision.handled, true);
    assert.match(decision.reason, /^ask_slot:paymentMethod$/);
    assert.match(decision.reply ?? "", /cash|Juice/i);
  });

  it("asks for the time when only time is missing", () => {
    const decision = routeCustomerMessage({
      text: "cash please",
      transcript: transcript([
        entry("ride from ALCHE Campus to Mahogany, I will pay cash", 2),
        entry("cash please", 0),
      ]),
    });
    assert.equal(decision.handled, true);
    assert.equal(decision.reason, "ask_slot:time");
  });

  it("reports all_slots_present on a fresh fully-specified conversation", () => {
    const decision = routeCustomerMessage({
      text: "yes book it",
      transcript: transcript([
        entry("I need a ride from ALCHE Campus to Mahogany at 2:30 pm, cash", 2),
        entry("yes book it", 0),
      ]),
    });
    assert.equal(decision.handled, false);
    assert.equal(decision.reason, "all_slots_present");
  });

  it("refuses to arm auto-booking on stale intake (older than 30 min)", () => {
    const decision = routeCustomerMessage({
      text: "yes",
      transcript: transcript([
        entry("I need a ride from ALCHE Campus to Mahogany at 2:30 pm, cash", 120),
        entry("yes", 0),
      ]),
    });
    assert.equal(decision.handled, false);
    assert.equal(decision.reason, "intake_stale");
  });

  it("never handles an empty message", () => {
    const decision = routeCustomerMessage({ text: "   ", transcript: transcript([]) });
    assert.equal(decision.handled, false);
    assert.equal(decision.reason, "empty");
  });
});

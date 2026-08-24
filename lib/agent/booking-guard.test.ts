import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fabricatedTrackingLinks } from "./booking-guard.ts";

const REAL = "https://delivery.grabbit-express.com/track/DEL_1/ABC";

describe("fabricatedTrackingLinks", () => {
  it("flags tracking links absent from the model context", () => {
    const reply = `Confirmed! 🔴 ${REAL}\nAlso https://delivery.grabbit-express.com/track/DEL_2/XYZ`;
    const forged = fabricatedTrackingLinks(reply, JSON.stringify({ messages: [{ content: REAL }] }));
    assert.equal(forged.length, 1);
    assert.match(forged[0], /DEL_2/);
  });

  it("allows links that genuinely appear in tool output or history", () => {
    const reply = `Your live link: ${REAL}`;
    const forged = fabricatedTrackingLinks(reply, `tool result echoed ${REAL} earlier`);
    assert.equal(forged.length, 0);
  });

  it("returns empty when the reply contains no links at all", () => {
    assert.equal(fabricatedTrackingLinks("No links here", "{}").length, 0);
  });
});

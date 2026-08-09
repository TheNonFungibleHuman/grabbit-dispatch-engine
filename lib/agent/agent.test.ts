import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGrabbitSystemInstruction } from "./prompt.ts";
import {
  clearPreviousInteractionId,
  getPreviousInteractionId,
  setPreviousInteractionId,
} from "./sessions.ts";

describe("buildGrabbitSystemInstruction", () => {
  it("includes Grabbit coverage areas from docs.md", () => {
    const prompt = buildGrabbitSystemInstruction();
    assert.match(prompt, /Grabbit Express/);
    assert.match(prompt, /Pamplemousses/);
    assert.match(prompt, /Triolet/);
    assert.match(prompt, /100% electric/i);
  });
});

describe("sessions", () => {
  it("stores previous interaction ids by normalized phone", () => {
    clearPreviousInteractionId("+99900000028");
    setPreviousInteractionId("+230 5519 8540", "int_123");
    assert.equal(getPreviousInteractionId("99900000028"), "int_123");
  });
});

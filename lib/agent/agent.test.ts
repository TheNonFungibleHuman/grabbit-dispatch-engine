import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeWhatsAppText } from "./format.ts";
import { buildGrabbitSystemInstruction } from "./prompt.ts";
import {
  clearPreviousInteractionId,
  getPreviousInteractionId,
  setPreviousInteractionId,
} from "./sessions.ts";

describe("buildGrabbitSystemInstruction", () => {
  it("includes Grabbit coverage areas and WhatsApp formatting rules", () => {
    const prompt = buildGrabbitSystemInstruction();
    assert.match(prompt, /Grabbit Express/);
    assert.match(prompt, /Pamplemousses/);
    assert.match(prompt, /Triolet/);
    assert.match(prompt, /100% electric/i);
    assert.match(prompt, /single asterisks/i);
    assert.match(prompt, /double dashes/i);
    assert.match(prompt, /Do not mix in anyone else's order/i);
    assert.match(prompt, /Smart guiding/i);
    assert.match(prompt, /Is that right/i);
    assert.match(prompt, /Known restaurants/i);
    assert.match(prompt, /book_kilo_delivery/);
    assert.match(prompt, /package photos/i);
    assert.match(prompt, /Delivering to this number/i);
    assert.match(prompt, /match_service_location/);
    assert.match(prompt, /Never mention Kilo/i);
    assert.match(prompt, /Trip \(passenger ride\)/i);
    assert.match(prompt, /team will get back/i);
    assert.match(prompt, /Never break character/i);
  });
});

describe("sanitizeWhatsAppText", () => {
  it("converts markdown bold to WhatsApp bold", () => {
    assert.equal(
      sanitizeWhatsAppText("Hello **Grabbit** friend"),
      "Hello *Grabbit* friend",
    );
  });

  it("removes double dashes and em dashes", () => {
    assert.equal(
      sanitizeWhatsAppText("Thanks -- we got it — pending"),
      "Thanks, we got it, pending",
    );
  });
});

describe("sessions", () => {
  it("keeps interaction ids isolated per customer phone", async () => {
    await clearPreviousInteractionId("+99900000028");
    await clearPreviousInteractionId("+99900000022");

    await setPreviousInteractionId("+230 5519 8540", "int_a");
    await setPreviousInteractionId("+99900000022", "int_b");

    assert.equal(await getPreviousInteractionId("99900000028"), "int_a");
    assert.equal(await getPreviousInteractionId("+99900000022"), "int_b");
    assert.notEqual(
      await getPreviousInteractionId("99900000028"),
      await getPreviousInteractionId("99900000022"),
    );
  });
});

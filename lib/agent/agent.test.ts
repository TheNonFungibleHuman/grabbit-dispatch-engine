import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sanitizeWhatsAppText } from "./format.ts";
import { prepareKnowledgeForPrompt } from "../admin/knowledge-format.ts";
import {
  clearPreviousInteractionId,
  getPreviousInteractionId,
  setPreviousInteractionId,
} from "./sessions.ts";

describe("buildGrabbitSystemInstruction", () => {
  it("includes Grabbit coverage areas and WhatsApp formatting rules", () => {
    // Read sources directly so the node strip-types runner does not need the
    // Next/Blob import graph used by the live async builder.
    const promptSource = readFileSync(
      join(process.cwd(), "lib/agent/prompt.ts"),
      "utf8",
    );
    const knowledge = prepareKnowledgeForPrompt(
      readFileSync(join(process.cwd(), "docs.md"), "utf8"),
    );

    assert.match(promptSource, /Grabbit Express/);
    assert.match(promptSource, /single asterisks/i);
    assert.match(promptSource, /double dashes/i);
    assert.match(promptSource, /Do not mix in anyone else's order/i);
    assert.match(promptSource, /Smart guiding/i);
    assert.match(promptSource, /Is that right/i);
    assert.match(promptSource, /book_kilo_delivery/);
    assert.match(promptSource, /pickup_delivery: at least 1 photo required/i);
    assert.match(promptSource, /errandMode=at_place or link: photos optional/i);
    assert.match(promptSource, /Delivering to this number/i);
    assert.match(promptSource, /match_service_location/);
    assert.match(promptSource, /Never mention Kilo/i);
    assert.match(promptSource, /Trip \(passenger ride\)/i);
    assert.match(promptSource, /team will get back/i);
    assert.match(promptSource, /Never claim an order\/delivery was placed/i);
    assert.match(promptSource, /ok:false means it was NOT placed/i);
    assert.match(
      promptSource,
      /Never book or claim an on-demand delivery while availability status is CLOSED/i,
    );
    assert.match(promptSource, /Mauritius time/i);
    assert.match(promptSource, /Never break character/i);

    assert.match(promptSource, /Triolet/);
    assert.match(knowledge, /Pamplemousses/);
    assert.match(knowledge, /100% electric/i);
    assert.match(knowledge, /Known restaurants/i);
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

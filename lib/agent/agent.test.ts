import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sanitizeWhatsAppText, isShortAcknowledgement } from "./format.ts";
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
    assert.match(promptSource, /Strict Domain Guardrail/i);
    assert.match(promptSource, /Payment Policy/i);
    assert.match(promptSource, /Never mention Kilo/i);
    assert.match(promptSource, /schedule_trip_or_delivery/i);
    assert.match(promptSource, /check_with_rider/i);
    assert.match(promptSource, /escalate_to_admin/i);

    assert.match(knowledge, /Pamplemousses/);
    assert.match(knowledge, /Menu Directory/i);
    assert.match(knowledge, /Official Pricing/i);
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

  it("strips love and heart emoji", () => {
    assert.equal(
      sanitizeWhatsAppText("Thanks for choosing Grabbit 💚"),
      "Thanks for choosing Grabbit",
    );
    assert.doesNotMatch(sanitizeWhatsAppText("Done ❤❤️"), /❤|💚|❤️/);
  });
});

describe("isShortAcknowledgement", () => {
  it("detects short acks that should not restart intake", () => {
    assert.equal(isShortAcknowledgement("nice"), true);
    assert.equal(isShortAcknowledgement("thanks!"), true);
    assert.equal(isShortAcknowledgement("yes"), false);
    assert.equal(isShortAcknowledgement("I want KFC Triolet"), false);
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

describe("buildAgentContextNote date filtering", () => {
  it("only includes current and future bookings for riders, ignoring past dates", async () => {
    const { buildAgentContextNote } = await import("./tools.ts");
    const { savePreBooking } = await import("../orders/pre-booking.ts");
    const { clearBookingIndexCache } = await import("../orders/booking-store.ts");

    // Add a past booking for Thierry
    await savePreBooking({
      id: "pb_ctx_past_thierry",
      customerPhone: "+99900000020",
      customerName: "Old Past Trip",
      serviceKind: "trip",
      pickupAddress: "ALCHE",
      deliveryAddress: "Mahogany",
      scheduledDate: "2020-01-01",
      scheduledTime: "10:00 am",
      slotKey: "2020-01-01_10:00-11:00",
      assignedRider: "Thierry",
      status: "confirmed",
      createdAt: "2020-01-01T06:00:00.000Z",
      updatedAt: "2020-01-01T06:00:00.000Z",
    });

    // Add a future booking for Thierry
    await savePreBooking({
      id: "pb_ctx_future_thierry",
      customerPhone: "+99900000021",
      customerName: "Future Trip",
      serviceKind: "trip",
      pickupAddress: "ALCHE",
      deliveryAddress: "Grand Baie",
      scheduledDate: "2031-12-12",
      scheduledTime: "2:00 pm",
      slotKey: "2031-12-12_1:30-3:30",
      assignedRider: "Thierry",
      status: "confirmed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    clearBookingIndexCache();

    // Thierry phone: +999000000009
    const note = await buildAgentContextNote({ senderPhone: "+999000000009" });
    assert.match(note, /Future Trip/);
    assert.doesNotMatch(note, /Old Past Trip/);
  });
});


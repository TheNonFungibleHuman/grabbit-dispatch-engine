import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeWhatsAppText } from "./format.ts";
import { isRepetitiveQuestionLoop } from "./booking-guard.ts";
import { resolveCustomerIdentity } from "../orders/customer-resolver.ts";
import { enforceAdminActionInvariants } from "./action-gateway.ts";
import { savePreBooking, createPreBookingRequest, recordPaymentProofReceived } from "../orders/pre-booking.ts";
import { recordPendingEscalation, getOpenCustomerEscalation } from "../ops/store.ts";
import { loadTranscript } from "./transcript.ts";
import { mauritiusDateIso } from "../time.ts";

describe("Today's Incident Audit (Wednesday, Sept 9, 2026) Regressions", () => {
  it("strips period-separated thought leaks without requiring leading newlines (Damini incident)", () => {
    const raw = "The customer wants a ride to ALCHE at 4:30pm. Let me clarify pickup location.Hello Damini! 👋 Thanks for reaching out to Grabbit Express!";
    const cleaned = sanitizeWhatsAppText(raw);
    assert.equal(cleaned, "Hello Damini! 👋 Thanks for reaching out to Grabbit Express!");

    const rawMulti = "Actually, the customer wants to go to Mahogany.\n\nHello Damini! 👋 Let me confirm your drop-off.";
    const cleanedMulti = sanitizeWhatsAppText(rawMulti);
    assert.equal(cleanedMulti, "Hello Damini! 👋 Let me confirm your drop-off.");
  });

  it("does not match 'me' as a substring of 'James Sanga' and forbids pronoun queries (James Sanga hallucination)", async () => {
    await savePreBooking({
      id: "pb_test_james_sanga_audit",
      customerPhone: "+99900000071",
      customerName: "James Sanga",
      serviceKind: "trip",
      pickupAddress: "ALCHE Campus",
      deliveryAddress: "Mahogany Promenade",
      scheduledDate: mauritiusDateIso(new Date()),
      scheduledTime: "5:00 pm",
      slotKey: `${mauritiusDateIso(new Date())}_17:00-18:00`,
      assignedRider: "Sherif",
      status: "confirmed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const resolved = await resolveCustomerIdentity("me");
    assert.equal(resolved, null, "'me' query must never resolve to James Sanga");

    const resolvedUs = await resolveCustomerIdentity("us");
    assert.equal(resolvedUs, null, "'us' query must never resolve to any customer");
  });

  it("does not treat admin inquiry 'Tell me what time is Peace's booking?' as a customer dispatch directive", async () => {
    const res = await enforceAdminActionInvariants({
      senderPhone: "+999000000008",
      isAdmin: true,
      incomingText: "Tell me what time is Peace's booking?",
      assistantText: "Peace has a booking at 5:30 PM today.",
      calledTools: new Set<string>(),
      messageId: "test_tell_me_msg_1",
    });

    assert.equal(res.actionsExecuted.length, 0, "must not execute any customer reply tool");
    assert.equal(res.text, "Peace has a booking at 5:30 PM today.");

    const jamesTranscript = await loadTranscript("99900000071");
    assert.equal(jamesTranscript.entries.length, 0, "must never send message to James Sanga");
  });

  it("does not trigger 'Alche at ALCHE' repetitive question loop fallback from internal context note (Peace incident)", () => {
    const contextNote = "[internal context note: customer_profile: Frequent/Last pickup=ALCHE, Last dropoff=Mahogany]";
    const repeatedQuestion = "Could you please let me know your drop-off location at ALCHE?";

    const historyWithContext = [
      { role: "assistant", content: "Could you share the exact drop-off location or residence at ALCHE?" },
      { role: "user", content: `${contextNote}\n\nCustomer message:\nCan I change the time to 5:30pm` },
    ];

    const loopResult = isRepetitiveQuestionLoop(repeatedQuestion, historyWithContext);
    assert.ok(!loopResult || !loopResult.includes("Alche at ALCHE"), "must not hallucinate Alche at ALCHE from context note");
  });

  it("auto-resolves open customer escalation when a booking is created or payment proof received (Juliette incident)", async () => {
    const customerPhone = "+99900000058";
    await recordPendingEscalation({
      customerPhone,
      customerName: "Juliette",
      reason: "Custom destination check",
    });

    const openBefore = await getOpenCustomerEscalation(customerPhone);
    assert.ok(openBefore, "escalation must be open initially");

    const today = mauritiusDateIso(new Date());
    await createPreBookingRequest({
      customerPhone,
      customerName: "Juliette",
      serviceKind: "trip",
      pickupAddress: "ALCHE",
      deliveryAddress: "Grand Baie",
      scheduledDate: today,
      scheduledTime: "6:00 pm",
      slotKey: `${today}_18:00-19:00`,
      assignedRider: "Thierry",
    });

    const openAfterBooking = await getOpenCustomerEscalation(customerPhone);
    assert.equal(openAfterBooking, null, "escalation must be auto-resolved when booking is confirmed");

    await recordPendingEscalation({
      customerPhone,
      customerName: "Juliette",
      reason: "Payment inquiry",
    });
    const openPaymentBefore = await getOpenCustomerEscalation(customerPhone);
    assert.ok(openPaymentBefore);

    await recordPaymentProofReceived({
      customerPhone,
      notes: "Transfer screenshot uploaded",
    });

    const openPaymentAfter = await getOpenCustomerEscalation(customerPhone);
    assert.equal(openPaymentAfter, null, "escalation must be auto-resolved when payment proof is received");
  });
});

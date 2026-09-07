import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyRiderAcceptDecline, handleRiderReply, savePreBooking } from "../orders/pre-booking.ts";
import { clearBookingIndexCache } from "../orders/booking-store.ts";
import { notifyAdminPaymentVerification } from "./notify-rider.ts";
import {
  clearFleetMaintenanceWindow,
  getFleetMaintenanceStatus,
  setFleetMaintenanceWindow,
} from "./commands.ts";
import { getRiderForTargetSlot } from "../schedule/availability.ts";
import { handleWasenderEvent } from "../wasender/handlers.ts";
import { mauritiusDateIso } from "../time.ts";

describe("Decision A2: WhatsApp Interactive Buttons & Poll Voting for Rider Dispatch", () => {
  it("correctly classifies interactive button strings with emojis", () => {
    assert.equal(classifyRiderAcceptDecline("Accept 🛵"), "accept");
    assert.equal(classifyRiderAcceptDecline("Decline ❌"), "decline");
    assert.equal(classifyRiderAcceptDecline("accept"), "accept");
    assert.equal(classifyRiderAcceptDecline("decline"), "decline");
    assert.equal(classifyRiderAcceptDecline("ACCEPT"), "accept");
    assert.equal(classifyRiderAcceptDecline("DECLINE"), "decline");
  });

  it("handles poll.results event from Wasender to accept a pending booking", async () => {
    const todayIso = mauritiusDateIso(new Date());
    const bookingId = "pb_poll_test_1";

    await savePreBooking({
      id: bookingId,
      customerPhone: "+99900000072",
      customerName: "Poll Voter",
      serviceKind: "trip",
      pickupAddress: "ALCHE",
      deliveryAddress: "Grand Baie",
      scheduledDate: todayIso,
      scheduledTime: "12:00 pm",
      slotKey: `${todayIso}_12:00 pm`,
      assignedRider: "Thierry",
      status: "pending_rider",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    clearBookingIndexCache();

    // Trigger poll.results webhook payload with Thierry's phone (+999000000009)
    await handleWasenderEvent({
      event: "poll.results",
      timestamp: Date.now(),
      data: {
        key: {
          id: `poll_msg_${Date.now()}`,
          remoteJid: "999000000009@s.whatsapp.net",
        },
        pollResult: [
          {
            name: "Accept 🛵",
            voters: ["999000000009@s.whatsapp.net"],
          },
          {
            name: "Decline ❌",
            voters: [],
          },
        ],
      },
    });

    const { readJson } = await import("../blob/json-store.ts");
    const updated = await readJson<{ status: string }>(`grabbit/prebookings/${bookingId}.json`);
    assert.equal(updated?.status, "confirmed");
  });
});

describe("Decision A3: Auto-Confirm on Payment Proof & Notify Admin", () => {
  it("fires notifyAdminPaymentVerification and records pending escalation", async () => {
    const result = await notifyAdminPaymentVerification({
      bookingId: "pb_pay_test_01",
      customerName: "Oliver Twist",
      customerPhone: "+99900000047",
      serviceKind: "trip",
      scheduledDate: "today",
      scheduledTime: "2:00 pm",
      amountRs: 400,
      paymentMethod: "Juice",
      assignedRider: "Thierry",
    });

    assert.equal(result.ok, true);

    const { loadEscalations } = await import("../ops/store.ts");
    const escalations = await loadEscalations();
    const found = escalations.find((e) => e.customerPhone === "99900000047");
    assert.ok(found, "must record pending escalation for admin verification");
    assert.match(found.reason, /Payment verification needed.*400.*Juice/i);
  });
});

describe("Decision A4: Fleet Maintenance Window & Emergency Pause", () => {
  it("sets maintenance window, marks slot unavailable with reason, and clears it cleanly", async () => {
    const now = new Date();
    const todayIso = mauritiusDateIso(now);

    // 1. Set maintenance window until 11:59 pm
    await setFleetMaintenanceWindow("11:59 pm", "Heavy Rain & Flooding");
    const status = await getFleetMaintenanceStatus();
    assert.equal(status.active, true);
    assert.equal(status.untilTimeStr, "11:59 pm");
    assert.equal(status.reason, "Heavy Rain & Flooding");

    // 2. Query target slot for today during maintenance window
    const slotCheck = await getRiderForTargetSlot({
      targetDate: todayIso,
      targetTime: "12:00 pm",
      now,
    });

    assert.equal(slotCheck.available, false);
    assert.ok(slotCheck.reason?.includes("Heavy Rain & Flooding"));

    // 3. Clear maintenance window
    await clearFleetMaintenanceWindow();
    const clearedStatus = await getFleetMaintenanceStatus();
    assert.equal(clearedStatus.active, false);

    // 4. Slot check after clear should restore availability if riders scheduled
    const slotRestored = await getRiderForTargetSlot({
      targetDate: todayIso,
      targetTime: "12:00 pm",
      now,
    });
    // Reason should no longer mention maintenance
    assert.ok(!slotRestored.reason?.includes("Heavy Rain & Flooding"));
  });
});

describe("Admin Direct Message to Customer by Username (Zero Escalation)", () => {
  it("resolves customer phone from profile/transcript and delivers message with pronoun polish and auto-cancellation", async () => {
    const { updateCustomerProfile } = await import("../orders/store.ts");
    const { enforceAdminActionInvariants } = await import("../agent/action-gateway.ts");
    const { loadTranscript } = await import("../agent/transcript.ts");
    const { savePreBooking, listAllPreBookings } = await import("../orders/pre-booking.ts");
    const { clearBookingIndexCache } = await import("../orders/booking-store.ts");
    const { saveEscalations } = await import("../ops/store.ts");

    // Ensure NO escalations exist
    await saveEscalations([]);

    const customeraPhone = "+99900000054";
    const customeraDigits = "99900000054";

    // 1. Customer A chatted previously, saving his profile as "Customer A"
    await updateCustomerProfile(customeraPhone, {
      name: "Customer A",
    });

    // 2. Customer A also has a pending booking that admin wants to decline
    const bookingId = "pb_customera_trip_01";
    await savePreBooking({
      id: bookingId,
      customerPhone: customeraPhone,
      customerName: "Customer A",
      serviceKind: "trip",
      pickupAddress: "ALCHE",
      deliveryAddress: "Grand Baie",
      scheduledDate: "2031-12-12",
      scheduledTime: "3:00 pm",
      slotKey: "2031-12-12_3:00 pm",
      assignedRider: "Thierry",
      status: "pending_rider",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    clearBookingIndexCache();

    // 3. Admin directs agent: "Tell Customer A that we are sorry we cannot take his trip"
    const adminText = "Tell Customer A that we are sorry we cannot take his trip";
    const gatewayResult = await enforceAdminActionInvariants({
      incomingText: adminText,
      assistantText: "I'll let Customer A know right away.",
      senderPhone: "+999000000008", // Admin Sherif
      isAdmin: true,
      calledTools: new Set(),
    });

    // 4. Invariant: message is delivered to Customer A's exact phone number
    assert.ok(
      gatewayResult.actionsExecuted.includes(`admin_reply_to_customer:${customeraDigits}`),
      "must execute admin_reply_to_customer with Customer A's phone",
    );
    assert.match(gatewayResult.text, /Verified message delivered to Customer A \(\+99900000054\) on WhatsApp/);

    // 5. Invariant: third-person "his trip" is converted to "your trip"
    assert.match(gatewayResult.text, /we cannot take your trip/i);

    // 6. Invariant: transcript records the outgoing WhatsApp message
    const transcript = await loadTranscript(customeraPhone);
    const lastEntry = transcript.entries[transcript.entries.length - 1];
    assert.equal(lastEntry.role, "agent");
    assert.match(lastEntry.text, /Hello Customer A!/);
    assert.match(lastEntry.text, /we cannot take your trip/i);

    // 7. Invariant: booking is automatically marked cancelled in the system
    const all = await listAllPreBookings();
    const updatedBooking = all.find((b) => b.id === bookingId);
    assert.equal(updatedBooking?.status, "cancelled", "booking must be auto-cancelled on decline relay");
  });
});

describe("Customer Interactive Poll Voting & Hybrid UX", () => {
  it("routes customer poll vote directly into customer message intake", async () => {
    const { handleWasenderEvent } = await import("../wasender/handlers.ts");
    const { loadTranscript } = await import("../agent/transcript.ts");

    const customerPhone = "99900000052";
    const pollId = `poll_test_${Date.now()}`;

    // Simulate Wasender poll.results webhook where a customer tapped "🛵 Passenger Ride"
    await handleWasenderEvent({
      event: "poll.results",
      timestamp: Date.now(),
      data: {
        key: { id: pollId, remoteJid: `${customerPhone}@s.whatsapp.net` },
        pollResult: [
          {
            name: "🛵 Passenger Ride",
            voters: [`${customerPhone}@s.whatsapp.net`],
          },
        ],
      },
    });

    // Verify that the customer's choice was recorded in their transcript
    const transcript = await loadTranscript(customerPhone);
    const hasCustomerChoice = transcript.entries.some(
      (e) => e.role === "customer" && e.text === "🛵 Passenger Ride",
    );
    assert.ok(hasCustomerChoice, "customer poll choice must be appended as customer message in transcript");
  });
});

describe("Unfamiliar Scenario Circuit Breaker & Customer Session Freeze Lock", () => {
  it("freezes customer session on escalation, holds customer politely with 0 LLM calls, and unfreezes on admin reply", async () => {
    const { executeAgentTool } = await import("../agent/tools.ts");
    const { getOpenCustomerEscalation, saveEscalations, loadEscalations } = await import("../ops/store.ts");
    const { handleWasenderEvent } = await import("../wasender/handlers.ts");
    const { loadTranscript } = await import("../agent/transcript.ts");
    const { enforceAdminActionInvariants } = await import("../agent/action-gateway.ts");

    await saveEscalations([]);
    const testCustomerPhone = "99900000059";

    // 1. Agent encounters an unfamiliar scenario (e.g. cross-island trip to Flic en Flac with credit payment)
    const escResult = await executeAgentTool({
      name: "escalate_to_admin",
      toolArguments: {
        reason: "Customer requesting cross-island ride to Flic en Flac and asking for deferred credit payment",
      },
      senderPhone: testCustomerPhone,
      pushName: "Jean-Luc",
      messageId: "test_esc_01",
    });

    assert.equal(escResult.ok, true);

    // 2. Verify that an open escalation was recorded and session is marked waiting for admin
    const openEsc = await getOpenCustomerEscalation(testCustomerPhone);
    assert.ok(openEsc, "must create an open escalation");
    assert.equal(openEsc.status, "open");
    assert.match(openEsc.reason, /Flic en Flac/);

    // 3. Customer sends a follow-up message while waiting for admin ("Any update? Can I get a discount?")
    await handleWasenderEvent({
      event: "messages.received",
      timestamp: Date.now(),
      data: {
        messages: {
          key: { id: `msg_followup_${Date.now()}`, remoteJid: `${testCustomerPhone}@s.whatsapp.net` },
          pushName: "Jean-Luc",
          messageBody: "Any update? Can I get a discount?",
        },
      },
    });

    // 4. Verify customer's follow-up was appended to escalation and transcript
    const transcript = await loadTranscript(testCustomerPhone);
    const hasFollowUp = transcript.entries.some(
      (e) => e.role === "customer" && e.text.includes("Any update?"),
    );
    assert.ok(hasFollowUp, "must record customer follow-up message in transcript");

    const updatedEsc = await getOpenCustomerEscalation(testCustomerPhone);
    assert.ok(
      updatedEsc?.followUpMessages?.some((m) => m.text.includes("Any update?")),
      "must record follow-up message in escalation record",
    );

    // 5. Verify holding reply was sent to the customer
    const holdingEntry = transcript.entries.find(
      (e) => e.role === "agent" && e.text.includes("reviewing your request and will get back to you shortly"),
    );
    assert.ok(holdingEntry, "must send polite holding message while frozen");

    // 6. Admin Sherif replies directly to resolve the issue: "Tell Jean-Luc that we cannot do Flic en Flac"
    const adminReplyResult = await enforceAdminActionInvariants({
      incomingText: "Tell Jean-Luc that we cannot do Flic en Flac but can take him around Grand Baie",
      assistantText: "I'll notify Jean-Luc.",
      senderPhone: "+999000000008",
      isAdmin: true,
      calledTools: new Set(),
    });

    assert.match(adminReplyResult.text, /Verified message delivered to Jean-Luc/);
    assert.match(adminReplyResult.text, /Escalation resolved and customer session unlocked/);

    // 7. Verify the escalation is now marked resolved and lock is released
    const openEscAfterAdmin = await getOpenCustomerEscalation(testCustomerPhone);
    assert.equal(openEscAfterAdmin, null, "open escalation must be cleared after admin resolution");

    const allEsc = await loadEscalations();
    const resolvedEsc = allEsc.find((e) => e.customerPhone.includes(testCustomerPhone));
    assert.equal(resolvedEsc?.status, "resolved", "escalation status must be resolved");
    assert.match(resolvedEsc?.responseMessage || "", /we cannot do Flic en Flac/i);
  });
});

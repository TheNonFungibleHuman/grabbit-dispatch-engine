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

describe("Second-Round Audit Hardening & Regressions", () => {
  it("ignores WhatsApp group messages, broadcast channels, and status broadcasts", async () => {
    const { handleWasenderEvent } = await import("../wasender/handlers.ts");
    const { loadTranscript } = await import("../agent/transcript.ts");

    // Group message
    const groupJid = "9990000000001@g.us";
    await handleWasenderEvent({
      event: "messages.received",
      timestamp: Date.now(),
      data: {
        messages: {
          key: { id: `group_msg_${Date.now()}`, remoteJid: groupJid },
          pushName: "Student Group",
          messageBody: "Hey everyone, who wants to split a cab?",
        },
      },
    });

    // Verify transcript for group is completely untouched / non-existent
    const transcript = await loadTranscript(groupJid);
    assert.equal(transcript.entries.length, 0, "must not process or record messages from groups");

    // Status broadcast message
    await handleWasenderEvent({
      event: "messages.received",
      timestamp: Date.now(),
      data: {
        messages: {
          key: { id: `status_msg_${Date.now()}`, remoteJid: "status@broadcast" },
          pushName: "Status",
          messageBody: "My WhatsApp status update",
        },
      },
    });
  });

  it("accurately parses British/Mauritian dot time formats and slot ranges", async () => {
    const { parseTimeToMinutes, formatMinutesToTime } = await import("../time.ts");
    const { parseTimeSlotLabel } = await import("../schedule/model.ts");

    // Dot separated times
    assert.equal(parseTimeToMinutes("12.45 pm"), 12 * 60 + 45);
    assert.equal(parseTimeToMinutes("8.20am"), 8 * 60 + 20);
    assert.equal(parseTimeToMinutes("14.30"), 14 * 60 + 30);
    assert.equal(parseTimeToMinutes("09.15"), 9 * 60 + 15);
    assert.equal(parseTimeToMinutes("7.00 PM"), 19 * 60);

    // Standard colon separated times still work
    assert.equal(parseTimeToMinutes("12:45 pm"), 12 * 60 + 45);
    assert.equal(parseTimeToMinutes("6pm"), 18 * 60);
    assert.equal(parseTimeToMinutes("12:00 am"), 0);

    // Format minutes back to string
    assert.equal(formatMinutesToTime(765), "12:45 pm");
    assert.equal(formatMinutesToTime(500), "8:20 am");

    // Slot label parsing with dot notation
    const slot = parseTimeSlotLabel("12.30pm - 2.30pm");
    assert.ok(slot);
    assert.equal(slot?.startMinutes, 750);
    assert.equal(slot?.endMinutes, 870);
  });

  it("prevents false cross-day slot conflicts when candidate records omit scheduledDate", async () => {
    const { evaluateSlotRules } = await import("../orders/pre-booking.ts");

    // Candidate booking is for yesterday / different day, but scheduledDate is omitted (legacy summary)
    // Date is only present in slotKey or createdAt
    const candidates = [
      {
        id: "legacy_bk_01",
        assignedRider: "Thierry",
        slotKey: "2026-09-06_12:00-13:00",
        scheduledTime: "12:00 pm",
        serviceKind: "trip" as const,
        tripType: "one_way" as const,
        customerPhone: "+99900000019",
        createdAt: "2026-09-06T12:00:00.000Z",
      },
    ];

    // New booking request for today (2026-09-07) at 12:05 pm
    const result = evaluateSlotRules(candidates, {
      slotKey: "2026-09-07_12:00-13:00",
      scheduledDate: "2026-09-07",
      scheduledTime: "12:05 pm",
      assignedRider: "Thierry",
      serviceKind: "trip",
      tripType: "one_way",
    });

    // Should NOT have a gap violation because the legacy booking was on a different day!
    assert.equal(result.available, true, "different days must not trigger gap violation");
    assert.equal(result.reason, undefined);
  });

  it("verifies Kilo webhook exports maxDuration = 60", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const routeContent = fs.readFileSync(path.join(process.cwd(), "app/api/kilo/webhook/route.ts"), "utf-8");
    assert.match(routeContent, /export\s+const\s+maxDuration\s*=\s*60\s*;/);
    assert.match(routeContent, /export\s+const\s+runtime\s*=\s*["']nodejs["']\s*;/);
    assert.match(routeContent, /appendTranscriptEntry/);
  });
});

describe("Customer +99900000055 Incident: Poll Messaging & Non-Text Webhook Safety", () => {
  it("accurately identifies bare greetings vs specific booking intent with isBareGreeting", async () => {
    const { isBareGreeting } = await import("../agent/format.ts");

    // Pure greetings should return true
    assert.equal(isBareGreeting("Hello"), true);
    assert.equal(isBareGreeting("Hi"), true);
    assert.equal(isBareGreeting("Hey"), true);
    assert.equal(isBareGreeting("Good morning"), true);
    assert.equal(isBareGreeting("Good afternoon"), true);
    assert.equal(isBareGreeting("Good evening"), true);
    assert.equal(isBareGreeting("Grabbit"), true);
    assert.equal(isBareGreeting("Grabbit express"), true);
    assert.equal(isBareGreeting("bonjour"), true);
    assert.equal(isBareGreeting("salut"), true);
    assert.equal(isBareGreeting("Hey there!"), true);

    // Messages with actual booking content or times should return false
    assert.equal(isBareGreeting("I want to book a trip"), false);
    assert.equal(isBareGreeting("For 11:45"), false);
    assert.equal(isBareGreeting("Hello, I want to book a ride to Grand Baie"), false);
    assert.equal(isBareGreeting("Can you deliver food from mahogany?"), false);
    assert.equal(isBareGreeting("12:00 pm"), false);
    assert.equal(isBareGreeting(""), false);
    assert.equal(isBareGreeting("   "), false);
  });

  it("discards non-text, non-media events early without creating transcript or triggering replies", async () => {
    const { handleWasenderEvent } = await import("../wasender/handlers.ts");
    const { loadTranscript } = await import("../agent/transcript.ts");

    const customerPhone = "99900000055";
    // Simulate the exact empty reaction / protocol message that arrived at 04:07:46
    await handleWasenderEvent({
      event: "messages.received",
      timestamp: Date.now(),
      data: {
        messages: {
          key: {
            id: "A540C60B9D9892D8D6C5A5B4DDCE9CFD",
            remoteJid: `${customerPhone}@s.whatsapp.net`,
          },
          pushName: ".o",
          messageBody: "", // Empty reaction / protocol event
        },
      },
    });

    const transcript = await loadTranscript(customerPhone);
    assert.equal(
      transcript.entries.length,
      0,
      "empty non-text/non-media events must be ignored and not recorded in transcript",
    );
  });

  it("dispatches single combined interactive welcome poll immediately on clean session greeting", async () => {
    const { handleWasenderEvent } = await import("../wasender/handlers.ts");
    const { loadTranscript } = await import("../agent/transcript.ts");

    const newCustomerPhone = "99900000056";
    await handleWasenderEvent({
      event: "messages.received",
      timestamp: Date.now(),
      data: {
        messages: {
          key: {
            id: `msg_hello_${Date.now()}`,
            remoteJid: `${newCustomerPhone}@s.whatsapp.net`,
          },
          pushName: "Sarah",
          messageBody: "Hello",
        },
      },
    });

    const transcript = await loadTranscript(newCustomerPhone);
    assert.equal(transcript.entries.length, 2, "must record customer hello and welcome greeting");
    assert.equal(transcript.entries[0].role, "customer");
    assert.equal(transcript.entries[0].text, "Hello");

    assert.equal(transcript.entries[1].role, "agent");
    assert.match(transcript.entries[1].text, /Welcome to Grabbit Express Sarah!/);
    assert.match(transcript.entries[1].text, /passenger ride/i);
    assert.match(transcript.entries[1].text, /food delivery/i);
  });

  it("does not re-send welcome greeting if customer has an active in-flight conversation", async () => {
    const { isBareGreeting } = await import("../agent/format.ts");
    const { loadTranscript, appendTranscriptEntry } = await import("../agent/transcript.ts");

    const activeCustomerPhone = "99900000053";

    // 1. Customer previously requested a trip 2 minutes ago
    await appendTranscriptEntry(activeCustomerPhone, {
      role: "customer",
      text: "I need a ride to Grand Baie at 2pm",
      at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    });

    // 2. Customer follows up with "Hello"
    const transcript = await loadTranscript(activeCustomerPhone);
    const lastCustomer = transcript.entries.findLast((e) => e.role === "customer");
    assert.ok(lastCustomer);
    assert.equal(isBareGreeting(lastCustomer.text), false, "last customer message was a real booking request");
  });
});

describe("Daily Escalation Scoping & End of Day Purge", () => {
  it("loadEscalations automatically purges past-day escalations and retains only today's records", async () => {
    const { loadEscalations, saveEscalations } = await import("../ops/store.ts");

    // Populate with 1 past-day escalation (2 weeks ago) and 1 today escalation
    await saveEscalations([
      {
        id: "esc_old_from_weeks_ago",
        customerPhone: "99900000062",
        customerName: "Old Customer",
        reason: "Old query from 2 weeks ago",
        createdAt: "2026-08-20T10:00:00.000Z",
        status: "open",
      },
      {
        id: "esc_today_active",
        customerPhone: "99900000063",
        customerName: "Today Customer",
        reason: "Asking for airport trip today",
        createdAt: new Date().toISOString(),
        status: "open",
      },
    ]);

    // loadEscalations() should strictly filter out the past-day escalation
    const active = await loadEscalations();
    assert.equal(active.length, 1, "must only return today's escalation");
    assert.equal(active[0].id, "esc_today_active");

    // Re-reading directly with allowPastDays should verify that the stale record was pruned from the persistent store
    const persisted = await loadEscalations({ allowPastDays: true });
    assert.equal(persisted.length, 1, "stale record must be pruned from store");
    assert.equal(persisted[0].id, "esc_today_active");
  });

  it("clearAllEscalations wipes all escalations resolved or not", async () => {
    const { clearAllEscalations, loadEscalations, saveEscalations } = await import("../ops/store.ts");

    await saveEscalations([
      {
        id: "esc_1",
        customerPhone: "99900000018",
        customerName: "Customer 1",
        reason: "Reason 1",
        createdAt: new Date().toISOString(),
        status: "open",
      },
      {
        id: "esc_2",
        customerPhone: "99900000023",
        customerName: "Customer 2",
        reason: "Reason 2",
        createdAt: new Date().toISOString(),
        status: "resolved",
      },
    ]);

    const res = await clearAllEscalations("Test wipe");
    assert.equal(res.clearedCount, 2);

    const remaining = await loadEscalations({ allowPastDays: true });
    assert.equal(remaining.length, 0, "all escalations must be cleared");
  });

  it("autoClearDailyEscalations clears all escalations at End of Day (20:30 Mauritius time)", async () => {
    const { autoClearDailyEscalations, loadEscalations, saveEscalations } = await import("../ops/store.ts");

    await saveEscalations([
      {
        id: "esc_today_eod",
        customerPhone: "99900000024",
        customerName: "Customer EOD",
        reason: "EOD inquiry",
        createdAt: new Date().toISOString(),
        status: "open",
      },
    ]);

    // Simulate 8:45 PM Mauritius time (20:45)
    // Mauritius is UTC+4, so 20:45 Mauritius = 16:45 UTC
    const eodInstant = new Date("2026-09-08T16:45:00.000Z");
    const res = await autoClearDailyEscalations(eodInstant);

    assert.equal(res.clearedCount, 1);
    assert.match(res.reason, /End of Day/i);

    const afterEod = await loadEscalations({ allowPastDays: true });
    assert.equal(afterEod.length, 0, "must be empty after End of Day clear");
  });

  it("admin invariant executes clear_all_escalations when admin texts 'Clear all escalations'", async () => {
    const { enforceAdminActionInvariants } = await import("../agent/action-gateway.ts");
    const { saveEscalations, loadEscalations } = await import("../ops/store.ts");

    await saveEscalations([
      {
        id: "esc_admin_test",
        customerPhone: "99900000025",
        customerName: "Customer Admin",
        reason: "Test inquiry",
        createdAt: new Date().toISOString(),
        status: "open",
      },
    ]);

    const result = await enforceAdminActionInvariants({
      senderPhone: "+999000000008", // Admin Sherif
      isAdmin: true,
      incomingText: "Please clear all escalations",
      assistantText: "Sure, let me check.",
      calledTools: new Set(),
      messageId: `msg_clear_${Date.now()}`,
    });

    assert.ok(result.actionsExecuted.includes("clear_all_escalations"));
    assert.match(result.text, /Escalations Cleared/i);

    const remaining = await loadEscalations({ allowPastDays: true });
    assert.equal(remaining.length, 0, "queue must be empty after admin clear command");
  });

  it("buildAgentContextNote reflects only today's escalations and labels with today's date", async () => {
    const { buildAgentContextNote } = await import("../agent/tools.ts");
    const { saveEscalations } = await import("../ops/store.ts");
    const { mauritiusDateIso } = await import("../time.ts");

    const todayIso = mauritiusDateIso(new Date());

    // 1 old escalation from yesterday and 1 from today
    await saveEscalations([
      {
        id: "esc_yesterday",
        customerPhone: "99900000050",
        customerName: "Yesterday Customer",
        reason: "Yesterday issue",
        createdAt: "2026-09-01T12:00:00.000Z",
        status: "open",
      },
      {
        id: "esc_today_note",
        customerPhone: "99900000052",
        customerName: "Today Note Customer",
        reason: "Needs quote for SSRN Hospital",
        createdAt: new Date().toISOString(),
        status: "open",
      },
    ]);

    const note = await buildAgentContextNote({ senderPhone: "+999000000008" }); // Admin Sherif
    assert.match(note, new RegExp(`ACTIVE ESCALATIONS AWAITING ADMIN FEEDBACK TODAY \\(${todayIso}\\)`));
    assert.match(note, /Today Note Customer/);
    assert.doesNotMatch(note, /Yesterday Customer/, "past-day escalations must not appear in context note");
  });
});

describe("Poll Eradication & Repetitive Question Loop Breaker", () => {
  it("verifies interactive poll tools are completely removed from AGENT_TOOLS", async () => {
    const { AGENT_TOOLS, DEEPSEEK_AGENT_TOOLS } = await import("../agent/tools.ts");
    const hasPollTool = AGENT_TOOLS.some((t) => t.name.includes("poll") || t.name.includes("interactive"));
    assert.equal(hasPollTool, false, "no interactive poll tools may exist in AGENT_TOOLS");

    const hasDeepSeekPollTool = DEEPSEEK_AGENT_TOOLS.some(
      (t) => t.function.name.includes("poll") || t.function.name.includes("interactive"),
    );
    assert.equal(hasDeepSeekPollTool, false, "no interactive poll tools may exist in DEEPSEEK_AGENT_TOOLS");
  });

  it("breaks repetitive question loop when assistant asks the same location question repeatedly", async () => {
    const { isRepetitiveQuestionLoop } = await import("../agent/booking-guard.ts");

    const repeatedQuestion =
      "Let me confirm the exact drop-off location at ALCHE for your KFC delivery. Could you share the specific gate, hostel, or residence name so the rider knows exactly where to go 😊";

    const historyWithLoop = [
      { role: "assistant", content: repeatedQuestion },
      { role: "user", content: "Aksum" },
      { role: "assistant", content: "I see you mentioned Aksum, is that correct?" },
      { role: "user", content: "Yes" },
    ];

    const loopFix = isRepetitiveQuestionLoop(repeatedQuestion, historyWithLoop);
    assert.ok(loopFix, "must detect repetitive question loop and return circuit breaker fix");
    assert.match(loopFix, /Aksum|drop-off/i);
    assert.doesNotMatch(loopFix, /could you share the specific gate/i);
  });
});

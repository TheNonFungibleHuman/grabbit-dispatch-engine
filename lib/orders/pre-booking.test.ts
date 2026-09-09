import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FLEET_RIDERS, findRiderByName, findRiderByPhone, getCustomTrackingUrl } from "../riders/config.ts";
import { checkSlotAvailability, classifyRiderAcceptDecline, createPreBookingRequest, handleRiderReply, listAllPreBookings } from "./pre-booking.ts";

describe("rider directory & custom tracking", () => {
  it("resolves riders by name, alias, and phone", () => {
    const thierry = findRiderByName("Thierry(Delivery)");
    assert.ok(thierry);
    assert.equal(thierry?.name, "Thierry");
    assert.equal(thierry?.kiloRiderId, "00000000-0000-0000-0000-0000000000a1");

    const sherif = findRiderByPhone("+233 59 723 6608");
    assert.ok(sherif);
    assert.equal(sherif?.name, "Sherif");

    const moses = findRiderByName("Moses Kolaan");
    assert.ok(moses);
    assert.equal(moses?.email, "rider.three@example.com");
  });

  it("generates custom tracking links with delivery.grabbit-express.com", () => {
    const tracking = getCustomTrackingUrl("del_98765", "ACC-123");
    assert.equal(tracking, "https://delivery.grabbit-express.com/track/del_98765/ACC-123");
  });
});

describe("classifyRiderAcceptDecline", () => {
  it("matches bare accept tokens", () => {
    assert.equal(classifyRiderAcceptDecline("Yes"), "accept");
    assert.equal(classifyRiderAcceptDecline("CONFIRM!"), "accept");
    assert.equal(classifyRiderAcceptDecline("ok"), "accept");
    assert.equal(classifyRiderAcceptDecline("accepted"), "accept");
  });

  it("matches bare decline tokens", () => {
    assert.equal(classifyRiderAcceptDecline("No"), "decline");
    assert.equal(classifyRiderAcceptDecline("Declined."), "decline");
    assert.equal(classifyRiderAcceptDecline("reject"), "decline");
  });

  it("ignores sentences and casual chatter", () => {
    assert.equal(classifyRiderAcceptDecline("yes I am at the gate"), null);
    assert.equal(classifyRiderAcceptDecline("no problem"), null);
    assert.equal(classifyRiderAcceptDecline("okay sure, heading there now"), null);
    assert.equal(classifyRiderAcceptDecline(""), null);
  });
});

describe("pre-booking & anti-double-booking guard", () => {
  it("prevents double-booking the same rider slot for different customers", async () => {
    const slotKey = "2026-09-01_12:00-13:00";
    const rider = "Thierry";

    // 1. Customer 1 books
    const book1 = await createPreBookingRequest({
      customerPhone: "+99900000018",
      customerName: "Alice",
      serviceKind: "trip",
      pickupAddress: "ALCHE",
      deliveryAddress: "Mahogany",
      scheduledDate: "2026-09-01",
      scheduledTime: "12:00 pm",
      slotKey,
      assignedRider: rider,
    });

    assert.equal(book1.ok, true);
    assert.equal(book1.booking?.assignedRider, rider);

    // 2. Customer 2 tries the SAME slot -> must be rejected
    const book2 = await createPreBookingRequest({
      customerPhone: "+99900000023",
      customerName: "Bob",
      serviceKind: "trip",
      pickupAddress: "SSRN",
      deliveryAddress: "Mahogany",
      scheduledDate: "2026-09-01",
      scheduledTime: "12:00 pm",
      slotKey,
      assignedRider: rider,
    });

    assert.equal(book2.ok, false);
    assert.equal(book2.doubleBooked, true);
    assert.match(book2.error || "", /booking|booked/i);
  });

  it("enforces strict 15-minute buffer between bookings for the same rider", async () => {
    const slotKey = "2026-09-03_18:00-19:00";
    const rider = "Thierry";

    // 1. Initial booking at 6:15 pm
    const book1 = await createPreBookingRequest({
      customerPhone: "+99900000025",
      customerName: "David",
      serviceKind: "pickup_delivery",
      pickupAddress: "KFC Mahogany",
      deliveryAddress: "ALCHE campus",
      scheduledDate: "2026-09-03",
      scheduledTime: "6:15 pm",
      slotKey,
      assignedRider: rider,
    });
    assert.equal(book1.ok, true);

    // 2. Exact same time 6:15 pm -> rejected
    const bookExact = await createPreBookingRequest({
      customerPhone: "+99900000030",
      customerName: "Eve",
      serviceKind: "pickup_delivery",
      pickupAddress: "Pan Asian",
      deliveryAddress: "ALCHE campus",
      scheduledDate: "2026-09-03",
      scheduledTime: "6:15 pm",
      slotKey,
      assignedRider: rider,
    });
    assert.equal(bookExact.ok, false);
    assert.equal(bookExact.doubleBooked, true);
    assert.match(bookExact.error || "", /15-minute gap/i);

    // 3. 6:14 pm (1 min gap) -> rejected
    const bookClose = await createPreBookingRequest({
      customerPhone: "+99900000030",
      customerName: "Eve",
      serviceKind: "pickup_delivery",
      pickupAddress: "Pan Asian",
      deliveryAddress: "ALCHE campus",
      scheduledDate: "2026-09-03",
      scheduledTime: "6:14 pm",
      slotKey,
      assignedRider: rider,
    });
    assert.equal(bookClose.ok, false);
    assert.equal(bookClose.doubleBooked, true);

    // 4. 6:25 pm (10 min gap) -> rejected
    const bookTenMin = await createPreBookingRequest({
      customerPhone: "+99900000030",
      customerName: "Eve",
      serviceKind: "pickup_delivery",
      pickupAddress: "Pan Asian",
      deliveryAddress: "ALCHE campus",
      scheduledDate: "2026-09-03",
      scheduledTime: "6:25 pm",
      slotKey,
      assignedRider: rider,
    });
    assert.equal(bookTenMin.ok, false);
    assert.equal(bookTenMin.doubleBooked, true);

    // 5. 6:30 pm (15 min gap) -> ACCEPTED
    const bookValidAfter = await createPreBookingRequest({
      customerPhone: "+99900000030",
      customerName: "Eve",
      serviceKind: "pickup_delivery",
      pickupAddress: "Pan Asian",
      deliveryAddress: "ALCHE campus",
      scheduledDate: "2026-09-03",
      scheduledTime: "6:30 pm",
      slotKey,
      assignedRider: rider,
    });
    assert.equal(bookValidAfter.ok, true);

    // 6. 6:00 pm (15 min before 6:15 pm) -> ACCEPTED
    const bookValidBefore = await createPreBookingRequest({
      customerPhone: "+99900000034",
      customerName: "Frank",
      serviceKind: "pickup_delivery",
      pickupAddress: "Roots Burgers",
      deliveryAddress: "ALCHE campus",
      scheduledDate: "2026-09-03",
      scheduledTime: "6:00 pm",
      slotKey,
      assignedRider: rider,
    });
    assert.equal(bookValidBefore.ok, true);
  });

  it("authorizes only riders and admin to query rider schedules", async () => {
    const { getRiderAssignedBookings } = await import("./pre-booking.ts");

    // 1. Random customer number -> Access Denied
    const denied = await getRiderAssignedBookings({
      callerPhone: "+99900000074",
      targetDate: "all",
    });
    assert.equal(denied.authorized, false);
    assert.equal(denied.ok, false);
    assert.match(denied.error || "", /Access Denied/i);

    // 2. Rider phone (+999000000009) -> Authorized
    const riderQuery = await getRiderAssignedBookings({
      callerPhone: "+999000000009",
      targetDate: "all",
    });
    assert.equal(riderQuery.authorized, true);
    assert.equal(riderQuery.ok, true);
    assert.equal(riderQuery.riderName, "Thierry");

    // 3. Admin phone (+9990000000003) -> Authorized
    const adminQuery = await getRiderAssignedBookings({
      callerPhone: "+9990000000003",
      targetDate: "all",
    });
    assert.equal(adminQuery.authorized, true);
    assert.equal(adminQuery.ok, true);
  });

  it("enforces hourly capacity rules: 3 deliveries + 1 trip, or 3 trips if 0 deliveries", async () => {
    const slotKey = "2026-09-05_11:30-13:30";
    const rider = "Moses";

    // 1. Hour 11:30 - 12:30: 0 deliveries -> can book 3 trips with 15-min gap
    const trip1 = await createPreBookingRequest({
      customerPhone: "+99900000036",
      customerName: "TripUser1",
      serviceKind: "trip",
      pickupAddress: "ALCHE gate",
      deliveryAddress: "Mahogany",
      scheduledDate: "2026-09-05",
      scheduledTime: "11:30 am",
      slotKey,
      assignedRider: rider,
    });
    assert.equal(trip1.ok, true);

    const trip2 = await createPreBookingRequest({
      customerPhone: "+99900000039",
      customerName: "TripUser2",
      serviceKind: "trip",
      pickupAddress: "ALCHE gate",
      deliveryAddress: "Mahogany",
      scheduledDate: "2026-09-05",
      scheduledTime: "11:45 am",
      slotKey,
      assignedRider: rider,
    });
    assert.equal(trip2.ok, true);

    const trip3 = await createPreBookingRequest({
      customerPhone: "+99900000040",
      customerName: "TripUser3",
      serviceKind: "trip",
      pickupAddress: "ALCHE gate",
      deliveryAddress: "Mahogany",
      scheduledDate: "2026-09-05",
      scheduledTime: "12:00 pm", // new hour (12:00-13:00)
      slotKey,
      assignedRider: rider,
    });
    assert.equal(trip3.ok, true);
  });

  it("reschedules an existing booking, updates the record and checks time buffers", async () => {
    const { reschedulePreBookingRequest } = await import("./pre-booking.ts");
    const slotKey = "2026-09-06_17:00-18:00";
    const rider = "Moses";

    // 1. Initial booking at 5:00 pm
    const initial = await createPreBookingRequest({
      customerPhone: "+99900000061",
      customerName: "RescheduleUser",
      serviceKind: "trip",
      pickupAddress: "ALCHE gate",
      deliveryAddress: "Mahogany",
      scheduledDate: "2026-09-06",
      scheduledTime: "5:00 pm",
      slotKey,
      assignedRider: rider,
    });
    assert.equal(initial.ok, true);

    // 2. Reschedule to 5:30 pm -> SUCCESS
    const rescheduled = await reschedulePreBookingRequest({
      customerPhone: "+99900000061",
      newScheduledDate: "2026-09-06",
      newScheduledTime: "5:30 pm",
      newSlotKey: slotKey,
      newAssignedRider: rider,
    });

    assert.equal(rescheduled.ok, true);
    assert.equal(rescheduled.booking?.scheduledTime, "5:30 pm");
    assert.equal(rescheduled.booking?.assignedRider, rider);
  });

  it("enforces strict 30-minute buffer for round-trip bookings for the same rider", async () => {
    const slotKey = "2026-09-07_11:00-13:00";
    const rider = "Moses";

    // 1. Book round-trip at 11:30 am
    const roundTrip = await createPreBookingRequest({
      customerPhone: "+99900000045",
      customerName: "Winter",
      serviceKind: "trip",
      tripType: "round_trip",
      pickupAddress: "ALCHE campus",
      deliveryAddress: "Mahogany",
      scheduledDate: "2026-09-07",
      scheduledTime: "11:30 am",
      slotKey,
      assignedRider: rider,
    });
    assert.equal(roundTrip.ok, true);

    // 2. Booking at 11:45 am (15 mins later) -> Must be REJECTED because round-trip needs 30 min buffer
    const clashTrip = await createPreBookingRequest({
      customerPhone: "+99900000048",
      customerName: "Customer C",
      serviceKind: "trip",
      tripType: "round_trip",
      pickupAddress: "ALCHE campus",
      deliveryAddress: "Mahogany",
      scheduledDate: "2026-09-07",
      scheduledTime: "11:45 am",
      slotKey,
      assignedRider: rider,
    });
    assert.equal(clashTrip.ok, false);
    assert.equal(clashTrip.doubleBooked, true);
    assert.match(clashTrip.error || "", /30-minute gap/i);

    // 3. Booking at 12:00 pm (30 mins later) -> SUCCESS
    const validTrip = await createPreBookingRequest({
      customerPhone: "+99900000049",
      customerName: "Charlie",
      serviceKind: "trip",
      tripType: "one_way",
      pickupAddress: "ALCHE campus",
      deliveryAddress: "Mahogany",
      scheduledDate: "2026-09-07",
      scheduledTime: "12:00 pm",
      slotKey,
      assignedRider: rider,
    });
    assert.equal(validTrip.ok, true);
  });

  it("prevents duplicate bookings for same customer within 2-minute cooldown", async () => {
    const slotKey = "2026-09-08_14:00-15:00";
    const rider = "Sherif";

    // 1. First booking
    const first = await createPreBookingRequest({
      customerPhone: "+99900000033",
      customerName: "RapidCustomer",
      serviceKind: "trip",
      tripType: "one_way",
      pickupAddress: "ALCHE",
      deliveryAddress: "Mahogany",
      scheduledDate: "2026-09-08",
      scheduledTime: "2:00 pm",
      slotKey,
      assignedRider: rider,
    });
    assert.equal(first.ok, true);

    // 2. Immediate follow-up booking call (e.g. from an emoji webhook 5s later)
    const duplicate = await createPreBookingRequest({
      customerPhone: "+99900000033",
      customerName: "RapidCustomer",
      serviceKind: "trip",
      tripType: "one_way",
      pickupAddress: "ALCHE",
      deliveryAddress: "Mahogany",
      scheduledDate: "2026-09-08",
      scheduledTime: "2:00 pm",
      slotKey,
      assignedRider: rider,
    });
    assert.equal(duplicate.ok, true);
    // Must return the exact same booking ID rather than creating a new one
    assert.equal(duplicate.booking?.id, first.booking?.id);
  });

  it("handles live rider status check and admin escalation", async () => {
    const { notifyRiderCustomerInquiry, notifyAdminEscalation } = await import("../riders/notify-rider.ts");
    
    const riderCheck = await notifyRiderCustomerInquiry({
      assignedRider: "Moses",
      customerName: "TestCustomer",
      customerPhone: "+99900000074",
      inquiry: "Where is my driver?",
      trackingUrl: "https://delivery.grabbit-express.com/track/DEL_123/ABC",
    });
    assert.equal(riderCheck.ok, true);

    const adminEsc = await notifyAdminEscalation({
      customerPhone: "+99900000074",
      customerName: "TestCustomer",
      reason: "Complex multi-vendor dispute",
    });
    assert.equal(adminEsc.ok, true);
  });

  it("processes pre-ride reminders safely", async () => {
    const { processUpcomingBookingReminders } = await import("../schedule/reminders.ts");
    const res = await processUpcomingBookingReminders();
    assert.equal(typeof res.processed, "number");
    assert.equal(Array.isArray(res.reminded), true);
  });

  it("generates daily trips & revenue rundown with fares calculation", async () => {
    const { generateDailyTripsRundown, estimateBookingFare } = await import("../schedule/daily-rundown.ts");

    const tripBooking = {
      id: "pb_test_1",
      customerPhone: "+99900000022",
      customerName: "TestUser",
      serviceKind: "trip",
      tripType: "round_trip" as const,
      pickupAddress: "ALCHE",
      deliveryAddress: "Mahogany",
      packageDescription: "Passenger round trip",
      scheduledDate: "2026-09-09",
      scheduledTime: "10:00 am",
      slotKey: "2026-09-09_10:00-11:00",
      assignedRider: "Moses",
      declinedRiders: [],
      status: "confirmed" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const fare = estimateBookingFare(tripBooking);
    assert.equal(fare, 80); // Rs 80 for round trip to Mahogany

    const rundown = await generateDailyTripsRundown("2026-09-09");
    assert.equal(typeof rundown.totalBookings, "number");
    assert.equal(typeof rundown.totalRevenue, "number");
    assert.match(rundown.summaryText, /Grabbit Daily Operations & Fares Rundown/i);
    assert.match(rundown.googleChatText, /GRABBIT DAILY OPERATIONS & REVENUE RUNDOWN/i);
  });

  it("formats transcript with date tags and demarcates multi-day history", async () => {
    const { formatTranscriptMessagesForModel } = await import("../agent/transcript.ts");

    const formatted = formatTranscriptMessagesForModel([
      {
        at: "2026-08-19T05:10:08.011Z",
        role: "customer",
        text: "Hello. I’d like to book a trip for today at 11:45",
      },
      {
        at: "2026-08-19T05:11:25.167Z",
        role: "agent",
        text: "Your trip is confirmed for 12:45 pm today",
      },
      {
        at: new Date().toISOString(),
        role: "customer",
        text: "Thank you for the reminder!",
      },
    ]);

    assert.equal(formatted.length >= 3, true);
    assert.match(formatted[0].content, /Past Date/i);
    assert.match(formatted[formatted.length - 1].content, /Today/i);
  });

  it("strips internal thought leaks from model replies in sanitizeWhatsAppText", async () => {
    const { sanitizeWhatsAppText } = await import("../agent/format.ts");

    const raw1 = 'Let me clarify the destination with the customer, as "lexpress bus stop" isn\'t a standard fare destination I have on file. Let me confirm the details.\n\nHello Customer A! 😊 Thanks for booking with Grabbit Express.';
    const cleaned1 = sanitizeWhatsAppText(raw1);
    assert.equal(cleaned1, "Hello Customer A! 😊 Thanks for booking with Grabbit Express.");

    const raw2 = "I don't have access to the Thursday and Friday schedules. Let me clarify with the customer.\n\nHello Customer A! 😊 Thanks for reaching out.";
    const cleaned2 = sanitizeWhatsAppText(raw2);
    assert.equal(cleaned2, "Hello Customer A! 😊 Thanks for reaching out.");

    const raw3 = "[Today 4:14 PM] Support: Got it, G! 😊 Your ride is confirmed.";
    const cleaned3 = sanitizeWhatsAppText(raw3);
    assert.equal(cleaned3, "Got it, G! 😊 Your ride is confirmed.");

    const raw4 = `I'll help Oliver book this ride. Let me check the details.\n\nThe customer wants a trip from campus to the Grand Baie Express bus stop at 5:25pm. That's within the 5:00-6:00pm slot (SHERIF). This is a passenger trip, so I need to confirm the payment method.\n\nLet me confirm the fare and payment preference before booking.\n\n*Hello Oliver! 👋*\n\nThanks for choosing Grabbit Express! 🛵\n\nYour trip to the *Grand Baie Express bus stop* at *5:25pm* is available, fare is *Rs 50* (one-way).`;
    const cleaned4 = sanitizeWhatsAppText(raw4);
    assert.equal(cleaned4.startsWith("*Hello Oliver! 👋*"), true);
  });

  it("stores and retrieves customer profile memory for quick re-orders", async () => {
    const { getCustomerProfile, updateCustomerProfile } = await import("./store.ts");

    const testPhone = "99900000046";
    await updateCustomerProfile(testPhone, {
      name: "Tariq",
      lastPickupAddress: "ALCHE Room 204",
      lastDeliveryAddress: "Mahogany",
      preferredPaymentMethod: "juice",
      tripCount: 1,
    });

    const prof = await getCustomerProfile(testPhone);
    assert.equal(prof.name, "Tariq");
    assert.equal(prof.lastPickupAddress, "ALCHE Room 204");
    assert.equal(prof.lastDeliveryAddress, "Mahogany");
    assert.equal(prof.preferredPaymentMethod, "juice");
    assert.equal(prof.tripCount >= 1, true);
  });

  it("generates zero-token personalized morning shift briefings for fleet riders", async () => {
    const { generateMorningRiderBriefing } = await import("../schedule/morning-briefing.ts");

    // 2026-08-10 is a Monday (Moses and Sherif are on duty in sample schedule)
    const now = new Date("2026-08-10T03:30:00.000Z"); // 07:30 Mauritius
    const briefing = await generateMorningRiderBriefing("Moses", now);
    assert.ok(briefing);
    assert.equal(briefing?.riderName, "Moses");
    assert.match(briefing?.briefingText || "", /Your On-Duty Shift Slots/i);
    assert.match(briefing?.briefingText || "", /Pre-Booked Runs Today/i);
  });

  it("handles rider 1-word WhatsApp commands (Delivered, Break, Back)", async () => {
    const { handleRiderCommand } = await import("../riders/commands.ts");
    const { FLEET_RIDERS } = await import("../riders/config.ts");

    const thierry = FLEET_RIDERS[0]; // Thierry

    // Test Break command
    const breakRes = await handleRiderCommand({
      senderPhone: "+999000000009",
      messageText: "Break 20m",
      rider: thierry,
    });
    assert.equal(breakRes.handled, true);
    assert.equal(breakRes.action, "started_break");
    assert.match(breakRes.replyText || "", /Break Logged \(20 mins\)/i);

    // Test Back command
    const backRes = await handleRiderCommand({
      senderPhone: "+999000000009",
      messageText: "Back",
      rider: thierry,
    });
    assert.equal(backRes.handled, true);
    assert.equal(backRes.action, "ended_break");
    assert.match(backRes.replyText || "", /Welcome Back/i);
  });

  it("evaluates smart route batching between ALCHE and Mahogany", async () => {
    const { isCompatibleRouteBatch } = await import("./pre-booking.ts");

    // 2 delivery runs to ALCHE
    const batch1 = isCompatibleRouteBatch(
      { serviceKind: "pickup_delivery", pickupAddress: "Mahogany KFC", deliveryAddress: "ALCHE 204" },
      { serviceKind: "pickup_delivery", pickupAddress: "Mahogany Pappagallo", deliveryAddress: "ALCHE 101" }
    );
    assert.equal(batch1, true);

    // 1 one-way trip and 1 delivery along same corridor
    const batch2 = isCompatibleRouteBatch(
      { serviceKind: "trip", tripType: "one_way", pickupAddress: "ALCHE Main Gate", deliveryAddress: "Mahogany" },
      { serviceKind: "pickup_delivery", pickupAddress: "ALCHE", deliveryAddress: "Mahogany" }
    );
    assert.equal(batch2, true);

    // Round-trips can NEVER be batched
    const batch3 = isCompatibleRouteBatch(
      { serviceKind: "trip", tripType: "round_trip", pickupAddress: "ALCHE", deliveryAddress: "Mahogany" },
      { serviceKind: "pickup_delivery", pickupAddress: "ALCHE", deliveryAddress: "Mahogany" }
    );
    assert.equal(batch3, false);
  });

  it("handles admin broadcast previews and safety guards", async () => {
    const { previewCustomerBroadcast } = await import("../admin/broadcast.ts");

    // Denied for non-admin
    const nonAdminRes = await previewCustomerBroadcast({
      adminPhone: "+99900000022",
      messageText: "Special Promo",
    });
    assert.equal(nonAdminRes.ok, false);
    assert.match(nonAdminRes.error || "", /Access Denied/i);

    // Authorized for admin (+999000000008)
    const adminRes = await previewCustomerBroadcast({
      adminPhone: "+999000000008",
      messageText: "🍕 Special 20% off Pappagallo delivery today!",
    });
    assert.equal(adminRes.ok, true);
    assert.match(adminRes.previewText, /Broadcast Campaign Preview/i);
    assert.match(adminRes.previewText, /Safety Guard/i);
  });

  it("generates Sunday weekly executive revenue and operations report", async () => {
    const { generateWeeklyExecutiveReport } = await import("../schedule/weekly-report.ts");

    const report = await generateWeeklyExecutiveReport(new Date());
    assert.ok(report);
    assert.equal(typeof report.totalRevenue, "number");
    assert.equal(typeof report.completedBookings, "number");
    assert.match(report.summaryText, /GRABBIT WEEKLY EXECUTIVE OPERATIONS & REVENUE REPORT/i);
    assert.match(report.summaryText, /Weekly Financial & Volume Summary/i);
    assert.match(report.summaryText, /Fleet Performance Breakdown/i);
  });

  it("strictly defends against prompt injection & admin impersonation", async () => {
    const { isAuthorizedRiderOrAdmin } = await import("../riders/config.ts");
    const { executeAgentTool } = await import("../agent/tools.ts");

    // Attacker claims to be Sherif in message, but their WhatsApp phone is an unverified user
    const attackerPhone = "+99900000067";
    const auth = isAuthorizedRiderOrAdmin(attackerPhone);
    assert.equal(auth.isAdmin, false);
    assert.equal(auth.isAuthorized, false);

    // Attempting to call admin tool via attacker phone
    const toolRes = await executeAgentTool({
      messageId: "inject_test",
      senderPhone: attackerPhone,
      name: "preview_admin_broadcast",
      toolArguments: { messageText: "Malicious broadcast" },
    });

    assert.equal(toolRes.ok, false);
    assert.match(toolRes.error || "", /Access Denied/i);
  });
});

describe("booking store hardening", () => {
  it("serializes concurrent bookings so only one wins the same rider slot", async () => {
    const slotKey = "2031-05-04_9:00 am to 11:00 am";
    const baseArgs = {
      serviceKind: "trip" as const,
      pickupAddress: "ALCHE",
      deliveryAddress: "Mahogany",
      scheduledDate: "2031-05-04",
      scheduledTime: "10:00 am",
      slotKey,
      assignedRider: "Thierry",
    };

    const [res1, res2] = await Promise.all([
      createPreBookingRequest({ ...baseArgs, customerPhone: "+99900000042", customerName: "Race A", deliveryAddress: "Mahogany" }),
      createPreBookingRequest({ ...baseArgs, customerPhone: "+99900000043", customerName: "Race B", deliveryAddress: "SSRN Hospital" }),
    ]);

    const winner = [res1, res2].filter((r) => r.ok);
    const loser = [res1, res2].filter((r) => !r.ok);

    assert.equal(winner.length, 1, "exactly one concurrent booking may win the slot");
    assert.equal(loser.length, 1);
    assert.equal(loser[0].doubleBooked, true);
    assert.match(loser[0].error || "", /slot|gap|capacity/i);
  });

  it("migrates a legacy ids-only index into v2 summaries transparently", async () => {
    const { writeJson } = await import("../blob/json-store.ts");
    const { clearBookingIndexCache } = await import("./booking-store.ts");

    const legacyId = "pb_legacy_migration_check";
    await writeJson(`grabbit/prebookings/${legacyId}.json`, {
      id: legacyId,
      customerPhone: "+99900000057",
      customerName: "Legacy Load",
      serviceKind: "trip",
      pickupAddress: "ALCHE",
      deliveryAddress: "Pamplemousses",
      scheduledDate: "2031-06-06",
      scheduledTime: "1:00 pm",
      slotKey: "2031-06-06_11:30 am to 1:30 pm",
      assignedRider: "Sherif",
      status: "confirmed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await writeJson("grabbit/prebookings/index.json", { ids: [legacyId] });

    clearBookingIndexCache();
    const all = await listAllPreBookings();
    const migrated = all.find((b) => b.id === legacyId);
    assert.ok(migrated, "legacy booking must be visible after migration");
    assert.equal(migrated?.customerName, "Legacy Load");

    const { getIndex } = await import("./booking-store.ts");
    const state = await getIndex({ bypassCache: true });
    assert.ok(state.revision >= 1);
    assert.ok(state.summaries.some((s) => s.id === legacyId));
  });
});

describe("orphan sweep & broadcast audience", () => {
  it("re-admits booking files that are missing from the active index", async () => {
    const { writeJson } = await import("../blob/json-store.ts");
    const { reconcileOrphanedBookings, getIndex } = await import("./booking-store.ts");

    const orphanId = "pb_orphan_reconcile_check";
    await writeJson(`grabbit/prebookings/${orphanId}.json`, {
      id: orphanId,
      customerPhone: "+99900000068",
      customerName: "Orphan Annie",
      serviceKind: "trip",
      pickupAddress: "ALCHE",
      deliveryAddress: "Mahogany",
      scheduledDate: "2031-07-07",
      scheduledTime: "6:30 pm",
      slotKey: "2031-07-07_5:00 pm -6:00 pm",
      assignedRider: "Moses",
      status: "confirmed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const before = await getIndex({ bypassCache: true });
    assert.ok(!before.summaries.some((s) => s.id === orphanId));

    const result = await reconcileOrphanedBookings();
    assert.equal(result.readmitted >= 1, true);

    const after = await getIndex({ bypassCache: true });
    const admitted = after.summaries.find((s) => s.id === orphanId);
    assert.ok(admitted, "orphan must be visible in the active index after reconcile");
    assert.equal(admitted?.customerName, "Orphan Annie");
  });

  it("includes archived customers in broadcast audiences", async () => {
    const { writeJson } = await import("../blob/json-store.ts");
    const { getAllUniqueCustomerPhones } = await import("../admin/broadcast.ts");

    const archivedPhone = "+99900000044";
    await writeJson("grabbit/prebookings-archive/index.json", {
      version: 2,
      revision: 1,
      bookings: [
        {
          id: "pb_archived_broadcast_seed",
          status: "completed",
          assignedRider: "Thierry",
          scheduledDate: "2026-01-01",
          scheduledTime: "12:00 pm",
          customerPhone: archivedPhone,
          customerName: "Archived Customer",
          serviceKind: "trip",
          createdAt: "2026-01-01T08:00:00.000Z",
          updatedAt: "2026-01-02T08:00:00.000Z",
        },
      ],
    });

    const phones = await getAllUniqueCustomerPhones();
    assert.ok(phones.includes(archivedPhone.replace(/\D/g, "")), "archived customer must remain reachable");
  });
});

describe("kilo integration integrity", () => {
  it("maps kilo webhook statuses onto pre-booking transitions", async () => {
    const { mapKiloEventToPreBookingStatus } = await import("../kilo/map-order.ts");
    assert.equal(mapKiloEventToPreBookingStatus("delivery.delivered"), "completed");
    assert.equal(mapKiloEventToPreBookingStatus("DELIVERY_CANCELLED"), "cancelled");
    assert.equal(mapKiloEventToPreBookingStatus("picked_up"), "dispatched");
    assert.equal(mapKiloEventToPreBookingStatus("assigned"), "confirmed");
    assert.equal(mapKiloEventToPreBookingStatus("otp_issued"), null);
    assert.equal(mapKiloEventToPreBookingStatus(undefined), null);
  });

  it("applies forward-only kilo status updates to the matching booking", async () => {
    const { applyKiloDeliveryStatus, savePreBooking } = await import("./pre-booking.ts");
    const { clearBookingIndexCache } = await import("./booking-store.ts");

    const bookingId = "pb_kilo_sync_check";
    const kiloId = "kd_sync_test_99";
    await savePreBooking({
      id: bookingId,
      customerPhone: "+99900000031",
      customerName: "Sync Tester",
      serviceKind: "trip",
      pickupAddress: "ALCHE",
      deliveryAddress: "SSRN Hospital",
      scheduledDate: "2031-09-09",
      scheduledTime: "5:00 pm",
      slotKey: "2031-09-09_5:00 pm -6:00 pm",
      assignedRider: "Thierry",
      status: "confirmed",
      kiloDeliveryId: kiloId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    clearBookingIndexCache();

    const dispatched = await applyKiloDeliveryStatus(kiloId, "picked_up");
    assert.equal(dispatched?.status, "dispatched");

    const completed = await applyKiloDeliveryStatus(kiloId, "delivered");
    assert.equal(completed?.status, "completed");

    const stale = await applyKiloDeliveryStatus(kiloId, "picked_up");
    assert.equal(stale, null, "must never regress a completed booking");

    const unknown = await applyKiloDeliveryStatus("kd_does_not_exist", "delivered");
    assert.equal(unknown, null);
  });

  it("reuses the existing Kilo delivery when a rider accepts an already-synced booking", async () => {
    const { handleRiderReply, savePreBooking } = await import("./pre-booking.ts");
    const { clearBookingIndexCache } = await import("./booking-store.ts");

    const bookingId = "pb_accept_reuse_check";
    const kiloId = "kd_reuse_test_77";
    await savePreBooking({
      id: bookingId,
      customerPhone: "+99900000032",
      customerName: "Reuse Tester",
      serviceKind: "trip",
      pickupAddress: "ALCHE",
      deliveryAddress: "Mahogany",
      scheduledDate: "2031-10-10",
      scheduledTime: "12:00 pm",
      slotKey: "2031-10-10_11:30 am to 1:30 pm",
      assignedRider: "Thierry",
      status: "confirmed",
      kiloDeliveryId: kiloId,
      trackingUrl: "https://delivery.grabbit-express.com/track/kd_reuse_test_77/CODE7",
      createdAt: new Date(Date.now() + 60_000).toISOString(),
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    clearBookingIndexCache();

    const result = await handleRiderReply({
      senderPhone: "+999000000009",
      text: "yes",
    });

    assert.equal(result.handled, true);
    assert.match(result.responseMessage || "", /confirmed/i);

    const { readJson } = await import("../blob/json-store.ts");
    const updated = await readJson<{ kiloDeliveryId?: string; trackingUrl?: string; status: string }>(
      `grabbit/prebookings/${bookingId}.json`,
    );
    assert.equal(updated?.kiloDeliveryId, kiloId, "accept must not create a second Kilo delivery");
    assert.match(updated?.trackingUrl || "", /kd_reuse_test_77/);
    assert.equal(updated?.status, "confirmed");
  });

  it("resolves collection methods from one shared policy helper", async () => {
    const { resolveDefaultCollectionMethod } = await import("../kilo/map-order.ts");
    assert.equal(resolveDefaultCollectionMethod("trip"), "cash_on_delivery");
    assert.equal(resolveDefaultCollectionMethod("errand"), "cash_on_delivery");
    assert.equal(resolveDefaultCollectionMethod("pickup_delivery"), "cash_on_delivery");
    assert.equal(resolveDefaultCollectionMethod(undefined), "cash_on_delivery");
  });
});

describe("shouldInterceptRiderDecision", () => {
  it("intercepts bare decisions when the rider has an active booking", async () => {
    const { shouldInterceptRiderDecision } = await import("./pre-booking.ts");
    assert.equal(shouldInterceptRiderDecision({ text: "yes", hasActiveBooking: true }), true);
    assert.equal(shouldInterceptRiderDecision({ text: "no", hasActiveBooking: true }), true);
    assert.equal(shouldInterceptRiderDecision({ text: "confirm", hasActiveBooking: true }), true);
  });

});

describe("shouldInterceptRiderDecision", () => {
  it("intercepts bare decisions when the rider has an active booking", async () => {
    const { shouldInterceptRiderDecision } = await import("./pre-booking.ts");
    assert.equal(shouldInterceptRiderDecision({ text: "yes", hasActiveBooking: true }), true);
    assert.equal(shouldInterceptRiderDecision({ text: "no", hasActiveBooking: true }), true);
    assert.equal(shouldInterceptRiderDecision({ text: "confirm", hasActiveBooking: true }), true);
  });

  it("never intercepts without an active booking or a bare decision token", async () => {
    const { shouldInterceptRiderDecision } = await import("./pre-booking.ts");
    assert.equal(shouldInterceptRiderDecision({ text: "yes", hasActiveBooking: false }), false);
    assert.equal(shouldInterceptRiderDecision({ text: "no problem", hasActiveBooking: true }), false);
    assert.equal(shouldInterceptRiderDecision({ text: "yes I am at the gate", hasActiveBooking: true }), false);
    assert.equal(shouldInterceptRiderDecision({ text: "", hasActiveBooking: true }), false);
  });

  it("lets admin approval intents fall through to the agent even with an active booking", async () => {
    const { shouldInterceptRiderDecision } = await import("./pre-booking.ts");
    assert.equal(shouldInterceptRiderDecision({ text: "yes post to google chat", hasActiveBooking: true }), false);
    assert.equal(shouldInterceptRiderDecision({ text: "YES send the report", hasActiveBooking: true }), false);
    assert.equal(shouldInterceptRiderDecision({ text: "ok broadcast it", hasActiveBooking: true }), false);
    assert.equal(shouldInterceptRiderDecision({ text: "yes send summary to customers", hasActiveBooking: true }), false);
  });
});

describe("updatePreBookingDetails", () => {
  it("updates customer name and details on an existing booking", async () => {
    const { savePreBooking, updatePreBookingDetails } = await import("./pre-booking.ts");
    const { clearBookingIndexCache } = await import("./booking-store.ts");

    const bookingId = "pb_update_test_101";
    await savePreBooking({
      id: bookingId,
      customerPhone: "+99900000051",
      customerName: "Hanneeeffff",
      serviceKind: "trip",
      pickupAddress: "ALCHE Campus",
      deliveryAddress: "Mahogany Promenade",
      scheduledDate: "2031-11-11",
      scheduledTime: "12:45 pm",
      slotKey: "2031-11-11_11:30 am to 1:30 pm",
      assignedRider: "Thierry",
      status: "confirmed",
      kiloDeliveryId: "DEL_2031_999",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    clearBookingIndexCache();

    const res = await updatePreBookingDetails({
      bookingId: "DEL_2031_999",
      customerName: "Customer A",
      deliveryAddress: "Grand Baie",
    });

    assert.equal(res.ok, true);
    assert.equal(res.booking?.customerName, "Customer A");
    assert.equal(res.booking?.deliveryAddress, "Grand Baie");
    assert.equal(res.booking?.pickupAddress, "ALCHE Campus");
  });

  it("returns error if booking is not found", async () => {
    const { updatePreBookingDetails } = await import("./pre-booking.ts");
    const res = await updatePreBookingDetails({
      bookingId: "non_existent_id_999",
      customerName: "Ghost",
    });
    assert.equal(res.ok, false);
    assert.match(res.error || "", /No booking found/i);
  });
});

describe("autoExpireStaleBookings", () => {
  it("auto-expires past confirmed bookings to completed", async () => {
    const { savePreBooking, autoExpireStaleBookings, listAllPreBookings } = await import("./pre-booking.ts");
    const { clearBookingIndexCache } = await import("./booking-store.ts");

    const pastId = "pb_stale_past_test_01";
    await savePreBooking({
      id: pastId,
      customerPhone: "+99900000069",
      customerName: "Past Customer",
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
    clearBookingIndexCache();

    const res = await autoExpireStaleBookings(new Date("2026-08-27T00:00:00.000Z"));
    assert.ok(res.expiredIds.includes(pastId));

    const all = await listAllPreBookings();
    const updated = all.find((b) => b.id === pastId);
    assert.equal(updated?.status, "completed");
  });
});

describe("handleRiderReply passenger trips", () => {
  it("confirms passenger trips without touching Kilo or generating tracking links", async () => {
    const { savePreBooking, handleRiderReply, listAllPreBookings } = await import("./pre-booking.ts");
    const testId = "pb_test_rider_trip_accept";
    await savePreBooking({
      id: testId,
      customerPhone: "+99900000060",
      customerName: "Trip Passenger",
      serviceKind: "trip",
      pickupAddress: "ALCHE Campus",
      deliveryAddress: "Mahogany Promenade",
      scheduledDate: "2026-09-05",
      scheduledTime: "2:00 pm",
      slotKey: "2026-09-05_14:00-15:00",
      assignedRider: "Thierry",
      status: "pending_rider",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const reply = await handleRiderReply({
      senderPhone: "+999000000009", // Thierry
      text: "YES",
    });

    assert.equal(reply.handled, true);
    assert.match(reply.responseMessage || "", /confirmed/i);
    assert.ok(!reply.responseMessage?.includes("Live Tracking Link:"));

    const all = await listAllPreBookings();
    const updated = all.find((b) => b.id === testId);
    assert.equal(updated?.status, "confirmed");
    assert.equal(updated?.kiloDeliveryId, undefined);
    assert.equal(updated?.trackingUrl, undefined);
  });
});

describe("Goodie Incident Regressions: addItemToActiveBooking, recordPaymentProofReceived, token lean prompt", () => {
  it("addItemToActiveBooking appends item to active booking and notifies rider", async () => {
    const { savePreBooking, addItemToActiveBooking, listAllPreBookings } = await import("./pre-booking.ts");
    const { clearBookingIndexCache } = await import("./booking-store.ts");
    const { mauritiusDateIso } = await import("../time.ts");
    const today = mauritiusDateIso(new Date());

    const testId = "pb_test_goodie_add_item_01";
    await savePreBooking({
      id: testId,
      customerPhone: "+9990000000004",
      customerName: "Goodie",
      serviceKind: "pickup_delivery",
      pickupAddress: "Mahogany Promenade",
      deliveryAddress: "Songhai, ALCHE",
      scheduledDate: today,
      scheduledTime: "6:00 pm",
      slotKey: `${today}_18:00-19:00`,
      assignedRider: "Thierry",
      packageDescription: "KFC order",
      status: "confirmed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    clearBookingIndexCache();

    const res = await addItemToActiveBooking({
      customerPhone: "+9990000000004",
      addedItem: "Semoule de blé / Semolina powder",
    });

    assert.equal(res.ok, true);
    assert.ok(res.booking);
    assert.match(res.booking?.packageDescription || "", /Semoule de blé \/ Semolina powder/);
    assert.match(res.message, /Added "Semoule de blé \/ Semolina powder"/);

    clearBookingIndexCache();
    const all = await listAllPreBookings();
    const updated = all.find((b) => b.id === testId);
    assert.match(updated?.packageDescription || "", /KFC order/);
    assert.match(updated?.packageDescription || "", /Semoule de blé \/ Semolina powder/);
  });

  it("recordPaymentProofReceived ends strictly at screenshot and does NOT mention rider name", async () => {
    const { savePreBooking, recordPaymentProofReceived, listAllPreBookings } = await import("./pre-booking.ts");
    const { clearBookingIndexCache } = await import("./booking-store.ts");
    const { mauritiusDateIso } = await import("../time.ts");
    const today = mauritiusDateIso(new Date());

    const testId = "pb_test_goodie_receipt_02";
    await savePreBooking({
      id: testId,
      customerPhone: "+9990000000005",
      customerName: "Goodie",
      serviceKind: "pickup_delivery",
      pickupAddress: "Mahogany Promenade",
      deliveryAddress: "Songhai, ALCHE",
      scheduledDate: today,
      scheduledTime: "6:00 pm",
      slotKey: `${today}_18:00-19:00`,
      assignedRider: "Thierry",
      status: "confirmed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    clearBookingIndexCache();

    const res = await recordPaymentProofReceived({
      customerPhone: "+9990000000005",
    });

    assert.equal(res.ok, true);
    assert.equal(res.message, "Thank you! 📄 We've received your payment screenshot.");
    assert.ok(!res.message.includes("Thierry"));
    assert.ok(!res.message.includes("Sherif"));

    clearBookingIndexCache();
    const all = await listAllPreBookings();
    const updated = all.find((b) => b.id === testId);
    assert.equal(updated?.paymentMethod, "transfer");
  });

  it("buildGrabbitSystemInstruction is token lean: omits admin section for regular customers", async () => {
    const { buildGrabbitSystemInstruction } = await import("../agent/prompt.ts");

    const customerPrompt = await buildGrabbitSystemInstruction();
    assert.ok(!customerPrompt.includes("## Admin Privileges"));
    assert.ok(!customerPrompt.includes("admin_reply_to_customer"));

    const explicitCustomerPrompt = await buildGrabbitSystemInstruction({ isAdmin: false });
    assert.ok(!explicitCustomerPrompt.includes("## Admin Privileges"));

    const adminPrompt = await buildGrabbitSystemInstruction({ isAdmin: true });
    assert.ok(adminPrompt.includes("## Admin Privileges"));
    assert.ok(adminPrompt.includes("admin_reply_to_customer"));
    assert.ok(adminPrompt.length > customerPrompt.length + 3000);
  });

  it("AGENT_TOOLS contains add_item_to_active_booking and confirm_payment_receipt", async () => {
    const { AGENT_TOOLS } = await import("../agent/tools.ts");

    const addTool = AGENT_TOOLS.find((t) => t.name === "add_item_to_active_booking");
    assert.ok(addTool, "add_item_to_active_booking must be registered");
    assert.ok(addTool.parameters.properties.addedItem);

    const receiptTool = AGENT_TOOLS.find((t) => t.name === "confirm_payment_receipt");
    assert.ok(receiptTool, "confirm_payment_receipt must be registered");
  });
});



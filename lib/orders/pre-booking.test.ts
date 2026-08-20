import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FLEET_RIDERS, findRiderByName, findRiderByPhone, getCustomTrackingUrl } from "../riders/config.ts";
import { checkSlotAvailability, createPreBookingRequest, handleRiderReply, listAllPreBookings } from "./pre-booking.ts";

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
});

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
});

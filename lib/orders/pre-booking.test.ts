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
    assert.match(tracking, /delivery\.grabbit-express\.com\/track\//);
    assert.match(tracking, /ACC-123/);
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
    assert.match(book2.error || "", /booked/i);
  });

  it("stores tripType for round trips and handles rider decline cascade", async () => {
    const slotKey = "2026-09-02_14:00-15:00";
    const book = await createPreBookingRequest({
      customerPhone: "+99900000024",
      customerName: "Charlie",
      serviceKind: "trip",
      tripType: "round_trip",
      pickupAddress: "ALCHE main gate",
      deliveryAddress: "Mahogany Promenade",
      scheduledDate: "2026-09-02",
      scheduledTime: "2:00 pm",
      slotKey,
      assignedRider: "Thierry",
    });

    assert.equal(book.ok, true);
    assert.equal(book.booking?.tripType, "round_trip");
    assert.equal(book.booking?.assignedRider, "Thierry");

    // Thierry declines -> should cascade to Sherif
    const declineRes = await handleRiderReply({
      senderPhone: "+999000000009", // Thierry's phone
      text: "NO",
    });

    assert.equal(declineRes.handled, true);
    assert.match(declineRes.responseMessage || "", /Reassigning request to/i);
  });
});

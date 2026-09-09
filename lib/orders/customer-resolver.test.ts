import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeCustomerPhone, resolveCustomerIdentity } from "./customer-resolver.ts";
import { savePreBooking } from "./pre-booking.ts";

describe("customer-resolver", () => {
  it("normalizes 8-digit Mauritian mobile numbers to 2305XXXXXXX", () => {
    assert.equal(normalizeCustomerPhone("58589448"), "99900000054");
    assert.equal(normalizeCustomerPhone("59323776"), "99900000065");
    assert.equal(normalizeCustomerPhone("+230 5858 9448"), "99900000054");
    assert.equal(normalizeCustomerPhone("9990000000003"), "9990000000003");
  });

  it("resolves customer identity from active bookings by name", async () => {
    await savePreBooking({
      id: "pb_test_resolver_customerb",
      customerPhone: "+99900000054",
      customerName: "Customer B",
      serviceKind: "trip",
      pickupAddress: "ALCHE Campus",
      deliveryAddress: "SSRN Hospital",
      scheduledDate: "2026-09-02",
      scheduledTime: "11:30 am",
      slotKey: "2026-09-02_11:30-12:30",
      assignedRider: "Moses",
      status: "confirmed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const resolved = await resolveCustomerIdentity("Customer B");
    assert.ok(resolved);
    assert.equal(resolved.phone, "99900000054");
    assert.equal(resolved.name, "Customer B");
    assert.equal(resolved.formattedPhone, "+99900000054");
  });

  it("resolves customer identity from phone number input", async () => {
    const resolved = await resolveCustomerIdentity("58589448");
    assert.ok(resolved);
    assert.equal(resolved.phone, "99900000054");
  });

  it("never resolves pronouns like 'me', 'us', 'bot' to a customer", async () => {
    await savePreBooking({
      id: "pb_test_resolver_james",
      customerPhone: "+99900000070",
      customerName: "James Sanga",
      serviceKind: "trip",
      pickupAddress: "ALCHE Campus",
      deliveryAddress: "Mahogany Promenade",
      scheduledDate: "2026-09-09",
      scheduledTime: "5:00 pm",
      slotKey: "2026-09-09_17:00-18:00",
      assignedRider: "Sherif",
      status: "confirmed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const forMe = await resolveCustomerIdentity("me");
    assert.equal(forMe, null, "query 'me' must never resolve to James Sanga");

    const forUs = await resolveCustomerIdentity("us");
    assert.equal(forUs, null, "query 'us' must never resolve to any customer");

    const forBot = await resolveCustomerIdentity("bot");
    assert.equal(forBot, null, "query 'bot' must never resolve to any customer");

    // But searching for "James" directly still resolves James Sanga
    const forJames = await resolveCustomerIdentity("James");
    assert.ok(forJames);
    assert.equal(forJames.name, "James Sanga");
  });
});

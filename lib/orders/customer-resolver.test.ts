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
});

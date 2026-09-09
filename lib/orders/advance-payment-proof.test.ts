import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  savePendingPaymentProof,
  getAndConsumePendingPaymentProof,
} from "./pending-proofs.ts";
import {
  savePreBooking,
  recordPaymentProofReceived,
  createPreBookingRequest,
  type PreBooking,
} from "./pre-booking.ts";
import { mauritiusDateIso } from "../time.ts";

describe("Advance Payment Proof & Multi-Booking Disambiguation", () => {
  it("stores and consumes advance payment proofs within TTL", async () => {
    const testPhone = "+99900000072";
    await savePendingPaymentProof({
      customerPhone: testPhone,
      bank: "MCB Juice",
      amount: 150,
      currency: "MUR",
      referenceId: "FT26998811",
      status: "successful",
    });

    const consumed = await getAndConsumePendingPaymentProof(testPhone);
    assert.ok(consumed);
    assert.equal(consumed.bank, "MCB Juice");
    assert.equal(consumed.amount, 150);
    assert.equal(consumed.referenceId, "FT26998811");

    // Second consumption must be null because it was consumed
    const secondConsume = await getAndConsumePendingPaymentProof(testPhone);
    assert.equal(secondConsume, null);
  });

  it("auto-links advance payment proof when booking is subsequently created", async () => {
    const testPhone = `+2305888${Date.now().toString().slice(-4)}`;
    const todayIso = mauritiusDateIso(new Date());

    // 1. Customer sends Juice transfer receipt BEFORE booking
    const receiptRes = await recordPaymentProofReceived({
      customerPhone: testPhone,
      bank: "MCB Juice",
      amount: 175,
      currency: "MUR",
      referenceId: "FT_ADVANCE_TEST",
      status: "successful",
    });

    assert.equal(receiptRes.ok, true);
    assert.equal(receiptRes.booking, undefined);
    assert.match(receiptRes.message, /recorded your MCB Juice receipt of Rs 175/);

    // 2. Customer now books the trip
    const bookingRes = await createPreBookingRequest({
      customerPhone: testPhone,
      customerName: "Advance Customer",
      serviceKind: "trip",
      pickupAddress: "ALCHE Campus",
      deliveryAddress: "Mahogany Promenade",
      scheduledDate: todayIso,
      scheduledTime: "11:00 am",
      slotKey: `${todayIso}_11:00-12:00`,
      assignedRider: "Thierry",
    });

    assert.equal(bookingRes.ok, true);
    assert.ok(bookingRes.booking);
    assert.equal(bookingRes.booking.paymentMethod, "transfer");
    assert.match(bookingRes.booking.notes || "", /Auto-linked advance payment/);
    assert.match(bookingRes.booking.notes || "", /FT_ADVANCE_TEST/);
  });

  it("matches receipt amount to the correct booking when customer has multiple active bookings", async () => {
    const testPhone = `+2305777${Date.now().toString().slice(-4)}`;
    const todayIso = mauritiusDateIso(new Date());

    // Booking 1: Rs 120
    const booking1: PreBooking = {
      id: `multi_test_1_${Date.now()}`,
      customerPhone: testPhone,
      customerName: "Multi Booker",
      serviceKind: "pickup_delivery",
      pickupAddress: "Mahogany",
      deliveryAddress: "ALCHE",
      scheduledDate: todayIso,
      scheduledTime: "01:00 pm",
      slotKey: `${todayIso}_13:00-14:00`,
      assignedRider: "Sherif",
      status: "confirmed",
      fareAmount: 120,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await savePreBooking(booking1);

    // Booking 2: Rs 200
    const booking2: PreBooking = {
      id: `multi_test_2_${Date.now()}`,
      customerPhone: testPhone,
      customerName: "Multi Booker",
      serviceKind: "trip",
      pickupAddress: "ALCHE",
      deliveryAddress: "SSRN Hospital",
      scheduledDate: todayIso,
      scheduledTime: "04:00 pm",
      slotKey: `${todayIso}_16:00-17:00`,
      assignedRider: "Thierry",
      status: "confirmed",
      fareAmount: 200,
      createdAt: new Date(Date.now() + 1000).toISOString(),
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    };
    await savePreBooking(booking2);

    // Send receipt for Rs 200
    const matchRes = await recordPaymentProofReceived({
      customerPhone: testPhone,
      bank: "MCB Juice",
      amount: 200,
      referenceId: "FT_MATCH_200",
      status: "successful",
    });

    assert.equal(matchRes.ok, true);
    assert.ok(matchRes.booking);
    // Must match Booking 2 (Rs 200), NOT Booking 1 (Rs 120)
    assert.equal(matchRes.booking.id, booking2.id);
    assert.equal(matchRes.booking.paymentMethod, "transfer");
    assert.match(matchRes.booking.notes || "", /FT_MATCH_200/);
  });
});

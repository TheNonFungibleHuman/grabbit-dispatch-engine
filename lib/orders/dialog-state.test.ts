import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCustomerSessionContext } from "./dialog-state.ts";
import { savePreBooking } from "./pre-booking.ts";
import { mauritiusDateIso } from "../time.ts";

describe("Customer Dialog State (FSM)", () => {
  const customerPhone = "+99900000051";
  const today = mauritiusDateIso(new Date());

  it("returns idle state when customer has no active bookings", async () => {
    const ctx = await getCustomerSessionContext("+99900000017");
    assert.equal(ctx.state, "idle");
    assert.equal(ctx.activeBooking, undefined);
  });

  it("identifies awaiting_payment state when booking is pending transfer proof", async () => {
    await savePreBooking({
      id: "pb_test_dialog_awaiting_payment",
      customerPhone,
      customerName: "Dialog Tester",
      serviceKind: "pickup_delivery",
      pickupAddress: "Mahogany",
      deliveryAddress: "ALCHE",
      scheduledDate: today,
      scheduledTime: "6:00 pm",
      slotKey: `${today}_18:00-19:00`,
      assignedRider: "Thierry",
      paymentMethod: "juice",
      status: "confirmed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const ctx = await getCustomerSessionContext(customerPhone);
    assert.equal(ctx.state, "awaiting_payment");
    assert.equal(ctx.activeBooking?.id, "pb_test_dialog_awaiting_payment");
  });

  it("transitions to active_trip state after payment proof is recorded", async () => {
    await savePreBooking({
      id: "pb_test_dialog_active_trip",
      customerPhone,
      customerName: "Dialog Tester",
      serviceKind: "pickup_delivery",
      pickupAddress: "Mahogany",
      deliveryAddress: "ALCHE",
      scheduledDate: today,
      scheduledTime: "6:00 pm",
      slotKey: `${today}_18:00-19:00`,
      assignedRider: "Thierry",
      paymentMethod: "transfer",
      status: "confirmed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const ctx = await getCustomerSessionContext(customerPhone);
    assert.equal(ctx.state, "active_trip");
  });
});

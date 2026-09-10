import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeAgentTool } from "./tools.ts";
import { listAllPreBookings } from "../orders/pre-booking.ts";

describe("pappagallo-pdf-booking", () => {
  it("books food delivery from Pappagallo immediately without blocking on strict pre-payment", async () => {
    const result = await executeAgentTool({
      name: "schedule_trip_or_delivery",
      toolArguments: {
        serviceKind: "delivery",
        pickupAddress: "Pappagallo, Mahogany",
        deliveryAddress: "Aksum Common Area 2, Mahogany",
        customerName: "BECCA",
        customerPhone: "+999000000011",
        scheduledDate: "today",
        scheduledTime: "7:00 pm",
        packageDescription: "Pappagallo Pizza: Spicy Meat Lovers (Medium), no chilli",
        paymentMethod: "transfer",
      },
      senderPhone: "+999000000011",
      pushName: "BECCA",
      messageId: "msg_test_becca_pizza",
    }) as { ok: boolean; bookingId?: string; assignedRider?: string; message?: string };

    assert.equal(result.ok, true);
    assert.ok(result.bookingId);
    assert.ok(result.assignedRider);

    const all = await listAllPreBookings();
    const beccaBooking = all.find((b) => b.id === result.bookingId);
    assert.ok(beccaBooking);
    assert.equal(beccaBooking.customerName, "BECCA");
    assert.equal(beccaBooking.pickupAddress, "Pappagallo, Mahogany");
    assert.equal(beccaBooking.deliveryAddress, "Aksum Common Area 2, Mahogany");
    assert.equal(beccaBooking.status, "confirmed");
  });

  it("defaults gracefully to cash when payment method is omitted on food orders", async () => {
    const result = await executeAgentTool({
      name: "schedule_trip_or_delivery",
      toolArguments: {
        serviceKind: "delivery",
        pickupAddress: "KFC, Mahogany",
        deliveryAddress: "ALCHE Campus",
        customerName: "Alex",
        customerPhone: "+99900000022",
        scheduledDate: "today",
        scheduledTime: "12:00 pm",
        packageDescription: "1x Bucket for one",
      },
      senderPhone: "+99900000022",
      pushName: "Alex",
      messageId: "msg_test_alex_kfc",
    }) as { ok: boolean; bookingId?: string; assignedRider?: string };

    assert.equal(result.ok, true);
    assert.ok(result.bookingId);
  });
});

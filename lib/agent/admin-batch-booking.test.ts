import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeAgentTool } from "./tools.ts";
import { listAllPreBookings, clearAllPreBookings } from "../orders/pre-booking.ts";

describe("admin_batch_booking_proxy", () => {
  it("persists bookings with customerPhone when scheduled by admin", async () => {
    await clearAllPreBookings();

    const adminPhone = "+9990000000003";
    const customerPhone = "+99900000065";
    const customerName = "Customer A";

    // Leg 1: Tuesday 12:45 pm
    const res1 = await executeAgentTool({
      name: "schedule_trip_or_delivery",
      toolArguments: JSON.stringify({
        serviceKind: "trip",
        customerName,
        customerPhone,
        pickupAddress: "ALCHE",
        deliveryAddress: "Mahogany Promenade",
        scheduledDate: "2026-09-02",
        scheduledTime: "12:45 pm",
        paymentMethod: "cash",
      }),
      senderPhone: adminPhone,
    });

    assert.equal((res1 as any).ok, true);

    // Leg 2: Thursday 12:45 pm
    const res2 = await executeAgentTool({
      name: "schedule_trip_or_delivery",
      toolArguments: JSON.stringify({
        serviceKind: "trip",
        customerName,
        customerPhone,
        pickupAddress: "ALCHE",
        deliveryAddress: "Mahogany Promenade",
        scheduledDate: "2026-09-03",
        scheduledTime: "12:45 pm",
        paymentMethod: "cash",
      }),
      senderPhone: adminPhone,
    });

    assert.equal((res2 as any).ok, true);

    // Leg 3: Friday 8:20 am
    const res3 = await executeAgentTool({
      name: "schedule_trip_or_delivery",
      toolArguments: JSON.stringify({
        serviceKind: "trip",
        customerName,
        customerPhone,
        pickupAddress: "ALCHE",
        deliveryAddress: "Mahogany Promenade",
        scheduledDate: "2026-09-04",
        scheduledTime: "8:20 am",
        paymentMethod: "cash",
      }),
      senderPhone: adminPhone,
    });

    assert.equal((res3 as any).ok, true);

    // Verify all 3 bookings exist in pre-booking database under customer's phone
    const all = await listAllPreBookings();
    const customerBookings = all.filter((b) => b.customerPhone === customerPhone);

    assert.equal(customerBookings.length, 3);
    assert.equal(customerBookings[0].customerName, "Customer A");
    assert.ok(customerBookings.some((b) => b.scheduledDate === "2026-09-02"));
    assert.ok(customerBookings.some((b) => b.scheduledDate === "2026-09-03"));
    assert.ok(customerBookings.some((b) => b.scheduledDate === "2026-09-04"));
  });
});

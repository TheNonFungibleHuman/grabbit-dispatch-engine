import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeAgentTool, isTestBookingRecord } from "./tools.ts";
import { listAllPreBookings, clearAllPreBookings } from "../orders/pre-booking.ts";
import { mauritiusDateIso } from "../time.ts";

function tomorrowIso(): string {
  return mauritiusDateIso(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

describe("Production booking resolution avoids sandbox records", () => {
  const liveBooking = () => ({
    id: "pb_live_customera",
    customerName: "Customer A",
    kiloDeliveryId: "DEL_2026_099",
    status: "confirmed",
    scheduledDate: tomorrowIso(),
    customerPhone: "+99900000065",
    createdAt: new Date().toISOString(),
  });
  const testBooking = (suffix: string) => ({
    id: `pb_test_${suffix}`,
    customerName: "Test Customer",
    kiloDeliveryId: `DEL_2026_TEST_${suffix}`,
    status: "confirmed",
    scheduledDate: tomorrowIso(),
    customerPhone: "+99900000074",
    createdAt: new Date().toISOString(),
  });

  it("identifies sandbox records by name", () => {
    assert.equal(isTestBookingRecord({ customerName: "Test Customer" }), true);
    assert.equal(isTestBookingRecord({ customerName: "Test trip, ALCHE" }), true);
    assert.equal(
      isTestBookingRecord({ customerName: "Customer A", kiloDeliveryId: "DEL_2026_099", id: "pb_1" }),
      false,
    );
    assert.equal(isTestBookingRecord({}), false);
  });

  it("mark-paid prefers the live customer booking over a test record", async () => {
    await clearAllPreBookings();
    const { savePreBooking } = await import("../orders/pre-booking.ts");
    const live = liveBooking();
    const test = testBooking("paid");
    await savePreBooking({ ...live, pickupAddress: "ALCHE", deliveryAddress: "Mahogany" } as never);
    await savePreBooking({ ...test, pickupAddress: "ALCHE", deliveryAddress: "Mahogany" } as never);

    const res = (await executeAgentTool({
      name: "mark_trip_paid_on_kilo",
      toolArguments: JSON.stringify({ identifier: "Customer A" }),
      senderPhone: "+999000000008",
    })) as { ok?: boolean; bookingId?: string; customerName?: string };

    assert.equal(res.ok, true);
    assert.equal(res.bookingId, live.id);
    assert.equal(res.customerName, "Customer A");
  });

  it("update_booking_details prefers the live customer booking over a test record", async () => {
    await clearAllPreBookings();
    const { savePreBooking } = await import("../orders/pre-booking.ts");
    const live = liveBooking();
    const test = testBooking("reassign");
    await savePreBooking({ ...live, pickupAddress: "ALCHE", deliveryAddress: "Mahogany" } as never);
    await savePreBooking({ ...test, pickupAddress: "ALCHE", deliveryAddress: "Mahogany" } as never);

    const res = (await executeAgentTool({
      name: "update_booking_details",
      toolArguments: JSON.stringify({
        customerNameOrPhone: "Customer A",
        assignedRider: "Moses",
      }),
      senderPhone: "+999000000008",
    })) as { ok?: boolean; bookingId?: string; assignedRider?: string };

    assert.equal(res.ok, true);
    assert.equal(res.bookingId, live.id);
    assert.equal(res.assignedRider, "Moses");
  });

  it("still resolves a test record when it is the only candidate", async () => {
    await clearAllPreBookings();
    const { savePreBooking } = await import("../orders/pre-booking.ts");
    const test = testBooking("only");
    await savePreBooking({ ...test, pickupAddress: "ALCHE", deliveryAddress: "Mahogany" } as never);

    const res = (await executeAgentTool({
      name: "update_booking_details",
      toolArguments: JSON.stringify({
        customerNameOrPhone: "Test Customer",
        assignedRider: "Moses",
      }),
      senderPhone: "+999000000008",
    })) as { ok?: boolean; bookingId?: string };

    assert.equal(res.ok, true);
    assert.equal(res.bookingId, test.id);
  });
});

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

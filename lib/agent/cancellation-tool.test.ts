import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adminCancelOrDeleteBooking,
  createPreBookingRequest,
  listAllPreBookings,
  clearAllPreBookings,
} from "../orders/pre-booking.ts";
import { executeAgentTool } from "./tools.ts";

describe("admin_cancel_or_delete_booking", () => {
  it("cancels booking matching query and updates status to cancelled", async () => {
    await clearAllPreBookings();

    const created = await createPreBookingRequest({
      customerPhone: "+99900000065",
      customerName: "Customer A",
      serviceKind: "trip",
      pickupAddress: "ALCHE",
      deliveryAddress: "Mahogany",
      scheduledDate: "2026-09-02",
      scheduledTime: "12:45 pm",
      slotKey: "2026-09-02_12:00 pm-1:00 pm",
      assignedRider: "Thierry",
    });

    assert.equal(created.ok, true);
    assert.ok(created.booking?.id);

    // Cancel using query "Customer A"
    const cancelRes = await adminCancelOrDeleteBooking({
      bookingIdOrQuery: "Customer A",
      targetDate: "2026-09-02",
    });

    assert.equal(cancelRes.ok, true);
    assert.equal(cancelRes.cancelledCount, 1);
    assert.equal(cancelRes.cancelledBookings[0].status, "cancelled");

    // Verify listAllPreBookings
    const all = await listAllPreBookings();
    const found = all.find((b) => b.id === created.booking?.id);
    assert.equal(found?.status, "cancelled");
  });

  it("handles test customer deletion queries", async () => {
    const created = await createPreBookingRequest({
      customerPhone: "+9990000000003",
      customerName: "Test Customer",
      serviceKind: "trip",
      pickupAddress: "ALCHE",
      deliveryAddress: "Mahogany",
      scheduledDate: "2026-09-02",
      scheduledTime: "2:00 pm",
      slotKey: "2026-09-02_2:00 pm-3:00 pm",
      assignedRider: "Sherif",
    });

    assert.equal(created.ok, true);

    const cancelRes = await adminCancelOrDeleteBooking({
      bookingIdOrQuery: "test customer",
    });

    assert.equal(cancelRes.ok, true);
    assert.ok(cancelRes.cancelledCount >= 1);
  });

  it("executes admin_cancel_or_delete_booking tool successfully when authorized", async () => {
    const created = await createPreBookingRequest({
      customerPhone: "+99900000029",
      customerName: "Oliver",
      serviceKind: "trip",
      pickupAddress: "ALCHE",
      deliveryAddress: "Grand Baie",
      scheduledDate: "2026-09-03",
      scheduledTime: "10:00 am",
      slotKey: "2026-09-03_10:00 am-11:00 am",
      assignedRider: "Moses",
    });

    assert.equal(created.ok, true);
    assert.ok(created.booking?.id);

    // Admin executes tool
    const toolRes = await executeAgentTool({
      name: "admin_cancel_or_delete_booking",
      toolArguments: JSON.stringify({
        bookingIdOrQuery: created.booking.id,
      }),
      senderPhone: "+999000000008", // Admin Sherif
    });

    assert.equal((toolRes as any).ok, true);
    assert.equal((toolRes as any).cancelledCount, 1);
  });

  it("rejects admin_cancel_or_delete_booking from non-admin users", async () => {
    const toolRes = await executeAgentTool({
      name: "admin_cancel_or_delete_booking",
      toolArguments: JSON.stringify({
        bookingIdOrQuery: "some_booking",
      }),
      senderPhone: "+99900000074", // Random customer
    });

    assert.equal((toolRes as any).ok, false);
    assert.match((toolRes as any).error, /Access Denied/i);
  });
});

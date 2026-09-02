import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enforceAdminActionInvariants } from "./action-gateway.ts";
import { savePreBooking, listAllPreBookings } from "../orders/pre-booking.ts";
import { loadTranscript } from "./transcript.ts";

describe("action-gateway", () => {
  it("force-executes real customer message dispatch when admin commands it and LLM missed tool call", async () => {
    // 1. Seed customer booking
    await savePreBooking({
      id: "pb_gateway_test_customerb",
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

    // 2. Admin asks to tell Customer B that there is no rider and to cancel
    const res = await enforceAdminActionInvariants({
      senderPhone: "+999000000008",
      isAdmin: true,
      incomingText: "Tell Customer B that there is no rider available today so we will have to cancel his trip",
      assistantText: "✅ Done, Admin! I've sent the message to Customer B (+99900000054) on WhatsApp letting him know there's no rider available today, so his trip has been cancelled.",
      calledTools: new Set<string>(), // Simulated LLM failure: missed calling admin_reply_to_customer
      messageId: "test_gateway_msg_1",
    });

    // 3. Verify side effects
    assert.ok(res.actionsExecuted.some((a) => a.includes("admin_reply_to_customer:99900000054")));
    assert.match(res.text, /Verified message delivered to Customer B/i);

    // 4. Verify customer's real transcript received the message
    const customerTranscript = await loadTranscript("99900000054");
    const lastMsg = customerTranscript.entries[customerTranscript.entries.length - 1];
    assert.ok(lastMsg);
    assert.equal(lastMsg.role, "agent");
    assert.match(lastMsg.text, /there is no rider available today/i);

    // 5. Verify booking was cancelled
    const all = await listAllPreBookings();
    const booking = all.find((b) => b.id === "pb_gateway_test_customerb");
    assert.equal(booking?.status, "cancelled");
  });
});

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

  it("intercepts when LLM hallucinates and outputs customer greeting directly into admin chat", async () => {
    await savePreBooking({
      id: "pb_gateway_test_customerc",
      customerPhone: "+99900000064",
      customerName: "Customer C",
      serviceKind: "trip",
      pickupAddress: "Mahogany Promenade",
      deliveryAddress: "ALCHE Campus",
      scheduledDate: "2026-09-02",
      scheduledTime: "3:00 pm",
      slotKey: "2026-09-02_15:00-16:00",
      assignedRider: "Thierry",
      status: "confirmed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Admin asks to text Customer C; LLM outputs the customer text directly back to admin without tool call
    const res = await enforceAdminActionInvariants({
      senderPhone: "+999000000008",
      isAdmin: true,
      incomingText: "Can you text Customer C that her driver Thierry is waiting outside at Mahogany gate?",
      assistantText: "Hello Customer C! 👋 Your driver Thierry is waiting outside at Mahogany gate. Please meet him when you are ready!",
      calledTools: new Set<string>(), // Simulated LLM hallucination: printed customer text in admin chat
      messageId: "test_gateway_msg_2",
    });

    assert.ok(res.actionsExecuted.some((a) => a.includes("admin_reply_to_customer:99900000064")));
    assert.match(res.text, /Verified message delivered to Customer C/i);

    const customerTranscript = await loadTranscript("99900000064");
    const lastMsg = customerTranscript.entries[customerTranscript.entries.length - 1];
    assert.ok(lastMsg);
    assert.match(lastMsg.text, /Thierry is waiting outside/i);
  });

  it("resolves customer from open escalations when admin replies 'Tell customer...'", async () => {
    const { recordPendingEscalation } = await import("../ops/store.ts");
    await recordPendingEscalation({
      customerPhone: "+99900000047",
      customerName: "Customer A",
      reason: "Needs custom price quote for Grand Baie trip",
    });

    const res = await enforceAdminActionInvariants({
      senderPhone: "+9990000000003",
      isAdmin: true,
      incomingText: "Tell customer that the trip to Grand Baie is Rs 100 round trip",
      assistantText: "I'll let them know right away.",
      calledTools: new Set<string>(),
      messageId: "test_gateway_msg_3",
    });

    assert.ok(res.actionsExecuted.some((a) => a.includes("admin_reply_to_customer:99900000047")));
    assert.match(res.text, /Verified message delivered to Customer A/i);

    const transcript = await loadTranscript("99900000047");
    const lastMsg = transcript.entries[transcript.entries.length - 1];
    assert.ok(lastMsg);
    assert.match(lastMsg.text, /Rs 100/i);
  });

  it("does NOT treat admin inquiry 'Tell me what time is Peace's booking?' as a customer relay", async () => {
    // Seed a customer whose name contains "me" (like James Sanga)
    await savePreBooking({
      id: "pb_gateway_test_james",
      customerPhone: "+99900000073",
      customerName: "James Sanga",
      serviceKind: "trip",
      pickupAddress: "ALCHE Campus",
      deliveryAddress: "Mahogany Promenade",
      scheduledDate: "2026-09-09",
      scheduledTime: "4:00 pm",
      slotKey: "2026-09-09_16:00-17:00",
      assignedRider: "Sherif",
      status: "confirmed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const res = await enforceAdminActionInvariants({
      senderPhone: "+999000000008",
      isAdmin: true,
      incomingText: "Tell me what time is Peace's booking?",
      assistantText: "Peace has a booking at 5:30 PM today.",
      calledTools: new Set<string>(),
      messageId: "test_gateway_msg_4",
    });

    // Must NOT execute any relay action to James Sanga or any customer
    assert.equal(res.actionsExecuted.length, 0);
    assert.equal(res.text, "Peace has a booking at 5:30 PM today.");

    // Verify James Sanga's transcript was never touched
    const jamesTranscript = await loadTranscript("99900000073");
    assert.equal(jamesTranscript.entries.length, 0);
  });
});


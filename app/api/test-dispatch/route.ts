import { NextResponse } from "next/server";
import { processIncomingUserMessage } from "@/lib/agent";
import { handleRiderReply, listAllPreBookings } from "@/lib/orders/pre-booking";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action") || "customer_request";
  const customerPhone = searchParams.get("phone") || "+99900000037";
  const text =
    searchParams.get("text") ||
    "Hi, I want to book a trip from ALCHE main gate to Mahogany Promenade tomorrow at 12:00 PM.";

  if (action === "rider_confirm") {
    const riderPhone = process.env.TEST_RIDER_PHONE || "+99900000027";
    const replyText = searchParams.get("reply") || "YES";
    const result = await handleRiderReply({
      senderPhone: riderPhone,
      text: replyText,
    });
    const bookings = await listAllPreBookings();
    return NextResponse.json({
      status: "rider_reply_processed",
      handled: result.handled,
      responseToRider: result.responseMessage,
      latestBooking: bookings[bookings.length - 1] || null,
    });
  }

  // Default: trigger customer booking message
  const cleanedDigits = customerPhone.replace(/\D/g, "");
  const testMsgId = `api_test_${Date.now()}`;
  await processIncomingUserMessage({
    messageId: testMsgId,
    sender: customerPhone,
    remoteJid: `${cleanedDigits}@s.whatsapp.net`,
    text,
    pushName: "Test Customer",
    raw: {
      key: {
        id: testMsgId,
        fromMe: false,
        remoteJid: `${cleanedDigits}@s.whatsapp.net`,
      },
      messageBody: text,
      pushName: "Test Customer",
    },
  });

  const bookings = await listAllPreBookings();
  const latestBooking = bookings[bookings.length - 1] || null;

  return NextResponse.json({
    status: "customer_message_processed",
    customerPhone,
    customerText: text,
    testRiderPhone: process.env.TEST_RIDER_PHONE || "+99900000027",
    latestBooking,
    instructions: [
      "1. Check your test rider phone (+99900000027) for the incoming WhatsApp prompt.",
      "2. Reply YES via WhatsApp (or visit /api/test-dispatch?action=rider_confirm) to confirm and create the Kilo delivery with tracking link!",
    ],
  });
}

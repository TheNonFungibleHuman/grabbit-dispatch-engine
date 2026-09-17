import { NextResponse } from "next/server";
import { processIncomingUserMessage } from "@/lib/agent";
import { isAdminAuthed } from "@/lib/admin/auth";
import { handleRiderReply, listAllPreBookings } from "@/lib/orders/pre-booking";

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!(await isAdminAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const getInput = (name: string): string | undefined => {
    const fromBody = body[name];
    if (typeof fromBody === "string" && fromBody.trim()) {
      return fromBody.trim();
    }
    const fromQuery = searchParams.get(name);
    return fromQuery?.trim() || undefined;
  };

  const action = getInput("action") || "customer_request";
  const customerPhone = getInput("phone") || "+99900000037";
  const text =
    getInput("text") ||
    "Hi, I want to book a trip from ALCHE main gate to Mahogany Promenade tomorrow at 12:00 PM.";

  if (action === "test_moses") {
    const { notifyRiderForBooking } = await import("@/lib/riders/notify-rider");
    const testResult = await notifyRiderForBooking({
      bookingId: `test_moses_${Date.now()}`,
      customerName: "Deen (Test)",
      customerPhone: "+9990000000003",
      serviceKind: "trip",
      pickupAddress: "ALCHE Campus main gate",
      dropoffAddress: "Mahogany Promenade",
      scheduledTime: "12:00 pm",
      assignedRider: "Moses",
      trackingUrl: "https://delivery.grabbit-express.com/track/DEL_2026_041/MOSES_TEST",
    });
    return NextResponse.json({
      status: "moses_dispatch_tested",
      googleChatWebhookConfigured: Boolean(process.env.GOOGLE_CHAT_WEBHOOK_URL),
      testResult,
      message: testResult.ok
        ? `Successfully sent Moses a WhatsApp notification (+999000000007) and mirrored it to Google Chat!`
        : `Notification failed: ${testResult.error || "Check WASENDER_API_KEY / GOOGLE_CHAT_WEBHOOK_URL"}`,
    });
  }

  if (action === "rider_confirm") {
    const riderPhone = process.env.TEST_RIDER_PHONE || "+99900000027";
    const replyText = getInput("reply") || "YES";
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
      "2. Reply YES via WhatsApp (or send POST /api/test-dispatch with {\"action\":\"rider_confirm\"}) to confirm and create the Kilo delivery with tracking link!",
    ],
  });
}

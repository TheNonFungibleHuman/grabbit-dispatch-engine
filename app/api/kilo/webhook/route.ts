import { after, NextResponse } from "next/server";
import {
  getDeliveryRecord,
  updateDeliveryRecordStatus,
} from "@/lib/orders/store";
import {
  extractKiloWebhook,
  getKiloWebhookSecret,
  isOtpIssuedEvent,
  resolveWebhookNotifyPhone,
  statusMessageForCustomer,
  toWhatsAppE164,
  verifyKiloSignature,
  type KiloWebhookPayload,
} from "@/lib/kilo";
import { sanitizeWhatsAppText } from "@/lib/agent/format";
import { sendCustomerText } from "@/lib/wasender/send-tracked";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "grabbit-whatsapp-agent",
    endpoint: "/api/kilo/webhook",
  });
}

/**
 * Kilo Business webhook receiver.
 * Configure: https://grabbit-whatsapp-agent.vercel.app/api/kilo/webhook
 *
 * Status + OTP WhatsApp sends run here independently of the admin AI kill switch.
 * When AI is off, inbound chat is quiet, but OTP (`delivery.otp_issued`) still goes out.
 */
export async function POST(request: Request) {
  let secret: string;
  try {
    secret = getKiloWebhookSecret();
  } catch {
    console.error("[kilo] KILO_WEBHOOK_SECRET is missing");
    return NextResponse.json(
      { error: "Webhook secret is not configured" },
      { status: 500 },
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get("kilo-signature");
  if (!verifyKiloSignature(secret, rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: KiloWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as KiloWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const eventHeader = request.headers.get("kilo-event") ?? "";
  const event =
    eventHeader ||
    payload.event ||
    payload.type ||
    "delivery.updated";

  after(async () => {
    try {
      const extracted = extractKiloWebhook(payload);
      if (!extracted.deliveryId) {
        console.warn("[kilo] webhook missing delivery id", { event });
        return;
      }

      if (isOtpIssuedEvent(event) && !extracted.otp?.code) {
        console.warn("[kilo] otp_issued without data.otp.code — not inventing", {
          deliveryId: extracted.deliveryId,
          event,
        });
        return;
      }

      const record =
        (await updateDeliveryRecordStatus(
          extracted.deliveryId,
          extracted.status ?? event,
        )) ?? (await getDeliveryRecord(extracted.deliveryId));

      const deliveryObject = payload.data?.object ?? payload.delivery;
      const notifyPhone = resolveWebhookNotifyPhone({
        otpReceiverPhone: extracted.otp?.receiverPhone,
        recordSenderPhone: record?.senderPhone,
        deliveryReceiverPhone: deliveryObject?.customer?.receiver_phone,
        deliverySenderPhone: deliveryObject?.customer?.sender_phone,
      });

      if (!notifyPhone) {
        console.warn("[kilo] no phone for webhook WhatsApp", {
          deliveryId: extracted.deliveryId,
          event,
          hasRecord: Boolean(record),
        });
        return;
      }

      const text = statusMessageForCustomer({
        event,
        status: extracted.status ?? record?.status,
        accessCode: extracted.accessCode ?? record?.accessCode,
        deliveryId: extracted.deliveryId,
        otpCode: extracted.otp?.code,
        customerMessageHint: extracted.customerMessageHint,
      });

      if (!text || !text.trim()) {
        console.info("[kilo] webhook event skipped (no customer message needed)", {
          deliveryId: extracted.deliveryId,
          event,
        });
        return;
      }

      await sendCustomerText({
        to: toWhatsAppE164(notifyPhone),
        text: sanitizeWhatsAppText(text),
        messageId: extracted.deliveryId,
      });
      console.info("[kilo] status WhatsApp sent", {
        deliveryId: extracted.deliveryId,
        event,
        otp: Boolean(extracted.otp?.code),
        to: notifyPhone,
      });
    } catch (error) {
      console.error("[kilo] failed to process webhook", { event, error });
    }
  });

  return NextResponse.json({ received: true });
}

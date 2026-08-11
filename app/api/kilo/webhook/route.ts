import { after, NextResponse } from "next/server";
import {
  getDeliveryRecord,
  updateDeliveryRecordStatus,
} from "@/lib/orders/store";
import {
  getKiloWebhookSecret,
  statusMessageForCustomer,
  verifyKiloSignature,
  type KiloWebhookPayload,
} from "@/lib/kilo";
import { sanitizeWhatsAppText } from "@/lib/agent/format";
import { sendCustomerText } from "@/lib/wasender/send-tracked";

export const runtime = "nodejs";

function extractDelivery(payload: KiloWebhookPayload): {
  id?: string;
  status?: string;
  accessCode?: string;
} {
  const delivery =
    payload.data?.object ??
    payload.delivery ??
    (payload.data &&
    typeof payload.data === "object" &&
    "delivery" in payload.data
      ? (payload.data as { delivery?: { id?: string; status?: string; access_code?: string | null } })
          .delivery
      : undefined);

  if (!delivery) {
    return {};
  }

  return {
    id: typeof delivery.id === "string" ? delivery.id : undefined,
    status: typeof delivery.status === "string" ? delivery.status : undefined,
    accessCode:
      typeof delivery.access_code === "string"
        ? delivery.access_code
        : undefined,
  };
}

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
      const delivery = extractDelivery(payload);
      if (!delivery.id) {
        console.warn("[kilo] webhook missing delivery id", { event });
        return;
      }

      const record =
        (await updateDeliveryRecordStatus(
          delivery.id,
          delivery.status ?? event,
        )) ?? (await getDeliveryRecord(delivery.id));

      if (!record?.senderPhone) {
        console.warn("[kilo] no local delivery record for webhook", {
          deliveryId: delivery.id,
          event,
        });
        return;
      }

      const text = statusMessageForCustomer({
        event,
        status: delivery.status ?? record.status,
        accessCode: delivery.accessCode ?? record.accessCode,
        deliveryId: delivery.id,
      });

      const to = record.senderPhone.startsWith("+")
        ? record.senderPhone
        : `+${record.senderPhone.replace(/\D/g, "")}`;

      await sendCustomerText({
        to,
        text: sanitizeWhatsAppText(text),
        messageId: delivery.id,
      });
      console.info("[kilo] status WhatsApp sent", {
        deliveryId: delivery.id,
        event,
        to: record.senderPhone,
      });
    } catch (error) {
      console.error("[kilo] failed to process webhook", { event, error });
    }
  });

  return NextResponse.json({ received: true });
}

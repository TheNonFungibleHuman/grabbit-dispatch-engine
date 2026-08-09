import { after, NextResponse } from "next/server";
import {
  handleWasenderEvent,
  parseWasenderWebhookPayload,
} from "@/lib/wasender/handlers";
import {
  getWasenderWebhookSecret,
  verifyWasenderSignature,
} from "@/lib/wasender/verify";

export const runtime = "nodejs";

/**
 * Health check so you can confirm the public URL is reachable before
 * saving the session in the Wasender dashboard.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "grabbit-whatsapp-agent",
    endpoint: "/webhook",
  });
}

/**
 * WasenderAPI webhook receiver.
 * Configure: https://grabbit-whatsapp-agent.vercel.app/webhook
 * Subscribe at least to: messages.received
 */
export async function POST(request: Request) {
  let secret: string;
  try {
    secret = getWasenderWebhookSecret();
  } catch {
    console.error("[wasender] WASENDER_WEBHOOK_SECRET is missing");
    return NextResponse.json(
      { error: "Webhook secret is not configured" },
      { status: 500 },
    );
  }

  const signature = request.headers.get("x-webhook-signature");
  if (!verifyWasenderSignature(signature, secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let payload;
  try {
    payload = parseWasenderWebhookPayload(body);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid webhook payload";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Ack Wasender immediately; Gemini + outbound send continue in the background.
  after(async () => {
    try {
      await handleWasenderEvent(payload);
    } catch (error) {
      console.error("[wasender] failed to process webhook event", {
        event: payload.event,
        error,
      });
    }
  });

  return NextResponse.json({ received: true });
}

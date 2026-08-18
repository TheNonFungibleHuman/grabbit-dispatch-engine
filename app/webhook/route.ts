import { after, NextResponse } from "next/server";
import {
  handleWasenderEvent,
  parseWasenderWebhookPayload,
} from "@/lib/wasender/handlers";
import {
  getWasenderWebhookSecret,
  verifyWasenderSignature,
} from "@/lib/wasender/verify";
import { formatError, logError, logInfo, logWarn } from "@/lib/log";

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
  const startedAt = Date.now();
  let secret: string;
  try {
    secret = getWasenderWebhookSecret();
  } catch {
    logError("webhook", "WASENDER_WEBHOOK_SECRET is missing");
    return NextResponse.json(
      { error: "Webhook secret is not configured" },
      { status: 500 },
    );
  }

  const signature = request.headers.get("x-webhook-signature");
  if (!verifyWasenderSignature(signature, secret)) {
    logWarn("webhook", "invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logWarn("webhook", "invalid JSON body");
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let payload;
  try {
    payload = parseWasenderWebhookPayload(body);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid webhook payload";
    logWarn("webhook", "payload parse failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const eventPreview =
    payload.event === "messages.received" ||
    payload.event === "messages-personal.received"
      ? {
          event: payload.event,
          messageId: (payload as { data?: { messages?: { key?: { id?: string } } } })
            .data?.messages?.key?.id,
          textPreview: (
            payload as { data?: { messages?: { messageBody?: string } } }
          ).data?.messages?.messageBody?.slice(0, 120),
        }
      : { event: payload.event };

  if (payload.event === "messages-personal.received") {
    logInfo("webhook", "ignored duplicate personal event (using messages.received only)", {
      event: payload.event,
    });
    return NextResponse.json({ received: true, ignored: true });
  }

  logInfo("webhook", "accepted", {
    ...eventPreview,
    ackMs: Date.now() - startedAt,
  });

  // Ack Wasender immediately; Gemini/DeepSeek + outbound send continue in the background.
  after(async () => {
    const bgStartedAt = Date.now();
    try {
      await handleWasenderEvent(payload);
      logInfo("webhook", "background processing done", {
        event: payload.event,
        ms: Date.now() - bgStartedAt,
      });
    } catch (error) {
      logError("webhook", "failed to process webhook event", error);
      console.error("[webhook] background failure detail", {
        event: payload.event,
        ...formatError(error),
      });
    }
  });

  return NextResponse.json({ received: true });
}

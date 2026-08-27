import { processIncomingUserMessage } from "../agent";
import { isAgentEnabled } from "../admin/agent-switch";
import { formatError, logError, logInfo, logWarn } from "../log";
import { recordOpsEvent } from "../ops/store";
import { appendTranscriptEntry } from "../agent/transcript";
import { sanitizeWhatsAppText } from "../agent/format";
import { sendCustomerText } from "./send-tracked";
import {
  claimInboundMessageId,
  completeInboundMessageId,
} from "./message-id-store.ts";
import { getSenderPhone } from "./parse";
import type {
  IncomingUserMessage,
  MessagesReceivedEvent,
  WasenderIncomingMessage,
  WasenderWebhookEvent,
} from "./types";

export { getSenderPhone, parseWasenderWebhookPayload } from "./parse";
export type { IncomingUserMessage } from "./types";

export async function handleWasenderEvent(
  payload: WasenderWebhookEvent,
): Promise<void> {
  logInfo("wasender", "event", { event: payload.event });

  switch (payload.event) {
    case "messages.received":
      await handleIncomingMessage(payload as MessagesReceivedEvent);
      break;
    case "session.status":
      logInfo("wasender", "session.status", payload.data);
      break;
    default:
      logInfo("wasender", `ignored event: ${payload.event}`);
  }
}

function extractMessageBody(message: WasenderIncomingMessage): string {
  if (message.messageBody && message.messageBody.trim()) {
    return message.messageBody.trim();
  }
  const msg = message.message as Record<string, unknown> | undefined;
  if (!msg) return "";

  const readText = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;

  const node = (key: string): Record<string, unknown> | undefined =>
    msg[key] as Record<string, unknown> | undefined;

  const docNode = node("documentMessage") || (node("documentWithCaptionMessage")?.message as Record<string, unknown> | undefined)?.documentMessage as Record<string, unknown> | undefined;

  return (
    readText(msg.conversation) ??
    readText(node("extendedTextMessage")?.text) ??
    readText(node("buttonsResponseMessage")?.selectedDisplayText) ??
    readText(node("buttonsResponseMessage")?.selectedButtonId) ??
    readText(node("templateButtonReplyMessage")?.selectedDisplayText) ??
    readText(node("listResponseMessage")?.title) ??
    readText((node("listResponseMessage")?.singleSelectReply as Record<string, unknown> | undefined)?.selectedRowId) ??
    readText(node("imageMessage")?.caption) ??
    readText(docNode?.caption) ??
    (docNode?.fileName ? `[Document: ${String(docNode.fileName)}]` : undefined) ??
    ""
  );
}

async function handleIncomingMessage(
  payload: MessagesReceivedEvent,
): Promise<void> {
  const message = payload.data?.messages;
  if (!message?.key?.id) {
    logWarn("wasender", "messages.received without message key or id");
    return;
  }

  // Deduplicate incoming messages across webhook events with a durable
  // claim so a crash mid-processing can never silently swallow a retry.
  const claim = await claimInboundMessageId(message.key.id);
  if (claim !== "new") {
    logInfo(
      "wasender",
      claim === "in_flight"
        ? "message is already being processed elsewhere; ignoring concurrent event"
        : "ignored duplicate incoming message event",
      { messageId: message.key.id, claim },
    );
    return;
  }

  try {
    await processClaimedIncomingMessage(message);
  } finally {
    await completeInboundMessageId(message.key.id);
  }
}

async function processClaimedIncomingMessage(
  message: WasenderIncomingMessage,
): Promise<void> {
  // Capture manual human messages sent from phone / WhatsApp Web
  if (message.key.fromMe) {
    const { isOutboundAiMessage } = await import("./send-tracked.ts");
    if (await isOutboundAiMessage(message.key.id)) {
      logInfo("wasender", "ignored automated agent fromMe echo", {
        messageId: message.key.id,
      });
      return;
    }

    const targetPhone = getSenderPhone(message);
    const text = extractMessageBody(message);

    if (text && targetPhone) {
      logInfo("wasender", "captured manual human takeover message from phone", {
        targetPhone,
        messageId: message.key.id,
        textPreview: text.slice(0, 120),
      });

      await appendTranscriptEntry(targetPhone, {
        role: "agent",
        text,
        at: new Date().toISOString(),
        messageId: message.key.id,
      });

      await recordOpsEvent({
        phone: targetPhone,
        type: "outbound_sent",
        messageId: message.key.id,
        preview: `[Human]: ${text}`,
      });
    }
    return;
  }

  const sender = getSenderPhone(message);
  const text = extractMessageBody(message);

  logInfo("wasender", "message received", {
    messageId: message.key.id,
    from: sender,
    remoteJid: message.key.remoteJid,
    pushName: message.pushName,
    textPreview: text.slice(0, 120),
    textLength: text.length,
    hasMedia: Boolean(
      message.message &&
        Object.keys(message.message).some((key) =>
          key.toLowerCase().includes("message"),
        ) &&
        !("conversation" in (message.message ?? {})),
    ),
  });

  await onUserMessage({
    messageId: message.key.id,
    sender,
    remoteJid: message.key.remoteJid,
    text,
    pushName: message.pushName,
    raw: message,
  });
}

async function onUserMessage(message: IncomingUserMessage): Promise<void> {
  const startedAt = Date.now();
  const { recordMetric } = await import("../metrics/recorder.ts");
  void recordMetric("inbound");
  await recordOpsEvent({
    phone: message.sender,
    type: "inbound_received",
    messageId: message.messageId,
    preview: message.text,
  });

  // 0. Compliance opt-out / re-subscribe handling — always wins, even mid-flow
  try {
    const { matchesOptOut, matchesResubscribe, suppressCustomerPhone, unsuppressCustomerPhone } =
      await import("../compliance/opt-out.ts");
    if (matchesOptOut(message.text)) {
      await suppressCustomerPhone(message.sender);
      const confirmation = sanitizeWhatsAppText(
        "You have been unsubscribed and will not receive any promotional messages from Grabbit Express. Bookings still work as usual — just message us anytime. (Reply START to re-subscribe.)",
      );
      await sendCustomerText({ to: message.sender, text: confirmation });
      await appendTranscriptEntry(message.sender, {
        role: "note",
        text: "[customer opted out of broadcasts]",
      });
      logInfo("wasender", "processed customer opt-out", { sender: message.sender });
      return;
    }
    if (matchesResubscribe(message.text)) {
      const changed = await unsuppressCustomerPhone(message.sender);
      if (changed) {
        const confirmation = sanitizeWhatsAppText(
          "Welcome back! You are re-subscribed to Grabbit Express updates.",
        );
        await sendCustomerText({ to: message.sender, text: confirmation });
      }
      logInfo("wasender", "processed customer resubscribe request", {
        sender: message.sender,
        changed,
      });
    }
  } catch (optErr) {
    logWarn("wasender", "opt-out check failed", formatError(optErr));
  }

  // 1. Check if incoming message is a 1-word command from a Fleet Rider (0 LLM tokens)
  try {
    const { isAuthorizedRiderOrAdmin } = await import("../riders/config.ts");
    const auth = isAuthorizedRiderOrAdmin(message.sender);
    if (auth.rider) {
      const { handleRiderCommand } = await import("../riders/commands.ts");
      const cmdResult = await handleRiderCommand({
        senderPhone: message.sender,
        messageText: message.text,
        rider: auth.rider,
      });

      if (cmdResult.handled && cmdResult.replyText) {
        await sendCustomerText({
          to: message.sender,
          text: cmdResult.replyText,
        });
        await appendTranscriptEntry(message.sender, {
          role: "customer",
          text: message.text,
          messageId: message.messageId,
        });
        await appendTranscriptEntry(message.sender, {
          role: "agent",
          text: cmdResult.replyText,
          messageId: message.messageId,
        });
        logInfo("wasender", "handled rider command with zero LLM tokens", {
          rider: auth.rider.name,
          action: cmdResult.action,
        });
        return;
      }

      const { shouldInterceptRiderDecision, handleRiderReply, riderHasActiveBooking } =
        await import("../orders/pre-booking.ts");
      if (
        shouldInterceptRiderDecision({
          text: message.text,
          hasActiveBooking: await riderHasActiveBooking(auth.rider.name),
        })
      ) {
          const replyResult = await handleRiderReply({
            senderPhone: message.sender,
            text: message.text,
          });

          if (replyResult.handled && replyResult.responseMessage) {
            await sendCustomerText({
              to: message.sender,
              text: replyResult.responseMessage,
            });
            await appendTranscriptEntry(message.sender, {
              role: "customer",
              text: message.text,
              messageId: message.messageId,
            });
            await appendTranscriptEntry(message.sender, {
              role: "agent",
              text: replyResult.responseMessage,
              messageId: message.messageId,
            });
            logInfo("wasender", "handled rider booking decision with zero LLM tokens", {
              rider: auth.rider.name,
            });
            return;
          }
        }
    }
  } catch (cmdErr) {
    logWarn("wasender", "rider command check failed", formatError(cmdErr));
  }

  const agentOn = await isAgentEnabled();
  if (!agentOn) {
    await appendTranscriptEntry(message.sender, {
      role: "customer",
      text: message.text || "(media/empty)",
      messageId: message.messageId,
      whileAgentDisabled: true,
    });
    logWarn("wasender", "agent disabled; skipping AI reply (human takeover)", {
      messageId: message.messageId,
      sender: message.sender,
    });
    return;
  }

  try {
    await processIncomingUserMessage(message);
    logInfo("wasender", "message processed", {
      messageId: message.messageId,
      sender: message.sender,
      ms: Date.now() - startedAt,
    });
  } catch (error) {
    logError("wasender", "failed to process inbound message", error);
    console.error("[wasender] process failure detail", {
      sender: message.sender,
      messageId: message.messageId,
      textPreview: message.text.slice(0, 160),
      ...formatError(error),
    });

    await recordOpsEvent({
      phone: message.sender,
      type: "agent_failed",
      messageId: message.messageId,
      preview: message.text,
      error: error instanceof Error ? error.message : String(error),
    });

    try {
      const to = message.sender.startsWith("+")
        ? message.sender
        : `+${message.sender.replace(/\D/g, "")}`;
      const text = sanitizeWhatsAppText(
        "Sorry, I’m having a quick technical hiccup. Please resend your message in a moment and we’ll take care of you.",
      );
      await sendCustomerText({
        to,
        text,
        messageId: message.messageId,
      });
      await appendTranscriptEntry(message.sender, {
        role: "agent",
        text,
        messageId: message.messageId,
      });
      logWarn("wasender", "sent technical hiccup fallback", {
        messageId: message.messageId,
        to,
      });
    } catch (sendError) {
      logError("wasender", "failed to send fallback error reply", sendError);
    }
  }
}

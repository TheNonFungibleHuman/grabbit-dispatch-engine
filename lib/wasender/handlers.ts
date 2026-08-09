import { processIncomingUserMessage } from "../agent";
import { formatError, logError, logInfo, logWarn } from "../log";
import { sendTextMessage } from "./client";
import { getSenderPhone } from "./parse";
import type {
  IncomingUserMessage,
  MessagesReceivedEvent,
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
    case "messages-personal.received":
      await handleIncomingMessage(payload as MessagesReceivedEvent);
      break;
    case "session.status":
      logInfo("wasender", "session.status", payload.data);
      break;
    default:
      logInfo("wasender", `ignored event: ${payload.event}`);
  }
}

async function handleIncomingMessage(
  payload: MessagesReceivedEvent,
): Promise<void> {
  const message = payload.data?.messages;
  if (!message?.key) {
    logWarn("wasender", "messages.received without message data");
    return;
  }

  // Ignore echoes of our own outbound messages.
  if (message.key.fromMe) {
    logInfo("wasender", "ignored fromMe echo", {
      messageId: message.key.id,
    });
    return;
  }

  const sender = getSenderPhone(message);
  const text = message.messageBody?.trim() ?? "";

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

    try {
      const to = message.sender.startsWith("+")
        ? message.sender
        : `+${message.sender.replace(/\D/g, "")}`;
      await sendTextMessage({
        to,
        text: "Sorry, I’m having a quick technical hiccup. Please resend your message in a moment and we’ll take care of you 💚",
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

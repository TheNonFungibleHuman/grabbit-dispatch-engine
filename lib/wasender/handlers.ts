import { processIncomingUserMessage } from "../agent";
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
  switch (payload.event) {
    case "messages.received":
    case "messages-personal.received":
      await handleIncomingMessage(payload as MessagesReceivedEvent);
      break;
    case "session.status":
      console.info("[wasender] session.status", payload.data);
      break;
    default:
      console.info(`[wasender] ignored event: ${payload.event}`);
  }
}

async function handleIncomingMessage(
  payload: MessagesReceivedEvent,
): Promise<void> {
  const message = payload.data?.messages;
  if (!message?.key) {
    console.warn("[wasender] messages.received without message data");
    return;
  }

  // Ignore echoes of our own outbound messages.
  if (message.key.fromMe) {
    return;
  }

  const sender = getSenderPhone(message);
  const text = message.messageBody?.trim() ?? "";

  console.info("[wasender] message received", {
    messageId: message.key.id,
    from: sender,
    remoteJid: message.key.remoteJid,
    textPreview: text.slice(0, 120),
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
    raw: message,
  });
}

async function onUserMessage(message: IncomingUserMessage): Promise<void> {
  try {
    await processIncomingUserMessage(message);
  } catch (error) {
    console.error("[agent] failed to process inbound message", {
      sender: message.sender,
      messageId: message.messageId,
      error,
    });

    try {
      const to = message.sender.startsWith("+")
        ? message.sender
        : `+${message.sender.replace(/\D/g, "")}`;
      await sendTextMessage({
        to,
        text: "Sorry — I’m having a quick technical hiccup. Please resend your message in a moment and we’ll take care of you 💚",
      });
    } catch (sendError) {
      console.error("[agent] failed to send fallback error reply", sendError);
    }
  }
}

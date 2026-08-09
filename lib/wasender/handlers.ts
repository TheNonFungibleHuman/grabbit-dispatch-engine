import type {
  MessagesReceivedEvent,
  WasenderIncomingMessage,
  WasenderWebhookEvent,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWasenderWebhookPayload(
  body: unknown,
): WasenderWebhookEvent {
  if (!isRecord(body)) {
    throw new Error("Webhook body must be a JSON object");
  }

  const event = body.event;
  if (typeof event !== "string" || event.length === 0) {
    throw new Error("Webhook payload is missing a valid event name");
  }

  return body as unknown as WasenderWebhookEvent;
}

export function getSenderPhone(message: WasenderIncomingMessage): string {
  const key = message.key;
  return (
    key.cleanedParticipantPn ??
    key.cleanedSenderPn ??
    key.senderPn?.replace(/@s\.whatsapp\.net$/, "") ??
    key.remoteJid.replace(/@.*$/, "")
  );
}

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

  // Agent reply logic will plug in here (LLM + wasender send API).
  await onUserMessage({
    messageId: message.key.id,
    sender,
    remoteJid: message.key.remoteJid,
    text,
    raw: message,
  });
}

export interface IncomingUserMessage {
  messageId: string;
  sender: string;
  remoteJid: string;
  text: string;
  raw: WasenderIncomingMessage;
}

/**
 * Central place for agent/business logic after a verified inbound message.
 * Keep this fast — Wasender expects a 200 within 60s.
 */
async function onUserMessage(message: IncomingUserMessage): Promise<void> {
  if (!message.text) {
    return;
  }

  // Placeholder: acknowledge inbound text while the agent is being built.
  console.info(
    `[wasender] ready to process agent reply for ${message.sender}: "${message.text}"`,
  );
}

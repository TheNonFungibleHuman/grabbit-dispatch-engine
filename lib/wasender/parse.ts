import type {
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

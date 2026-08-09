/**
 * WasenderAPI webhook payload types.
 * @see https://wasenderapi.com/api-docs/webhooks/webhook-setup
 * @see https://api.wasenderapi.com/api-docs/webhooks/webhook-message-received
 */

export type WasenderWebhookEventName =
  | "messages.received"
  | "messages-group.received"
  | "messages-newsletter.received"
  | "messages-personal.received"
  | "messages.upsert"
  | "messages.update"
  | "messages.delete"
  | "message.sent"
  | "message-receipt.update"
  | "messages.reaction"
  | "session.status"
  | "qrcode.updated"
  | "passkey.updated"
  | "call"
  | "chats.upsert"
  | "chats.update"
  | "chats.delete"
  | "groups.upsert"
  | "groups.update"
  | "group-participants.update"
  | "contacts.upsert"
  | "contacts.update"
  | "poll.results"
  | (string & {});

export interface WasenderMessageKey {
  id: string;
  fromMe: boolean;
  remoteJid: string;
  addressingMode?: string;
  senderPn?: string;
  cleanedSenderPn?: string;
  senderLid?: string;
  participant?: string;
  cleanedParticipantPn?: string;
}

export interface WasenderIncomingMessage {
  key: WasenderMessageKey;
  /** Unified text body (conversation, caption, or reply text). */
  messageBody?: string;
  messageTimestamp?: number;
  pushName?: string;
  message?: Record<string, unknown>;
}

export interface WasenderMessagesReceivedData {
  messages: WasenderIncomingMessage;
}

export interface WasenderSessionStatusData {
  status?: string;
  sessionId?: string | number;
  [key: string]: unknown;
}

export interface WasenderWebhookEvent<TData = unknown> {
  event: WasenderWebhookEventName;
  timestamp: number;
  sessionId?: string | number;
  data: TData;
}

export type MessagesReceivedEvent =
  WasenderWebhookEvent<WasenderMessagesReceivedData>;

export interface IncomingUserMessage {
  messageId: string;
  sender: string;
  remoteJid: string;
  text: string;
  raw: WasenderIncomingMessage;
}

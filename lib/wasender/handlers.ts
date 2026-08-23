import { processIncomingUserMessage } from "../agent";
import { isAgentEnabled } from "../admin/agent-switch";
import { formatError, logError, logInfo, logWarn } from "../log";
import { recordOpsEvent } from "../ops/store";
import { appendTranscriptEntry } from "../agent/transcript";
import { sanitizeWhatsAppText } from "../agent/format";
import { sendCustomerText } from "./send-tracked";
import { getSenderPhone } from "./parse";
import type {
  IncomingUserMessage,
  MessagesReceivedEvent,
  WasenderIncomingMessage,
  WasenderWebhookEvent,
} from "./types";

export { getSenderPhone, parseWasenderWebhookPayload } from "./parse";
export type { IncomingUserMessage } from "./types";

const PROCESSED_MESSAGE_IDS = new Set<string>();

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
  const msg = message.message as Record<string, any> | undefined;
  if (!msg) return "";

  if (typeof msg.conversation === "string") return msg.conversation.trim();
  if (typeof msg.extendedTextMessage?.text === "string") return msg.extendedTextMessage.text.trim();
  if (typeof msg.buttonsResponseMessage?.selectedDisplayText === "string") return msg.buttonsResponseMessage.selectedDisplayText.trim();
  if (typeof msg.buttonsResponseMessage?.selectedButtonId === "string") return msg.buttonsResponseMessage.selectedButtonId.trim();
  if (typeof msg.templateButtonReplyMessage?.selectedDisplayText === "string") return msg.templateButtonReplyMessage.selectedDisplayText.trim();
  if (typeof msg.listResponseMessage?.title === "string") return msg.listResponseMessage.title.trim();
  if (typeof msg.listResponseMessage?.singleSelectReply?.selectedRowId === "string") return msg.listResponseMessage.singleSelectReply.selectedRowId.trim();
  if (typeof msg.imageMessage?.caption === "string") return msg.imageMessage.caption.trim();

  return "";
}

async function handleIncomingMessage(
  payload: MessagesReceivedEvent,
): Promise<void> {
  const message = payload.data?.messages;
  if (!message?.key?.id) {
    logWarn("wasender", "messages.received without message key or id");
    return;
  }

  // Deduplicate incoming messages across webhook events
  if (PROCESSED_MESSAGE_IDS.has(message.key.id)) {
    logInfo("wasender", "ignored duplicate incoming message event", {
      messageId: message.key.id,
    });
    return;
  }
  PROCESSED_MESSAGE_IDS.add(message.key.id);
  if (PROCESSED_MESSAGE_IDS.size > 2000) {
    const oldest = PROCESSED_MESSAGE_IDS.values().next().value;
    if (oldest) PROCESSED_MESSAGE_IDS.delete(oldest);
  }

  // Ignore echoes of our own outbound messages.
  if (message.key.fromMe) {
    logInfo("wasender", "ignored fromMe echo", {
      messageId: message.key.id,
    });
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

  queueDebouncedUserMessage({
    messageId: message.key.id,
    sender,
    remoteJid: message.key.remoteJid,
    text,
    pushName: message.pushName,
    raw: message,
  });
}

interface PendingUserBatch {
  timer: NodeJS.Timeout;
  firstReceivedAt: number;
  messages: IncomingUserMessage[];
}

const PENDING_BATCHES = new Map<string, PendingUserBatch>();
const DEBOUNCE_WAIT_MS = 1500;
const MAX_BATCH_WAIT_MS = 4000;

function queueDebouncedUserMessage(msg: IncomingUserMessage): void {
  const existing = PENDING_BATCHES.get(msg.sender);
  if (existing) {
    existing.messages.push(msg);
    const age = Date.now() - existing.firstReceivedAt;
    clearTimeout(existing.timer);

    if (age >= MAX_BATCH_WAIT_MS) {
      PENDING_BATCHES.delete(msg.sender);
      flushBatch(msg.sender, existing.messages);
    } else {
      existing.timer = setTimeout(() => {
        PENDING_BATCHES.delete(msg.sender);
        flushBatch(msg.sender, existing.messages);
      }, DEBOUNCE_WAIT_MS);
    }
  } else {
    const messages = [msg];
    const timer = setTimeout(() => {
      PENDING_BATCHES.delete(msg.sender);
      flushBatch(msg.sender, messages);
    }, DEBOUNCE_WAIT_MS);

    PENDING_BATCHES.set(msg.sender, {
      timer,
      firstReceivedAt: Date.now(),
      messages,
    });
  }
}

async function flushBatch(sender: string, messages: IncomingUserMessage[]): Promise<void> {
  if (messages.length === 0) return;
  if (messages.length === 1) {
    await onUserMessage(messages[0]);
    return;
  }

  const latest = messages[messages.length - 1];
  const combinedText = messages
    .map((m) => m.text.trim())
    .filter(Boolean)
    .join("\n");

  logInfo("wasender", "flushed debounced batch", {
    sender,
    count: messages.length,
    combinedPreview: combinedText.slice(0, 120),
  });

  await onUserMessage({
    messageId: latest.messageId,
    sender,
    remoteJid: latest.remoteJid,
    text: combinedText,
    pushName: latest.pushName,
    raw: latest.raw,
  });
}

async function onUserMessage(message: IncomingUserMessage): Promise<void> {
  const startedAt = Date.now();
  await recordOpsEvent({
    phone: message.sender,
    type: "inbound_received",
    messageId: message.messageId,
    preview: message.text,
  });

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

import { generateAgentReply } from "./deepseek.ts";
import { isShortAcknowledgement, sanitizeWhatsAppText } from "./format.ts";
import { formatError, logError, logInfo, logWarn } from "../log.ts";
import { persistIncomingPackageImage } from "../media/wasender.ts";
import { addPackageImageToDraft } from "../orders/store.ts";
import { sendCustomerText } from "../wasender/send-tracked.ts";
import type { IncomingUserMessage } from "../wasender/types.ts";
import {
  appendTranscriptEntry,
  isInQuietWindow,
  loadTranscript,
  recentDisabledCustomerMessages,
} from "./transcript.ts";

function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (!digits) {
    throw new Error("Cannot send reply: sender phone is missing");
  }
  return phone.trim().startsWith("+") ? `+${digits}` : `+${digits}`;
}

function hasImageMessage(message: IncomingUserMessage): boolean {
  return Boolean(
    message.raw?.message &&
      typeof message.raw.message === "object" &&
      "imageMessage" in message.raw.message,
  );
}

async function sendAndRecord(args: {
  to: string;
  sender: string;
  text: string;
  messageId: string;
}): Promise<void> {
  const text = sanitizeWhatsAppText(args.text);
  await sendCustomerText({
    to: args.to,
    text,
    messageId: args.messageId,
  });
  await appendTranscriptEntry(args.sender, {
    role: "agent",
    text,
    messageId: args.messageId,
  });
}

/**
 * Run the Grabbit Gemini agent and reply on WhatsApp.
 */
export async function processIncomingUserMessage(
  message: IncomingUserMessage,
): Promise<void> {
  const to = toE164(message.sender);
  logInfo("agent", "process start", {
    messageId: message.messageId,
    sender: message.sender,
    to,
    hasText: Boolean(message.text),
    hasImage: hasImageMessage(message),
  });

  await appendTranscriptEntry(message.sender, {
    role: "customer",
    text: message.text || (hasImageMessage(message) ? "(image)" : ""),
    messageId: message.messageId,
  });

  if (hasImageMessage(message) && message.raw?.message) {
    try {
      const imageUrl = await persistIncomingPackageImage({
        senderPhone: message.sender,
        messageId: message.messageId,
        message: message.raw.message,
      });

      if (imageUrl) {
        const draft = await addPackageImageToDraft(message.sender, imageUrl);
        const caption = message.text?.trim();

        if (caption) {
          const reply = await generateAgentReply({
            sender: message.sender,
            text: caption,
            messageId: message.messageId,
            pushName: message.pushName,
          });
          await sendAndRecord({
            to,
            sender: message.sender,
            text: reply.text,
            messageId: message.messageId,
          });
        } else {
          const name = message.pushName?.trim();
          await sendAndRecord({
            to,
            sender: message.sender,
            text: name
              ? `Got it ${name}. Photo saved (${draft.packageImages.length}/6). Send another if needed, or tell me pickup and drop-off.`
              : `Got your photo (${draft.packageImages.length}/6). Send another if needed, or tell me the pickup and drop-off details.`,
            messageId: message.messageId,
          });
        }

        logInfo("agent", "stored package image", {
          to: message.sender,
          messageId: message.messageId,
          count: draft.packageImages.length,
        });
        return;
      }

      logWarn("agent", "image message had no resolvable url", {
        messageId: message.messageId,
      });
    } catch (error) {
      logError("agent", "failed to persist package image", error);
      console.error("[agent] image persist detail", {
        messageId: message.messageId,
        ...formatError(error),
      });
      await sendAndRecord({
        to,
        sender: message.sender,
        text: "I couldn’t save that photo. Please send it again as an image.",
        messageId: message.messageId,
      });
      return;
    }
  }

  if (!message.text) {
    await sendAndRecord({
      to,
      sender: message.sender,
      text: "Happy to help. Tell me what you need delivered, or send a package photo to start.",
      messageId: message.messageId,
    });
    return;
  }

  // After an order is handled, or right after AI was paused with human coverage,
  // short acks should not restart the whole intake persona.
  if (isShortAcknowledgement(message.text)) {
    try {
      const transcript = await loadTranscript(message.sender);
      const hadPauseGap = recentDisabledCustomerMessages(transcript).length > 0;
      if (isInQuietWindow(transcript) || hadPauseGap) {
        await sendAndRecord({
          to,
          sender: message.sender,
          text: "Anytime. Ping us when you need the next delivery.",
          messageId: message.messageId,
        });
        logInfo("agent", "brief ack reply (quiet/pause gap)", {
          messageId: message.messageId,
          quiet: isInQuietWindow(transcript),
          hadPauseGap,
        });
        return;
      }
    } catch (error) {
      logWarn("agent", "short-ack path failed; continuing normal reply", formatError(error));
    }
  }

  const reply = await generateAgentReply({
    sender: message.sender,
    text: message.text,
    messageId: message.messageId,
    pushName: message.pushName,
  });

  await sendAndRecord({
    to,
    sender: message.sender,
    text: reply.text,
    messageId: message.messageId,
  });

  logInfo("agent", "replied", {
    to: message.sender,
    messageId: message.messageId,
    model: reply.model,
    interactionId: reply.interactionId,
    usedHistory: Boolean(reply.previousInteractionId),
    replyPreview: reply.text.slice(0, 120),
  });
}

export { generateAgentReply } from "./deepseek.ts";
export { sanitizeWhatsAppText } from "./format.ts";
export { buildGrabbitSystemInstruction } from "./prompt.ts";

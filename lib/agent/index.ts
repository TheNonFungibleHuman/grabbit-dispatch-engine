import { generateAgentReply } from "./deepseek.ts";
import { isBareGreeting, isShortAcknowledgement, sanitizeWhatsAppText } from "./format.ts";
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

function hasDocumentMessage(message: IncomingUserMessage): boolean {
  return Boolean(
    message.raw?.message &&
      typeof message.raw.message === "object" &&
      ("documentMessage" in message.raw.message ||
        "documentWithCaptionMessage" in message.raw.message),
  );
}

const recentSentReplies = new Map<string, { text: string; at: number }>();
const recentInboundTurns = new Map<string, { text: string; at: number }>();
const SENT_REPLY_DEDUP_WINDOW_MS = 5000;

async function sendAndRecord(args: {
  to: string;
  sender: string;
  text: string;
  messageId: string;
}): Promise<void> {
  const text = sanitizeWhatsAppText(args.text);
  const now = Date.now();
  const last = recentSentReplies.get(args.to);
  if (last && now - last.at < SENT_REPLY_DEDUP_WINDOW_MS && last.text === text) {
    logWarn("agent", "suppressing exact duplicate outbound reply within cooldown", {
      to: args.to,
      messageId: args.messageId,
      preview: text.slice(0, 80),
    });
    return;
  }
  recentSentReplies.set(args.to, { text, at: now });

  if (recentSentReplies.size > 200) {
    for (const [k, v] of recentSentReplies.entries()) {
      if (now - v.at > 60_000) recentSentReplies.delete(k);
    }
  }

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
 * Run the Grabbit dispatch agent and reply on WhatsApp.
 */
export async function processIncomingUserMessage(
  message: IncomingUserMessage,
): Promise<void> {
  const to = toE164(message.sender);
  const now = Date.now();
  const lastInbound = recentInboundTurns.get(message.sender);

  // Suppress rapid duplicate webhook triggers (e.g. duplicate webhook deliveries for emojis/acks within 5s)
  if (
    lastInbound &&
    now - lastInbound.at < 5000 &&
    (lastInbound.text === message.text || (message.text && isShortAcknowledgement(message.text)))
  ) {
    logWarn("agent", "suppressing rapid duplicate inbound acknowledgment turn", {
      sender: message.sender,
      messageId: message.messageId,
      text: message.text,
      gapMs: now - lastInbound.at,
    });
    return;
  }
  recentInboundTurns.set(message.sender, { text: message.text || "", at: now });

  logInfo("agent", "process start", {
    messageId: message.messageId,
    sender: message.sender,
    to,
    hasText: Boolean(message.text),
    hasImage: hasImageMessage(message),
    hasDocument: hasDocumentMessage(message),
  });

  await appendTranscriptEntry(message.sender, {
    role: "customer",
    text:
      message.text ||
      (hasImageMessage(message) ? "(image)" : hasDocumentMessage(message) ? "(document/pdf)" : ""),
    messageId: message.messageId,
  });

  // Handle incoming document attachments (e.g. PDF payment receipts, menus, invoices)
  if (hasDocumentMessage(message)) {
    const caption = message.text?.trim() || "";
    let hasUpcoming = false;
    try {
      const { listAllPreBookings } = await import("../orders/pre-booking.ts");
      const { mauritiusDateIso } = await import("../time.ts");
      const all = await listAllPreBookings();
      const phoneDigits = message.sender.replace(/\D/g, "");
      const todayIso = mauritiusDateIso(new Date());
      hasUpcoming = all.some((b) => {
        if (b.customerPhone.replace(/\D/g, "") !== phoneDigits) return false;
        if (b.status !== "confirmed" && b.status !== "pending_rider" && b.status !== "dispatched") return false;
        const bDate = (b.scheduledDate && b.scheduledDate !== "today" && b.scheduledDate !== "tomorrow")
          ? b.scheduledDate
          : (b.slotKey?.split("_")[0] || b.createdAt.slice(0, 10));
        return bDate >= todayIso;
      });
    } catch {
      // Non-blocking
    }

    const promptText = hasUpcoming
      ? (caption ? `[Attached Document/Receipt for active booking: "${caption}"]` : `[Attached Document / Payment Receipt for active booking]`)
      : (caption ? `[Attached Document/PDF: "${caption}"]` : `[Attached Document/PDF Payment Receipt]`);

    logInfo("agent", "processing incoming document/pdf message", {
      sender: message.sender,
      caption,
      promptText,
      hasUpcoming,
    });

    const reply = await generateAgentReply({
      sender: message.sender,
      text: promptText,
      messageId: message.messageId,
      pushName: message.pushName,
    });

    await sendAndRecord({
      to,
      sender: message.sender,
      text: reply.text,
      messageId: message.messageId,
    });
    return;
  }

  if (hasImageMessage(message) && message.raw?.message) {
    try {
      const imageUrl = await persistIncomingPackageImage({
        senderPhone: message.sender,
        messageId: message.messageId,
        message: message.raw.message,
      });

      if (imageUrl) {
        await addPackageImageToDraft(message.sender, imageUrl);
        const caption = message.text?.trim();

        let hasUpcoming = false;
        try {
          const { listAllPreBookings } = await import("../orders/pre-booking.ts");
          const { mauritiusDateIso } = await import("../time.ts");
          const all = await listAllPreBookings();
          const phoneDigits = message.sender.replace(/\D/g, "");
          const todayIso = mauritiusDateIso(new Date());
          hasUpcoming = all.some((b) => {
            if (b.customerPhone.replace(/\D/g, "") !== phoneDigits) return false;
            if (b.status !== "confirmed" && b.status !== "pending_rider" && b.status !== "dispatched") return false;
            const bDate = (b.scheduledDate && b.scheduledDate !== "today" && b.scheduledDate !== "tomorrow")
              ? b.scheduledDate
              : (b.slotKey?.split("_")[0] || b.createdAt.slice(0, 10));
            return bDate >= todayIso;
          });
        } catch {
          // Non-blocking
        }

        const promptText = hasUpcoming
          ? (caption ? `[Customer sent Payment Screenshot for active booking: "${caption}"]` : `[Customer sent Payment Screenshot / Transfer Receipt for active booking]`)
          : (caption ? `[Attached Image: "${caption}"]` : `[Attached Image / Payment Screenshot]`);

        const reply = await generateAgentReply({
          sender: message.sender,
          text: promptText,
          messageId: message.messageId,
          pushName: message.pushName,
        });

        await sendAndRecord({
          to,
          sender: message.sender,
          text: reply.text,
          messageId: message.messageId,
        });

        logInfo("agent", "processed incoming image and generated reply", {
          to: message.sender,
          messageId: message.messageId,
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

  if (!message.text || !message.text.trim()) {
    logInfo("agent", "ignored empty message turn with no text", {
      messageId: message.messageId,
      sender: message.sender,
    });
    return;
  }

  const { isAuthorizedRiderOrAdmin } = await import("../riders/config.ts");
  const auth = isAuthorizedRiderOrAdmin(message.sender);

  // Opening bare greeting: present a fast, warm, natural text welcome (0 LLM tokens, pure WhatsApp text)
  if (!auth.isAdmin && !auth.rider && isBareGreeting(message.text)) {
    try {
      const transcript = await loadTranscript(message.sender);
      const priorCustomerEntries = transcript.entries.filter(
        (e) => e.role === "customer" && e.messageId !== message.messageId,
      );
      const lastPriorCustomerEntry = priorCustomerEntries[priorCustomerEntries.length - 1];
      const timeSinceLastTurn = lastPriorCustomerEntry
        ? Date.now() - new Date(lastPriorCustomerEntry.at).getTime()
        : Infinity;

      // If customer had an active exchange in the last 15 minutes that wasn't just a greeting,
      // or if an admin recently sent an injected message/relay,
      // let DeepSeek handle it in conversational context rather than repeating the welcome greeting.
      const lastAgentEntry = transcript.entries.filter((e) => e.role === "agent").at(-1);
      const hasRecentAdminRelay = Boolean(lastAgentEntry?.adminInjected);
      const hasRecentActiveFlow =
        hasRecentAdminRelay ||
        (timeSinceLastTurn < 15 * 60 * 1000 && !isBareGreeting(lastPriorCustomerEntry.text));


      if (!hasRecentActiveFlow) {
        const namePart = message.pushName?.trim() ? ` ${message.pushName.trim()}` : "";
        const greetingText = `👋 Welcome to Grabbit Express${namePart}! ⚡\nMauritius' on-demand electric delivery & passenger ride service.\n\nHow can we help you today? Let us know if you need a passenger ride, food delivery, or errand/package pickup! 😊`;

        // Record customer message if not already recorded by webhook handler
        const alreadyRecorded = transcript.entries.some(
          (e) => e.role === "customer" && (e.messageId === message.messageId || e.text === message.text),
        );
        if (!alreadyRecorded) {
          await appendTranscriptEntry(to, {
            role: "customer",
            text: message.text,
            messageId: message.messageId,
          });
        }

        try {
          await sendCustomerText({
            to,
            text: greetingText,
            messageId: `welcome_${message.messageId}`,
          });
        } catch (sendErr) {
          logWarn("agent", "failed to send welcome text via WhatsApp API", formatError(sendErr));
        }

        try {
          await appendTranscriptEntry(to, {
            role: "agent",
            text: greetingText,
            messageId: `welcome_${message.messageId}`,
          });
        } catch {
          // ignore transcript errors
        }

        logInfo("agent", "sent pure text welcome greeting", {
          to,
          sender: message.sender,
          messageId: message.messageId,
          pushName: message.pushName,
        });
        return;
      }
    } catch (greetErr) {
      logWarn("agent", "failed in greeting check, falling back to LLM", formatError(greetErr));
    }
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
          text: "You're welcome! 😊 Ping us anytime you need a ride or delivery 🛵⚡",
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

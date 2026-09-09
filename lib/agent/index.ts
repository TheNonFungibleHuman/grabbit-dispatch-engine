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
    try {
      const { persistIncomingDocument } = await import("../media/wasender.ts");
      const doc = await persistIncomingDocument({
        senderPhone: message.sender,
        messageId: message.messageId,
        message: message.raw?.message as Record<string, unknown> | undefined,
      });

      if (doc) {
        const { inspectPdfDocument } = await import("../media/pdf-inspector.ts");
        const pdfAnalysis = await inspectPdfDocument(doc.buffer, doc.url);

        if (pdfAnalysis.isPaymentReceipt) {
          if (pdfAnalysis.paymentDetails?.status === "failed") {
            const warnText =
              "It looks like this bank transfer did not complete successfully. Could you please check with your bank or try again? 🙏";
            await sendAndRecord({ to, sender: message.sender, text: warnText, messageId: message.messageId });
            return;
          }

          const { recordPaymentProofReceived } = await import("../orders/pre-booking.ts");
          const bank = pdfAnalysis.paymentDetails?.bank || "Bank Transfer";
          const amountPart = pdfAnalysis.paymentDetails?.amount ? ` of Rs ${pdfAnalysis.paymentDetails.amount}` : "";
          const refPart = pdfAnalysis.paymentDetails?.referenceId ? ` (Ref: ${pdfAnalysis.paymentDetails.referenceId})` : "";

          await recordPaymentProofReceived({
            customerPhone: message.sender,
            notes: `${pdfAnalysis.summary} (File: ${doc.fileName || "receipt.pdf"})`,
          });

          const confirmText = `Thank you! 📄 We've received and verified your ${bank} payment receipt${amountPart}${refPart}.`;
          await sendAndRecord({ to, sender: message.sender, text: confirmText, messageId: message.messageId });
          return;
        }

        // If not a receipt, it's a menu or general document - pass extracted text to agent
        const promptText = `[Customer sent PDF document (${doc.fileName || "document.pdf"}): "${pdfAnalysis.extractedText.slice(0, 500)}"]`;
        const reply = await generateAgentReply({
          sender: message.sender,
          text: promptText,
          messageId: message.messageId,
          pushName: message.pushName,
        });
        await sendAndRecord({ to, sender: message.sender, text: reply.text, messageId: message.messageId });
        return;
      }
    } catch (docErr) {
      logWarn("agent", "failed to inspect incoming document, falling back", formatError(docErr));
    }

    const promptText = caption ? `[Attached Document/PDF: "${caption}"]` : `[Attached Document/PDF Payment Receipt]`;
    const reply = await generateAgentReply({
      sender: message.sender,
      text: promptText,
      messageId: message.messageId,
      pushName: message.pushName,
    });
    await sendAndRecord({ to, sender: message.sender, text: reply.text, messageId: message.messageId });
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
        const caption = message.text?.trim() || "";

        try {
          const { inspectImageWithDeepSeekVision } = await import("../media/vision-inspector.ts");
          const vision = await inspectImageWithDeepSeekVision({ imageUrl });

          if (vision.isPaymentReceipt) {
            if (vision.paymentDetails?.status === "failed") {
              const failText =
                "It looks like this transfer did not complete successfully. Could you please check with your bank or try again? 🙏";
              await sendAndRecord({ to, sender: message.sender, text: failText, messageId: message.messageId });
              return;
            }

            const { recordPaymentProofReceived } = await import("../orders/pre-booking.ts");
            const bank = vision.paymentDetails?.bank || "Payment";
            const amountPart = vision.paymentDetails?.amount ? ` of Rs ${vision.paymentDetails.amount}` : "";
            const refPart = vision.paymentDetails?.referenceId ? ` (Ref: ${vision.paymentDetails.referenceId})` : "";

            await recordPaymentProofReceived({
              customerPhone: message.sender,
              notes: vision.summary,
            });

            const confirmText = `Thank you! 📄 We've received your ${bank} payment screenshot${amountPart}${refPart}.`;
            await sendAndRecord({ to, sender: message.sender, text: confirmText, messageId: message.messageId });
            return;
          }

          // If food menu or list, pass items directly to agent
          let promptText = caption ? `[Attached Image: "${caption}"]` : `[Attached Image]`;
          if (vision.category === "food_menu" && vision.extractedItems?.length) {
            promptText = `[Customer sent Menu/Food items photo: ${vision.extractedItems.join(", ")}${caption ? `. Caption: "${caption}"` : ""}]`;
          } else if (vision.summary) {
            promptText = `[Customer sent photo: "${vision.summary}"${caption ? `. Caption: "${caption}"` : ""}]`;
          }

          const reply = await generateAgentReply({
            sender: message.sender,
            text: promptText,
            messageId: message.messageId,
            pushName: message.pushName,
          });
          await sendAndRecord({ to, sender: message.sender, text: reply.text, messageId: message.messageId });
          return;
        } catch (visionErr) {
          logWarn("agent", "vision inspection failed, falling back to standard prompt", formatError(visionErr));
        }

        const promptText = caption ? `[Attached Image: "${caption}"]` : `[Attached Image / Payment Screenshot]`;
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

import { generateAgentReply } from "./deepseek.ts";
import { isDialogRouterEnabled, routeCustomerMessage, tryDeterministicBooking } from "./dialog-router.ts";
import {
  cleanCustomerGreetingName,
  isBareGreeting,
  isContentFreeMessage,
  isShortAcknowledgement,
  sanitizeWhatsAppText,
} from "./format.ts";
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
  type ChatTranscript,
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

  // Cross-instance duplicate guard: per-process maps cannot de-duplicate webhook
  // retries or retries that land on parallel serverless instances.
  try {
    const { shouldSuppressDuplicateReply } = await import("./reply-guard.ts");
    if (await shouldSuppressDuplicateReply(args.to, text, now)) {
      logWarn("agent", "suppressing cross-instance duplicate outbound reply", {
        to: args.to,
        messageId: args.messageId,
        preview: text.slice(0, 80),
      });
      return;
    }
  } catch (guardErr) {
    logWarn("agent", "reply-guard duplicate check failed; continuing send", formatError(guardErr));
  }

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
  // NOTE: sendCustomerText already records the send in the cross-instance
  // reply guard (lib/wasender/send-tracked.ts) — recording again here would
  // double the guard-store writes per reply.
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

  // Per-invocation transcript single-flight: the fast-path guards and the LLM
  // turn used to re-read the same transcript document 3–4 times per message.
  // This closure loads it at most once per message, scoped strictly to this
  // invocation — no cross-message staleness, no cross-customer leakage.
  let turnTranscript: ChatTranscript | null = null;
  const getTurnTranscript = async (): Promise<ChatTranscript> => {
    if (turnTranscript) return turnTranscript;
    turnTranscript = await loadTranscript(message.sender);
    return turnTranscript;
  };

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

  // Content-free inbound messages ("…", ".", emoji-only) carry no request and must
  // never trigger a full LLM turn on their own. Mid-burst they are continuation
  // nudges; answer only if the bot has NOT replied recently, otherwise stay silent.
  // (Pacifique incident, 2026-09-14: a lone "…" earned a full duplicate 60-word
  // reply 5.6s after the real answer.)
  if (isContentFreeMessage(message.text)) {
    try {
      const transcript = await getTurnTranscript();
      const agentEntries = transcript.entries.filter((e) => e.role === "agent");
      const lastAgentAt = agentEntries.length
        ? Date.parse(agentEntries[agentEntries.length - 1].at)
        : 0;
      if (Number.isFinite(lastAgentAt) && now - lastAgentAt < 90_000) {
        logInfo("agent", "skipping reply for content-free message (recent reply exists)", {
          sender: message.sender,
          messageId: message.messageId,
          text: message.text,
        });
        return;
      }
      await sendAndRecord({
        to,
        sender: message.sender,
        text: "Still with you! 😊 Just tell me what you need — a ride, a delivery, or an errand — and I will sort it out.",
        messageId: message.messageId,
      });
      logInfo("agent", "brief nudge ack for stale content-free message", {
        sender: message.sender,
        messageId: message.messageId,
      });
      return;
    } catch (error) {
      logWarn("agent", "content-free path failed; continuing normal reply", formatError(error));
    }
  }

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
          const proofRes = await recordPaymentProofReceived({
            customerPhone: message.sender,
            bank: pdfAnalysis.paymentDetails?.bank,
            amount: pdfAnalysis.paymentDetails?.amount,
            currency: pdfAnalysis.paymentDetails?.currency,
            referenceId: pdfAnalysis.paymentDetails?.referenceId,
            status: pdfAnalysis.paymentDetails?.status,
            notes: `${pdfAnalysis.summary} (File: ${doc.fileName || "receipt.pdf"})`,
          });

          await sendAndRecord({ to, sender: message.sender, text: proofRes.message, messageId: message.messageId });
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
            const proofRes = await recordPaymentProofReceived({
              customerPhone: message.sender,
              bank: vision.paymentDetails?.bank,
              amount: vision.paymentDetails?.amount,
              currency: vision.paymentDetails?.currency,
              referenceId: vision.paymentDetails?.referenceId,
              status: vision.paymentDetails?.status,
              notes: vision.summary,
            });

            await sendAndRecord({ to, sender: message.sender, text: proofRes.message, messageId: message.messageId });
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
        const cleanName = cleanCustomerGreetingName(message.pushName);
        const namePart = cleanName ? ` ${cleanName}` : "";
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
          cleanName,
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

      // CRITICAL CHECK: Never fire "You're welcome!" if there is an active escalation
      // or if the dispatcher/agent just asked a question or sent an escalation notice.
      const { getOpenCustomerEscalation } = await import("../ops/store.ts");
      const openEscalation = await getOpenCustomerEscalation(message.sender);

      const agentEntries = transcript.entries.filter((e) => e.role === "agent");
      const lastAgentText = (agentEntries[agentEntries.length - 1]?.text || "").toLowerCase();
      const isAwaitingResolution = Boolean(
        openEscalation ||
        lastAgentText.includes("escalated") ||
        lastAgentText.includes("reviewing your request") ||
        lastAgentText.includes("dispatcher will be with you") ||
        lastAgentText.includes("?") ||
        lastAgentText.includes("which exact") ||
        lastAgentText.includes("mind sending") ||
        lastAgentText.includes("what time") ||
        lastAgentText.includes("cash or transfer")
      );

      if (!isAwaitingResolution && (isInQuietWindow(transcript) || hadPauseGap)) {
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

  // Rapid post-booking follow-up handler:
  // If a booking was confirmed in the last 90s and the customer immediately sends
  // a short message confirming payment method or reassurance (e.g. "Payment in cash", "Cash", "Please"),
  // acknowledge concisely rather than regenerating a duplicate full-page confirmation card.
  try {
    const transcript = await getTurnTranscript();
    const lastBookingTs = transcript.lastBookingAt ? Date.parse(transcript.lastBookingAt) : 0;
    const isRecentBooking = Number.isFinite(lastBookingTs) && now - lastBookingTs < 90_000;
    if (isRecentBooking) {
      const cleaned = (message.text || "")
        .trim()
        .toLowerCase()
        .replace(/[!?.,👋✨⚡😊🛵☀🙏👍👌]+/gu, "")
        .trim();

      const isPaymentAck = /^(?:payment\s+(?:in\s+)?(?:cash|transfer|juice)|(?:in\s+)?cash|juice|transfer|by\s+cash|cash\s+payment|cash\s+please)$/i.test(cleaned);
      const isUrgencyAck = /^(?:please|pls|please\s+book\s+it|confirm\s+it)$/i.test(cleaned);

      if (isPaymentAck) {
        const isTransfer = /juice|transfer/i.test(cleaned);
        const paymentLabel = isTransfer ? "transfer via Juice / MCB" : "cash to the rider";
        await sendAndRecord({
          to,
          sender: message.sender,
          text: `Noted, payment in ${paymentLabel}! Have a great ride 🛵⚡`,
          messageId: message.messageId,
        });
        logInfo("agent", "acknowledged post-booking payment method follow-up concisely", {
          sender: message.sender,
          paymentLabel,
        });
        return;
      }

      if (isUrgencyAck) {
        await sendAndRecord({
          to,
          sender: message.sender,
          text: "Already locked in for you! Your rider is confirmed. See you soon! 🛵⚡",
          messageId: message.messageId,
        });
        logInfo("agent", "acknowledged post-booking urgency follow-up concisely", {
          sender: message.sender,
        });
        return;
      }
    }
  } catch (burstErr) {
    logWarn("agent", "post-booking burst follow-up check skipped", formatError(burstErr));
  }

  // ── Phase 3: deterministic dialog router (0 LLM tokens) ─────────────
  // After the greeting/ack/burst guards, before the LLM. Only customers —
  // never admins or riders. Books ONLY on an explicit confirmation word when
  // every slot is already resolved in the transcript; otherwise answers a
  // single missing slot deterministically. Everything else falls through.
  if (!auth.isAdmin && !auth.rider && isDialogRouterEnabled() && message.text) {
    try {
      const transcript = await getTurnTranscript();
      const decision = routeCustomerMessage({ text: message.text, transcript });

      if (decision.handled && decision.reply) {
        await sendAndRecord({ to, sender: message.sender, text: decision.reply, messageId: message.messageId });
        logInfo("agent", "router handled message deterministically", {
          sender: message.sender, reason: decision.reason,
        });
        return;
      }

      // All slots present — book only on an explicit confirmation word.
      if (decision.reason === "all_slots_present") {
        const isConfirm = /^(?:yes|yeah|yep|confirm|book it|go ahead|sure|ok book|please book)\b/i.test(message.text.trim());
        if (isConfirm) {
          const { extractIntakeState } = await import("../orders/intake-state.ts");
          const intake = extractIntakeState(transcript.entries);
          const booked = await tryDeterministicBooking({
            senderPhone: message.sender,
            customerName: message.pushName,
            intake,
          });
          if (booked.handled && booked.reply) {
            await sendAndRecord({ to, sender: message.sender, text: booked.reply, messageId: message.messageId });
            logInfo("agent", "router completed booking deterministically", {
              sender: message.sender, reason: booked.reason,
            });
            return;
          }
          logInfo("agent", "router booking fell through to LLM", { reason: booked.reason });
        }
      }
    } catch (routerErr) {
      logWarn("agent", "dialog router error; continuing to LLM", formatError(routerErr));
    }
  }

  const reply = await generateAgentReply({
    sender: message.sender,
    text: message.text,
    messageId: message.messageId,
    pushName: message.pushName,
    transcript: turnTranscript ?? undefined,
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

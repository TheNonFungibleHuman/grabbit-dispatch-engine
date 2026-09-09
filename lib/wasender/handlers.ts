import { processIncomingUserMessage } from "../agent/index.ts";
import { isAgentEnabled } from "../admin/agent-switch.ts";
import { formatError, logError, logInfo, logWarn } from "../log.ts";
import { recordOpsEvent } from "../ops/store.ts";
import { appendTranscriptEntry } from "../agent/transcript.ts";
import { sanitizeWhatsAppText } from "../agent/format.ts";
import { sendCustomerText } from "./send-tracked.ts";
import {
  claimInboundMessageId,
  completeInboundMessageId,
} from "./message-id-store.ts";
import { getSenderPhone } from "./parse.ts";
import type {
  IncomingUserMessage,
  MessagesReceivedEvent,
  WasenderIncomingMessage,
  WasenderWebhookEvent,
} from "./types.ts";

export { getSenderPhone, parseWasenderWebhookPayload } from "./parse.ts";
export type { IncomingUserMessage } from "./types.ts";

export async function handleWasenderEvent(
  payload: WasenderWebhookEvent,
): Promise<void> {
  logInfo("wasender", "event", { event: payload.event });

  switch (payload.event) {
    case "messages.received":
      await handleIncomingMessage(payload as MessagesReceivedEvent);
      break;
    case "poll.results":
      await handlePollResults(payload);
      break;
    case "session.status":
      logInfo("wasender", "session.status", payload.data);
      break;
    default:
      logInfo("wasender", `ignored event: ${payload.event}`);
  }
}

interface PollResultOption {
  name: string;
  voters?: string[];
}

interface PollResultsData {
  key?: {
    id?: string;
    remoteJid?: string;
    participant?: string;
  };
  pollResult?: PollResultOption[];
  [key: string]: unknown;
}

async function handlePollResults(payload: WasenderWebhookEvent): Promise<void> {
  const data = payload.data as PollResultsData | undefined;
  if (!data?.pollResult || !Array.isArray(data.pollResult)) {
    logInfo("wasender", "poll.results with no pollResult options array");
    return;
  }

  const remoteJid = data.key?.remoteJid || "";
  if (
    remoteJid.endsWith("@g.us") ||
    remoteJid.endsWith("@broadcast") ||
    remoteJid === "status@broadcast" ||
    remoteJid.includes("newsletter")
  ) {
    logInfo("wasender", "ignored group/broadcast poll event", { remoteJid });
    return;
  }

  const pollId = data.key?.id || String(payload.timestamp || Date.now());

  for (const option of data.pollResult) {
    if (!option.voters || !Array.isArray(option.voters) || option.voters.length === 0) {
      continue;
    }

    for (const rawVoter of option.voters) {
      const voterPhone = String(rawVoter).replace(/@.*$/, "").replace(/\D/g, "");
      if (!voterPhone) continue;

      const claimKey = `poll_${pollId}_${voterPhone}_${option.name}`;
      const claim = await claimInboundMessageId(claimKey);
      if (claim !== "new") {
        logInfo("wasender", "ignored duplicate poll vote event", { claimKey });
        continue;
      }

      try {
        const { isAuthorizedRiderOrAdmin } = await import("../riders/config.ts");
        const auth = isAuthorizedRiderOrAdmin(`+${voterPhone}`);
        if (auth.rider) {
          logInfo("wasender", "received poll vote from fleet rider", {
            rider: auth.rider.name,
            voterPhone,
            option: option.name,
            pollId,
          });

          const { handleRiderReply } = await import("../orders/pre-booking.ts");
          const replyResult = await handleRiderReply({
            senderPhone: `+${voterPhone}`,
            text: option.name,
          });

          if (replyResult.handled && replyResult.responseMessage) {
            await sendCustomerText({
              to: `+${voterPhone}`,
              text: replyResult.responseMessage,
              messageId: `reply_poll_${Date.now()}`,
            });
          }
        } else {
          // Customer poll response (hybrid interactive button tap)
          logInfo("wasender", "received interactive button/poll vote from customer", {
            customerPhone: voterPhone,
            selection: option.name,
            pollId,
          });

          const { withPhoneSessionLock } = await import("./session-lock.ts");
          await withPhoneSessionLock(`+${voterPhone}`, async () => {
            await onUserMessage({
              messageId: `poll_${pollId}_${Date.now()}`,
              sender: `+${voterPhone}`,
              remoteJid: data.key?.remoteJid || `${voterPhone}@s.whatsapp.net`,
              text: option.name,
            });
          });
        }
      } catch (err) {
        logWarn("wasender", "failed to process poll vote", formatError(err));
      } finally {
        await completeInboundMessageId(claimKey);
      }
    }
  }
}

function extractMessageBody(message: WasenderIncomingMessage): string {
  if (message.messageBody && message.messageBody.trim()) {
    return message.messageBody.trim();
  }
  const msg = message.message as Record<string, unknown> | undefined;
  if (!msg) return "";

  const readText = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;

  const node = (key: string): Record<string, unknown> | undefined =>
    msg[key] as Record<string, unknown> | undefined;

  const docNode = node("documentMessage") || (node("documentWithCaptionMessage")?.message as Record<string, unknown> | undefined)?.documentMessage as Record<string, unknown> | undefined;

  return (
    readText(msg.conversation) ??
    readText(node("extendedTextMessage")?.text) ??
    readText(node("buttonsResponseMessage")?.selectedDisplayText) ??
    readText(node("buttonsResponseMessage")?.selectedButtonId) ??
    readText(node("templateButtonReplyMessage")?.selectedDisplayText) ??
    readText(node("listResponseMessage")?.title) ??
    readText((node("listResponseMessage")?.singleSelectReply as Record<string, unknown> | undefined)?.selectedRowId) ??
    readText(node("imageMessage")?.caption) ??
    readText(docNode?.caption) ??
    (docNode?.fileName ? `[Document: ${String(docNode.fileName)}]` : undefined) ??
    ""
  );
}

async function handleIncomingMessage(
  payload: MessagesReceivedEvent,
): Promise<void> {
  const message = payload.data?.messages;
  if (!message?.key?.id) {
    logWarn("wasender", "messages.received without message key or id");
    return;
  }

  const remoteJid = message.key?.remoteJid || "";
  if (
    remoteJid.endsWith("@g.us") ||
    remoteJid.endsWith("@broadcast") ||
    remoteJid === "status@broadcast" ||
    remoteJid.includes("newsletter")
  ) {
    logInfo("wasender", "ignored group/broadcast/status message event", {
      remoteJid,
      messageId: message.key.id,
    });
    return;
  }

  // Deduplicate incoming messages across webhook events with a durable
  // claim so a crash mid-processing can never silently swallow a retry.
  const claim = await claimInboundMessageId(message.key.id);
  if (claim !== "new") {
    logInfo(
      "wasender",
      claim === "in_flight"
        ? "message is already being processed elsewhere; ignoring concurrent event"
        : "ignored duplicate incoming message event",
      { messageId: message.key.id, claim },
    );
    return;
  }

  try {
    await processClaimedIncomingMessage(message);
  } finally {
    await completeInboundMessageId(message.key.id);
  }
}

async function processClaimedIncomingMessage(
  message: WasenderIncomingMessage,
): Promise<void> {
  // Capture manual human messages sent from phone / WhatsApp Web
  if (message.key.fromMe) {
    const { isOutboundAiMessage } = await import("./send-tracked.ts");
    if (await isOutboundAiMessage(message.key.id)) {
      logInfo("wasender", "ignored automated agent fromMe echo", {
        messageId: message.key.id,
      });
      return;
    }

    const targetPhone = getSenderPhone(message);
    const text = extractMessageBody(message);

    if (text && targetPhone) {
      logInfo("wasender", "captured manual human takeover message from phone", {
        targetPhone,
        messageId: message.key.id,
        textPreview: text.slice(0, 120),
      });

      await appendTranscriptEntry(targetPhone, {
        role: "agent",
        text,
        at: new Date().toISOString(),
        messageId: message.key.id,
        adminInjected: true,
      });


      await recordOpsEvent({
        phone: targetPhone,
        type: "outbound_sent",
        messageId: message.key.id,
        preview: `[Human]: ${text}`,
      });
    }
    return;
  }

  const sender = getSenderPhone(message);
  const text = extractMessageBody(message);

  const msgObj = message.message as Record<string, unknown> | undefined;
  const hasImageOrDoc = Boolean(
    msgObj &&
      (msgObj.imageMessage ||
        msgObj.documentMessage ||
        msgObj.documentWithCaptionMessage),
  );

  // Wasender API guidance: ignore webhook events that carry no text or media payload
  // (e.g. WhatsApp emoji reactions, protocol/ack messages, stickers, ephemeral syncs).
  if (!text.trim() && !hasImageOrDoc) {
    logInfo("wasender", "ignored empty non-text/non-media message event", {
      messageId: message.key.id,
      from: sender,
    });
    return;
  }

  logInfo("wasender", "message received", {
    messageId: message.key.id,
    from: sender,
    remoteJid: message.key.remoteJid,
    pushName: message.pushName,
    textPreview: text.slice(0, 120),
    textLength: text.length,
    hasMedia: hasImageOrDoc,
  });

  const { withPhoneSessionLock } = await import("./session-lock.ts");
  await withPhoneSessionLock(sender, async () => {
    await onUserMessage({
      messageId: message.key.id,
      sender,
      remoteJid: message.key.remoteJid,
      text,
      pushName: message.pushName,
      raw: message,
    });
  });
}

async function onUserMessage(message: IncomingUserMessage): Promise<void> {
  const startedAt = Date.now();
  const { recordMetric } = await import("../metrics/recorder.ts");
  void recordMetric("inbound");
  await recordOpsEvent({
    phone: message.sender,
    type: "inbound_received",
    messageId: message.messageId,
    preview: message.text,
  });

  // Automatically index customer pushName/username for effortless admin resolution (e.g. "Tell Customer A...")
  if (message.pushName?.trim()) {
    try {
      const { isAuthorizedRiderOrAdmin } = await import("../riders/config.ts");
      const auth = isAuthorizedRiderOrAdmin(message.sender);
      if (!auth.isAuthorized) {
        const { updateCustomerProfile } = await import("../orders/store.ts");
        void updateCustomerProfile(message.sender, {
          name: message.pushName.trim(),
        });
      }
    } catch {
      // Non-blocking
    }
  }

  // 0. Compliance opt-out / re-subscribe handling — always wins, even mid-flow
  try {
    const { matchesOptOut, matchesResubscribe, suppressCustomerPhone, unsuppressCustomerPhone } =
      await import("../compliance/opt-out.ts");
    if (matchesOptOut(message.text)) {
      await suppressCustomerPhone(message.sender);
      const confirmation = sanitizeWhatsAppText(
        "You have been unsubscribed and will not receive any promotional messages from Grabbit Express. Bookings still work as usual — just message us anytime. (Reply START to re-subscribe.)",
      );
      await sendCustomerText({ to: message.sender, text: confirmation });
      await appendTranscriptEntry(message.sender, {
        role: "note",
        text: "[customer opted out of broadcasts]",
      });
      logInfo("wasender", "processed customer opt-out", { sender: message.sender });
      return;
    }
    if (matchesResubscribe(message.text)) {
      const changed = await unsuppressCustomerPhone(message.sender);
      if (changed) {
        const confirmation = sanitizeWhatsAppText(
          "Welcome back! You are re-subscribed to Grabbit Express updates.",
        );
        await sendCustomerText({ to: message.sender, text: confirmation });
      }
      logInfo("wasender", "processed customer resubscribe request", {
        sender: message.sender,
        changed,
      });
    }
  } catch (optErr) {
    logWarn("wasender", "opt-out check failed", formatError(optErr));
  }

  // 0.5. Check if incoming message is an Admin Action confirmation (e.g. daily rundown, weekly report, broadcast approval) (0 LLM tokens)
  try {
    const { isAuthorizedRiderOrAdmin } = await import("../riders/config.ts");
    const auth = isAuthorizedRiderOrAdmin(message.sender);
    if (auth.isAdmin) {
      const { consumePendingAdminAction } = await import("../admin/admin-actions.ts");
      const pendingRes = await consumePendingAdminAction(message.sender, message.text);
      if (pendingRes.handled && pendingRes.responseMessage) {
        await sendCustomerText({
          to: message.sender,
          text: pendingRes.responseMessage,
          messageId: `admin_action_${message.messageId}`,
        });
        await appendTranscriptEntry(message.sender, {
          role: "customer",
          text: message.text,
          messageId: message.messageId,
        });
        await appendTranscriptEntry(message.sender, {
          role: "agent",
          text: pendingRes.responseMessage,
          messageId: `admin_action_${message.messageId}`,
        });
        logInfo("wasender", "handled pending admin action with zero LLM tokens", {
          sender: message.sender,
        });
        return;
      }
    }
  } catch (actErr) {
    logWarn("wasender", "pending admin action check failed", formatError(actErr));
  }

  // 1. Check if incoming message is a 1-word command from a Fleet Rider (0 LLM tokens)
  try {
    const { isAuthorizedRiderOrAdmin } = await import("../riders/config.ts");
    const auth = isAuthorizedRiderOrAdmin(message.sender);
    if (auth.rider) {
      const { handleRiderCommand } = await import("../riders/commands.ts");
      const cmdResult = await handleRiderCommand({
        senderPhone: message.sender,
        messageText: message.text,
        rider: auth.rider,
      });

      if (cmdResult.handled && cmdResult.replyText) {
        await sendCustomerText({
          to: message.sender,
          text: cmdResult.replyText,
        });
        await appendTranscriptEntry(message.sender, {
          role: "customer",
          text: message.text,
          messageId: message.messageId,
        });
        await appendTranscriptEntry(message.sender, {
          role: "agent",
          text: cmdResult.replyText,
          messageId: message.messageId,
        });
        logInfo("wasender", "handled rider command with zero LLM tokens", {
          rider: auth.rider.name,
          action: cmdResult.action,
        });
        return;
      }

      if (!auth.isAdmin) {
        const { shouldInterceptRiderDecision, handleRiderReply, riderHasActiveBooking } =
          await import("../orders/pre-booking.ts");
        if (
          shouldInterceptRiderDecision({
            text: message.text,
            hasActiveBooking: await riderHasActiveBooking(auth.rider.name),
          })
        ) {
          const replyResult = await handleRiderReply({
            senderPhone: message.sender,
            text: message.text,
          });

          if (replyResult.handled && replyResult.responseMessage) {
            await sendCustomerText({
              to: message.sender,
              text: replyResult.responseMessage,
            });
            await appendTranscriptEntry(message.sender, {
              role: "customer",
              text: message.text,
              messageId: message.messageId,
            });
            await appendTranscriptEntry(message.sender, {
              role: "agent",
              text: replyResult.responseMessage,
              messageId: message.messageId,
            });
            logInfo("wasender", "handled rider booking decision with zero LLM tokens", {
              rider: auth.rider.name,
            });
            return;
          }
        }
      }
    }
  } catch (cmdErr) {
    logWarn("wasender", "rider command check failed", formatError(cmdErr));
  }

  // 1.5 Check if customer is waiting for admin reply (session frozen due to active escalation)
  try {
    const { isAuthorizedRiderOrAdmin } = await import("../riders/config.ts");
    const auth = isAuthorizedRiderOrAdmin(message.sender);
    if (!auth.isAdmin && !auth.rider) {
      const {
        getOpenCustomerEscalation,
        recordCustomerFollowUp,
        recordHoldingNoticeSent,
      } = await import("../ops/store.ts");

      const openEscalation = await getOpenCustomerEscalation(message.sender);
      if (openEscalation) {
        logInfo("wasender", "customer session frozen awaiting admin reply", {
          sender: message.sender,
          escalationId: openEscalation.id,
          reason: openEscalation.reason,
          textPreview: message.text.slice(0, 100),
        });

        // 1. Append message to customer transcript so full conversation history is preserved
        await appendTranscriptEntry(message.sender, {
          role: "customer",
          text: message.text || "(media/empty)",
          messageId: message.messageId,
        });

        // 2. Record follow-up message into the escalation record
        await recordCustomerFollowUp(message.sender, message.text);

        // 3. Alert Admin Sherif on WhatsApp about the follow-up
        try {
          const { notifyAdminCustomerFollowUp } = await import("../riders/notify-rider.ts");
          await notifyAdminCustomerFollowUp({
            customerPhone: message.sender,
            customerName: openEscalation.customerName || message.pushName || "Customer",
            escalationReason: openEscalation.reason,
            followUpText: message.text,
          });
        } catch (alertErr) {
          logWarn("wasender", "failed to alert admin of customer follow-up", formatError(alertErr));
        }

        // 4. Send rate-limited holding reply (max once every 3 minutes)
        const now = Date.now();
        const lastNotice = openEscalation.lastHoldingNoticeAt || 0;
        if (now - lastNotice > 3 * 60 * 1000) {
          const holdingText = sanitizeWhatsAppText(
            "Our dispatch team is currently reviewing your request and will get back to you shortly! 🙏",
          );
          try {
            await sendCustomerText({
              to: message.sender,
              text: holdingText,
              messageId: `holding_${message.messageId}`,
            });
          } catch (sendErr) {
            logWarn("wasender", "holding message network dispatch skipped/failed", formatError(sendErr));
          }
          await appendTranscriptEntry(message.sender, {
            role: "agent",
            text: holdingText,
            messageId: `holding_${message.messageId}`,
          });
          await recordHoldingNoticeSent(message.sender);
        }

        // Return immediately — 0 LLM tokens, 0 hallucination!
        return;
      }
    }
  } catch (escErr) {
    logWarn("wasender", "customer escalation freeze check failed", formatError(escErr));
  }

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

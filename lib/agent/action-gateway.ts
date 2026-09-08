import { resolveCustomerIdentity, normalizeCustomerPhone } from "../orders/customer-resolver.ts";
import { sendCustomerText } from "../wasender/send-tracked.ts";
import { appendTranscriptEntry, loadTranscript } from "./transcript.ts";
import { adminCancelOrDeleteBooking } from "../orders/pre-booking.ts";
import { logInfo, logWarn, formatError } from "../log.ts";
import { sanitizeWhatsAppText } from "./format.ts";

export interface ActionGatewayContext {
  senderPhone: string;
  isAdmin: boolean;
  incomingText: string;
  assistantText: string;
  calledTools: Set<string>;
  messageId: string;
}

export interface ActionGatewayResult {
  text: string;
  actionsExecuted: string[];
}

/**
 * Deterministic Action Gateway & Invariant Enforcer.
 * Guarantees that any side-effects requested by an Admin or claimed by the LLM
 * (such as sending a customer WhatsApp message, cancelling a booking, or viewing transcripts)
 * are ACTUALLY executed in TypeScript with verified receipts.
 */
function convertThirdPersonToSecondPerson(text: string): string {
  let res = text
    .replace(/\bhis\s+(trip|ride|order|booking|delivery|package|food|item|driver|request)\b/gi, "your $1")
    .replace(/\bher\s+(trip|ride|order|booking|delivery|package|food|item|driver|request)\b/gi, "your $1")
    .replace(/\btheir\s+(trip|ride|order|booking|delivery|package|food|item|driver|request)\b/gi, "your $1")
    .replace(/\bhe\s+is\b/gi, "you are")
    .replace(/\bshe\s+is\b/gi, "you are")
    .replace(/\bhe's\b/gi, "you're")
    .replace(/\bshe's\b/gi, "you're")
    .replace(/\bhim\s+that\b/gi, "you that")
    .replace(/\bher\s+that\b/gi, "you that")
    .replace(/\bhim\s+to\b/gi, "you to")
    .replace(/\bher\s+to\b/gi, "you to")
    .replace(/\bhe\s+has\b/gi, "you have")
    .replace(/\bshe\s+has\b/gi, "you have")
    .replace(/\bhe\s+can\b/gi, "you can")
    .replace(/\bshe\s+can\b/gi, "you can");

  if (res.length > 0) {
    res = res.charAt(0).toUpperCase() + res.slice(1);
  }
  return res;
}

export async function enforceAdminActionInvariants(
  ctx: ActionGatewayContext,
): Promise<ActionGatewayResult> {
  if (!ctx.isAdmin) {
    return { text: ctx.assistantText, actionsExecuted: [] };
  }

  let finalReply = ctx.assistantText;
  const actions: string[] = [];

  const adminText = ctx.incomingText.trim();
  const modelText = ctx.assistantText.trim();

  // Pattern 0: Admin asks to clear / reset escalations
  if (/\b(?:clear|reset|dismiss|delete|wipe)\s+(?:all\s+)?escalations?\b/i.test(adminText)) {
    const { clearAllEscalations } = await import("../ops/store.ts");
    const cleared = await clearAllEscalations(`Admin command: "${adminText}"`);
    actions.push("clear_all_escalations");
    finalReply = `✅ *Escalations Cleared!* All active customer escalations (${cleared.clearedCount}) have been wiped from the queue. Future requests will start with a fresh slate.`;
    return { text: finalReply, actionsExecuted: actions };
  }

  // Pattern 1: Admin asks to message a customer (with flexible prefixes and verbs)
  let tellTarget = "";
  let tellMessage = "";

  const prefixPattern = "^(?:please\\s+|can you\\s+|could you\\s+|kindly\\s+|hey\\s*,?\\s*|hi\\s*,?\\s*)?(?:tell|text|message|inform|relay(?:\\s+to)?|notify|send(?:\\s+a)?\\s+(?:message|text|wa|whatsapp)?\\s+to|write(?:\\s+to)?|let|reply(?:\\s+to)?)\\s+";

  // Case 1: Generic customer pronoun/alias: "tell customer that...", "text her to...", "message them..."
  const mGeneric = adminText.match(new RegExp(`${prefixPattern}(?:(?:the\\s+)?customer|her|him|them)\\s*(?:that|to|about|know\\s+that|saying\\s+that|saying)?\\s*[-:,—\\n]?\\s*(.+)$`, "i"));
  // Case 2: Named target with connector: "tell Customer C that...", "message Customer D to...", "text +230... saying..."
  const mNamedConnector = adminText.match(new RegExp(`${prefixPattern}([A-Za-zÀ-ÿ0-9_@.+]+(?:\\s+[A-Za-zÀ-ÿ0-9_@.+]+)?)\\s+(?:that|to|about|know\\s+that|saying\\s+that|saying)\\s*[-:,—\\n]?\\s*(.+)$`, "i"));
  // Case 3: Named target with delimiter: "tell Customer C: order ready", "text Customer D - driver outside"
  const mNamedDelim = adminText.match(new RegExp(`${prefixPattern}([A-Za-zÀ-ÿ0-9_@.+]+)\\s*[-:,—\\n]\\s*(.+)$`, "i"));
  // Case 4: Named target directly followed by message: "tell Customer C driver is here"
  const mNamedDirect = adminText.match(new RegExp(`${prefixPattern}([A-Za-zÀ-ÿ0-9_@.+]+)\\s+(.+)$`, "i"));

  if (mGeneric) {
    tellTarget = "ACTIVE_CUSTOMER";
    tellMessage = mGeneric[1].trim();
  } else if (mNamedConnector) {
    tellTarget = mNamedConnector[1].trim();
    tellMessage = mNamedConnector[2].trim();
  } else if (mNamedDelim) {
    tellTarget = mNamedDelim[1].trim();
    tellMessage = mNamedDelim[2].trim();
  } else if (mNamedDirect) {
    tellTarget = mNamedDirect[1].trim();
    tellMessage = mNamedDirect[2].trim();
  }

  // Check if model hallucinated and generated a customer greeting/message directly back to the admin!
  const customerGreetingMatch = modelText.match(/^(?:hello|hi|good\s+(?:morning|afternoon|evening)|dear)\s+([A-Za-z0-9_]+)[!,\s]/i);
  const greetedName = customerGreetingMatch?.[1]?.toLowerCase();
  const isGreetingCustomer = Boolean(
    greetedName &&
    !["admin", "sherif", "hanif", "team", "all", "there", "boss", "grabbit"].includes(greetedName),
  );

  const claimsSent =
    isGreetingCustomer ||
    // "I've sent the message to Customer F on WhatsApp"
    /(?:i(?:'ve| have) sent|sent (?:the )?(?:message|text)|notified|letting (?:him|her|them) know|i(?:'ll| will) send|sending now|message (?:has been )?(?:sent|delivered))\s/i.test(modelText) ||
    // "Here is the message I sent" / "Here's what I sent"
    /here(?:'s| is) (?:the|what).{0,30}(?:message|text).{0,30}(?:sent|delivered|relayed)/i.test(modelText) ||
    // "Done! Message sent to [Name]"
    /(?:done|sent)[!.]?\s+(?:message|text)\s+(?:sent|delivered)\s+to\s+/i.test(modelText);

  // 1. Invariant: WhatsApp Message to Customer MUST be sent
  if ((tellTarget || claimsSent) && !ctx.calledTools.has("admin_reply_to_customer")) {
    let rawTarget = tellTarget;
    if (!rawTarget || rawTarget === "ACTIVE_CUSTOMER") {
      let candidate = "";
      if (isGreetingCustomer && customerGreetingMatch?.[1]) {
        candidate = customerGreetingMatch[1].trim();
      } else {
        candidate = (modelText.match(/(?:to|letting)\s+\*?([A-Za-z0-9_.+\s]+?)\*?\s+(?:on whatsapp|\(?[+]?\d+\)?)/i)?.[1] || "").trim();
      }

      if (!candidate) {
        const adminTranscript = await loadTranscript(ctx.senderPhone);
        const recentAgentMessages = adminTranscript.entries
          .filter((e) => e.role === "agent")
          .slice(-3);
        for (const m of recentAgentMessages) {
          const nameMatch = m.text.match(/(?:Customer:|for|with|to)\s+\*?([A-Za-z0-9_.\s]+?)\*?\s*[(|\s]/i);
          if (nameMatch) {
            candidate = nameMatch[1].trim();
            break;
          }
        }
      }

      if (candidate) {
        rawTarget = candidate;
      } else if (!rawTarget) {
        rawTarget = "ACTIVE_CUSTOMER";
      }
    }
    
    if (rawTarget) {
      const resolved = await resolveCustomerIdentity(rawTarget);
      if (resolved && resolved.phone) {
        // Extract message to send
        let messageToSend = "";
        if (tellMessage) {
          messageToSend = convertThirdPersonToSecondPerson(tellMessage.trim());
        } else if (isGreetingCustomer) {
          // Model output IS the customer message
          messageToSend = modelText;
        } else {
          // Extract quoted message from model text
          const quoteMatch = modelText.match(/["“]([\s\S]+?)["”]/) || modelText.match(/•\s*\*?(.+?)\*?$/m);
          messageToSend = quoteMatch ? quoteMatch[1].trim() : modelText;
        }

        // Format into polite customer WhatsApp text if needed
        if (!messageToSend.toLowerCase().startsWith("hello") && !messageToSend.toLowerCase().startsWith("hi") && !messageToSend.toLowerCase().startsWith("dear")) {
          messageToSend = `Hello ${resolved.name}! 👋 This is Grabbit Express dispatch.\n\n${messageToSend}`;
        }

        const relayMsgId = `gateway_relay_${Date.now()}`;
        // Use formattedPhone (E.164 with +) for WaSender compatibility
        const targetPhone = resolved.formattedPhone || (resolved.phone.startsWith("+") ? resolved.phone : `+${resolved.phone}`);
        try {
          await sendCustomerText({
            to: targetPhone,
            text: sanitizeWhatsAppText(messageToSend),
            messageId: relayMsgId,
          });
        } catch (err) {
          logWarn("gateway", "whatsapp network dispatch skipped/failed", formatError(err));
        }

        try {
          await appendTranscriptEntry(resolved.phone, {
            role: "agent",
            text: sanitizeWhatsAppText(messageToSend),
            messageId: relayMsgId,
          });

          actions.push(`admin_reply_to_customer:${resolved.phone}`);
          logInfo("gateway", "enforced customer message dispatch", {
            customer: resolved.name,
            phone: resolved.phone,
            textPreview: messageToSend.slice(0, 100),
          });

          // Check if it's a cancellation notice, also auto-cancel booking
          if (
            /cancel/i.test(adminText) ||
            /no rider/i.test(adminText) ||
            /cannot take/i.test(adminText) ||
            /can't take/i.test(adminText) ||
            /unable to take/i.test(adminText) ||
            /sorry/i.test(adminText)
          ) {
            await adminCancelOrDeleteBooking({
              bookingIdOrQuery: resolved.phone,
              reason: "Cancelled by admin via message relay",
            });
            actions.push(`admin_cancel_or_delete_booking:${resolved.phone}`);
          }

          // Unfreeze customer session by resolving any open escalations
          try {
            const { resolvePendingEscalation } = await import("../ops/store.ts");
            await resolvePendingEscalation({
              customerPhone: resolved.phone,
              responseMessage: messageToSend,
              resolvedBy: ctx.senderPhone,
            });
            actions.push(`resolve_escalation:${resolved.phone}`);
          } catch (escErr) {
            logWarn("gateway", "failed to resolve escalation on admin relay", formatError(escErr));
          }

          finalReply = `✅ *Done, Admin! Verified message delivered to ${resolved.name} (${resolved.formattedPhone}) on WhatsApp:*\n\n"${sanitizeWhatsAppText(messageToSend)}"\n\nEscalation resolved and customer session unlocked. 👍`;
        } catch (err) {
          logWarn("gateway", "failed to record customer message dispatch", formatError(err));
          finalReply = `⚠️ Tried sending WhatsApp message to ${resolved.name} (${resolved.formattedPhone}), but encountered an issue: ${formatError(err).message}`;
        }
      } else {
        logWarn("gateway", "could not resolve customer identity for relay", { rawTarget });
        // Give admin a clear actionable error — tell them what we need
        finalReply = `⚠️ *Message NOT sent.* Could not find a WhatsApp number for "${rawTarget}" in the system.\n\nTo send the message, please reply with their phone number:\n*Tell [+230XXXXXXXX] [your message]*`;
      }
    }
  }

  // 2. Invariant: Admin asks to view/see messages sent to customer
  const viewChatMatch = adminText.match(
    /(?:see|show|view|look at|send)\s+(?:the\s+)?(?:messages?|chat|transcript|thread)\s*(?:you sent to them|sent to them|with|for)?\s*([A-Za-z0-9_.\s+]*)?/i,
  );

  if (viewChatMatch && !ctx.calledTools.has("admin_view_customer_chat")) {
    const rawTarget = (viewChatMatch[1] || "").trim();
    let targetPhone = "";
    let targetName = "";

    if (rawTarget) {
      const resolved = await resolveCustomerIdentity(rawTarget);
      if (resolved) {
        targetPhone = resolved.phone;
        targetName = resolved.name;
      }
    }

    // If no target in current prompt, look at previous admin turn's referenced customer
    if (!targetPhone) {
      const adminTranscript = await loadTranscript(ctx.senderPhone);
      const recentAgentMessages = adminTranscript.entries
        .filter((e) => e.role === "agent")
        .slice(-3);
      for (const m of recentAgentMessages) {
        const phoneMatch = m.text.match(/\+?(230\d{7,8}|\d{8,12})/);
        if (phoneMatch) {
          targetPhone = normalizeCustomerPhone(phoneMatch[1]);
          break;
        }
        const nameMatch = m.text.match(/(?:to|with)\s+\*?([A-Za-z0-9_.\s]+?)\*?\s+(?:on whatsapp|\()/i);
        if (nameMatch) {
          const res = await resolveCustomerIdentity(nameMatch[1].trim());
          if (res) {
            targetPhone = res.phone;
            targetName = res.name;
            break;
          }
        }
      }
    }

    if (targetPhone) {
      const transcript = await loadTranscript(targetPhone);
      const recent = transcript.entries.slice(-8);
      if (recent.length > 0) {
        const formatted = recent
          .map((e) => `• *[${e.role === "agent" ? "Grabbit" : "Customer"}]* (${e.at.slice(11, 16)} UTC): ${e.text}`)
          .join("\n\n");
        finalReply = `📋 *Actual WhatsApp Chat with ${targetName || targetPhone} (+${targetPhone}):*\n\n${formatted}\n\nAll verified directly from the customer's live chat record. 👍`;
        actions.push(`admin_view_customer_chat:${targetPhone}`);
      } else {
        finalReply = `📋 No previous messages found in the live WhatsApp thread for +${targetPhone}.`;
      }
    }
  }

  return {
    text: finalReply,
    actionsExecuted: actions,
  };
}

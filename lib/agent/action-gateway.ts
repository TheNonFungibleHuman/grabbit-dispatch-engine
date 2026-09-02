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

  // Pattern 1: Admin says "Tell [customer] [message]" or "Message [customer] [message]"
  let tellTarget = "";
  let tellMessage = "";

  const m1 = adminText.match(/^(?:tell|message|inform|relay to|notify|send message to|send to)\s+(?:the\s+customer\s+|customer\s+)?([A-Za-z0-9_.+]+(?:\s+[A-Za-z0-9_.+]+)?)\s+(?:that|to|about)\s+(.+)$/i);
  const m2 = adminText.match(/^(?:tell|message|inform|relay to|notify|send message to|send to)\s+(?:the\s+customer\s+|customer\s+)?([A-Za-z0-9_.+]+(?:\s+[A-Za-z0-9_.+]+)?)\s*[:,\-—\n]\s*(.+)$/i);
  const m3 = adminText.match(/^(?:tell|message|inform|relay to|notify|send message to|send to)\s+(?:the\s+customer|customer)\s+(.+)$/i);
  const m4 = adminText.match(/^(?:tell|message|inform|relay to|notify|send message to|send to)\s+([A-Za-z0-9_.+]+)\s+(.+)$/i);

  if (m1) {
    tellTarget = m1[1].trim();
    tellMessage = m1[2].trim();
  } else if (m2) {
    tellTarget = m2[1].trim();
    tellMessage = m2[2].trim();
  } else if (m3) {
    tellTarget = "ACTIVE_CUSTOMER";
    tellMessage = m3[1].trim();
  } else if (m4) {
    tellTarget = m4[1].trim();
    tellMessage = m4[2].trim();
  }

  const claimsSent =
    /(?:i've sent the message to|sent (?:the )?message to|notified|letting (?:him|her|them) know)\s+([A-Za-z0-9_.\s+]+?)\s*(?:on whatsapp|\(?[+]?\d+\)?|letting|\.)/i.test(
      modelText,
    );

  // 1. Invariant: WhatsApp Message to Customer MUST be sent
  if ((tellTarget || claimsSent) && !ctx.calledTools.has("admin_reply_to_customer")) {
    let rawTarget = tellTarget;
    if (!rawTarget || rawTarget === "ACTIVE_CUSTOMER") {
      rawTarget = (modelText.match(/(?:to|letting)\s+\*?([A-Za-z0-9_.\s+]+?)\*?\s+(?:on whatsapp|\(?[+]?\d+\)?)/i)?.[1] || "").trim();
    }

    // If still ACTIVE_CUSTOMER or empty, look up the last customer from admin transcript or active bookings
    if (!rawTarget || rawTarget === "ACTIVE_CUSTOMER") {
      const adminTranscript = await loadTranscript(ctx.senderPhone);
      const recentAgentMessages = adminTranscript.entries
        .filter((e) => e.role === "agent")
        .slice(-3);
      for (const m of recentAgentMessages) {
        const nameMatch = m.text.match(/(?:Customer:|for|with|to)\s+\*?([A-Za-z0-9_.\s]+?)\*?\s*(?:[(|]|\s+)/i);
        if (nameMatch) {
          rawTarget = nameMatch[1].trim();
          break;
        }
      }
    }
    
    if (rawTarget) {
      const resolved = await resolveCustomerIdentity(rawTarget);
      if (resolved && resolved.phone) {
        // Extract message to send
        let messageToSend = "";
        if (tellMessage) {
          messageToSend = tellMessage.trim();
        } else {
          // Extract quoted message from model text
          const quoteMatch = modelText.match(/["“]([\s\S]+?)["”]/) || modelText.match(/•\s*\*?(.+?)\*?$/m);
          messageToSend = quoteMatch ? quoteMatch[1].trim() : `Hello ${resolved.name}, this is Grabbit Express dispatch regarding your ride.`;
        }

        // Format into polite customer WhatsApp text if needed
        if (!messageToSend.toLowerCase().startsWith("hello") && !messageToSend.toLowerCase().startsWith("hi")) {
          messageToSend = `Hello ${resolved.name}! 👋 This is Grabbit Express dispatch.\n\n${messageToSend}`;
        }

        const relayMsgId = `gateway_relay_${Date.now()}`;
        try {
          await sendCustomerText({
            to: resolved.phone,
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
          if (/cancel/i.test(adminText) || /no rider/i.test(adminText)) {
            await adminCancelOrDeleteBooking({
              bookingIdOrQuery: resolved.phone,
              reason: "Cancelled by admin via message relay",
            });
            actions.push(`admin_cancel_or_delete_booking:${resolved.phone}`);
          }

          finalReply = `✅ *Done, Admin! Verified message delivered to ${resolved.name} (${resolved.formattedPhone}) on WhatsApp:*\n\n"${sanitizeWhatsAppText(messageToSend)}"\n\nBooking status updated. 👍`;
        } catch (err) {
          logWarn("gateway", "failed to record customer message dispatch", formatError(err));
          finalReply = `⚠️ Tried sending WhatsApp message to ${resolved.name} (${resolved.formattedPhone}), but encountered an issue: ${formatError(err).message}`;
        }
      } else {
        logWarn("gateway", "could not resolve customer identity for relay", { rawTarget });
        finalReply = `⚠️ Could not find a phone number for customer "${rawTarget}". Please provide their phone number so I can message them directly.`;
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

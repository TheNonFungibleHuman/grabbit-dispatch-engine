import { recordOpsEvent } from "../ops/store.ts";
import { sendTextMessage, type WasenderSendResult } from "./client.ts";

const OUTBOUND_AI_MESSAGE_IDS = new Set<string>();

export function registerOutboundAiMessage(id?: string): void {
  if (!id) return;
  OUTBOUND_AI_MESSAGE_IDS.add(id);
  if (OUTBOUND_AI_MESSAGE_IDS.size > 5000) {
    const oldest = OUTBOUND_AI_MESSAGE_IDS.values().next().value;
    if (oldest) OUTBOUND_AI_MESSAGE_IDS.delete(oldest);
  }
}

export function isOutboundAiMessage(id?: string): boolean {
  if (!id) return false;
  return OUTBOUND_AI_MESSAGE_IDS.has(id);
}

/**
 * Customer-facing send with ops tracking (success / fail / dropped numbers).
 */
export async function sendCustomerText(input: {
  to: string;
  text: string;
  messageId?: string;
}): Promise<WasenderSendResult> {
  if (input.messageId) {
    registerOutboundAiMessage(input.messageId);
  }

  try {
    const result = await sendTextMessage({
      to: input.to,
      text: input.text,
    });

    if (!result.success) {
      throw new Error(result.message ?? "Wasender reported unsuccessful send");
    }

    if (result.data && typeof result.data === "object") {
      const dataObj = result.data as Record<string, any>;
      if (dataObj.msgId) registerOutboundAiMessage(String(dataObj.msgId));
      if (dataObj.id) registerOutboundAiMessage(String(dataObj.id));
      if (dataObj.keyId) registerOutboundAiMessage(String(dataObj.keyId));
    }

    await recordOpsEvent({
      phone: input.to,
      type: "outbound_sent",
      messageId: input.messageId,
      preview: input.text,
    });
    return result;
  } catch (error) {
    await recordOpsEvent({
      phone: input.to,
      type: "outbound_failed",
      messageId: input.messageId,
      preview: input.text,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

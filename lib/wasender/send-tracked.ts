import { recordOpsEvent } from "../ops/store";
import { sendTextMessage, type WasenderSendResult } from "./client";

/**
 * Customer-facing send with ops tracking (success / fail / dropped numbers).
 */
export async function sendCustomerText(input: {
  to: string;
  text: string;
  messageId?: string;
}): Promise<WasenderSendResult> {
  try {
    const result = await sendTextMessage({
      to: input.to,
      text: input.text,
    });

    if (!result.success) {
      throw new Error(result.message ?? "Wasender reported unsuccessful send");
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

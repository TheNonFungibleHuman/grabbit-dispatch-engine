import { recordOpsEvent } from "../ops/store.ts";
import { sendTextMessage, type WasenderSendResult } from "./client.ts";
import {
  isKnownOutboundAiId,
  registerOutboundAiId,
} from "./message-id-store.ts";

async function noteSendMetrics(ok: boolean): Promise<void> {
  try {
    const { recordMetric, noteOutboundResult } = await import("../metrics/recorder.ts");
    void recordMetric(ok ? "outbound_sent" : "outbound_failed");
    await noteOutboundResult(ok);
  } catch {
    // metrics must never break sends
  }
}

export async function registerOutboundAiMessage(id?: string): Promise<void> {
  await registerOutboundAiId(id);
}

export async function isOutboundAiMessage(id?: string): Promise<boolean> {
  return isKnownOutboundAiId(id);
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
    await registerOutboundAiMessage(input.messageId);
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
      const dataObj = result.data as { msgId?: unknown; id?: unknown; keyId?: unknown };
      for (const key of ["msgId", "id", "keyId"] as const) {
        if (dataObj[key]) await registerOutboundAiMessage(String(dataObj[key]));
      }
    }

    await recordOpsEvent({
      phone: input.to,
      type: "outbound_sent",
      messageId: input.messageId,
      preview: input.text,
    });
    await noteSendMetrics(true);
    return result;
  } catch (error) {
    await recordOpsEvent({
      phone: input.to,
      type: "outbound_failed",
      messageId: input.messageId,
      preview: input.text,
      error: error instanceof Error ? error.message : String(error),
    });
    await noteSendMetrics(false);
    throw error;
  }
}

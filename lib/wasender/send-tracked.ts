import { recordOpsEvent } from "../ops/store.ts";
import { sendPollMessage, sendTextMessage, type WasenderSendResult } from "./client.ts";
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

/**
 * Dispatch an interactive poll to a rider with ops event tracking.
 */
export async function sendCustomerPoll(input: {
  to: string;
  question: string;
  options: string[];
  messageId?: string;
}): Promise<WasenderSendResult> {
  if (input.messageId) {
    await registerOutboundAiMessage(input.messageId);
  }

  try {
    const result = await sendPollMessage({
      to: input.to,
      question: input.question,
      options: input.options,
      multiSelect: false,
    });

    if (!result.success) {
      throw new Error(result.message ?? "Wasender reported unsuccessful poll send");
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
      preview: `[Poll] ${input.question} -> ${input.options.join(" | ")}`,
    });

    try {
      const { findRiderByPhone } = await import("../riders/config.ts");
      if (!findRiderByPhone(input.to)) {
        const { appendTranscriptEntry } = await import("../agent/transcript.ts");
        await appendTranscriptEntry(input.to, {
          role: "agent",
          text: `${input.question}\n[Options: ${input.options.join(" | ")}]`,
          messageId: input.messageId,
        });
      }
    } catch {
      // ignore transcript errors
    }

    await noteSendMetrics(true);
    return result;
  } catch (error) {
    await recordOpsEvent({
      phone: input.to,
      type: "outbound_failed",
      messageId: input.messageId,
      preview: `[Poll] ${input.question}`,
      error: error instanceof Error ? error.message : String(error),
    });
    await noteSendMetrics(false);
    throw error;
  }
}


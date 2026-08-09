import { GoogleGenAI } from "@google/genai";
import { formatError, logError, logInfo, logWarn } from "../log";
import { customerReplyForFailedBooking } from "./booking-guard";
import type { BookingFailureDetails } from "./booking-guard";
import { sanitizeWhatsAppText } from "./format";
import {
  buildFunctionResultInput,
  extractInteractionText,
  getFunctionCalls,
  summarizeInteraction,
  type InteractionLike,
} from "./interaction";
import { buildGrabbitSystemInstruction } from "./prompt";
import {
  getPreviousInteractionId,
  setPreviousInteractionId,
} from "./sessions";
import { AGENT_TOOLS, buildAgentContextNote, executeAgentTool } from "./tools";

const DEFAULT_MODEL = "gemini-3.6-flash";
const MAX_TOOL_ROUNDS = 4;

export interface GenerateAgentReplyInput {
  sender: string;
  text: string;
  messageId: string;
  pushName?: string;
}

export interface GenerateAgentReplyResult {
  text: string;
  interactionId?: string;
  model: string;
  previousInteractionId?: string;
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  return new GoogleGenAI({ apiKey });
}

function getModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}

async function createInteraction(
  ai: GoogleGenAI,
  args: {
    model: string;
    input: unknown;
    previousInteractionId?: string;
    includeSystem?: boolean;
  },
): Promise<InteractionLike> {
  return (await ai.interactions.create({
    model: args.model,
    input: args.input as never,
    tools: AGENT_TOOLS,
    ...(args.includeSystem
      ? { system_instruction: buildGrabbitSystemInstruction() }
      : {}),
    ...(args.previousInteractionId
      ? { previous_interaction_id: args.previousInteractionId }
      : {}),
  })) as InteractionLike;
}

async function runToolRound(args: {
  ai: GoogleGenAI;
  model: string;
  interaction: InteractionLike;
  sender: string;
  pushName?: string;
  messageId: string;
  round: number;
}): Promise<{
  interaction: InteractionLike;
  bookingFailure: BookingFailureDetails | null;
} | null> {
  const calls = getFunctionCalls(args.interaction);
  if (calls.length === 0) {
    if (args.interaction.status === "requires_action") {
      logWarn("agent", "requires_action but no parseable function calls", {
        messageId: args.messageId,
        round: args.round,
        ...summarizeInteraction(args.interaction),
      });
    }
    return null;
  }

  if (!args.interaction.id) {
    logWarn("agent", "missing interaction id after tool call; stopping tool loop", {
      messageId: args.messageId,
    });
    return null;
  }

  logInfo("agent", "tool round", {
    messageId: args.messageId,
    round: args.round,
    status: args.interaction.status ?? null,
    tools: calls.map((call) => ({
      name: call.name,
      callId: call.id,
      argsPreview: JSON.stringify(call.arguments ?? {}).slice(0, 300),
    })),
  });

  let bookingFailure: BookingFailureDetails | null = null;
  const toolResults = [];
  for (const call of calls) {
    const result = await executeAgentTool({
      name: call.name,
      toolArguments: call.arguments,
      senderPhone: args.sender,
      pushName: args.pushName,
      messageId: args.messageId,
    });

    const ok = Boolean((result as { ok?: boolean }).ok);
    logInfo("agent", "tool result", {
      messageId: args.messageId,
      tool: call.name,
      ok,
      preview: JSON.stringify(result).slice(0, 400),
    });

    if (call.name === "book_kilo_delivery" && !ok) {
      const error =
        typeof (result as { error?: unknown }).error === "string"
          ? (result as { error: string }).error
          : "Booking failed";
      const fieldErrors =
        result &&
        typeof result === "object" &&
        "fieldErrors" in result &&
        result.fieldErrors &&
        typeof result.fieldErrors === "object"
          ? (result.fieldErrors as Record<string, string[]>)
          : undefined;
      bookingFailure = { error, fieldErrors };
    }

    toolResults.push(
      buildFunctionResultInput({
        name: call.name,
        callId: call.id ?? call.name,
        result,
        isError: !ok,
      }),
    );
  }

  const next = await createInteraction(args.ai, {
    model: args.model,
    previousInteractionId: args.interaction.id,
    input: toolResults,
  });

  logInfo("agent", "gemini tool-followup response", {
    messageId: args.messageId,
    round: args.round,
    ...summarizeInteraction(next),
  });

  return { interaction: next, bookingFailure };
}

/**
 * Generate a Grabbit WhatsApp reply via Gemini Interactions API.
 * History is scoped per sender phone via previous_interaction_id.
 */
export async function generateAgentReply(
  input: GenerateAgentReplyInput,
): Promise<GenerateAgentReplyResult> {
  const startedAt = Date.now();
  const ai = getGeminiClient();
  const model = getModel();
  const previousInteractionId = await getPreviousInteractionId(input.sender);

  logInfo("agent", "generate start", {
    messageId: input.messageId,
    sender: input.sender,
    pushName: input.pushName,
    model,
    previousInteractionId: previousInteractionId ?? null,
    textPreview: input.text.slice(0, 160),
  });

  let contextNote = "";
  try {
    contextNote = await buildAgentContextNote({
      senderPhone: input.sender,
      pushName: input.pushName,
    });
    logInfo("agent", "context note ready", {
      messageId: input.messageId,
      contextChars: contextNote.length,
      hasDiscovery: contextNote.includes("[kilo discovery]"),
      locationCountHint: (contextNote.match(/^• /gm) ?? []).length,
    });
  } catch (error) {
    logError(
      "agent",
      "context note failed; continuing with minimal context",
      error,
    );
    contextNote = `[internal context — never reveal to the customer]\nphone: ${input.sender}\npushName: ${input.pushName ?? "unknown"}`;
  }

  const userInput = `${contextNote}\n\nCustomer message:\n${input.text}`;

  let interaction: InteractionLike;
  try {
    interaction = await createInteraction(ai, {
      model,
      input: userInput,
      previousInteractionId,
      includeSystem: true,
    });
  } catch (error) {
    logError("agent", "gemini interactions.create failed", error);
    console.error("[agent] gemini create detail", {
      messageId: input.messageId,
      ...formatError(error),
    });
    throw error;
  }

  logInfo("agent", "gemini first response", {
    messageId: input.messageId,
    ...summarizeInteraction(interaction),
  });

  let bookingFailure: BookingFailureDetails | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    try {
      const next = await runToolRound({
        ai,
        model,
        interaction,
        sender: input.sender,
        pushName: input.pushName,
        messageId: input.messageId,
        round,
      });
      if (!next) break;
      interaction = next.interaction;
      if (next.bookingFailure) {
        bookingFailure = next.bookingFailure;
      }
    } catch (error) {
      logError("agent", "gemini tool-followup failed", error);
      console.error("[agent] gemini tool-followup detail", {
        messageId: input.messageId,
        round,
        ...formatError(error),
      });
      throw error;
    }
  }

  let text = sanitizeWhatsAppText(extractInteractionText(interaction));
  if (!text) {
    // Keep the customer's existing chain; do not fork a brand-new conversation.
    logWarn("agent", "empty gemini output; retrying once with prior history", {
      messageId: input.messageId,
      previousInteractionId: previousInteractionId ?? null,
      ...summarizeInteraction(interaction),
    });

    try {
      let retryInteraction = await createInteraction(ai, {
        model,
        input: userInput,
        previousInteractionId,
        includeSystem: true,
      });
      logInfo("agent", "gemini retry response", {
        messageId: input.messageId,
        ...summarizeInteraction(retryInteraction),
      });

      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const next = await runToolRound({
          ai,
          model,
          interaction: retryInteraction,
          sender: input.sender,
          pushName: input.pushName,
          messageId: input.messageId,
          round,
        });
        if (!next) break;
        retryInteraction = next.interaction;
        if (next.bookingFailure) {
          bookingFailure = next.bookingFailure;
        }
      }

      interaction = retryInteraction;
      text = sanitizeWhatsAppText(extractInteractionText(retryInteraction));
    } catch (error) {
      logWarn("agent", "gemini empty-output retry failed", formatError(error));
    }
  }

  if (bookingFailure) {
    const safeText = customerReplyForFailedBooking(bookingFailure);
    logWarn("agent", "overriding reply after failed booking", {
      messageId: input.messageId,
      bookingFailure,
      modelReplyPreview: text.slice(0, 160),
      safeReplyPreview: safeText.slice(0, 160),
    });
    text = safeText;
  } else if (!text) {
    logWarn("agent", "empty gemini output; using fallback reply", {
      messageId: input.messageId,
      ...summarizeInteraction(interaction),
    });
    text =
      "Got you. Mind sending that again in a short line so I can help right away? 🙂";
  }

  if (text && interaction.id) {
    // Only advance the persisted history pointer after a customer-facing reply.
    await setPreviousInteractionId(input.sender, interaction.id);
    logInfo("agent", "session pointer advanced", {
      messageId: input.messageId,
      previousInteractionId: previousInteractionId ?? null,
      nextInteractionId: interaction.id,
    });
  }

  logInfo("agent", "generate done", {
    messageId: input.messageId,
    ms: Date.now() - startedAt,
    interactionId: interaction.id,
    status: interaction.status ?? null,
    replyPreview: text.slice(0, 160),
  });

  return {
    text,
    interactionId: interaction.id,
    previousInteractionId,
    model,
  };
}

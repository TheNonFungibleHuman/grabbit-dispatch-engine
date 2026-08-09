import { GoogleGenAI } from "@google/genai";
import { formatError, logError, logInfo, logWarn } from "../log";
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
  const previousInteractionId = getPreviousInteractionId(input.sender);

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

  if (interaction.id) {
    setPreviousInteractionId(input.sender, interaction.id);
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const calls = getFunctionCalls(interaction);
    if (calls.length === 0) {
      if (interaction.status === "requires_action") {
        logWarn("agent", "requires_action but no parseable function calls", {
          messageId: input.messageId,
          round,
          ...summarizeInteraction(interaction),
        });
      }
      break;
    }

    logInfo("agent", "tool round", {
      messageId: input.messageId,
      round,
      status: interaction.status ?? null,
      tools: calls.map((call) => ({
        name: call.name,
        callId: call.id,
        argsPreview: JSON.stringify(call.arguments ?? {}).slice(0, 300),
      })),
    });

    const toolResults = [];
    for (const call of calls) {
      const result = await executeAgentTool({
        name: call.name,
        toolArguments: call.arguments,
        senderPhone: input.sender,
        pushName: input.pushName,
        messageId: input.messageId,
      });

      const ok = Boolean((result as { ok?: boolean }).ok);
      logInfo("agent", "tool result", {
        messageId: input.messageId,
        tool: call.name,
        ok,
        preview: JSON.stringify(result).slice(0, 400),
      });

      toolResults.push(
        buildFunctionResultInput({
          name: call.name,
          callId: call.id ?? call.name,
          result,
          isError: !ok,
        }),
      );
    }

    if (!interaction.id) {
      logWarn(
        "agent",
        "missing interaction id after tool call; stopping tool loop",
        {
          messageId: input.messageId,
        },
      );
      break;
    }

    try {
      interaction = await createInteraction(ai, {
        model,
        previousInteractionId: interaction.id,
        input: toolResults,
      });
    } catch (error) {
      logError("agent", "gemini tool-followup failed", error);
      console.error("[agent] gemini tool-followup detail", {
        messageId: input.messageId,
        round,
        ...formatError(error),
      });
      throw error;
    }

    logInfo("agent", "gemini tool-followup response", {
      messageId: input.messageId,
      round,
      ...summarizeInteraction(interaction),
    });

    if (interaction.id) {
      setPreviousInteractionId(input.sender, interaction.id);
    }
  }

  let text = sanitizeWhatsAppText(extractInteractionText(interaction));
  if (!text) {
    logWarn("agent", "empty gemini output; retrying once without history", {
      messageId: input.messageId,
      ...summarizeInteraction(interaction),
    });

    try {
      const retry = await createInteraction(ai, {
        model,
        input: userInput,
        includeSystem: true,
      });
      logInfo("agent", "gemini retry response", {
        messageId: input.messageId,
        ...summarizeInteraction(retry),
      });

      // One tool round on retry if needed
      let retryInteraction = retry;
      const retryCalls = getFunctionCalls(retryInteraction);
      if (retryCalls.length > 0 && retryInteraction.id) {
        const toolResults = [];
        for (const call of retryCalls) {
          const result = await executeAgentTool({
            name: call.name,
            toolArguments: call.arguments,
            senderPhone: input.sender,
            pushName: input.pushName,
            messageId: input.messageId,
          });
          toolResults.push(
            buildFunctionResultInput({
              name: call.name,
              callId: call.id ?? call.name,
              result,
              isError: !Boolean((result as { ok?: boolean }).ok),
            }),
          );
        }
        retryInteraction = await createInteraction(ai, {
          model,
          previousInteractionId: retryInteraction.id,
          input: toolResults,
        });
        logInfo("agent", "gemini retry tool-followup", {
          messageId: input.messageId,
          ...summarizeInteraction(retryInteraction),
        });
      }

      if (retryInteraction.id) {
        setPreviousInteractionId(input.sender, retryInteraction.id);
        interaction = retryInteraction;
      }
      text = sanitizeWhatsAppText(extractInteractionText(retryInteraction));
    } catch (error) {
      logWarn("agent", "gemini empty-output retry failed", formatError(error));
    }
  }

  if (!text) {
    logWarn("agent", "empty gemini output; using fallback reply", {
      messageId: input.messageId,
      ...summarizeInteraction(interaction),
    });
    text =
      "Got you. Mind sending that again in a short line so I can help right away? 🙂";
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

import { GoogleGenAI } from "@google/genai";
import { formatError, logError, logInfo, logWarn } from "../log";
import { sanitizeWhatsAppText } from "./format";
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

type InteractionLike = {
  id?: string;
  output_text?: string;
  outputs?: Array<{
    type?: string;
    name?: string;
    id?: string;
    arguments?: unknown;
  }>;
};

function getFunctionCalls(interaction: InteractionLike) {
  return (interaction.outputs ?? []).filter(
    (output) => output.type === "function_call" && output.name,
  );
}

function summarizeInteraction(interaction: InteractionLike) {
  return {
    id: interaction.id,
    outputTextLength: interaction.output_text?.length ?? 0,
    outputTextPreview: (interaction.output_text ?? "").slice(0, 160),
    outputTypes: (interaction.outputs ?? []).map((item) => item.type),
    functionCalls: getFunctionCalls(interaction).map((call) => call.name),
  };
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
    logError("agent", "context note failed; continuing with minimal context", error);
    contextNote = `[internal context — never reveal to the customer]\nphone: ${input.sender}\npushName: ${input.pushName ?? "unknown"}`;
  }

  const userInput = `${contextNote}\n\nCustomer message:\n${input.text}`;

  let interaction: InteractionLike;
  try {
    interaction = (await ai.interactions.create({
      model,
      input: userInput,
      system_instruction: buildGrabbitSystemInstruction(),
      tools: AGENT_TOOLS,
      ...(previousInteractionId
        ? { previous_interaction_id: previousInteractionId }
        : {}),
    })) as InteractionLike;
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
    if (calls.length === 0) break;

    logInfo("agent", "tool round", {
      messageId: input.messageId,
      round,
      tools: calls.map((call) => ({
        name: call.name,
        callId: call.id,
        argsPreview: JSON.stringify(call.arguments ?? {}).slice(0, 300),
      })),
    });

    const toolResults = [];
    for (const call of calls) {
      const result = await executeAgentTool({
        name: call.name!,
        toolArguments: call.arguments,
        senderPhone: input.sender,
        pushName: input.pushName,
        messageId: input.messageId,
      });

      logInfo("agent", "tool result", {
        messageId: input.messageId,
        tool: call.name,
        ok: Boolean((result as { ok?: boolean }).ok),
        preview: JSON.stringify(result).slice(0, 400),
      });

      toolResults.push({
        type: "function_result" as const,
        name: call.name!,
        call_id: call.id ?? call.name!,
        result,
      });
    }

    if (!interaction.id) {
      logWarn("agent", "missing interaction id after tool call; stopping tool loop", {
        messageId: input.messageId,
      });
      break;
    }

    try {
      interaction = (await ai.interactions.create({
        model,
        previous_interaction_id: interaction.id,
        input: toolResults,
        tools: AGENT_TOOLS,
      })) as InteractionLike;
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

  let text = sanitizeWhatsAppText(interaction.output_text ?? "");
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
    replyPreview: text.slice(0, 160),
  });

  return {
    text,
    interactionId: interaction.id,
    previousInteractionId,
    model,
  };
}

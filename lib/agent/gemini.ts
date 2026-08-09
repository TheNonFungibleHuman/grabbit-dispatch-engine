import { GoogleGenAI } from "@google/genai";
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

/**
 * Generate a Grabbit WhatsApp reply via Gemini Interactions API.
 * History is scoped per sender phone via previous_interaction_id.
 */
export async function generateAgentReply(
  input: GenerateAgentReplyInput,
): Promise<GenerateAgentReplyResult> {
  const ai = getGeminiClient();
  const model = getModel();
  const previousInteractionId = getPreviousInteractionId(input.sender);
  const contextNote = await buildAgentContextNote({
    senderPhone: input.sender,
    pushName: input.pushName,
  });
  const userInput = `${contextNote}\n\nCustomer message:\n${input.text}`;

  let interaction = (await ai.interactions.create({
    model,
    input: userInput,
    system_instruction: buildGrabbitSystemInstruction(),
    tools: AGENT_TOOLS,
    ...(previousInteractionId
      ? { previous_interaction_id: previousInteractionId }
      : {}),
  })) as InteractionLike;

  if (interaction.id) {
    setPreviousInteractionId(input.sender, interaction.id);
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const calls = getFunctionCalls(interaction);
    if (calls.length === 0) break;

    const toolResults = [];
    for (const call of calls) {
      const result = await executeAgentTool({
        name: call.name!,
        toolArguments: call.arguments,
        senderPhone: input.sender,
        pushName: input.pushName,
        messageId: input.messageId,
      });

      toolResults.push({
        type: "function_result" as const,
        name: call.name!,
        call_id: call.id ?? call.name!,
        result,
      });
    }

    interaction = (await ai.interactions.create({
      model,
      previous_interaction_id: interaction.id,
      input: toolResults,
      tools: AGENT_TOOLS,
    })) as InteractionLike;

    if (interaction.id) {
      setPreviousInteractionId(input.sender, interaction.id);
    }
  }

  const text = sanitizeWhatsAppText(interaction.output_text ?? "");
  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  return {
    text,
    interactionId: interaction.id,
    previousInteractionId,
    model,
  };
}

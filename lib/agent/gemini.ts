import { GoogleGenAI } from "@google/genai";
import { sanitizeWhatsAppText } from "./format";
import { buildGrabbitSystemInstruction } from "./prompt";
import {
  getPreviousInteractionId,
  setPreviousInteractionId,
} from "./sessions";

const DEFAULT_MODEL = "gemini-3.6-flash";

export interface GenerateAgentReplyInput {
  sender: string;
  text: string;
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

/**
 * Generate a Grabbit WhatsApp reply via Gemini Interactions API.
 * History is scoped per sender phone via previous_interaction_id.
 * @see https://ai.google.dev/gemini-api/docs/interactions-overview
 */
export async function generateAgentReply(
  input: GenerateAgentReplyInput,
): Promise<GenerateAgentReplyResult> {
  const ai = getGeminiClient();
  const model = getModel();
  const previousInteractionId = getPreviousInteractionId(input.sender);

  const interaction = await ai.interactions.create({
    model,
    input: input.text,
    system_instruction: buildGrabbitSystemInstruction(),
    ...(previousInteractionId
      ? { previous_interaction_id: previousInteractionId }
      : {}),
  });

  if (interaction.id) {
    setPreviousInteractionId(input.sender, interaction.id);
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

import { formatError, logError, logInfo, logWarn } from "../log.ts";
import {
  closedHoursComeBackReply,
  customerReplyForFailedBooking,
  looksLikeFalseDeferredOrderPromise,
  type BookingFailureDetails,
} from "./booking-guard.ts";
import { sanitizeWhatsAppText } from "./format.ts";
import { buildGrabbitSystemInstruction } from "./prompt.ts";
import {
  DEEPSEEK_AGENT_TOOLS,
  buildAgentContextNote,
  executeAgentTool,
} from "./tools.ts";
import { loadTranscript } from "./transcript.ts";

const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_BASE_URL = "https://api.deepseek.com";
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

interface DeepSeekToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface DeepSeekChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: DeepSeekToolCall[];
}

interface DeepSeekChatCompletionResponse {
  id?: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: DeepSeekToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: {
    message: string;
    type?: string;
    code?: string;
  };
}

function getDeepSeekApiKey(): string {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is not configured");
  }
  return apiKey;
}

function getDeepSeekBaseUrl(): string {
  const raw = process.env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

function getModel(): string {
  return process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL;
}

async function callDeepSeekChat(args: {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: DeepSeekChatMessage[];
  tools?: typeof DEEPSEEK_AGENT_TOOLS;
}): Promise<DeepSeekChatCompletionResponse> {
  const url = `${args.baseUrl}/chat/completions`;
  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
    temperature: 0.3,
  };

  if (args.tools && args.tools.length > 0) {
    body.tools = args.tools;
    body.tool_choice = "auto";
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `DeepSeek API error HTTP ${response.status} (${response.statusText}): ${errorText}`,
    );
  }

  return (await response.json()) as DeepSeekChatCompletionResponse;
}

/**
 * Generate a Grabbit WhatsApp reply via DeepSeek Chat API.
 */
export async function generateAgentReply(
  input: GenerateAgentReplyInput,
): Promise<GenerateAgentReplyResult> {
  const startedAt = Date.now();
  const apiKey = getDeepSeekApiKey();
  const baseUrl = getDeepSeekBaseUrl();
  const model = getModel();

  logInfo("agent", "deepseek generate start", {
    messageId: input.messageId,
    sender: input.sender,
    pushName: input.pushName,
    model,
    baseUrl,
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

  const systemInstruction = await buildGrabbitSystemInstruction();

  // Assemble message history
  const messages: DeepSeekChatMessage[] = [
    { role: "system", content: systemInstruction },
  ];

  try {
    const { loadTranscript, formatTranscriptMessagesForModel } = await import("./transcript.ts");
    const transcript = await loadTranscript(input.sender);
    const recentEntries = transcript.entries.slice(-12);
    const formattedHistory = formatTranscriptMessagesForModel(recentEntries);
    messages.push(...formattedHistory);
  } catch (error) {
    logWarn("agent", "failed to load transcript for history", formatError(error));
  }

  // Current turn with contextual note
  const currentUserContent = `${contextNote}\n\nCustomer message:\n${input.text}`;
  messages.push({ role: "user", content: currentUserContent });

  let bookingFailure: BookingFailureDetails | null = null;
  let bookingSucceeded = false;
  let lastSuccessfulTrackingUrl: string | null = null;
  let responseId: string | undefined;
  let finalAssistantText = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    logInfo("agent", "deepseek round start", {
      messageId: input.messageId,
      round,
      messagesCount: messages.length,
    });

    let completion: DeepSeekChatCompletionResponse;
    try {
      completion = await callDeepSeekChat({
        apiKey,
        baseUrl,
        model,
        messages,
        tools: DEEPSEEK_AGENT_TOOLS,
      });
    } catch (error) {
      logError("agent", "deepseek completion failed", error);
      console.error("[agent] deepseek completion detail", {
        messageId: input.messageId,
        round,
        ...formatError(error),
      });
      throw error;
    }

    responseId = completion.id;
    const choice = completion.choices?.[0];
    if (!choice) {
      logWarn("agent", "deepseek empty choices", { messageId: input.messageId });
      break;
    }

    const message = choice.message;
    const toolCalls = message.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      // No further tool calls: this is the final assistant response
      finalAssistantText = message.content || "";
      break;
    }

    // Append assistant's tool-calling message
    messages.push({
      role: "assistant",
      content: message.content ?? null,
      tool_calls: toolCalls,
    });

    logInfo("agent", "deepseek tool calls requested", {
      messageId: input.messageId,
      round,
      tools: toolCalls.map((tc) => ({
        name: tc.function.name,
        argsPreview: tc.function.arguments.slice(0, 200),
      })),
    });

    for (const toolCall of toolCalls) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
      } catch (parseErr) {
        logWarn("agent", "failed to parse tool arguments JSON", {
          tool: toolCall.function.name,
          args: toolCall.function.arguments,
          err: formatError(parseErr),
        });
      }

      const result = await executeAgentTool({
        name: toolCall.function.name,
        toolArguments: parsedArgs,
        senderPhone: input.sender,
        pushName: input.pushName,
        messageId: input.messageId,
      });

      const ok = Boolean((result as { ok?: boolean }).ok);
      logInfo("agent", "deepseek tool executed", {
        messageId: input.messageId,
        tool: toolCall.function.name,
        ok,
        preview: JSON.stringify(result).slice(0, 300),
      });

      if (toolCall.function.name === "book_kilo_delivery") {
        if (ok) {
          bookingSucceeded = true;
        } else {
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
          const code =
            result &&
            typeof result === "object" &&
            "code" in result &&
            typeof (result as { code?: unknown }).code === "string"
              ? (result as { code: string }).code
              : undefined;
          bookingFailure = { error, fieldErrors, code };
        }
      }

      if (
        (toolCall.function.name === "schedule_trip_or_delivery" ||
          toolCall.function.name === "book_kilo_delivery") &&
        ok
      ) {
        bookingSucceeded = true;
        if (result && typeof result === "object" && "trackingUrl" in result && (result as any).trackingUrl) {
          lastSuccessfulTrackingUrl = String((result as any).trackingUrl);
        }
      }

      // Add tool output to conversation
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  let text = sanitizeWhatsAppText(finalAssistantText);

  // If a booking succeeded but the assistant omitted the live tracking URL, append it!
  if (bookingSucceeded && lastSuccessfulTrackingUrl && !text.includes(lastSuccessfulTrackingUrl) && !text.includes("delivery.grabbit-express.com")) {
    text = `${text}\n\n🔴 *Live Tracking Link:*\n${lastSuccessfulTrackingUrl}`;
  }

  // Safety overrides & fallback protections
  if (bookingFailure) {
    const safeText = customerReplyForFailedBooking(bookingFailure);
    logWarn("agent", "overriding reply after failed booking", {
      messageId: input.messageId,
      bookingFailure,
      modelReplyPreview: text.slice(0, 160),
      safeReplyPreview: safeText.slice(0, 160),
    });
    text = safeText;
  } else if (
    !bookingSucceeded &&
    text &&
    /\b(heading your way|rider has been assigned and is heading|your trip has been confirmed|your order has been confirmed)\b/i.test(text)
  ) {
    logWarn("agent", "stripping premature confirmation claim", {
      messageId: input.messageId,
      modelReplyPreview: text.slice(0, 160),
    });
    text = text
      .replace(/✅\s*Dearest customer,?\s*your trip has been confirmed!?/gi, "")
      .replace(/Our rider has been assigned and is heading your way\.?/gi, "")
      .replace(/✅\s*Your order has been confirmed!?/gi, "")
      .trim();
    if (!text) {
      text = "Got your request! Let me confirm your details and notify the on-duty rider.";
    }
  } else if (!text) {
    logWarn("agent", "empty deepseek output; using fallback reply", {
      messageId: input.messageId,
    });
    text =
      "Got you. Mind sending that again in a short line so I can help right away? 🙂";
  }

  logInfo("agent", "deepseek generate done", {
    messageId: input.messageId,
    ms: Date.now() - startedAt,
    model,
    replyPreview: text.slice(0, 160),
  });

  return {
    text,
    interactionId: responseId,
    model,
  };
}

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
  getDeepSeekToolsForRole,
} from "./tools.ts";
import { loadTranscript } from "./transcript.ts";

const DEFAULT_MODEL = "deepseek-flash";
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const MAX_TOOL_ROUNDS = 4;
/**
 * Hard time budget for the whole agent turn. The Vercel function gets 60s;
 * bailing at 45s guarantees the reply is actually sent instead of the lambda
 * dying mid-turn after side effects (bookings) already landed.
 */
const AGENT_TURN_BUDGET_MS = 45_000;
const DEEPSEEK_MAX_ATTEMPTS = 3;
const DEEPSEEK_RETRY_BASE_MS = 1_500;
/** Statuses worth retrying: rate limit, server errors, gateway timeouts. */
const RETRYABLE_HTTP = new Set([408, 409, 429, 500, 502, 503, 504]);

export interface GenerateAgentReplyInput {
  sender: string;
  text: string;
  messageId: string;
  pushName?: string;
  /** Optional pre-loaded transcript — per-turn single-flight when the caller already fetched it. */
  transcript?: import("./transcript.ts").ChatTranscript;
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
      reasoning_content?: string | null;
      tool_calls?: DeepSeekToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    temperature: 0.7,
  };

  if (args.tools && args.tools.length > 0) {
    body.tools = args.tools;
    body.tool_choice = "auto";
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= DEEPSEEK_MAX_ATTEMPTS; attempt += 1) {
    try {
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
        const error = new Error(
          `DeepSeek API error HTTP ${response.status} (${response.statusText}): ${errorText}`,
        );
        if (!RETRYABLE_HTTP.has(response.status) || attempt === DEEPSEEK_MAX_ATTEMPTS) {
          throw error;
        }
        lastError = error;
        logWarn("agent", "deepseek transient error; retrying", {
          attempt,
          status: response.status,
        });
        await sleep(DEEPSEEK_RETRY_BASE_MS * attempt);
        continue;
      }

      return (await response.json()) as DeepSeekChatCompletionResponse;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      // HTTP errors thrown above already decided retryability; only network
      // failures (fetch rejects) land here and are worth a retry.
      if (err.message.startsWith("DeepSeek API error HTTP") || attempt === DEEPSEEK_MAX_ATTEMPTS) {
        throw err;
      }
      lastError = err;
      logWarn("agent", "deepseek network failure; retrying", {
        attempt,
        ...formatError(err),
      });
      await sleep(DEEPSEEK_RETRY_BASE_MS * attempt);
    }
  }
  throw lastError ?? new Error("DeepSeek request failed without a response");
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
      transcript: input.transcript,
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

  const { isAuthorizedRiderOrAdmin } = await import("../riders/config.ts");
  const callerAuth = isAuthorizedRiderOrAdmin(input.sender);

  // Phase 4: role-scoped tool surface — customers/riders never see admin
  // tools, riders never see booking tools. Fewer tokens per round, and the
  // model cannot hallucinate a tool it was never shown.
  const roleTools = getDeepSeekToolsForRole(
    callerAuth.isAdmin ? "admin" : callerAuth.rider ? "rider" : "customer",
  );

  const systemInstruction = await buildGrabbitSystemInstruction({ isAdmin: callerAuth.isAdmin });

  const senderRoleHeader = callerAuth.isAdmin
    ? "Admin dispatch instruction (You are speaking directly to DISPATCH ADMIN. If asked to text/message/notify a customer, YOU MUST CALL the `admin_reply_to_customer` tool — NEVER output the customer message directly in this chat):"
    : callerAuth.rider
      ? `Fleet rider message (${callerAuth.rider.name}):`
      : "Customer message:";

  const fullSystemInstruction = contextNote
    ? `${systemInstruction}\n\n--- OPERATIONAL CONTEXT ---\n${contextNote}\n\n${senderRoleHeader}`
    : `${systemInstruction}\n\n${senderRoleHeader}`;

  // Assemble message history (reuse the caller's transcript when provided —
  // per-turn single-flight instead of a second read of the same document)
  const messages: DeepSeekChatMessage[] = [
    { role: "system", content: fullSystemInstruction },
  ];

  try {
    const { formatTranscriptMessagesForModel } = await import("./transcript.ts");
    const transcript = input.transcript ?? (await loadTranscript(input.sender));
    const recentEntries = transcript.entries.slice(-20);
    const formattedHistory = formatTranscriptMessagesForModel(recentEntries, { maxHoursOld: 36 });
    messages.push(...formattedHistory);
  } catch (error) {
    logWarn("agent", "failed to load transcript for history", formatError(error));
  }

  // Current turn with strictly pure user input
  messages.push({ role: "user", content: input.text });

  let bookingFailure: BookingFailureDetails | null = null;
  let bookingSucceeded = false;
  let lastSuccessfulTrackingUrl: string | null = null;
  let responseId: string | undefined;
  let finalAssistantText = "";
  const calledTools = new Set<string>();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    if (Date.now() - startedAt > AGENT_TURN_BUDGET_MS) {
      logWarn("agent", "agent turn budget exhausted; forcing final response", {
        messageId: input.messageId,
        round,
        elapsedMs: Date.now() - startedAt,
        budgetMs: AGENT_TURN_BUDGET_MS,
      });
      break;
    }

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
        tools: roleTools,
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
    if (completion.usage) {
      const { recordAgentCallUsage } = await import("../metrics/recorder.ts");
      void recordAgentCallUsage({
        promptTokens: completion.usage.prompt_tokens ?? 0,
        completionTokens: completion.usage.completion_tokens ?? 0,
        promptCacheHitTokens: completion.usage.prompt_cache_hit_tokens,
        promptCacheMissTokens: completion.usage.prompt_cache_miss_tokens,
      });
    }
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
      calledTools.add(toolCall.function.name);
      let parsedArgs: Record<string, unknown> = {};
      let argsMalformed = false;
      try {
        parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
      } catch (parseErr) {
        argsMalformed = true;
        logWarn("agent", "failed to parse tool arguments JSON; feeding error back to model", {
          tool: toolCall.function.name,
          args: toolCall.function.arguments,
          err: formatError(parseErr),
        });
      }

      // Structured tool hygiene: never execute a tool with silently-emptied
      // arguments — that produces confusing "missing fields" tool results.
      // Instead return a tool error so the model re-emits valid JSON.
      if (argsMalformed) {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            ok: false,
            error: "Tool call arguments were not valid JSON. Re-issue the tool call with a well-formed JSON object matching the schema.",
          }),
        });
        continue;
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
        if (result && typeof result === "object" && "trackingUrl" in result) {
          const maybeTrackingUrl = (result as { trackingUrl?: unknown }).trackingUrl;
          if (typeof maybeTrackingUrl === "string" && maybeTrackingUrl) {
            lastSuccessfulTrackingUrl = maybeTrackingUrl;
          }
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

  if (!bookingSucceeded && text.includes("delivery.grabbit-express.com/track/")) {
    const { fabricatedTrackingLinks, fabricatedTrackingReply } = await import("./booking-guard.ts");
    const forged = fabricatedTrackingLinks(text, JSON.stringify(messages));
    if (forged.length > 0) {
      logWarn("agent", "overriding reply with fabricated tracking link", {
        messageId: input.messageId,
        forgedLinks: forged,
        modelReplyPreview: text.slice(0, 160),
      });
      text = fabricatedTrackingReply();
    }
  }

  // If a booking succeeded but the assistant omitted the live tracking URL, append it!
  if (bookingSucceeded && lastSuccessfulTrackingUrl && !text.includes(lastSuccessfulTrackingUrl) && !text.includes("delivery.grabbit-express.com")) {
    text = `${text}\n\n🔴 *Live Tracking Link:*\n${lastSuccessfulTrackingUrl}`;
  }

  // Safety overrides & fallback protections
  if (bookingFailure) {
    const isPaymentOrAddReceiptTurn = calledTools.has("confirm_payment_receipt") || calledTools.has("add_item_to_active_booking");
    const hasActiveBookingInContext = contextNote.includes("CUSTOMER'S UPCOMING & ADVANCE BOOKINGS");

    if (isPaymentOrAddReceiptTurn || (hasActiveBookingInContext && !input.text.toLowerCase().includes("book") && !input.text.toLowerCase().includes("ride"))) {
      logWarn("agent", "suppressing booking failure override since customer has active booking or payment/addition action succeeded", {
        messageId: input.messageId,
        bookingFailure,
        calledTools: Array.from(calledTools),
      });
    } else {
      const safeText = customerReplyForFailedBooking(bookingFailure);
      if (callerAuth.isAdmin) {
        text = `⚠️ Booking could not be created: ${safeText} (${bookingFailure.error || "validation error"})`;
      } else {
        logWarn("agent", "overriding reply after failed booking", {
          messageId: input.messageId,
          bookingFailure,
          modelReplyPreview: text.slice(0, 160),
          safeReplyPreview: safeText.slice(0, 160),
        });
        text = safeText;
      }
    }
  } else if (callerAuth.isAdmin) {
    const { enforceAdminActionInvariants } = await import("./action-gateway.ts");
    const gatewayRes = await enforceAdminActionInvariants({
      senderPhone: input.sender,
      isAdmin: true,
      incomingText: input.text,
      assistantText: text,
      calledTools,
      messageId: input.messageId,
    });
    text = gatewayRes.text;
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
  }

  // Repetition guard on customer policy and question loops
  if (!callerAuth.isAdmin && !callerAuth.rider && text) {
    const { isRepetitivePolicyLoop, isRepetitiveQuestionLoop } = await import("./booking-guard.ts");
    const repetitiveFix = isRepetitivePolicyLoop(text, messages as any) || isRepetitiveQuestionLoop(text, messages as any);
    if (repetitiveFix) {
      logInfo("agent", "suppressing repetitive loop for customer", {
        messageId: input.messageId,
      });
      text = repetitiveFix;
    }
  }

  if (!text) {
    if (calledTools.size > 0) {
      logInfo("agent", "synthesized response after successful tool execution with empty assistant text", {
        messageId: input.messageId,
        calledTools: Array.from(calledTools),
      });
      if (callerAuth.isAdmin) {
        text = "✅ Done, Admin! Processed your requested dispatch actions and notified the relevant parties.";
      } else {
        text = "Got your request! Your details have been processed with our dispatch team. 👍";
      }
    } else if (callerAuth.isAdmin) {
      text = "Hello Admin! 👨‍💼 Dispatch system is online. Could you specify which booking, rider, or customer action you'd like to perform?";
    } else {
      logWarn("agent", "empty deepseek output; using fallback reply", {
        messageId: input.messageId,
      });
      text =
        "Got you. Mind sending that again in a short line so I can help right away? 🙂";
    }
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

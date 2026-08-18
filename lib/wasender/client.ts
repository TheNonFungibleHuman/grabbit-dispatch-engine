const WASENDER_API_BASE =
  process.env.WASENDER_API_BASE_URL ?? "https://www.wasenderapi.com/api";

export interface SendTextMessageInput {
  to: string;
  text: string;
}

export interface WasenderSendResult {
  success: boolean;
  message?: string;
  data?: unknown;
}

let sendQueue: Promise<unknown> = Promise.resolve();
let lastSendTime = 0;
const MIN_SEND_INTERVAL_MS = 5200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeSendWithRetry(
  input: SendTextMessageInput,
  maxAttempts = 3,
): Promise<WasenderSendResult> {
  const apiKey = process.env.WASENDER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("WASENDER_API_KEY is not configured");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Respect inter-message spacing
    const now = Date.now();
    const timeSinceLast = now - lastSendTime;
    if (timeSinceLast < MIN_SEND_INTERVAL_MS) {
      await sleep(MIN_SEND_INTERVAL_MS - timeSinceLast);
    }

    const response = await fetch(`${WASENDER_API_BASE}/send-message`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: input.to,
        text: input.text,
      }),
    });

    const payload = (await response.json().catch(() => null)) as {
      success?: boolean;
      message?: string;
      data?: unknown;
    } | null;

    if (response.ok) {
      lastSendTime = Date.now();
      return {
        success: payload?.success ?? true,
        message: payload?.message,
        data: payload?.data,
      };
    }

    const errorMessage =
      payload?.message ||
      `Wasender send-message failed with status ${response.status}`;
    const isRateLimited =
      response.status === 429 ||
      /5 seconds|account protection|rate limit|too many requests/i.test(
        errorMessage,
      );

    if (isRateLimited && attempt < maxAttempts) {
      console.warn(
        `[wasender] rate limit hit (attempt ${attempt}/${maxAttempts}), waiting 5.5s...`,
        {
          to: input.to,
          errorMessage,
        },
      );
      await sleep(5500);
      continue;
    }

    throw new Error(errorMessage);
  }

  throw new Error("Wasender send failed after retry attempts");
}

/**
 * Send a text message via the connected Wasender session API key.
 * Serializes sends and handles 5s account protection backoff.
 * @see https://wasenderapi.com/api-docs
 */
export function sendTextMessage(
  input: SendTextMessageInput,
): Promise<WasenderSendResult> {
  const currentSend = sendQueue.then(() => executeSendWithRetry(input));
  sendQueue = currentSend.then(
    () => {},
    () => {},
  );
  return currentSend;
}

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

/**
 * Send a text message via the connected Wasender session API key.
 * @see https://wasenderapi.com/api-docs
 */
export async function sendTextMessage(
  input: SendTextMessageInput,
): Promise<WasenderSendResult> {
  const apiKey = process.env.WASENDER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("WASENDER_API_KEY is not configured");
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

  if (!response.ok) {
    throw new Error(
      payload?.message ??
        `Wasender send-message failed with status ${response.status}`,
    );
  }

  return {
    success: payload?.success ?? true,
    message: payload?.message,
    data: payload?.data,
  };
}

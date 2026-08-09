import { uploadPackageImage } from "./blob";

const WASENDER_API_BASE =
  process.env.WASENDER_API_BASE_URL ?? "https://www.wasenderapi.com/api";

interface DecryptMediaResponse {
  success?: boolean;
  publicUrl?: string;
  public_url?: string;
}

function getWasenderApiKey(): string {
  const key = process.env.WASENDER_API_KEY?.trim();
  if (!key) {
    throw new Error("WASENDER_API_KEY is not configured");
  }
  return key;
}

function extractImageMessage(
  message: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!message || typeof message !== "object") return null;
  const image = message.imageMessage;
  if (image && typeof image === "object") {
    return image as Record<string, unknown>;
  }
  return null;
}

/**
 * Decrypt Wasender image → download temp URL → store on Vercel Blob (durable https).
 */
export async function persistIncomingPackageImage(args: {
  senderPhone: string;
  messageId: string;
  message?: Record<string, unknown>;
}): Promise<string | null> {
  const imageMessage = extractImageMessage(args.message);
  if (!imageMessage) {
    return null;
  }

  const decryptResponse = await fetch(`${WASENDER_API_BASE}/decrypt-media`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getWasenderApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        messages: {
          key: { id: args.messageId },
          message: { imageMessage },
        },
      },
    }),
  });

  const decryptPayload = (await decryptResponse.json().catch(() => null)) as
    | DecryptMediaResponse
    | null;

  if (!decryptResponse.ok) {
    throw new Error(
      (decryptPayload && "message" in decryptPayload
        ? String((decryptPayload as { message?: string }).message)
        : null) ||
        `Wasender decrypt-media failed (${decryptResponse.status})`,
    );
  }

  const tempUrl = decryptPayload?.publicUrl ?? decryptPayload?.public_url;
  if (!tempUrl) {
    throw new Error("Wasender decrypt-media returned no publicUrl");
  }

  const mediaResponse = await fetch(tempUrl);
  if (!mediaResponse.ok) {
    throw new Error(`Failed to download decrypted media (${mediaResponse.status})`);
  }

  const contentType =
    mediaResponse.headers.get("content-type") ||
    (typeof imageMessage.mimetype === "string"
      ? imageMessage.mimetype
      : "image/jpeg");
  const bytes = await mediaResponse.arrayBuffer();

  return uploadPackageImage({
    senderPhone: args.senderPhone,
    messageId: args.messageId,
    bytes,
    contentType,
  });
}

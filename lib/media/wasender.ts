import { uploadPackageImage } from "./blob.ts";

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

function extractDocumentMessage(
  message: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!message || typeof message !== "object") return null;
  const doc =
    message.documentMessage ||
    (message.documentWithCaptionMessage as Record<string, unknown> | undefined)?.message &&
      ((message.documentWithCaptionMessage as Record<string, unknown>).message as Record<string, unknown>)?.documentMessage;
  if (doc && typeof doc === "object") {
    return doc as Record<string, unknown>;
  }
  return null;
}

/**
 * Decrypt Wasender document (PDF) → download temp URL → store on durable storage and return bytes.
 */
export async function persistIncomingDocument(args: {
  senderPhone: string;
  messageId: string;
  message?: Record<string, unknown>;
}): Promise<{ url: string; buffer: Buffer; fileName?: string } | null> {
  const documentMessage = extractDocumentMessage(args.message);
  if (!documentMessage) {
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
          message: { documentMessage },
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
        `Wasender decrypt-media for document failed (${decryptResponse.status})`,
    );
  }

  const tempUrl = decryptPayload?.publicUrl ?? decryptPayload?.public_url;
  if (!tempUrl) {
    throw new Error("Wasender decrypt-media returned no publicUrl for document");
  }

  const mediaResponse = await fetch(tempUrl);
  if (!mediaResponse.ok) {
    throw new Error(`Failed to download decrypted document (${mediaResponse.status})`);
  }

  const contentType =
    mediaResponse.headers.get("content-type") ||
    (typeof documentMessage.mimetype === "string"
      ? documentMessage.mimetype
      : "application/pdf");
  const arrayBuf = await mediaResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);

  const url = await uploadPackageImage({
    senderPhone: args.senderPhone,
    messageId: args.messageId,
    bytes: buffer,
    contentType,
  });

  return {
    url,
    buffer,
    fileName: typeof documentMessage.fileName === "string" ? documentMessage.fileName : undefined,
  };
}

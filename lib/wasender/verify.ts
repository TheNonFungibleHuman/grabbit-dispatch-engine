import { timingSafeEqual } from "node:crypto";

/**
 * Wasender sends the webhook secret in the `X-Webhook-Signature` header
 * (plain equality — not an HMAC of the body).
 * @see https://wasenderapi.com/api-docs/webhooks/webhook-setup
 */
export function verifyWasenderSignature(
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) {
    return false;
  }

  const provided = Buffer.from(signatureHeader);
  const expected = Buffer.from(secret);

  if (provided.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(provided, expected);
}

export function getWasenderWebhookSecret(): string {
  const secret = process.env.WASENDER_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error("WASENDER_WEBHOOK_SECRET is not configured");
  }
  return secret;
}

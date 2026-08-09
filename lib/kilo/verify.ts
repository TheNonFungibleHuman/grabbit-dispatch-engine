import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_SKEW_SECONDS = 300;

/**
 * Verify Kilo webhook signature header: `t=<unix>,v1=<hex>`
 * HMAC-SHA256 of `${t}.${rawBody}` with the `whsec_...` secret.
 */
export function verifyKiloSignature(
  secret: string,
  rawBody: string,
  header: string | null,
): boolean {
  if (!secret || !header || !rawBody) {
    return false;
  }

  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const [key, ...rest] = part.trim().split("=");
      return [key, rest.join("=")];
    }),
  );

  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!Number.isFinite(timestamp) || !signature) {
    return false;
  }

  if (Math.abs(Date.now() / 1000 - timestamp) > MAX_SKEW_SECONDS) {
    return false;
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  try {
    const expectedBuf = Buffer.from(expected, "utf8");
    const providedBuf = Buffer.from(signature, "utf8");
    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }
    return timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

export function getKiloWebhookSecret(): string {
  const secret = process.env.KILO_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error("KILO_WEBHOOK_SECRET is not configured");
  }
  return secret;
}

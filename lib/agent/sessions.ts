/**
 * Best-effort conversation continuity for serverless.
 * Keys: normalized phone; values: last Gemini interaction id.
 * Lost on cold start — acceptable for v1; swap for Redis/KV later if needed.
 */
const previousInteractionBySender = new Map<string, string>();

export function getPreviousInteractionId(sender: string): string | undefined {
  return previousInteractionBySender.get(normalizeSender(sender));
}

export function setPreviousInteractionId(
  sender: string,
  interactionId: string,
): void {
  previousInteractionBySender.set(normalizeSender(sender), interactionId);
}

export function clearPreviousInteractionId(sender: string): void {
  previousInteractionBySender.delete(normalizeSender(sender));
}

function normalizeSender(sender: string): string {
  return sender.replace(/\D/g, "");
}

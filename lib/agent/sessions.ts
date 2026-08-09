/**
 * Conversation continuity is scoped per customer phone number.
 * Each sender maps to their own Gemini previous_interaction_id only,
 * so Customer A and Customer B never share history.
 *
 * Note: process memory can reset on cold starts. Gemini still stores the
 * interaction chain server-side once an id exists for that sender.
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

export function normalizeSender(sender: string): string {
  return sender.replace(/\D/g, "");
}

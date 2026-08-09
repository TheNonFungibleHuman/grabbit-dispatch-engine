/**
 * Normalize model output for WhatsApp text messages.
 * WhatsApp uses *bold*, _italic_, ~strike~, ```monospace```
 * (not Markdown **bold**).
 */
export function sanitizeWhatsAppText(raw: string): string {
  let text = raw.trim();

  // Convert Markdown bold/italic to WhatsApp markers.
  text = text.replace(/\*\*(.+?)\*\*/g, "*$1*");
  text = text.replace(/__(.+?)__/g, "_$1_");
  text = text.replace(/~~(.+?)~~/g, "~$1~");

  // Remove leftover Markdown artifacts that look messy in chat.
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "• ");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // Prefer clean punctuation over AI-ish dashes.
  text = text.replace(/\s*—\s*/g, ", ");
  text = text.replace(/\s*–\s*/g, ", ");
  text = text.replace(/\s+--\s+/g, ", ");
  text = text.replace(/-{2,}/g, "-");

  // Tighten whitespace / blank lines for cleaner chats.
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]{2,}/g, " ");

  return text.trim();
}

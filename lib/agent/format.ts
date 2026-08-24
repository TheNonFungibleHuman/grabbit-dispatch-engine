/**
 * Normalize model output for WhatsApp text messages.
 * WhatsApp uses *bold*, _italic_, ~strike~, ```monospace```
 * (not Markdown **bold**).
 */
export function sanitizeWhatsAppText(raw: string): string {
  let text = raw.trim();

  // Strip leaked role/time tags like "[Today 4:14 PM] Support:" or "Support:"
  text = text.replace(/^\[(?:Today|\d{4}-\d{2}-\d{2})[^\]]*\]\s*(?:Support|Customer|Agent|Grabbit|Grabbit Express)?:\s*/i, "");
  text = text.replace(/^(?:Support|Agent|Grabbit Express|Grabbit):\s*/i, "");

  // Strip leaked internal reasoning / chain-of-thought prefixes
  text = text.replace(/^(?:(?:Thinking|Thought|Reasoning|Internal Note|Plan):\s*[\s\S]*?\n+)/i, "");
  text = text.replace(/^(?:Let me (?:clarify|check|confirm|ask|look|see|tell|verify|proceed).*?\n+)/i, "");
  text = text.replace(/^(?:I (?:don't|do not|need to|should|will|must|have to) (?:have access|clarify|check|confirm|ask|look|see|verify).*?\n+)/i, "");

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

  // Never send love / heart-style emoji (client preference).
  text = text.replace(/[\u{1F90D}\u{1F9E1}\u{1F49B}\u{1F49A}\u{1F499}\u{1F49C}\u{1F5A4}\u{1F90E}\u{2764}\u{FE0F}?\u{1F494}\u{1F495}\u{1F496}\u{1F497}\u{1F498}\u{1F49D}\u{1F49E}\u{1F49F}\u{2763}\u{FE0F}?]/gu, "");
  text = text.replace(/💚/g, "");
  text = text.replace(/❤️‍🔥/g, "");
  text = text.replace(/❤️‍🩹/g, "");
  text = text.replace(/♥️/g, "");
  text = text.replace(/❤/g, "");

  // Tighten whitespace / blank lines for cleaner chats.
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]{2,}/g, " ");
  text = text.replace(/[ \t]+([!?.,])/g, "$1");

  return text.trim();
}

/** Short customer acknowledgements that should not restart intake.
 * Do NOT include confirmation words like yes/sure — those are used mid-order.
 */
export function isShortAcknowledgement(text: string): boolean {
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/[!?.,👋🙏👍👌😊😅]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > 40) return false;
  return (
    /^(nice|ok|okay|k|kk|cool|great|perfect|thanks|thank you|thank u|thx|ty|noted|cheers|appreciate it|much appreciated)$/i.test(
      cleaned,
    ) || /^(thanks|thank you|thx|ty)\b/.test(cleaned)
  );
}

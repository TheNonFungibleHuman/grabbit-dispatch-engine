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

  // 1. If there is a clear customer-facing greeting preceded by internal thinking, slice to the greeting
  const greetingMatch = text.match(/(?:[\n.!?]|^)\s*(?:(?:\*|\b)(?:hello|hi|hey|good morning|good afternoon|good evening|thanks|greetings|dear|welcome|trip confirmed|order confirmed|booking confirmed)\b[\s\S]*)$/i);
  if (greetingMatch && greetingMatch.index !== undefined && greetingMatch.index > 0) {
    const beforeGreeting = text.slice(0, greetingMatch.index).trim();
    if (/^(?:actually|i'll|i will|let me|the customer|the user|customer wants|we need to|first,|thinking|thought|reasoning|internal note|plan|i need to|i should|i must|hmm|wait,|the intake|trip fare)/i.test(beforeGreeting)) {
      const matchText = greetingMatch[0];
      text = matchText.replace(/^[\n.!?\s]+/, "").trim();
    }
  }

  // 2. Strip standard thought/reasoning prefixes
  text = text.replace(/^(?:(?:Thinking|Thought|Reasoning|Internal Note|Plan):\s*[\s\S]*?\n+)/i, "");
  text = text.replace(/^(?:(?:I'll|I will|Let me|The customer|The user|We need to|I need to|I should|I must|Actually|Hmm|Wait,|The intake|Trip fare)\s+[\s\S]*?\n\n+)/i, "");
  text = text.replace(/^(?:(?:Actually|Hmm|Wait,|The intake|Trip fare).*?\n+)/i, "");
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
    ) ||
    /^(thanks|thank you|thx|ty)\b/i.test(cleaned) ||
    /^(?:ok|okay)\s+(?:thanks|thank you|thx|ty|noted)\b/i.test(cleaned)
  );
}

/**
 * Detects general opening greetings with no specific service, location, or destination details.
 * Used to immediately present the 1-tap interactive welcome poll on first contact.
 */
export function isBareGreeting(text: string): boolean {
  if (!text) return false;
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/[!?.,👋✨⚡😊🛵☀🙏]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned || cleaned.length > 50) return false;

  // Specific booking/errand/food keywords mean the customer is already stating their intent
  const intentKeywords = [
    "ride", "trip", "delivery", "order", "book", "booking", "package",
    "errand", "pickup", "dropoff", "food", "pizza", "kfc", "pan asian",
    "mahogany", "alche", "grand baie", "pamplemousses", "price", "fare",
    "cost", "menu", "decathlon", "super u", "ready", "outside", "car"
  ];
  if (intentKeywords.some((kw) => cleaned.includes(kw))) {
    return false;
  }

  const commonGreetings = new Set([
    "hello", "hi", "hey", "good morning", "good afternoon", "good evening",
    "grabbit", "grabbit express", "start", "bonjour", "bonsoir", "salut",
    "ola", "yo", "morning", "afternoon", "evening"
  ]);

  if (commonGreetings.has(cleaned)) {
    return true;
  }

  const tokens = cleaned.split(/\s+/);
  if (tokens.length <= 3 && tokens.some((t) => commonGreetings.has(t))) {
    return true;
  }

  return false;
}

/**
 * Sanitizes a customer pushName for natural WhatsApp greetings.
 * Rejects internet handles, usernames with digits/underscores (e.g. "jwangirl07"),
 * and extracts a clean, title-cased first name.
 */
export function cleanCustomerGreetingName(pushName?: string): string | undefined {
  if (!pushName || !pushName.trim()) return undefined;

  const raw = pushName.trim();

  // 1. Reject handles containing digits, underscores, or handle symbols (e.g. "jwangirl07", "@john", "rider_01")
  if (/\d/.test(raw) || /[_@\\/]/.test(raw) || raw.startsWith("@")) {
    return undefined;
  }

  // 2. Strip emojis and pictographic symbols
  let cleaned = raw
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .trim();

  // 3. Strip surrounding non-alphanumeric decoration (e.g. "🌸 Sadia 🌸" -> "Sadia")
  cleaned = cleaned.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").trim();

  // 4. Strip common prefixes like "Emp."
  cleaned = cleaned.replace(/^(?:emp|dr|mr|mrs|ms)[.\s]+/i, "").trim();

  // 5. Take first name token
  const first = cleaned.split(/\s+/)[0];
  if (!first || first.length < 2 || first.length > 25) {
    return undefined;
  }

  // 6. Ensure token is purely alphabetical
  if (!/^[a-zA-ZÀ-ÿ'-]+$/.test(first)) {
    return undefined;
  }

  // 7. Normalize casing: Title Case (e.g. "felicia" -> "Felicia", "SADIA" -> "Sadia")
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}


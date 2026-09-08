import type { TranscriptEntry } from "../agent/transcript.ts";
import { parseTimeToMinutes, formatMinutesToTime } from "../time.ts";

export interface ExtractedIntakeState {
  serviceKind?: "trip" | "delivery" | "errand";
  pickup?: string;
  dropoff?: string;
  time?: string;
  paymentMethod?: "cash" | "transfer";
  packageDescription?: string;
  summaryNote?: string;
}

interface LocationDefinition {
  pattern: RegExp;
  normalizedName: string;
  isShop?: boolean;
  isAlche?: boolean;
}

const LOCATIONS: LocationDefinition[] = [
  // Shops / Food
  { pattern: /\b(?:pappagallo|pappagalo)\b/i, normalizedName: "Pappagallo, Mahogany", isShop: true },
  { pattern: /\b(?:kfc)\b/i, normalizedName: "KFC, Mahogany", isShop: true },
  { pattern: /\b(?:pan\s*asian)\b/i, normalizedName: "Pan Asian, Mahogany", isShop: true },
  { pattern: /\b(?:intermart(?:\s+mahogany)?)\b/i, normalizedName: "Intermart, Mahogany", isShop: true },
  { pattern: /\b(?:eaters(?:\s+mahogany)?)\b/i, normalizedName: "Eaters, Mahogany", isShop: true },

  // ALCHE Specific Landmarks
  { pattern: /\b(?:alche\s+main\s+gate|main\s+gate)\b/i, normalizedName: "ALCHE Main Gate", isAlche: true },
  { pattern: /\b(?:alche\s+cafeteria|cafeteria)\b/i, normalizedName: "ALCHE Cafeteria", isAlche: true },
  { pattern: /\b(?:alche\s+library|library)\b/i, normalizedName: "ALCHE Library", isAlche: true },
  { pattern: /\b(?:learning\s+commons)\b/i, normalizedName: "ALCHE Learning Commons", isAlche: true },

  // ALCHE Hostels
  { pattern: /\b(?:songhai|songai)\b/i, normalizedName: "Songhai Residence, ALCHE", isAlche: true },
  { pattern: /\b(?:aksum|axum)\b/i, normalizedName: "Aksum Residence, ALCHE", isAlche: true },
  { pattern: /\b(?:timbuktu)\b/i, normalizedName: "Timbuktu Residence, ALCHE", isAlche: true },
  { pattern: /\b(?:kilwa)\b/i, normalizedName: "Kilwa Residence, ALCHE", isAlche: true },
  { pattern: /\b(?:great\s+zimbabwe|zimbabwe)\b/i, normalizedName: "Great Zimbabwe Residence, ALCHE", isAlche: true },

  // General Campus
  { pattern: /\b(?:alche\s+campus|alche|campus)\b/i, normalizedName: "ALCHE Campus", isAlche: true },

  // External Destination Landmarks
  { pattern: /\b(?:mahogany(?:\s+shopping)?(?:\s+promenade)?)\b/i, normalizedName: "Mahogany Promenade" },
  { pattern: /\b(?:super\s*u(?:\s+grand\s+baie)?)\b/i, normalizedName: "Super U, Grand Baie" },
  { pattern: /\b(?:grand\s+baie|grand\s+bay)\b/i, normalizedName: "Grand Baie" },
  { pattern: /\b(?:ssrn(?:\s+hospital)?)\b/i, normalizedName: "SSRN Hospital" },
  { pattern: /\b(?:botanical\s+garden)\b/i, normalizedName: "Pamplemousses Botanical Garden" },
  { pattern: /\b(?:pamplemousses?)\b/i, normalizedName: "Pamplemousses" },
  { pattern: /\b(?:port\s+louis)\b/i, normalizedName: "Port Louis" },
];

interface LocationMatch {
  location: LocationDefinition;
  index: number;
  length: number;
  textBefore: string;
}

/**
 * Parses recent customer messages in the active conversation thread
 * to detect what booking parameters have already been provided.
 */
export function extractIntakeState(entries: TranscriptEntry[]): ExtractedIntakeState {
  const customerEntries = entries
    .filter((e) => e.role === "customer" && e.text && e.text.trim())
    .slice(-6); // analyze last 6 customer messages

  if (customerEntries.length === 0) {
    return {};
  }

  const combinedText = customerEntries.map((e) => e.text).join(" \n ");
  const textLower = combinedText.toLowerCase();

  const state: ExtractedIntakeState = {};

  // 1. Service Kind
  if (/\b(ride|trip|lift|cab|passenger|car|transport)\b/i.test(textLower)) {
    state.serviceKind = "trip";
  } else if (/\b(food|delivery|deliver|order|pizza|burger|groceries|kfc|pappagallo|intermart)\b/i.test(textLower)) {
    state.serviceKind = "delivery";
  } else if (/\b(errand|pick up|buy for me)\b/i.test(textLower)) {
    state.serviceKind = "errand";
  }

  // 2. Location matches
  const foundMatches: LocationMatch[] = [];
  for (const loc of LOCATIONS) {
    const match = loc.pattern.exec(combinedText);
    if (match) {
      foundMatches.push({
        location: loc,
        index: match.index,
        length: match[0].length,
        textBefore: combinedText.slice(Math.max(0, match.index - 35), match.index).toLowerCase(),
      });
    }
  }

  // Sort by match length descending so longer/specific names take precedence over substrings
  foundMatches.sort((a, b) => b.length - a.length);

  const nonOverlapping: LocationMatch[] = [];
  for (const m of foundMatches) {
    const overlaps = nonOverlapping.some((existing) => {
      const existingEnd = existing.index + existing.length;
      const mEnd = m.index + m.length;
      return Math.max(existing.index, m.index) < Math.min(existingEnd, mEnd);
    });
    if (!overlaps) {
      nonOverlapping.push(m);
    }
  }

  // Sort chronological order of appearance in conversation
  nonOverlapping.sort((a, b) => a.index - b.index);

  // Directional assignment based on immediate preposition context
  for (const m of nonOverlapping) {
    const trailingWords = m.textBefore.trim().split(/\s+/).slice(-2).join(" ");
    const isFrom = /\b(?:from|leaving|pickup(?:\s+at)?)\b/i.test(trailingWords);
    const isTo = /\b(?:to|heading|going|drop(?:\s+off)?(?:\s+at)?)\b/i.test(trailingWords);

    if (isFrom && !state.pickup) {
      state.pickup = m.location.normalizedName;
    } else if (isTo && !state.dropoff) {
      state.dropoff = m.location.normalizedName;
    }
  }


  // Fill in any unassigned locations
  for (const m of nonOverlapping) {
    const name = m.location.normalizedName;
    if (name === state.pickup || name === state.dropoff) continue;

    if (!state.pickup && m.location.isShop) {
      state.pickup = name;
    } else if (!state.dropoff) {
      state.dropoff = name;
    } else if (!state.pickup) {
      state.pickup = name;
    }
  }

  // 3. Time detection
  if (/\b(?:now|asap|right now|immediately|ready)\b/i.test(textLower)) {
    state.time = "Now / ASAP";
  } else {
    const timeRegex = /\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|\d{1,2}[:.]\d{2})\b/gi;
    const matches = Array.from(combinedText.matchAll(timeRegex));
    for (const m of matches) {
      const parsedMins = parseTimeToMinutes(m[1]);
      if (parsedMins !== null && parsedMins >= 0 && parsedMins < 1440) {
        state.time = formatMinutesToTime(parsedMins);
        break;
      }
    }
  }

  // 4. Payment Method
  if (/\b(cash|cash on delivery|cod|pay rider|pay cash)\b/i.test(textLower)) {
    state.paymentMethod = "cash";
  } else if (/\b(juice|transfer|bank transfer|mcb|paid|receipt)\b/i.test(textLower)) {
    state.paymentMethod = "transfer";
  }

  // 5. Food/Order Items
  const foodKeywords = ["pizza", "burger", "chicken", "kfc", "bucket", "pappagallo", "pan asian", "fries", "meal"];
  for (const entry of customerEntries) {
    const t = entry.text;
    if (foodKeywords.some((k) => t.toLowerCase().includes(k)) && !state.packageDescription) {
      state.packageDescription = t.slice(0, 150).trim();
      break;
    }
  }

  // 6. Build context summary note
  const parts: string[] = [];
  if (state.serviceKind) parts.push(`Service=${state.serviceKind} ✓`);
  if (state.pickup) parts.push(`Pickup=${state.pickup} ✓`);
  if (state.dropoff) parts.push(`Drop-off=${state.dropoff} ✓`);
  if (state.time) parts.push(`Time=${state.time} ✓`);
  if (state.packageDescription) parts.push(`OrderItems="${state.packageDescription}" ✓`);
  if (state.paymentMethod) {
    parts.push(`Payment=${state.paymentMethod} ✓`);
  } else {
    parts.push(`Payment=NOT YET SPECIFIED`);
  }

  if (parts.length > 1) {
    state.summaryNote = [
      `[ACTIVE INTAKE STATE: ${parts.join(" | ")}]`,
      `[DIRECTIVE: Do NOT re-ask details marked with ✓. Move forward directly to ask only missing details or confirm booking warmly!]`,
    ].join("\n");
  }

  return state;
}

import { readJson, writeJson } from "../blob/json-store.ts";
import { normalizeSender } from "./sessions.ts";
import { mauritiusClockLabel, mauritiusDateIso } from "../time.ts";

export type TranscriptRole = "customer" | "agent" | "note";

export interface TranscriptEntry {
  at: string;
  role: TranscriptRole;
  text: string;
  /** True when AI kill switch was off (human covering WhatsApp). */
  whileAgentDisabled?: boolean;
  messageId?: string;
}

export interface ChatTranscript {
  senderPhone: string;
  updatedAt: string;
  /** Last successful booking / handoff quiet window */
  quietUntil?: string;
  lastBookingAt?: string;
  entries: TranscriptEntry[];
}

const MAX_ENTRIES = 40;

function transcriptPath(sender: string): string {
  return `grabbit/sessions/${normalizeSender(sender)}/transcript.json`;
}

export async function loadTranscript(sender: string): Promise<ChatTranscript> {
  const phone = normalizeSender(sender);
  const stored = await readJson<ChatTranscript>(transcriptPath(phone));
  if (stored?.entries && Array.isArray(stored.entries)) {
    return {
      senderPhone: phone,
      updatedAt: stored.updatedAt ?? new Date(0).toISOString(),
      quietUntil: stored.quietUntil,
      lastBookingAt: stored.lastBookingAt,
      entries: stored.entries.slice(-MAX_ENTRIES),
    };
  }
  return {
    senderPhone: phone,
    updatedAt: new Date(0).toISOString(),
    entries: [],
  };
}

async function saveTranscript(transcript: ChatTranscript): Promise<void> {
  await writeJson(transcriptPath(transcript.senderPhone), {
    ...transcript,
    entries: transcript.entries.slice(-MAX_ENTRIES),
    updatedAt: new Date().toISOString(),
  });
}

export async function appendTranscriptEntry(
  sender: string,
  entry: Omit<TranscriptEntry, "at"> & { at?: string },
): Promise<ChatTranscript> {
  const transcript = await loadTranscript(sender);
  transcript.entries.push({
    at: entry.at ?? new Date().toISOString(),
    role: entry.role,
    text: String(entry.text || "").slice(0, 2000),
    whileAgentDisabled: entry.whileAgentDisabled,
    messageId: entry.messageId,
  });
  transcript.updatedAt = new Date().toISOString();
  await saveTranscript(transcript);
  return transcript;
}

export async function markTranscriptBookingQuiet(
  sender: string,
  quietMinutes = 90,
): Promise<void> {
  const transcript = await loadTranscript(sender);
  const now = Date.now();
  transcript.lastBookingAt = new Date(now).toISOString();
  transcript.quietUntil = new Date(now + quietMinutes * 60_000).toISOString();
  transcript.updatedAt = new Date().toISOString();
  await saveTranscript(transcript);
}

export function isInQuietWindow(transcript: ChatTranscript, now = Date.now()): boolean {
  if (!transcript.quietUntil) return false;
  const until = Date.parse(transcript.quietUntil);
  return Number.isFinite(until) && until > now;
}

export function recentDisabledCustomerMessages(
  transcript: ChatTranscript,
  limit = 6,
): TranscriptEntry[] {
  const disabled = transcript.entries.filter(
    (entry) => entry.role === "customer" && entry.whileAgentDisabled,
  );
  return disabled.slice(-limit);
}

export function formatTranscriptForAgent(
  transcript: ChatTranscript,
  opts?: { includeDisabledGap?: boolean },
): string {
  const lines: string[] = ["[recent chat thread]"];

  const gap = recentDisabledCustomerMessages(transcript);
  if (opts?.includeDisabledGap !== false && gap.length > 0) {
    lines.push(
      "[messages while agent was paused]",
      ...gap.map(
        (entry) =>
          `• customer (${entry.at.slice(11, 16)} UTC): ${entry.text || "(media/empty)"}`,
      ),
    );
  }

  const recent = transcript.entries.slice(-8);
  if (recent.length) {
    lines.push("[latest turns]");
    for (const entry of recent) {
      const tag =
        entry.role === "customer"
          ? entry.whileAgentDisabled
            ? "customer(paused-AI)"
            : "customer"
          : entry.role;
      lines.push(`• ${tag}: ${entry.text || "(media/empty)"}`);
    }
  }

  if (isInQuietWindow(transcript)) {
    lines.push(
      "[quiet window: booking active. If customer only sends thanks/ok, reply in 1 line without restarting intake]",
    );
  }

  return lines.join("\n");
}

export function formatTranscriptMessagesForModel(
  entries: TranscriptEntry[],
  opts?: { maxHoursOld?: number }
): Array<{ role: "user" | "assistant"; content: string }> {
  const now = new Date();
  const todayMauritiusIso = mauritiusDateIso(now);
  const cutoffTime = opts?.maxHoursOld ? Date.now() - opts.maxHoursOld * 3600 * 1000 : 0;

  // Filter if maxHoursOld was explicitly requested
  const targetEntries = cutoffTime > 0
    ? entries.filter((e) => !e.at || new Date(e.at).getTime() >= cutoffTime)
    : entries;

  const result: Array<{ role: "user" | "assistant"; content: string }> = [];

  let lastDateIso = "";

  for (const entry of targetEntries) {
    if (!entry.text || !entry.text.trim()) continue;

    const entryDate = entry.at ? new Date(entry.at) : now;
    const entryMauritiusIso = mauritiusDateIso(entryDate);
    const timeStr = mauritiusClockLabel(entryDate);

    const isToday = entryMauritiusIso === todayMauritiusIso;
    const timeTag = isToday ? `[Today ${timeStr}]` : `[${entryMauritiusIso} ${timeStr} - Past Date]`;

    // If day changed between messages, note the transition
    if (lastDateIso && lastDateIso !== entryMauritiusIso) {
      if (isToday) {
        result.push({
          role: "assistant",
          content: `[--- End of previous conversation from ${lastDateIso} --- New conversation today (${todayMauritiusIso}) ---]`,
        });
      }
    }
    lastDateIso = entryMauritiusIso;

    if (entry.role === "customer") {
      result.push({
        role: "user",
        content: `${timeTag} Customer: ${entry.text}`,
      });
    } else if (entry.role === "agent") {
      // Strip any legacy Support: prefixes and pass clean assistant text so model never mimics it
      const cleanAgentText = entry.text
        .replace(/^\[(?:Today|\d{4}-\d{2}-\d{2})[^\]]*\]\s*(?:Support|Customer|Agent|Grabbit)?:\s*/i, "")
        .replace(/^(?:Support|Agent|Grabbit Express|Grabbit):\s*/i, "")
        .trim();
      result.push({
        role: "assistant",
        content: cleanAgentText,
      });
    }
  }

  return result;
}

export const MAURITIUS_TZ = "Indian/Mauritius";

export type WeekdayKey =
  | "MON"
  | "TUES"
  | "WED"
  | "THURS"
  | "FRI"
  | "SAT"
  | "SUN";

export interface ScheduleSlot {
  label: string;
  startMinutes: number;
  endMinutes: number;
  /** Rider cell text per weekday */
  byDay: Partial<Record<WeekdayKey, string>>;
}

export interface AvailabilityEvaluation {
  slots: ScheduleSlot[];
  mauritiusNowLabel: string;
  weekday: WeekdayKey;
  minutesNow: number;
  openNow: boolean;
  currentSlot: ScheduleSlot | null;
  ridersNow: string[];
  nextOpenSlots: Array<{ label: string; riders: string[] }>;
  summaryForAgent: string;
}

const DAY_KEYS: WeekdayKey[] = [
  "MON",
  "TUES",
  "WED",
  "THURS",
  "FRI",
  "SAT",
  "SUN",
];

const UNAVAILABLE_MARKERS = [
  "no rider available",
  "no riders available",
  "closed",
  "n/a",
  "na",
  "-",
];

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function parseTimeToMinutes(raw: string): number | null {
  const cleaned = raw
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3].toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour === 12) hour = 0;
  if (meridiem === "pm") hour += 12;
  return hour * 60 + minute;
}

export function parseTimeSlotLabel(
  label: string,
): { startMinutes: number; endMinutes: number } | null {
  const normalized = label
    .toLowerCase()
    .replace(/\u2013|\u2014/g, "-")
    .replace(/\s+to\s+/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const parts = normalized.split("-").map((part) => part.trim());
  if (parts.length !== 2) return null;
  const startMinutes = parseTimeToMinutes(parts[0]);
  const endMinutes = parseTimeToMinutes(parts[1]);
  if (startMinutes == null || endMinutes == null) return null;
  if (endMinutes <= startMinutes) return null;
  return { startMinutes, endMinutes };
}

export function isUnavailableCell(value: string | undefined): boolean {
  const text = (value ?? "").trim().toLowerCase();
  if (!text) return true;
  return UNAVAILABLE_MARKERS.some(
    (marker) => text === marker || text.includes(marker),
  );
}

export function ridersFromCell(value: string | undefined): string[] {
  if (isUnavailableCell(value)) return [];
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parseRiderScheduleCsv(csv: string): ScheduleSlot[] {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]).map((cell) =>
    cell.toUpperCase().replace(/\s+/g, " ").trim(),
  );
  const timeIdx = header.findIndex((cell) => cell.includes("TIME SLOT"));
  if (timeIdx < 0) return [];

  const dayIndexes = DAY_KEYS.map((day) => ({
    day,
    index: header.findIndex((cell) => cell === day || cell.startsWith(day)),
  })).filter((row) => row.index >= 0);

  const slots: ScheduleSlot[] = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const label = cells[timeIdx]?.trim() ?? "";
    if (!label) continue;
    const parsed = parseTimeSlotLabel(label);
    if (!parsed) continue;

    const byDay: Partial<Record<WeekdayKey, string>> = {};
    for (const { day, index } of dayIndexes) {
      byDay[day] = cells[index] ?? "";
    }
    slots.push({
      label,
      startMinutes: parsed.startMinutes,
      endMinutes: parsed.endMinutes,
      byDay,
    });
  }
  return slots;
}

export function getMauritiusParts(now = new Date()): {
  weekday: WeekdayKey;
  minutesNow: number;
  label: string;
} {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: MAURITIUS_TZ,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).formatToParts(now);

  const map = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  const weekdayRaw = (map.weekday ?? "").toLowerCase();
  const weekdayMap: Record<string, WeekdayKey> = {
    mon: "MON",
    tue: "TUES",
    wed: "WED",
    thu: "THURS",
    fri: "FRI",
    sat: "SAT",
    sun: "SUN",
  };
  const weekday = weekdayMap[weekdayRaw.slice(0, 3)] ?? "MON";
  const hour = Number(map.hour ?? "0");
  const minute = Number(map.minute ?? "0");
  const minutesNow = hour * 60 + minute;
  const label = `${map.weekday} ${map.day} ${map.month} ${map.year}, ${map.hour}:${map.minute} Mauritius time`;
  return { weekday, minutesNow, label };
}

function slotRiders(slot: ScheduleSlot, weekday: WeekdayKey): string[] {
  return ridersFromCell(slot.byDay[weekday]);
}

export function evaluateAvailability(
  slots: ScheduleSlot[],
  now = new Date(),
): AvailabilityEvaluation {
  const { weekday, minutesNow, label } = getMauritiusParts(now);
  const currentSlot =
    slots.find(
      (slot) =>
        minutesNow >= slot.startMinutes && minutesNow < slot.endMinutes,
    ) ?? null;
  const ridersNow = currentSlot ? slotRiders(currentSlot, weekday) : [];
  const openNow = ridersNow.length > 0;

  const nextOpenSlots: Array<{ label: string; riders: string[] }> = [];
  for (const slot of slots) {
    const riders = slotRiders(slot, weekday);
    if (riders.length < 1) continue;
    if (slot.endMinutes <= minutesNow) continue;
    if (currentSlot && slot.startMinutes === currentSlot.startMinutes) {
      // Skip the active slot whether open or "No Rider Available".
      continue;
    }
    nextOpenSlots.push({ label: slot.label, riders });
    if (nextOpenSlots.length >= 3) break;
  }

  const todayOpen = slots
    .map((slot) => ({
      label: slot.label,
      riders: slotRiders(slot, weekday),
    }))
    .filter((row) => row.riders.length > 0);

  const lines = [
    "[delivery availability — Mauritius time Indian/Mauritius]",
    `now: ${label}`,
    openNow
      ? `status: OPEN now (${currentSlot?.label}) riders: ${ridersNow.join(", ")}`
      : "status: CLOSED for on-demand booking right now (no rider in this slot)",
    todayOpen.length
      ? `today open slots:\n${todayOpen
          .map((row) => `• ${row.label} — ${row.riders.join(", ")}`)
          .join("\n")}`
      : "today open slots: none",
    nextOpenSlots.length
      ? `next options:\n${nextOpenSlots
          .map((row) => `• ${row.label} — ${row.riders.join(", ")}`)
          .join("\n")}`
      : "next options: none left today",
    "Hard rule: do NOT accept/book on-demand delivery while status is CLOSED. Offer the next open slot and take a deferred request for the team if they still want help.",
  ];

  return {
    slots,
    mauritiusNowLabel: label,
    weekday,
    minutesNow,
    openNow,
    currentSlot,
    ridersNow,
    nextOpenSlots,
    summaryForAgent: lines.join("\n"),
  };
}

export const MAURITIUS_TZ = "Indian/Mauritius";

const DAY_MS = 24 * 60 * 60 * 1000;

const isoFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: MAURITIUS_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const clockFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: MAURITIUS_TZ,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: MAURITIUS_TZ,
  hour: "numeric",
  minute: "2-digit",
  hourCycle: "h23",
});

export function mauritiusDateIso(instant: Date = new Date(), offsetDays = 0): string {
  const shifted = offsetDays !== 0 ? new Date(instant.getTime() + offsetDays * DAY_MS) : instant;
  return isoFmt.format(shifted);
}

export function addDaysIso(dateIso: string, offsetDays: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const utc = Date.UTC(y || 1970, (m || 1) - 1, d || 1) + offsetDays * DAY_MS;
  return new Date(utc).toISOString().slice(0, 10);
}

export function mauritiusMinutesOfDay(instant: Date = new Date()): number {
  const parts = partsFmt.formatToParts(instant);
  const hours = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minutes = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hours * 60 + minutes;
}

export function mauritiusClockLabel(instant: Date = new Date()): string {
  return clockFmt.format(instant);
}

export function resolveRelativeDateWord(
  word: string | null | undefined,
  now: Date = new Date(),
): string | null {
  const normalized = (word || "").trim().toLowerCase();
  if (normalized === "today") return mauritiusDateIso(now);
  if (normalized === "tomorrow") return mauritiusDateIso(now, 1);
  if (normalized === "yesterday") return mauritiusDateIso(now, -1);
  return null;
}

const WEEKDAY_INDEX: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  TUES: 2,
  WED: 3,
  THU: 4,
  THUR: 4,
  THURS: 4,
  FRI: 5,
  SAT: 6,
};

const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: MAURITIUS_TZ, weekday: "short" });

export function mauritiusWeekday(instant: Date = new Date()): number {
  const label = weekdayFmt.format(instant).toUpperCase().replace(/\.$/, "");
  return WEEKDAY_INDEX[label] ?? 0;
}

const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sept", "Oct", "Nov", "Dec",
];

/**
 * Customer-facing date label for confirmation messages. Same-day bookings say
 * "today"; future bookings restate the day so a bare time is never ambiguous
 * (e.g. "tomorrow, Friday 19 Sept" or "Monday 21 Sept").
 */
export function customerDateLabel(dateIso: string, now: Date = new Date()): string {
  const todayIso = mauritiusDateIso(now);
  if (dateIso === todayIso) return "today";
  const [y, m, d] = dateIso.split("-").map(Number);
  if (!y || !m || !d) return dateIso;
  const weekday = WEEKDAY_LONG[mauritiusWeekday(new Date(Date.UTC(y, m - 1, d, 8)))];
  const label = `${weekday} ${d} ${MONTH_SHORT[m - 1]}`;
  return dateIso === addDaysIso(todayIso, 1) ? `tomorrow, ${label}` : label;
}

export function parseTimeToMinutes(timeStr: string): number | null {
  if (!timeStr) return null;
  const clean = timeStr.toLowerCase().trim().replace(/(\d{1,2})\.(\d{2})/, "$1:$2");

  // Match e.g. "6:10 pm", "06:10pm", "6:10", "18:10", "6pm", "6 pm", "12.45 pm", "8.20am"
  const match = clean.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const meridian = match[3]?.toLowerCase();

  if (meridian === "pm" && hours < 12) {
    hours += 12;
  } else if (meridian === "am" && hours === 12) {
    hours = 0;
  }

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatMinutesToTime(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const meridian = h24 >= 12 ? "pm" : "am";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mStr = m.toString().padStart(2, "0");
  return `${h12}:${mStr} ${meridian}`;
}

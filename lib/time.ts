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
  TUES: 2,
  WED: 3,
  THURS: 4,
  FRI: 5,
  SAT: 6,
};

const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: MAURITIUS_TZ, weekday: "short" });

export function mauritiusWeekday(instant: Date = new Date()): number {
  const label = weekdayFmt.format(instant).toUpperCase().replace(/\.$/, "");
  return WEEKDAY_INDEX[label] ?? 0;
}

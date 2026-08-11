import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryClear, readJson, writeJson } from "../blob/json-store";
import { formatError, logInfo, logWarn } from "../log";
import {
  evaluateAvailability,
  parseRiderScheduleCsv,
  type AvailabilityEvaluation,
  type ScheduleSlot,
} from "./model";

export type {
  AvailabilityEvaluation,
  ScheduleSlot,
  WeekdayKey,
} from "./model";
export {
  evaluateAvailability,
  getMauritiusParts,
  isUnavailableCell,
  MAURITIUS_TZ,
  parseRiderScheduleCsv,
  parseTimeSlotLabel,
  ridersFromCell,
} from "./model";

export const SCHEDULE_BLOB_PATH = "grabbit/admin/rider-schedule.json";

export interface AvailabilitySnapshot extends AvailabilityEvaluation {
  fetchedAt: number;
  source: "remote" | "blob" | "local";
}

interface StoredSchedule {
  csv: string;
  updatedAt: string;
  source: "remote";
  slotCount: number;
}

const CACHE_TTL_MS = 30 * 1000;
let cache: {
  fetchedAt: number;
  slots: ScheduleSlot[];
  source: AvailabilitySnapshot["source"];
} | null = null;

function getSheetCsvUrl(): string | null {
  const explicit = process.env.GRABBIT_SCHEDULE_SHEET_CSV_URL?.trim();
  if (explicit) return explicit;
  const id = process.env.GRABBIT_SCHEDULE_SHEET_ID?.trim();
  if (!id) return null;
  const gid = process.env.GRABBIT_SCHEDULE_SHEET_GID?.trim() || "0";
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

async function fetchRemoteCsv(): Promise<string> {
  const remoteUrl = getSheetCsvUrl();
  if (!remoteUrl) {
    throw new Error(
      "No sheet configured. Set GRABBIT_SCHEDULE_SHEET_ID or GRABBIT_SCHEDULE_SHEET_CSV_URL.",
    );
  }

  const response = await fetch(remoteUrl, {
    headers: {
      Accept: "text/csv,text/plain,*/*",
      "User-Agent": "grabbit-whatsapp-agent/1.0",
    },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`schedule sheet HTTP ${response.status}`);
  }
  const text = await response.text();
  if (text.trim().startsWith("<!DOCTYPE") || text.trim().startsWith("<html")) {
    throw new Error(
      "Sheet returned HTML (publish/share the Sheet for CSV export, or set GRABBIT_SCHEDULE_SHEET_CSV_URL)",
    );
  }
  const slots = parseRiderScheduleCsv(text);
  if (slots.length < 1) {
    throw new Error("schedule sheet parsed to zero slots");
  }
  return text;
}

async function persistRemoteSchedule(csv: string): Promise<StoredSchedule> {
  const slots = parseRiderScheduleCsv(csv);
  const stored: StoredSchedule = {
    csv,
    updatedAt: new Date().toISOString(),
    source: "remote",
    slotCount: slots.length,
  };
  memoryClear(SCHEDULE_BLOB_PATH);
  await writeJson(SCHEDULE_BLOB_PATH, stored);
  return stored;
}

async function loadBlobSchedule(): Promise<{
  slots: ScheduleSlot[];
  updatedAt: string;
} | null> {
  memoryClear(SCHEDULE_BLOB_PATH);
  const stored = await readJson<StoredSchedule>(SCHEDULE_BLOB_PATH);
  if (!stored?.csv?.trim()) return null;
  const slots = parseRiderScheduleCsv(stored.csv);
  if (slots.length < 1) return null;
  return { slots, updatedAt: stored.updatedAt };
}

function loadLocalSchedule(): ScheduleSlot[] {
  const localPath = join(process.cwd(), "data/rider-schedule.csv");
  const csv = readFileSync(localPath, "utf8");
  return parseRiderScheduleCsv(csv);
}

async function loadScheduleSlots(args?: {
  forceRemote?: boolean;
}): Promise<{
  slots: ScheduleSlot[];
  source: AvailabilitySnapshot["source"];
}> {
  if (
    !args?.forceRemote &&
    cache &&
    Date.now() - cache.fetchedAt < CACHE_TTL_MS
  ) {
    return { slots: cache.slots, source: cache.source };
  }

  if (args?.forceRemote || getSheetCsvUrl()) {
    try {
      const csv = await fetchRemoteCsv();
      const stored = await persistRemoteSchedule(csv);
      const slots = parseRiderScheduleCsv(csv);
      cache = { fetchedAt: Date.now(), slots, source: "remote" };
      logInfo("schedule", "loaded remote rider schedule", {
        slots: slots.length,
        forced: Boolean(args?.forceRemote),
        publishedAt: stored.updatedAt,
      });
      return { slots, source: "remote" };
    } catch (error) {
      logWarn("schedule", "remote schedule fetch failed", {
        forced: Boolean(args?.forceRemote),
        ...formatError(error),
      });
      if (args?.forceRemote) {
        throw error instanceof Error
          ? error
          : new Error("Failed to refresh schedule from Google Sheet");
      }
    }
  }

  try {
    const blob = await loadBlobSchedule();
    if (blob) {
      cache = { fetchedAt: Date.now(), slots: blob.slots, source: "blob" };
      logInfo("schedule", "loaded rider schedule from Blob publish", {
        slots: blob.slots.length,
        updatedAt: blob.updatedAt,
      });
      return { slots: blob.slots, source: "blob" };
    }
  } catch (error) {
    logWarn("schedule", "blob schedule read failed", formatError(error));
  }

  const slots = loadLocalSchedule();
  cache = { fetchedAt: Date.now(), slots, source: "local" };
  logInfo("schedule", "loaded local rider schedule", { slots: slots.length });
  return { slots, source: "local" };
}

export async function getAvailabilitySnapshot(
  now = new Date(),
): Promise<AvailabilitySnapshot> {
  const { slots, source } = await loadScheduleSlots();
  const evaluated = evaluateAvailability(slots, now);
  return {
    fetchedAt: cache?.fetchedAt ?? Date.now(),
    source,
    ...evaluated,
  };
}

/** Admin / booking hard refresh from Google Sheet → Blob for all instances. */
export async function refreshScheduleFromSheet(
  now = new Date(),
): Promise<AvailabilitySnapshot> {
  clearScheduleCache();
  const { slots, source } = await loadScheduleSlots({ forceRemote: true });
  const evaluated = evaluateAvailability(slots, now);
  return {
    fetchedAt: cache?.fetchedAt ?? Date.now(),
    source,
    ...evaluated,
  };
}

export function summarizeAvailabilityForAdmin(
  snap: AvailabilitySnapshot,
): string {
  const status = snap.openNow
    ? `OPEN now (${snap.currentSlot?.label ?? "?"}) — ${snap.ridersNow.join(", ") || "n/a"}`
    : "CLOSED now";
  const tomorrow = snap.upcomingDays.find((day) => day.daysAhead === 1);
  const tomorrowHint = tomorrow?.openSlots[0]
    ? `Tomorrow first open: ${tomorrow.openSlots[0].label} (${tomorrow.openSlots[0].riders.join(", ")})`
    : "Tomorrow: no open slots";
  return [
    `Source: ${snap.source}`,
    `Mauritius: ${snap.mauritiusNowLabel}`,
    status,
    `Today open slots: ${snap.upcomingDays.find((d) => d.daysAhead === 0)?.openSlots.length ?? 0}`,
    tomorrowHint,
  ].join(" · ");
}

/** Soft reset for tests / booking gate */
export function clearScheduleCache(): void {
  cache = null;
  memoryClear(SCHEDULE_BLOB_PATH);
}

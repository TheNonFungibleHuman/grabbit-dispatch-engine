import { readFileSync } from "node:fs";
import { join } from "node:path";
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

export interface AvailabilitySnapshot extends AvailabilityEvaluation {
  fetchedAt: number;
  source: "remote" | "local";
}

const CACHE_TTL_MS = 30 * 1000;
let cache: {
  fetchedAt: number;
  slots: ScheduleSlot[];
  source: "remote" | "local";
} | null = null;

function getSheetCsvUrl(): string | null {
  const explicit = process.env.GRABBIT_SCHEDULE_SHEET_CSV_URL?.trim();
  if (explicit) return explicit;
  const id = process.env.GRABBIT_SCHEDULE_SHEET_ID?.trim();
  if (!id) return null;
  const gid = process.env.GRABBIT_SCHEDULE_SHEET_GID?.trim() || "0";
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

async function loadScheduleSlots(): Promise<{
  slots: ScheduleSlot[];
  source: "remote" | "local";
}> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { slots: cache.slots, source: cache.source };
  }

  const remoteUrl = getSheetCsvUrl();
  if (remoteUrl) {
    try {
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
        throw new Error("schedule sheet returned HTML (not publicly exportable)");
      }
      const slots = parseRiderScheduleCsv(text);
      if (slots.length < 1) {
        throw new Error("schedule sheet parsed to zero slots");
      }
      cache = { fetchedAt: Date.now(), slots, source: "remote" };
      logInfo("schedule", "loaded remote rider schedule", {
        slots: slots.length,
        urlHost: (() => {
          try {
            return new URL(remoteUrl).hostname;
          } catch {
            return "unknown";
          }
        })(),
      });
      return { slots, source: "remote" };
    } catch (error) {
      logWarn("schedule", "remote schedule fetch failed; using local CSV", {
        ...formatError(error),
      });
    }
  }

  const localPath = join(process.cwd(), "data/rider-schedule.csv");
  const csv = readFileSync(localPath, "utf8");
  const slots = parseRiderScheduleCsv(csv);
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

/** Soft reset for tests */
export function clearScheduleCache(): void {
  cache = null;
}

import {
  deleteJson,
  listJsonPaths,
  readJson,
  readJsonFresh,
  writeJson,
  writeJsonCas,
} from "../blob/json-store.ts";
import { formatError, logInfo, logWarn } from "../log.ts";

export interface BookingSummary {
  id: string;
  status: string;
  assignedRider: string;
  scheduledDate: string;
  scheduledTime: string;
  slotKey?: string;
  customerPhone: string;
  customerName?: string;
  serviceKind: string;
  tripType?: string;
  pickupAddress?: string;
  deliveryAddress?: string;
  kiloDeliveryId?: string;
  fareAmount?: number | string;
  paymentMethod?: string;
  paymentStatus?: "unpaid" | "paid";
  createdAt: string;
  updatedAt: string;
}

interface BookingIndexV2 {
  version: 2;
  revision: number;
  bookings: BookingSummary[];
}

interface LegacyIndex {
  ids: string[];
}

export const ACTIVE_INDEX_PATH = "grabbit/prebookings/index.json";
export const ARCHIVE_INDEX_PATH = "grabbit/prebookings-archive/index.json";

const TERMINAL_STATUSES = new Set(["completed", "cancelled", "declined"]);
const DEFAULT_ARCHIVE_DAYS = 45;
const MAX_COMMIT_RETRIES = 3;

function archiveCutoffMs(): number {
  const days = Number(process.env.GRABBIT_BOOKING_ARCHIVE_DAYS) || DEFAULT_ARCHIVE_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

function bookingPath(id: string): string {
  return `grabbit/prebookings/${id}.json`;
}

function archivePath(id: string): string {
  return `grabbit/prebookings-archive/${id}.json`;
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isArchivable(summary: BookingSummary, now = Date.now()): boolean {
  if (!isTerminalStatus(summary.status)) return false;
  const ts = Date.parse(summary.updatedAt || summary.createdAt);
  return Number.isFinite(ts) && now - ts >= archiveCutoffMs();
}

const lockQueues = new Map<string, Promise<unknown>>();

export async function withBookingLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = lockQueues.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  lockQueues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export interface IndexState {
  revision: number;
  summaries: BookingSummary[];
}

function summarizeFromRecord(record: Partial<BookingSummary> & { id: string }): BookingSummary {
  return {
    id: record.id,
    status: record.status ?? "confirmed",
    assignedRider: record.assignedRider ?? "",
    scheduledDate: record.scheduledDate ?? "",
    scheduledTime: record.scheduledTime ?? "",
    slotKey: record.slotKey,
    customerPhone: record.customerPhone ?? "",
    customerName: record.customerName,
    serviceKind: record.serviceKind ?? "",
    tripType: record.tripType,
    pickupAddress: record.pickupAddress,
    deliveryAddress: record.deliveryAddress,
    kiloDeliveryId: record.kiloDeliveryId,
    fareAmount: record.fareAmount,
    paymentMethod: record.paymentMethod,
    paymentStatus: record.paymentStatus,
    createdAt: record.createdAt ?? new Date(0).toISOString(),
    updatedAt: record.updatedAt ?? record.createdAt ?? new Date(0).toISOString(),
  };
}

async function migrateLegacyIndex(raw: LegacyIndex | null): Promise<IndexState> {
  let ids = Array.isArray(raw?.ids) ? raw!.ids : [];
  if (ids.length === 0) {
    try {
      const paths = await listJsonPaths("grabbit/prebookings/");
      ids = paths
        .filter((p) => p.includes("pb_") && p.endsWith(".json"))
        .map((p) => p.replace("grabbit/prebookings/", "").replace(".json", ""));
    } catch {
      ids = [];
    }
  }
  const summaries: BookingSummary[] = [];
  for (const id of ids) {
    const record = await readJson<BookingSummary>(bookingPath(id));
    if (record?.id) {
      summaries.push(summarizeFromRecord(record));
    }
  }
  logInfo("booking-store", "migrated legacy booking index to v2", {
    migrated: summaries.length,
    droppedMissingFiles: ids.length - summaries.length,
  });
  const state: IndexState = { revision: 1, summaries };
  const v2Doc: BookingIndexV2 = { version: 2, revision: state.revision, bookings: state.summaries };
  const committed = await writeJsonCas(ACTIVE_INDEX_PATH, v2Doc, {
    field: "revision",
    equals: 0,
    createIfMissing: true,
  });
  if (!committed) {
    await writeJson(ACTIVE_INDEX_PATH, v2Doc);
  }
  return state;
}

let cachedIndex: { fetchedAt: number; state: IndexState } | null = null;
const INDEX_CACHE_TTL_MS = 2_000;

export async function getIndex(args?: { bypassCache?: boolean }): Promise<IndexState> {
  if (!args?.bypassCache && cachedIndex && Date.now() - cachedIndex.fetchedAt < INDEX_CACHE_TTL_MS) {
    return cachedIndex.state;
  }

  memoryClearIndex();
  const raw = await readJson<(BookingIndexV2 | LegacyIndex) & { revision?: number; version?: number }>(
    ACTIVE_INDEX_PATH,
  );

  if (raw && Array.isArray((raw as BookingIndexV2).bookings) && (raw as BookingIndexV2).version === 2) {
    const state: IndexState = {
      revision: (raw as BookingIndexV2).revision ?? 1,
      summaries: ((raw as BookingIndexV2).bookings ?? []).map(summarizeFromRecord),
    };
    cachedIndex = { fetchedAt: Date.now(), state };
    return state;
  }

  const state = await migrateLegacyIndex((raw as LegacyIndex) ?? null);
  cachedIndex = { fetchedAt: Date.now(), state };
  return state;
}

function memoryClearIndex(): void {
  cachedIndex = null;
}

export async function commitIndex(
  nextSummaries: BookingSummary[],
  expectedRevision: number,
): Promise<boolean> {
  const now = Date.now();
  const stale = nextSummaries.filter((s) => isArchivable(s, now));

  let finalSummaries = nextSummaries;
  if (stale.length > 0) {
    finalSummaries = nextSummaries.filter((s) => !isArchivable(s, now));
    try {
      const archiveRaw = await readJson<BookingIndexV2>(ARCHIVE_INDEX_PATH);
      const archivedIds = new Set((archiveRaw?.bookings ?? []).map((s) => s.id));
      const additions = stale.filter((s) => !archivedIds.has(s.id));
      const archiveNext: BookingIndexV2 = {
        version: 2,
        revision: (archiveRaw?.revision ?? 0) + 1,
        bookings: [...(archiveRaw?.bookings ?? []), ...additions],
      };
      await writeJson(ARCHIVE_INDEX_PATH, archiveNext);
      for (const s of additions) {
        await deleteJson(bookingPath(s.id));
      }
      logInfo("booking-store", "archived stale terminal bookings", {
        archived: additions.length,
      });
    } catch (err) {
      logWarn("booking-store", "archival failed; keeping entries active", formatError(err));
    }
  }

  const committed = await writeJsonCas(
    ACTIVE_INDEX_PATH,
    { version: 2 as const, revision: expectedRevision + 1, bookings: finalSummaries },
    { field: "revision", equals: expectedRevision, createIfMissing: expectedRevision === 0 },
  );
  if (!committed) {
    memoryClearIndex();
  } else {
    cachedIndex = {
      fetchedAt: Date.now(),
      state: { revision: expectedRevision + 1, summaries: finalSummaries },
    };
  }
  return committed;
}

export function clearBookingIndexCache(): void {
  cachedIndex = null;
}

export async function querySummaries(
  predicate: (s: BookingSummary) => boolean,
  args?: { bypassCache?: boolean },
): Promise<BookingSummary[]> {
  const { summaries } = await getIndex(args);
  return summaries.filter(predicate);
}

export async function readBookingFile<T>(id: string): Promise<T | null> {
  return readJson<T>(bookingPath(id));
}

export async function writeBookingFile<T extends object>(record: T & { id: string }): Promise<void> {
  await writeJson(bookingPath(record.id), record);
}

export async function readBookingFileFresh<T>(id: string): Promise<T | null> {
  return readJsonFresh<T>(bookingPath(id));
}

export async function upsertSingleSummary(summary: BookingSummary): Promise<void> {
  await withBookingLock("index", async () => {
    for (let attempt = 0; attempt < MAX_COMMIT_RETRIES; attempt++) {
      const { revision, summaries } = await getIndex({ bypassCache: attempt > 0 });
      const idx = summaries.findIndex((s) => s.id === summary.id);
      const next =
        idx >= 0
          ? summaries.map((s, i) => (i === idx ? summary : s))
          : [...summaries, summary];
      if (await commitIndex(next, revision)) return;
    }
    logWarn("booking-store", "failed to upsert summary after retries", { id: summary.id });
  });
}

export async function listArchivedSummaries(): Promise<BookingSummary[]> {
  try {
    const raw = await readJson<BookingIndexV2>(ARCHIVE_INDEX_PATH);
    return (raw?.bookings ?? []).map(summarizeFromRecord);
  } catch {
    return [];
  }
}

export interface OrphanSweepResult {
  scanned: number;
  readmitted: number;
}

export async function reconcileOrphanedBookings(): Promise<OrphanSweepResult> {
  const paths = await listJsonPaths("grabbit/prebookings/");
  const idPattern = /^grabbit\/prebookings\/([^/]+)\.json$/;
  const known = new Set((await getIndex()).summaries.map((s) => s.id));

  const orphans: BookingSummary[] = [];
  for (const path of paths) {
    if (path.includes("prebookings-archive")) continue;
    const match = idPattern.exec(path);
    if (!match || match[1] === "index" || known.has(match[1])) continue;
    const record = await readJson<Partial<BookingSummary>>(path);
    if (!record?.id || !record.status || !record.assignedRider) continue;
    orphans.push(summarizeFromRecord({ ...record, id: record.id }));
  }

  if (orphans.length === 0) {
    return { scanned: paths.length, readmitted: 0 };
  }

  let readmitted = 0;
  await withBookingLock("index", async () => {
    for (let attempt = 0; attempt < MAX_COMMIT_RETRIES; attempt++) {
      const current = await getIndex({ bypassCache: attempt > 0 });
      const presentIds = new Set(current.summaries.map((s) => s.id));
      const additions = orphans.filter((o) => !presentIds.has(o.id));
      if (additions.length === 0) return;
      const committed = await commitIndex([...current.summaries, ...additions], current.revision);
      if (committed) {
        readmitted = additions.length;
        return;
      }
    }
    logWarn("booking-store", "orphan reconcile could not commit after retries", {
      attempted: orphans.length,
    });
  });

  logInfo("booking-store", "reconciled orphaned booking files into index", {
    scanned: paths.length,
    readmitted,
  });
  return { scanned: paths.length, readmitted };
}

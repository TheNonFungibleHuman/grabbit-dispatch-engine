import { readJson, writeJson } from "../blob/json-store.ts";

export const INBOUND_DEDUP_STORE_PATH =
  "grabbit/ops/processed-inbound-message-ids.json";
export const OUTBOUND_AI_ID_STORE_PATH =
  "grabbit/ops/outbound-ai-message-ids.json";

const MAX_IDS = 5000;
const ID_TTL_MS = 24 * 60 * 60 * 1000;
const CLAIM_STALE_MS = 20_000;

interface InboundEntry {
  s: "p" | "d";
  t: number;
}

type RegistryValue = number | InboundEntry;

function entryTimestamp(value: RegistryValue): number {
  return typeof value === "number" ? value : value.t;
}

function normalizeRegistry(raw: Record<string, unknown> | null): Record<string, RegistryValue> {
  const out: Record<string, RegistryValue> = {};
  for (const [id, value] of Object.entries(raw ?? {})) {
    if (typeof value === "number") {
      out[id] = value;
    } else if (
      value &&
      typeof value === "object" &&
      ((value as InboundEntry).s === "p" || (value as InboundEntry).s === "d") &&
      typeof (value as InboundEntry).t === "number"
    ) {
      out[id] = value as InboundEntry;
    }
  }
  return out;
}

const memoryRegistries = new Map<string, Map<string, RegistryValue>>();
const loadedPaths = new Set<string>();
const lastFetchAt = new Map<string, number>();

function registryFreshnessTtlMs(): number {
  const raw = Number(process.env.GRABBIT_DEDUP_FRESH_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
}

function shouldReplaceEntry(existing: RegistryValue, incoming: RegistryValue): boolean {
  if (typeof incoming === "number") return false;
  if (typeof existing === "number") return true;
  if (existing.s === "d") return false;
  if (incoming.s === "d") return true;
  return incoming.t < existing.t;
}

function memoryFor(pathname: string): Map<string, RegistryValue> {
  let registry = memoryRegistries.get(pathname);
  if (!registry) {
    registry = new Map<string, RegistryValue>();
    memoryRegistries.set(pathname, registry);
  }
  return registry;
}

function pruneIds(ids: Record<string, RegistryValue>, now: number): Record<string, RegistryValue> {
  const fresh: Array<[string, RegistryValue]> = [];
  for (const [id, value] of Object.entries(ids)) {
    if (now - entryTimestamp(value) <= ID_TTL_MS) {
      fresh.push([id, value]);
    }
  }
  fresh.sort((a, b) => entryTimestamp(a[1]) - entryTimestamp(b[1]));
  return Object.fromEntries(fresh.slice(Math.max(0, fresh.length - MAX_IDS)));
}

async function loadRegistry(pathname: string): Promise<Record<string, RegistryValue>> {
  const mem = memoryFor(pathname);
  const ttl = registryFreshnessTtlMs();
  const fetchedAt = lastFetchAt.get(pathname);
  const needsFetch =
    !loadedPaths.has(pathname) || ttl === 0 || Date.now() - (fetchedAt ?? 0) > ttl;

  if (needsFetch) {
    loadedPaths.add(pathname);
    try {
      const stored = await readJson<{ ids?: Record<string, unknown> }>(pathname);
      const now = Date.now();
      for (const [id, value] of Object.entries(pruneIds(normalizeRegistry(stored?.ids ?? {}), now))) {
        const existing = mem.get(id);
        if (!existing || shouldReplaceEntry(existing, value)) {
          mem.set(id, value);
        }
      }
    } catch {
      if (!loadedPaths.has(pathname)) {
        mem.clear();
      }
    }
    lastFetchAt.set(pathname, Date.now());
  }
  return Object.fromEntries(mem);
}

async function persistRegistry(
  pathname: string,
  ids: Record<string, RegistryValue>,
): Promise<void> {
  try {
    await writeJson(pathname, { ids });
  } catch {
    loadedPaths.delete(pathname);
  }
}

async function setInboundEntry(id: string, entry: InboundEntry): Promise<void> {
  const mem = memoryFor(INBOUND_DEDUP_STORE_PATH);
  mem.set(id, entry);
  const pruned = pruneIds(Object.fromEntries(mem), Date.now());
  mem.clear();
  for (const [key, value] of Object.entries(pruned)) {
    mem.set(key, value);
  }
  await persistRegistry(INBOUND_DEDUP_STORE_PATH, pruned);
}

export async function claimInboundMessageId(
  id?: string,
): Promise<"new" | "in_flight" | "done"> {
  if (!id) return "done";
  const ids = await loadRegistry(INBOUND_DEDUP_STORE_PATH);
  const raw = ids[id];
  if (raw) {
    if (typeof raw === "number") return "done";
    if (raw.s === "d") return "done";
    if (Date.now() - raw.t < CLAIM_STALE_MS) return "in_flight";
  }
  await setInboundEntry(id, { s: "p", t: Date.now() });
  return "new";
}

export async function completeInboundMessageId(id?: string): Promise<void> {
  if (!id) return;
  await setInboundEntry(id, { s: "d", t: Date.now() });
}

export async function hasInboundMessageId(id?: string): Promise<boolean> {
  if (!id) return false;
  const ids = await loadRegistry(INBOUND_DEDUP_STORE_PATH);
  return Boolean(ids[id]);
}

export async function registerOutboundAiId(id?: string): Promise<void> {
  if (!id) return;
  const mem = memoryFor(OUTBOUND_AI_ID_STORE_PATH);
  mem.set(id, Date.now());
  const pruned = pruneIds(Object.fromEntries(mem), Date.now());
  mem.clear();
  for (const [key, value] of Object.entries(pruned)) {
    mem.set(key, value);
  }
  await persistRegistry(OUTBOUND_AI_ID_STORE_PATH, pruned);
}

export async function isKnownOutboundAiId(id?: string): Promise<boolean> {
  if (!id) return false;
  const ids = await loadRegistry(OUTBOUND_AI_ID_STORE_PATH);
  return Boolean(ids[id]);
}

export function resetMessageIdStoreForTests(): void {
  memoryRegistries.clear();
  loadedPaths.clear();
  lastFetchAt.clear();
}

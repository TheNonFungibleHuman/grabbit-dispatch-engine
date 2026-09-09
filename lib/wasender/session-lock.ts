import { logInfo, logWarn } from "../log.ts";
import { readJson, writeJson } from "../blob/json-store.ts";

const activeLocks = new Map<string, Promise<void>>();
const LOCK_TIMEOUT_MS = 25_000; // Maximum time a single message turn can hold the local lock
const DISTRIBUTED_LOCK_STALE_MS = 12_000; // Distributed lock auto-expires after 12s

interface DistributedLockStore {
  locks: Record<string, number>; // phone -> timestamp
}

const DISTRIBUTED_LOCKS_PATH = "grabbit/ops/active-phone-locks.json";

async function isDistributedLocked(phone: string): Promise<boolean> {
  try {
    const store = await readJson<DistributedLockStore>(DISTRIBUTED_LOCKS_PATH);
    if (!store?.locks?.[phone]) return false;
    const lockAge = Date.now() - store.locks[phone];
    return lockAge < DISTRIBUTED_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

async function claimDistributedLock(phone: string): Promise<void> {
  try {
    const store = (await readJson<DistributedLockStore>(DISTRIBUTED_LOCKS_PATH)) || { locks: {} };
    store.locks[phone] = Date.now();
    await writeJson(DISTRIBUTED_LOCKS_PATH, store);
  } catch (err) {
    // Non-blocking
  }
}

async function releaseDistributedLock(phone: string): Promise<void> {
  try {
    const store = await readJson<DistributedLockStore>(DISTRIBUTED_LOCKS_PATH);
    if (store?.locks?.[phone]) {
      delete store.locks[phone];
      await writeJson(DISTRIBUTED_LOCKS_PATH, store);
    }
  } catch (err) {
    // Non-blocking
  }
}

/**
 * Serializes all inbound processing for a specific phone number so parallel
 * webhooks never run concurrent LLM calls for the same conversation, both within
 * a single container instance and across distributed serverless functions.
 */
export async function withPhoneSessionLock<T>(
  phone: string,
  fn: () => Promise<T>,
): Promise<T> {
  const cleanPhone = phone.replace(/\D/g, "");
  if (!cleanPhone) {
    return fn();
  }

  // 1. In-process lock (instant, 0ms)
  while (activeLocks.has(cleanPhone)) {
    const currentLock = activeLocks.get(cleanPhone);
    try {
      await Promise.race([
        currentLock,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("session lock timeout")), LOCK_TIMEOUT_MS),
        ),
      ]);
    } catch (e) {
      logWarn("session-lock", "pre-existing local lock timed out or threw, releasing", {
        phone: cleanPhone,
        error: e instanceof Error ? e.message : String(e),
      });
      activeLocks.delete(cleanPhone);
      break;
    }
  }

  let releaseLock: () => void = () => {};
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  activeLocks.set(cleanPhone, lockPromise);

  // 2. Distributed lock across serverless instances: wait up to 3 seconds if another lambda holds the turn
  for (let attempt = 0; attempt < 5; attempt++) {
    const isLocked = await isDistributedLocked(cleanPhone);
    if (!isLocked) break;
    await new Promise((r) => setTimeout(r, 600));
  }

  await claimDistributedLock(cleanPhone);

  try {
    return await fn();
  } finally {
    await releaseDistributedLock(cleanPhone);
    activeLocks.delete(cleanPhone);
    releaseLock();
  }
}

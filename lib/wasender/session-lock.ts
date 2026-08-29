import { logInfo, logWarn } from "../log.ts";

interface QueueItem {
  resolve: () => void;
  reject: (err: unknown) => void;
  queuedAt: number;
}

const activeLocks = new Map<string, Promise<void>>();
const queues = new Map<string, QueueItem[]>();

const LOCK_TIMEOUT_MS = 25_000; // Maximum time a single message turn can hold the lock

/**
 * Serializes all inbound processing for a specific phone number so parallel
 * webhooks never run concurrent LLM calls for the same conversation.
 */
export async function withPhoneSessionLock<T>(
  phone: string,
  fn: () => Promise<T>,
): Promise<T> {
  const cleanPhone = phone.replace(/\D/g, "");
  if (!cleanPhone) {
    return fn();
  }

  // Wait for any currently active lock on this phone
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
      logWarn("session-lock", "pre-existing lock timed out or threw, releasing", {
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

  try {
    return await fn();
  } finally {
    activeLocks.delete(cleanPhone);
    releaseLock();
  }
}

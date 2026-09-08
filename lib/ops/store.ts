import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "../blob/json-store.ts";
import { formatError, logInfo, logWarn } from "../log.ts";
import { mauritiusDateIso, mauritiusMinutesOfDay } from "../time.ts";
import {
  applyOpsEvent,
  emptyOpsState,
  listRecentThreads,
  listTakeoverThreads,
  normalizeOpsPhone,
  type OpsEvent,
  type OpsEventType,
  type OpsState,
  type ThreadOps,
} from "./model.ts";

export type {
  OpsEvent,
  OpsEventType,
  OpsStats,
  OpsState,
  ThreadOps,
} from "./model";

export const OPS_STATE_PATH = "grabbit/ops/state.json";

async function loadOpsState(): Promise<OpsState> {
  const stored = await readJson<OpsState>(OPS_STATE_PATH);
  if (!stored?.stats || !stored.threads || !stored.recent) {
    return emptyOpsState();
  }
  return stored;
}

async function saveOpsState(state: OpsState): Promise<void> {
  await writeJson(OPS_STATE_PATH, state);
}

export async function recordOpsEvent(input: {
  phone: string;
  type: OpsEventType;
  messageId?: string;
  preview?: string;
  error?: string;
}): Promise<void> {
  const phone = normalizeOpsPhone(input.phone);
  if (!phone) return;

  try {
    const event: OpsEvent = {
      id: randomUUID(),
      at: new Date().toISOString(),
      phone,
      type: input.type,
      messageId: input.messageId,
      preview: input.preview?.slice(0, 180),
      error: input.error?.slice(0, 300),
    };
    const next = applyOpsEvent(await loadOpsState(), event);
    await saveOpsState(next);
  } catch (error) {
    logWarn("ops", "failed to record ops event", {
      type: input.type,
      phone,
      ...formatError(error),
    });
  }
}

export async function clearThreadTakeover(phone: string): Promise<ThreadOps | null> {
  const normalized = normalizeOpsPhone(phone);
  if (!normalized) return null;

  const event: OpsEvent = {
    id: randomUUID(),
    at: new Date().toISOString(),
    phone: normalized,
    type: "takeover_cleared",
    preview: "Marked handled in admin",
  };
  const next = applyOpsEvent(await loadOpsState(), event);
  await saveOpsState(next);
  return next.threads[normalized] ?? null;
}

export async function getOpsDashboard(): Promise<{
  state: OpsState;
  takeovers: ThreadOps[];
  recentThreads: ThreadOps[];
}> {
  const state = await loadOpsState();
  return {
    state,
    takeovers: listTakeoverThreads(state),
    recentThreads: listRecentThreads(state),
  };
}

export async function getRecentOpsEvents(limit = 50): Promise<OpsEvent[]> {
  const state = await loadOpsState();
  return (state.recent || []).slice(-limit);
}

export interface PendingEscalation {
  id: string;
  customerPhone: string;
  customerName: string;
  reason: string;
  createdAt: string;
  status: "open" | "resolved";
  resolvedAt?: string;
  resolvedBy?: string;
  responseMessage?: string;
  lastHoldingNoticeAt?: number;
  followUpMessages?: Array<{ text: string; at: string }>;
}

const ESCALATIONS_STORE_PATH = "grabbit/ops/escalations.json";

export async function loadEscalations(opts?: {
  allowPastDays?: boolean;
  now?: Date;
}): Promise<PendingEscalation[]> {
  try {
    const list = await readJson<PendingEscalation[]>(ESCALATIONS_STORE_PATH);
    if (!Array.isArray(list)) return [];
    if (opts?.allowPastDays) return list;

    const todayIso = mauritiusDateIso(opts?.now ?? new Date());
    // Strictly scope escalations to current Mauritius day
    const activeToday = list.filter((e) => {
      if (!e.createdAt) return false;
      const createdDate = mauritiusDateIso(new Date(e.createdAt));
      return createdDate === todayIso;
    });

    // If past-day records were present, prune them from persistent store asynchronously
    if (activeToday.length !== list.length) {
      writeJson(ESCALATIONS_STORE_PATH, activeToday).catch((err) => {
        logWarn("ops", "failed to prune stale past-day escalations", formatError(err));
      });
    }

    return activeToday;
  } catch {
    return [];
  }
}

export async function saveEscalations(list: PendingEscalation[]): Promise<void> {
  await writeJson(ESCALATIONS_STORE_PATH, list);
}

/**
 * Completely wipe the escalation queue (e.g. at End of Day or via Admin command).
 */
export async function clearAllEscalations(reason = "End of day reset"): Promise<{ clearedCount: number }> {
  try {
    const list = await readJson<PendingEscalation[]>(ESCALATIONS_STORE_PATH);
    const count = Array.isArray(list) ? list.length : 0;
    await writeJson(ESCALATIONS_STORE_PATH, []);
    logInfo("ops", "cleared all escalations", { count, reason });
    return { clearedCount: count };
  } catch (err) {
    logWarn("ops", "failed to clear escalations", formatError(err));
    return { clearedCount: 0 };
  }
}

/**
 * Checks and clears escalations at End of Day daily (resolved or not),
 * and purges any past-day records.
 */
export async function autoClearDailyEscalations(now = new Date()): Promise<{
  clearedCount: number;
  reason: string;
}> {
  const todayIso = mauritiusDateIso(now);
  const minutesOfDay = mauritiusMinutesOfDay(now);
  const list = await readJson<PendingEscalation[]>(ESCALATIONS_STORE_PATH);
  if (!Array.isArray(list) || list.length === 0) {
    return { clearedCount: 0, reason: "Queue already empty" };
  }

  // If after 8:30 PM (20:30) Mauritius time or before 6:00 AM, it is End of Day / off-shift:
  // Clear ALL escalations resolved or not.
  const isEndOfDay = minutesOfDay >= 20 * 60 + 30 || minutesOfDay <= 6 * 60;
  if (isEndOfDay) {
    await clearAllEscalations(`End of day automatic clear (${todayIso})`);
    return {
      clearedCount: list.length,
      reason: `Cleared all ${list.length} escalations at End of Day (${todayIso})`,
    };
  }

  // During operating day: purge any past-day escalations
  const activeToday = list.filter((e) => {
    if (!e.createdAt) return false;
    const createdDate = mauritiusDateIso(new Date(e.createdAt));
    return createdDate === todayIso;
  });

  if (activeToday.length !== list.length) {
    const prunedCount = list.length - activeToday.length;
    await writeJson(ESCALATIONS_STORE_PATH, activeToday);
    logInfo("ops", "auto-cleared stale past-day escalations", {
      prunedCount,
      remaining: activeToday.length,
    });
    return {
      clearedCount: prunedCount,
      reason: `Purged ${prunedCount} past-day escalations`,
    };
  }

  return { clearedCount: 0, reason: "No stale past-day escalations found" };
}

export async function recordPendingEscalation(input: {
  customerPhone: string;
  customerName: string;
  reason: string;
}): Promise<PendingEscalation> {
  const cleanPhone = input.customerPhone.replace(/\D/g, "");
  const list = await loadEscalations();

  const escalation: PendingEscalation = {
    id: `esc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    customerPhone: cleanPhone,
    customerName: input.customerName,
    reason: input.reason,
    createdAt: new Date().toISOString(),
    status: "open",
    followUpMessages: [],
  };

  const updated = list.map((e) =>
    e.customerPhone === cleanPhone && e.status === "open"
      ? { ...e, status: "resolved" as const, resolvedAt: new Date().toISOString() }
      : e,
  );

  updated.unshift(escalation);
  await saveEscalations(updated.slice(0, 50));
  return escalation;
}

export async function listOpenEscalations(): Promise<PendingEscalation[]> {
  const list = await loadEscalations();
  return list.filter((e) => e.status === "open");
}

export async function getOpenCustomerEscalation(
  customerPhone: string,
): Promise<PendingEscalation | null> {
  const cleanPhone = customerPhone.replace(/\D/g, "");
  if (!cleanPhone) return null;
  const list = await loadEscalations();
  return (
    list.find(
      (e) =>
        e.status === "open" &&
        (e.customerPhone.includes(cleanPhone) || cleanPhone.includes(e.customerPhone)),
    ) || null
  );
}

export async function recordCustomerFollowUp(
  customerPhone: string,
  text: string,
): Promise<PendingEscalation | null> {
  const cleanPhone = customerPhone.replace(/\D/g, "");
  const list = await loadEscalations();
  let updatedEsc: PendingEscalation | null = null;

  const updated = list.map((e) => {
    if (
      e.status === "open" &&
      (e.customerPhone.includes(cleanPhone) || cleanPhone.includes(e.customerPhone))
    ) {
      const messages = e.followUpMessages || [];
      const followUp = { text, at: new Date().toISOString() };
      updatedEsc = {
        ...e,
        followUpMessages: [...messages.slice(-10), followUp],
      };
      return updatedEsc;
    }
    return e;
  });

  if (updatedEsc) {
    await saveEscalations(updated);
  }
  return updatedEsc;
}

export async function recordHoldingNoticeSent(customerPhone: string): Promise<void> {
  const cleanPhone = customerPhone.replace(/\D/g, "");
  const list = await loadEscalations();
  const now = Date.now();

  const updated = list.map((e) => {
    if (
      e.status === "open" &&
      (e.customerPhone.includes(cleanPhone) || cleanPhone.includes(e.customerPhone))
    ) {
      return { ...e, lastHoldingNoticeAt: now };
    }
    return e;
  });

  await saveEscalations(updated);
}

export async function getLatestResolvedEscalationInstruction(
  customerPhone: string,
): Promise<string | null> {
  const cleanPhone = customerPhone.replace(/\D/g, "");
  if (!cleanPhone) return null;
  const list = await loadEscalations();
  const found = list.find(
    (e) =>
      e.status === "resolved" &&
      e.responseMessage &&
      (e.customerPhone.includes(cleanPhone) || cleanPhone.includes(e.customerPhone)),
  );
  return found?.responseMessage || null;
}

export async function resolvePendingEscalation(args: {
  customerPhone: string;
  responseMessage?: string;
  resolvedBy?: string;
}): Promise<boolean> {
  const cleanPhone = args.customerPhone.replace(/\D/g, "");
  const list = await loadEscalations();
  let found = false;

  const updated = list.map((e) => {
    if (e.customerPhone.includes(cleanPhone) || cleanPhone.includes(e.customerPhone)) {
      if (e.status === "open") {
        found = true;
        return {
          ...e,
          status: "resolved" as const,
          resolvedAt: new Date().toISOString(),
          resolvedBy: args.resolvedBy,
          responseMessage: args.responseMessage,
        };
      }
    }
    return e;
  });

  if (found) {
    await saveEscalations(updated);
  }

  return found;
}


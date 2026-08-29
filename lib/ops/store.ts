import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "../blob/json-store.ts";
import { formatError, logWarn } from "../log.ts";
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
}

const ESCALATIONS_STORE_PATH = "grabbit/ops/escalations.json";

export async function loadEscalations(): Promise<PendingEscalation[]> {
  try {
    const list = await readJson<PendingEscalation[]>(ESCALATIONS_STORE_PATH);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function saveEscalations(list: PendingEscalation[]): Promise<void> {
  await writeJson(ESCALATIONS_STORE_PATH, list);
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


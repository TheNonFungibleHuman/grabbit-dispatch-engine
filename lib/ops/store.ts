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

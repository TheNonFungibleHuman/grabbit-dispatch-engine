export type OpsEventType =
  | "inbound_received"
  | "outbound_sent"
  | "outbound_failed"
  | "agent_failed"
  | "takeover_cleared";

export interface OpsEvent {
  id: string;
  at: string;
  phone: string;
  type: OpsEventType;
  messageId?: string;
  preview?: string;
  error?: string;
}

export interface ThreadOps {
  phone: string;
  updatedAt: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastOutboundOk?: boolean;
  lastError?: string;
  needsTakeover: boolean;
  takeoverReason?: string;
  inboundCount: number;
  successOutCount: number;
  failOutCount: number;
  recent: OpsEvent[];
}

export interface OpsStats {
  inbound: number;
  outboundSuccess: number;
  outboundFailed: number;
  agentFailed: number;
  needsTakeover: number;
}

export interface OpsState {
  updatedAt: string;
  stats: OpsStats;
  threads: Record<string, ThreadOps>;
  recent: OpsEvent[];
}

export const EMPTY_OPS_STATS: OpsStats = {
  inbound: 0,
  outboundSuccess: 0,
  outboundFailed: 0,
  agentFailed: 0,
  needsTakeover: 0,
};

export function emptyOpsState(now = new Date().toISOString()): OpsState {
  return {
    updatedAt: now,
    stats: { ...EMPTY_OPS_STATS },
    threads: {},
    recent: [],
  };
}

export function normalizeOpsPhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

function emptyThread(phone: string, at: string): ThreadOps {
  return {
    phone,
    updatedAt: at,
    needsTakeover: false,
    inboundCount: 0,
    successOutCount: 0,
    failOutCount: 0,
    recent: [],
  };
}

function recountTakeovers(threads: Record<string, ThreadOps>): number {
  return Object.values(threads).filter((thread) => thread.needsTakeover).length;
}

const MAX_RECENT = 150;
const MAX_THREAD_RECENT = 20;

export function applyOpsEvent(state: OpsState, event: OpsEvent): OpsState {
  const phone = normalizeOpsPhone(event.phone);
  if (!phone) return state;

  const threads = { ...state.threads };
  const thread = { ...(threads[phone] ?? emptyThread(phone, event.at)) };
  const stats = { ...state.stats };

  thread.updatedAt = event.at;
  thread.recent = [event, ...thread.recent].slice(0, MAX_THREAD_RECENT);

  switch (event.type) {
    case "inbound_received":
      thread.inboundCount += 1;
      thread.lastInboundAt = event.at;
      stats.inbound += 1;
      break;
    case "outbound_sent":
      thread.successOutCount += 1;
      thread.lastOutboundAt = event.at;
      thread.lastOutboundOk = true;
      thread.lastError = undefined;
      // Successful bot reply means the thread is no longer dropped.
      thread.needsTakeover = false;
      thread.takeoverReason = undefined;
      stats.outboundSuccess += 1;
      break;
    case "outbound_failed":
      thread.failOutCount += 1;
      thread.lastOutboundAt = event.at;
      thread.lastOutboundOk = false;
      thread.lastError = event.error ?? "Outbound send failed";
      thread.needsTakeover = true;
      thread.takeoverReason =
        event.error ?? "Wasender could not deliver the reply";
      stats.outboundFailed += 1;
      break;
    case "agent_failed":
      thread.lastError = event.error ?? "Agent failed";
      // Keep visible in feed/stats. Takeover flips only if outbound also fails
      // (Wasender drop / protection), which is what ops must pick up.
      stats.agentFailed += 1;
      break;
    case "takeover_cleared":
      thread.needsTakeover = false;
      thread.takeoverReason = undefined;
      break;
    default:
      break;
  }

  threads[phone] = thread;
  stats.needsTakeover = recountTakeovers(threads);

  return {
    updatedAt: event.at,
    stats,
    threads,
    recent: [event, ...state.recent].slice(0, MAX_RECENT),
  };
}

export function listTakeoverThreads(state: OpsState): ThreadOps[] {
  return Object.values(state.threads)
    .filter((thread) => thread.needsTakeover)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function listRecentThreads(state: OpsState, limit = 40): ThreadOps[] {
  return Object.values(state.threads)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, limit);
}

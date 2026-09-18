import { readJson, writeJson } from "../blob/json-store.ts";
import { formatError, logInfo, logWarn } from "../log.ts";

const GUARD_PATH = "grabbit/ops/outbound-reply-guard.json";
const IDENTICAL_REPLY_WINDOW_MS = 60_000;
const MAX_TRACKED_RECIPIENTS = 500;

export interface GuardedReplyRecord {
  text: string;
  at: number;
}

export interface OutboundReplyGuardState {
  replies: Record<string, GuardedReplyRecord>;
}

/**
 * Normalizes a message for duplicate comparison. WhatsApp sanitization already
 * ran before this point, so only normalize case, repeated whitespace, and
 * easily variable tokens such as zero-width characters.
 */
export function normalizeReplyText(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[​‌‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Determines whether an outbound reply is an exact duplicate of the previous
 * reply to the same recipient within the guard window.
 */
export function isIdenticalRecentReply(
  candidate: string,
  previous?: GuardedReplyRecord | null,
  now = Date.now(),
): boolean {
  if (!previous) return false;
  if (!Number.isFinite(previous.at) || now - previous.at > IDENTICAL_REPLY_WINDOW_MS) {
    return false;
  }
  const candidateText = normalizeReplyText(candidate);
  if (!candidateText) return false;
  return normalizeReplyText(previous.text) === candidateText;
}

function pruneReplies(replies: Record<string, GuardedReplyRecord>, now: number): void {
  for (const [phone, record] of Object.entries(replies)) {
    if (!Number.isFinite(record?.at) || now - record.at > IDENTICAL_REPLY_WINDOW_MS) {
      delete replies[phone];
    }
  }
}

async function loadGuardState(): Promise<OutboundReplyGuardState> {
  try {
    const stored = await readJson<OutboundReplyGuardState>(GUARD_PATH);
    if (stored && typeof stored.replies === "object") {
      return { replies: stored.replies };
    }
  } catch (error) {
    logWarn("reply-guard", "failed to read outbound reply guard", formatError(error));
  }
  return { replies: {} };
}

export async function shouldSuppressDuplicateReply(
  to: string,
  text: string,
  now = Date.now(),
): Promise<boolean> {
  try {
    const state = await loadGuardState();
    return isIdenticalRecentReply(text, state.replies[to], now);
  } catch (error) {
    logWarn("reply-guard", "duplicate check failed; allowing reply", formatError(error));
    return false;
  }
}

export async function rememberSentReply(
  to: string,
  text: string,
  now = Date.now(),
): Promise<void> {
  try {
    const state = await loadGuardState();
    pruneReplies(state.replies, now);
    if (Object.keys(state.replies).length >= MAX_TRACKED_RECIPIENTS) {
      const oldest = Object.entries(state.replies).sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) delete state.replies[oldest[0]];
    }
    state.replies[to] = { text, at: now };
    await writeJson(GUARD_PATH, state);
    logInfo("reply-guard", "recorded outbound reply", { to });
  } catch (error) {
    logWarn("reply-guard", "failed to record outbound reply", formatError(error));
  }
}

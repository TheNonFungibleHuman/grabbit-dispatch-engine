import { readJson, writeJson } from "../blob/json-store.ts";
import { formatError, logInfo, logWarn } from "../log.ts";

const GUARD_PATH = "grabbit/ops/outbound-reply-guard.json";
const IDENTICAL_REPLY_WINDOW_MS = 60_000;
const MAX_TRACKED_RECIPIENTS = 500;
const NEAR_DUPLICATE_WINDOW_MS = 10_000;
const NEAR_DUPLICATE_MIN_SIMILARITY = 0.6;
const NEAR_DUPLICATE_MIN_TOKENS = 8;

function tokenCount(text: string): number {
  return normalizeReplyText(text).split(" ").filter((token) => token.length > 0).length;
}

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

/**
 * Word-level Jaccard similarity in [0, 1] between two messages after
 * normalization. Used to catch near-duplicate confirmation cards that carry
 * different outbound message IDs, where exact-match dedup cannot fire.
 */
export function textSimilarity(left: string, right: string): number {
  const leftTokens = new Set(
    normalizeReplyText(left).split(" ").filter((token) => token.length > 0),
  );
  const rightTokens = new Set(
    normalizeReplyText(right).split(" ").filter((token) => token.length > 0),
  );
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = leftTokens.size + rightTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Determines whether an outbound reply is a NEAR-duplicate of the previous
 * reply to the same recipient — the "5-second duplicate confirmation card"
 * case, where two sends carry different outbound IDs and slightly reworded
 * text (e.g. a tool side-effect confirmation followed by the agent's own
 * paraphrased card). Fires only inside a tight 10s window on long,
 * high-similarity messages so distinct follow-ups are never suppressed.
 */
export function isNearDuplicateRecentReply(
  candidate: string,
  previous?: GuardedReplyRecord | null,
  now = Date.now(),
): boolean {
  if (!previous) return false;
  if (!Number.isFinite(previous.at) || now - previous.at > NEAR_DUPLICATE_WINDOW_MS) {
    return false;
  }
  const candidateText = normalizeReplyText(candidate);
  const previousText = normalizeReplyText(previous.text || "");
  if (!candidateText || !previousText) return false;
  if (tokenCount(candidateText) < NEAR_DUPLICATE_MIN_TOKENS) return false;
  if (tokenCount(previousText) < NEAR_DUPLICATE_MIN_TOKENS) return false;
  return textSimilarity(candidateText, previousText) >= NEAR_DUPLICATE_MIN_SIMILARITY;
}

/**
 * Escape hatch for the near-duplicate guard: short, content-distinct replies
 * (e.g. the deterministic post-booking acks "Noted, payment in cash!" or
 * "Already locked in for you!") must NEVER be suppressed just because they
 * followed a confirmation card within the window.
 */
export function isDistinctShortReply(
  candidate: string,
  previousText?: string | null,
): boolean {
  if (!previousText) return false;
  return (
    tokenCount(candidate) < NEAR_DUPLICATE_MIN_TOKENS &&
    textSimilarity(candidate, previousText) < NEAR_DUPLICATE_MIN_SIMILARITY
  );
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
    const previous = state.replies[to];
    if (isIdenticalRecentReply(text, previous, now)) return true;
    if (
      isNearDuplicateRecentReply(text, previous, now) &&
      !isDistinctShortReply(text, previous?.text)
    ) {
      return true;
    }
    return false;
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

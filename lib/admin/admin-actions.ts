import { readJson, writeJson } from "../blob/json-store.ts";
import { formatError, logInfo, logWarn } from "../log.ts";
import { postDailySummaryToGoogleChat } from "../schedule/daily-rundown.ts";
import { postWeeklySummaryToGoogleChat } from "../schedule/weekly-report.ts";
import { executeCustomerBroadcast } from "./broadcast.ts";

export type AdminActionType = "daily_rundown" | "weekly_report" | "broadcast";

export interface PendingAdminAction {
  type: AdminActionType;
  payload?: Record<string, unknown>;
  createdAt: string;
  expiresAt: number; // Unix ms timestamp
}

export interface AdminActionsStore {
  actions: Record<string, PendingAdminAction>;
}

const PENDING_ACTIONS_PATH = "grabbit/ops/pending-admin-actions.json";

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

export async function setPendingAdminAction(
  adminPhone: string,
  type: AdminActionType,
  payload: Record<string, unknown> = {},
  ttlMinutes = 30, // 30 min — stale previews must never hijack unrelated admin replies
): Promise<void> {
  const cleanPhone = normalizePhone(adminPhone);
  const store = (await readJson<AdminActionsStore>(PENDING_ACTIONS_PATH)) || { actions: {} };
  store.actions[cleanPhone] = {
    type,
    payload,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + ttlMinutes * 60 * 1000,
  };
  await writeJson(PENDING_ACTIONS_PATH, store);
  logInfo("admin_actions", "registered pending admin action", {
    adminPhone: cleanPhone,
    type,
    expiresInMin: ttlMinutes,
  });
}

export async function getPendingAdminAction(adminPhone: string): Promise<PendingAdminAction | null> {
  const cleanPhone = normalizePhone(adminPhone);
  const store = (await readJson<AdminActionsStore>(PENDING_ACTIONS_PATH)) || { actions: {} };
  const action = store.actions[cleanPhone];
  if (!action) return null;

  if (Date.now() > action.expiresAt) {
    delete store.actions[cleanPhone];
    await writeJson(PENDING_ACTIONS_PATH, store);
    return null;
  }
  return action;
}

export async function clearPendingAdminAction(adminPhone: string): Promise<void> {
  const cleanPhone = normalizePhone(adminPhone);
  const store = (await readJson<AdminActionsStore>(PENDING_ACTIONS_PATH)) || { actions: {} };
  if (store.actions[cleanPhone]) {
    delete store.actions[cleanPhone];
    await writeJson(PENDING_ACTIONS_PATH, store);
  }
}

export async function consumePendingAdminAction(
  adminPhone: string,
  text: string,
): Promise<{ handled: boolean; responseMessage?: string }> {
  const action = await getPendingAdminAction(adminPhone);
  if (!action) {
    return { handled: false };
  }

  const cleanText = text.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "");

  // Guard: if the admin's message clearly carries booking/dispatch intent, it is
  // NOT a report confirmation — never consume it here; let the agent handle it.
  // (Uwase incident 2026-09-17: admin's "Yes" meant "book the 8:45 am trip" but
  // a stale rundown preview swallowed it and posted the revenue rundown.)
  const hasBookingIntent =
    /\b(book|booking|reassign|reschedule|trip|ride|delivery|slot|rider|customer)\b/i.test(text) ||
    /\d{1,2}[:.]?\d{0,2}\s*(am|pm)/i.test(text);
  if (hasBookingIntent) {
    await clearPendingAdminAction(adminPhone);
    return { handled: false };
  }

  // Bare affirmative tokens ONLY. Prefix matching (e.g. startsWith("yes")) made
  // any admin sentence beginning with "yes" act as a report approval.
  const isAffirmative =
    cleanText === "yes" ||
    cleanText === "y" ||
    cleanText === "send" ||
    cleanText === "post" ||
    cleanText === "confirm" ||
    cleanText === "ok" ||
    cleanText === "looks good" ||
    cleanText === "go ahead" ||
    cleanText === "send it" ||
    cleanText === "post it";

  const isNegative =
    cleanText === "no" ||
    cleanText === "n" ||
    cleanText === "cancel" ||
    cleanText === "dont send" ||
    cleanText.startsWith("cancel");

  if (!isAffirmative && !isNegative) {
    return { handled: false };
  }

  // Recency guard: only treat a bare confirmation as a report approval while the
  // pending action is FRESH (<=15 min old). A stale preview must never hijack a
  // "Yes" that actually answers an unrelated question — the agent has full
  // conversation context and should handle it instead.
  // (Uwase incident 2026-09-17: the 17:13 rundown preview swallowed the admin's
  // 18:13 "Yes", which was meant to approve booking her 8:45 am trip.)
  const actionAgeMs = Date.now() - (Date.parse(action.createdAt) || 0);
  const isStale = actionAgeMs > 15 * 60 * 1000 || actionAgeMs < 0;
  if (isAffirmative && isStale) {
    await clearPendingAdminAction(adminPhone);
    logInfo("admin_actions", "stale pending admin action ignored — deferring to agent", {
      type: action.type,
      ageMinutes: Math.round(actionAgeMs / 60_000),
    });
    return { handled: false };
  }

  // Clear action immediately so double sends are prevented
  await clearPendingAdminAction(adminPhone);

  if (isNegative) {
    return {
      handled: true,
      responseMessage: `🚫 Action cancelled, Admin. The ${action.type.replace("_", " ")} was not sent.`,
    };
  }

  try {
    if (action.type === "daily_rundown") {
      const res = await postDailySummaryToGoogleChat(action.payload?.customMessage as string | undefined);
      if (res.ok) {
        return {
          handled: true,
          responseMessage: "✅ Done, Admin! Daily operations & revenue rundown posted to Google Chat! 🚀",
        };
      }
      return {
        handled: true,
        responseMessage: `⚠️ Failed to post rundown to Google Chat: ${res.message}`,
      };
    }

    if (action.type === "weekly_report") {
      const res = await postWeeklySummaryToGoogleChat(action.payload?.customMessage as string | undefined);
      if (res.ok) {
        return {
          handled: true,
          responseMessage: "✅ Done, Admin! Weekly executive report posted to Google Chat! 🚀",
        };
      }
      return {
        handled: true,
        responseMessage: `⚠️ Failed to post weekly report to Google Chat: ${res.message}`,
      };
    }

    if (action.type === "broadcast") {
      const res = await executeCustomerBroadcast({
        adminPhone,
      });
      return {
        handled: true,
        responseMessage: res.message,
      };
    }
  } catch (err) {
    logWarn("admin_actions", "failed to execute pending admin action", formatError(err));
    return {
      handled: true,
      responseMessage: `⚠️ Error executing action: ${String(formatError(err).message || err)}`,
    };
  }

  return { handled: false };
}

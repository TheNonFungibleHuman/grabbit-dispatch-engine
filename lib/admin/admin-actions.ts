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
  ttlMinutes = 240, // 4 hours valid
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

  const isAffirmative =
    cleanText === "yes" ||
    cleanText === "y" ||
    cleanText === "send" ||
    cleanText === "post" ||
    cleanText === "confirm" ||
    cleanText === "ok" ||
    cleanText === "looks good" ||
    cleanText === "go ahead" ||
    cleanText.startsWith("yes") ||
    cleanText.startsWith("send it") ||
    cleanText.startsWith("post it");

  const isNegative =
    cleanText === "no" ||
    cleanText === "n" ||
    cleanText === "cancel" ||
    cleanText === "dont send" ||
    cleanText.startsWith("cancel");

  if (!isAffirmative && !isNegative) {
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

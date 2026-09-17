import { isAuthorizedRiderOrAdmin, type RiderProfile } from "./config.ts";
import { findLatestActiveBookingForRider, savePreBooking, type PreBooking } from "../orders/pre-booking.ts";
import { sendCustomerText } from "../wasender/send-tracked.ts";
import { readJson, writeJson } from "../blob/json-store.ts";
import { formatError, logInfo, logWarn } from "../log.ts";
import { mauritiusClockLabel, parseTimeToMinutes } from "../time.ts";

export interface RiderStatusState {
  breaks: Record<string, { onBreak: boolean; untilIso?: string; untilTimeStr?: string; startedAt: string }>;
  maintenance?: {
    active: boolean;
    untilTimeStr: string;
    reason?: string;
    startedAt: string;
    /** Hard epoch-ms deadline — maintenance can NEVER outlive this (phantom-pause guard). */
    expiresAtMs?: number;
  };
}

const RIDER_STATUS_PATH = "grabbit/riders/status.json";

export interface RiderCommandResult {
  handled: boolean;
  replyText?: string;
  action?: "completed_booking" | "started_break" | "ended_break";
  booking?: PreBooking;
}

export function isRiderOnBreak(riderName: string, breaks: RiderStatusState["breaks"]): boolean {
  const riderKey = riderName.toLowerCase();
  const entry = breaks[riderKey];
  if (!entry || !entry.onBreak) return false;
  if (entry.untilIso && new Date(entry.untilIso).getTime() <= Date.now()) {
    return false; // Break expired
  }
  return true;
}

export async function getRiderBreakStatus(riderName: string): Promise<boolean> {
  try {
    const state = (await readJson<RiderStatusState>(RIDER_STATUS_PATH)) || { breaks: {} };
    return isRiderOnBreak(riderName, state.breaks);
  } catch {
    return false;
  }
}

/** Maintenance windows can never outlive this — phantom-pause hard cap. */
const MAX_MAINTENANCE_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Converts a Mauritius wall-clock "until" label into a hard epoch-ms deadline.
 * If the target time has already passed today, the window is treated as already
 * expired (0 duration) — we never roll it forward into a day-long phantom pause.
 */
function computeMaintenanceExpiryMs(untilTimeStr: string, from = new Date()): number {
  const targetMin = parseTimeToMinutes(untilTimeStr);
  if (targetMin === null) {
    return from.getTime() + 4 * 60 * 60 * 1000; // unparseable → bounded 4h fallback
  }
  const nowMin = from.getUTCHours() * 60 + from.getUTCMinutes() + 4 * 60; // Mauritius = UTC+4 (no DST)
  const nowMinOfDay = nowMin % (24 * 60);
  const deltaMin = targetMin - nowMinOfDay;
  if (deltaMin <= 0) {
    // "until 5:00 pm" requested after 5:00 pm — expired on arrival, no pause.
    return from.getTime() - 1;
  }
  return from.getTime() + Math.min(deltaMin, 12 * 60) * 60 * 1000;
}

export async function setFleetMaintenanceWindow(untilTimeStr: string, reason?: string): Promise<void> {
  try {
    const startedAt = new Date();
    const rawExpiry = computeMaintenanceExpiryMs(untilTimeStr.trim(), startedAt);
    const expiresAtMs = Math.min(rawExpiry, startedAt.getTime() + MAX_MAINTENANCE_WINDOW_MS);
    const state = (await readJson<RiderStatusState>(RIDER_STATUS_PATH)) || { breaks: {} };
    state.maintenance = {
      active: rawExpiry > Date.now(),
      untilTimeStr: untilTimeStr.trim(),
      reason: reason?.trim() || "Fleet maintenance",
      startedAt: startedAt.toISOString(),
      expiresAtMs: expiresAtMs,
    };
    await writeJson(RIDER_STATUS_PATH, state);
    logInfo("riders", "set fleet maintenance window", {
      untilTimeStr,
      reason,
      expiresAtMs: expiresAtMs,
      maxWindowMs: MAX_MAINTENANCE_WINDOW_MS,
    });
  } catch (err) {
    logWarn("riders", "failed to set fleet maintenance window", formatError(err));
  }
}

export async function clearFleetMaintenanceWindow(): Promise<void> {
  try {
    const state = (await readJson<RiderStatusState>(RIDER_STATUS_PATH)) || { breaks: {} };
    if (state.maintenance) {
      state.maintenance.active = false;
      await writeJson(RIDER_STATUS_PATH, state);
      logInfo("riders", "cleared fleet maintenance window");
    }
  } catch (err) {
    logWarn("riders", "failed to clear fleet maintenance window", formatError(err));
  }
}

export async function getFleetMaintenanceStatus(): Promise<{ active: boolean; untilTimeStr?: string; reason?: string }> {
  try {
    const state = (await readJson<RiderStatusState>(RIDER_STATUS_PATH)) || { breaks: {} };
    const maint = state.maintenance;
    if (!maint?.active) return { active: false };

    // Phantom-pause guard: a maintenance window MUST auto-expire. Legacy
    // entries without expiresAtMs fall back to startedAt + 12h hard cap.
    // (Sept 2026 incidents: windows set by the agent lingered for days,
    // rejecting real customers until an admin manually cleared them.)
    const nowMs = Date.now();
    const startedMs = Date.parse(maint.startedAt || "") || 0;
    let expiresAt =
      typeof maint.expiresAtMs === "number" && Number.isFinite(maint.expiresAtMs)
        ? maint.expiresAtMs
        : startedMs + MAX_MAINTENANCE_WINDOW_MS;
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) expiresAt = nowMs; // corrupt record → expire now
    if (!Number.isFinite(startedMs) || startedMs <= 0) {
      // No valid startedAt: only honour an explicit future expiry
      if (expiresAt <= nowMs) expiresAt = nowMs;
    }

    if (nowMs >= expiresAt) {
      maint.active = false;
      await writeJson(RIDER_STATUS_PATH, state);
      logInfo("riders", "maintenance window auto-expired", {
        untilTimeStr: maint.untilTimeStr,
        expiresAtMs: expiresAt,
      });
      return { active: false };
    }

    return { active: true, untilTimeStr: maint.untilTimeStr, reason: maint.reason };
  } catch {
    return { active: false };
  }
}

export async function handleRiderCommand(args: {
  senderPhone: string;
  messageText: string;
  rider: RiderProfile;
}): Promise<RiderCommandResult> {
  const text = args.messageText.trim().toLowerCase();
  const riderName = args.rider.name;

  // 1. Check "Delivered" / "Done" / "Completed"
  if (/^(done|delivered|trip completed|order completed|finished|drop completed|drop done|dropped|completed|run completed)[.!]?$/i.test(text)) {
    const activeBooking = await findLatestActiveBookingForRider(riderName);

    if (!activeBooking) {
      return {
        handled: true,
        replyText: `Hi ${riderName}! You don't have any active bookings marked in progress right now. All caught up! 🛵`,
      };
    }

    // Mark completed
    activeBooking.status = "completed";
    const { recordMetric } = await import("../metrics/recorder.ts");
    void recordMetric("booking_completed_rider");
    activeBooking.updatedAt = new Date().toISOString();
    await savePreBooking(activeBooking);

    logInfo("riders", "rider marked booking as completed via 1-word command", {
      rider: riderName,
      bookingId: activeBooking.id,
      customer: activeBooking.customerPhone,
    });

    // Send thank-you wrap-up to customer
    try {
      const customerMsg = `🛵 *Trip / Delivery Completed!*\nYour run with ${riderName} has been completed. Thank you for choosing Grabbit Express! Have a wonderful day! 😊`;
      await sendCustomerText({
        to: activeBooking.customerPhone,
        text: customerMsg,
      });
      logInfo("riders", "dispatched completion wrap-up to customer", {
        customer: activeBooking.customerPhone,
      });
    } catch (custErr) {
      logWarn("riders", "failed to send wrap-up to customer", formatError(custErr));
    }

    const route = `${activeBooking.pickupAddress} → ${activeBooking.deliveryAddress}`;
    return {
      handled: true,
      action: "completed_booking",
      booking: activeBooking,
      replyText: `✅ *Run Completed!*\nMarked run for *${activeBooking.customerName || "Customer"}* (${route}) as completed. You are now free for your next runs! 🛵💨`,
    };
  }

  // 2. Check "Break [Xm]" / "On Break"
  const breakMatch = text.match(/^(?:break\s*(\d+)?m?|on\s*break|taking\s*a?\s*break|pause\s*(\d+)?m?)[.!]?$/i);
  if (breakMatch) {
    const minutes = Number(breakMatch[1] || breakMatch[2]) || 15; // default 15 mins
    const now = new Date();
    const until = new Date(now.getTime() + minutes * 60 * 1000);
    const mauritiusUntilTime = mauritiusClockLabel(until);

    const state = (await readJson<RiderStatusState>(RIDER_STATUS_PATH)) || { breaks: {} };
    state.breaks[riderName.toLowerCase()] = {
      onBreak: true,
      untilIso: until.toISOString(),
      untilTimeStr: mauritiusUntilTime,
      startedAt: now.toISOString(),
    };
    await writeJson(RIDER_STATUS_PATH, state);

    logInfo("riders", "rider logged break", { rider: riderName, minutes, untilTime: mauritiusUntilTime });

    return {
      handled: true,
      action: "started_break",
      replyText: `☕ *Break Logged (${minutes} mins)*\nYou are marked on break until *${mauritiusUntilTime}*. System will route new requests to other available riders. Text *Back* when you return!`,
    };
  }

  // 3. Check "Back" / "Available" / "Ready"
  if (/^(back|available|active|ready|am ready|i am ready|i'm ready|im ready|ready now|online|resumed)[.!]?$/i.test(text)) {
    const state = (await readJson<RiderStatusState>(RIDER_STATUS_PATH)) || { breaks: {} };
    state.breaks[riderName.toLowerCase()] = {
      onBreak: false,
      startedAt: new Date().toISOString(),
    };
    await writeJson(RIDER_STATUS_PATH, state);

    logInfo("riders", "rider ended break", { rider: riderName });

    return {
      handled: true,
      action: "ended_break",
      replyText: `🟢 *Welcome Back, ${riderName}!*\nYou are marked active and ready for dispatches. Safe riding! 🛵`,
    };
  }

  return { handled: false };
}

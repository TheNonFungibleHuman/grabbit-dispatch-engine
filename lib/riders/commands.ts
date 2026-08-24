import { isAuthorizedRiderOrAdmin, type RiderProfile } from "./config.ts";
import { listAllPreBookings, savePreBooking, type PreBooking } from "../orders/pre-booking.ts";
import { sendCustomerText } from "../wasender/send-tracked.ts";
import { readJson, writeJson } from "../blob/json-store.ts";
import { formatError, logInfo, logWarn } from "../log.ts";

export interface RiderStatusState {
  breaks: Record<string, { onBreak: boolean; untilIso?: string; untilTimeStr?: string; startedAt: string }>;
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

export async function handleRiderCommand(args: {
  senderPhone: string;
  messageText: string;
  rider: RiderProfile;
}): Promise<RiderCommandResult> {
  const text = args.messageText.trim().toLowerCase();
  const riderName = args.rider.name;

  // 1. Check "Delivered" / "Done" / "Completed"
  if (/^(done|delivered|trip completed|order completed|finished|drop completed|drop done|dropped|completed|run completed)[.!]?$/i.test(text)) {
    const all = await listAllPreBookings();
    const riderLower = riderName.toLowerCase();

    // Find rider's most recent active booking
    const activeBooking = all
      .filter((b) => {
        if (!b.assignedRider.toLowerCase().includes(riderLower)) return false;
        return b.status === "confirmed" || b.status === "pending_rider" || b.status === "dispatched";
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

    if (!activeBooking) {
      return {
        handled: true,
        replyText: `Hi ${riderName}! You don't have any active bookings marked in progress right now. All caught up! 🛵`,
      };
    }

    // Mark completed
    activeBooking.status = "completed";
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
    const mauritiusUntilTime = new Date(until.getTime() + 4 * 3600 * 1000).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

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

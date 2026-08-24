import { getAvailabilitySnapshot } from "./availability.ts";
import { listAllPreBookings } from "../orders/pre-booking.ts";
import { FLEET_RIDERS } from "../riders/config.ts";
import { sendCustomerText } from "../wasender/send-tracked.ts";
import { readJson, writeJson } from "../blob/json-store.ts";
import { formatError, logInfo, logWarn } from "../log.ts";

export interface MorningBriefingState {
  lastSentDateIso?: string;
  sentAt?: string;
  riderSummaries: Record<string, string>;
}

const BRIEFING_STATE_PATH = "grabbit/ops/morning-briefing.json";

export interface RiderDaySchedule {
  riderName: string;
  weekday: string;
  dateIso: string;
  shiftSlots: string[];
  assignedBookings: Array<{
    time: string;
    route: string;
    customer: string;
    serviceKind: string;
  }>;
  briefingText: string;
}

export async function generateMorningRiderBriefing(
  riderName: string,
  now = new Date(),
): Promise<RiderDaySchedule | null> {
  const snapshot = await getAvailabilitySnapshot(now);
  const weekday = snapshot.weekday;
  const todayMauritiusIso = new Date(now.getTime() + 4 * 3600 * 1000).toISOString().slice(0, 10);

  // Find all slots where rider is on duty
  const todaySlotInfo = snapshot.upcomingDays.find((d) => d.daysAhead === 0);
  if (!todaySlotInfo) return null;

  const riderLower = riderName.toLowerCase();
  const shiftSlots = todaySlotInfo.openSlots
    .filter((s) => s.riders.some((r) => r.toLowerCase().includes(riderLower)))
    .map((s) => s.label);

  if (shiftSlots.length === 0) {
    return null; // Rider not scheduled on duty today
  }

  // Find assigned bookings for today
  const allBookings = await listAllPreBookings();
  const assigned = allBookings.filter((b) => {
    if (!b.assignedRider.toLowerCase().includes(riderLower)) return false;
    if (b.status !== "confirmed" && b.status !== "pending_rider") return false;
    const bDate = b.scheduledDate || b.createdAt.slice(0, 10);
    return bDate === todayMauritiusIso;
  });

  const assignedBookings = assigned.map((b) => ({
    time: b.scheduledTime || "Scheduled",
    route: `${b.pickupAddress} → ${b.deliveryAddress}`,
    customer: b.customerName,
    serviceKind: b.serviceKind === "trip" ? "Passenger Ride" : "Delivery",
  }));

  const lines = [
    `Good morning ${riderName}! ☀️ Here is your Grabbit shift briefing for today (${weekday}, ${todayMauritiusIso}):`,
    "",
    "🛵 *Your On-Duty Shift Slots:*",
    ...shiftSlots.map((s) => `• ${s}`),
    "",
    "📋 *Pre-Booked Runs Today:*",
    assignedBookings.length > 0
      ? assignedBookings.map((b) => `• *${b.time}* — ${b.route} (${b.customer}, ${b.serviceKind})`).join("\n")
      : "• No advance bookings yet. Be ready for incoming on-demand dispatches!",
    "",
    "Have a safe and smooth day on the road! 🚀",
  ];

  return {
    riderName,
    weekday,
    dateIso: todayMauritiusIso,
    shiftSlots,
    assignedBookings,
    briefingText: lines.join("\n"),
  };
}

export async function sendDailyMorningBriefings(now = new Date()): Promise<{
  dateIso: string;
  sentCount: number;
  results: Record<string, boolean>;
}> {
  const todayMauritiusIso = new Date(now.getTime() + 4 * 3600 * 1000).toISOString().slice(0, 10);
  const results: Record<string, boolean> = {};

  const state = (await readJson<MorningBriefingState>(BRIEFING_STATE_PATH)) || {
    riderSummaries: {},
  };

  if (state.lastSentDateIso === todayMauritiusIso) {
    logInfo("briefing", "morning briefing already sent for today", { date: todayMauritiusIso });
    return { dateIso: todayMauritiusIso, sentCount: 0, results: {} };
  }

  let sentCount = 0;

  for (const rider of FLEET_RIDERS) {
    try {
      const schedule = await generateMorningRiderBriefing(rider.name, now);
      if (!schedule) continue;

      state.riderSummaries[rider.name] = schedule.briefingText;

      if (rider.channel === "whatsapp" && rider.phone) {
        await sendCustomerText({
          to: rider.phone,
          text: schedule.briefingText,
        });
        results[rider.name] = true;
        sentCount++;
        logInfo("briefing", "dispatched morning briefing via whatsapp", { rider: rider.name });
      } else {
        // Google Chat webhook for Moses / Group
        const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL?.trim();
        if (webhookUrl) {
          const gchatText = `*MORNING SHIFT BRIEFING: ${rider.name.toUpperCase()}*\n\n${schedule.briefingText}`;
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: gchatText }),
          });
        }
        results[rider.name] = true;
        sentCount++;
        logInfo("briefing", "dispatched morning briefing via google chat", { rider: rider.name });
      }
    } catch (err) {
      logWarn("briefing", "failed to send morning briefing to rider", {
        rider: rider.name,
        error: formatError(err),
      });
      results[rider.name] = false;
    }
  }

  state.lastSentDateIso = todayMauritiusIso;
  state.sentAt = new Date().toISOString();
  await writeJson(BRIEFING_STATE_PATH, state);

  return {
    dateIso: todayMauritiusIso,
    sentCount,
    results,
  };
}

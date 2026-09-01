import { listAllPreBookings, type PreBooking } from "../orders/pre-booking.ts";
import { estimateBookingFare as computeFare } from "../pricing/fares.ts";
import { sendCustomerText } from "../wasender/send-tracked.ts";
import { appendTranscriptEntry } from "../agent/transcript.ts";
import { readJson, writeJson } from "../blob/json-store.ts";
import { formatError, logError, logInfo, logWarn } from "../log.ts";
import { mauritiusDateIso, mauritiusMinutesOfDay } from "../time.ts";

import { ADMIN_PHONES } from "../riders/config.ts";

export const SHERIF_PHONE = "+999000000008";
export const DAILY_RUNDOWN_PATH = "grabbit/ops/daily-rundown.json";

export interface DailyRundownState {
  lastSentDate?: string;
  lastDraftMessage?: string;
  postedToGoogleChatDate?: string;
}

export function estimateBookingFare(booking: PreBooking): number {
  return computeFare(booking);
}

export async function generateDailyTripsRundown(targetDateIso?: string): Promise<{
  dateStr: string;
  totalBookings: number;
  totalRevenue: number;
  summaryText: string;
  googleChatText: string;
  bookings: PreBooking[];
}> {
  const now = new Date();
  // Mauritius is UTC+4
  const mauritiusIso = targetDateIso || mauritiusDateIso(now);
  const all = await listAllPreBookings();

  // Filter bookings for target date, excluding cancelled/declined
  const todaysBookings = all.filter((b) => {
    if (b.status === "cancelled" || b.status === "declined") return false;
    if (b.scheduledDate && b.scheduledDate === mauritiusIso) return true;
    if (!b.scheduledDate && b.createdAt.slice(0, 10) === mauritiusIso) return true;
    return false;
  });

  // Sort chronologically by time
  todaysBookings.sort((a, b) => (a.scheduledTime || "").localeCompare(b.scheduledTime || ""));

  let totalRevenue = 0;
  const lines: string[] = [];

  for (const b of todaysBookings) {
    const fare = estimateBookingFare(b);
    totalRevenue += fare;
    const kind = b.serviceKind === "trip" ? (b.tripType === "round_trip" ? "🚗 Trip (Round)" : "🚗 Trip (One-way)") : "🛵 Delivery";
    lines.push(
      `• *${b.scheduledTime || "Flexible"}*, ${kind}: ${b.pickupAddress} → ${b.deliveryAddress} (${b.customerName || "Customer"}, Rider: *${b.assignedRider}*) — *Rs ${fare}*`
    );
  }

  const formattedDate = new Date(mauritiusIso + "T00:00:00Z").toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "short",
  });

  const summaryHeader = `📋 *Grabbit Daily Operations & Fares Rundown*\n📅 *${formattedDate}* (${mauritiusIso})\n`;
  const summaryBody = lines.length > 0 ? lines.join("\n") : "_No trips or deliveries booked for today._";
  const summaryFooter = `\n\n📊 *Total Bookings:* ${todaysBookings.length}\n💰 *Total Fares / Revenue:* *Rs ${totalRevenue}*`;

  const summaryText = `${summaryHeader}\n${summaryBody}${summaryFooter}`;

  const promptForSherif = [
    `Hi Sherif! 👋 Here is today's full daily trips and revenue rundown for *${formattedDate}*:`,
    ``,
    summaryText,
    ``,
    `Would you like me to post this daily summary to Google Chat now?`,
    `👉 Reply *YES* to confirm and send to Google Chat, or let me know if you would like to edit or add any trips first! 😊`,
  ].join("\n");

  const googleChatText = [
    `📊 *GRABBIT DAILY OPERATIONS & REVENUE RUNDOWN*`,
    `📅 *Date:* ${formattedDate} (${mauritiusIso})`,
    ``,
    summaryBody,
    ``,
    `*Summary:*`,
    `• Total Bookings: ${todaysBookings.length}`,
    `• Total Revenue Collected / Expected: *Rs ${totalRevenue}*`,
    `_Grabbit Express Dispatch Team 🛵⚡_`,
  ].join("\n");

  return {
    dateStr: mauritiusIso,
    totalBookings: todaysBookings.length,
    totalRevenue,
    summaryText: promptForSherif,
    googleChatText,
    bookings: todaysBookings,
  };
}

export async function sendDailyRundownDraftToSherif(targetDateIso?: string): Promise<{
  ok: boolean;
  sentDate: string;
  totalBookings: number;
  totalRevenue: number;
}> {
  const rundown = await generateDailyTripsRundown(targetDateIso);

  const recipients = ADMIN_PHONES.length > 0 ? ADMIN_PHONES : [SHERIF_PHONE];
  for (const phone of recipients) {
    try {
      await sendCustomerText({
        to: phone,
        text: rundown.summaryText,
        messageId: `rundown_admin_${Date.now()}_${phone.replace(/\D/g, "").slice(-4)}`,
      });

      await appendTranscriptEntry(phone, {
        role: "agent",
        text: rundown.summaryText,
      });
    } catch (err) {
      logWarn("rundown", "failed to send rundown to admin phone", { phone, ...formatError(err) });
    }
  }

  const state: DailyRundownState = (await readJson<DailyRundownState>(DAILY_RUNDOWN_PATH)) || {};
  state.lastSentDate = rundown.dateStr;
  state.lastDraftMessage = rundown.googleChatText;
  await writeJson(DAILY_RUNDOWN_PATH, state);

  logInfo("rundown", "sent 8:30pm daily rundown draft to Admins on WhatsApp", {
    date: rundown.dateStr,
    totalBookings: rundown.totalBookings,
    totalRevenue: rundown.totalRevenue,
    recipients,
  });

  return {
    ok: true,
    sentDate: rundown.dateStr,
    totalBookings: rundown.totalBookings,
    totalRevenue: rundown.totalRevenue,
  };
}

export async function postDailySummaryToGoogleChat(customMessage?: string): Promise<{
  ok: boolean;
  message: string;
}> {
  const state: DailyRundownState = (await readJson<DailyRundownState>(DAILY_RUNDOWN_PATH)) || {};
  const messageToSend = customMessage || state.lastDraftMessage;

  if (!messageToSend) {
    const fresh = await generateDailyTripsRundown();
    return postDailySummaryToGoogleChat(fresh.googleChatText);
  }

  const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    return { ok: false, message: "GOOGLE_CHAT_WEBHOOK_URL is not configured." };
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: messageToSend,
      }),
    });

    if (res.ok) {
      state.postedToGoogleChatDate = new Date().toISOString().slice(0, 10);
      await writeJson(DAILY_RUNDOWN_PATH, state);
      logInfo("rundown", "posted daily summary to Google Chat");
      return { ok: true, message: "Successfully posted daily operations summary to Google Chat! 🚀" };
    }

    return { ok: false, message: `Google Chat returned status ${res.status}: ${res.statusText}` };
  } catch (err) {
    logError("rundown", "failed to post summary to Google Chat", err);
    return { ok: false, message: String(formatError(err).message || err) };
  }
}

/**
 * Checks if it is 8:30 PM in Mauritius (20:30 to 21:30) and sends today's rundown to Admins.
 */
export async function processDailyRundownCron(now = new Date()): Promise<{ triggered: boolean; reason?: string }> {
  const minutesOfDay = mauritiusMinutesOfDay(now);
  const mauritiusHours = Math.floor(minutesOfDay / 60);
  const mauritiusMinutes = minutesOfDay % 60;
  const todayIso = mauritiusDateIso(now);

  // Check if current time is between 8:30 PM (20:30) and 9:30 PM (21:30)
  const isAround830PM =
    (mauritiusHours === 20 && mauritiusMinutes >= 30) ||
    (mauritiusHours === 21 && mauritiusMinutes <= 30);

  if (!isAround830PM) {
    return { triggered: false, reason: `Not 8:30 PM Mauritius time (current: ${mauritiusHours}:${mauritiusMinutes < 10 ? '0' : ''}${mauritiusMinutes})` };
  }

  const state: DailyRundownState = (await readJson<DailyRundownState>(DAILY_RUNDOWN_PATH)) || {};
  if (state.lastSentDate === todayIso) {
    return { triggered: false, reason: `Daily rundown for ${todayIso} already sent to Admins` };
  }

  await sendDailyRundownDraftToSherif(todayIso);
  return { triggered: true };
}

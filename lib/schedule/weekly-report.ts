import { listAllPreBookings, type PreBooking } from "../orders/pre-booking.ts";
import { estimateBookingFare, SHERIF_PHONE } from "./daily-rundown.ts";
import { sendCustomerText } from "../wasender/send-tracked.ts";
import { readJson, writeJson } from "../blob/json-store.ts";
import { addDaysIso, mauritiusDateIso, mauritiusMinutesOfDay, mauritiusWeekday } from "../time.ts";
import { formatError, logError, logInfo, logWarn } from "../log.ts";

export interface WeeklyReportState {
  lastSentWeekIso?: string;
  sentAt?: string;
  lastSummaryText?: string;
}

const WEEKLY_REPORT_STATE_PATH = "grabbit/ops/weekly-report.json";

export interface WeeklyReportData {
  startDateIso: string;
  endDateIso: string;
  totalBookings: number;
  completedBookings: number;
  cancelledBookings: number;
  totalTrips: number;
  totalDeliveries: number;
  totalRevenue: number;
  riderStats: Record<string, { runs: number; revenue: number }>;
  busiestDay: string;
  summaryText: string;
}

export async function generateWeeklyExecutiveReport(referenceDate = new Date()): Promise<WeeklyReportData> {
  const allBookings = await listAllPreBookings();

  // Calculate past 7 days (Monday through Sunday)
  const endIso = mauritiusDateIso(referenceDate);
  const startIso = addDaysIso(endIso, -6);

  const weekBookings = allBookings.filter((b) => {
    const bDate = b.scheduledDate || b.createdAt.slice(0, 10);
    return bDate >= startIso && bDate <= endIso;
  });

  let totalRevenue = 0;
  let completedBookings = 0;
  let cancelledBookings = 0;
  let totalTrips = 0;
  let totalDeliveries = 0;

  const dayCounts: Record<string, number> = {};
  const riderStats: Record<string, { runs: number; revenue: number }> = {
    Thierry: { runs: 0, revenue: 0 },
    Moses: { runs: 0, revenue: 0 },
    Sherif: { runs: 0, revenue: 0 },
  };

  for (const b of weekBookings) {
    if (b.status === "cancelled" || b.status === "declined") {
      cancelledBookings++;
      continue;
    }

    const fare = estimateBookingFare(b);
    totalRevenue += fare;
    completedBookings++;

    if (b.serviceKind === "trip") {
      totalTrips++;
    } else {
      totalDeliveries++;
    }

    // Day distribution
    const bDate = b.scheduledDate || b.createdAt.slice(0, 10);
    dayCounts[bDate] = (dayCounts[bDate] || 0) + 1;

    // Rider stats
    const rider = b.assignedRider || "Unassigned";
    let matchedRider = "Other";
    if (rider.toLowerCase().includes("thierry")) matchedRider = "Thierry";
    else if (rider.toLowerCase().includes("moses")) matchedRider = "Moses";
    else if (rider.toLowerCase().includes("sherif")) matchedRider = "Sherif";

    if (!riderStats[matchedRider]) {
      riderStats[matchedRider] = { runs: 0, revenue: 0 };
    }
    riderStats[matchedRider].runs++;
    riderStats[matchedRider].revenue += fare;
  }

  // Find busiest day
  let busiestDay = "N/A";
  let maxDayRuns = 0;
  for (const [day, count] of Object.entries(dayCounts)) {
    if (count > maxDayRuns) {
      maxDayRuns = count;
      busiestDay = day;
    }
  }

  const successRate = weekBookings.length > 0
    ? Math.round((completedBookings / weekBookings.length) * 100)
    : 100;

  const lines = [
    "📊 *GRABBIT WEEKLY EXECUTIVE OPERATIONS & REVENUE REPORT*",
    `📅 *Period:* ${startIso} to ${endIso}`,
    "",
    "💰 *Weekly Financial & Volume Summary:*",
    `• Total Revenue / Fares: *Rs ${totalRevenue}*`,
    `• Total Runs Completed: *${completedBookings}* (Success Rate: ${successRate}%)`,
    `  ↳ Passenger Rides: *${totalTrips}* | Food & Package Deliveries: *${totalDeliveries}*`,
    cancelledBookings > 0 ? `• Cancelled/Declined: *${cancelledBookings}*` : "",
    "",
    "🛵 *Fleet Performance Breakdown:*",
    ...Object.entries(riderStats)
      .filter(([_, data]) => data.runs > 0)
      .map(([name, data]) => `• *${name}*: ${data.runs} runs (Rs ${data.revenue})`),
    "",
    "🏆 *Operations Highlights:*",
    `• Busiest Day: *${busiestDay}* (${maxDayRuns} runs)`,
    "• Top Corridors: ALCHE ⇄ Mahogany, ALCHE ⇄ Grand Baie Express",
    "",
    "Have a fantastic upcoming week! 🚀 Grabbit Operations",
    "",
    "💬 *Would you like me to send this weekly summary to Google Chat?* Reply *YES* (or tell me what to modify/send specifically).",
  ].filter(Boolean);

  const summaryText = lines.join("\n");

  return {
    startDateIso: startIso,
    endDateIso: endIso,
    totalBookings: weekBookings.length,
    completedBookings,
    cancelledBookings,
    totalTrips,
    totalDeliveries,
    totalRevenue,
    riderStats,
    busiestDay,
    summaryText,
  };
}

export async function postWeeklySummaryToGoogleChat(customMessage?: string): Promise<{ ok: boolean; message: string }> {
  const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    return { ok: false, message: "Google Chat webhook URL is not configured." };
  }

  const state = (await readJson<WeeklyReportState>(WEEKLY_REPORT_STATE_PATH)) || {};
  const messageToSend = customMessage?.trim() || state.lastSummaryText || "Weekly report not found.";

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: messageToSend }),
    });

    if (res.ok) {
      logInfo("weekly_report", "posted weekly summary to Google Chat upon Sherif approval");
      return { ok: true, message: "Successfully posted weekly operations report to Google Chat! 🚀" };
    }
    return { ok: false, message: `Google Chat returned status ${res.status}: ${res.statusText}` };
  } catch (err) {
    logError("weekly_report", "failed to post weekly summary to Google Chat", err);
    return { ok: false, message: String(formatError(err).message || err) };
  }
}

export async function processWeeklyReportCron(now = new Date()): Promise<{ triggered: boolean; reason?: string }> {
  // Mauritius is UTC+4
  const mauritiusDay = mauritiusWeekday(now); // 0 is Sunday
  const minutesOfDay = mauritiusMinutesOfDay(now);
  const mauritiusHours = Math.floor(minutesOfDay / 60);
  const mauritiusMinutes = minutesOfDay % 60;
  const todayIso = mauritiusDateIso(now);

  // Check if today is Sunday and time is around 9:00 PM (21:00 - 21:30)
  const isSundayNight = mauritiusDay === 0 && mauritiusHours === 21 && mauritiusMinutes <= 30;
  if (!isSundayNight) {
    return { triggered: false, reason: "Not Sunday 9:00 PM Mauritius time" };
  }

  const state = (await readJson<WeeklyReportState>(WEEKLY_REPORT_STATE_PATH)) || {};
  if (state.lastSentWeekIso === todayIso) {
    return { triggered: false, reason: `Weekly report for week ending ${todayIso} already sent` };
  }

  const report = await generateWeeklyExecutiveReport(now);

  try {
    // Send exclusively to Sherif on WhatsApp
    await sendCustomerText({
      to: SHERIF_PHONE,
      text: report.summaryText,
    });

    try {
      const { appendTranscriptEntry } = await import("../agent/transcript.ts");
      await appendTranscriptEntry(SHERIF_PHONE, {
        role: "agent",
        text: report.summaryText,
      });
    } catch {}

    state.lastSentWeekIso = todayIso;
    state.sentAt = new Date().toISOString();
    state.lastSummaryText = report.summaryText;
    await writeJson(WEEKLY_REPORT_STATE_PATH, state);

    logInfo("weekly_report", "dispatched Sunday weekly report exclusively to Sherif on WhatsApp", {
      weekEnding: todayIso,
      totalRevenue: report.totalRevenue,
    });

    return { triggered: true };
  } catch (err) {
    logWarn("weekly_report", "failed to dispatch weekly report", formatError(err));
    return { triggered: false, reason: String(formatError(err).message || err) };
  }
}

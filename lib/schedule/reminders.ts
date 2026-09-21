import { listActiveBookingsOnDate, savePreBooking, parseTimeToMinutes, autoExpireStaleBookings } from "../orders/pre-booking.ts";
import { notifyRiderRideReminder } from "../riders/notify-rider.ts";
import { formatError, logInfo, logWarn } from "../log.ts";
import { mauritiusDateIso, mauritiusMinutesOfDay } from "../time.ts";

export function shouldSendRideReminder(scheduledMin: number, nowMinutes: number): boolean {
  const diff = scheduledMin - nowMinutes;
  return diff >= 15 && diff <= 30;
}

/**
 * Late catch-up band: if the scheduler was delayed and we first see the
 * booking inside [5, 15) minutes before start, still send the reminder once —
 * a late reminder beats a missed one. With a healthy 5-minute heartbeat the
 * primary band fires first and this never triggers (reminderSent is set).
 */
export function shouldSendLateReminder(scheduledMin: number, nowMinutes: number): boolean {
  const diff = scheduledMin - nowMinutes;
  return diff >= 5 && diff < 15;
}

/**
 * Checks all active bookings and triggers reminders to riders ~25 minutes before start.
 */
export async function processUpcomingBookingReminders(now = new Date()): Promise<{
  processed: number;
  reminded: string[];
}> {
  const todayMauritiusIso = mauritiusDateIso(now);
  const mauritiusMinutes = mauritiusMinutesOfDay(now);

  logInfo("reminders", "cron heartbeat", {
    mauritiusTime: `${Math.floor(mauritiusMinutes / 60)}:${String(mauritiusMinutes % 60).padStart(2, "0")}`,
    todayIso: todayMauritiusIso,
  });

  // Auto-expire stale past-day bookings to completed/cancelled
  try {
    await autoExpireStaleBookings(now);
  } catch (expireErr) {
    logWarn("reminders", "autoExpireStaleBookings error", formatError(expireErr));
  }

  // Auto-clear stale past-day escalations and clear all at End of Day
  try {
    const { autoClearDailyEscalations } = await import("../ops/store.ts");
    await autoClearDailyEscalations(now);
  } catch (escExpireErr) {
    logWarn("reminders", "autoClearDailyEscalations error", formatError(escExpireErr));
  }

  const active = (await listActiveBookingsOnDate(todayMauritiusIso)).filter(
    (b) => !b.reminderSent,
  );

  const reminded: string[] = [];

  for (const booking of active) {
    if (!booking.scheduledTime) continue;

    const scheduledMin = parseTimeToMinutes(booking.scheduledTime);
    if (scheduledMin === null) continue;

    const isPrimary = shouldSendRideReminder(scheduledMin, mauritiusMinutes);
    const isLate = shouldSendLateReminder(scheduledMin, mauritiusMinutes);
    if (!isPrimary && !isLate) continue;

    logInfo("reminders", isPrimary ? "triggering 25-min reminder for rider" : "late catch-up reminder (scheduler delay)", {
      bookingId: booking.id,
      rider: booking.assignedRider,
      time: booking.scheduledTime,
      diffMinutes: scheduledMin - mauritiusMinutes,
    });

    // Claim first, revert on failure: concurrent heartbeat runs (or the two
    // daily Vercel crons racing a GHA ping) must never double-send. The
    // at-most-once flag is durable BEFORE the send; a failed send reverts it
    // so the next heartbeat retries.
    booking.reminderSent = true;
    booking.updatedAt = new Date().toISOString();
    await savePreBooking(booking);

    try {
      await notifyRiderRideReminder({
        assignedRider: booking.assignedRider,
        customerName: booking.customerName || "Customer",
        customerPhone: booking.customerPhone,
        scheduledTime: booking.scheduledTime,
        pickupAddress: booking.pickupAddress,
        dropoffAddress: booking.deliveryAddress,
        serviceKind: booking.serviceKind,
        trackingUrl: booking.trackingUrl,
      });
      reminded.push(booking.id);
    } catch (err) {
      logWarn("reminders", "failed to dispatch ride reminder; will retry next heartbeat", {
        bookingId: booking.id,
        ...formatError(err),
      });
      booking.reminderSent = false;
      booking.updatedAt = new Date().toISOString();
      await savePreBooking(booking);
    }
  }

  // Check 7:30 AM Mauritius morning shift briefing for fleet riders (7:30 - 8:15 AM)
  try {
    const mauritiusHour = Math.floor(mauritiusMinutes / 60) % 24;
    const mauritiusMin = mauritiusMinutes % 60;
    if ((mauritiusHour === 7 && mauritiusMin >= 30) || (mauritiusHour === 8 && mauritiusMin <= 30)) {
      const { sendDailyMorningBriefings } = await import("./morning-briefing.ts");
      await sendDailyMorningBriefings(now);
    }
  } catch (briefingErr) {
    logWarn("reminders", "morning briefing check error", formatError(briefingErr));
  }

  // Check 8:30 PM Mauritius daily rundown for Admins (8:30 - 9:30 PM)
  try {
    const { processDailyRundownCron } = await import("./daily-rundown.ts");
    await processDailyRundownCron(now);
  } catch (rundownErr) {
    logWarn("reminders", "daily rundown check error", formatError(rundownErr));
  }

  // Check 9:00 PM Sunday Mauritius weekly executive report
  try {
    const { processWeeklyReportCron } = await import("./weekly-report.ts");
    await processWeeklyReportCron(now);
  } catch (weeklyErr) {
    logWarn("reminders", "weekly report check error", formatError(weeklyErr));
  }

  // Daily self-healing sweep for booking files missing from the active index
  try {
    const { runDailyOrphanSweep } = await import("../orders/orphan-sweep.ts");
    await runDailyOrphanSweep(now);
  } catch (sweepErr) {
    logWarn("reminders", "orphan sweep check error", formatError(sweepErr));
  }

  return {
    processed: active.length,
    reminded,
  };
}

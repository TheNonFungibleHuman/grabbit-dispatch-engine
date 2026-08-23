import { listAllPreBookings, savePreBooking, parseTimeToMinutes } from "../orders/pre-booking.ts";
import { notifyRiderRideReminder } from "../riders/notify-rider.ts";
import { formatError, logInfo, logWarn } from "../log.ts";

/**
 * Checks all active bookings and triggers reminders to riders ~25 minutes before start.
 */
export async function processUpcomingBookingReminders(): Promise<{
  processed: number;
  reminded: string[];
}> {
  const all = await listAllPreBookings();
  const active = all.filter(
    (b) =>
      (b.status === "pending_rider" || b.status === "confirmed") &&
      !(b as any).reminderSent,
  );

  const now = new Date();
  const mauritiusMinutes = now.getUTCHours() * 60 + now.getUTCMinutes() + 240; // UTC+4

  const reminded: string[] = [];

  for (const booking of active) {
    if (!booking.scheduledTime) continue;

    const scheduledMin = parseTimeToMinutes(booking.scheduledTime);
    if (scheduledMin === null) continue;

    const diff = scheduledMin - mauritiusMinutes;

    // Trigger reminder if run is within 15 to 30 minutes (center ~25 min)
    if (diff >= 15 && diff <= 30) {
      logInfo("reminders", "triggering 25-min reminder for rider", {
        bookingId: booking.id,
        rider: booking.assignedRider,
        time: booking.scheduledTime,
        diffMinutes: diff,
      });

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

        (booking as any).reminderSent = true;
        booking.updatedAt = new Date().toISOString();
        await savePreBooking(booking);
        reminded.push(booking.id);
      } catch (err) {
        logWarn("reminders", "failed to dispatch ride reminder", {
          bookingId: booking.id,
          ...formatError(err),
        });
      }
    }
  }

  // Check 8:30 PM Mauritius daily rundown for Sherif
  try {
    const { processDailyRundownCron } = await import("./daily-rundown.ts");
    await processDailyRundownCron();
  } catch (rundownErr) {
    logWarn("reminders", "daily rundown check error", formatError(rundownErr));
  }

  return {
    processed: active.length,
    reminded,
  };
}

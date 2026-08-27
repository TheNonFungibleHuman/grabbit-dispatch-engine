import { redirect } from "next/navigation";
import { getAgentSwitchState } from "@/lib/admin/agent-switch";
import { isAdminAuthed } from "@/lib/admin/auth";
import { listAllPreBookings } from "@/lib/orders/pre-booking";
import {
  getAvailabilitySnapshot,
  summarizeAvailabilityForAdmin,
} from "@/lib/schedule/availability";
import { mauritiusDateIso } from "@/lib/time";
import { SlotsDashboard } from "./slots-dashboard";

export default async function AdminSlotsPage() {
  if (!(await isAdminAuthed())) {
    redirect("/admin/login");
  }

  const [rawBookings, agentSwitch, schedule] = await Promise.all([
    listAllPreBookings(),
    getAgentSwitchState({ bypassMemory: true }),
    getAvailabilitySnapshot(),
  ]);

  const todayIso = mauritiusDateIso(new Date());
  const allowedDates = new Set([
    mauritiusDateIso(new Date(), -2),
    mauritiusDateIso(new Date(), -1),
    todayIso,
    mauritiusDateIso(new Date(), 1),
  ]);

  const bookings = rawBookings.filter((b) => {
    if (b.status === "cancelled" || b.status === "declined") return false;
    const bDate =
      b.scheduledDate && b.scheduledDate !== "today" && b.scheduledDate !== "tomorrow"
        ? b.scheduledDate
        : b.slotKey?.split("_")[0] || b.createdAt?.slice(0, 10);
    return allowedDates.has(bDate) || (b.scheduledDate === "today" && allowedDates.has(todayIso));
  });

  return (
    <SlotsDashboard
      initialBookings={bookings}
      agentEnabled={agentSwitch.enabled}
      scheduleSummary={summarizeAvailabilityForAdmin(schedule)}
      slots={schedule.slots}
      currentWeekday={schedule.weekday}
      mauritiusNow={schedule.mauritiusNowLabel}
      openNow={schedule.openNow}
      currentRiders={schedule.ridersNow}
      upcomingDays={schedule.upcomingDays}
    />
  );
}

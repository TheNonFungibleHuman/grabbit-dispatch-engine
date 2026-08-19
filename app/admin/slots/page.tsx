import { redirect } from "next/navigation";
import { getAgentSwitchState } from "@/lib/admin/agent-switch";
import { isAdminAuthed } from "@/lib/admin/auth";
import { listAllPreBookings } from "@/lib/orders/pre-booking";
import {
  getAvailabilitySnapshot,
  summarizeAvailabilityForAdmin,
} from "@/lib/schedule/availability";
import { SlotsDashboard } from "./slots-dashboard";

export default async function AdminSlotsPage() {
  if (!(await isAdminAuthed())) {
    redirect("/admin/login");
  }

  const [bookings, agentSwitch, schedule] = await Promise.all([
    listAllPreBookings(),
    getAgentSwitchState({ bypassMemory: true }),
    getAvailabilitySnapshot(),
  ]);

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

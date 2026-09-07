import { redirect } from "next/navigation";
import { getAgentSwitchState } from "@/lib/admin/agent-switch";
import { isAdminAuthed } from "@/lib/admin/auth";
import { getOpsDashboard } from "@/lib/ops/store";
import { listAllPreBookings } from "@/lib/orders/pre-booking";
import { getAvailabilitySnapshot } from "@/lib/schedule/availability";
import { getFleetMaintenanceStatus } from "@/lib/riders/commands";
import { mauritiusDateIso } from "@/lib/time";
import { OverviewDashboard } from "./overview-dashboard";

export default async function AdminIndexPage() {
  if (!(await isAdminAuthed())) {
    redirect("/admin/login");
  }

  const [rawBookings, schedule, agentSwitch, ops, maintenance] = await Promise.all([
    listAllPreBookings(),
    getAvailabilitySnapshot(),
    getAgentSwitchState({ bypassMemory: true }),
    getOpsDashboard(),
    getFleetMaintenanceStatus(),
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
    return (
      allowedDates.has(bDate) ||
      (b.scheduledDate === "today" && allowedDates.has(b.createdAt?.slice(0, 10) || todayIso))
    );
  });

  return (
    <OverviewDashboard
      bookings={bookings}
      schedule={schedule}
      agentEnabled={agentSwitch.enabled}
      totalInbound={ops.state.stats.inbound}
      totalOutbound={ops.state.stats.outboundSuccess}
      needsTakeoverCount={ops.takeovers.length}
      maintenance={maintenance}
    />
  );
}

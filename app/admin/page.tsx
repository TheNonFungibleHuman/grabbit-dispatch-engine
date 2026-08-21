import { redirect } from "next/navigation";
import { getAgentSwitchState } from "@/lib/admin/agent-switch";
import { isAdminAuthed } from "@/lib/admin/auth";
import { getOpsDashboard } from "@/lib/ops/store";
import { listAllPreBookings } from "@/lib/orders/pre-booking";
import { getAvailabilitySnapshot } from "@/lib/schedule/availability";
import { OverviewDashboard } from "./overview-dashboard";

export default async function AdminIndexPage() {
  if (!(await isAdminAuthed())) {
    redirect("/admin/login");
  }

  const [rawBookings, schedule, agentSwitch, ops] = await Promise.all([
    listAllPreBookings(),
    getAvailabilitySnapshot(),
    getAgentSwitchState({ bypassMemory: true }),
    getOpsDashboard(),
  ]);

  const bookings = rawBookings.filter(
    (b) => b.status !== "cancelled" && b.status !== "declined",
  );

  return (
    <OverviewDashboard
      bookings={bookings}
      schedule={schedule}
      agentEnabled={agentSwitch.enabled}
      totalInbound={ops.state.stats.inbound}
      totalOutbound={ops.state.stats.outboundSuccess}
      needsTakeoverCount={ops.takeovers.length}
    />
  );
}

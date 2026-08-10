import { redirect } from "next/navigation";
import { MessagesDashboard } from "@/app/admin/messages-dashboard";
import { getAgentSwitchState } from "@/lib/admin/agent-switch";
import { isAdminAuthed } from "@/lib/admin/auth";
import { getOpsDashboard } from "@/lib/ops/store";

export default async function AdminMessagesPage() {
  if (!(await isAdminAuthed())) {
    redirect("/admin/login");
  }

  const [dashboard, agentSwitch] = await Promise.all([
    getOpsDashboard(),
    getAgentSwitchState({ bypassMemory: true }),
  ]);

  return (
    <MessagesDashboard
      stats={dashboard.state.stats}
      takeovers={dashboard.takeovers}
      recentThreads={dashboard.recentThreads}
      recentEvents={dashboard.state.recent}
      updatedAt={dashboard.state.updatedAt}
      agentEnabled={agentSwitch.enabled}
    />
  );
}

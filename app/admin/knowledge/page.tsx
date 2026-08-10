import { redirect } from "next/navigation";
import { KnowledgeEditor } from "@/app/admin/knowledge-editor";
import { getAgentSwitchState } from "@/lib/admin/agent-switch";
import { isAdminAuthed } from "@/lib/admin/auth";
import { loadKnowledgeDocument } from "@/lib/admin/knowledge";

export default async function AdminKnowledgePage() {
  if (!(await isAdminAuthed())) {
    redirect("/admin/login");
  }

  const [doc, agentSwitch] = await Promise.all([
    loadKnowledgeDocument(),
    getAgentSwitchState({ bypassMemory: true }),
  ]);
  return (
    <KnowledgeEditor initial={doc} agentEnabled={agentSwitch.enabled} />
  );
}

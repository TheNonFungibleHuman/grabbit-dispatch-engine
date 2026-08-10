import { redirect } from "next/navigation";
import { KnowledgeEditor } from "@/app/admin/knowledge-editor";
import { isAdminAuthed } from "@/lib/admin/auth";
import { loadKnowledgeDocument } from "@/lib/admin/knowledge";

export default async function AdminKnowledgePage() {
  if (!(await isAdminAuthed())) {
    redirect("/admin/login");
  }

  const doc = await loadKnowledgeDocument();
  return <KnowledgeEditor initial={doc} />;
}

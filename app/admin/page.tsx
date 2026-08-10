import { redirect } from "next/navigation";
import { isAdminAuthed } from "@/lib/admin/auth";

export default async function AdminIndexPage() {
  if (await isAdminAuthed()) {
    redirect("/admin/knowledge");
  }
  redirect("/admin/login");
}

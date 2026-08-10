import { redirect } from "next/navigation";
import { LoginForm } from "@/app/admin/login-form";
import { isAdminAuthed, isAdminConfigured } from "@/lib/admin/auth";

export default async function AdminLoginPage() {
  if (await isAdminAuthed()) {
    redirect("/admin/knowledge");
  }

  return (
    <main className="mx-auto mt-16 max-w-md rounded-xl border border-[#d7dfd1] bg-white p-8 shadow-sm">
      <p className="text-sm font-semibold tracking-wide text-[#1f7a4c]">
        Grabbit
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Admin</h1>
      <p className="mt-2 text-sm leading-6 text-[#4b5a50]">
        Single shared login for managing WhatsApp agent context.
      </p>

      {!isAdminConfigured() ? (
        <p className="mt-6 rounded-md border border-[#f0d5a8] bg-[#fff8eb] px-3 py-3 text-sm text-[#7a4b00]">
          Set <code className="font-mono">ADMIN_PASSWORD</code> in the
          environment, then reload.
        </p>
      ) : (
        <div className="mt-6">
          <LoginForm />
        </div>
      )}
    </main>
  );
}

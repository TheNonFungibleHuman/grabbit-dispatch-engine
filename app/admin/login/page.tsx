import { redirect } from "next/navigation";
import { LoginForm } from "@/app/admin/login-form";
import { isAdminAuthed, isAdminConfigured } from "@/lib/admin/auth";

export default async function AdminLoginPage() {
  if (await isAdminAuthed()) {
    redirect("/admin");
  }

  return (
    <main className="mx-auto mt-16 max-w-sm rounded-[24px] border border-[#E8E5DC] dark:border-[#1D2620] bg-[var(--bg-card)] p-8 shadow-sm">
      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#101412] dark:bg-[#F6F3EC] text-white dark:text-[#101412] shadow-sm mb-4">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M11 2H5a3 3 0 0 0-3 3v6h9V2zM13 2v9h9V5a3 3 0 0 0-3-3h-6zM2 13v6a3 3 0 0 0 3 3h6v-9H2zM13 22h6a3 3 0 0 0 3-3v-6h-9v9z" />
        </svg>
      </div>

      <span className="text-[10px] font-bold uppercase tracking-wider text-[#7ed957]">
        Grabbit Express
      </span>
      <h1 className="font-display text-xl font-bold text-[#101412] dark:text-[#F6F3EC] mt-1">
        Admin Access
      </h1>
      <p className="mt-1 text-xs text-[#6C746E] dark:text-[#8E9690] leading-relaxed">
        Sign in to manage rider shifts, time slots, and agent knowledge.
      </p>

      {!isAdminConfigured() ? (
        <p className="mt-6 rounded-[16px] border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 text-xs text-amber-800 dark:text-amber-300 font-medium">
          Set <code className="font-mono">ADMIN_PASSWORD</code> in the environment, then reload.
        </p>
      ) : (
        <div className="mt-6">
          <LoginForm />
        </div>
      )}
    </main>
  );
}

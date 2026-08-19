"use client";

import { useActionState } from "react";
import {
  loginAdminAction,
  type AdminActionState,
} from "@/app/admin/actions";

const initialState: AdminActionState = { ok: false };

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAdminAction, initialState);

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="password" className="block text-xs font-semibold text-[#101412] dark:text-[#F6F3EC]">
          Admin Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          placeholder="Enter dashboard password"
          className="w-full rounded-[14px] border border-[#E8E5DC] dark:border-[#1D2620] bg-[#F6F3EC] dark:bg-[#0B0F0C] px-3.5 py-2.5 text-xs text-[#101412] dark:text-[#F6F3EC] outline-none focus:border-[#7ed957] transition-colors"
        />
      </div>

      {state.message ? (
        <p className="text-xs text-rose-600 dark:text-rose-400 font-semibold" role="alert">
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-full bg-[#101412] dark:bg-[#F6F3EC] hover:bg-[#7ed957] dark:hover:bg-[#7ed957] hover:text-[#101412] dark:hover:text-[#101412] px-4 py-2.5 text-xs font-bold text-white dark:text-[#101412] transition-all shadow-sm disabled:opacity-50"
      >
        {pending ? "Signing in..." : "Sign in to Dashboard"}
      </button>
    </form>
  );
}

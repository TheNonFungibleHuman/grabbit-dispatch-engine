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
    <form action={action} className="space-y-5">
      <div className="space-y-2">
        <label htmlFor="password" className="block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="w-full rounded-md border border-[#c9d2c6] bg-white px-3 py-2.5 text-base outline-none ring-[#1f7a4c] focus:ring-2"
        />
      </div>

      {state.message ? (
        <p className="text-sm text-[#9b2c2c]" role="alert">
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-[#1f7a4c] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#18643e] disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

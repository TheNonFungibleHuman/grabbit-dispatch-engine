"use client";

import Link from "next/link";
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  logoutAdminAction,
  refreshScheduleAction,
  setAgentEnabledAction,
  type AdminActionState,
} from "@/app/admin/actions";

const initialState: AdminActionState = { ok: false };

function AgentKillSwitch(props: { enabled: boolean }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(
    setAgentEnabledAction,
    initialState,
  );

  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);

  return (
    <div className="flex flex-col items-stretch gap-1 sm:items-end">
      <form action={action}>
        <input
          type="hidden"
          name="enabled"
          value={props.enabled ? "false" : "true"}
        />
        <button
          type="submit"
          disabled={pending}
          className={[
            "rounded-md px-3 py-2 text-sm font-semibold transition disabled:opacity-60",
            props.enabled
              ? "border border-[#f0c2c2] bg-[#fff5f5] text-[#9b2c2c] hover:bg-[#fee2e2]"
              : "border border-[#b7dfc5] bg-[#eefaf2] text-[#14532d] hover:bg-[#dcfce7]",
          ].join(" ")}
        >
          {pending
            ? "Updating…"
            : props.enabled
              ? "Deactivate AI"
              : "Activate AI"}
        </button>
      </form>
      <p
        className={`text-xs ${
          props.enabled ? "text-[#14532d]" : "text-[#9b2c2c]"
        }`}
      >
        {props.enabled
          ? "AI is ON"
          : "AI is OFF — silent (human takeover)"}
      </p>
      {state.message ? (
        <p
          className={`max-w-[16rem] text-xs ${
            state.ok ? "text-[#4b5a50]" : "text-[#9b2c2c]"
          }`}
        >
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

function ScheduleRefresh(props: { summary: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(
    refreshScheduleAction,
    initialState,
  );

  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);

  return (
    <div className="rounded-xl border border-[#d7dfd1] bg-white px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#14201a]">
            Rider schedule (Mauritius)
          </p>
          <p className="mt-1 text-xs leading-5 text-[#4b5a50]">
            {props.summary}
          </p>
        </div>
        <form action={action}>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md border border-[#c9d2c6] bg-[#f3f5f1] px-3 py-2 text-sm font-semibold text-[#14201a] hover:bg-[#eef2ea] disabled:opacity-60"
          >
            {pending ? "Fetching Sheet…" : "Refresh schedule"}
          </button>
        </form>
      </div>
      {state.message ? (
        <p
          className={`mt-3 text-xs leading-5 ${
            state.ok ? "text-[#14532d]" : "text-[#9b2c2c]"
          }`}
        >
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

export function AdminNav(props: {
  active: "knowledge" | "messages" | "slots";
  agentEnabled: boolean;
  scheduleSummary: string;
}) {
  const linkClass = (id: "knowledge" | "messages" | "slots") =>
    [
      "rounded-md px-3 py-2 text-sm font-medium",
      props.active === id
        ? "bg-[#1f7a4c] text-white"
        : "border border-[#c9d2c6] bg-white text-[#14201a] hover:bg-[#eef2ea]",
    ].join(" ");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-2 text-sm font-semibold tracking-wide text-[#1f7a4c]">
            Grabbit Admin
          </p>
          <Link href="/admin/knowledge" className={linkClass("knowledge")}>
            Context
          </Link>
          <Link href="/admin/messages" className={linkClass("messages")}>
            Messages
          </Link>
          <Link href="/admin/slots" className={linkClass("slots")}>
            Time Slots
          </Link>
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <AgentKillSwitch enabled={props.agentEnabled} />
          <form action={logoutAdminAction}>
            <button
              type="submit"
              className="rounded-md border border-[#c9d2c6] bg-white px-3 py-2 text-sm font-medium hover:bg-[#eef2ea]"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>

      <ScheduleRefresh summary={props.scheduleSummary} />

      {!props.agentEnabled ? (
        <div className="rounded-md border border-[#f0c2c2] bg-[#fff5f5] px-3 py-2 text-sm text-[#9b2c2c]">
          AI replies are paused. New customer messages stay silent so you can
          answer on WhatsApp.
        </div>
      ) : null}
    </div>
  );
}

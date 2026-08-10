"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  clearTakeoverAction,
  type AdminActionState,
} from "@/app/admin/actions";
import { AdminNav } from "@/app/admin/admin-nav";
import type { OpsEvent, OpsStats, ThreadOps } from "@/lib/ops/model";

const initialState: AdminActionState = { ok: false };

function formatWhen(iso?: string): string {
  if (!iso) return "—";
  return iso.replace("T", " ").slice(0, 19) + " UTC";
}

function eventLabel(type: OpsEvent["type"]): string {
  switch (type) {
    case "inbound_received":
      return "In";
    case "outbound_sent":
      return "Sent";
    case "outbound_failed":
      return "Send failed";
    case "agent_failed":
      return "Agent failed";
    case "takeover_cleared":
      return "Handled";
    default:
      return type;
  }
}

function StatCard(props: { label: string; value: number; warn?: boolean }) {
  return (
    <div
      className={`rounded-xl border bg-white p-4 ${
        props.warn ? "border-[#f0c2c2]" : "border-[#d7dfd1]"
      }`}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-[#4b5a50]">
        {props.label}
      </p>
      <p
        className={`mt-2 text-3xl font-semibold tabular-nums ${
          props.warn ? "text-[#9b2c2c]" : "text-[#14201a]"
        }`}
      >
        {props.value}
      </p>
    </div>
  );
}

function TakeoverRow(props: { thread: ThreadOps }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(
    clearTakeoverAction,
    initialState,
  );

  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);

  return (
    <li className="rounded-xl border border-[#f0c2c2] bg-[#fff8f8] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-semibold tabular-nums">+{props.thread.phone}</p>
          <p className="mt-1 text-sm text-[#9b2c2c]">
            {props.thread.takeoverReason || "Needs human takeover"}
          </p>
          <p className="mt-1 text-xs text-[#4b5a50]">
            Last activity {formatWhen(props.thread.updatedAt)}
            {props.thread.lastInboundAt
              ? ` · last inbound ${formatWhen(props.thread.lastInboundAt)}`
              : ""}
          </p>
        </div>
        <form action={action}>
          <input type="hidden" name="phone" value={props.thread.phone} />
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-[#1f7a4c] px-3 py-2 text-sm font-semibold text-white hover:bg-[#18643e] disabled:opacity-60"
          >
            {pending ? "Saving…" : "Mark handled"}
          </button>
        </form>
      </div>
      {state.message && !state.ok ? (
        <p className="mt-2 text-sm text-[#9b2c2c]">{state.message}</p>
      ) : null}
    </li>
  );
}

export function MessagesDashboard(props: {
  stats: OpsStats;
  takeovers: ThreadOps[];
  recentThreads: ThreadOps[];
  recentEvents: OpsEvent[];
  updatedAt: string;
}) {
  return (
    <div className="space-y-8">
      <AdminNav active="messages" />

      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Messages</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[#4b5a50]">
          Successful sends, failures, and numbers that dropped so you can take
          over on WhatsApp. Updated {formatWhen(props.updatedAt)}.
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Inbound" value={props.stats.inbound} />
        <StatCard label="Sent OK" value={props.stats.outboundSuccess} />
        <StatCard
          label="Send failed"
          value={props.stats.outboundFailed}
          warn={props.stats.outboundFailed > 0}
        />
        <StatCard
          label="Agent failed"
          value={props.stats.agentFailed}
          warn={props.stats.agentFailed > 0}
        />
        <StatCard
          label="Needs takeover"
          value={props.stats.needsTakeover}
          warn={props.stats.needsTakeover > 0}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Needs takeover</h2>
        {props.takeovers.length < 1 ? (
          <p className="rounded-xl border border-[#d7dfd1] bg-white px-4 py-3 text-sm text-[#4b5a50]">
            No dropped numbers right now.
          </p>
        ) : (
          <ul className="space-y-3">
            {props.takeovers.map((thread) => (
              <TakeoverRow key={thread.phone} thread={thread} />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Recent numbers</h2>
        <div className="overflow-x-auto rounded-xl border border-[#d7dfd1] bg-white">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-[#e4ebe0] text-xs uppercase tracking-wide text-[#4b5a50]">
              <tr>
                <th className="px-4 py-3 font-medium">Phone</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">In</th>
                <th className="px-4 py-3 font-medium">Sent</th>
                <th className="px-4 py-3 font-medium">Failed</th>
                <th className="px-4 py-3 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {props.recentThreads.length < 1 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-6 text-[#4b5a50]"
                  >
                    No message activity recorded yet.
                  </td>
                </tr>
              ) : (
                props.recentThreads.map((thread) => (
                  <tr
                    key={thread.phone}
                    className="border-b border-[#eef2ea] last:border-0"
                  >
                    <td className="px-4 py-3 font-medium tabular-nums">
                      +{thread.phone}
                    </td>
                    <td className="px-4 py-3">
                      {thread.needsTakeover ? (
                        <span className="rounded-full bg-[#fee2e2] px-2 py-0.5 text-xs font-semibold text-[#9b2c2c]">
                          Takeover
                        </span>
                      ) : thread.lastOutboundOk === false ? (
                        <span className="rounded-full bg-[#ffedd5] px-2 py-0.5 text-xs font-semibold text-[#9a3412]">
                          Last send failed
                        </span>
                      ) : (
                        <span className="rounded-full bg-[#eefaf2] px-2 py-0.5 text-xs font-semibold text-[#14532d]">
                          OK
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{thread.inboundCount}</td>
                    <td className="px-4 py-3 tabular-nums">
                      {thread.successOutCount}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{thread.failOutCount}</td>
                    <td className="px-4 py-3 text-[#4b5a50]">
                      {formatWhen(thread.updatedAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Event feed</h2>
        <ul className="space-y-2">
          {props.recentEvents.length < 1 ? (
            <li className="rounded-xl border border-[#d7dfd1] bg-white px-4 py-3 text-sm text-[#4b5a50]">
              No events yet. They appear as WhatsApp traffic flows.
            </li>
          ) : (
            props.recentEvents.slice(0, 60).map((item) => (
              <li
                key={item.id}
                className="rounded-lg border border-[#d7dfd1] bg-white px-4 py-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-[#eef2ea] px-2 py-0.5 text-xs font-semibold">
                    {eventLabel(item.type)}
                  </span>
                  <span className="font-medium tabular-nums">+{item.phone}</span>
                  <span className="text-xs text-[#4b5a50]">
                    {formatWhen(item.at)}
                  </span>
                </div>
                {item.error ? (
                  <p className="mt-1 text-[#9b2c2c]">{item.error}</p>
                ) : null}
                {item.preview ? (
                  <p className="mt-1 text-[#4b5a50]">{item.preview}</p>
                ) : null}
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}

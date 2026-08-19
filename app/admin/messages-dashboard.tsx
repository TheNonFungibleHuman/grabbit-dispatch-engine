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
      return "Inbound";
    case "outbound_sent":
      return "Sent";
    case "outbound_failed":
      return "Send Failed";
    case "agent_failed":
      return "Agent Failed";
    case "takeover_cleared":
      return "Handled";
    default:
      return type;
  }
}

function StatCard(props: { label: string; value: number; warn?: boolean }) {
  return (
    <div
      className={`rounded-[20px] bg-[var(--bg-card)] border p-4 shadow-sm ${
        props.warn
          ? "border-rose-500/30 dark:border-rose-500/30"
          : "border-[#E8E5DC] dark:border-[#1D2620]"
      }`}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wider text-[#6C746E] dark:text-[#8E9690]">
        {props.label}
      </p>
      <p
        className={`mt-2 font-display text-2xl font-bold tabular-nums ${
          props.warn ? "text-rose-600 dark:text-rose-400" : "text-[#101412] dark:text-[#F6F3EC]"
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
    <li className="rounded-[20px] border border-rose-500/30 bg-rose-500/5 p-4 transition-all">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <span className="font-display font-bold text-sm text-[#101412] dark:text-[#F6F3EC]">
            +{props.thread.phone}
          </span>
          <p className="mt-0.5 text-xs text-rose-600 dark:text-rose-400 font-medium">
            {props.thread.takeoverReason || "Needs human operator takeover"}
          </p>
          <p className="mt-1 text-[11px] text-[#6C746E] dark:text-[#8E9690]">
            Last activity {formatWhen(props.thread.updatedAt)}
            {props.thread.lastInboundAt ? ` · inbound ${formatWhen(props.thread.lastInboundAt)}` : ""}
          </p>
        </div>
        <form action={action}>
          <input type="hidden" name="phone" value={props.thread.phone} />
          <button
            type="submit"
            disabled={pending}
            className="px-3.5 py-1.5 rounded-full bg-[#7ed957] hover:bg-[#6fc847] text-[#101412] font-bold text-xs shadow-sm transition-all disabled:opacity-50"
          >
            {pending ? "Saving..." : "Mark Handled"}
          </button>
        </form>
      </div>
      {state.message && !state.ok ? (
        <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{state.message}</p>
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
  agentEnabled: boolean;
  scheduleSummary: string;
}) {
  return (
    <div className="space-y-6">
      <AdminNav
        active="messages"
        agentEnabled={props.agentEnabled}
        scheduleSummary={props.scheduleSummary}
      />

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#101412] dark:text-[#F6F3EC]">
            Live Activity & Support Queue
          </h1>
          <p className="text-xs text-[#6C746E] dark:text-[#8E9690] mt-1">
            Real-time WhatsApp traffic, message delivery status, and human operator takeover alerts.
          </p>
        </div>
        <span className="text-[11px] text-[#6C746E] dark:text-[#8E9690]">
          Updated: {formatWhen(props.updatedAt)}
        </span>
      </div>

      {/* Stats Cards */}
      <section className="grid grid-cols-2 sm:grid-cols-5 gap-3.5">
        <StatCard label="Inbound" value={props.stats.inbound} />
        <StatCard label="Sent OK" value={props.stats.outboundSuccess} />
        <StatCard
          label="Send Failed"
          value={props.stats.outboundFailed}
          warn={props.stats.outboundFailed > 0}
        />
        <StatCard
          label="Agent Failed"
          value={props.stats.agentFailed}
          warn={props.stats.agentFailed > 0}
        />
        <StatCard
          label="Needs Takeover"
          value={props.stats.needsTakeover}
          warn={props.stats.needsTakeover > 0}
        />
      </section>

      {/* Human Takeover Queue */}
      <section className="rounded-[24px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-6 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-base font-bold text-[#101412] dark:text-[#F6F3EC]">
            Human Takeover Queue
          </h2>
          <span className="text-xs text-[#6C746E] dark:text-[#8E9690]">
            {props.takeovers.length} active alerts
          </span>
        </div>

        {props.takeovers.length < 1 ? (
          <div className="p-8 text-center rounded-[16px] bg-[#F6F3EC] dark:bg-[#0B0F0C] border border-[#E8E5DC] dark:border-[#1D2620] text-xs text-[#6C746E] dark:text-[#8E9690]">
            All conversations are currently handled by the AI agent. No dropped numbers.
          </div>
        ) : (
          <ul className="space-y-3">
            {props.takeovers.map((thread) => (
              <TakeoverRow key={thread.phone} thread={thread} />
            ))}
          </ul>
        )}
      </section>

      {/* Recent Numbers Table */}
      <section className="rounded-[24px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] overflow-hidden shadow-sm">
        <div className="p-5 border-b border-[#E8E5DC] dark:border-[#1D2620]">
          <h2 className="font-display text-base font-bold text-[#101412] dark:text-[#F6F3EC]">
            Recent WhatsApp Conversations
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#F6F3EC] dark:bg-[#0B0F0C] text-[#6C746E] dark:text-[#8E9690] border-b border-[#E8E5DC] dark:border-[#1D2620] uppercase tracking-wider font-semibold">
              <tr>
                <th className="p-3.5 font-semibold">Phone</th>
                <th className="p-3.5 font-semibold">Status</th>
                <th className="p-3.5 font-semibold">Inbound</th>
                <th className="p-3.5 font-semibold">Sent</th>
                <th className="p-3.5 font-semibold">Failed</th>
                <th className="p-3.5 font-semibold">Last Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E8E5DC] dark:divide-[#1D2620]">
              {props.recentThreads.length < 1 ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-[#6C746E] dark:text-[#8E9690]">
                    No message activity recorded yet.
                  </td>
                </tr>
              ) : (
                props.recentThreads.map((thread) => (
                  <tr key={thread.phone} className="hover:bg-[#F6F3EC]/50 dark:hover:bg-[#0B0F0C]/50 transition-colors">
                    <td className="p-3.5 font-semibold font-mono text-[#101412] dark:text-[#F6F3EC]">
                      +{thread.phone}
                    </td>
                    <td className="p-3.5">
                      {thread.needsTakeover ? (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20">
                          Takeover
                        </span>
                      ) : thread.lastOutboundOk === false ? (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                          Send Failed
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-[#7ed957]/15 text-[#101412] dark:text-[#7ed957] border border-[#7ed957]/30">
                          OK
                        </span>
                      )}
                    </td>
                    <td className="p-3.5 tabular-nums text-[#101412] dark:text-[#F6F3EC]">{thread.inboundCount}</td>
                    <td className="p-3.5 tabular-nums text-[#101412] dark:text-[#F6F3EC]">{thread.successOutCount}</td>
                    <td className="p-3.5 tabular-nums text-[#6C746E] dark:text-[#8E9690]">{thread.failOutCount}</td>
                    <td className="p-3.5 text-[#6C746E] dark:text-[#8E9690]">
                      {formatWhen(thread.updatedAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Activity Event Feed */}
      <section className="rounded-[24px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-6 shadow-sm space-y-4">
        <h2 className="font-display text-base font-bold text-[#101412] dark:text-[#F6F3EC]">
          Event Feed
        </h2>
        <ul className="space-y-2">
          {props.recentEvents.length < 1 ? (
            <li className="p-6 text-center text-xs text-[#6C746E] dark:text-[#8E9690]">
              No events yet. They will appear as WhatsApp messages flow through.
            </li>
          ) : (
            props.recentEvents.slice(0, 40).map((item) => (
              <li
                key={item.id}
                className="p-3 rounded-xl bg-[#F6F3EC] dark:bg-[#0B0F0C] border border-[#E8E5DC] dark:border-[#1D2620] text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2"
              >
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] text-[#101412] dark:text-[#F6F3EC]">
                    {eventLabel(item.type)}
                  </span>
                  <span className="font-mono font-semibold text-[#101412] dark:text-[#F6F3EC]">+{item.phone}</span>
                  {item.preview && (
                    <span className="text-[#6C746E] dark:text-[#8E9690] truncate max-w-sm">· {item.preview}</span>
                  )}
                </div>
                <span className="text-[11px] text-[#6C746E] dark:text-[#8E9690]">
                  {formatWhen(item.at)}
                </span>
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}

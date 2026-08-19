"use client";

import Link from "next/link";
import { AdminNav } from "@/app/admin/admin-nav";
import type { PreBooking } from "@/lib/orders/pre-booking";
import type { AvailabilitySnapshot } from "@/lib/schedule/availability";

export function OverviewDashboard(props: {
  bookings: PreBooking[];
  schedule: AvailabilitySnapshot;
  agentEnabled: boolean;
  totalInbound: number;
  totalOutbound: number;
  needsTakeoverCount: number;
}) {
  const activeBookings = props.bookings.filter(
    (b) => b.status === "pending_rider" || b.status === "confirmed" || b.status === "dispatched",
  );

  const todaySchedule = props.schedule.upcomingDays.find((d) => d.daysAhead === 0);
  const todayOpenSlots = todaySchedule?.openSlots || [];

  return (
    <div className="space-y-6">
      <AdminNav
        active="dashboard"
        agentEnabled={props.agentEnabled}
        mauritiusNow={props.schedule.mauritiusNowLabel}
      />

      {/* Main Bento Layout */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* Metric 1: Active Trips & Deliveries */}
        <div className="rounded-[24px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-6 shadow-sm hover:shadow-md transition-all">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-[#6C746E] dark:text-[#8E9690]">
              Active Bookings
            </span>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-[#7ed957]/15 text-[#101412] dark:text-[#7ed957] border border-[#7ed957]/30">
              Live
            </span>
          </div>
          <div className="mt-4 flex items-baseline gap-3">
            <span className="font-display text-4xl font-extrabold text-[#101412] dark:text-[#F6F3EC]">
              {activeBookings.length}
            </span>
            <span className="text-xs text-[#6C746E] dark:text-[#8E9690]">
              in queue / confirmed
            </span>
          </div>
          <div className="mt-5 pt-4 border-t border-[#E8E5DC] dark:border-[#1D2620] flex items-center justify-between text-xs">
            <span className="text-[#6C746E] dark:text-[#8E9690]">Total all-time records</span>
            <span className="font-semibold text-[#101412] dark:text-[#F6F3EC]">{props.bookings.length}</span>
          </div>
        </div>

        {/* Metric 2: Today's Shift Status */}
        <div className="rounded-[24px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-6 shadow-sm hover:shadow-md transition-all">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-[#6C746E] dark:text-[#8E9690]">
              Shift Status
            </span>
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold ${
                props.schedule.openNow
                  ? "bg-[#7ed957]/15 text-[#101412] dark:text-[#7ed957] border border-[#7ed957]/30"
                  : "bg-[#EDEAE2] dark:bg-[#171E1A] text-[#6C746E] dark:text-[#8E9690] border border-[#E8E5DC] dark:border-[#1D2620]"
              }`}
            >
              {props.schedule.openNow ? "Open Right Now" : "Closed Right Now"}
            </span>
          </div>
          <div className="mt-4">
            <span className="font-display text-2xl font-bold text-[#101412] dark:text-[#F6F3EC] line-clamp-1">
              {props.schedule.ridersNow.length > 0
                ? props.schedule.ridersNow.join(", ")
                : "No Rider Active"}
            </span>
            <p className="mt-1 text-xs text-[#6C746E] dark:text-[#8E9690]">
              {props.schedule.currentSlot?.label || "Off-hours / Outside shift window"}
            </p>
          </div>
          <div className="mt-5 pt-4 border-t border-[#E8E5DC] dark:border-[#1D2620] flex items-center justify-between text-xs">
            <span className="text-[#6C746E] dark:text-[#8E9690]">Today open windows</span>
            <span className="font-semibold text-[#101412] dark:text-[#F6F3EC]">
              {todayOpenSlots.length} slots
            </span>
          </div>
        </div>

        {/* Metric 3: AI WhatsApp Agent Status */}
        <div className="rounded-[24px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-6 shadow-sm hover:shadow-md transition-all">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-[#6C746E] dark:text-[#8E9690]">
              AI Automation
            </span>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold ${
                props.agentEnabled
                  ? "bg-[#7ed957]/15 text-[#101412] dark:text-[#7ed957] border border-[#7ed957]/30"
                  : "bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  props.agentEnabled ? "bg-[#7ed957]" : "bg-rose-500"
                }`}
              />
              {props.agentEnabled ? "Operational" : "Paused"}
            </span>
          </div>
          <div className="mt-4 flex items-baseline gap-3">
            <span className="font-display text-4xl font-extrabold text-[#101412] dark:text-[#F6F3EC]">
              {props.totalInbound}
            </span>
            <span className="text-xs text-[#6C746E] dark:text-[#8E9690]">
              messages processed
            </span>
          </div>
          <div className="mt-5 pt-4 border-t border-[#E8E5DC] dark:border-[#1D2620] flex items-center justify-between text-xs">
            <span className="text-[#6C746E] dark:text-[#8E9690]">Support takeovers needed</span>
            <span
              className={`font-semibold ${
                props.needsTakeoverCount > 0 ? "text-rose-600 dark:text-rose-400" : "text-[#101412] dark:text-[#F6F3EC]"
              }`}
            >
              {props.needsTakeoverCount}
            </span>
          </div>
        </div>
      </div>

      {/* Bento Row 2: Today's Shift Breakdown & Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Today's Shifts Card (Left 2 cols) */}
        <div className="lg:col-span-2 rounded-[24px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-6 shadow-sm">
          <div className="flex items-center justify-between pb-4 border-b border-[#E8E5DC] dark:border-[#1D2620]">
            <div>
              <h3 className="font-display text-base font-bold text-[#101412] dark:text-[#F6F3EC]">
                Today’s Duty Schedule ({props.schedule.weekday})
              </h3>
              <p className="text-xs text-[#6C746E] dark:text-[#8E9690] mt-0.5">
                {props.schedule.mauritiusNowLabel}
              </p>
            </div>
            <Link
              href="/admin/slots"
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-[#101412] dark:bg-[#F6F3EC] text-white dark:text-[#101412] hover:opacity-90 transition-opacity"
            >
              <span>Manage Matrix</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            </Link>
          </div>

          <div className="mt-5 space-y-2.5">
            {props.schedule.slots.map((slot, idx) => {
              const rider = slot.byDay[props.schedule.weekday] || "No Rider Available";
              const isClosed =
                !rider ||
                rider.toLowerCase().includes("closed") ||
                rider.toLowerCase().includes("no rider") ||
                rider === "-";

              return (
                <div
                  key={idx}
                  className="flex items-center justify-between p-3.5 rounded-2xl bg-[#F6F3EC] dark:bg-[#0B0F0C] border border-[#E8E5DC] dark:border-[#1D2620] transition-all hover:translate-x-0.5"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--bg-card)] text-[#101412] dark:text-[#F6F3EC] font-display text-xs font-bold border border-[#E8E5DC] dark:border-[#1D2620]">
                      {idx + 1}
                    </div>
                    <div>
                      <span className="font-semibold text-xs text-[#101412] dark:text-[#F6F3EC]">
                        {slot.label}
                      </span>
                    </div>
                  </div>

                  <span
                    className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold ${
                      isClosed
                        ? "bg-[#EDEAE2] dark:bg-[#171E1A] text-[#6C746E] dark:text-[#8E9690]"
                        : "bg-[#7ed957]/15 text-[#101412] dark:text-[#7ed957] border border-[#7ed957]/30"
                    }`}
                  >
                    {isClosed ? "Closed / No Rider" : rider}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Quick Actions & Short Cuts (Right 1 col) */}
        <div className="space-y-5">
          {/* Action Card */}
          <div className="rounded-[24px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-6 shadow-sm">
            <h3 className="font-display text-base font-bold text-[#101412] dark:text-[#F6F3EC]">
              Quick Controls
            </h3>
            <p className="text-xs text-[#6C746E] dark:text-[#8E9690] mt-1">
              Direct access to dispatch and prompt tools.
            </p>

            <div className="mt-5 space-y-2">
              <Link
                href="/admin/slots"
                className="flex items-center justify-between p-3 rounded-2xl bg-[#F6F3EC] dark:bg-[#0B0F0C] border border-[#E8E5DC] dark:border-[#1D2620] text-xs font-semibold hover:border-[#7ed957] transition-all"
              >
                <span>Edit Weekly Shifts Matrix</span>
                <span className="text-[#6C746E] dark:text-[#8E9690]">→</span>
              </Link>
              <Link
                href="/admin/knowledge"
                className="flex items-center justify-between p-3 rounded-2xl bg-[#F6F3EC] dark:bg-[#0B0F0C] border border-[#E8E5DC] dark:border-[#1D2620] text-xs font-semibold hover:border-[#7ed957] transition-all"
              >
                <span>Update AI Knowledge / Fares</span>
                <span className="text-[#6C746E] dark:text-[#8E9690]">→</span>
              </Link>
              <Link
                href="/admin/messages"
                className="flex items-center justify-between p-3 rounded-2xl bg-[#F6F3EC] dark:bg-[#0B0F0C] border border-[#E8E5DC] dark:border-[#1D2620] text-xs font-semibold hover:border-[#7ed957] transition-all"
              >
                <span>View Activity & Takeovers</span>
                <span className="text-[#6C746E] dark:text-[#8E9690]">→</span>
              </Link>
            </div>
          </div>

          {/* Pricing Quick Card */}
          <div className="rounded-[24px] bg-[#101412] dark:bg-[#F6F3EC] text-white dark:text-[#101412] p-6 shadow-sm">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#7ed957] dark:text-[#101412] opacity-90">
              Pricing Quick Card
            </span>
            <h4 className="font-display text-lg font-bold mt-1">
              Passenger Trips & Deliveries
            </h4>
            <div className="mt-4 space-y-1.5 text-xs opacity-90">
              <div className="flex justify-between">
                <span>Pamplemousses Garden:</span>
                <span className="font-bold">Rs 50 (Round: Rs 100)</span>
              </div>
              <div className="flex justify-between">
                <span>Mahogany / SSRN:</span>
                <span className="font-bold">Rs 40 (Round: Rs 80)</span>
              </div>
              <div className="flex justify-between">
                <span>Mahogany Delivery:</span>
                <span className="font-bold">Rs 100</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

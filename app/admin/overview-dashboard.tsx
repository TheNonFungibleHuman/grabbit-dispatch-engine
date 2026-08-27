"use client";

import Link from "next/link";
import { AdminNav } from "@/app/admin/admin-nav";
import type { PreBooking } from "@/lib/orders/pre-booking";
import type { AvailabilitySnapshot } from "@/lib/schedule/availability";
import { estimateBookingFare } from "@/lib/pricing/fares";

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

  function getMauritiusIsoDate(offsetDays: number = 0): string {
    try {
      const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Indian/Mauritius" });
      const parts = formatter.format(new Date()).split("-");
      const d = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)));
      d.setUTCDate(d.getUTCDate() + offsetDays);
      return d.toISOString().split("T")[0];
    } catch {
      const now = new Date();
      now.setDate(now.getDate() + offsetDays);
      return now.toISOString().split("T")[0];
    }
  }

  const todayIso = getMauritiusIsoDate(0);

  // Today's Revenue & Volume Calculations
  const todayBookings = props.bookings.filter(
    (b) =>
      b.scheduledDate === todayIso ||
      b.scheduledDate === "today" ||
      b.slotKey?.startsWith(todayIso),
  );

  const todayGrossRevenueRs = todayBookings.reduce((sum, b) => sum + estimateBookingFare(b), 0);
  const cashBookingsCount = todayBookings.filter((b) => (b.paymentMethod || "cash").toLowerCase().includes("cash")).length;
  const juiceBookingsCount = todayBookings.filter((b) => (b.paymentMethod || "").toLowerCase().includes("juice") || (b.paymentMethod || "").toLowerCase().includes("transfer")).length;
  const completedTodayCount = todayBookings.filter((b) => b.status === "completed").length;

  return (
    <div className="space-y-6">
      <AdminNav
        active="dashboard"
        agentEnabled={props.agentEnabled}
        mauritiusNow={props.schedule.mauritiusNowLabel}
      />

      {/* Main Bento Layout (4 Key Metrics) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {/* Metric 1: Today's Gross Revenue */}
        <div className="rounded-[24px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-6 shadow-sm hover:shadow-md transition-all">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-[#6C746E] dark:text-[#8E9690]">
              Today's Fares
            </span>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-[#7ed957]/15 text-[#101412] dark:text-[#7ed957] border border-[#7ed957]/30">
              Gross
            </span>
          </div>
          <div className="mt-4 flex items-baseline gap-2">
            <span className="font-display text-3xl font-extrabold text-[#101412] dark:text-[#F6F3EC]">
              Rs {todayGrossRevenueRs}
            </span>
            <span className="text-xs text-[#6C746E] dark:text-[#8E9690]">
              ({todayBookings.length} total)
            </span>
          </div>
          <div className="mt-5 pt-4 border-t border-[#E8E5DC] dark:border-[#1D2620] flex items-center justify-between text-xs text-[#6C746E] dark:text-[#8E9690]">
            <span>Cash: <strong className="text-[#101412] dark:text-[#F6F3EC]">{cashBookingsCount}</strong></span>
            <span>Juice/Bank: <strong className="text-[#101412] dark:text-[#F6F3EC]">{juiceBookingsCount}</strong></span>
            <span>Done: <strong className="text-[#101412] dark:text-[#F6F3EC]">{completedTodayCount}</strong></span>
          </div>
        </div>

        {/* Metric 2: Active Trips & Deliveries */}
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
            <span className="font-display text-3xl font-extrabold text-[#101412] dark:text-[#F6F3EC]">
              {activeBookings.length}
            </span>
            <span className="text-xs text-[#6C746E] dark:text-[#8E9690]">
              in queue / confirmed
            </span>
          </div>
          <div className="mt-5 pt-4 border-t border-[#E8E5DC] dark:border-[#1D2620] flex items-center justify-between text-xs">
            <span className="text-[#6C746E] dark:text-[#8E9690]">Confirmed & In Queue</span>
            <span className="font-semibold text-[#101412] dark:text-[#F6F3EC]">{activeBookings.length}</span>
          </div>
        </div>

        {/* Metric 3: Today's Shift Status */}
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
              {props.schedule.openNow ? "Open Now" : "Closed"}
            </span>
          </div>
          <div className="mt-4">
            <span className="font-display text-xl font-bold text-[#101412] dark:text-[#F6F3EC] line-clamp-1">
              {props.schedule.ridersNow.length > 0
                ? props.schedule.ridersNow.join(", ")
                : "No Rider Active"}
            </span>
            <p className="mt-1 text-xs text-[#6C746E] dark:text-[#8E9690] line-clamp-1">
              {props.schedule.currentSlot?.label || "Outside shift window"}
            </p>
          </div>
          <div className="mt-5 pt-4 border-t border-[#E8E5DC] dark:border-[#1D2620] flex items-center justify-between text-xs">
            <span className="text-[#6C746E] dark:text-[#8E9690]">Today windows</span>
            <span className="font-semibold text-[#101412] dark:text-[#F6F3EC]">
              {todayOpenSlots.length} slots
            </span>
          </div>
        </div>

        {/* Metric 4: AI WhatsApp Agent Status */}
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
            <span className="font-display text-3xl font-extrabold text-[#101412] dark:text-[#F6F3EC]">
              {props.totalInbound}
            </span>
            <span className="text-xs text-[#6C746E] dark:text-[#8E9690]">
              messages
            </span>
          </div>
          <div className="mt-5 pt-4 border-t border-[#E8E5DC] dark:border-[#1D2620] flex items-center justify-between text-xs">
            <span className="text-[#6C746E] dark:text-[#8E9690]">Takeovers needed</span>
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

      {/* Fleet Telemetry & Rider Quick-Ping Bar */}
      <div className="rounded-[24px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-5 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[#E8E5DC] dark:border-[#1D2620]">
          <div>
            <h3 className="font-display text-sm font-bold text-[#101412] dark:text-[#F6F3EC] flex items-center gap-2">
              <span>🛵 Fleet Live Quick-Ping Bar</span>
            </h3>
            <p className="text-xs text-[#6C746E] dark:text-[#8E9690]">
              Direct one-click check-ins with Grabbit on-duty riders.
            </p>
          </div>
          <span className="text-[11px] font-semibold text-[#6C746E] dark:text-[#8E9690]">
            3 Active Fleet Riders
          </span>
        </div>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Rider 1: Moses */}
          <div className="flex items-center justify-between p-3 rounded-2xl bg-[#F6F3EC] dark:bg-[#0B0F0C] border border-[#E8E5DC] dark:border-[#1D2620]">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-full bg-purple-500/15 text-purple-700 dark:text-purple-300 font-bold text-xs flex items-center justify-center border border-purple-500/30">
                M
              </div>
              <div>
                <span className="font-bold text-xs text-[#101412] dark:text-[#F6F3EC] block">Moses</span>
                <span className="text-[10px] text-[#6C746E] dark:text-[#8E9690]">Campus Rider</span>
              </div>
            </div>
            <a
              href="https://wa.me/99900000038?text=Hi%20Moses,%20checking%20in%20from%20Grabbit%20dispatch.%20How%20are%20runs%20going%20today%3F"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-[#7ed957]/15 text-[#101412] dark:text-[#7ed957] border border-[#7ed957]/30 hover:bg-[#7ed957]/25 transition-colors"
            >
              <span>💬 WhatsApp</span>
            </a>
          </div>

          {/* Rider 2: Thierry */}
          <div className="flex items-center justify-between p-3 rounded-2xl bg-[#F6F3EC] dark:bg-[#0B0F0C] border border-[#E8E5DC] dark:border-[#1D2620]">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-full bg-[#7ed957]/20 text-[#101412] dark:text-[#7ed957] font-bold text-xs flex items-center justify-center border border-[#7ed957]/40">
                T
              </div>
              <div>
                <span className="font-bold text-xs text-[#101412] dark:text-[#F6F3EC] block">Thierry</span>
                <span className="text-[10px] text-[#6C746E] dark:text-[#8E9690]">Delivery Specialist</span>
              </div>
            </div>
            <a
              href="https://wa.me/999000000009?text=Hi%20Thierry,%20checking%20in%20from%20Grabbit%20dispatch.%20How%20are%20deliveries%20going%20today%3F"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-[#7ed957]/15 text-[#101412] dark:text-[#7ed957] border border-[#7ed957]/30 hover:bg-[#7ed957]/25 transition-colors"
            >
              <span>💬 WhatsApp</span>
            </a>
          </div>

          {/* Rider 3: Sherif */}
          <div className="flex items-center justify-between p-3 rounded-2xl bg-[#F6F3EC] dark:bg-[#0B0F0C] border border-[#E8E5DC] dark:border-[#1D2620]">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-full bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 font-bold text-xs flex items-center justify-center border border-cyan-500/30">
                S
              </div>
              <div>
                <span className="font-bold text-xs text-[#101412] dark:text-[#F6F3EC] block">Sherif</span>
                <span className="text-[10px] text-[#6C746E] dark:text-[#8E9690]">Fleet Lead</span>
              </div>
            </div>
            <a
              href="https://wa.me/999000000008?text=Hi%20Sherif,%20checking%20in%20from%20Grabbit%20dispatch."
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-[#7ed957]/15 text-[#101412] dark:text-[#7ed957] border border-[#7ed957]/30 hover:bg-[#7ed957]/25 transition-colors"
            >
              <span>💬 WhatsApp</span>
            </a>
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

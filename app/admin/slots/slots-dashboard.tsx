"use client";

import { useState } from "react";
import Link from "next/link";
import { AdminNav } from "@/app/admin/admin-nav";
import type { PreBooking } from "@/lib/orders/pre-booking";
import type { DayOpenSlots, ScheduleSlot, WeekdayKey } from "@/lib/schedule/model";

const DAYS: { key: WeekdayKey; label: string; full: string }[] = [
  { key: "MON", label: "Mon", full: "Monday" },
  { key: "TUES", label: "Tue", full: "Tuesday" },
  { key: "WED", label: "Wed", full: "Wednesday" },
  { key: "THURS", label: "Thu", full: "Thursday" },
  { key: "FRI", label: "Fri", full: "Friday" },
  { key: "SAT", label: "Sat", full: "Saturday" },
  { key: "SUN", label: "Sun", full: "Sunday" },
];

function getRiderBadgeStyle(riderName?: string): { bg: string; text: string; border: string } {
  if (!riderName) return { bg: "bg-slate-900/40", text: "text-slate-500", border: "border-slate-800/40" };
  const clean = riderName.toLowerCase().trim();
  if (clean.includes("thierry")) {
    return { bg: "bg-emerald-950/80", text: "text-emerald-300", border: "border-emerald-700/60" };
  }
  if (clean.includes("sherif")) {
    return { bg: "bg-cyan-950/80", text: "text-cyan-300", border: "border-cyan-700/60" };
  }
  if (clean.includes("moses")) {
    return { bg: "bg-purple-950/80", text: "text-purple-300", border: "border-purple-700/60" };
  }
  if (clean.includes("no rider") || clean.includes("closed") || clean === "-" || clean === "n/a") {
    return { bg: "bg-slate-950/40", text: "text-slate-600", border: "border-slate-800/30" };
  }
  return { bg: "bg-amber-950/80", text: "text-amber-300", border: "border-amber-700/60" };
}

export function SlotsDashboard(props: {
  initialBookings: PreBooking[];
  agentEnabled: boolean;
  scheduleSummary: string;
  slots?: ScheduleSlot[];
  currentWeekday?: WeekdayKey;
  mauritiusNow?: string;
  openNow?: boolean;
  currentRiders?: string[];
  upcomingDays?: DayOpenSlots[];
}) {
  const [bookings, setBookings] = useState<PreBooking[]>(props.initialBookings);
  const [slots, setSlots] = useState<ScheduleSlot[]>(props.slots || []);
  const [loading, setLoading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const RIDER_PRESETS = [
    { label: "— Closed / No Rider —", value: "No Rider Available" },
    { label: "🚴 Thierry", value: "THIERRY(Delivery)" },
    { label: "🚴 Sherif", value: "SHERIF" },
    { label: "🚴 Moses", value: "MOSES" },
    { label: "🚴 Moses & Thierry", value: "MOSES, THIERRY(Delivery)" },
    { label: "🚴 Sherif & Thierry", value: "SHERIF, THIERRY(Delivery)" },
    { label: "🚴 Moses & Sherif", value: "MOSES, SHERIF" },
    { label: "🚴 All 3 (Thierry, Sherif, Moses)", value: "SHERIF, MOSES, THIERRY(Delivery)" },
  ];

  async function refreshBookings() {
    setLoading(true);
    try {
      const res = await fetch("/api/slots");
      const data = await res.json();
      if (data.ok && Array.isArray(data.bookings)) {
        setBookings(data.bookings);
      }
    } catch (err) {
      console.error("Refresh error:", err);
    } finally {
      setLoading(false);
    }
  }

  function handleCellChange(slotIdx: number, day: WeekdayKey, value: string) {
    const updated = [...slots];
    updated[slotIdx] = {
      ...updated[slotIdx],
      byDay: {
        ...updated[slotIdx].byDay,
        [day]: value,
      },
    };
    setSlots(updated);
    setIsDirty(true);
  }

  function handleLabelChange(slotIdx: number, label: string) {
    const updated = [...slots];
    updated[slotIdx] = {
      ...updated[slotIdx],
      label,
    };
    setSlots(updated);
    setIsDirty(true);
  }

  function handleAddSlot() {
    const newSlot: ScheduleSlot = {
      label: "2:00 pm - 3:00 pm",
      startMinutes: 14 * 60,
      endMinutes: 15 * 60,
      byDay: {
        MON: "No Rider Available",
        TUES: "No Rider Available",
        WED: "No Rider Available",
        THURS: "No Rider Available",
        FRI: "No Rider Available",
        SAT: "No Rider Available",
        SUN: "No Rider Available",
      },
    };
    setSlots([...slots, newSlot]);
    setIsDirty(true);
    setIsEditing(true);
  }

  function handleDeleteSlot(slotIdx: number) {
    if (!confirm(`Delete time slot "${slots[slotIdx].label}"?`)) return;
    const updated = slots.filter((_, idx) => idx !== slotIdx);
    setSlots(updated);
    setIsDirty(true);
  }

  async function handleSaveSchedule() {
    setSavingSchedule(true);
    setMessage(null);
    try {
      const res = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slots }),
      });
      const data = await res.json();
      if (data.ok) {
        setIsDirty(false);
        setIsEditing(false);
        setMessage("✅ Schedule updated and immediately synced with AI knowledge!");
      } else {
        setMessage(`❌ Error saving schedule: ${data.error || "Unknown error"}`);
      }
    } catch (err) {
      setMessage(`❌ Failed to save schedule: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingSchedule(false);
    }
  }

  async function cancelSlot(id: string) {
    if (!confirm("Are you sure you want to cancel this booking and free up the slot?")) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/slots?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (data.ok) {
        setMessage(`Slot unlocked for booking ${id}`);
        await refreshBookings();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function clearAll() {
    if (!confirm("Are you sure you want to clear ALL pre-bookings and reset all slots?")) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/slots?clearAll=true`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (data.ok) {
        setMessage("All pre-bookings cleared!");
        await refreshBookings();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  const activeCount = bookings.filter(
    (b) => b.status === "pending_rider" || b.status === "confirmed" || b.status === "dispatched",
  ).length;

  return (
    <div className="space-y-8">
      <AdminNav
        active="slots"
        agentEnabled={props.agentEnabled}
        scheduleSummary={props.scheduleSummary}
      />
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
          <div>
            <h1 className="text-xl font-bold text-[#1f7a4c]">🛵 Grabbit Rider Shifts & Time Slots</h1>
            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400 mt-1">
              <span>🇲🇺 Mauritius: <strong className="text-white">{props.mauritiusNow || "Live"}</strong></span>
              <span>•</span>
              <span>
                Status:{" "}
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
                    props.openNow
                      ? "bg-emerald-950 text-emerald-300 border border-emerald-800"
                      : "bg-rose-950 text-rose-300 border border-rose-800"
                  }`}
                >
                  {props.openNow ? "🟢 Open Now" : "🔴 Closed Now"}
                </span>
              </span>
              {props.currentRiders && props.currentRiders.length > 0 && (
                <>
                  <span>•</span>
                  <span>On Duty: <strong className="text-amber-300">{props.currentRiders.join(", ")}</strong></span>
                </>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isDirty && (
              <button
                onClick={handleSaveSchedule}
                disabled={savingSchedule}
                className="px-3.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm shadow-lg shadow-emerald-900/40 animate-pulse flex items-center gap-1.5"
              >
                {savingSchedule ? "Saving..." : "💾 Save Changes"}
              </button>
            )}
            <button
              onClick={() => setIsEditing(!isEditing)}
              className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
                isEditing
                  ? "bg-amber-950/80 text-amber-300 border-amber-700"
                  : "bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700"
              }`}
            >
              {isEditing ? "👁️ View Mode" : "✏️ Edit Schedule"}
            </button>
            <button
              onClick={refreshBookings}
              disabled={loading}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium disabled:opacity-50"
            >
              {loading ? "Refreshing..." : "🔄 Refresh"}
            </button>
            <button
              onClick={clearAll}
              disabled={loading}
              className="px-3 py-1.5 rounded-lg bg-rose-900/60 hover:bg-rose-800 text-rose-200 border border-rose-700/50 text-sm font-medium disabled:opacity-50"
            >
              🗑️ Clear All
            </button>
          </div>
        </div>

        {message && (
          <div className="p-3 bg-slate-900 border border-emerald-600/60 rounded-xl text-emerald-300 text-sm flex items-center justify-between shadow-lg">
            <span>{message}</span>
            <button onClick={() => setMessage(null)} className="text-slate-400 hover:text-white text-xs">✕</button>
          </div>
        )}

        {/* 1. Daily Rider Schedule Matrix */}
        {slots.length > 0 && (
          <div className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
            <div className="p-4 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="font-semibold text-white flex items-center gap-2">
                  📅 Weekly Rider Duty Schedule
                  {isEditing ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-800 font-medium">
                      ✏️ Edit Mode Active
                    </span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-400 font-normal">
                      Live Matrix
                    </span>
                  )}
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  {isEditing
                    ? "Select riders from the dropdowns below. Click 'Save Changes' to instantly update the AI dispatch."
                    : "Assigned riders for each time slot. Click 'Edit Schedule' to update shifts seamlessly."}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {isEditing && (
                  <button
                    onClick={handleAddSlot}
                    className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-emerald-400 border border-emerald-800 font-medium flex items-center gap-1"
                  >
                    ➕ Add Time Slot
                  </button>
                )}
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Thierry
                </span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400"></span> Sherif
                </span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800">
                  <span className="w-1.5 h-1.5 rounded-full bg-purple-400"></span> Moses
                </span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800 uppercase tracking-wider font-semibold">
                  <tr>
                    <th className="p-3 w-44 border-r border-slate-800/80">Time Slot</th>
                    {DAYS.map((day) => {
                      const isToday = props.currentWeekday === day.key;
                      return (
                        <th
                          key={day.key}
                          className={`p-3 text-center border-r border-slate-800/60 last:border-r-0 ${
                            isToday ? "bg-emerald-950/50 text-emerald-300 font-bold" : ""
                          }`}
                        >
                          <div className="flex items-center justify-center gap-1">
                            <span>{day.label}</span>
                            {isToday && (
                              <span className="px-1.5 py-0.2 rounded text-[10px] bg-emerald-600 text-white font-bold">
                                TODAY
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] opacity-60 font-normal">{day.full}</div>
                        </th>
                      );
                    })}
                    {isEditing && <th className="p-3 text-right w-16">Delete</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {slots.map((slot, sIdx) => {
                    return (
                      <tr key={sIdx} className="hover:bg-slate-800/20 transition-colors">
                        <td className="p-2.5 font-semibold text-slate-200 border-r border-slate-800/80 whitespace-nowrap bg-slate-950/40">
                          {isEditing ? (
                            <input
                              type="text"
                              value={slot.label}
                              onChange={(e) => handleLabelChange(sIdx, e.target.value)}
                              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white focus:border-emerald-500 focus:outline-none"
                            />
                          ) : (
                            slot.label
                          )}
                        </td>
                        {DAYS.map((day) => {
                          const isToday = props.currentWeekday === day.key;
                          const cellValue = slot.byDay[day.key] || "No Rider Available";
                          const style = getRiderBadgeStyle(cellValue);
                          const isClosed =
                            !cellValue ||
                            cellValue.toLowerCase().includes("closed") ||
                            cellValue.toLowerCase().includes("no rider") ||
                            cellValue === "-";

                          return (
                            <td
                              key={day.key}
                              className={`p-2 text-center border-r border-slate-800/40 last:border-r-0 ${
                                isToday ? "bg-emerald-950/20" : ""
                              }`}
                            >
                              {isEditing ? (
                                <select
                                  value={cellValue}
                                  onChange={(e) => handleCellChange(sIdx, day.key, e.target.value)}
                                  className={`w-full text-xs font-medium py-1 px-1.5 rounded border focus:outline-none focus:ring-1 focus:ring-emerald-500 ${style.bg} ${style.text} ${style.border}`}
                                >
                                  {RIDER_PRESETS.map((opt) => (
                                    <option key={opt.value} value={opt.value} className="bg-slate-900 text-white">
                                      {opt.label}
                                    </option>
                                  ))}
                                  {!RIDER_PRESETS.some((p) => p.value === cellValue) && (
                                    <option value={cellValue} className="bg-slate-900 text-white">
                                      {cellValue}
                                    </option>
                                  )}
                                </select>
                              ) : (
                                <span
                                  className={`inline-block w-full py-1 px-2 rounded-lg border text-xs font-medium ${style.bg} ${style.text} ${style.border}`}
                                >
                                  {isClosed ? "—" : cellValue}
                                </span>
                              )}
                            </td>
                          );
                        })}
                        {isEditing && (
                          <td className="p-2 text-right">
                            <button
                              onClick={() => handleDeleteSlot(sIdx)}
                              className="p-1 rounded text-rose-400 hover:bg-rose-950 hover:text-rose-300"
                              title="Delete Slot"
                            >
                              🗑️
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 2. Stats Summary */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Total Bookings</div>
            <div className="text-2xl font-bold text-white mt-1">{bookings.length}</div>
          </div>
          <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Active / Locked</div>
            <div className="text-2xl font-bold text-amber-400 mt-1">{activeCount}</div>
          </div>
          <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Confirmed on Kilo</div>
            <div className="text-2xl font-bold text-emerald-400 mt-1">
              {bookings.filter((b) => b.status === "confirmed").length}
            </div>
          </div>
          <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Declined / Cancelled</div>
            <div className="text-2xl font-bold text-slate-400 mt-1">
              {bookings.filter((b) => b.status === "declined" || b.status === "cancelled").length}
            </div>
          </div>
        </div>

        {message && (
          <div className="p-3 bg-emerald-950/60 border border-emerald-800/80 rounded-lg text-emerald-300 text-sm">
            {message}
          </div>
        )}

        {/* Bookings Table */}
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-800 flex items-center justify-between">
            <h2 className="font-semibold text-white">All Booked Time Slots</h2>
            <span className="text-xs text-slate-400">Max 3 deliveries / 1 trip per slot</span>
          </div>

          {bookings.length === 0 ? (
            <div className="p-10 text-center text-slate-500 text-sm">
              No pre-bookings or locked slots found. All schedule slots are currently open!
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-950/60 text-slate-400 border-b border-slate-800 text-xs uppercase tracking-wider">
                  <tr>
                    <th className="p-3">Time / Slot</th>
                    <th className="p-3">Customer</th>
                    <th className="p-3">Service</th>
                    <th className="p-3">Rider</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Tracking</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {bookings.map((b) => {
                    const isActive =
                      b.status === "pending_rider" || b.status === "confirmed" || b.status === "dispatched";
                    return (
                      <tr key={b.id} className="hover:bg-slate-800/30 transition-colors">
                        <td className="p-3 font-medium text-white">
                          <div>{b.scheduledTime}</div>
                          <div className="text-xs text-slate-400">{b.scheduledDate} ({b.slotKey})</div>
                        </td>
                        <td className="p-3 text-slate-300">
                          <div>{b.customerName}</div>
                          <div className="text-xs text-slate-400">{b.customerPhone}</div>
                        </td>
                        <td className="p-3 text-slate-300">
                          <span className="capitalize">{b.serviceKind}</span>
                          <div className="text-xs text-slate-400 truncate max-w-xs">{b.pickupAddress} → {b.deliveryAddress}</div>
                        </td>
                        <td className="p-3 font-medium text-amber-300">
                          {b.assignedRider}
                        </td>
                        <td className="p-3">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
                              b.status === "confirmed"
                                ? "bg-emerald-950 text-emerald-300 border border-emerald-800"
                                : b.status === "pending_rider"
                                ? "bg-amber-950 text-amber-300 border border-amber-800"
                                : "bg-slate-800 text-slate-400 border border-slate-700"
                            }`}
                          >
                            {b.status}
                          </span>
                        </td>
                        <td className="p-3 text-xs">
                          {b.trackingUrl ? (
                            <a
                              href={b.trackingUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-emerald-400 hover:underline font-mono"
                            >
                              Live Map ↗
                            </a>
                          ) : (
                            <span className="text-slate-600">—</span>
                          )}
                        </td>
                        <td className="p-3 text-right">
                          {isActive && (
                            <button
                              onClick={() => cancelSlot(b.id)}
                              className="px-2.5 py-1 text-xs font-medium rounded bg-rose-950/80 hover:bg-rose-900 text-rose-300 border border-rose-800"
                            >
                              Unlock Slot
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

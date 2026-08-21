"use client";

import { useState, useMemo } from "react";
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
  if (!riderName) return { bg: "bg-[#EDEAE2] dark:bg-[#171E1A]", text: "text-[#6C746E] dark:text-[#8E9690]", border: "border-[#E8E5DC] dark:border-[#1D2620]" };
  const clean = riderName.toLowerCase().trim();
  if (clean.includes("thierry")) {
    return { bg: "bg-[#7ed957]/15", text: "text-[#101412] dark:text-[#7ed957]", border: "border-[#7ed957]/30" };
  }
  if (clean.includes("sherif")) {
    return { bg: "bg-cyan-500/15", text: "text-cyan-800 dark:text-cyan-300", border: "border-cyan-500/30" };
  }
  if (clean.includes("moses")) {
    return { bg: "bg-purple-500/15", text: "text-purple-800 dark:text-purple-300", border: "border-purple-500/30" };
  }
  if (clean.includes("no rider") || clean.includes("closed") || clean === "-" || clean === "n/a") {
    return { bg: "bg-[#EDEAE2] dark:bg-[#171E1A]", text: "text-[#6C746E] dark:text-[#8E9690]", border: "border-[#E8E5DC] dark:border-[#1D2620]" };
  }
  return { bg: "bg-amber-500/15", text: "text-amber-800 dark:text-amber-300", border: "border-amber-500/30" };
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
  const [searchQuery, setSearchQuery] = useState("");

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

  function getRelativeDateLabel(dateStr: string, todayIso: string): string {
    if (!dateStr) return "Unknown";
    try {
      const tTarget = new Date(dateStr + "T00:00:00Z").getTime();
      const tToday = new Date(todayIso + "T00:00:00Z").getTime();
      if (isNaN(tTarget) || isNaN(tToday)) return dateStr;
      const diffDays = Math.round((tTarget - tToday) / (1000 * 60 * 60 * 24));
      if (diffDays === 0) return "Today";
      if (diffDays === 1) return "Tomorrow";
      if (diffDays === -1) return "Yesterday";
      if (diffDays > 1 && diffDays < 7) {
        return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(
          new Date(dateStr + "T00:00:00Z"),
        );
      }
      return dateStr;
    } catch {
      return dateStr;
    }
  }

  const todayMauritius = useMemo(() => getMauritiusIsoDate(0), []);
  const tomorrowMauritius = useMemo(() => getMauritiusIsoDate(1), []);

  const [selectedDate, setSelectedDate] = useState<string>("ALL");

  const RIDER_PRESETS = [
    { label: "Closed / No Rider", value: "No Rider Available" },
    { label: "Thierry", value: "THIERRY(Delivery)" },
    { label: "Sherif", value: "SHERIF" },
    { label: "Moses", value: "MOSES" },
    { label: "Moses & Thierry", value: "MOSES, THIERRY(Delivery)" },
    { label: "Sherif & Thierry", value: "SHERIF, THIERRY(Delivery)" },
    { label: "Moses & Sherif", value: "MOSES, SHERIF" },
    { label: "All 3 (Thierry, Sherif, Moses)", value: "SHERIF, MOSES, THIERRY(Delivery)" },
  ];

  // Completely filter out cancelled or declined bookings from all views & metrics
  const activeBookingsList = useMemo(() => {
    return bookings.filter((b) => b.status !== "cancelled" && b.status !== "declined");
  }, [bookings]);

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
        setMessage("Schedule updated and synced with AI live dispatch.");
      } else {
        setMessage(`Error saving schedule: ${data.error || "Unknown error"}`);
      }
    } catch (err) {
      setMessage(`Failed to save schedule: ${err instanceof Error ? err.message : String(err)}`);
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
        setMessage(`Slot unlocked and booking ${id} removed.`);
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
        setMessage("All pre-bookings cleared.");
        await refreshBookings();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  const activeCount = activeBookingsList.filter(
    (b) => b.status === "pending_rider" || b.status === "confirmed" || b.status === "dispatched",
  ).length;

  const uniqueDates = useMemo(() => {
    const dates = new Set([
      todayMauritius,
      tomorrowMauritius,
      ...activeBookingsList.map((b) => b.scheduledDate).filter(Boolean),
    ]);
    return Array.from(dates).sort().reverse();
  }, [todayMauritius, tomorrowMauritius, activeBookingsList]);

  function parseTimeToMinutesHelper(timeStr: string): number {
    const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
    if (!match) return 0;
    let h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const period = match[3]?.toLowerCase();
    if (period === "pm" && h < 12) h += 12;
    if (period === "am" && h === 12) h = 0;
    return h * 60 + m;
  }

  const sortedBookings = useMemo(() => {
    return [...activeBookingsList].sort((a, b) => {
      const dateCmp = (b.scheduledDate || "").localeCompare(a.scheduledDate || "");
      if (dateCmp !== 0) return dateCmp;
      return parseTimeToMinutesHelper(a.scheduledTime || "") - parseTimeToMinutesHelper(b.scheduledTime || "");
    });
  }, [activeBookingsList]);

  const filteredBookings = sortedBookings.filter((b) => {
    if (selectedDate !== "ALL" && b.scheduledDate !== selectedDate) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      b.customerName?.toLowerCase().includes(q) ||
      b.customerPhone?.toLowerCase().includes(q) ||
      b.serviceKind?.toLowerCase().includes(q) ||
      b.assignedRider?.toLowerCase().includes(q) ||
      b.slotKey?.toLowerCase().includes(q) ||
      b.pickupAddress?.toLowerCase().includes(q) ||
      b.deliveryAddress?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <AdminNav
        active="slots"
        agentEnabled={props.agentEnabled}
        scheduleSummary={props.scheduleSummary}
        mauritiusNow={props.mauritiusNow}
      />

      {/* Header & Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#101412] dark:text-[#F6F3EC]">
            Rider Shifts & Time Slots
          </h1>
          <div className="flex flex-wrap items-center gap-2.5 text-xs text-[#6C746E] dark:text-[#8E9690] mt-1">
            <span>Mauritius: <strong className="text-[#101412] dark:text-[#F6F3EC]">{props.mauritiusNow || "Live"}</strong></span>
            <span>·</span>
            <span>
              Status:{" "}
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${
                  props.openNow
                    ? "bg-[#7ed957]/15 text-[#101412] dark:text-[#7ed957] border border-[#7ed957]/30"
                    : "bg-[#EDEAE2] dark:bg-[#171E1A] text-[#6C746E] dark:text-[#8E9690] border border-[#E8E5DC] dark:border-[#1D2620]"
                }`}
              >
                {props.openNow ? "Open Right Now" : "Closed Right Now"}
              </span>
            </span>
            {props.currentRiders && props.currentRiders.length > 0 && (
              <>
                <span>·</span>
                <span>On Duty: <strong className="text-[#101412] dark:text-[#F6F3EC]">{props.currentRiders.join(", ")}</strong></span>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isDirty && (
            <button
              onClick={handleSaveSchedule}
              disabled={savingSchedule}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#7ed957] hover:bg-[#6fc847] text-[#101412] font-bold text-xs shadow-sm transition-all"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
              <span>{savingSchedule ? "Saving..." : "Save Changes"}</span>
            </button>
          )}
          <button
            onClick={() => setIsEditing(!isEditing)}
            className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-semibold border transition-all ${
              isEditing
                ? "bg-[#101412] dark:bg-[#F6F3EC] text-white dark:text-[#101412] border-[#101412] dark:border-[#F6F3EC]"
                : "bg-[var(--bg-card)] text-[#101412] dark:text-[#F6F3EC] border-[#E8E5DC] dark:border-[#1D2620] hover:border-[#7ed957]"
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            <span>{isEditing ? "Done Editing" : "Edit Schedule"}</span>
          </button>
          <button
            onClick={refreshBookings}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[var(--bg-card)] text-[#101412] dark:text-[#F6F3EC] border border-[#E8E5DC] dark:border-[#1D2620] text-xs font-semibold hover:border-[#7ed957] transition-all disabled:opacity-50"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 21h5v-5" />
            </svg>
            <span>{loading ? "Refreshing..." : "Refresh"}</span>
          </button>
          <button
            onClick={clearAll}
            disabled={loading}
            className="inline-flex items-center gap-1 px-3 py-2 rounded-full bg-[#EDEAE2] dark:bg-[#171E1A] text-[#6C746E] dark:text-[#8E9690] hover:text-rose-600 border border-[#E8E5DC] dark:border-[#1D2620] text-xs font-medium transition-all"
            title="Clear all bookings"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
            <span>Clear Bookings</span>
          </button>
        </div>
      </div>

      {message && (
        <div className="p-3.5 bg-[var(--bg-card)] border border-[#7ed957] rounded-2xl text-xs font-semibold text-[#101412] dark:text-[#F6F3EC] flex items-center justify-between shadow-sm">
          <span>{message}</span>
          <button onClick={() => setMessage(null)} className="text-[#6C746E] hover:text-[#101412] dark:hover:text-[#F6F3EC]">✕</button>
        </div>
      )}

      {/* 1. Weekly Rider Duty Schedule Matrix */}
      {slots.length > 0 && (
        <div className="rounded-[24px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] overflow-hidden shadow-sm">
          <div className="p-5 border-b border-[#E8E5DC] dark:border-[#1D2620] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-base font-bold text-[#101412] dark:text-[#F6F3EC] flex items-center gap-2">
                Weekly Duty Schedule
                {isEditing ? (
                  <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-[#101412] dark:bg-[#F6F3EC] text-white dark:text-[#101412] font-bold">
                    Edit Mode
                  </span>
                ) : (
                  <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-[#EDEAE2] dark:bg-[#171E1A] text-[#6C746E] dark:text-[#8E9690] font-semibold">
                    Live Matrix
                  </span>
                )}
              </h2>
              <p className="text-xs text-[#6C746E] dark:text-[#8E9690] mt-0.5">
                {isEditing
                  ? "Select riders from the dropdowns below. Click 'Save Changes' to instantly update the AI dispatch."
                  : "Assigned riders for each time slot. Click 'Edit Schedule' to update shifts."}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {isEditing && (
                <button
                  onClick={handleAddSlot}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-[#101412] dark:bg-[#F6F3EC] text-white dark:text-[#101412] text-xs font-semibold"
                >
                  <span>+ Add Time Slot</span>
                </button>
              )}
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#7ed957]/15 text-[#101412] dark:text-[#7ed957] border border-[#7ed957]/30 font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-[#7ed957]"></span> Thierry
              </span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-cyan-500/15 text-cyan-800 dark:text-cyan-300 border border-cyan-500/30 font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-500"></span> Sherif
              </span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-purple-500/15 text-purple-800 dark:text-purple-300 border border-purple-500/30 font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-purple-500"></span> Moses
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-[#F6F3EC] dark:bg-[#0B0F0C] text-[#6C746E] dark:text-[#8E9690] border-b border-[#E8E5DC] dark:border-[#1D2620] uppercase tracking-wider font-semibold">
                <tr>
                  <th className="p-3.5 w-44 border-r border-[#E8E5DC] dark:border-[#1D2620]">Time Slot</th>
                  {DAYS.map((day) => {
                    const isToday = props.currentWeekday === day.key;
                    return (
                      <th
                        key={day.key}
                        className={`p-3.5 text-center border-r border-[#E8E5DC] dark:border-[#1D2620] last:border-r-0 ${
                          isToday ? "bg-[#7ed957]/10 text-[#101412] dark:text-[#7ed957] font-bold" : ""
                        }`}
                      >
                        <div className="flex items-center justify-center gap-1.5">
                          <span>{day.label}</span>
                          {isToday && (
                            <span className="px-1.5 py-0.2 rounded-full text-[9px] bg-[#7ed957] text-[#101412] font-extrabold">
                              TODAY
                            </span>
                          )}
                        </div>
                      </th>
                    );
                  })}
                  {isEditing && <th className="p-3.5 text-right w-16">Remove</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E8E5DC] dark:border-[#1D2620]">
                {slots.map((slot, sIdx) => {
                  return (
                    <tr key={sIdx} className="hover:bg-[#F6F3EC]/50 dark:hover:bg-[#0B0F0C]/50 transition-colors">
                      <td className="p-3 font-semibold text-[#101412] dark:text-[#F6F3EC] border-r border-[#E8E5DC] dark:border-[#1D2620] whitespace-nowrap bg-[#F6F3EC]/30 dark:bg-[#0B0F0C]/30">
                        {isEditing ? (
                          <input
                            type="text"
                            value={slot.label}
                            onChange={(e) => handleLabelChange(sIdx, e.target.value)}
                            className="w-full bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] rounded-xl px-2.5 py-1.5 text-xs text-[#101412] dark:text-[#F6F3EC] focus:border-[#7ed957] focus:outline-none"
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
                            className={`p-2.5 text-center border-r border-[#E8E5DC] dark:border-[#1D2620] last:border-r-0 ${
                              isToday ? "bg-[#7ed957]/5" : ""
                            }`}
                          >
                            {isEditing ? (
                              <select
                                value={cellValue}
                                onChange={(e) => handleCellChange(sIdx, day.key, e.target.value)}
                                className={`w-full text-xs font-medium py-1.5 px-2 rounded-xl border focus:outline-none focus:ring-1 focus:ring-[#7ed957] bg-[var(--bg-card)] text-[#101412] dark:text-[#F6F3EC] border-[#E8E5DC] dark:border-[#1D2620]`}
                              >
                                {RIDER_PRESETS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))}
                                {!RIDER_PRESETS.some((p) => p.value === cellValue) && (
                                  <option value={cellValue}>
                                    {cellValue}
                                  </option>
                                )}
                              </select>
                            ) : (
                              <span
                                className={`inline-block w-full py-1.5 px-2 rounded-full border text-xs font-semibold ${style.bg} ${style.text} ${style.border}`}
                              >
                                {isClosed ? "—" : cellValue}
                              </span>
                            )}
                          </td>
                        );
                      })}
                      {isEditing && (
                        <td className="p-2.5 text-right">
                          <button
                            onClick={() => handleDeleteSlot(sIdx)}
                            className="p-1.5 rounded-lg text-[#6C746E] hover:text-rose-600 transition-colors"
                            title="Delete Slot"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M3 6h18" />
                              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                            </svg>
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

      {/* 2. Stats Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="rounded-[20px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-4 shadow-sm">
          <span className="text-[11px] font-semibold text-[#6C746E] dark:text-[#8E9690] uppercase tracking-wider">Total Bookings</span>
          <div className="font-display text-2xl font-bold text-[#101412] dark:text-[#F6F3EC] mt-1">{activeBookingsList.length}</div>
        </div>
        <div className="rounded-[20px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-4 shadow-sm">
          <span className="text-[11px] font-semibold text-[#6C746E] dark:text-[#8E9690] uppercase tracking-wider">Active / Locked</span>
          <div className="font-display text-2xl font-bold text-amber-600 dark:text-amber-400 mt-1">{activeCount}</div>
        </div>
        <div className="rounded-[20px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-4 shadow-sm">
          <span className="text-[11px] font-semibold text-[#6C746E] dark:text-[#8E9690] uppercase tracking-wider">Confirmed</span>
          <div className="font-display text-2xl font-bold text-[#7ed957] mt-1">
            {activeBookingsList.filter((b) => b.status === "confirmed").length}
          </div>
        </div>
        <div className="rounded-[20px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-4 shadow-sm">
          <span className="text-[11px] font-semibold text-[#6C746E] dark:text-[#8E9690] uppercase tracking-wider">Pending Rider</span>
          <div className="font-display text-2xl font-bold text-[#6C746E] dark:text-[#8E9690] mt-1">
            {activeBookingsList.filter((b) => b.status === "pending_rider").length}
          </div>
        </div>
      </div>

      {/* 3. Bookings Table */}
      <div className="rounded-[24px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] overflow-hidden shadow-sm">
        <div className="p-5 border-b border-[#E8E5DC] dark:border-[#1D2620] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-bold text-[#101412] dark:text-[#F6F3EC]">Active Booked Time Slots</h2>
            <p className="text-xs text-[#6C746E] dark:text-[#8E9690]">Max 3 deliveries / 1 trip per slot · Cancelled bookings are automatically purged</p>
          </div>

          {/* Date Filter & Search bar */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full sm:w-auto">
            <div className="flex items-center gap-1.5 bg-[#F6F3EC] dark:bg-[#0B0F0C] border border-[#E8E5DC] dark:border-[#1D2620] rounded-full px-3.5 py-1.5 text-xs shadow-xs">
              <span className="text-[#6C746E] dark:text-[#8E9690] text-[11px] font-semibold">Filter Date:</span>
              <select
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="bg-transparent text-[#101412] dark:text-[#F6F3EC] font-bold text-xs focus:outline-none cursor-pointer pr-1"
              >
                <option value="ALL">All Dates ({activeBookingsList.length})</option>
                {uniqueDates.map((d) => {
                  const count = activeBookingsList.filter((b) => b.scheduledDate === d).length;
                  const label = getRelativeDateLabel(d, todayMauritius);
                  const displayLabel = label === d ? d : `${label} (${d})`;
                  return (
                    <option key={d} value={d}>
                      {displayLabel} — {count} {count === 1 ? "booking" : "bookings"}
                    </option>
                  );
                })}
              </select>
            </div>

            <div className="relative w-full sm:w-60">
              <input
                type="text"
                placeholder="Search customer, rider, slot..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded-full bg-[#F6F3EC] dark:bg-[#0B0F0C] border border-[#E8E5DC] dark:border-[#1D2620] px-4 py-2 text-xs text-[#101412] dark:text-[#F6F3EC] placeholder-[#6C746E] focus:border-[#7ed957] focus:outline-none"
              />
            </div>
          </div>
        </div>

        {/* Quick Date Tabs */}
        <div className="px-5 py-2.5 bg-[#F6F3EC]/60 dark:bg-[#0B0F0C]/60 border-b border-[#E8E5DC] dark:border-[#1D2620] flex flex-wrap items-center gap-1.5 text-xs">
          <button
            onClick={() => setSelectedDate("ALL")}
            className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
              selectedDate === "ALL"
                ? "bg-[#101412] dark:bg-[#F6F3EC] text-white dark:text-[#101412] shadow-xs"
                : "bg-[var(--bg-card)] text-[#6C746E] dark:text-[#8E9690] hover:text-[#101412] dark:hover:text-[#F6F3EC] border border-[#E8E5DC] dark:border-[#1D2620]"
            }`}
          >
            All Bookings ({activeBookingsList.length})
          </button>
          {uniqueDates.map((d) => {
            const count = activeBookingsList.filter((b) => b.scheduledDate === d).length;
            const label = getRelativeDateLabel(d, todayMauritius);
            return (
              <button
                key={d}
                onClick={() => setSelectedDate(d)}
                className={`px-3 py-1 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  selectedDate === d
                    ? "bg-[#7ed957] text-[#101412] font-bold shadow-xs"
                    : "bg-[var(--bg-card)] text-[#6C746E] dark:text-[#8E9690] hover:text-[#101412] dark:hover:text-[#F6F3EC] border border-[#E8E5DC] dark:border-[#1D2620]"
                }`}
              >
                <span>{label}</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                  selectedDate === d ? "bg-[#101412] text-white" : "bg-[#EDEAE2] dark:bg-[#171E1A] text-[#6C746E] dark:text-[#8E9690]"
                }`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {filteredBookings.length === 0 ? (
          <div className="p-12 text-center text-[#6C746E] dark:text-[#8E9690] text-xs">
            {searchQuery ? "No bookings matched your search query." : "No active bookings or locked slots found. All slots are open."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#F6F3EC] dark:bg-[#0B0F0C] text-[#6C746E] dark:text-[#8E9690] border-b border-[#E8E5DC] dark:border-[#1D2620] uppercase tracking-wider font-semibold">
                <tr>
                  <th className="p-3.5">Time / Slot</th>
                  <th className="p-3.5">Customer</th>
                  <th className="p-3.5">Service</th>
                  <th className="p-3.5">Rider</th>
                  <th className="p-3.5">Status</th>
                  <th className="p-3.5">Tracking</th>
                  <th className="p-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E8E5DC] dark:divide-[#1D2620]">
                {filteredBookings.map((b) => {
                  const isActive =
                    b.status === "pending_rider" || b.status === "confirmed" || b.status === "dispatched";
                  const dateLabel = getRelativeDateLabel(b.scheduledDate, todayMauritius);
                  return (
                    <tr key={b.id} className="hover:bg-[#F6F3EC]/50 dark:hover:bg-[#0B0F0C]/50 transition-colors">
                      <td className="p-3.5 font-semibold text-[#101412] dark:text-[#F6F3EC]">
                        <div>{b.scheduledTime}</div>
                        <div className="text-[11px] text-[#6C746E] dark:text-[#8E9690] font-normal">
                          <span className="font-semibold text-[#101412] dark:text-[#F6F3EC]">{dateLabel}</span> ({b.scheduledDate}) · {b.slotKey}
                        </div>
                      </td>
                      <td className="p-3.5 text-[#101412] dark:text-[#F6F3EC]">
                        <div className="font-semibold">{b.customerName}</div>
                        <div className="text-[11px] text-[#6C746E] dark:text-[#8E9690] font-mono">{b.customerPhone}</div>
                      </td>
                      <td className="p-3.5 text-[#101412] dark:text-[#F6F3EC]">
                        <span className="capitalize font-semibold">{b.serviceKind}</span>
                        <div className="text-[11px] text-[#6C746E] dark:text-[#8E9690] truncate max-w-xs">{b.pickupAddress} → {b.deliveryAddress}</div>
                      </td>
                      <td className="p-3.5 font-semibold text-[#101412] dark:text-[#F6F3EC]">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-[#7ed957]/15 text-[#101412] dark:text-[#7ed957] border border-[#7ed957]/30 text-xs font-bold">
                          {b.assignedRider}
                        </span>
                      </td>
                      <td className="p-3.5">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold ${
                            b.status === "confirmed"
                              ? "bg-[#7ed957]/15 text-[#101412] dark:text-[#7ed957] border border-[#7ed957]/30"
                              : b.status === "pending_rider"
                              ? "bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/30"
                              : "bg-[#EDEAE2] dark:bg-[#171E1A] text-[#6C746E] dark:text-[#8E9690] border border-[#E8E5DC] dark:border-[#1D2620]"
                          }`}
                        >
                          {b.status}
                        </span>
                      </td>
                      <td className="p-3.5 text-xs">
                        {b.trackingUrl ? (
                          <a
                            href={b.trackingUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[#101412] dark:text-[#7ed957] underline font-medium hover:opacity-80"
                          >
                            Live Map ↗
                          </a>
                        ) : (
                          <span className="text-[#6C746E] dark:text-[#8E9690]">—</span>
                        )}
                      </td>
                      <td className="p-3.5 text-right">
                        {isActive && (
                          <button
                            onClick={() => cancelSlot(b.id)}
                            className="px-3 py-1 text-xs font-semibold rounded-full bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 border border-rose-500/20 transition-colors"
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
  );
}

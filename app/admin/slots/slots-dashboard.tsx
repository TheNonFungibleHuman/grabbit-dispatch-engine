"use client";

import { useState } from "react";
import Link from "next/link";
import { AdminNav } from "@/app/admin/admin-nav";
import type { PreBooking } from "@/lib/orders/pre-booking";

export function SlotsDashboard(props: {
  initialBookings: PreBooking[];
  agentEnabled: boolean;
  scheduleSummary: string;
}) {
  const [bookings, setBookings] = useState<PreBooking[]>(props.initialBookings);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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
      const res = await fetch("/api/slots?clearAll=true", {
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
            <h1 className="text-xl font-bold text-[#1f7a4c]">🛵 Grabbit Time Slots & Pre-Bookings</h1>
            <p className="text-sm text-slate-500 mt-1">{props.scheduleSummary}</p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/admin"
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm"
            >
              ← Admin Home
            </Link>
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

        {/* Stats */}
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

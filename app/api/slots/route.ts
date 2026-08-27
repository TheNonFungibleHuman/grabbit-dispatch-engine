import { NextResponse } from "next/server";
import { isAdminAuthed } from "@/lib/admin/auth";
import {
  cancelPreBooking,
  clearAllPreBookings,
  listAllPreBookings,
} from "@/lib/orders/pre-booking";
import { mauritiusDateIso } from "@/lib/time";

export async function GET() {
  const { syncBookingToKiloIfMissing } = await import("@/lib/orders/pre-booking");
  const raw = await listAllPreBookings();

  const todayIso = mauritiusDateIso(new Date());
  const allowedDates = new Set([
    mauritiusDateIso(new Date(), -2),
    mauritiusDateIso(new Date(), -1),
    todayIso,
    mauritiusDateIso(new Date(), 1),
  ]);

  const valid = raw.filter((b) => {
    if (b.status === "cancelled" || b.status === "declined") return false;
    const bDate =
      b.scheduledDate && b.scheduledDate !== "today" && b.scheduledDate !== "tomorrow"
        ? b.scheduledDate
        : b.slotKey?.split("_")[0] || b.createdAt?.slice(0, 10);
    return allowedDates.has(bDate) || (b.scheduledDate === "today" && allowedDates.has(todayIso));
  });

  const bookings = await Promise.all(valid.map((b) => syncBookingToKiloIfMissing(b)));
  return NextResponse.json({
    ok: true,
    total: bookings.length,
    bookings,
  });
}

export async function DELETE(request: Request) {
  if (!(await isAdminAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const clearAll = searchParams.get("clearAll") === "true";

  if (clearAll) {
    await clearAllPreBookings();
    return NextResponse.json({ ok: true, message: "All pre-bookings cleared" });
  }

  if (id) {
    const cancelled = await cancelPreBooking(id);
    return NextResponse.json({
      ok: cancelled,
      message: cancelled ? `Booking ${id} cancelled and slot unlocked` : "Booking not found",
    });
  }

  return NextResponse.json({ error: "Missing id or clearAll parameter" }, { status: 400 });
}

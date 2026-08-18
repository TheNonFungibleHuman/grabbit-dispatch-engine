import { NextResponse } from "next/server";
import {
  cancelPreBooking,
  clearAllPreBookings,
  listAllPreBookings,
} from "@/lib/orders/pre-booking";

export async function GET() {
  const bookings = await listAllPreBookings();
  return NextResponse.json({
    ok: true,
    total: bookings.length,
    bookings,
  });
}

export async function DELETE(request: Request) {
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

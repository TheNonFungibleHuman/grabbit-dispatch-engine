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

export async function POST(request: Request) {
  if (!(await isAdminAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const {
      customerName,
      customerPhone,
      pickupAddress,
      deliveryAddress,
      scheduledDate,
      scheduledTime,
      assignedRider,
      serviceKind = "trip",
      paymentMethod = "cash",
      packageDescription,
    } = body;

    if (!customerName || !pickupAddress || !deliveryAddress || !scheduledTime) {
      return NextResponse.json(
        { error: "Missing required fields: name, pickup, delivery, or time" },
        { status: 400 },
      );
    }

    const { savePreBooking, syncBookingToKiloIfMissing } =
      await import("@/lib/orders/pre-booking");

    const dateIso = scheduledDate || mauritiusDateIso(new Date());
    const cleanTime = scheduledTime.replace(/\s+/g, "").toLowerCase();
    const slotKey = `${dateIso}_${cleanTime}`;
    const id = `pb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const newBooking = {
      id,
      slotKey,
      scheduledDate: dateIso,
      scheduledTime,
      assignedRider: assignedRider || "Sherif",
      customerPhone: customerPhone || "Walk-in",
      customerName,
      pickupAddress,
      deliveryAddress,
      serviceKind: (serviceKind === "errand_or_delivery" || serviceKind === "pickup_delivery"
        ? "pickup_delivery"
        : "trip") as "pickup_delivery" | "trip",
      packageDescription: packageDescription || (serviceKind === "trip" ? `Trip to ${deliveryAddress}` : `Delivery from ${pickupAddress}`),
      status: "confirmed" as const,
      paymentMethod,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await savePreBooking(newBooking);
    const synced = await syncBookingToKiloIfMissing(newBooking);

    return NextResponse.json({
      ok: true,
      booking: synced,
      message: `Booking created successfully for ${customerName}`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create booking" },
      { status: 500 },
    );
  }
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

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
      assignedRider = "Sherif",
      serviceKind = "trip",
      paymentMethod = "cash",
      fareAmount,
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
    const { notifyRiderForBooking } = await import("@/lib/riders/notify-rider");
    const { findRiderByName } = await import("@/lib/riders/config");
    const { sendCustomerText } = await import("@/lib/wasender/send-tracked");
    const { appendTranscriptEntry } = await import("@/lib/agent/transcript");

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
      fareAmount: fareAmount ? String(fareAmount).trim() : undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await savePreBooking(newBooking);
    const synced = await syncBookingToKiloIfMissing(newBooking);

    // 1. Notify the assigned fleet rider (WhatsApp for Sherif/Thierry, Google Chat for Moses)
    try {
      await notifyRiderForBooking({
        bookingId: synced.id,
        customerName,
        customerPhone: customerPhone || "Walk-in",
        serviceKind: serviceKind === "trip" ? "trip" : "delivery",
        pickupAddress,
        dropoffAddress: deliveryAddress,
        scheduledTime: `${scheduledTime} (${dateIso})`,
        assignedRider: assignedRider || "Sherif",
        trackingUrl: synced.trackingUrl,
      });
    } catch (riderErr) {
      console.error("[slots] failed to notify rider", riderErr);
    }

    // 2. Notify the customer via WhatsApp if valid phone provided
    const cleanPhone = (customerPhone || "").replace(/\D/g, "");
    if (cleanPhone.length >= 7) {
      const to = customerPhone.startsWith("+") ? customerPhone : `+${cleanPhone}`;
      const riderProfile = findRiderByName(assignedRider || "Sherif");
      const riderContact = riderProfile?.phone ? `${riderProfile.name} (${riderProfile.phone})` : (riderProfile?.name || assignedRider);
      const fareLine = fareAmount ? `• *Fare:* Rs ${fareAmount}` : "";
      const customerMsg = [
        `Hello ${customerName}! 👋 Your ${serviceKind === "trip" ? "trip" : "delivery"} has been confirmed by Grabbit Dispatch. ✅`,
        ``,
        `🛵 *Booking Details:*`,
        `• *Pickup:* ${pickupAddress}`,
        `• *Destination:* ${deliveryAddress}`,
        `• *Time:* ${scheduledTime} (${dateIso})`,
        fareLine,
        `• *Payment:* ${paymentMethod === "cash" ? "Cash to rider" : "Bank Transfer / Juice"}`,
        `• *Assigned Rider:* ${riderContact}`,
        synced.trackingUrl ? `\n🔴 *Live Tracking:* ${synced.trackingUrl}` : ``,
        ``,
        `We look forward to taking you! 🛵⚡`,
      ].filter(Boolean).join("\n");

      try {
        await sendCustomerText({
          to,
          text: customerMsg,
          messageId: `dispatch_${synced.id}`,
        });
        await appendTranscriptEntry(to, {
          role: "agent",
          text: customerMsg,
          messageId: `dispatch_${synced.id}`,
        });
      } catch (custErr) {
        console.error("[slots] failed to send customer whatsapp confirmation", custErr);
      }
    }

    return NextResponse.json({
      ok: true,
      booking: synced,
      message: `Booking created successfully for ${customerName} (Rider & Customer notified)`,
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

import { readJson, writeJson } from "../blob/json-store.ts";
import { formatError, logError, logInfo, logWarn } from "../log.ts";
import { FLEET_RIDERS, findRiderByName, findRiderByPhone, getCustomTrackingUrl, type RiderProfile } from "../riders/config.ts";
import { notifyRiderForBooking } from "../riders/notify-rider.ts";
import { assignDeliveryRider, createDelivery } from "../kilo/client.ts";
import { sendCustomerText } from "../wasender/send-tracked.ts";
import type { CreateKiloDeliveryInput, KiloErrandMode, KiloPackageSize, KiloServiceKind } from "../kilo/types.ts";

export interface PreBooking {
  id: string;
  customerPhone: string;
  customerName: string;
  serviceKind: "pickup_delivery" | "errand" | "trip";
  pickupAddress: string;
  deliveryAddress: string;
  packageDescription?: string;
  packageSize?: KiloPackageSize;
  packageImages?: string[];
  pickupCoords?: { lat: number; lng: number };
  deliveryCoords?: { lat: number; lng: number };
  scheduledDate: string; // e.g. "2026-08-19"
  scheduledTime: string; // e.g. "12:00 pm"
  slotKey: string;       // e.g. "2026-08-19_12:00-13:00"
  assignedRider: string; // e.g. "Thierry"
  status: "pending_rider" | "confirmed" | "dispatched" | "declined" | "cancelled";
  kiloDeliveryId?: string;
  trackingUrl?: string;
  createdAt: string;
  updatedAt: string;
}

const INDEX_PATH = "grabbit/prebookings/index.json";

function bookingPath(id: string): string {
  return `grabbit/prebookings/${id}.json`;
}

export async function listAllPreBookings(): Promise<PreBooking[]> {
  const index = await readJson<{ ids: string[] }>(INDEX_PATH);
  if (!index?.ids || !Array.isArray(index.ids)) return [];

  const bookings: PreBooking[] = [];
  for (const id of index.ids) {
    const record = await readJson<PreBooking>(bookingPath(id));
    if (record) bookings.push(record);
  }
  return bookings;
}

export async function savePreBooking(booking: PreBooking): Promise<void> {
  await writeJson(bookingPath(booking.id), {
    ...booking,
    updatedAt: new Date().toISOString(),
  });

  const index = await readJson<{ ids: string[] }>(INDEX_PATH) || { ids: [] };
  if (!index.ids.includes(booking.id)) {
    index.ids.push(booking.id);
    await writeJson(INDEX_PATH, index);
  }
}

const MAX_DELIVERIES_PER_SLOT = 3;

/**
 * Checks if a rider's slot has available capacity (Anti-Double-Booking Guard).
 */
export async function checkSlotAvailability(args: {
  slotKey: string;
  assignedRider: string;
  customerPhone?: string;
  serviceKind?: string;
}): Promise<{ available: boolean; conflictingBooking?: PreBooking }> {
  const all = await listAllPreBookings();
  const riderNormalized = args.assignedRider.trim().toLowerCase();
  const cleanCustomer = args.customerPhone?.replace(/\D/g, "");

  const activeBookings = all.filter(
    (b) =>
      b.slotKey === args.slotKey &&
      b.assignedRider.toLowerCase().includes(riderNormalized) &&
      (b.status === "pending_rider" || b.status === "confirmed" || b.status === "dispatched"),
  );

  // If the same customer already has a pending booking for this slot, allow updating it
  const isSameCustomer = cleanCustomer && activeBookings.some((b) => b.customerPhone.replace(/\D/g, "") === cleanCustomer);
  if (isSameCustomer) {
    return { available: true };
  }

  // Passenger trips are strictly 1 per slot; Deliveries/errands allow up to MAX_DELIVERIES_PER_SLOT
  const maxCapacity = args.serviceKind === "trip" ? 1 : MAX_DELIVERIES_PER_SLOT;

  if (activeBookings.length >= maxCapacity) {
    return { available: false, conflictingBooking: activeBookings[0] };
  }

  return { available: true };
}

export async function cancelPreBooking(id: string): Promise<boolean> {
  const all = await listAllPreBookings();
  const found = all.find((b) => b.id === id);
  if (!found) return false;
  found.status = "cancelled";
  await savePreBooking(found);
  return true;
}

export async function clearAllPreBookings(): Promise<void> {
  await writeJson(INDEX_PATH, { ids: [] });
}

/**
 * Creates a pre-booking request, checks for capacity, and notifies the rider.
 */
export async function createPreBookingRequest(args: {
  customerPhone: string;
  customerName: string;
  serviceKind: "pickup_delivery" | "errand" | "trip";
  pickupAddress: string;
  deliveryAddress: string;
  packageDescription?: string;
  packageSize?: KiloPackageSize;
  packageImages?: string[];
  pickupCoords?: { lat: number; lng: number };
  deliveryCoords?: { lat: number; lng: number };
  scheduledDate: string;
  scheduledTime: string;
  slotKey: string;
  assignedRider: string;
}): Promise<{
  ok: boolean;
  booking?: PreBooking;
  error?: string;
  doubleBooked?: boolean;
}> {
  // 1. Anti-Double-Booking / Capacity Check
  const availability = await checkSlotAvailability({
    slotKey: args.slotKey,
    assignedRider: args.assignedRider,
    customerPhone: args.customerPhone,
    serviceKind: args.serviceKind,
  });

  if (!availability.available) {
    logWarn("prebooking", "slot capacity reached", {
      slotKey: args.slotKey,
      assignedRider: args.assignedRider,
      existingCustomer: availability.conflictingBooking?.customerPhone,
    });
    return {
      ok: false,
      doubleBooked: true,
      error: `Rider ${args.assignedRider} is fully booked for ${args.scheduledTime}. Please choose another time slot.`,
    };
  }

  const bookingId = `pb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const booking: PreBooking = {
    id: bookingId,
    customerPhone: args.customerPhone,
    customerName: args.customerName,
    serviceKind: args.serviceKind,
    pickupAddress: args.pickupAddress,
    deliveryAddress: args.deliveryAddress,
    packageDescription: args.packageDescription,
    packageSize: args.packageSize || "small",
    packageImages: args.packageImages || [],
    pickupCoords: args.pickupCoords,
    deliveryCoords: args.deliveryCoords,
    scheduledDate: args.scheduledDate,
    scheduledTime: args.scheduledTime,
    slotKey: args.slotKey,
    assignedRider: args.assignedRider,
    status: "pending_rider",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await savePreBooking(booking);

  logInfo("prebooking", "created pre-booking record", {
    bookingId,
    customer: args.customerPhone,
    slotKey: args.slotKey,
    assignedRider: args.assignedRider,
  });

  // 2. Dispatch notification to assigned rider
  await notifyRiderForBooking({
    bookingId,
    customerName: args.customerName,
    customerPhone: args.customerPhone,
    serviceKind: args.serviceKind,
    pickupAddress: args.pickupAddress,
    dropoffAddress: args.deliveryAddress,
    scheduledTime: `${args.scheduledDate} ${args.scheduledTime}`,
    assignedRider: args.assignedRider,
  });

  return { ok: true, booking };
}

/**
 * Handles incoming WhatsApp message from a rider (e.g. YES / NO).
 */
export async function handleRiderReply(args: {
  senderPhone: string;
  text: string;
}): Promise<{ handled: boolean; responseMessage?: string }> {
  const rider = findRiderByPhone(args.senderPhone);
  if (!rider) {
    return { handled: false };
  }

  const cleanText = args.text.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "");
  const isAccept =
    cleanText === "yes" ||
    cleanText === "confirm" ||
    cleanText === "confirmed" ||
    cleanText === "ok" ||
    cleanText === "y" ||
    cleanText === "accept" ||
    cleanText === "accepted" ||
    cleanText.startsWith("yes") ||
    cleanText.startsWith("confirm");

  const isDecline =
    cleanText === "no" ||
    cleanText === "decline" ||
    cleanText === "declined" ||
    cleanText === "n" ||
    cleanText === "reject" ||
    cleanText.startsWith("no") ||
    cleanText.startsWith("decline");

  if (!isAccept && !isDecline) {
    // If rider sent another message, acknowledge them without letting it fall to customer AI
    return {
      handled: true,
      responseMessage: `Hi ${rider.name}, to respond to trip requests, reply *YES* to accept or *NO* to decline.`,
    };
  }

  // Find latest pending pre-booking for this rider (or latest pending if in test mode)
  const isTestMode = Boolean(
    process.env.TEST_RIDER_PHONE &&
      args.senderPhone.replace(/\D/g, "") === process.env.TEST_RIDER_PHONE.replace(/\D/g, ""),
  );

  const all = await listAllPreBookings();
  const pending = all
    .filter(
      (b) =>
        b.status === "pending_rider" &&
        (isTestMode || b.assignedRider.toLowerCase().includes(rider.name.toLowerCase())),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];

  const actualRider = (pending ? findRiderByName(pending.assignedRider) : null) || rider;

  if (!pending) {
    logInfo("prebooking", "rider replied but no pending booking found", {
      rider: rider.name,
      reply: args.text,
    });
    return {
      handled: true,
      responseMessage: `Hi ${actualRider.name}, you have no pending trip requests right now.`,
    };
  }

  if (isDecline) {
    pending.status = "declined";
    await savePreBooking(pending);

    logInfo("prebooking", "rider declined booking", {
      bookingId: pending.id,
      rider: actualRider.name,
    });

    // Notify customer
    try {
      await sendCustomerText({
        to: pending.customerPhone,
        text: `Hello ${pending.customerName || "there"}, rider ${actualRider.name} is unavailable for your requested time (${pending.scheduledTime}). Would you like to select another time?`,
        messageId: `decline_${pending.id}_${Date.now()}`,
      });
    } catch (custErr) {
      logWarn("prebooking", "error notifying customer of decline", formatError(custErr));
    }

    return {
      handled: true,
      responseMessage: `Understood, ${actualRider.name}. The request has been declined.`,
    };
  }

  // Rider accepted: Dispatch on Kilo Fleet & send tracking link!
  logInfo("prebooking", "rider accepted booking, creating Kilo delivery", {
    bookingId: pending.id,
    rider: actualRider.name,
  });

  try {
    const hasPhotos = Boolean(pending.packageImages && pending.packageImages.length > 0);
    // For food orders, errands, or passenger trips without package photos, use errand with at_place mode
    const isTripOrErrand = pending.serviceKind === "trip" || pending.serviceKind === "errand" || !hasPhotos;
    const serviceKind: KiloServiceKind = isTripOrErrand ? "errand" : (pending.serviceKind as any);
    const errandMode: KiloErrandMode | undefined = serviceKind === "errand" ? "at_place" : undefined;

    const kiloPayload: CreateKiloDeliveryInput = {
      serviceKind,
      errandMode,
      deliveryMode: "pickup",
      senderName: pending.customerName || "Customer",
      senderPhone: pending.customerPhone,
      receiverName: pending.customerName || "Customer",
      receiverPhone: pending.customerPhone,
      pickupAddress: pending.pickupAddress,
      pickupCoords: pending.pickupCoords || { lat: -20.1024, lng: 57.5621 },
      deliveryAddress: pending.deliveryAddress,
      deliveryCoords: pending.deliveryCoords || { lat: -20.1026, lng: 57.5620 },
      packageDescription: pending.packageDescription || `${pending.serviceKind.toUpperCase()} booking for ${pending.scheduledTime}`,
      packageSize: pending.packageSize || "small",
      packageImages: hasPhotos ? pending.packageImages! : [],
      customerCollectionMethod: "cash_on_delivery",
      idempotencyKey: `kilo_${pending.id}`,
    };

    const kiloRes = await createDelivery(kiloPayload);
    const delivery = kiloRes.delivery;

    // Assign rider in Kilo
    if (actualRider.kiloRiderId) {
      try {
        await assignDeliveryRider(delivery.id, actualRider.kiloRiderId);
        logInfo("prebooking", "assigned rider in Kilo", {
          deliveryId: delivery.id,
          riderId: actualRider.kiloRiderId,
        });
      } catch (assignErr) {
        logWarn("prebooking", "kilo assign warning", formatError(assignErr));
      }
    }

    const trackingUrl = getCustomTrackingUrl(delivery.id, delivery.access_code);
    pending.status = "confirmed";
    pending.kiloDeliveryId = delivery.id;
    pending.trackingUrl = trackingUrl;
    await savePreBooking(pending);

    // Send tracking link to customer!
    const customerMsg = [
      `✅ *Your ${pending.serviceKind} is confirmed!*`,
      `Rider *${actualRider.name}* has accepted and is scheduled for *${pending.scheduledTime}*.`,
      ``,
      `📍 Pickup: ${pending.pickupAddress}`,
      `📍 Drop-off: ${pending.deliveryAddress}`,
      ``,
      `🔴 *Live Tracking Link:*`,
      trackingUrl,
      ``,
      `Thank you for choosing Grabbit Express! 🛵⚡`,
    ].join("\n");

    try {
      await sendCustomerText({
        to: pending.customerPhone,
        text: customerMsg,
        messageId: `confirm_${pending.id}_${Date.now()}`,
      });
      logInfo("prebooking", "customer notified with tracking url", {
        customer: pending.customerPhone,
        trackingUrl,
      });
    } catch (custSendErr) {
      logWarn("prebooking", "warning sending customer tracking text", formatError(custSendErr));
    }

    return {
      handled: true,
      responseMessage: `👍 Thanks ${actualRider.name}! The trip for ${pending.customerName} at ${pending.scheduledTime} is confirmed.\n\nLive Tracking Link: ${trackingUrl}`,
    };
  } catch (error) {
    logError("prebooking", "failed to create Kilo delivery on rider acceptance", error);
    return {
      handled: true,
      responseMessage: `Trip accepted, but had a temporary hiccup dispatching to Kilo. Support notified.`,
    };
  }
}

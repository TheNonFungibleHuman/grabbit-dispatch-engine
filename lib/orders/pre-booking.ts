import { readJson, writeJson } from "../blob/json-store.ts";
import { formatError, logError, logInfo, logWarn } from "../log.ts";
import { FLEET_RIDERS, findRiderByName, findRiderByPhone, getCustomTrackingUrl, isAuthorizedRiderOrAdmin, type RiderProfile } from "../riders/config.ts";
import { notifyRiderForBooking, notifyRiderOfReschedule } from "../riders/notify-rider.ts";
import { assignDeliveryRider, createDelivery } from "../kilo/client.ts";
import { sanitizeKiloName } from "../kilo/map-order.ts";
import { sendCustomerText } from "../wasender/send-tracked.ts";
import type { CreateKiloDeliveryInput, KiloErrandMode, KiloPackageSize, KiloServiceKind } from "../kilo/types.ts";

export interface PreBooking {
  id: string;
  customerPhone: string;
  customerName: string;
  serviceKind: "pickup_delivery" | "errand" | "trip";
  tripType?: "one_way" | "round_trip";
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
  declinedRiders?: string[]; // Rider names who declined
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
  await writeJson(bookingPath(booking.id), booking);
  const index = await readJson<{ ids: string[] }>(INDEX_PATH);
  const ids = Array.isArray(index?.ids) ? index!.ids : [];
  if (!ids.includes(booking.id)) {
    ids.push(booking.id);
    await writeJson(INDEX_PATH, { ids });
  }
}

/**
 * Ensures an active booking is synced and live on Kilo with rider assigned.
 */
export async function syncBookingToKiloIfMissing(booking: PreBooking): Promise<PreBooking> {
  if (booking.status === "cancelled" || booking.status === "declined") {
    return booking;
  }

  // If kiloDeliveryId is present, verify it on Kilo
  if (booking.kiloDeliveryId) {
    try {
      const { getDelivery } = await import("../kilo/client.ts");
      const kilo = await getDelivery(booking.kiloDeliveryId);
      if (kilo?.id) {
        return booking;
      }
    } catch {
      logWarn("prebooking", "kilo delivery missing or invalid, recreating on Kilo", {
        bookingId: booking.id,
        kiloDeliveryId: booking.kiloDeliveryId,
      });
    }
  }

  // Create on Kilo
  try {
    const { createDelivery, assignDeliveryRider } = await import("../kilo/client.ts");
    const { getCustomTrackingUrl, findRiderByName } = await import("../riders/config.ts");
    const actualRider = findRiderByName(booking.assignedRider);

    const kiloRes = await createDelivery({
      serviceKind: "errand",
      errandMode: "at_place",
      deliveryMode: "pickup",
      senderName: sanitizeKiloName(booking.customerName),
      senderPhone: booking.customerPhone,
      receiverName: sanitizeKiloName(booking.customerName),
      receiverPhone: booking.customerPhone,
      pickupAddress: booking.pickupAddress || "ALCHE gate",
      pickupCoords: booking.pickupCoords || { lat: -20.1024, lng: 57.5621 },
      deliveryAddress: booking.deliveryAddress || "Mahogany",
      deliveryCoords: booking.deliveryCoords || { lat: -20.1026, lng: 57.5620 },
      packageDescription: booking.packageDescription || `${booking.serviceKind.toUpperCase()} booking for ${booking.scheduledTime}`,
      packageSize: booking.packageSize || "small",
      packageImages: booking.packageImages || [],
      customerCollectionMethod: booking.serviceKind === "trip" ? "cash_on_delivery" : "online_checkout",
      idempotencyKey: `kilo_${booking.id}_sync`,
    });

    if (actualRider?.kiloRiderId) {
      try {
        await assignDeliveryRider(kiloRes.delivery.id, actualRider.kiloRiderId);
      } catch (assignErr) {
        logWarn("prebooking", "sync assign rider warning", formatError(assignErr));
      }
    }

    booking.kiloDeliveryId = kiloRes.delivery.id;
    booking.trackingUrl = getCustomTrackingUrl(kiloRes.delivery.id, kiloRes.delivery.access_code);
    booking.updatedAt = new Date().toISOString();
    await savePreBooking(booking);
    logInfo("prebooking", "synced booking to Kilo successfully", {
      bookingId: booking.id,
      kiloDeliveryId: booking.kiloDeliveryId,
    });
  } catch (err) {
    logError("prebooking", "failed to sync booking to Kilo", err);
  }

  return booking;
}

export function parseTimeToMinutes(timeStr: string): number | null {
  if (!timeStr) return null;
  const clean = timeStr.toLowerCase().trim();

  // Match e.g. "6:10 pm", "06:10pm", "6:10", "18:10", "6pm", "6 pm"
  const match = clean.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const meridian = match[3]?.toLowerCase();

  if (meridian === "pm" && hours < 12) {
    hours += 12;
  } else if (meridian === "am" && hours === 12) {
    hours = 0;
  }

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatMinutesToTime(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const meridian = h24 >= 12 ? "pm" : "am";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mStr = m.toString().padStart(2, "0");
  return `${h12}:${mStr} ${meridian}`;
}

export const MIN_BOOKING_GAP_MINUTES = 15;
export const MAX_DELIVERIES_PER_HOUR = 3;
export const MAX_TRIPS_PER_HOUR_DEFAULT = 1;
export const MAX_TRIPS_PER_HOUR_NO_DELIVERIES = 3;
export const MAX_TOTAL_PER_HOUR = 3;

export interface CheckSlotResult {
  available: boolean;
  conflictingBooking?: PreBooking;
  reason?: "gap_violation" | "trip_limit" | "slot_capacity";
  suggestedTime?: string;
}

/**
 * Checks if a rider's hour window has available capacity & enforces the strict 15-minute buffer.
 * Capacity rule per hour:
 * - Up to 3 deliveries and 1 trip per hour.
 * - If there are zero deliveries in that hour, up to 3 passenger trips can be booked.
 * - Maximum total bookings per hour = 3.
 * - Minimum gap between bookings for the same rider = 15 minutes.
 */
export async function checkSlotAvailability(args: {
  slotKey: string;
  assignedRider: string;
  customerPhone?: string;
  serviceKind?: string;
  scheduledTime?: string;
  scheduledDate?: string;
}): Promise<CheckSlotResult> {
  const all = await listAllPreBookings();
  const riderNormalized = args.assignedRider.trim().toLowerCase();

  // Find all active bookings for this rider
  const allRiderActiveBookings = all.filter(
    (b) =>
      b.assignedRider.toLowerCase().includes(riderNormalized) &&
      (b.status === "pending_rider" || b.status === "confirmed" || b.status === "dispatched"),
  );

  const targetMin = args.scheduledTime ? parseTimeToMinutes(args.scheduledTime) : null;
  const targetDate = args.scheduledDate || "";

  // 1. Strict 15-minute gap buffer per rider on the same date/slot
  if (targetMin !== null) {
    for (const b of allRiderActiveBookings) {
      const isSameDay = !targetDate || !b.scheduledDate || b.scheduledDate === targetDate || b.slotKey === args.slotKey;
      if (isSameDay) {
        const existingMin = parseTimeToMinutes(b.scheduledTime);
        if (existingMin !== null) {
          const diff = Math.abs(targetMin - existingMin);
          if (diff < MIN_BOOKING_GAP_MINUTES) {
            const nextAvailableMin = existingMin + MIN_BOOKING_GAP_MINUTES;
            const suggestedTime = formatMinutesToTime(nextAvailableMin);
            return {
              available: false,
              conflictingBooking: b,
              reason: "gap_violation",
              suggestedTime,
            };
          }
        }
      }
    }
  }

  // 2. Hourly Capacity Check (3 deliveries + 1 trip per hour, or up to 3 trips if 0 deliveries)
  if (targetMin !== null) {
    const hourStart = Math.floor(targetMin / 60) * 60;
    const hourEnd = hourStart + 60;

    const bookingsInHour = allRiderActiveBookings.filter((b) => {
      const isSameDay = !targetDate || !b.scheduledDate || b.scheduledDate === targetDate || b.slotKey === args.slotKey;
      if (!isSameDay) return false;
      const bMin = parseTimeToMinutes(b.scheduledTime);
      return bMin !== null && bMin >= hourStart && bMin < hourEnd;
    });

    const deliveriesInHour = bookingsInHour.filter((b) => b.serviceKind !== "trip");
    const tripsInHour = bookingsInHour.filter((b) => b.serviceKind === "trip");
    const isTripRequest = args.serviceKind === "trip";

    // Rule A: Max total bookings per hour is 3
    if (bookingsInHour.length >= MAX_TOTAL_PER_HOUR) {
      return {
        available: false,
        conflictingBooking: bookingsInHour[0],
        reason: "slot_capacity",
      };
    }

    if (isTripRequest) {
      // If there are deliveries booked in this hour, max trips is 1
      if (deliveriesInHour.length > 0 && tripsInHour.length >= MAX_TRIPS_PER_HOUR_DEFAULT) {
        return {
          available: false,
          conflictingBooking: tripsInHour[0] || deliveriesInHour[0],
          reason: "trip_limit",
        };
      }
      // If 0 deliveries in this hour, max trips is up to 3
      if (tripsInHour.length >= MAX_TRIPS_PER_HOUR_NO_DELIVERIES) {
        return {
          available: false,
          conflictingBooking: tripsInHour[0],
          reason: "trip_limit",
        };
      }
    } else {
      // Delivery / Errand request: max deliveries in hour is 3
      if (deliveriesInHour.length >= MAX_DELIVERIES_PER_HOUR) {
        return {
          available: false,
          conflictingBooking: deliveriesInHour[0],
          reason: "slot_capacity",
        };
      }
    }
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

export function resolveIsoDate(dateStr?: string): string {
  if (!dateStr || dateStr.toLowerCase() === "today") {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: "Indian/Mauritius" }).format(new Date());
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }
  if (dateStr.toLowerCase() === "tomorrow") {
    try {
      const now = new Date();
      now.setDate(now.getDate() + 1);
      return new Intl.DateTimeFormat("en-CA", { timeZone: "Indian/Mauritius" }).format(now);
    } catch {
      const now = new Date();
      now.setDate(now.getDate() + 1);
      return now.toISOString().slice(0, 10);
    }
  }
  return dateStr;
}

/**
 * Reschedules an existing active pre-booking for a customer to a new time or date.
 */
export async function reschedulePreBookingRequest(args: {
  customerPhone: string;
  newScheduledDate?: string;
  newScheduledTime: string;
  newSlotKey: string;
  newAssignedRider: string;
}): Promise<{
  ok: boolean;
  booking?: PreBooking;
  doubleBooked?: boolean;
  error?: string;
  trackingUrl?: string;
}> {
  const all = await listAllPreBookings();
  const phoneClean = args.customerPhone.replace(/\D/g, "");

  // Find customer's latest active booking
  const activeBooking = all
    .filter(
      (b) =>
        b.customerPhone.replace(/\D/g, "") === phoneClean &&
        (b.status === "pending_rider" || b.status === "confirmed" || b.status === "dispatched"),
    )
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  if (!activeBooking) {
    return {
      ok: false,
      error: "No active booking found for your phone number to reschedule.",
    };
  }

  // Check availability for the new target time
  const targetDate = resolveIsoDate(args.newScheduledDate || activeBooking.scheduledDate);
  const targetSlotKey = args.newSlotKey || activeBooking.slotKey;
  const rider = args.newAssignedRider || activeBooking.assignedRider;

  // Run capacity check excluding this existing booking
  const check = await checkSlotAvailability({
    slotKey: targetSlotKey,
    assignedRider: rider,
    customerPhone: args.customerPhone,
    serviceKind: activeBooking.serviceKind,
    scheduledTime: args.newScheduledTime,
    scheduledDate: targetDate,
  });

  // If there's a conflict and it is NOT this same booking
  if (!check.available && check.conflictingBooking?.id !== activeBooking.id) {
    let errorMsg = `Rider ${rider} already has a booking around ${args.newScheduledTime}.`;
    if (check.reason === "gap_violation" && check.suggestedTime) {
      errorMsg = `Rider ${rider} already has a booking at ${check.conflictingBooking?.scheduledTime}. Grabbit requires at least a 15-minute gap between bookings. Please offer ${check.suggestedTime} or another open time slot.`;
    }
    return {
      ok: false,
      doubleBooked: true,
      error: errorMsg,
    };
  }

  const oldTime = activeBooking.scheduledTime;
  activeBooking.scheduledTime = args.newScheduledTime;
  activeBooking.scheduledDate = targetDate;
  activeBooking.slotKey = targetSlotKey;
  activeBooking.assignedRider = rider;
  activeBooking.updatedAt = new Date().toISOString();

  await savePreBooking(activeBooking);
  logInfo("prebooking", "booking rescheduled", {
    bookingId: activeBooking.id,
    oldTime,
    newTime: args.newScheduledTime,
    rider,
  });

  // Dispatch reschedule notification to the rider
  try {
    await notifyRiderOfReschedule({
      bookingId: activeBooking.id,
      customerName: activeBooking.customerName,
      customerPhone: activeBooking.customerPhone,
      serviceKind: activeBooking.serviceKind,
      pickupAddress: activeBooking.pickupAddress,
      dropoffAddress: activeBooking.deliveryAddress,
      oldScheduledTime: oldTime,
      newScheduledTime: args.newScheduledTime,
      assignedRider: rider,
      trackingUrl: activeBooking.trackingUrl,
      kiloDeliveryId: activeBooking.kiloDeliveryId,
    });
  } catch (err) {
    logWarn("prebooking", "failed to notify rider of reschedule", formatError(err));
  }

  return {
    ok: true,
    booking: activeBooking,
    trackingUrl: activeBooking.trackingUrl,
  };
}

/**
 * Creates a pre-booking request, checks for capacity, and notifies the rider.
 */
export async function createPreBookingRequest(args: {
  customerPhone: string;
  customerName: string;
  serviceKind: "pickup_delivery" | "errand" | "trip";
  tripType?: "one_way" | "round_trip";
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
  assignedRider?: string;
  kiloDeliveryId?: string;
  trackingUrl?: string;
}> {
  const targetIsoDate = resolveIsoDate(args.scheduledDate);

  // 1. Anti-Double-Booking & 15-Minute Gap Check
  const availability = await checkSlotAvailability({
    slotKey: args.slotKey,
    assignedRider: args.assignedRider,
    customerPhone: args.customerPhone,
    serviceKind: args.serviceKind,
    scheduledTime: args.scheduledTime,
    scheduledDate: targetIsoDate,
  });

  if (!availability.available) {
    let errorMsg = `Rider ${args.assignedRider} is not available for ${args.scheduledTime}.`;
    if (availability.reason === "gap_violation" && availability.conflictingBooking) {
      errorMsg = `Rider ${args.assignedRider} already has a booking at ${availability.conflictingBooking.scheduledTime}. Grabbit requires at least a 15-minute gap between bookings. Please offer ${availability.suggestedTime} or another open time slot.`;
    } else if (availability.reason === "trip_limit") {
      errorMsg = `Rider ${args.assignedRider} already has a passenger trip in this slot. Only 1 trip per slot is permitted. Please choose another time slot.`;
    } else if (availability.reason === "slot_capacity") {
      errorMsg = `Rider ${args.assignedRider} has reached maximum delivery capacity (3) for this slot. Please choose another time slot.`;
    }

    logWarn("prebooking", "slot booking rejected", {
      slotKey: args.slotKey,
      assignedRider: args.assignedRider,
      reason: availability.reason,
      errorMsg,
    });

    return {
      ok: false,
      doubleBooked: true,
      error: errorMsg,
    };
  }

  const bookingId = `pb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const actualRider = findRiderByName(args.assignedRider) || FLEET_RIDERS[0];
  const hasPhotos = Boolean(args.packageImages && args.packageImages.length > 0);
  const isTripOrErrand = args.serviceKind === "trip" || args.serviceKind === "errand" || !hasPhotos;
  const kiloServiceKind: KiloServiceKind = isTripOrErrand ? "errand" : (args.serviceKind as any);
  const kiloErrandMode: KiloErrandMode | undefined = kiloServiceKind === "errand" ? "at_place" : undefined;

  let kiloDeliveryId: string | undefined;
  let trackingUrl: string | undefined;

  try {
    const kiloPayload: CreateKiloDeliveryInput = {
      serviceKind: kiloServiceKind,
      errandMode: kiloErrandMode,
      deliveryMode: "pickup",
      senderName: sanitizeKiloName(args.customerName),
      senderPhone: args.customerPhone,
      receiverName: sanitizeKiloName(args.customerName),
      receiverPhone: args.customerPhone,
      pickupAddress: args.pickupAddress,
      pickupCoords: args.pickupCoords || { lat: -20.1024, lng: 57.5621 },
      deliveryAddress: args.deliveryAddress,
      deliveryCoords: args.deliveryCoords || { lat: -20.1026, lng: 57.5620 },
      packageDescription: args.packageDescription || `${args.serviceKind.toUpperCase()} booking for ${args.scheduledTime}`,
      packageSize: args.packageSize || "small",
      packageImages: hasPhotos ? args.packageImages! : [],
      customerCollectionMethod: args.serviceKind === "trip" ? "cash_on_delivery" : "online_checkout",
      idempotencyKey: `kilo_${bookingId}`,
    };

    const kiloRes = await createDelivery(kiloPayload);
    const delivery = kiloRes.delivery;
    kiloDeliveryId = delivery.id;
    trackingUrl = getCustomTrackingUrl(delivery.id, delivery.access_code);

    if (actualRider?.kiloRiderId) {
      try {
        await assignDeliveryRider(delivery.id, actualRider.kiloRiderId);
        logInfo("prebooking", "auto-assigned rider in Kilo", {
          deliveryId: delivery.id,
          riderId: actualRider.kiloRiderId,
        });
      } catch (assignErr) {
        logWarn("prebooking", "kilo assign warning", formatError(assignErr));
      }
    }
  } catch (kiloErr) {
    logError("prebooking", "failed to create Kilo delivery", kiloErr);
  }

  const booking: PreBooking = {
    id: bookingId,
    customerPhone: args.customerPhone,
    customerName: args.customerName,
    serviceKind: args.serviceKind,
    tripType: args.tripType,
    pickupAddress: args.pickupAddress,
    deliveryAddress: args.deliveryAddress,
    packageDescription: args.packageDescription,
    packageSize: args.packageSize || "small",
    packageImages: args.packageImages || [],
    pickupCoords: args.pickupCoords,
    deliveryCoords: args.deliveryCoords,
    scheduledDate: targetIsoDate,
    scheduledTime: args.scheduledTime,
    slotKey: args.slotKey,
    assignedRider: actualRider.name,
    declinedRiders: [],
    status: "confirmed",
    kiloDeliveryId,
    trackingUrl,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await savePreBooking(booking);

  logInfo("prebooking", "created & confirmed pre-booking record", {
    bookingId,
    customer: args.customerPhone,
    slotKey: args.slotKey,
    assignedRider: actualRider.name,
    tripType: args.tripType,
    kiloDeliveryId,
    trackingUrl,
  });

  // 2. Dispatch notification to assigned rider (queued after customer confirmation)
  setTimeout(async () => {
    try {
      await notifyRiderForBooking({
        bookingId,
        customerName: args.customerName,
        customerPhone: args.customerPhone,
        serviceKind: args.serviceKind,
        pickupAddress: args.pickupAddress,
        dropoffAddress: args.deliveryAddress,
        scheduledTime: `${args.scheduledDate} ${args.scheduledTime}`,
        assignedRider: actualRider.name,
        trackingUrl,
      });
    } catch (notifErr) {
      logWarn("prebooking", "rider notification warning", formatError(notifErr));
    }
  }, 1000);

  return { ok: true, booking, trackingUrl, kiloDeliveryId, assignedRider: actualRider.name };
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
    return { handled: false };
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
        (b.status === "pending_rider" || b.status === "confirmed") &&
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
    const declined = pending.declinedRiders || [];
    if (!declined.includes(actualRider.name)) {
      declined.push(actualRider.name);
    }
    pending.declinedRiders = declined;

    logInfo("prebooking", "rider declined booking, attempting cascade", {
      bookingId: pending.id,
      declinedRider: actualRider.name,
    });

    // Attempt cascade: find another rider in fleet who has not yet declined
    const nextRider = FLEET_RIDERS.find(
      (r) => !declined.some((d) => d.toLowerCase() === r.name.toLowerCase()),
    );

    if (nextRider) {
      pending.assignedRider = nextRider.name;
      pending.updatedAt = new Date().toISOString();
      await savePreBooking(pending);

      logInfo("prebooking", "cascading booking to next rider", {
        bookingId: pending.id,
        nextRider: nextRider.name,
      });

      await notifyRiderForBooking({
        bookingId: pending.id,
        customerName: pending.customerName,
        customerPhone: pending.customerPhone,
        serviceKind: pending.serviceKind,
        pickupAddress: pending.pickupAddress,
        dropoffAddress: pending.deliveryAddress,
        scheduledTime: `${pending.scheduledDate} ${pending.scheduledTime}`,
        assignedRider: nextRider.name,
      });

      return {
        handled: true,
        responseMessage: `Understood, ${actualRider.name}. Reassigning request to ${nextRider.name}.`,
      };
    }

    // No other riders available
    pending.status = "declined";
    pending.updatedAt = new Date().toISOString();
    await savePreBooking(pending);

    // Notify customer
    try {
      await sendCustomerText({
        to: pending.customerPhone,
        text: `Hello ${pending.customerName || "there"}, our riders are currently unavailable for your requested time (${pending.scheduledTime}). Would you like to select another time slot?`,
        messageId: `decline_${pending.id}_${Date.now()}`,
      });
    } catch (custErr) {
      logWarn("prebooking", "error notifying customer of decline", formatError(custErr));
    }

    return {
      handled: true,
      responseMessage: `Understood, ${actualRider.name}. No other riders available; customer has been notified.`,
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
    pending.updatedAt = new Date().toISOString();
    await savePreBooking(pending);

    // Send tracking link to customer with trip type specifics!
    const isRoundTrip = pending.serviceKind === "trip" && pending.tripType === "round_trip";
    const customerLines = [
      `✅ *Your ${pending.serviceKind === "trip" ? (isRoundTrip ? "Round Trip" : "Trip") : pending.serviceKind} is confirmed!*`,
      `Rider *${actualRider.name}* has accepted and is scheduled for *${pending.scheduledTime}*.`,
      ``,
      `📍 Pickup: ${pending.pickupAddress}`,
      `📍 Drop-off: ${pending.deliveryAddress}`,
    ];

    if (isRoundTrip) {
      customerLines.push(
        ``,
        `⏱️ *Waiting Policy:*`,
        `Your round trip includes 15 minutes of free waiting time after drop-off at your destination before the return leg.`,
      );
    }

    customerLines.push(
      ``,
      `🔴 *Live Tracking Link:*`,
      trackingUrl,
      ``,
      `Thank you for choosing Grabbit Express! 🛵⚡`,
    );

    const customerMsg = customerLines.join("\n");

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

export async function getRiderAssignedBookings(args: {
  callerPhone: string;
  targetDate?: string;
  targetRiderName?: string;
}): Promise<{
  ok: boolean;
  authorized: boolean;
  riderName?: string;
  date?: string;
  bookings?: Array<{
    id: string;
    scheduledTime: string;
    scheduledDate: string;
    serviceKind: string;
    customerName: string;
    customerPhone: string;
    pickupAddress: string;
    deliveryAddress: string;
    assignedRider: string;
    status: string;
    trackingUrl?: string;
  }>;
  error?: string;
}> {
  const auth = isAuthorizedRiderOrAdmin(args.callerPhone);
  if (!auth.isAuthorized) {
    return {
      ok: false,
      authorized: false,
      error: "Access Denied: You do not have permission to view rider schedules.",
    };
  }

  const all = await listAllPreBookings();
  const targetRider = auth.isAdmin
    ? args.targetRiderName?.trim() || null
    : auth.rider?.name;

  // Filter active bookings
  const activeBookings = all.filter((b) => {
    if (b.status === "cancelled" || b.status === "declined") return false;
    if (targetRider && !b.assignedRider.toLowerCase().includes(targetRider.toLowerCase())) {
      return false;
    }
    if (args.targetDate && args.targetDate.toLowerCase() !== "all") {
      const targetIso = resolveIsoDate(args.targetDate);
      return (
        b.scheduledDate === targetIso ||
        b.slotKey.startsWith(targetIso) ||
        b.scheduledDate.toLowerCase().includes(args.targetDate.toLowerCase()) ||
        b.slotKey.includes(args.targetDate)
      );
    }
    return true;
  });

  return {
    ok: true,
    authorized: true,
    riderName: targetRider || "All Fleet Riders",
    date: args.targetDate || "today",
    bookings: activeBookings.map((b) => ({
      id: b.id,
      scheduledTime: b.scheduledTime,
      scheduledDate: b.scheduledDate,
      serviceKind: b.serviceKind,
      customerName: b.customerName,
      customerPhone: b.customerPhone,
      pickupAddress: b.pickupAddress,
      deliveryAddress: b.deliveryAddress,
      assignedRider: b.assignedRider,
      status: b.status,
      trackingUrl: b.trackingUrl,
    })),
  };
}

import {
  commitIndex,
  getIndex,
  querySummaries,
  readBookingFile,
  upsertSingleSummary,
  withBookingLock,
  writeBookingFile,
  type BookingSummary,
} from "./booking-store.ts";
import { formatError, logError, logInfo, logWarn } from "../log.ts";
import { mauritiusDateIso, resolveRelativeDateWord } from "../time.ts";
import { FLEET_RIDERS, findRiderByName, findRiderByPhone, getCustomTrackingUrl, isAuthorizedRiderOrAdmin, type RiderProfile } from "../riders/config.ts";
import { notifyRiderForBooking, notifyRiderOfReschedule } from "../riders/notify-rider.ts";
import { assignDeliveryRider, createDelivery, getDelivery } from "../kilo/client.ts";
import { mapKiloEventToPreBookingStatus, resolveDefaultCollectionMethod, sanitizeKiloName } from "../kilo/map-order.ts";
import { sendCustomerText } from "../wasender/send-tracked.ts";
import type { CreateKiloDeliveryInput, KiloErrandMode, KiloPackageSize, KiloServiceKind } from "../kilo/types.ts";

export const ACTIVE_BOOKING_STATUSES = ["pending_rider", "confirmed", "dispatched"] as const;

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
  status: "pending_rider" | "confirmed" | "dispatched" | "declined" | "cancelled" | "completed";
  kiloDeliveryId?: string;
  trackingUrl?: string;
  paymentStatus?: "unpaid" | "paid";
  paymentMethod?: string;
  reminderSent?: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function listAllPreBookings(): Promise<PreBooking[]> {
  const { summaries } = await getIndex();
  const bookings: PreBooking[] = [];
  for (const summary of summaries) {
    const record = await readBookingFile<PreBooking>(summary.id);
    if (record) bookings.push(record);
  }
  return bookings;
}

export async function savePreBooking(booking: PreBooking): Promise<void> {
  booking.updatedAt = new Date().toISOString();
  await writeBookingFile(booking);
  await upsertSingleSummary(toSummary(booking));
}

function toSummary(b: PreBooking): BookingSummary {
  return {
    id: b.id,
    status: b.status,
    assignedRider: b.assignedRider,
    scheduledDate: b.scheduledDate,
    scheduledTime: b.scheduledTime,
    slotKey: b.slotKey,
    customerPhone: b.customerPhone,
    customerName: b.customerName,
    serviceKind: b.serviceKind,
    tripType: b.tripType,
    pickupAddress: b.pickupAddress,
    deliveryAddress: b.deliveryAddress,
    kiloDeliveryId: b.kiloDeliveryId,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

export async function riderHasActiveBooking(riderName: string): Promise<boolean> {
  const riderLower = riderName.trim().toLowerCase();
  return (
    await querySummaries(
      (s) =>
        s.assignedRider.toLowerCase().includes(riderLower) &&
        isActiveStatus(s.status),
    )
  ).length > 0;
}

export async function findLatestActiveBookingForRider(riderName: string): Promise<PreBooking | null> {
  const riderLower = riderName.trim().toLowerCase();
  const matches = await querySummaries(
    (s) =>
      s.assignedRider.toLowerCase().includes(riderLower) &&
      isActiveStatus(s.status),
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return readBookingFile<PreBooking>(matches[0].id);
}

export async function listActiveBookingsOnDate(dateIso: string): Promise<PreBooking[]> {
  const summaries = await querySummaries((s) => isActiveStatus(s.status));
  const matching = summaries.filter(
    (s) => s.scheduledDate === dateIso || (s.slotKey ?? "").startsWith(dateIso),
  );
  const records: PreBooking[] = [];
  for (const s of matching) {
    const record = await readBookingFile<PreBooking>(s.id);
    if (record) records.push(record);
  }
  return records;
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
      customerCollectionMethod: resolveDefaultCollectionMethod(booking.serviceKind),
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

export const MIN_BOOKING_GAP_MINUTES_ONE_WAY = 15;
export const MIN_BOOKING_GAP_MINUTES_ROUND_TRIP = 30;
export const MIN_BOOKING_GAP_MINUTES = 15;
export const MAX_DELIVERIES_PER_HOUR = 3;
export const MAX_TRIPS_PER_HOUR_DEFAULT = 1;
export const MAX_TRIPS_PER_HOUR_NO_DELIVERIES = 3;
export const MAX_TOTAL_PER_HOUR = 3;

export interface CheckSlotResult {
  available: boolean;
  conflictingBooking?: PreBooking | BookingSummary | SlotCandidate;
  reason?: "gap_violation" | "trip_limit" | "slot_capacity";
  suggestedTime?: string;
}

export function evaluateSlotRules(
  riderActiveCandidates: SlotCandidate[],
  args: {
    slotKey: string;
    assignedRider: string;
    customerPhone?: string;
    serviceKind?: string;
    tripType?: "one_way" | "round_trip";
    pickupAddress?: string;
    deliveryAddress?: string;
    scheduledTime?: string;
    scheduledDate?: string;
  },
): CheckSlotResult {
  const targetMin = args.scheduledTime ? parseTimeToMinutes(args.scheduledTime) : null;
  const targetDate = args.scheduledDate || "";

  // 1. Strict gap buffer per rider on the same date/slot (30 mins if round-trip, 15 mins for one-way)
  if (targetMin !== null) {
    const isNewRoundTrip = args.tripType === "round_trip";
    for (const b of riderActiveCandidates) {
      const isSameDay = !targetDate || !b.scheduledDate || b.scheduledDate === targetDate || b.slotKey === args.slotKey;
      if (isSameDay) {
        const existingMin = parseTimeToMinutes(b.scheduledTime);
        if (existingMin !== null) {
          const isExistingRoundTrip = b.tripType === "round_trip";
          const requiredGap = isNewRoundTrip || isExistingRoundTrip
            ? MIN_BOOKING_GAP_MINUTES_ROUND_TRIP
            : MIN_BOOKING_GAP_MINUTES_ONE_WAY;

          const diff = Math.abs(targetMin - existingMin);
          if (diff < requiredGap) {
            const canBatch = isCompatibleRouteBatch(b, args);
            if (!canBatch) {
              const nextAvailableMin = existingMin + (isExistingRoundTrip ? MIN_BOOKING_GAP_MINUTES_ROUND_TRIP : (isNewRoundTrip ? MIN_BOOKING_GAP_MINUTES_ROUND_TRIP : MIN_BOOKING_GAP_MINUTES_ONE_WAY));
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
  }

  // 2. Hourly Capacity Check (3 deliveries + 1 trip per hour, or up to 3 trips if 0 deliveries)
  if (targetMin !== null) {
    const hourStart = Math.floor(targetMin / 60) * 60;
    const hourEnd = hourStart + 60;

    const bookingsInHour = riderActiveCandidates.filter((b) => {
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
        suggestedTime: formatMinutesToTime(hourEnd),
      };
    }

    if (isTripRequest) {
      // If there are deliveries booked in this hour, max trips is 1
      if (deliveriesInHour.length > 0 && tripsInHour.length >= MAX_TRIPS_PER_HOUR_DEFAULT) {
        return {
          available: false,
          conflictingBooking: tripsInHour[0] || deliveriesInHour[0],
          reason: "trip_limit",
          suggestedTime: formatMinutesToTime(hourEnd),
        };
      }
      // If 0 deliveries in this hour, max trips is up to 3
      if (tripsInHour.length >= MAX_TRIPS_PER_HOUR_NO_DELIVERIES) {
        return {
          available: false,
          conflictingBooking: tripsInHour[0],
          reason: "trip_limit",
          suggestedTime: formatMinutesToTime(hourEnd),
        };
      }
    } else {
      // Delivery / Errand request: max deliveries in hour is 3
      if (deliveriesInHour.length >= MAX_DELIVERIES_PER_HOUR) {
        return {
          available: false,
          conflictingBooking: deliveriesInHour[0],
          reason: "slot_capacity",
          suggestedTime: formatMinutesToTime(hourEnd),
        };
      }
    }
  }

  return { available: true };
}

/**
 * Checks if a rider's hour window has available capacity & enforces trip buffers.
 * Capacity rule per hour:
 * - Up to 3 deliveries and 1 trip per hour.
 * - If there are zero deliveries in that hour, up to 3 passenger trips can be booked.
 * - Maximum total bookings per hour = 3.
 * - Minimum gap between bookings for the same rider = 15 minutes (one-way / deliveries), 30 minutes (round-trips),
 *   unless bookings are along the same route corridor (Smart Route Batching).
 */
export async function checkSlotAvailability(args: {
  slotKey: string;
  assignedRider: string;
  customerPhone?: string;
  serviceKind?: string;
  tripType?: "one_way" | "round_trip";
  pickupAddress?: string;
  deliveryAddress?: string;
  scheduledTime?: string;
  scheduledDate?: string;
}): Promise<CheckSlotResult> {
  const riderNormalized = args.assignedRider.trim().toLowerCase();
  const candidates = await querySummaries(
    (s) =>
      s.assignedRider.toLowerCase().includes(riderNormalized) &&
      isActiveStatus(s.status),
  );

  return evaluateSlotRules(candidates, args);
}

export interface SlotCandidate {
  id: string;
  status: string;
  assignedRider: string;
  scheduledDate: string;
  scheduledTime: string;
  slotKey?: string;
  serviceKind: string;
  tripType?: string;
  pickupAddress?: string;
  deliveryAddress?: string;
}

export function isActiveStatus(status: string): boolean {
  return (ACTIVE_BOOKING_STATUSES as readonly string[]).includes(status);
}

export function isCompatibleRouteBatch(
  b1: { serviceKind?: string; tripType?: string; pickupAddress?: string; deliveryAddress?: string },
  b2: { serviceKind?: string; tripType?: string; pickupAddress?: string; deliveryAddress?: string },
): boolean {
  // Round trips can NEVER be batched due to waiting time and round-trip passenger exclusivity
  if (b1.tripType === "round_trip" || b2.tripType === "round_trip") {
    return false;
  }

  const p1 = (b1.pickupAddress || "").toLowerCase();
  const d1 = (b1.deliveryAddress || "").toLowerCase();
  const p2 = (b2.pickupAddress || "").toLowerCase();
  const d2 = (b2.deliveryAddress || "").toLowerCase();

  // If both are package/food deliveries/errands, batch if pickup or dropoff zones match
  const bothDeliveries = b1.serviceKind !== "trip" && b2.serviceKind !== "trip";
  if (bothDeliveries) {
    const samePickup = (p1.includes("alche") && p2.includes("alche")) || (p1.includes("mahogany") && p2.includes("mahogany"));
    const sameDrop = (d1.includes("alche") && d2.includes("alche")) || (d1.includes("mahogany") && d2.includes("mahogany"));
    return Boolean(samePickup || sameDrop);
  }

  // If one is a one-way passenger trip and one is a delivery in the exact same corridor
  const isAlcheToMahogany1 = p1.includes("alche") && (d1.includes("mahogany") || d1.includes("grand baie"));
  const isAlcheToMahogany2 = p2.includes("alche") && (d2.includes("mahogany") || d2.includes("grand baie"));
  if (isAlcheToMahogany1 && isAlcheToMahogany2) return true;

  const isMahoganyToAlche1 = p1.includes("mahogany") && d1.includes("alche");
  const isMahoganyToAlche2 = p2.includes("mahogany") && d2.includes("alche");
  if (isMahoganyToAlche1 && isMahoganyToAlche2) return true;

  return false;
}

/**
 * Checks if a rider's hour window has available capacity & enforces trip buffers.
 * Capacity rule per hour:
 * - Up to 3 deliveries and 1 trip per hour.
 * - If there are zero deliveries in that hour, up to 3 passenger trips can be booked.
 * - Maximum total bookings per hour = 3.
 * - Minimum gap between bookings for the same rider = 15 minutes (one-way / deliveries), 30 minutes (round-trips),
 *   unless bookings are along the same route corridor (Smart Route Batching).
 */
export async function cancelPreBooking(id: string): Promise<boolean> {
  const found = await readBookingFile<PreBooking>(id);
  if (!found) return false;
  found.status = "cancelled";
  await savePreBooking(found);
  return true;
}

const STATUS_RANK: Record<PreBooking["status"], number> = {
  pending_rider: 0,
  confirmed: 1,
  dispatched: 2,
  completed: 3,
  cancelled: 3,
  declined: 3,
};

export async function applyKiloDeliveryStatus(
  kiloDeliveryId: string,
  kiloStatus?: string | null,
): Promise<PreBooking | null> {
  if (!kiloDeliveryId) return null;
  const target = mapKiloEventToPreBookingStatus(kiloStatus);
  if (!target) return null;

  const summary = (
    await querySummaries((s) => s.kiloDeliveryId === kiloDeliveryId, { bypassCache: true })
  )[0];
  if (!summary) return null;

  const booking = await readBookingFile<PreBooking>(summary.id);
  if (!booking || booking.kiloDeliveryId !== kiloDeliveryId) return null;
  if (booking.status === "cancelled" || booking.status === "declined") return null;

  if (target === "cancelled") {
    if (booking.status === "completed") return null;
  } else if (STATUS_RANK[target] <= STATUS_RANK[booking.status]) {
    return null;
  }

  booking.status = target;
  await savePreBooking(booking);
  if (target === "completed") {
    const { recordMetric } = await import("../metrics/recorder.ts");
    void recordMetric("booking_completed_kilo");
  }
  logInfo("prebooking", "synced Kilo delivery status into pre-booking", {
    bookingId: booking.id,
    kiloDeliveryId,
    status: target,
  });
  return booking;
}

export async function clearAllPreBookings(): Promise<void> {
  await commitIndex([], (await getIndex()).revision);
}

export function resolveIsoDate(dateStr?: string): string {
  if (!dateStr) return mauritiusDateIso();
  const relative = resolveRelativeDateWord(dateStr);
  if (relative) return relative;
  return dateStr;
}

/**
 * Reschedules an existing active pre-booking for a customer to a new time or date.
 */
function toKiloServiceKind(value?: string): KiloServiceKind {
  return value === "pickup_delivery" ? "pickup_delivery" : "errand";
}

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
  const phoneClean = args.customerPhone.replace(/\D/g, "");

  const activeSummaries = (
    await querySummaries((s) => isActiveStatus(s.status) && s.customerPhone.replace(/\D/g, "") === phoneClean)
  ).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  let activeBooking: PreBooking | null = null;
  for (const s of activeSummaries) {
    const record = await readBookingFile<PreBooking>(s.id);
    if (record) {
      activeBooking = record;
      break;
    }
  }

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

  // 0. Idempotency Check: prevent duplicate bookings for same customer within 2 minutes
  const activeStatuses = ACTIVE_BOOKING_STATUSES;
  const recentDuplicateSummary = (
    await querySummaries(
      (s) =>
        s.customerPhone === args.customerPhone &&
        s.status !== "cancelled" &&
        s.status !== "declined" &&
        s.scheduledDate === targetIsoDate &&
        Date.now() - Date.parse(s.createdAt) < 120_000 &&
        activeStatuses.includes(s.status as (typeof activeStatuses)[number]),
    )
  )[0];

  if (recentDuplicateSummary) {
    const recentDuplicate = await readBookingFile<PreBooking>(recentDuplicateSummary.id);
    if (recentDuplicate) {
      logInfo("prebooking", "prevented duplicate booking via recent idempotency lock", {
        customerPhone: args.customerPhone,
        existingBookingId: recentDuplicate.id,
        scheduledTime: recentDuplicate.scheduledTime,
      });
      return {
        ok: true,
        booking: recentDuplicate,
        trackingUrl: recentDuplicate.trackingUrl,
        kiloDeliveryId: recentDuplicate.kiloDeliveryId,
        assignedRider: recentDuplicate.assignedRider,
      };
    }
  }

  // 1. Anti-Double-Booking & Gap Check
  const availability = await checkSlotAvailability({
    slotKey: args.slotKey,
    assignedRider: args.assignedRider,
    customerPhone: args.customerPhone,
    serviceKind: args.serviceKind,
    tripType: args.tripType,
    scheduledTime: args.scheduledTime,
    scheduledDate: targetIsoDate,
  });

  if (!availability.available) {
    let errorMsg = `Rider ${args.assignedRider} is not available for ${args.scheduledTime}.`;
    if (availability.reason === "gap_violation" && availability.conflictingBooking) {
      const requiredGap = (args.tripType === "round_trip" || availability.conflictingBooking.tripType === "round_trip") ? "30-minute" : "15-minute";
      errorMsg = `Rider ${args.assignedRider} already has a booking at ${availability.conflictingBooking.scheduledTime}. Grabbit requires at least a ${requiredGap} gap for this booking. Please offer ${availability.suggestedTime} or another open time slot.`;
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
  const kiloServiceKind: KiloServiceKind = isTripOrErrand ? "errand" : toKiloServiceKind(args.serviceKind);
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
      customerCollectionMethod: resolveDefaultCollectionMethod(args.serviceKind),
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

  let persistRejected: string | null = null;
  const persisted = await withBookingLock("index", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { revision, summaries } = await getIndex({ bypassCache: attempt > 0 });
      const riderNormalized = booking.assignedRider.trim().toLowerCase();
      const riderCandidates = summaries.filter(
        (s) =>
          s.id !== booking.id &&
          s.assignedRider.toLowerCase().includes(riderNormalized) &&
          isActiveStatus(s.status),
      );
      const recheck = evaluateSlotRules(riderCandidates, {
        slotKey: booking.slotKey,
        assignedRider: booking.assignedRider,
        serviceKind: booking.serviceKind,
        tripType: booking.tripType,
        pickupAddress: booking.pickupAddress,
        deliveryAddress: booking.deliveryAddress,
        scheduledTime: booking.scheduledTime,
        scheduledDate: booking.scheduledDate,
      });

      if (!recheck.available) {
        if (recheck.reason === "gap_violation" && recheck.conflictingBooking) {
          const requiredGap = (booking.tripType === "round_trip" || recheck.conflictingBooking.tripType === "round_trip") ? "30-minute" : "15-minute";
          persistRejected = `Rider ${booking.assignedRider} already has a booking at ${recheck.conflictingBooking.scheduledTime}. Grabbit requires at least a ${requiredGap} gap for this booking.`;
        } else if (recheck.reason === "trip_limit") {
          persistRejected = `Rider ${booking.assignedRider} already has a passenger trip in this slot. Only 1 trip per slot is permitted.`;
        } else {
          persistRejected = `Rider ${booking.assignedRider} just reached maximum capacity for this slot.`;
        }
        return false;
      }

      await writeBookingFile(booking);
      if (await commitIndex([...summaries, toSummary(booking)], revision)) {
        return true;
      }
    }
    return false;
  });

  if (!persisted) {
    logWarn("prebooking", "persist rejected by concurrent-write guard", {
      customerPhone: args.customerPhone,
      slotKey: args.slotKey,
      reason: persistRejected ?? "revision_conflict",
    });
    return {
      ok: false,
      doubleBooked: true,
      error: persistRejected ?? "That slot was just booked by another request. Please pick another time slot.",
    };
  }
  try {
    const { clearOrderDraft, updateCustomerProfile } = await import("./store.ts");
    await clearOrderDraft(args.customerPhone);
    await updateCustomerProfile(args.customerPhone, {
      name: args.customerName,
      lastPickupAddress: args.pickupAddress,
      lastDeliveryAddress: args.deliveryAddress,
      preferredPaymentMethod: args.serviceKind === "trip" ? "cash" : "juice",
      tripCount: 1,
      lastBookingAt: new Date().toISOString(),
    });
  } catch (draftErr) {
    logWarn("prebooking", "draft reset or profile update failed after booking", formatError(draftErr));
  }

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
export type RiderReplyDecision = "accept" | "decline";

export function classifyRiderAcceptDecline(text: string): RiderReplyDecision | null {
  const cleanText = text.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "");
  if (!cleanText) return null;

  if (["yes", "y", "ok", "okay", "confirm", "confirmed", "accept", "accepted"].includes(cleanText)) {
    return "accept";
  }
  if (["no", "n", "decline", "declined", "reject", "rejected"].includes(cleanText)) {
    return "decline";
  }
  return null;
}

const APPROVAL_INTENT_KEYWORDS = [
  "google",
  "chat",
  "post",
  "report",
  "summary",
  "rundown",
  "broadcast",
  "customers",
];

export function shouldInterceptRiderDecision(args: {
  text: string;
  hasActiveBooking: boolean;
}): boolean {
  if (!args.hasActiveBooking) return false;
  if (!classifyRiderAcceptDecline(args.text)) return false;
  const haystack = args.text.toLowerCase();
  if (APPROVAL_INTENT_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
    return false;
  }
  return true;
}

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

  const pendingSummaries = (
    await querySummaries(
      (s) =>
        (s.status === "pending_rider" || s.status === "confirmed") &&
        (isTestMode || s.assignedRider.toLowerCase().includes(rider.name.toLowerCase())),
    )
  ).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  let pendingRecord: PreBooking | null = null;
  for (const s of pendingSummaries) {
    const record = await readBookingFile<PreBooking>(s.id);
    if (record) {
      pendingRecord = record;
      break;
    }
  }

  const pending = pendingRecord;

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

  // Rider accepted: ensure the run is live on Kilo Fleet & send tracking link!
  logInfo("prebooking", "rider accepted booking", {
    bookingId: pending.id,
    rider: actualRider.name,
    existingKiloDeliveryId: pending.kiloDeliveryId || "none",
  });

  try {
    let deliveryId = pending.kiloDeliveryId;
    let trackingUrl = pending.trackingUrl;

    if (deliveryId) {
      if (actualRider.kiloRiderId) {
        try {
          await assignDeliveryRider(deliveryId, actualRider.kiloRiderId);
          logInfo("prebooking", "re-assigned rider on existing Kilo delivery", {
            deliveryId,
            riderId: actualRider.kiloRiderId,
          });
        } catch (assignErr) {
          logWarn("prebooking", "kilo re-assign warning", formatError(assignErr));
        }
      }
      if (!trackingUrl) {
        const existing = await getDelivery(deliveryId);
        trackingUrl = getCustomTrackingUrl(existing.id, existing.access_code);
      }
    } else {
      const hasPhotos = Boolean(pending.packageImages && pending.packageImages.length > 0);
      // For food orders, errands, or passenger trips without package photos, use errand with at_place mode
      const isTripOrErrand = pending.serviceKind === "trip" || pending.serviceKind === "errand" || !hasPhotos;
      const serviceKind: KiloServiceKind = isTripOrErrand ? "errand" : toKiloServiceKind(pending.serviceKind);
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
        customerCollectionMethod: resolveDefaultCollectionMethod(pending.serviceKind),
        idempotencyKey: `kilo_${pending.id}`,
      };

      const kiloRes = await createDelivery(kiloPayload);
      deliveryId = kiloRes.delivery.id;
      trackingUrl = getCustomTrackingUrl(kiloRes.delivery.id, kiloRes.delivery.access_code);

      if (actualRider.kiloRiderId) {
        try {
          await assignDeliveryRider(deliveryId, actualRider.kiloRiderId);
          logInfo("prebooking", "assigned rider in Kilo", {
            deliveryId,
            riderId: actualRider.kiloRiderId,
          });
        } catch (assignErr) {
          logWarn("prebooking", "kilo assign warning", formatError(assignErr));
        }
      }
    }

    pending.status = "confirmed";
    pending.kiloDeliveryId = deliveryId;
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

  const targetRider = auth.isAdmin
    ? args.targetRiderName?.trim() || null
    : auth.rider?.name;

  // Filter active bookings
  const candidateSummaries = await querySummaries((s) => s.status !== "cancelled" && s.status !== "declined");
  const activeBookings: PreBooking[] = [];
  for (const s of candidateSummaries) {
    if (targetRider && !s.assignedRider.toLowerCase().includes(targetRider.toLowerCase())) {
      continue;
    }
    if (args.targetDate && args.targetDate.toLowerCase() !== "all") {
      const targetIso = resolveIsoDate(args.targetDate);
      const matchesDate =
        s.scheduledDate === targetIso ||
        (s.slotKey ?? "").startsWith(targetIso) ||
        s.scheduledDate.toLowerCase().includes(args.targetDate.toLowerCase()) ||
        (s.slotKey ?? "").includes(args.targetDate);
      if (!matchesDate) continue;
    }
    const record = await readBookingFile<PreBooking>(s.id);
    if (record) activeBookings.push(record);
  }

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

export async function updatePreBookingDetails(args: {
  bookingId: string;
  customerName?: string;
  pickupAddress?: string;
  deliveryAddress?: string;
  scheduledTime?: string;
  scheduledDate?: string;
  assignedRider?: string;
  packageDescription?: string;
}): Promise<{ ok: boolean; booking?: PreBooking; error?: string }> {
  const all = await listAllPreBookings();
  const idQuery = args.bookingId.trim().toLowerCase();

  const target = all.find(
    (b) =>
      b.id.toLowerCase() === idQuery ||
      (b.kiloDeliveryId && b.kiloDeliveryId.toLowerCase() === idQuery) ||
      b.customerPhone.replace(/\D/g, "") === idQuery.replace(/\D/g, "")
  );

  if (!target) {
    return { ok: false, error: `No booking found matching "${args.bookingId}".` };
  }

  if (args.customerName) target.customerName = args.customerName.trim();
  if (args.pickupAddress) target.pickupAddress = args.pickupAddress.trim();
  if (args.deliveryAddress) target.deliveryAddress = args.deliveryAddress.trim();
  if (args.packageDescription) target.packageDescription = args.packageDescription.trim();
  if (args.scheduledDate) target.scheduledDate = resolveIsoDate(args.scheduledDate);
  if (args.scheduledTime) target.scheduledTime = args.scheduledTime.trim();
  if (args.assignedRider) target.assignedRider = args.assignedRider.trim();

  target.updatedAt = new Date().toISOString();
  await savePreBooking(target);

  logInfo("prebooking", "updated booking details", {
    bookingId: target.id,
    updates: args,
  });

  return { ok: true, booking: target };
}

export async function autoExpireStaleBookings(now = new Date()): Promise<{
  expiredCount: number;
  expiredIds: string[];
}> {
  const todayIso = mauritiusDateIso(now);
  const all = await listAllPreBookings();
  const expiredIds: string[] = [];

  for (const b of all) {
    if (b.status !== "confirmed" && b.status !== "pending_rider" && b.status !== "dispatched") {
      continue;
    }
    const bDate = (b.scheduledDate && b.scheduledDate !== "today" && b.scheduledDate !== "tomorrow")
      ? b.scheduledDate
      : (b.slotKey?.split("_")[0] || b.createdAt.slice(0, 10));

    // If scheduled date is strictly before today in Mauritius time
    if (bDate < todayIso) {
      const nextStatus = (b.status === "confirmed" || b.status === "dispatched") ? "completed" : "cancelled";
      b.status = nextStatus;
      b.updatedAt = new Date().toISOString();
      await savePreBooking(b);
      expiredIds.push(b.id);
      logInfo("prebooking", "auto-expired stale past booking", {
        bookingId: b.id,
        scheduledDate: bDate,
        todayIso,
        oldStatus: b.status,
        newStatus: nextStatus,
      });
    }
  }

  return { expiredCount: expiredIds.length, expiredIds };
}

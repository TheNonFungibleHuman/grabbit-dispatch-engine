/**
 * Deterministic dialog router — Phase 3.
 *
 * Intercepts high-frequency, fully-deterministic customer messages BEFORE the
 * LLM so a booking with all slots resolved completes with zero LLM tokens.
 * Anything ambiguous or missing a required slot falls through to DeepSeek.
 *
 * Safety contract:
 *  - Never books when a required slot is missing or ambiguous.
 *  - Books through the SAME createPreBookingRequest engine as the LLM tool,
 *    so capacity/buffer/batching/cooldown rules are identical.
 *  - Gated by GRABBIT_DIALOG_ROUTER env (default ON; "0"/"off"/"false" bypasses).
 */

import { extractIntakeState, type ExtractedIntakeState } from "../orders/intake-state.ts";
import { formatError, logInfo, logWarn } from "../log.ts";
import type { ChatTranscript } from "../agent/transcript.ts";

/** Slots older than this are treated as stale — never auto-booked from. */
const INTAKE_FRESHNESS_MS = 30 * 60 * 1000;

export interface RouterDecision {
  handled: boolean;
  reply?: string;
  reason: string;
}

export function isDialogRouterEnabled(): boolean {
  const raw = (process.env.GRABBIT_DIALOG_ROUTER ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "off" && raw !== "false";
}

const SLOT_LABELS: Record<string, string> = {
  serviceKind: "a passenger ride or a delivery/errand",
  pickup: "the pickup point",
  dropoff: "the drop-off point",
  time: "the time",
  paymentMethod: "cash or Juice/bank transfer",
};

function missingSlots(state: ExtractedIntakeState): string[] {
  const missing: string[] = [];
  if (!state.serviceKind) missing.push("serviceKind");
  if (!state.pickup) missing.push("pickup");
  if (!state.dropoff) missing.push("dropoff");
  if (!state.time) missing.push("time");
  if (!state.paymentMethod) missing.push("paymentMethod");
  return missing;
}

/**
 * Decide whether this customer message can be fully handled deterministically.
 * Only the single-missing-slot ask is answered here synchronously; the actual
 * booking is completed by tryDeterministicBooking once the caller confirms all
 * slots are present and the customer sent an explicit confirmation.
 */
export function routeCustomerMessage(args: {
  text: string;
  transcript: ChatTranscript;
}): RouterDecision {
  const text = (args.text || "").trim();
  if (!text) return { handled: false, reason: "empty" };

  const intake = extractIntakeState(args.transcript.entries);
  const missing = missingSlots(intake);

  if (missing.length > 1) {
    return { handled: false, reason: `intake_incomplete:${missing.join(",")}` };
  }

  if (missing.length === 1) {
    const slot = missing[0];
    const label = SLOT_LABELS[slot];
    const reply =
      slot === "paymentMethod"
        ? `Almost there! Just to confirm — will you pay in *cash* to the rider, or by *Juice / bank transfer*?`
        : slot === "time"
          ? `Got it! What *time* would you like that for?`
          : `Got it! Just to confirm, what's ${label}?`;
    logInfo("router", "deterministic targeted slot ask", { slot });
    return { handled: true, reply, reason: `ask_slot:${slot}` };
  }

  // All slots present — but the slot-bearing conversation must be FRESH.
  // extractIntakeState scans the last 6 customer messages with no time bound;
  // without this guard a "yes" hours later could book off stale slots.
  const customerEntries = args.transcript.entries.filter((e) => e.role === "customer");
  const previousCustomerEntry = customerEntries.length > 1 ? customerEntries[customerEntries.length - 2] : null;
  const previousAt = previousCustomerEntry ? Date.parse(previousCustomerEntry.at) : NaN;
  if (!Number.isFinite(previousAt) || Date.now() - previousAt > INTAKE_FRESHNESS_MS) {
    return { handled: false, reason: "intake_stale" };
  }

  return { handled: false, reason: "all_slots_present" };
}

/**
 * Attempt to complete a fully-confirmed booking deterministically.
 * Mirrors the schedule_trip_or_delivery tool: resolves the on-duty rider and
 * slotKey via getRiderForTargetSlot, then calls the same createPreBookingRequest
 * engine — identical capacity/buffer/batching/cooldown rules as an LLM booking.
 */
export async function tryDeterministicBooking(args: {
  senderPhone: string;
  customerName?: string;
  intake: ExtractedIntakeState;
}): Promise<RouterDecision> {
  const { intake } = args;
  try {
    const serviceKind: "pickup_delivery" | "errand" | "trip" =
      intake.serviceKind === "delivery" ? "pickup_delivery" : intake.serviceKind ?? "trip";
    const scheduledDate = "today";
    const scheduledTime = intake.time ?? "";

    // 1. Resolve on-duty rider for this target date & time (same as the tool).
    const { getRiderForTargetSlot } = await import("../schedule/availability.ts");
    const targetSlot = await getRiderForTargetSlot({ targetDate: scheduledDate, targetTime: scheduledTime });
    if (!targetSlot.available || targetSlot.riders.length === 0) {
      return { handled: false, reason: `no_rider:${targetSlot.weekday}` };
    }
    const assignedRider = targetSlot.riders[0];

    // 2. Create the booking through the deterministic engine.
    const { createPreBookingRequest } = await import("../orders/pre-booking.ts");
    const result = await createPreBookingRequest({
      customerPhone: args.senderPhone,
      customerName: args.customerName || "Customer",
      serviceKind,
      pickupAddress: intake.pickup ?? "",
      deliveryAddress: intake.dropoff ?? "",
      packageDescription: intake.packageDescription,
      tripType: "one_way",
      scheduledDate,
      scheduledTime,
      slotKey: targetSlot.slotKey,
      assignedRider,
    });

    if (!result.ok) {
      logWarn("router", "deterministic booking rejected by engine", { error: result.error });
      return { handled: false, reason: `engine_rejected:${result.error ?? "unknown"}` };
    }

    const { recordMetric } = await import("../metrics/recorder.ts");
    void recordMetric("booking_created");

    const rider = result.assignedRider || assignedRider || "your rider";
    const reply = [
      `✅ *You're booked!*`,
      ``,
      `🛵 Rider: *${rider}*`,
      `⏰ Time: *${intake.time}*`,
      `📍 ${intake.pickup} → ${intake.dropoff}`,
      intake.paymentMethod === "cash"
        ? `💰 Pay your rider in cash.`
        : `💰 Payment via Juice/transfer — dispatch will verify receipt.`,
      ``,
      `Have a great trip with Grabbit Express! ⚡`,
    ].join("\n");

    logInfo("router", "deterministic booking completed", { bookingId: result.booking?.id, rider });
    return { handled: true, reply, reason: "booked" };
  } catch (error) {
    logWarn("router", "deterministic booking failed; falling through to LLM", formatError(error));
    return { handled: false, reason: "engine_error" };
  }
}

import {
  bookKiloDeliveryFromChat,
  matchPlaceForChat,
  type BookDeliveryToolArgs,
} from "../orders/book.ts";
import {
  getDiscoveryBundle,
  summarizeDiscoveryForAgent,
} from "../kilo/discovery.ts";
import { formatError, logError, logInfo, logWarn } from "../log.ts";
import { getOrderDraft } from "../orders/store.ts";
import { getAvailabilitySnapshot } from "../schedule/availability.ts";
import { getKnowledgeBundle } from "../admin/knowledge.ts";
import {
  formatTranscriptForAgent,
  loadTranscript,
} from "./transcript.ts";

export const AGENT_TOOLS = [
  {
    type: "function" as const,
    name: "match_service_location",
    description:
      "Match a hostel/gate/landmark mention to Kilo service locations and return unit follow-up rules. Use for pickup_delivery places and errand dropoffs. Do not use for errand shop side.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        role: { type: "string", enum: ["pickup", "dropoff"] },
        serviceKind: {
          type: "string",
          enum: ["pickup_delivery", "errand"],
        },
      },
      required: ["query", "role"],
    },
  },
  {
    type: "function" as const,
    name: "book_kilo_delivery",
    description:
      "Book an immediate on-demand delivery/errand on the Kilo fleet after the customer confirms the order summary. For scheduled or future slots (e.g. later today or tomorrow), use schedule_trip_or_delivery instead.",
    parameters: {
      type: "object",
      properties: {
        serviceKind: {
          type: "string",
          enum: ["pickup_delivery", "errand"],
        },
        deliveryMode: {
          type: "string",
          enum: ["pickup", "warehouse"],
        },
        warehouseId: { type: "string" },
        senderName: { type: "string" },
        senderPhone: { type: "string" },
        receiverName: { type: "string" },
        receiverPhone: {
          type: "string",
          description:
            "Only required when receiver is NOT the WhatsApp user.",
        },
        receiverIsWhatsAppUser: {
          type: "boolean",
          description:
            "Default true. Confirm delivering to this WhatsApp number.",
        },
        pickupAddress: { type: "string" },
        deliveryAddress: { type: "string" },
        pickupServiceLocationId: { type: "string" },
        pickupUnit: { type: "string" },
        deliveryServiceLocationId: { type: "string" },
        deliveryUnit: { type: "string" },
        packageDescription: { type: "string" },
        packageSize: {
          type: "string",
          enum: ["small", "medium", "large"],
        },
        pickupContactSameAsSender: { type: "boolean" },
        pickupContactName: { type: "string" },
        pickupContactPhone: { type: "string" },
        senderEmail: { type: "string" },
        isPODEnabled: { type: "boolean" },
        podAmount: { type: "number" },
        errandMode: {
          type: "string",
          enum: ["at_place", "link", "photo"],
          description:
            "Required for errands. at_place/link: photos optional. photo: need stored WhatsApp photos. link: need errandLinks.",
        },
        errandLinks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string" },
              note: { type: "string" },
              curatedId: { type: "string" },
            },
            required: ["url"],
          },
        },
        errandBudgetNgn: { type: "string" },
        errandSubstituteOk: { type: "boolean" },
        shopPhone: { type: "string" },
        pickupLocationUnknown: { type: "boolean" },
      },
      required: ["packageDescription"],
    },
  },
  {
    type: "function" as const,
    name: "schedule_trip_or_delivery",
    description:
      "Pre-book or schedule a future delivery or passenger trip for any date/time (even outside current hours). Checks on-duty rider from schedule and prevents double-booking. Notifies the assigned rider to confirm before final dispatch.",
    parameters: {
      type: "object",
      properties: {
        serviceKind: {
          type: "string",
          enum: ["pickup_delivery", "errand", "trip"],
          description: "trip for passenger ride, pickup_delivery for food/packages, errand for errands",
        },
        scheduledDate: {
          type: "string",
          description: "Target date in YYYY-MM-DD format or 'today' / 'tomorrow'",
        },
        scheduledTime: {
          type: "string",
          description: "Target time e.g. '12:00 pm', '8:30 am', '17:00'",
        },
        pickupAddress: { type: "string" },
        deliveryAddress: { type: "string" },
        customerName: { type: "string" },
        packageDescription: { type: "string" },
        tripType: {
          type: "string",
          enum: ["one_way", "round_trip"],
          description: "For passenger trips: one_way (direct trip) or round_trip (includes return + 15 min free wait after dropoff)",
        },
      },
      required: ["serviceKind", "scheduledDate", "scheduledTime", "pickupAddress", "deliveryAddress"],
    },
  },
  {
    type: "function" as const,
    name: "reschedule_trip_or_delivery",
    description:
      "Reschedule, move, delay, or postpone an existing confirmed trip or delivery for a customer to a new time or date. Checks rider capacity and updates the assigned rider with a reschedule alert.",
    parameters: {
      type: "object",
      properties: {
        newScheduledTime: {
          type: "string",
          description: "New requested time e.g. '12:45 pm', '1:00 pm', '6:30 pm'",
        },
        newScheduledDate: {
          type: "string",
          description: "Optional new date if moving to another day, e.g. 'today', 'tomorrow', or 'YYYY-MM-DD'",
        },
      },
      required: ["newScheduledTime"],
    },
  },
  {
    type: "function" as const,
    name: "check_with_rider",
    description:
      "Send a real-time status inquiry to the assigned rider when a customer asks for a live update, where their driver is, or reports an in-flight delay. Returns active delivery info and live map link.",
    parameters: {
      type: "object",
      properties: {
        inquiryMessage: {
          type: "string",
          description: "Summary of customer inquiry e.g. 'Customer is asking where the rider is' or 'Checking on order delay'",
        },
      },
      required: ["inquiryMessage"],
    },
  },
  {
    type: "function" as const,
    name: "escalate_to_admin",
    description:
      "Alert the human dispatch admin (+999000000008 and Google Chat) when a customer request is confusing, an edge case occurs, or human intervention is required.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Explanation of why admin intervention is needed",
        },
      },
      required: ["reason"],
    },
  },
  {
    type: "function" as const,
    name: "check_rider_assigned_trips",
    description:
      "Query booked trips and deliveries assigned to a rider or all riders for today or upcoming dates. STRICT SECURITY: Only works for registered Grabbit fleet riders and authorized admin (+9990000000003). If any unauthorized customer asks, returns Access Denied.",
    parameters: {
      type: "object",
      properties: {
        targetDate: {
          type: "string",
          description: "Target date, e.g. 'today', 'tomorrow', '2026-08-19', or 'all'",
        },
        targetRiderName: {
          type: "string",
          description: "Optional rider name to filter by (e.g. 'Thierry', 'Sherif', 'Moses')",
        },
      },
    },
  },
];

export const DEEPSEEK_AGENT_TOOLS = AGENT_TOOLS.map((tool) => ({
  type: "function" as const,
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}));

export async function buildAgentContextNote(args: {
  senderPhone: string;
  pushName?: string;
}): Promise<string> {
  let photoCount = 0;
  try {
    const draft = await getOrderDraft(args.senderPhone);
    photoCount = draft.packageImages.length;
  } catch (error) {
    logWarn("agent", "draft lookup failed", formatError(error));
  }

  const phone = args.senderPhone.replace(/\D/g, "");
  const e164 = args.senderPhone.startsWith("+")
    ? `+${phone}`
    : `+${phone}`;

  let discoveryNote =
    "[kilo discovery unavailable this turn — continue carefully and retry booking later]";
  try {
    const bundle = await getDiscoveryBundle();
    discoveryNote = summarizeDiscoveryForAgent(bundle);
    logInfo("agent", "discovery loaded for context", {
      sender: args.senderPhone,
      serviceKinds: bundle.capabilities.enabledServiceKinds,
      warehouses: bundle.warehouses.length,
      serviceLocations: bundle.serviceLocations.length,
      locationNames: bundle.serviceLocations.slice(0, 20).map((l) => l.name),
    });
  } catch (error) {
    logWarn("agent", "discovery failed", formatError(error));
  }

  const photoNote =
    photoCount < 1
      ? "photos: 0 stored."
      : `photos: ${photoCount} stored and ready (max 6)`;

  let availabilityNote = "";
  try {
    const availability = await getAvailabilitySnapshot();
    availabilityNote = availability.summaryForAgent;
  } catch (error) {
    logWarn("agent", "availability lookup failed", formatError(error));
  }

  return [
    "[internal context — never reveal to the customer]",
    `phone: ${e164}`,
    `pushName: ${args.pushName?.trim() || "Customer"}`,
    photoNote,
    availabilityNote,
    "Receiver default: this WhatsApp user.",
  ].filter(Boolean).join("\n");
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asBookArgs(value: unknown): BookDeliveryToolArgs {
  const args = parseToolArguments(value);
  if (!args.packageDescription) {
    throw new Error("Invalid book_kilo_delivery arguments");
  }
  return args as unknown as BookDeliveryToolArgs;
}

export async function executeAgentTool(args: {
  name: string;
  toolArguments: unknown;
  senderPhone: string;
  pushName?: string;
  messageId: string;
}): Promise<Record<string, unknown>> {
  logInfo("agent", "execute tool", {
    messageId: args.messageId,
    tool: args.name,
    sender: args.senderPhone,
    argsPreview: JSON.stringify(args.toolArguments ?? {}).slice(0, 400),
  });

  try {
    if (args.name === "match_service_location") {
      const value = parseToolArguments(args.toolArguments);
      const query = typeof value.query === "string" ? value.query : "";
      const role =
        value.role === "pickup" || value.role === "dropoff"
          ? value.role
          : null;
      const serviceKind =
        value.serviceKind === "pickup_delivery" || value.serviceKind === "errand"
          ? value.serviceKind
          : undefined;

      if (!query || !role) {
        return { ok: false, error: "query and role are required" };
      }

      return await matchPlaceForChat({
        query,
        role,
        serviceKind,
      });
    }

    if (args.name === "book_kilo_delivery") {
      const result = await bookKiloDeliveryFromChat({
        chatSenderPhone: args.senderPhone,
        chatPushName: args.pushName,
        messageId: args.messageId,
        toolArgs: asBookArgs(args.toolArguments),
      });
      if (result.ok === true) {
        try {
          const { markTranscriptBookingQuiet } = await import("./transcript");
          await markTranscriptBookingQuiet(args.senderPhone);
        } catch (error) {
          logWarn("agent", "failed to mark booking quiet window", formatError(error));
        }
      }
      return result;
    }

    if (args.name === "schedule_trip_or_delivery") {
      const value = parseToolArguments(args.toolArguments);
      const serviceKind = (value.serviceKind as "pickup_delivery" | "errand" | "trip") || "trip";
      const scheduledDate = String(value.scheduledDate || "today");
      const scheduledTime = String(value.scheduledTime || "12:00 pm");
      const pickupAddress = String(value.pickupAddress || "");
      const deliveryAddress = String(value.deliveryAddress || "");
      const customerName = String(value.customerName || args.pushName || "Customer");
      const packageDescription = value.packageDescription ? String(value.packageDescription) : undefined;
      const tripType = value.tripType as ("one_way" | "round_trip" | undefined);

      // 1. Resolve on-duty rider for this target date & time
      const { getRiderForTargetSlot } = await import("../schedule/availability.ts");
      const targetSlot = await getRiderForTargetSlot({
        targetDate: scheduledDate,
        targetTime: scheduledTime,
      });

      if (!targetSlot.available || targetSlot.riders.length === 0) {
        return {
          ok: false,
          error: `No rider is scheduled on duty on ${targetSlot.weekday} around ${scheduledTime}. Please offer another open time slot.`,
        };
      }

      const assignedRider = targetSlot.riders[0];

      // 2. Create prebooking with anti-double-booking guard & notify rider
      const { createPreBookingRequest } = await import("../orders/pre-booking.ts");
      const prebookResult = await createPreBookingRequest({
        customerPhone: args.senderPhone,
        customerName,
        serviceKind,
        pickupAddress,
        deliveryAddress,
        packageDescription,
        tripType,
        scheduledDate,
        scheduledTime,
        slotKey: targetSlot.slotKey,
        assignedRider,
      });

      if (!prebookResult.ok) {
        return {
          ok: false,
          doubleBooked: prebookResult.doubleBooked ?? false,
          error: prebookResult.error,
        };
      }

      try {
        const { markTranscriptBookingQuiet } = await import("./transcript.ts");
        await markTranscriptBookingQuiet(args.senderPhone);
      } catch (error) {
        logWarn("agent", "failed to mark schedule booking quiet window", formatError(error));
      }

      const trackingUrl = prebookResult.trackingUrl || "https://delivery.grabbit-express.com";

      return {
        ok: true,
        serviceKind,
        scheduledDate,
        scheduledTime,
        assignedRider: prebookResult.assignedRider || assignedRider,
        kiloDeliveryId: prebookResult.kiloDeliveryId,
        trackingUrl,
        status: "confirmed",
        message: `Your ${serviceKind} request for ${scheduledDate} at ${scheduledTime} is confirmed and assigned to rider ${prebookResult.assignedRider || assignedRider}! Live Tracking Link: ${trackingUrl}`,
      };
    }

    if (args.name === "reschedule_trip_or_delivery") {
      const value = parseToolArguments(args.toolArguments);
      const newScheduledTime = String(value.newScheduledTime || "");
      const newScheduledDate = value.newScheduledDate ? String(value.newScheduledDate) : "today";

      if (!newScheduledTime) {
        return { ok: false, error: "newScheduledTime is required to reschedule." };
      }

      // 1. Resolve on-duty rider for this new target date & time
      const { getRiderForTargetSlot } = await import("../schedule/availability.ts");
      const targetSlot = await getRiderForTargetSlot({
        targetDate: newScheduledDate,
        targetTime: newScheduledTime,
      });

      if (!targetSlot.available || targetSlot.riders.length === 0) {
        return {
          ok: false,
          error: `No rider is scheduled on duty on ${targetSlot.weekday} around ${newScheduledTime}. Please offer another open time slot.`,
        };
      }

      const assignedRider = targetSlot.riders[0];

      // 2. Reschedule prebooking and notify rider
      const { reschedulePreBookingRequest } = await import("../orders/pre-booking.ts");
      const result = await reschedulePreBookingRequest({
        customerPhone: args.senderPhone,
        newScheduledDate,
        newScheduledTime,
        newSlotKey: targetSlot.slotKey,
        newAssignedRider: assignedRider,
      });

      if (!result.ok) {
        return {
          ok: false,
          doubleBooked: result.doubleBooked ?? false,
          error: result.error,
        };
      }

      const trackingUrl = result.trackingUrl || "https://delivery.grabbit-express.com";

      return {
        ok: true,
        serviceKind: result.booking?.serviceKind || "booking",
        newScheduledDate,
        newScheduledTime,
        assignedRider: result.booking?.assignedRider || assignedRider,
        kiloDeliveryId: result.booking?.kiloDeliveryId,
        trackingUrl,
        message: `Your booking is now rescheduled to ${newScheduledDate} at ${newScheduledTime} with rider ${result.booking?.assignedRider || assignedRider}! Live Tracking Link: ${trackingUrl}`,
      };
    }

    if (args.name === "check_with_rider") {
      const value = parseToolArguments(args.toolArguments);
      const inquiryMessage = String(value.inquiryMessage || "Customer is checking on order status");

      const { listAllPreBookings } = await import("../orders/pre-booking.ts");
      const { notifyRiderCustomerInquiry } = await import("../riders/notify-rider.ts");
      const phoneClean = args.senderPhone.replace(/\D/g, "");

      const all = await listAllPreBookings();
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
          error: "No active delivery or trip found in progress for your number.",
        };
      }

      await notifyRiderCustomerInquiry({
        assignedRider: activeBooking.assignedRider,
        customerName: activeBooking.customerName || args.pushName || "Customer",
        customerPhone: args.senderPhone,
        inquiry: inquiryMessage,
        bookingId: activeBooking.id,
        kiloDeliveryId: activeBooking.kiloDeliveryId,
        trackingUrl: activeBooking.trackingUrl,
      });

      return {
        ok: true,
        assignedRider: activeBooking.assignedRider,
        scheduledTime: activeBooking.scheduledTime,
        trackingUrl: activeBooking.trackingUrl || "https://delivery.grabbit-express.com",
        message: `I've sent an alert to rider ${activeBooking.assignedRider}. You can also follow their real-time map location here: ${activeBooking.trackingUrl || 'https://delivery.grabbit-express.com'}`,
      };
    }

    if (args.name === "escalate_to_admin") {
      const value = parseToolArguments(args.toolArguments);
      const reason = String(value.reason || "Customer inquiry needs admin assistance");

      const { notifyAdminEscalation } = await import("../riders/notify-rider.ts");
      const { recordOpsEvent } = await import("../ops/store.ts");

      await notifyAdminEscalation({
        customerPhone: args.senderPhone,
        customerName: args.pushName || "Customer",
        reason,
      });

      await recordOpsEvent({
        phone: args.senderPhone,
        type: "agent_failed",
        preview: `Escalated: ${reason}`,
      });

      return {
        ok: true,
        message: "I've flagged this to our dispatch team so a human operator can assist right away!",
      };
    }

    if (args.name === "check_rider_assigned_trips") {
      const value = parseToolArguments(args.toolArguments);
      const { getRiderAssignedBookings } = await import("../orders/pre-booking.ts");
      const result = await getRiderAssignedBookings({
        callerPhone: args.senderPhone,
        targetDate: value.targetDate ? String(value.targetDate) : "today",
        targetRiderName: value.targetRiderName ? String(value.targetRiderName) : undefined,
      });

      return result;
    }

    return { ok: false, error: `Unknown tool: ${args.name}` };
  } catch (error) {
    logError("agent", "tool execution failed", error);
    console.error("[agent] tool failure detail", {
      messageId: args.messageId,
      tool: args.name,
      ...formatError(error),
    });
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Tool failed unexpectedly",
    };
  }
}

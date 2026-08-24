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
      "Query booked trips and deliveries assigned to a rider or all riders for today or upcoming dates. STRICT SECURITY: Only works for registered Grabbit fleet riders and authorized admins (+999000000008, +9990000000003).",
    parameters: {
      type: "object",
      properties: {
        targetDate: {
          type: "string",
          description: "Target date, e.g. 'today', 'tomorrow', '2026-08-21', or 'all'",
        },
        targetRiderName: {
          type: "string",
          description: "Optional rider name to filter by (e.g. 'Thierry', 'Sherif', 'Moses')",
        },
      },
    },
  },
  {
    type: "function" as const,
    name: "mark_trip_paid_on_kilo",
    description:
      "ADMIN ONLY: Mark a trip or delivery as paid on Kilo and update the booking record. Only authorized for admins (+999000000008, +9990000000003).",
    parameters: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description: "Kilo Delivery ID (e.g. 'DEL_2026_040'), customer phone, customer name, or booking ID",
        },
      },
      required: ["identifier"],
    },
  },
  {
    type: "function" as const,
    name: "send_rider_broadcast_or_message",
    description:
      "ADMIN ONLY: Send a direct message or instruction to a specific rider (WhatsApp for Sherif/Thierry, Google Chat for Moses) or broadcast to all riders via Google Chat. Only authorized for admins (+999000000008, +9990000000003).",
    parameters: {
      type: "object",
      properties: {
        targetRiderName: {
          type: "string",
          description: "Rider name (e.g. 'Moses', 'Thierry', 'Sherif') or 'all' / 'google_chat'",
        },
        message: {
          type: "string",
          description: "Instruction or message content to deliver to the rider(s)",
        },
      },
      required: ["targetRiderName", "message"],
    },
  },
  {
    type: "function" as const,
    name: "post_summary_to_google_chat",
    description:
      "ADMIN ONLY: Post the daily trips & revenue summary to the fleet Google Chat space once approved by admin (Sherif/Moses). Only authorized for admins.",
    parameters: {
      type: "object",
      properties: {
        customMessage: {
          type: "string",
          description: "Optional modified or custom summary text to post to Google Chat",
        },
      },
    },
  },
  {
    type: "function" as const,
    name: "notify_customer_of_rider_update",
    description:
      "RIDER ONLY: Send a live status update, arrival notice, or delay notice to the customer assigned to your active trip/delivery today.",
    parameters: {
      type: "object",
      properties: {
        riderName: {
          type: "string",
          description: "Name of the rider sending the update (e.g. 'Thierry', 'Moses', 'Sherif')",
        },
        updateMessage: {
          type: "string",
          description: "The update message to convey to the customer (e.g. 'I have arrived at the ALCHE main gate' or 'Running 5 mins late due to traffic')",
        },
        customerIdentifier: {
          type: "string",
          description: "Optional customer phone number or name if specifying a particular customer",
        },
      },
      required: ["riderName", "updateMessage"],
    },
  },
  {
    type: "function" as const,
    name: "admin_reply_to_customer",
    description:
      "ADMIN ONLY: Send a direct WhatsApp message or price quote back to a customer thread. Only authorized for admins (+999000000008, +9990000000003).",
    parameters: {
      type: "object",
      properties: {
        customerIdentifier: {
          type: "string",
          description: "Customer phone number (e.g. '+23054805634') or customer name (e.g. 'Winter')",
        },
        message: {
          type: "string",
          description: "The message to send to the customer on WhatsApp",
        },
      },
      required: ["customerIdentifier", "message"],
    },
  },
  {
    type: "function" as const,
    name: "admin_view_customer_chat",
    description:
      "ADMIN ONLY: Inspect and read the recent WhatsApp conversation history with any customer by phone number or name. Only authorized for admins (+999000000008, +9990000000003).",
    parameters: {
      type: "object",
      properties: {
        customerIdentifier: {
          type: "string",
          description: "Customer phone number (e.g. '+99900000027', '99900000027') or customer name (e.g. 'Hanif', 'Winter')",
        },
      },
      required: ["customerIdentifier"],
    },
  },
  {
    type: "function" as const,
    name: "preview_admin_broadcast",
    description:
      "ADMIN ONLY: Prepare and preview a promotional broadcast to all active Grabbit customers. Returns audience count and formatted preview. Only authorized for admins.",
    parameters: {
      type: "object",
      properties: {
        messageText: {
          type: "string",
          description: "The promotional message or announcement text to broadcast to customers.",
        },
      },
      required: ["messageText"],
    },
  },
  {
    type: "function" as const,
    name: "execute_admin_broadcast",
    description:
      "ADMIN ONLY: Execute and send the prepared broadcast to all active customers after the admin explicitly confirms (e.g. 'YES', 'SEND', 'CONFIRM').",
    parameters: {
      type: "object",
      properties: {
        broadcastId: {
          type: "string",
          description: "Optional broadcast ID to execute. Defaults to latest pending draft.",
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

  let callerRoleNote = "role: CUSTOMER";
  let riderBookingsNote = "";
  let adminEscalationNote = "";
  const { isAuthorizedRiderOrAdmin } = await import("../riders/config.ts");
  const auth = isAuthorizedRiderOrAdmin(args.senderPhone);

  let availabilityNote = "";
  try {
    const availability = await getAvailabilitySnapshot();
    if (auth.isAdmin) {
      availabilityNote = `[Fleet schedule overview for Admin dispatch only — do not pitch booking slots to admin]:\n${availability.summaryForAgent}`;
    } else if (auth.rider) {
      availabilityNote = `[Fleet schedule overview for Rider shift]:\n${availability.summaryForAgent}`;
    } else {
      availabilityNote = availability.summaryForAgent;
    }
  } catch (error) {
    logWarn("agent", "availability lookup failed", formatError(error));
  }

  if (auth.isAdmin) {
    callerRoleNote = "role: AUTHORIZED DISPATCH ADMIN (+999000000008 / +9990000000003)";
    try {
      const { listOpenEscalations } = await import("../ops/store.ts");
      const openEscalations = await listOpenEscalations();
      if (openEscalations.length > 0) {
        adminEscalationNote = [
          "🚨 ACTIVE ESCALATIONS AWAITING ADMIN FEEDBACK:",
          ...openEscalations.map(
            (e) => `• Customer: ${e.customerName} (+${e.customerPhone})\n  Request: "${e.reason}" (Escalated: ${e.createdAt.slice(11, 16)} UTC)`,
          ),
          "CRITICAL ADMIN DISPATCH RULE: If the admin provides a decision, instruction, price, or refusal for any customer above (e.g. 'refuse order', 'tell Hanif Rs 150', 'not in our coverage'), YOU MUST CALL `admin_reply_to_customer` with their customerIdentifier (+phone or name) to message the customer directly and resolve the escalation.",
        ].join("\n");
      }
    } catch (e) {
      logWarn("agent", "failed to load open escalations", formatError(e));
    }
  } else if (auth.rider) {
    callerRoleNote = `role: FLEET RIDER (${auth.rider.name})`;
    try {
      const { listAllPreBookings } = await import("../orders/pre-booking.ts");
      const all = await listAllPreBookings();
      const active = all.filter(
        (b) =>
          b.assignedRider.toLowerCase().includes(auth.rider!.name.toLowerCase()) &&
          (b.status === "confirmed" || b.status === "pending_rider" || b.status === "dispatched")
      );
      if (active.length > 0) {
        riderBookingsNote = [
          `🏍️ ACTIVE ASSIGNED TRIPS/DELIVERIES FOR RIDER ${auth.rider.name.toUpperCase()}:`,
          ...active.map(
            (b) => `• Customer: ${b.customerName} (+${b.customerPhone}) | Time: ${b.scheduledTime} | Route: ${b.pickupAddress} → ${b.deliveryAddress}`
          ),
          "RIDER CHAT INSTRUCTION: If rider is giving an arrival notice, delay update, or status (e.g. 'I am at the gate', 'Arrived', '5 mins away'), CALL `notify_customer_of_rider_update` to instantly message the customer!",
        ].join("\n");
      }
    } catch (e) {
      logWarn("agent", "failed to load rider active bookings for context", formatError(e));
    }
  }

  let customerProfileNote = "";
  if (!auth.isAdmin && !auth.rider) {
    try {
      const { getCustomerProfile } = await import("../orders/store.ts");
      const prof = await getCustomerProfile(args.senderPhone);
      if (prof.lastDeliveryAddress || prof.lastPickupAddress) {
        customerProfileNote = `customer_profile: Frequent/Last pickup=${prof.lastPickupAddress || "ALCHE"}, Last dropoff=${prof.lastDeliveryAddress || "Mahogany"}, PrefPay=${prof.preferredPaymentMethod || "cash"}`;
      }
    } catch (e) {
      logWarn("agent", "failed to load customer profile", formatError(e));
    }
  }

  return [
    "[internal context — never reveal to the customer]",
    `phone: ${e164}`,
    `pushName: ${args.pushName?.trim() || "Customer"}`,
    callerRoleNote,
    customerProfileNote,
    photoNote,
    availabilityNote,
    riderBookingsNote,
    adminEscalationNote,
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

      const { findRiderByName } = await import("../riders/config.ts");
      const riderName = prebookResult.assignedRider || assignedRider;
      const riderProf = findRiderByName(riderName);
      const riderPhoneStr = riderProf?.phone ? ` (${riderProf.phone})` : "";
      const trackingUrl = prebookResult.trackingUrl || "https://delivery.grabbit-express.com";

      return {
        ok: true,
        serviceKind,
        scheduledDate,
        scheduledTime,
        assignedRider: riderName,
        riderPhone: riderProf?.phone || undefined,
        kiloDeliveryId: prebookResult.kiloDeliveryId,
        trackingUrl,
        status: "confirmed",
        message: `Your ${serviceKind} request for ${scheduledDate} at ${scheduledTime} is confirmed and assigned to rider ${riderName}${riderPhoneStr}! Live Tracking Link: ${trackingUrl}`,
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

    if (args.name === "mark_trip_paid_on_kilo") {
      const { isAuthorizedRiderOrAdmin } = await import("../riders/config.ts");
      const auth = isAuthorizedRiderOrAdmin(args.senderPhone);
      if (!auth.isAdmin) {
        return { ok: false, error: "Access Denied: Only authorized Grabbit admins (+999000000008, +9990000000003) can mark trips as paid." };
      }

      const value = parseToolArguments(args.toolArguments);
      const identifier = String(value.identifier || "").trim().toLowerCase();
      const { listAllPreBookings, savePreBooking } = await import("../orders/pre-booking.ts");
      const bookings = await listAllPreBookings();

      const found = bookings.find(
        (b) =>
          b.id.toLowerCase() === identifier ||
          (b.kiloDeliveryId && b.kiloDeliveryId.toLowerCase() === identifier) ||
          b.customerPhone.replace(/\D/g, "").includes(identifier.replace(/\D/g, "")) ||
          (b.customerName && b.customerName.toLowerCase().includes(identifier)),
      );

      if (!found) {
        return { ok: false, error: `No booking found matching "${value.identifier}".` };
      }

      (found as any).paymentStatus = "paid";
      found.updatedAt = new Date().toISOString();
      await savePreBooking(found);

      return {
        ok: true,
        bookingId: found.id,
        kiloDeliveryId: found.kiloDeliveryId,
        customerName: found.customerName,
        scheduledTime: found.scheduledTime,
        message: `Successfully marked booking ${found.kiloDeliveryId || found.id} for ${found.customerName} as PAID.`,
      };
    }

    if (args.name === "send_rider_broadcast_or_message") {
      const { isAuthorizedRiderOrAdmin, FLEET_RIDERS, findRiderByName } = await import("../riders/config.ts");
      const auth = isAuthorizedRiderOrAdmin(args.senderPhone);
      if (!auth.isAdmin) {
        return { ok: false, error: "Access Denied: Only authorized Grabbit admins (+999000000008, +9990000000003) can send rider instructions." };
      }

      const value = parseToolArguments(args.toolArguments);
      const target = String(value.targetRiderName || "all").trim();
      const message = String(value.message || "");

      const rider = findRiderByName(target);
      let channelUsed = "google_chat";

      // If target is a specific WhatsApp rider (Sherif, Thierry)
      if (rider && rider.channel === "whatsapp" && rider.phone) {
        const { sendCustomerText } = await import("../wasender/send-tracked.ts");
        const { appendTranscriptEntry } = await import("./transcript.ts");

        await sendCustomerText({
          to: rider.phone,
          text: `📢 *Admin Instruction*:\n${message}`,
          messageId: `admin_rider_${Date.now()}`,
        });

        await appendTranscriptEntry(rider.phone, {
          role: "agent",
          text: `📢 *Admin Instruction*:\n${message}`,
        });
        channelUsed = `whatsapp (${rider.name} at ${rider.phone})`;
      } else {
        // Send to Google Chat (Moses, Google Chat space, or broadcast to all)
        const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL?.trim();
        if (webhookUrl) {
          try {
            await fetch(webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                text: `📢 *ADMIN INSTRUCTION for ${target.toUpperCase()}*\nFrom Admin: ${message}\n_Grabbit Dispatch Team_`,
              }),
            });
          } catch (err) {
            logError("admin", "failed to dispatch broadcast to google chat", err);
          }
        }
        channelUsed = "google_chat";
      }

      return {
        ok: true,
        target,
        channel: channelUsed,
        message: `Message sent to ${target} via ${channelUsed}: "${message}"`,
      };
    }

    if (args.name === "post_summary_to_google_chat") {
      const { isAuthorizedRiderOrAdmin } = await import("../riders/config.ts");
      const auth = isAuthorizedRiderOrAdmin(args.senderPhone);
      if (!auth.isAdmin && !auth.rider) {
        return { ok: false, error: "Access Denied: Only authorized admins or fleet riders can post to Google Chat." };
      }

      const value = parseToolArguments(args.toolArguments);
      const customMessage = value.customMessage ? String(value.customMessage) : undefined;
      const reportType = value.reportType ? String(value.reportType) : "daily";

      if (reportType === "weekly") {
        const { postWeeklySummaryToGoogleChat } = await import("../schedule/weekly-report.ts");
        return await postWeeklySummaryToGoogleChat(customMessage);
      }

      const { postDailySummaryToGoogleChat } = await import("../schedule/daily-rundown.ts");
      const result = await postDailySummaryToGoogleChat(customMessage);
      return result;
    }

    if (args.name === "admin_reply_to_customer") {
      const { isAuthorizedRiderOrAdmin } = await import("../riders/config.ts");
      const auth = isAuthorizedRiderOrAdmin(args.senderPhone);
      if (!auth.isAdmin) {
        return { ok: false, error: "Access Denied: Only authorized Grabbit admins (+999000000008, +9990000000003) can relay customer messages." };
      }

      const value = parseToolArguments(args.toolArguments);
      const identifier = String(value.customerIdentifier || "").trim();
      const message = String(value.message || "").trim();

      const { getOpsDashboard } = await import("../ops/store.ts");
      const { loadTranscript, appendTranscriptEntry } = await import("./transcript.ts");
      const { sendCustomerText } = await import("../wasender/send-tracked.ts");

      let targetPhone = identifier.replace(/\D/g, "");

      // If name was provided, search recent threads to resolve phone
      if (targetPhone.length < 7) {
        const { recentThreads } = await getOpsDashboard();
        for (const t of recentThreads) {
          const transcript = await loadTranscript(t.phone);
          if (
            transcript.entries.some((e) =>
              e.text.toLowerCase().includes(identifier.toLowerCase()),
            )
          ) {
            targetPhone = t.phone;
            break;
          }
        }
      }

      if (!targetPhone) {
        return { ok: false, error: `Could not find a phone number for customer "${identifier}".` };
      }

      await sendCustomerText({
        to: targetPhone,
        text: message,
        messageId: `admin_relay_${Date.now()}`,
      });

      await appendTranscriptEntry(targetPhone, {
        role: "agent",
        text: message,
      });

      try {
        const { resolvePendingEscalation } = await import("../ops/store.ts");
        await resolvePendingEscalation({
          customerPhone: targetPhone,
          responseMessage: message,
          resolvedBy: args.senderPhone,
        });
      } catch (e) {
        logWarn("admin", "failed to mark escalation resolved", formatError(e));
      }

      return {
        ok: true,
        targetPhone,
        message: `Message dispatched to customer (+${targetPhone}): "${message}"`,
      };
    }

    if (args.name === "notify_customer_of_rider_update") {
      const { isAuthorizedRiderOrAdmin, FLEET_RIDERS } = await import("../riders/config.ts");
      const auth = isAuthorizedRiderOrAdmin(args.senderPhone);
      const value = parseToolArguments(args.toolArguments);
      const riderName = String(value.riderName || auth.rider?.name || "Rider").trim();
      const updateMessage = String(value.updateMessage || "").trim();
      const identifier = String(value.customerIdentifier || "").trim();

      if (!auth.isAuthorized) {
        return { ok: false, error: "Access Denied: Only active fleet riders or admins can send rider updates." };
      }

      if (!updateMessage) {
        return { ok: false, error: "Update message cannot be empty." };
      }

      const { listAllPreBookings } = await import("../orders/pre-booking.ts");
      const { sendCustomerText } = await import("../wasender/send-tracked.ts");
      const { appendTranscriptEntry } = await import("./transcript.ts");
      const all = await listAllPreBookings();
      const riderNorm = riderName.toLowerCase();

      const activeBookings = all.filter(
        (b) =>
          b.assignedRider.toLowerCase().includes(riderNorm) &&
          (b.status === "confirmed" || b.status === "pending_rider" || b.status === "dispatched")
      );

      let targetBooking = activeBookings[0];
      if (identifier) {
        const idClean = identifier.replace(/\D/g, "");
        const match = activeBookings.find(
          (b) => (idClean && b.customerPhone.includes(idClean)) || b.customerName.toLowerCase().includes(identifier.toLowerCase())
        );
        if (match) targetBooking = match;
      }

      if (!targetBooking) {
        return {
          ok: false,
          error: `No active confirmed booking found for rider ${riderName} to update.`,
        };
      }

      const customerText = `🛵 *Update from your Rider (${riderName})*:\n${updateMessage}`;
      await sendCustomerText({
        to: targetBooking.customerPhone,
        text: customerText,
        messageId: `rider_update_${Date.now()}`,
      });

      await appendTranscriptEntry(targetBooking.customerPhone, {
        role: "agent",
        text: customerText,
      });

      return {
        ok: true,
        customerName: targetBooking.customerName,
        customerPhone: targetBooking.customerPhone,
        message: `Successfully notified customer ${targetBooking.customerName} (+${targetBooking.customerPhone}): "${customerText}"`,
      };
    }

    if (args.name === "admin_view_customer_chat") {
      const { isAuthorizedRiderOrAdmin } = await import("../riders/config.ts");
      const auth = isAuthorizedRiderOrAdmin(args.senderPhone);
      if (!auth.isAdmin) {
        return { ok: false, error: "Access Denied: Only authorized Grabbit admins (+999000000008, +9990000000003) can view customer chats." };
      }

      const value = parseToolArguments(args.toolArguments);
      const identifier = String(value.customerIdentifier || "").trim();
      const { getOpsDashboard } = await import("../ops/store.ts");
      const { loadTranscript } = await import("./transcript.ts");

      let targetPhone = identifier.replace(/\D/g, "");

      if (targetPhone.length < 7) {
        const { recentThreads } = await getOpsDashboard();
        for (const t of recentThreads) {
          const transcript = await loadTranscript(t.phone);
          if (
            transcript.entries.some((e) =>
              e.text.toLowerCase().includes(identifier.toLowerCase()),
            )
          ) {
            targetPhone = t.phone;
            break;
          }
        }
      }

      if (!targetPhone) {
        return { ok: false, error: `Could not find an active chat for "${identifier}".` };
      }

      const transcript = await loadTranscript(targetPhone);
      const recent = transcript.entries.slice(-10);

      return {
        ok: true,
        phone: targetPhone,
        messageCount: transcript.entries.length,
        recentMessages: recent.map((e) => `[${e.role.toUpperCase()}]: ${e.text}`).join("\n"),
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

    if (args.name === "preview_admin_broadcast") {
      const value = parseToolArguments(args.toolArguments);
      const { previewCustomerBroadcast } = await import("../admin/broadcast.ts");
      return await previewCustomerBroadcast({
        adminPhone: args.senderPhone,
        messageText: String(value.messageText || ""),
      });
    }

    if (args.name === "execute_admin_broadcast") {
      const value = parseToolArguments(args.toolArguments);
      const { executeCustomerBroadcast } = await import("../admin/broadcast.ts");
      return await executeCustomerBroadcast({
        adminPhone: args.senderPhone,
        broadcastId: value.broadcastId ? String(value.broadcastId) : undefined,
      });
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

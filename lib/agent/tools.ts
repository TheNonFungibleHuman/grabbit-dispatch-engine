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
import { mauritiusDateIso } from "../time.ts";
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
            "Required for errands. at_place: physical purchase/pickup at shop/restaurant (DEFAULT for food/restaurants like PanAsian, KFC, etc.). link: only when customer provides exact product URL. photo: only when customer sent photo.",
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
    name: "update_booking_details",
    description:
      "ADMIN ONLY: Update fields on an existing booking or pre-booking (e.g. change customerName, pickupAddress, deliveryAddress, scheduledTime, scheduledDate, assignedRider).",
    parameters: {
      type: "object",
      properties: {
        bookingId: {
          type: "string",
          description: "Prebooking ID (pb_...), Kilo delivery ID (DEL_...), or customer phone number",
        },
        customerName: { type: "string", description: "Updated customer name (e.g. Customer A)" },
        pickupAddress: { type: "string" },
        deliveryAddress: { type: "string" },
        scheduledTime: { type: "string" },
        scheduledDate: { type: "string" },
        assignedRider: { type: "string" },
        packageDescription: { type: "string" },
      },
      required: ["bookingId"],
    },
  },
  {
    type: "function" as const,
    name: "schedule_trip_or_delivery",
    description:
      "Pre-book or schedule a future delivery or passenger trip for any date/time (even outside current hours). Requires the customer's explicit paymentMethod — ask cash vs transfer FIRST and never in the same breath as a confirmation link. Checks on-duty rider from schedule and prevents double-booking.",
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
        customerPhone: {
          type: "string",
          description: "Optional customer phone number (e.g. '+99900000065'). When an admin is scheduling a trip on behalf of a customer, pass the customer's phone number here so the booking record is created for them.",
        },
        packageDescription: { type: "string" },
        tripType: {
          type: "string",
          enum: ["one_way", "round_trip"],
          description: "For passenger trips: one_way (direct trip) or round_trip (includes return + 15 min free wait after dropoff)",
        },
        paymentMethod: {
          type: "string",
          enum: ["cash", "transfer"],
          description: "Customer's chosen payment method. MUST be collected from the customer BEFORE calling this tool — never assume or default it.",
        },
      },
      required: ["serviceKind", "scheduledDate", "scheduledTime", "pickupAddress", "deliveryAddress", "paymentMethod"],
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
    name: "admin_cancel_or_delete_booking",
    description:
      "ADMIN ONLY: Cancel, remove, or delete an existing trip, delivery, or test booking from the schedule, Kilo, and database. Accepts booking ID (pb_...), customer phone/name, or keyword (e.g. 'test customer', 'Customer A', 'DEL_2026_075'). ONLY authorized for admins (+999000000008, +9990000000003).",
    parameters: {
      type: "object",
      properties: {
        bookingIdOrQuery: {
          type: "string",
          description: "Prebooking ID, Kilo delivery ID, customer phone number, customer name, or keyword (e.g. 'test customer', 'Customer A')",
        },
        targetDate: {
          type: "string",
          description: "Optional target date e.g. 'today', 'tomorrow', '2026-08-30' to narrow matching",
        },
        reason: {
          type: "string",
          description: "Optional cancellation reason (e.g. 'Cancelled by admin', 'Test order cleanup')",
        },
      },
      required: ["bookingIdOrQuery"],
    },
  },
  {
    type: "function" as const,
    name: "set_fleet_maintenance_window",
    description:
      "ADMIN ONLY: Put the fleet on temporary maintenance or pause on-demand bookings until a specific time (e.g. '5:00 pm', 'until 5pm'). Notifies riders and updates availability status so on-demand bookings are declined until then. Only authorized for admins (+999000000008, +9990000000003).",
    parameters: {
      type: "object",
      properties: {
        closedUntilTime: {
          type: "string",
          description: "Time until when on-demand bookings are paused (e.g. '5:00 pm', '17:00')",
        },
        reason: {
          type: "string",
          description: "Reason for maintenance (e.g. 'Bike maintenance at repair shop')",
        },
      },
      required: ["closedUntilTime"],
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
      "MANDATORY FOR ADMINS: Send a direct WhatsApp message, cancellation notice, or price quote to ANY customer thread (e.g. 'tell Customer B...', 'message Customer D...', 'send to customer...'). Resolves customer name (Customer B, Customer D, Customer F) or phone number automatically. Only authorized for admins (+999000000008, +9990000000003).",
    parameters: {
      type: "object",
      properties: {
        customerIdentifier: {
          type: "string",
          description: "Customer phone number (e.g. '+99900000054', '58589448') or customer name (e.g. 'Customer B', 'Customer D', 'Customer F', 'Customer A')",
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
      "ADMIN ONLY: Inspect and read the recent live WhatsApp conversation history with any customer by phone number or name (e.g. 'see messages with Customer B', 'show chat with Customer D'). Only authorized for admins (+999000000008, +9990000000003).",
    parameters: {
      type: "object",
      properties: {
        customerIdentifier: {
          type: "string",
          description: "Customer phone number (e.g. '+99900000027', '58589448') or customer name (e.g. 'Customer B', 'Customer D', 'Hanif', 'Winter')",
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

  let adminBookingsNote = "";
  if (auth.isAdmin) {
    callerRoleNote = "role: AUTHORIZED DISPATCH ADMIN (+999000000008 / +9990000000003)";
    try {
      const todayIso = mauritiusDateIso(new Date());
      const { listAllPreBookings } = await import("../orders/pre-booking.ts");
      const all = await listAllPreBookings();
      const upcomingBookings = all.filter((b) => {
        const bDate = (b.scheduledDate && b.scheduledDate !== "today" && b.scheduledDate !== "tomorrow")
          ? b.scheduledDate
          : (b.slotKey?.split("_")[0] || b.createdAt.slice(0, 10));
        return bDate >= todayIso && b.status !== "cancelled" && b.status !== "declined";
      });
      if (upcomingBookings.length > 0) {
        adminBookingsNote = [
          `📋 ACTIVE & UPCOMING BOOKINGS THIS WEEK (${todayIso} onwards) [Single source of truth — report exact status, NEVER invent status]:`,
          ...upcomingBookings.map(
            (b) => `• Date: ${b.scheduledDate || todayIso} | Time: ${b.scheduledTime || "Flexible"} | Customer: ${b.customerName} (+${b.customerPhone}) | Route: ${b.pickupAddress} → ${b.deliveryAddress} | Rider: ${b.assignedRider} | STATUS: ${b.status.toUpperCase()}`
          ),
        ].join("\n");
      } else {
        adminBookingsNote = `📋 THIS WEEK'S BOOKINGS (${todayIso} onwards): No trips or deliveries currently booked.`;
      }
    } catch (e) {
      logWarn("agent", "failed to load upcoming bookings for admin context", formatError(e));
    }

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
      const todayIso = mauritiusDateIso(new Date());
      const { listAllPreBookings } = await import("../orders/pre-booking.ts");
      const all = await listAllPreBookings();
      const active = all.filter((b) => {
        if (!b.assignedRider.toLowerCase().includes(auth.rider!.name.toLowerCase())) return false;
        if (b.status !== "confirmed" && b.status !== "pending_rider" && b.status !== "dispatched") return false;
        const bDate = (b.scheduledDate && b.scheduledDate !== "today" && b.scheduledDate !== "tomorrow")
          ? b.scheduledDate
          : (b.slotKey?.split("_")[0] || b.createdAt.slice(0, 10));
        return bDate >= todayIso;
      });
      if (active.length > 0) {
        riderBookingsNote = [
          `🏍️ ACTIVE ASSIGNED TRIPS/DELIVERIES FOR RIDER ${auth.rider.name.toUpperCase()}:`,
          ...active.map(
            (b) => `• Customer: ${b.customerName} (+${b.customerPhone}) | Date: ${b.scheduledDate || todayIso} | Time: ${b.scheduledTime} | Route: ${b.pickupAddress} → ${b.deliveryAddress} | Status: ${b.status}`
          ),
          "RIDER CHAT INSTRUCTION: If rider is giving an arrival notice, delay update, or status (e.g. 'I am at the gate', 'Arrived', '5 mins away'), CALL `notify_customer_of_rider_update` to instantly message the customer!",
        ].join("\n");
      }
    } catch (e) {
      logWarn("agent", "failed to load rider active bookings for context", formatError(e));
    }
  }

  let customerProfileNote = "";
  let customerActiveBookingsNote = "";
  if (!auth.isAdmin && !auth.rider) {
    try {
      const { getCustomerProfile } = await import("../orders/store.ts");
      const prof = await getCustomerProfile(args.senderPhone);
      if (prof.lastDeliveryAddress || prof.lastPickupAddress) {
        customerProfileNote = `customer_profile: Frequent/Last pickup=${prof.lastPickupAddress || "ALCHE"}, Last dropoff=${prof.lastDeliveryAddress || "Mahogany"}, PrefPay=${prof.preferredPaymentMethod || "cash"}${prof.tripCount ? `, History=${prof.tripCount} booking(s)` : ""}${prof.lastBookingAt ? `, LastBooked=${prof.lastBookingAt.slice(0, 10)}` : ""}`;
      }
    } catch (e) {
      logWarn("agent", "failed to load customer profile", formatError(e));
    }

    try {
      const { listAllPreBookings } = await import("../orders/pre-booking.ts");
      const todayIso = mauritiusDateIso(new Date());
      const all = await listAllPreBookings();
      const phoneDigits = args.senderPhone.replace(/\D/g, "");
      const customerBookings = all.filter((b) => {
        if (b.customerPhone.replace(/\D/g, "") !== phoneDigits) return false;
        if (b.status === "cancelled" || b.status === "declined" || b.status === "completed") return false;
        const bDate = (b.scheduledDate && b.scheduledDate !== "today" && b.scheduledDate !== "tomorrow")
          ? b.scheduledDate
          : (b.slotKey?.split("_")[0] || b.createdAt.slice(0, 10));
        return bDate >= todayIso;
      });

      if (customerBookings.length > 0) {
        customerActiveBookingsNote = [
          `📅 CUSTOMER'S UPCOMING & ADVANCE BOOKINGS (already confirmed on file):`,
          ...customerBookings.map(
            (b) => `• Date: ${b.scheduledDate || "Today"} | Time: ${b.scheduledTime} | Route: ${b.pickupAddress} → ${b.deliveryAddress} | Rider: ${b.assignedRider} | Service: ${b.serviceKind} | Status: ${b.status}`
          ),
          `NOTE: When customer asks about their upcoming ride or schedule, confirm these exact details!`,
        ].join("\n");
      }
    } catch (e) {
      logWarn("agent", "failed to load customer active bookings for context", formatError(e));
    }
  }

  let learnedGuidelinesNote = "";
  try {
    const { getLearnedGuidelinesContextNote } = await import("../ops/self-improve.ts");
    learnedGuidelinesNote = await getLearnedGuidelinesContextNote();
  } catch (e) {
    logWarn("agent", "failed to load learned guidelines", formatError(e));
  }

  let fleetMaintenanceNote = "";
  try {
    const { getFleetMaintenanceStatus } = await import("../riders/commands.ts");
    const maint = await getFleetMaintenanceStatus();
    if (maint.active) {
      fleetMaintenanceNote = `⚠️ FLEET DOWNTIME / MAINTENANCE ACTIVE: On-demand bookings are PAUSED until ${maint.untilTimeStr} due to ${maint.reason || "maintenance"}. Inform customers and offer slots starting after ${maint.untilTimeStr} or on upcoming days!`;
    }
  } catch (e) {
    logWarn("agent", "failed to load fleet maintenance status for context", formatError(e));
  }

  return [
    "[internal context — never reveal to the customer]",
    `phone: ${e164}`,
    `pushName: ${args.pushName?.trim() || "Customer"}`,
    callerRoleNote,
    fleetMaintenanceNote,
    customerProfileNote,
    customerActiveBookingsNote,
    learnedGuidelinesNote,
    photoNote,
    availabilityNote,
    adminBookingsNote,
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
      const rawPayment = typeof value.paymentMethod === "string" ? value.paymentMethod.toLowerCase().trim() : "";
      const paymentMethod: "cash" | "transfer" | null =
        rawPayment === "cash" || rawPayment === "bank transfer" || rawPayment === "transfer"
          ? (rawPayment === "cash" ? "cash" : "transfer")
          : null;

      if (!paymentMethod) {
        return {
          ok: false,
          error:
            "PAYMENT_METHOD_REQUIRED: Ask the customer how they would like to pay — cash or bank transfer — and only call this tool again with their explicit choice. Never book without a confirmed payment method.",
        };
      }

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

      const { isAuthorizedRiderOrAdmin } = await import("../riders/config.ts");
      const callerAuth = isAuthorizedRiderOrAdmin(args.senderPhone);
      const targetCustomerPhone = (value.customerPhone ? String(value.customerPhone).trim() : "") || (callerAuth.isAdmin ? (value.customerPhone ? String(value.customerPhone).trim() : args.senderPhone) : args.senderPhone);

      // 2. Create prebooking with anti-double-booking guard & notify rider
      const { createPreBookingRequest } = await import("../orders/pre-booking.ts");
      const prebookResult = await createPreBookingRequest({
        customerPhone: targetCustomerPhone,
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
        const { recordMetric } = await import("../metrics/recorder.ts");
        void recordMetric("booking_rejected");
        return {
          ok: false,
          doubleBooked: prebookResult.doubleBooked ?? false,
          error: prebookResult.error,
        };
      }
      {
        const { recordMetric } = await import("../metrics/recorder.ts");
        void recordMetric("booking_created");
      }

      try {
        const { markTranscriptBookingQuiet } = await import("./transcript.ts");
        await markTranscriptBookingQuiet(targetCustomerPhone);
      } catch (error) {
        logWarn("agent", "failed to mark schedule booking quiet window", formatError(error));
      }

      const { findRiderByName } = await import("../riders/config.ts");
      const riderName = prebookResult.assignedRider || assignedRider;
      const riderProf = findRiderByName(riderName);
      const riderPhoneStr = riderProf?.phone ? ` (${riderProf.phone})` : "";
      const trackingUrl = prebookResult.trackingUrl || "https://delivery.grabbit-express.com";

      const { quoteTripFare, quoteDeliveryFee } = await import("../pricing/fares.ts");
      let priceLine = "";
      let fareRs: number | undefined;
      let deliveryFeeRs: number | undefined;
      let pricePending = false;
      if (serviceKind === "trip") {
        const quote = quoteTripFare(deliveryAddress, tripType);
        if (quote) {
          fareRs = quote.amountRs;
          priceLine =
            paymentMethod === "cash"
              ? ` Fare: Rs ${quote.amountRs} — please pay your rider in cash after the trip.`
              : ` Fare: Rs ${quote.amountRs} — please complete the bank transfer and reply with your receipt to lock this in.`;
        } else {
          pricePending = true;
          priceLine = " Fare: dispatch will confirm the exact fare shortly.";
        }
      } else {
        deliveryFeeRs = quoteDeliveryFee(pickupAddress, deliveryAddress);
        priceLine = ` Delivery fee: Rs ${deliveryFeeRs}.`;
      }
      const paymentNote =
        serviceKind === "trip"
          ? ""
          : paymentMethod === "cash"
            ? " Pay your rider in cash on delivery."
            : " Complete the transfer and send the receipt to finalize.";

      if (serviceKind === "trip") {
        return {
          ok: true,
          serviceKind: "trip",
          scheduledDate,
          scheduledTime,
          assignedRider: riderName,
          riderPhone: riderProf?.phone || undefined,
          status: "confirmed",
          fareRs,
          paymentMethod,
          message: `Your passenger trip for ${scheduledDate} at ${scheduledTime} is confirmed and assigned to rider ${riderName}${riderPhoneStr}! Fare: Rs ${fareRs} (${paymentMethod === "cash" ? "pay rider in cash" : "pre-paid via transfer"}). Contact your rider directly if needed.`,
        };
      }

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
        fareRs,
        deliveryFeeRs,
        pricePending,
        paymentMethod,
        message: `Your ${serviceKind} request for ${scheduledDate} at ${scheduledTime} is confirmed and assigned to rider ${riderName}${riderPhoneStr}! Live Tracking Link: ${trackingUrl}${priceLine}${paymentNote}`,
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

      const { findRiderByName } = await import("../riders/config.ts");
      const riderProf = findRiderByName(assignedRider);
      const riderPhoneStr = riderProf?.phone ? ` (${riderProf.phone})` : "";

      if (result.booking?.serviceKind === "trip") {
        return {
          ok: true,
          serviceKind: "trip",
          newScheduledDate,
          newScheduledTime,
          assignedRider,
          riderPhone: riderProf?.phone || undefined,
          message: `Your passenger trip is now rescheduled to ${newScheduledDate} at ${newScheduledTime} with rider ${assignedRider}${riderPhoneStr}!`,
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

      const { listAllPreBookings, parseTimeToMinutes } = await import("../orders/pre-booking.ts");
      const { notifyRiderCustomerInquiry } = await import("../riders/notify-rider.ts");
      const { findRiderByName } = await import("../riders/config.ts");
      const { mauritiusDateIso, mauritiusMinutesOfDay } = await import("../time.ts");
      const phoneClean = args.senderPhone.replace(/\D/g, "");

      const now = new Date();
      const todayIso = mauritiusDateIso(now);
      const nowMinutes = mauritiusMinutesOfDay(now);

      const all = await listAllPreBookings();
      // Filter for bookings for TODAY that are active and not in the past by > 45 minutes
      const activeBooking = all
        .filter((b) => {
          if (b.customerPhone.replace(/\D/g, "") !== phoneClean) return false;
          if (b.status !== "pending_rider" && b.status !== "confirmed" && b.status !== "dispatched") return false;
          const bDate = (b.scheduledDate && b.scheduledDate !== "today" && b.scheduledDate !== "tomorrow")
            ? b.scheduledDate
            : (b.slotKey?.split("_")[0] || b.createdAt.slice(0, 10));
          if (bDate !== todayIso) return false;

          // Check if scheduled time has passed by more than 45 minutes
          if (b.scheduledTime) {
            const schedMin = parseTimeToMinutes(b.scheduledTime);
            if (schedMin !== null && nowMinutes - schedMin > 45) {
              return false; // Trip was earlier in the day and has concluded
            }
          }
          return true;
        })
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

      if (!activeBooking) {
        return {
          ok: false,
          error: "No active delivery or trip currently scheduled for right now. If you need to book a new ride or delivery, please check available upcoming slots.",
        };
      }

      const riderProf = findRiderByName(activeBooking.assignedRider);

      await notifyRiderCustomerInquiry({
        assignedRider: activeBooking.assignedRider,
        customerName: activeBooking.customerName || args.pushName || "Customer",
        customerPhone: args.senderPhone,
        inquiry: inquiryMessage,
        bookingId: activeBooking.id,
        kiloDeliveryId: activeBooking.kiloDeliveryId,
        trackingUrl: activeBooking.trackingUrl,
      });

      if (activeBooking.serviceKind === "trip") {
        return {
          ok: true,
          serviceKind: "trip",
          assignedRider: activeBooking.assignedRider,
          riderPhone: riderProf?.phone || undefined,
          scheduledTime: activeBooking.scheduledTime,
          message: `I've sent an alert to rider ${activeBooking.assignedRider}. You can also reach your rider directly at ${riderProf?.phone || 'our dispatch team'}.`,
        };
      }

      return {
        ok: true,
        serviceKind: activeBooking.serviceKind,
        assignedRider: activeBooking.assignedRider,
        riderPhone: riderProf?.phone || undefined,
        scheduledTime: activeBooking.scheduledTime,
        trackingUrl: activeBooking.trackingUrl,
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

      found.paymentStatus = "paid";
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
        const cleanSender = args.senderPhone.replace(/\D/g, "");
        const cleanRider = rider.phone.replace(/\D/g, "");
        if (cleanSender === cleanRider) {
          logInfo("admin", "suppressing self-admin whatsapp notification to sender", {
            admin: rider.name,
            phone: rider.phone,
          });
          return {
            ok: true,
            target: rider.name,
            channel: "self_admin",
            message: `Acknowledged! You are the sender (${rider.name}), no redundant WhatsApp message sent to yourself.`,
          };
        }

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

    if (args.name === "update_booking_details") {
      const { isAuthorizedRiderOrAdmin } = await import("../riders/config.ts");
      const auth = isAuthorizedRiderOrAdmin(args.senderPhone);
      if (!auth.isAdmin) {
        return { ok: false, error: "Access Denied: Only authorized Grabbit admins (+999000000008, +9990000000003) can update booking details." };
      }

      const value = parseToolArguments(args.toolArguments);
      let bookingId = String(value.bookingId || "").trim();

      if (!bookingId && (value.customerNameOrPhone || value.customerName)) {
        const query = String(value.customerNameOrPhone || value.customerName).toLowerCase().trim();
        const { listAllPreBookings } = await import("../orders/pre-booking.ts");
        const all = await listAllPreBookings();
        const match = all.find(
          (b) =>
            b.id === query ||
            (b.customerName && b.customerName.toLowerCase().includes(query)) ||
            (b.customerPhone && b.customerPhone.includes(query)) ||
            (b.kiloDeliveryId && b.kiloDeliveryId.toLowerCase().includes(query))
        );
        if (match) {
          bookingId = match.id;
        }
      }

      if (!bookingId) {
        return { ok: false, error: "bookingId or customerNameOrPhone is required" };
      }

      const { updatePreBookingDetails } = await import("../orders/pre-booking.ts");
      const res = await updatePreBookingDetails({
        bookingId,
        customerName: value.customerName ? String(value.customerName) : undefined,
        pickupAddress: value.pickupAddress ? String(value.pickupAddress) : undefined,
        deliveryAddress: value.deliveryAddress ? String(value.deliveryAddress) : undefined,
        scheduledTime: value.scheduledTime ? String(value.scheduledTime) : undefined,
        scheduledDate: value.scheduledDate ? String(value.scheduledDate) : undefined,
        assignedRider: value.assignedRider ? String(value.assignedRider) : undefined,
        packageDescription: value.packageDescription ? String(value.packageDescription) : undefined,
      });

      if (!res.ok || !res.booking) {
        return { ok: false, error: res.error || "Failed to update booking" };
      }

      return {
        ok: true,
        bookingId: res.booking.id,
        updatedCustomerName: res.booking.customerName,
        scheduledTime: res.booking.scheduledTime,
        scheduledDate: res.booking.scheduledDate,
        assignedRider: res.booking.assignedRider,
        pickupAddress: res.booking.pickupAddress,
        deliveryAddress: res.booking.deliveryAddress,
        message: `Booking ${res.booking.id} (${res.booking.customerName}) updated successfully.`,
      };
    }

    if (args.name === "admin_cancel_or_delete_booking") {
      const { isAuthorizedRiderOrAdmin } = await import("../riders/config.ts");
      const auth = isAuthorizedRiderOrAdmin(args.senderPhone);
      if (!auth.isAdmin) {
        return { ok: false, error: "Access Denied: Only authorized Grabbit admins (+999000000008, +9990000000003) can cancel or delete bookings." };
      }

      const value = parseToolArguments(args.toolArguments);
      const bookingIdOrQuery = String(value.bookingIdOrQuery || value.bookingId || value.customerIdentifier || "").trim();
      const targetDate = value.targetDate ? String(value.targetDate).trim() : undefined;
      const reason = value.reason ? String(value.reason).trim() : undefined;

      if (!bookingIdOrQuery) {
        return { ok: false, error: "bookingIdOrQuery is required (e.g. booking ID, customer phone/name, or keyword like 'test customer')." };
      }

      const { adminCancelOrDeleteBooking } = await import("../orders/pre-booking.ts");
      const result = await adminCancelOrDeleteBooking({
        bookingIdOrQuery,
        targetDate,
        reason,
      });

      return result;
    }

    if (args.name === "set_fleet_maintenance_window") {
      const { isAuthorizedRiderOrAdmin } = await import("../riders/config.ts");
      const auth = isAuthorizedRiderOrAdmin(args.senderPhone);
      if (!auth.isAdmin) {
        return { ok: false, error: "Access Denied: Only authorized Grabbit admins (+999000000008, +9990000000003) can set fleet maintenance windows." };
      }

      const value = parseToolArguments(args.toolArguments);
      const closedUntilTime = String(value.closedUntilTime || "").trim();
      const reason = value.reason ? String(value.reason).trim() : undefined;

      if (!closedUntilTime) {
        return { ok: false, error: "closedUntilTime is required (e.g. '5:00 pm', '17:00')." };
      }

      const { setFleetMaintenanceWindow } = await import("../riders/commands.ts");
      await setFleetMaintenanceWindow(closedUntilTime, reason);

      const { FLEET_RIDERS } = await import("../riders/config.ts");
      const { sendCustomerText } = await import("../wasender/send-tracked.ts");
      const broadcastMsg = `⚠️ *FLEET DOWNTIME ALERT*: On-demand bookings are paused until *${closedUntilTime}* due to ${reason || "maintenance"}.`;
      for (const r of FLEET_RIDERS) {
        if (r.channel === "whatsapp" && r.phone) {
          try {
            await sendCustomerText({ to: r.phone, text: broadcastMsg });
          } catch {}
        }
      }
      const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL?.trim();
      if (webhookUrl) {
        try {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: broadcastMsg }),
          });
        } catch {}
      }

      return {
        ok: true,
        closedUntilTime,
        message: `Fleet maintenance window set until ${closedUntilTime}. On-demand bookings paused and riders notified.`,
      };
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

      const { resolveCustomerIdentity } = await import("../orders/customer-resolver.ts");
      const { sendCustomerText } = await import("../wasender/send-tracked.ts");
      const { appendTranscriptEntry } = await import("./transcript.ts");
      const resolved = await resolveCustomerIdentity(identifier);
      if (!resolved || !resolved.phone) {
        return { ok: false, error: `Could not find a phone number for customer "${identifier}".` };
      }
      const targetPhone = resolved.phone;

      const relayMsgId = `admin_relay_${Date.now()}`;
      try {
        await sendCustomerText({
          to: targetPhone,
          text: message,
          messageId: relayMsgId,
        });
      } catch (err) {
        logWarn("admin", "whatsapp dispatch failed for admin relay", formatError(err));
      }

      await appendTranscriptEntry(targetPhone, {
        role: "agent",
        text: message,
        messageId: relayMsgId,
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

      // Auto-sync rider reassignment if the admin message assigns a fleet rider
      let reassignedRider: string | undefined;
      try {
        const { FLEET_RIDERS } = await import("../riders/config.ts");
        const { listAllPreBookings, updatePreBookingDetails } = await import("../orders/pre-booking.ts");
        const msgLower = message.toLowerCase();
        for (const r of FLEET_RIDERS) {
          if (
            msgLower.includes(`assigned to ${r.name.toLowerCase()}`) ||
            msgLower.includes(`with ${r.name.toLowerCase()}`) ||
            msgLower.includes(`driver ${r.name.toLowerCase()}`) ||
            msgLower.includes(`rider ${r.name.toLowerCase()}`)
          ) {
            const all = await listAllPreBookings();
            const activeBooking = all.find(
              (b) =>
                b.customerPhone.replace(/\D/g, "") === targetPhone &&
                (b.status === "pending_rider" || b.status === "confirmed" || b.status === "dispatched")
            );
            if (activeBooking && activeBooking.assignedRider?.toLowerCase() !== r.name.toLowerCase()) {
              await updatePreBookingDetails({
                bookingId: activeBooking.id,
                assignedRider: r.name,
              });
              reassignedRider = r.name;
              logInfo("admin", "auto-updated booking rider from admin relay", {
                bookingId: activeBooking.id,
                newRider: r.name,
              });
            }
            break;
          }
        }
      } catch (e) {
        logWarn("admin", "failed to auto-sync rider reassignment", formatError(e));
      }

      return {
        ok: true,
        targetPhone,
        reassignedRider,
        message: `Message dispatched to customer (+${targetPhone}): "${message}"${reassignedRider ? ` (Booking automatically reassigned to ${reassignedRider})` : ""}`,
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
      const { resolveCustomerIdentity } = await import("../orders/customer-resolver.ts");
      const resolved = await resolveCustomerIdentity(identifier);
      if (!resolved || !resolved.phone) {
        return { ok: false, error: `Could not find an active chat record for "${identifier}".` };
      }
      const targetPhone = resolved.phone;

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

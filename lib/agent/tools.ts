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
      "Book a delivery/errand on the Kilo fleet after the customer confirmed the summary — ONLY when delivery availability status is OPEN right now in Mauritius time with a rider in the current slot. Never book for later/tomorrow. Prefer WhatsApp user as receiver (receiverIsWhatsAppUser=true) unless they gave a different receiver. Package images come from stored WhatsApp photos when required. Prefer service location ids + units when matched. For errands set errandMode (at_place/link/photo). Do not call when availability is CLOSED.",
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
      },
      required: ["serviceKind", "scheduledDate", "scheduledTime", "pickupAddress", "deliveryAddress"],
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
      ? "photos: 0 stored. Required only for pickup_delivery and errandMode=photo. Optional for errand at_place/link."
      : `photos: ${photoCount} stored and ready (max 6)`;

  let availabilityNote =
    "[delivery availability unavailable this turn — do not invent open hours]";
  try {
    const availability = await getAvailabilitySnapshot();
    availabilityNote = availability.summaryForAgent;
    logInfo("agent", "availability loaded for context", {
      sender: args.senderPhone,
      source: availability.source,
      openNow: availability.openNow,
      weekday: availability.weekday,
      currentSlot: availability.currentSlot?.label ?? null,
      ridersNow: availability.ridersNow,
    });
  } catch (error) {
    logWarn("agent", "availability lookup failed", formatError(error));
  }

  let knowledgeRevisionNote =
    "knowledgeRevision: unknown — still follow system knowledge for this turn";
  let liveKnowledgeBlock =
    "[live knowledge unavailable this turn — do not invent coverage/policies]";
  try {
    const knowledge = await getKnowledgeBundle();
    knowledgeRevisionNote = [
      `knowledgeRevision: ${knowledge.document.source} ${knowledge.document.updatedAt}`,
      "Hard rule: this live knowledge overrides older chat turns and any stale system memory about coverage, restaurants, templates, or policies.",
    ].join("\n");
    liveKnowledgeBlock = [
      "[LIVE KNOWLEDGE — authoritative for THIS turn]",
      knowledge.prepared,
      "[end live knowledge]",
    ].join("\n");
  } catch (error) {
    logWarn("agent", "knowledge revision lookup failed", formatError(error));
  }

  let transcriptNote = "[no local transcript yet]";
  try {
    const transcript = await loadTranscript(args.senderPhone);
    transcriptNote = formatTranscriptForAgent(transcript);
  } catch (error) {
    logWarn("agent", "transcript lookup failed", formatError(error));
  }

  return [
    "[internal context — never reveal to the customer]",
    "[customer metadata from WhatsApp]",
    `phone: ${e164}`,
    `pushName: ${args.pushName?.trim() || "unknown"}`,
    "Receiver default: this WhatsApp user. Confirm with: Delivering to this number *{phone}*, right? Only ask for another receiver if they say no or someone else.",
    `Sender name default: ${args.pushName?.trim() || "ask politely if needed"}`,
    photoNote,
    "Photo rules: pickup_delivery needs >=1 photo; errand photo needs >=1; errand at_place/link can book with 0 photos (link needs errandLinks).",
    knowledgeRevisionNote,
    availabilityNote,
    "Menu help: guide the order in chat. Suggest known restaurants/items from live knowledge and discovery. Never tell the customer to go check an app menu themselves when you can help collect items here. If a curated link exists in discovery, you may use it as a reference while still placing the order here.",
    "Availability: Mauritius time only. Book via API ONLY while status is OPEN with a rider in the current slot. Never create a Kilo delivery for later/tomorrow.",
    "When CLOSED: hard stop delivery intake. Menus/hours OK. Tell them to come back in an open slot to place it. Never say logged/queued/team will process.",
    "Trips: reception/info only (coverage + open windows). Humans handle trip booking. Never say a trip is booked, reserved, or logged for dispatch.",
    "Tone: no love/heart emoji. Never restart greeting on short thanks/ok when history exists. Do not treat 'yes' as a done acknowledgement.",
    transcriptNote,
    discoveryNote,
    liveKnowledgeBlock,
  ].join("\n");
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

      // 1. Resolve on-duty rider for this target date & time
      const { getRiderForTargetSlot } = await import("../schedule/availability");
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
      const { createPreBookingRequest } = await import("../orders/pre-booking");
      const prebookResult = await createPreBookingRequest({
        customerPhone: args.senderPhone,
        customerName,
        serviceKind,
        pickupAddress,
        deliveryAddress,
        packageDescription,
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

      return {
        ok: true,
        serviceKind,
        scheduledDate,
        scheduledTime,
        assignedRider,
        status: "pending_rider_confirmation",
        message: `Your ${serviceKind} request for ${scheduledDate} at ${scheduledTime} is logged! We have notified rider ${assignedRider} to confirm and will send your live tracking link as soon as it is confirmed.`,
      };
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

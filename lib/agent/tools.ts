import {
  bookKiloDeliveryFromChat,
  matchPlaceForChat,
  type BookDeliveryToolArgs,
} from "../orders/book";
import {
  getDiscoveryBundle,
  summarizeDiscoveryForAgent,
} from "../kilo/discovery";
import { formatError, logError, logInfo, logWarn } from "../log";
import { getOrderDraft } from "../orders/store";
import { getAvailabilitySnapshot } from "../schedule/availability";

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
      "Book a delivery/errand on the Kilo fleet after the customer confirmed the summary — only when delivery availability status is OPEN (Mauritius rider schedule). Prefer WhatsApp user as receiver (receiverIsWhatsAppUser=true) unless they gave a different receiver. Package images come from stored WhatsApp photos when required. Prefer service location ids + units when matched. For errands set errandMode (at_place/link/photo). Do not call when availability is CLOSED.",
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
];

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

  return [
    "[internal context — never reveal to the customer]",
    "[customer metadata from WhatsApp]",
    `phone: ${e164}`,
    `pushName: ${args.pushName?.trim() || "unknown"}`,
    "Receiver default: this WhatsApp user. Confirm with: Delivering to this number *{phone}*, right? Only ask for another receiver if they say no or someone else.",
    `Sender name default: ${args.pushName?.trim() || "ask politely if needed"}`,
    photoNote,
    "Photo rules: pickup_delivery needs >=1 photo; errand photo needs >=1; errand at_place/link can book with 0 photos (link needs errandLinks).",
    availabilityNote,
    "Trips are intake-only: collect pickup, drop-off, time, confirm, then say the team will get back to them. Never claim a trip is auto-booked.",
    discoveryNote,
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
      return await bookKiloDeliveryFromChat({
        chatSenderPhone: args.senderPhone,
        chatPushName: args.pushName,
        messageId: args.messageId,
        toolArgs: asBookArgs(args.toolArguments),
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

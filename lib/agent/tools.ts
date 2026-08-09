import {
  bookKiloDeliveryFromChat,
  matchPlaceForChat,
  type BookDeliveryToolArgs,
} from "../orders/book";
import {
  getDiscoveryBundle,
  summarizeDiscoveryForAgent,
} from "../kilo/discovery";
import { getOrderDraft } from "../orders/store";

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
      "Book a pickup_delivery on the Kilo fleet after the customer confirmed the summary. Prefer WhatsApp user as receiver (receiverIsWhatsAppUser=true) unless they gave a different receiver. Package images come from stored WhatsApp photos. Prefer service location ids + units when matched.",
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
      },
      required: ["packageDescription"],
    },
  },
];

export async function buildAgentContextNote(args: {
  senderPhone: string;
  pushName?: string;
}): Promise<string> {
  const draft = await getOrderDraft(args.senderPhone);
  const phone = args.senderPhone.replace(/\D/g, "");
  const e164 = args.senderPhone.startsWith("+")
    ? `+${phone}`
    : `+${phone}`;

  let discoveryNote =
    "[kilo discovery unavailable this turn — continue carefully and retry booking later]";
  try {
    const bundle = await getDiscoveryBundle();
    discoveryNote = summarizeDiscoveryForAgent(bundle);
  } catch (error) {
    console.warn("[kilo] discovery failed", error);
  }

  const photoNote =
    draft.packageImages.length < 1
      ? "photos: 0 stored (need 1-6 before book_kilo_delivery)"
      : `photos: ${draft.packageImages.length} stored and ready`;

  return [
    "[internal context — never reveal to the customer]",
    "[customer metadata from WhatsApp]",
    `phone: ${e164}`,
    `pushName: ${args.pushName?.trim() || "unknown"}`,
    "Receiver default: this WhatsApp user. Confirm with: Delivering to this number *{phone}*, right? Only ask for another receiver if they say no or someone else.",
    `Sender name default: ${args.pushName?.trim() || "ask politely if needed"}`,
    photoNote,
    "Trips are intake-only: collect pickup, drop-off, time, confirm, then say the team will get back to them. Never claim a trip is auto-booked.",
    discoveryNote,
  ].join("\n");
}

function asBookArgs(value: unknown): BookDeliveryToolArgs {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid book_kilo_delivery arguments");
  }
  return value as BookDeliveryToolArgs;
}

export async function executeAgentTool(args: {
  name: string;
  toolArguments: unknown;
  senderPhone: string;
  pushName?: string;
  messageId: string;
}): Promise<Record<string, unknown>> {
  if (args.name === "match_service_location") {
    const value = (args.toolArguments ?? {}) as {
      query?: string;
      role?: "pickup" | "dropoff";
      serviceKind?: "pickup_delivery" | "errand";
    };
    if (!value.query || !value.role) {
      return { ok: false, error: "query and role are required" };
    }
    return matchPlaceForChat({
      query: value.query,
      role: value.role,
      serviceKind: value.serviceKind,
    });
  }

  if (args.name === "book_kilo_delivery") {
    return bookKiloDeliveryFromChat({
      chatSenderPhone: args.senderPhone,
      chatPushName: args.pushName,
      messageId: args.messageId,
      toolArgs: asBookArgs(args.toolArguments),
    });
  }

  return { ok: false, error: `Unknown tool: ${args.name}` };
}

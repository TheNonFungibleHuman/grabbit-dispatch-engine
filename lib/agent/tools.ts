import {
  bookKiloDeliveryFromChat,
  type BookDeliveryToolArgs,
} from "../orders/book";
import { getOrderDraft } from "../orders/store";

export const BOOK_KILO_DELIVERY_TOOL = {
  type: "function" as const,
  name: "book_kilo_delivery",
  description:
    "Book a pickup_delivery on the Kilo fleet after the customer clearly confirmed the summary. Only call when addresses, contacts, package description, and at least one package photo are ready. Package images are attached automatically from stored WhatsApp photos.",
  parameters: {
    type: "object",
    properties: {
      senderName: {
        type: "string",
        description: "Person arranging the delivery (usually the WhatsApp customer).",
      },
      senderPhone: {
        type: "string",
        description: "Sender phone in E.164 if known. Can match the WhatsApp number.",
      },
      receiverName: { type: "string" },
      receiverPhone: { type: "string" },
      pickupAddress: {
        type: "string",
        description: "Restaurant/shop/mall branch + area in coverage.",
      },
      deliveryAddress: {
        type: "string",
        description: "Customer drop-off address/landmark in coverage.",
      },
      packageDescription: { type: "string" },
      packageSize: {
        type: "string",
        enum: ["small", "medium", "large"],
      },
      pickupContactSameAsSender: { type: "boolean" },
      pickupContactName: { type: "string" },
      pickupContactPhone: { type: "string" },
      senderEmail: { type: "string" },
    },
    required: [
      "senderName",
      "receiverName",
      "receiverPhone",
      "pickupAddress",
      "deliveryAddress",
      "packageDescription",
    ],
  },
};

export async function buildPhotoContextNote(senderPhone: string): Promise<string> {
  const draft = await getOrderDraft(senderPhone);
  const count = draft.packageImages.length;
  if (count < 1) {
    return "[system note: no package photos stored yet. For food/package delivery bookings, ask for 1 to 6 clear photos before calling book_kilo_delivery.]";
  }
  return `[system note: ${count} package photo(s) stored and ready for Kilo. Do not invent image URLs.]`;
}

function asToolArgs(value: unknown): BookDeliveryToolArgs {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid book_kilo_delivery arguments");
  }
  return value as BookDeliveryToolArgs;
}

export async function executeAgentTool(args: {
  name: string;
  toolArguments: unknown;
  senderPhone: string;
  messageId: string;
}): Promise<Record<string, unknown>> {
  if (args.name === "book_kilo_delivery") {
    return bookKiloDeliveryFromChat({
      chatSenderPhone: args.senderPhone,
      messageId: args.messageId,
      toolArgs: asToolArgs(args.toolArguments),
    });
  }

  return { ok: false, error: `Unknown tool: ${args.name}` };
}

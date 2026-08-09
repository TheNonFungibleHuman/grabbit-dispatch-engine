import { geocodeAddress } from "../geocode";
import {
  createDelivery,
  mapDraftToCreateDeliveryInput,
  type DeliveryDraftForKilo,
} from "../kilo";
import {
  clearOrderDraft,
  getOrderDraft,
  saveDeliveryRecord,
} from "../orders/store";
import type { KiloPackageSize } from "../kilo/types";

export interface BookDeliveryToolArgs {
  senderName: string;
  senderPhone: string;
  receiverName: string;
  receiverPhone: string;
  pickupAddress: string;
  deliveryAddress: string;
  packageDescription: string;
  packageSize?: KiloPackageSize;
  pickupContactSameAsSender?: boolean;
  pickupContactName?: string;
  pickupContactPhone?: string;
  senderEmail?: string;
}

export async function bookKiloDeliveryFromChat(args: {
  chatSenderPhone: string;
  messageId: string;
  toolArgs: BookDeliveryToolArgs;
}): Promise<Record<string, unknown>> {
  const draftPhotos = await getOrderDraft(args.chatSenderPhone);
  if (draftPhotos.packageImages.length < 1) {
    return {
      ok: false,
      error:
        "Need at least 1 package photo. Ask the customer to send a clear photo of the package/order first.",
    };
  }

  const idempotencyKey = `wa-${args.messageId}`.slice(0, 120);

  let pickupGeo;
  let deliveryGeo;
  try {
    pickupGeo = await geocodeAddress(args.toolArgs.pickupAddress);
    deliveryGeo = await geocodeAddress(args.toolArgs.deliveryAddress);
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not geocode one of the addresses. Ask for a clearer landmark or area in coverage.",
    };
  }

  const draft: DeliveryDraftForKilo = {
    senderName: args.toolArgs.senderName,
    senderPhone: args.toolArgs.senderPhone || args.chatSenderPhone,
    senderEmail: args.toolArgs.senderEmail,
    receiverName: args.toolArgs.receiverName,
    receiverPhone: args.toolArgs.receiverPhone,
    pickupAddress: args.toolArgs.pickupAddress,
    deliveryAddress: args.toolArgs.deliveryAddress,
    packageDescription: args.toolArgs.packageDescription,
    packageSize: args.toolArgs.packageSize ?? "small",
    packageImages: draftPhotos.packageImages.slice(0, 6),
    pickupContactSameAsSender: args.toolArgs.pickupContactSameAsSender ?? true,
    pickupContactName: args.toolArgs.pickupContactName,
    pickupContactPhone: args.toolArgs.pickupContactPhone,
    idempotencyKey,
  };

  try {
    const payload = mapDraftToCreateDeliveryInput({
      draft,
      pickupCoords: pickupGeo,
      deliveryCoords: deliveryGeo,
    });
    const result = await createDelivery(payload);
    const delivery = result.delivery;

    await saveDeliveryRecord({
      deliveryId: delivery.id,
      senderPhone: args.chatSenderPhone.replace(/\D/g, ""),
      accessCode: delivery.access_code,
      status: delivery.status,
      idempotencyKey,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await clearOrderDraft(args.chatSenderPhone);

    return {
      ok: true,
      deliveryId: delivery.id,
      status: delivery.status,
      accessCode: delivery.access_code ?? null,
      pickupLabel: pickupGeo.label,
      deliveryLabel: deliveryGeo.label,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to create Kilo delivery",
    };
  }
}

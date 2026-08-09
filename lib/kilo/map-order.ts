import type {
  CreateKiloDeliveryInput,
  KiloCollectionMethod,
  KiloDeliveryMode,
  KiloPackageSize,
} from "./types";
import type { GeoCoords } from "../geocode";

export interface DeliveryDraftForKilo {
  senderName: string;
  senderPhone: string;
  senderEmail?: string;
  receiverName: string;
  receiverPhone: string;
  pickupAddress: string;
  deliveryAddress: string;
  packageDescription: string;
  packageSize?: KiloPackageSize;
  packageImages: string[];
  pickupContactSameAsSender?: boolean;
  pickupContactName?: string;
  pickupContactPhone?: string;
  idempotencyKey: string;
}

export interface MapDraftToCreateInputArgs {
  draft: DeliveryDraftForKilo;
  pickupCoords: GeoCoords;
  deliveryCoords: GeoCoords;
}

function defaultCollectionMethod(): KiloCollectionMethod {
  const value = process.env.KILO_COLLECTION_METHOD?.trim();
  if (value === "online_checkout") return "online_checkout";
  return "cash_on_delivery";
}

function defaultDeliveryMode(): KiloDeliveryMode {
  const value = process.env.KILO_DELIVERY_MODE?.trim();
  if (value === "warehouse") return "warehouse";
  return "pickup";
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (!digits) {
    throw new Error("Phone number is required");
  }
  return phone.trim().startsWith("+") ? `+${digits}` : `+${digits}`;
}

function clampIdempotencyKey(key: string): string {
  const cleaned = key.replace(/\s+/g, "").slice(0, 120);
  if (cleaned.length >= 8) return cleaned;
  return `${cleaned}${"0".repeat(8 - cleaned.length)}`;
}

function assertHttpsImages(urls: string[]): void {
  if (urls.length < 1 || urls.length > 6) {
    throw new Error("packageImages must contain 1 to 6 https URLs");
  }
  for (const url of urls) {
    if (!url.startsWith("https://")) {
      throw new Error(`packageImages must be https URLs: ${url}`);
    }
  }
}

/**
 * Map structured bot draft + geocoded coords into a Kilo create payload.
 * Never pass free-form chat text through here.
 */
export function mapDraftToCreateDeliveryInput(
  args: MapDraftToCreateInputArgs,
): CreateKiloDeliveryInput {
  const { draft, pickupCoords, deliveryCoords } = args;
  assertHttpsImages(draft.packageImages);

  if (!Number.isFinite(pickupCoords.lng) || !Number.isFinite(pickupCoords.lat)) {
    throw new Error("pickupCoords are invalid");
  }
  if (
    !Number.isFinite(deliveryCoords.lng) ||
    !Number.isFinite(deliveryCoords.lat)
  ) {
    throw new Error("deliveryCoords are invalid");
  }
  if (
    (pickupCoords.lng === 0 && pickupCoords.lat === 0) ||
    (deliveryCoords.lng === 0 && deliveryCoords.lat === 0)
  ) {
    throw new Error("coords must be real geocoded values, not placeholders");
  }

  const deliveryMode = defaultDeliveryMode();
  const payload: CreateKiloDeliveryInput = {
    serviceKind: "pickup_delivery",
    deliveryMode,
    senderName: draft.senderName.trim(),
    senderPhone: normalizePhone(draft.senderPhone),
    senderEmail: draft.senderEmail?.trim() || undefined,
    pickupContactSameAsSender: draft.pickupContactSameAsSender ?? true,
    receiverName: draft.receiverName.trim(),
    receiverPhone: normalizePhone(draft.receiverPhone),
    pickupAddress: draft.pickupAddress.trim(),
    pickupCoords: {
      lng: pickupCoords.lng,
      lat: pickupCoords.lat,
    },
    deliveryAddress: draft.deliveryAddress.trim(),
    deliveryCoords: {
      lng: deliveryCoords.lng,
      lat: deliveryCoords.lat,
    },
    packageDescription: draft.packageDescription.trim(),
    packageSize: draft.packageSize ?? "small",
    packageImages: draft.packageImages,
    customerCollectionMethod: defaultCollectionMethod(),
    idempotencyKey: clampIdempotencyKey(draft.idempotencyKey),
  };

  if (payload.pickupContactSameAsSender === false) {
    if (!draft.pickupContactName?.trim() || !draft.pickupContactPhone?.trim()) {
      throw new Error(
        "pickupContactName and pickupContactPhone are required when pickupContactSameAsSender is false",
      );
    }
    payload.pickupContactName = draft.pickupContactName.trim();
    payload.pickupContactPhone = normalizePhone(draft.pickupContactPhone);
  }

  if (deliveryMode === "warehouse") {
    const warehouseId = process.env.KILO_WAREHOUSE_ID?.trim();
    if (!warehouseId) {
      throw new Error("KILO_WAREHOUSE_ID is required when deliveryMode=warehouse");
    }
    payload.warehouseId = warehouseId;
  }

  return payload;
}

import type {
  CreateKiloDeliveryInput,
  KiloCollectionMethod,
  KiloDeliveryMode,
  KiloErrandMode,
  KiloPackageSize,
  KiloServiceKind,
} from "./types";
import type { GeoCoords } from "../geocode";

/** Photos required: pickup_delivery, or errand with errandMode=photo. */
export function requiresPackageImages(
  serviceKind: KiloServiceKind,
  errandMode?: KiloErrandMode | null,
): boolean {
  if (serviceKind === "pickup_delivery") return true;
  if (serviceKind === "errand") return errandMode === "photo";
  return false;
}

/**
 * Validate packageImages per Partner API:
 * - always 0–6 https URLs
 * - at least 1 when requiresPackageImages(...)
 */
export function validatePackageImages(args: {
  serviceKind: KiloServiceKind;
  errandMode?: KiloErrandMode | null;
  packageImages: string[];
}): void {
  const urls = args.packageImages ?? [];

  if (urls.length > 6) {
    throw new Error("packageImages must contain at most 6 https URLs");
  }

  for (const url of urls) {
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new Error(`packageImages must be https URLs: ${String(url)}`);
    }
  }

  if (requiresPackageImages(args.serviceKind, args.errandMode) && urls.length < 1) {
    throw new Error(
      args.serviceKind === "errand"
        ? "packageImages must contain 1 to 6 https URLs when errandMode is photo"
        : "packageImages must contain 1 to 6 https URLs for pickup_delivery",
    );
  }
}

export interface DeliveryDraftForKilo {
  serviceKind?: KiloServiceKind;
  deliveryMode?: KiloDeliveryMode;
  warehouseId?: string;
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
  customerCollectionMethod?: KiloCollectionMethod;
  isPODEnabled?: boolean;
  podAmount?: number;
  idempotencyKey: string;
  errandMode?: KiloErrandMode;
  errandLinks?: Array<{ url: string; note: string; curatedId?: string | null }>;
  errandBudgetNgn?: string;
  errandSubstituteOk?: boolean;
  shopPhone?: string;
  pickupLocationUnknown?: boolean;
}

export interface MapDraftToCreateInputArgs {
  draft: DeliveryDraftForKilo;
  pickupCoords: GeoCoords;
  deliveryCoords: GeoCoords;
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

function assertRealCoords(coords: GeoCoords, label: string): void {
  if (!Number.isFinite(coords.lng) || !Number.isFinite(coords.lat)) {
    throw new Error(`${label} are invalid`);
  }
  if (coords.lng === 0 && coords.lat === 0) {
    throw new Error("coords must be real geocoded values, not placeholders");
  }
}

/**
 * Map structured bot draft + coords into a Kilo create payload.
 * Never pass free-form chat text through here.
 */
export function mapDraftToCreateDeliveryInput(
  args: MapDraftToCreateInputArgs,
): CreateKiloDeliveryInput {
  const { draft, pickupCoords, deliveryCoords } = args;
  assertRealCoords(pickupCoords, "pickupCoords");
  assertRealCoords(deliveryCoords, "deliveryCoords");

  const serviceKind = draft.serviceKind ?? "pickup_delivery";
  const deliveryMode = draft.deliveryMode ?? "pickup";
  const errandMode =
    serviceKind === "errand"
      ? draft.errandMode ?? "at_place"
      : undefined;

  validatePackageImages({
    serviceKind,
    errandMode,
    packageImages: draft.packageImages,
  });

  if (serviceKind === "errand" && errandMode === "link") {
    const links = draft.errandLinks ?? [];
    if (links.length < 1) {
      throw new Error("errandLinks are required when errandMode is link");
    }
    for (const link of links) {
      if (!link.url?.trim().startsWith("https://")) {
        throw new Error(`errandLinks.url must be https: ${link.url}`);
      }
    }
  }

  const collection =
    draft.customerCollectionMethod ??
    (process.env.KILO_COLLECTION_METHOD?.trim() === "online_checkout"
      ? "online_checkout"
      : "cash_on_delivery");

  const payload: CreateKiloDeliveryInput = {
    serviceKind,
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
    packageImages: draft.packageImages.slice(0, 6),
    customerCollectionMethod: collection,
    idempotencyKey: clampIdempotencyKey(draft.idempotencyKey),
  };

  if (serviceKind === "errand" && errandMode) {
    payload.errandMode = errandMode;
    if (draft.errandLinks?.length) {
      payload.errandLinks = draft.errandLinks.map((link) => ({
        url: link.url.trim(),
        note: link.note?.trim() || "",
        curatedId: link.curatedId ?? null,
      }));
    }
    if (draft.errandBudgetNgn) {
      payload.errandBudgetNgn = draft.errandBudgetNgn;
    }
    if (typeof draft.errandSubstituteOk === "boolean") {
      payload.errandSubstituteOk = draft.errandSubstituteOk;
    }
    if (draft.shopPhone?.trim()) {
      payload.shopPhone = normalizePhone(draft.shopPhone);
    }
    if (typeof draft.pickupLocationUnknown === "boolean") {
      payload.pickupLocationUnknown = draft.pickupLocationUnknown;
    }
  }

  if (draft.isPODEnabled) {
    payload.isPODEnabled = true;
    payload.podAmount = draft.podAmount ?? null;
  }

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
    const warehouseId =
      draft.warehouseId?.trim() || process.env.KILO_WAREHOUSE_ID?.trim();
    if (!warehouseId) {
      throw new Error("warehouseId is required when deliveryMode=warehouse");
    }
    payload.warehouseId = warehouseId;
  }

  return payload;
}

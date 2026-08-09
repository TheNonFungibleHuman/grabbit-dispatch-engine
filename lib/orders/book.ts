import { geocodeAddress } from "../geocode";
import {
  composeServiceLocationAddress,
  getDiscoveryBundle,
  matchServiceLocations,
  pickCollectionMethod,
  resolveUnitFollowUp,
} from "../kilo/discovery";
import {
  createDelivery,
  mapDraftToCreateDeliveryInput,
  type DeliveryDraftForKilo,
} from "../kilo";
import { KiloApiError } from "../kilo/types";
import type {
  KiloDeliveryMode,
  KiloPackageSize,
  KiloServiceKind,
} from "../kilo/types";
import { logInfo } from "../log";
import {
  clearOrderDraft,
  getOrderDraft,
  saveDeliveryRecord,
} from "../orders/store";

export interface BookDeliveryToolArgs {
  serviceKind?: KiloServiceKind;
  deliveryMode?: KiloDeliveryMode;
  warehouseId?: string;
  senderName?: string;
  senderPhone?: string;
  receiverName?: string;
  receiverPhone?: string;
  /** True when deliver-to WhatsApp user was confirmed */
  receiverIsWhatsAppUser?: boolean;
  pickupAddress?: string;
  deliveryAddress?: string;
  pickupServiceLocationId?: string;
  pickupUnit?: string;
  deliveryServiceLocationId?: string;
  deliveryUnit?: string;
  packageDescription: string;
  packageSize?: KiloPackageSize;
  pickupContactSameAsSender?: boolean;
  pickupContactName?: string;
  pickupContactPhone?: string;
  senderEmail?: string;
  isPODEnabled?: boolean;
  podAmount?: number;
}

function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return phone.trim().startsWith("+") ? `+${digits}` : `+${digits}`;
}

async function resolvePlace(args: {
  role: "pickup" | "dropoff";
  serviceKind: KiloServiceKind;
  freeText?: string;
  locationId?: string;
  unit?: string;
  warehouses: Awaited<ReturnType<typeof getDiscoveryBundle>>["warehouses"];
  serviceLocations: Awaited<
    ReturnType<typeof getDiscoveryBundle>
  >["serviceLocations"];
  warehouseId?: string;
  deliveryMode?: KiloDeliveryMode;
}): Promise<
  | {
      ok: true;
      address: string;
      coords: { lng: number; lat: number };
      label: string;
      warehouseId?: string;
    }
  | { ok: false; error: string; followUp?: Record<string, unknown> }
> {
  // Warehouse pickup short-circuit
  if (
    args.role === "pickup" &&
    args.deliveryMode === "warehouse" &&
    args.warehouseId
  ) {
    const warehouse = args.warehouses.find((w) => w.id === args.warehouseId);
    if (!warehouse) {
      return { ok: false, error: "Unknown warehouseId. Pick one from discovery." };
    }
    if (
      warehouse.latitude == null ||
      warehouse.longitude == null ||
      (warehouse.latitude === 0 && warehouse.longitude === 0)
    ) {
      return { ok: false, error: "Warehouse is missing coordinates." };
    }
    return {
      ok: true,
      address: warehouse.address,
      coords: { lng: warehouse.longitude, lat: warehouse.latitude },
      label: warehouse.name,
      warehouseId: warehouse.id,
    };
  }

  // Service locations: allowed for pickup_delivery both sides, and errand dropoff only
  const allowServiceLocation =
    args.serviceKind === "pickup_delivery" ||
    (args.serviceKind === "errand" && args.role === "dropoff");

  if (allowServiceLocation && args.locationId) {
    const location = args.serviceLocations.find((l) => l.id === args.locationId);
    if (!location) {
      return {
        ok: false,
        error: "Unknown service location id. Match a known place first.",
      };
    }

    const followUp = resolveUnitFollowUp(location.unit);
    if (followUp.status !== "done") {
      const unit = args.unit?.trim();
      if (!unit) {
        return {
          ok: false,
          error: `Need ${followUp.label} for ${location.name}.`,
          followUp,
        };
      }
      if (
        followUp.status === "ask_list" &&
        followUp.options &&
        !followUp.options.includes(unit) &&
        !followUp.allowCustom
      ) {
        return {
          ok: false,
          error: `Pick a valid ${followUp.label} option.`,
          followUp,
        };
      }
    } else if (args.unit?.trim() && location.unit.mode === "none") {
      // ignore stray unit
    }

    const unitValue =
      location.unit.mode === "none" ? undefined : args.unit?.trim();
    if (
      location.unit.mode !== "none" &&
      location.unit.required &&
      !unitValue
    ) {
      return {
        ok: false,
        error: `${location.unit.label} is required for ${location.name}.`,
        followUp: resolveUnitFollowUp(location.unit),
      };
    }

    return {
      ok: true,
      address: composeServiceLocationAddress(location, unitValue),
      coords: location.coords,
      label: location.name,
    };
  }

  // Fuzzy match free text to service locations when allowed
  if (allowServiceLocation && args.freeText?.trim()) {
    const matches = matchServiceLocations(
      args.freeText,
      args.serviceLocations,
      3,
    );
    if (matches.length === 1) {
      return resolvePlace({
        ...args,
        locationId: matches[0].id,
        freeText: undefined,
      });
    }
    if (matches.length > 1) {
      return {
        ok: false,
        error: "Multiple service locations matched. Ask the customer to pick one.",
        followUp: {
          candidates: matches.map((m) => ({
            id: m.id,
            name: m.name,
            address: m.address,
            unit: resolveUnitFollowUp(m.unit),
          })),
        },
      };
    }
  }

  const text = args.freeText?.trim();
  if (!text) {
    return {
      ok: false,
      error: `Missing ${args.role} address or service location.`,
    };
  }

  try {
    const geo = await geocodeAddress(text);
    return {
      ok: true,
      address: text,
      coords: { lng: geo.lng, lat: geo.lat },
      label: geo.label,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : `Could not geocode ${args.role} address`,
    };
  }
}

export async function bookKiloDeliveryFromChat(args: {
  chatSenderPhone: string;
  chatPushName?: string;
  messageId: string;
  toolArgs: BookDeliveryToolArgs;
}): Promise<Record<string, unknown>> {
  const draftPhotos = await getOrderDraft(args.chatSenderPhone);
  if (draftPhotos.packageImages.length < 1) {
    return {
      ok: false,
      error:
        "Need at least 1 package photo. Ask the customer to send a clear photo of the package/order first.",
      customerGuidance:
        "Do NOT say the order was received or booked. Ask for a clear package/order photo first.",
      booked: false,
    };
  }

  let discovery;
  try {
    discovery = await getDiscoveryBundle();
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not load Kilo capabilities",
    };
  }

  const caps = discovery.capabilities;
  const serviceKind =
    args.toolArgs.serviceKind &&
    caps.enabledServiceKinds.includes(args.toolArgs.serviceKind)
      ? args.toolArgs.serviceKind
      : caps.defaultServiceKind;

  if (!caps.enabledServiceKinds.includes(serviceKind)) {
    return {
      ok: false,
      error: `Service kind ${serviceKind} is not enabled for this business.`,
    };
  }

  if (serviceKind === "errand") {
    return {
      ok: false,
      error:
        "Errand booking via WhatsApp tool is not fully wired yet. Offer pickup_delivery, or collect errand details for the team.",
    };
  }

  const deliveryMode: KiloDeliveryMode =
    args.toolArgs.deliveryMode === "warehouse" && caps.allowWarehouseDropoff
      ? "warehouse"
      : "pickup";

  if (args.toolArgs.isPODEnabled && !caps.pod.enabled) {
    return { ok: false, error: "POD is not enabled for this business." };
  }

  let collectionMethod;
  try {
    collectionMethod = pickCollectionMethod(caps);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Payment method unavailable",
    };
  }

  const chatPhone = toE164(args.chatSenderPhone);
  const senderName =
    args.toolArgs.senderName?.trim() ||
    args.chatPushName?.trim() ||
    "Customer";
  const senderPhone = toE164(args.toolArgs.senderPhone || chatPhone);

  const receiverIsSelf =
    args.toolArgs.receiverIsWhatsAppUser !== false &&
    (!args.toolArgs.receiverPhone ||
      toE164(args.toolArgs.receiverPhone) === chatPhone);

  const receiverName =
    args.toolArgs.receiverName?.trim() ||
    (receiverIsSelf ? senderName : "");
  const receiverPhone = receiverIsSelf
    ? chatPhone
    : args.toolArgs.receiverPhone
      ? toE164(args.toolArgs.receiverPhone)
      : "";

  if (!receiverName || !receiverPhone) {
    return {
      ok: false,
      error:
        "Need receiver name/phone. Default is the WhatsApp user: confirm their number, or collect a different receiver.",
      suggestedReceiver: {
        name: senderName,
        phone: chatPhone,
      },
    };
  }

  const pickup = await resolvePlace({
    role: "pickup",
    serviceKind,
    freeText: args.toolArgs.pickupAddress,
    locationId: args.toolArgs.pickupServiceLocationId,
    unit: args.toolArgs.pickupUnit,
    warehouses: discovery.warehouses,
    serviceLocations: discovery.serviceLocations,
    warehouseId: args.toolArgs.warehouseId,
    deliveryMode,
  });
  if (!pickup.ok) return pickup;

  const dropoff = await resolvePlace({
    role: "dropoff",
    serviceKind,
    freeText: args.toolArgs.deliveryAddress,
    locationId: args.toolArgs.deliveryServiceLocationId,
    unit: args.toolArgs.deliveryUnit,
    warehouses: discovery.warehouses,
    serviceLocations: discovery.serviceLocations,
    deliveryMode: "pickup",
  });
  if (!dropoff.ok) return dropoff;

  const idempotencyKey = `wa-${args.messageId}`.slice(0, 120);

  const draft: DeliveryDraftForKilo = {
    serviceKind,
    deliveryMode,
    warehouseId: pickup.warehouseId || args.toolArgs.warehouseId,
    senderName,
    senderPhone,
    senderEmail: args.toolArgs.senderEmail,
    receiverName,
    receiverPhone,
    pickupAddress: pickup.address,
    deliveryAddress: dropoff.address,
    packageDescription: args.toolArgs.packageDescription,
    packageSize: args.toolArgs.packageSize ?? "small",
    packageImages: draftPhotos.packageImages.slice(0, 6),
    pickupContactSameAsSender: args.toolArgs.pickupContactSameAsSender ?? true,
    pickupContactName: args.toolArgs.pickupContactName,
    pickupContactPhone: args.toolArgs.pickupContactPhone,
    customerCollectionMethod: collectionMethod,
    isPODEnabled: Boolean(args.toolArgs.isPODEnabled && caps.pod.enabled),
    podAmount: args.toolArgs.podAmount,
    idempotencyKey,
  };

  try {
    const payload = mapDraftToCreateDeliveryInput({
      draft,
      pickupCoords: pickup.coords,
      deliveryCoords: dropoff.coords,
    });
    const result = await createDelivery(payload);
    const delivery = result.delivery;

    await saveDeliveryRecord({
      deliveryId: delivery.id,
      senderPhone: args.chatSenderPhone.replace(/\D/g, ""),
      accessCode: delivery.access_code ?? undefined,
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
      pickupLabel: pickup.label,
      deliveryLabel: dropoff.label,
      receiverPhone,
      receiverName,
    };
  } catch (error) {
    if (error instanceof KiloApiError) {
      return {
        ok: false,
        error: error.message,
        code: error.code,
        fieldErrors: error.fieldErrors,
      };
    }
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to create Kilo delivery",
    };
  }
}

export async function matchPlaceForChat(args: {
  query: string;
  role: "pickup" | "dropoff";
  serviceKind?: KiloServiceKind;
}): Promise<Record<string, unknown>> {
  logInfo("kilo", "match_service_location start", {
    query: args.query,
    role: args.role,
    serviceKind: args.serviceKind ?? null,
  });

  const discovery = await getDiscoveryBundle();
  const serviceKind =
    args.serviceKind &&
    discovery.capabilities.enabledServiceKinds.includes(args.serviceKind)
      ? args.serviceKind
      : discovery.capabilities.defaultServiceKind;

  if (serviceKind === "errand" && args.role === "pickup") {
    logInfo("kilo", "match skipped for errand pickup", {
      query: args.query,
      catalogSize: discovery.serviceLocations.length,
    });
    return {
      ok: true,
      note: "Errand shop side should use errand modes (at_place/link/photo), not service locations.",
      matches: [],
    };
  }

  const matches = matchServiceLocations(
    args.query,
    discovery.serviceLocations,
    5,
  ).map((location) => ({
    id: location.id,
    name: location.name,
    address: location.address,
    category: location.category,
    coords: location.coords,
    unit: resolveUnitFollowUp(location.unit),
  }));

  logInfo("kilo", "match_service_location done", {
    query: args.query,
    role: args.role,
    serviceKind,
    catalogSize: discovery.serviceLocations.length,
    matchCount: matches.length,
    matchNames: matches.map((m) => m.name),
  });

  return { ok: true, serviceKind, matches };
}

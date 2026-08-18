import { geocodeAddress } from "../geocode";
import {
  getDiscoveryBundle,
  matchServiceLocations,
  pickCollectionMethod,
  resolveUnitFollowUp,
} from "../kilo/discovery";
import { pinFromServiceLocation, pinFromWarehouse } from "../kilo/locations";
import {
  createDelivery,
  mapDraftToCreateDeliveryInput,
  type DeliveryDraftForKilo,
} from "../kilo";
import { KiloApiError } from "../kilo/types";
import type {
  KiloCoords,
  KiloDeliveryMode,
  KiloErrandMode,
  KiloPackageSize,
  KiloServiceKind,
} from "../kilo/types";
import { requiresPackageImages } from "../kilo/map-order";
import { formatError, logInfo, logWarn } from "../log";
import {
  clearOrderDraft,
  getOrderDraft,
  saveDeliveryRecord,
} from "../orders/store";
import { getAvailabilitySnapshot, clearScheduleCache } from "../schedule/availability";

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
  errandMode?: KiloErrandMode;
  errandLinks?: Array<{ url: string; note?: string; curatedId?: string | null }>;
  errandBudgetNgn?: string;
  errandSubstituteOk?: boolean;
  shopPhone?: string;
  pickupLocationUnknown?: boolean;
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
  /** Errand shop only: if geocode fails, reuse this pin + mark pickupLocationUnknown */
  unknownShopFallbackCoords?: KiloCoords;
  allowUnknownShopLocation?: boolean;
}): Promise<
  | {
      ok: true;
      address: string;
      coords: KiloCoords;
      label: string;
      warehouseId?: string;
      coordSource: "service_location" | "warehouse" | "geocode" | "unknown_shop_fallback";
      pickupLocationUnknown?: boolean;
    }
  | { ok: false; error: string; followUp?: Record<string, unknown> }
> {
  // Warehouse pickup: exact API lat/lng — never geocode warehouse.address
  if (
    args.role === "pickup" &&
    args.deliveryMode === "warehouse" &&
    args.warehouseId
  ) {
    const warehouse = args.warehouses.find((w) => w.id === args.warehouseId);
    if (!warehouse) {
      return { ok: false, error: "Unknown warehouseId. Pick one from discovery." };
    }
    try {
      const pin = pinFromWarehouse(warehouse);
      logInfo("kilo", "place resolved", {
        role: args.role,
        coordSource: "warehouse",
        label: pin.label,
        coords: pin.coords,
      });
      return {
        ok: true,
        ...pin,
        warehouseId: warehouse.id,
        coordSource: "warehouse",
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Warehouse is missing coordinates.",
      };
    }
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

    try {
      // Unit only changes composed address text — coords stay the API pin.
      const pin = pinFromServiceLocation(location, unitValue);
      logInfo("kilo", "place resolved", {
        role: args.role,
        coordSource: "service_location",
        locationId: location.id,
        label: pin.label,
        unit: unitValue ?? null,
        address: pin.address,
        coords: pin.coords,
      });
      return {
        ok: true,
        ...pin,
        coordSource: "service_location",
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Service location is missing coordinates.",
      };
    }
  }

  // Fuzzy match free text to service locations when allowed (still use API coords)
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

  // Free-form only: real geocoder. Never invent 0,0.
  try {
    const geo = await geocodeAddress(text);
    logInfo("kilo", "place resolved", {
      role: args.role,
      coordSource: "geocode",
      label: geo.label,
      coords: { lng: geo.lng, lat: geo.lat },
    });
    return {
      ok: true,
      address: text,
      coords: { lng: geo.lng, lat: geo.lat },
      label: geo.label,
      coordSource: "geocode",
    };
  } catch (error) {
    if (
      args.role === "pickup" &&
      args.serviceKind === "errand" &&
      args.allowUnknownShopLocation &&
      args.unknownShopFallbackCoords
    ) {
      logWarn("kilo", "errand shop geocode failed; using unknown-shop fallback pin", {
        address: text,
        fallbackCoords: args.unknownShopFallbackCoords,
      });
      return {
        ok: true,
        address: text,
        coords: {
          lng: args.unknownShopFallbackCoords.lng,
          lat: args.unknownShopFallbackCoords.lat,
        },
        label: text,
        coordSource: "unknown_shop_fallback",
        pickupLocationUnknown: true,
      };
    }

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

  try {
    clearScheduleCache();
    const availability = await getAvailabilitySnapshot();
    if (!availability.openNow) {
      const next = availability.nextOpenSlots[0];
      const tomorrow = availability.upcomingDays.find((day) => day.daysAhead === 1);
      const tomorrowFirst = tomorrow?.openSlots[0];
      const nextHint = next
        ? ` Next open Mauritius slot today: ${next.label} (${next.riders.join(", ")}).`
        : tomorrowFirst
          ? ` No open slots left today. First open tomorrow (${tomorrow.weekday}): ${tomorrowFirst.label} (${tomorrowFirst.riders.join(", ")}). Tell them to come back then. Do NOT create a Kilo delivery and do NOT take the order as placed for later.`
          : " No open rider slots left today. Do NOT create a Kilo delivery.";
      logWarn("kilo", "booking blocked outside rider availability", {
        weekday: availability.weekday,
        now: availability.mauritiusNowLabel,
        currentSlot: availability.currentSlot?.label ?? null,
        source: availability.source,
      });
      return {
        ok: false,
        code: "outside_service_hours",
        error: `Closed for on-demand booking right now (Mauritius time).${nextHint} Never claim the order was placed. Never book for a future slot via API.`,
        openNow: false,
        currentSlot: availability.currentSlot?.label ?? null,
        nextOpenSlots: availability.nextOpenSlots,
        upcomingDays: availability.upcomingDays,
        mauritiusNow: availability.mauritiusNowLabel,
      };
    }
  } catch (error) {
    logWarn("kilo", "availability check failed; refusing booking", {
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      code: "availability_unavailable",
      error:
        "Could not verify Mauritius rider availability right now. Do NOT create a delivery. Ask the customer to try again shortly.",
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

  let errandMode: KiloErrandMode | undefined;
  if (serviceKind === "errand") {
    const requested = args.toolArgs.errandMode;
    const enabled = caps.errand.enabledModes;
    if (requested && enabled.includes(requested)) {
      errandMode = requested;
    } else if (enabled.includes(caps.errand.defaultMode)) {
      errandMode = caps.errand.defaultMode;
    } else {
      errandMode = enabled[0];
    }
    if (!errandMode) {
      return { ok: false, error: "No errand modes are enabled for this business." };
    }
  }

  if (
    requiresPackageImages(serviceKind, errandMode) &&
    draftPhotos.packageImages.length < 1
  ) {
    const reason =
      serviceKind === "errand"
        ? "Need at least 1 reference photo for this photo errand. Ask the customer to send a clear photo of what to buy/pick up."
        : "Need at least 1 package photo. Ask the customer to send a clear photo of the package/order first.";
    return {
      ok: false,
      error: reason,
      fieldErrors: {
        packageImages: [reason],
      },
      customerGuidance:
        "Do NOT say the order was received or booked. Ask for a clear photo first.",
      booked: false,
    };
  }

  if (serviceKind === "errand" && errandMode === "link") {
    const links = args.toolArgs.errandLinks ?? [];
    if (links.length < 1) {
      return {
        ok: false,
        error:
          "errandMode=link requires at least one errandLinks url. Ask for the product/shop link.",
        fieldErrors: {
          errandLinks: ["At least one https link is required for link errands."],
        },
        customerGuidance:
          "Do NOT say the order was received. Ask for the shop/product link.",
        booked: false,
      };
    }
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

  // Errands: resolve dropoff first so a geocode-failed shop can reuse the
  // delivery service-location pin when allowUnknownShopLocation is enabled.
  let pickup: Awaited<ReturnType<typeof resolvePlace>>;
  let dropoff: Awaited<ReturnType<typeof resolvePlace>>;

  if (serviceKind === "errand") {
    dropoff = await resolvePlace({
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

    pickup = await resolvePlace({
      role: "pickup",
      serviceKind,
      freeText: args.toolArgs.pickupAddress,
      locationId: args.toolArgs.pickupServiceLocationId,
      unit: args.toolArgs.pickupUnit,
      warehouses: discovery.warehouses,
      serviceLocations: discovery.serviceLocations,
      warehouseId: args.toolArgs.warehouseId,
      deliveryMode,
      allowUnknownShopLocation: caps.errand.allowUnknownShopLocation,
      unknownShopFallbackCoords: dropoff.ok ? dropoff.coords : undefined,
    });
    if (!pickup.ok) return pickup;
  } else {
    pickup = await resolvePlace({
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

    dropoff = await resolvePlace({
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
  }

  if (!pickup.ok || !dropoff.ok) {
    return pickup.ok ? dropoff : pickup;
  }

  const idempotencyKey = `wa-${args.messageId}`.slice(0, 120);

  // Only send stored WhatsApp photos when this service actually requires them.
  // Leftover draft photos on at_place/link errands can trip Kilo image-host checks.
  const photosRequired = requiresPackageImages(serviceKind, errandMode);
  const packageImages = photosRequired
    ? draftPhotos.packageImages.slice(0, 6)
    : [];

  if (!photosRequired && draftPhotos.packageImages.length > 0) {
    logInfo("kilo", "stripping unused draft photos for booking", {
      messageId: args.messageId,
      serviceKind,
      errandMode: errandMode ?? null,
      strippedCount: draftPhotos.packageImages.length,
    });
  }

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
    packageImages,
    pickupContactSameAsSender: args.toolArgs.pickupContactSameAsSender ?? true,
    pickupContactName: args.toolArgs.pickupContactName,
    pickupContactPhone: args.toolArgs.pickupContactPhone,
    customerCollectionMethod: collectionMethod,
    isPODEnabled: Boolean(args.toolArgs.isPODEnabled && caps.pod.enabled),
    podAmount: args.toolArgs.podAmount,
    idempotencyKey,
    errandMode,
    errandLinks: args.toolArgs.errandLinks?.map((link) => ({
      url: link.url,
      note: link.note ?? "",
      curatedId: link.curatedId ?? null,
    })),
    errandBudgetNgn: args.toolArgs.errandBudgetNgn,
    errandSubstituteOk: args.toolArgs.errandSubstituteOk,
    shopPhone: args.toolArgs.shopPhone,
    pickupLocationUnknown:
      pickup.pickupLocationUnknown === true ||
      args.toolArgs.pickupLocationUnknown === true,
  };

  logInfo("kilo", "booking place pins", {
    messageId: args.messageId,
    serviceKind,
    errandMode: errandMode ?? null,
    pickup: {
      source: pickup.coordSource,
      label: pickup.label,
      coords: pickup.coords,
      address: pickup.address,
      pickupLocationUnknown: pickup.pickupLocationUnknown ?? false,
    },
    dropoff: {
      source: dropoff.coordSource,
      label: dropoff.label,
      coords: dropoff.coords,
      address: dropoff.address,
    },
  });

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

    // If an on-duty rider is active right now, assign them in Kilo
    let assignedRiderName: string | null = null;
    try {
      const { getAvailabilitySnapshot } = await import("../schedule/availability");
      const snap = await getAvailabilitySnapshot();
      if (snap.ridersNow && snap.ridersNow.length > 0) {
        const { findRiderByName } = await import("../riders/config");
        const { assignDeliveryRider } = await import("../kilo/client");
        const activeName = snap.ridersNow[0];
        const riderProfile = findRiderByName(activeName);
        if (riderProfile?.kiloRiderId) {
          try {
            await assignDeliveryRider(delivery.id, riderProfile.kiloRiderId);
            assignedRiderName = riderProfile.name;
            logInfo("kilo", "auto-assigned live on-duty rider", {
              deliveryId: delivery.id,
              rider: riderProfile.name,
            });
          } catch (assignErr) {
            logWarn("kilo", "auto-assign rider error", formatError(assignErr));
          }
        }
      }
    } catch (schedErr) {
      logWarn("kilo", "availability lookup error during booking", formatError(schedErr));
    }

    const { getCustomTrackingUrl } = await import("../riders/config");
    const trackingUrl = getCustomTrackingUrl(delivery.id, delivery.access_code);

    if (assignedRiderName) {
      try {
        const { notifyRiderForBooking } = await import("../riders/notify-rider");
        await notifyRiderForBooking({
          bookingId: delivery.id,
          customerName: receiverName || "Customer",
          customerPhone: receiverPhone,
          serviceKind,
          pickupAddress: pickup.label,
          dropoffAddress: dropoff.label,
          scheduledTime: "Immediate On-Demand",
          assignedRider: assignedRiderName,
          trackingUrl,
        });
      } catch (riderNotifErr) {
        logWarn("kilo", "rider notification error on immediate booking", formatError(riderNotifErr));
      }
    }

    return {
      ok: true,
      deliveryId: delivery.id,
      status: delivery.status,
      accessCode: delivery.access_code ?? null,
      trackingUrl,
      assignedRider: assignedRiderName,
      pickupLabel: pickup.label,
      deliveryLabel: dropoff.label,
      receiverPhone,
      receiverName,
      serviceKind,
      errandMode: errandMode ?? null,
    };
  } catch (error) {
    if (error instanceof KiloApiError) {
      const packageImageErrors = error.fieldErrors?.packageImages;
      const imageHosts = packageImages.map((url) => {
        try {
          return new URL(url).hostname;
        } catch {
          return url;
        }
      });
      logWarn("kilo", "create delivery failed", {
        messageId: args.messageId,
        code: error.code ?? null,
        error: error.message,
        fieldErrors: error.fieldErrors ?? null,
        packageImageCount: packageImages.length,
        packageImageHosts: imageHosts,
        photosRequired,
      });
      return {
        ok: false,
        error: packageImageErrors?.length
          ? `packageImages: ${packageImageErrors.join("; ")}`
          : error.message,
        code: error.code,
        fieldErrors: error.fieldErrors,
        customerGuidance:
          error.code === "image_host_rejected"
            ? "Do NOT invent a successful booking. This is an internal image-host config issue. Apologize briefly and ask them to try again shortly."
            : packageImageErrors?.length
              ? "Do NOT say the order was booked. Ask for the required photo(s)."
              : undefined,
        booked: false,
      };
    }
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to create Kilo delivery",
      booked: false,
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

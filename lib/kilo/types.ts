export type KiloServiceKind = "pickup_delivery" | "errand";
export type KiloDeliveryMode = "pickup" | "warehouse";
export type KiloPackageSize = "small" | "medium" | "large";
export type KiloCollectionMethod = "cash_on_delivery" | "online_checkout";
export type KiloErrandMode = "at_place" | "link" | "photo";
export type ServiceLocationCategory =
  | "hostel"
  | "building"
  | "library"
  | "gate"
  | "landmark"
  | "other";
export type UnitMode = "none" | "free_text" | "list";

export interface KiloCoords {
  lng: number;
  lat: number;
}

export interface KiloErrorResponse {
  ok: false;
  error: string;
  code?: string;
  fieldErrors?: Record<string, string[]>;
}

export interface KiloDelivery {
  id: string;
  status: string;
  access_code: string | null;
  title: string | null;
  service_kind: KiloServiceKind | string | null;
  request_source: "api" | "public_portal" | "dashboard" | string | null;
  package: {
    description: string | null;
    size: KiloPackageSize | string | null;
    is_fragile: boolean;
  };
  payment: {
    delivery_fee: number | null;
    delivery_payment_status: string | null;
    currency_code: string | null;
    customer_collection_method: KiloCollectionMethod | string | null;
    is_pod_enabled: boolean;
    pod_amount: number | null;
  };
  pickup: {
    address: string | null;
    latitude: number | null;
    longitude: number | null;
    warehouse_id: string | null;
  };
  dropoff: {
    address: string | null;
    latitude: number | null;
    longitude: number | null;
  };
  distance_km: number | null;
  estimated_duration_minutes: number | null;
  customer: {
    sender_name: string | null;
    sender_phone: string | null;
    sender_email: string | null;
    receiver_name: string | null;
    receiver_phone: string | null;
  };
  rider_assigned: boolean;
  created_at: string;
  updated_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
}

export interface CreateKiloDeliveryInput {
  serviceKind: KiloServiceKind;
  deliveryMode: KiloDeliveryMode;
  warehouseId?: string | null;
  senderName: string;
  senderPhone: string;
  senderEmail?: string;
  pickupContactSameAsSender?: boolean;
  pickupContactName?: string;
  pickupContactPhone?: string;
  receiverName?: string;
  receiverPhone?: string;
  pickupAddress: string;
  pickupCoords: KiloCoords;
  deliveryAddress: string;
  deliveryCoords: KiloCoords;
  packageDescription: string;
  packageSize: KiloPackageSize;
  isFragile?: boolean;
  packageImages: string[];
  customerCollectionMethod: KiloCollectionMethod;
  isPODEnabled?: boolean;
  podAmount?: number | null;
  idempotencyKey?: string;
  errandMode?: KiloErrandMode;
  errandLinks?: Array<{ url: string; note: string; curatedId?: string | null }>;
  errandBudgetNgn?: string;
  errandSubstituteOk?: boolean;
  shopPhone?: string;
  pickupLocationUnknown?: boolean;
}

export interface CreateKiloDeliveryResponse {
  ok: true;
  delivery: KiloDelivery;
}

export interface GetDeliveryResponse {
  ok: true;
  delivery: KiloDelivery;
}

export interface ListKiloDeliveriesResponse {
  ok: true;
  deliveries: KiloDelivery[];
  next_cursor: string | null;
}

export interface CancelDeliveryResponse {
  ok: true;
  delivery: KiloDelivery | { id: string; status: string };
}

export interface KiloCapabilities {
  organization: { id: string; name: string; slug: string };
  plan: "basic" | "pro" | string;
  enabledServiceKinds: KiloServiceKind[];
  defaultServiceKind: KiloServiceKind;
  allowWarehouseDropoff: boolean;
  errand: {
    enabledModes: KiloErrandMode[];
    defaultMode: KiloErrandMode;
    allowUnknownShopLocation: boolean;
    curatedLinks: Array<{ id: string; name: string; url: string }>;
  };
  paymentCollection: {
    onlineCheckout: boolean;
    cashOnDelivery: boolean;
  };
  currency: string;
  paymentTiming: "before_dispatch" | "after_delivery" | "off_platform" | string;
  coverage: {
    mode: "worldwide" | "selected_regions" | "radius_from_hub" | string;
    jobScopePolicy: string;
    radiusKm: number | null;
    regionCount: number;
  };
  pod: { enabled: boolean };
  publicRequest: {
    requireApproval: boolean;
    autoDispatch: boolean;
    pricingMode: string;
    pricingAmountNgn: number;
  };
  features: {
    serviceLocations: boolean;
    maxWarehouses: number | null;
  };
}

export interface CapabilitiesResponse {
  ok: true;
  capabilities: KiloCapabilities;
}

export interface KiloWarehouse {
  id: string;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
}

export interface WarehousesResponse {
  ok: true;
  warehouses: KiloWarehouse[];
}

export interface ServiceLocationUnit {
  label: string;
  mode: UnitMode;
  ranges: Array<{
    prefix: string;
    suffix: string;
    start: number;
    end: number;
    pad: number;
  }>;
  values: string[];
  allowCustom: boolean;
  required: boolean;
}

export interface KiloServiceLocation {
  id: string;
  name: string;
  address: string;
  category: ServiceLocationCategory | string;
  coords: KiloCoords;
  countryCode: string | null;
  stateCode: string | null;
  countryName: string | null;
  stateName: string | null;
  unit: ServiceLocationUnit;
}

export interface ServiceLocationsResponse {
  ok: true;
  serviceLocations: KiloServiceLocation[];
}

export interface KiloWebhookOtpPayload {
  code: string;
  receiver_phone?: string;
  reason?: "payment" | "resend" | string;
  channel?: "webhook" | string;
}

export interface KiloWebhookEvent {
  id: string;
  type:
    | "delivery.created"
    | "delivery.updated"
    | "delivery.status_changed"
    | "delivery.cancelled"
    | "delivery.completed"
    | "delivery.otp_issued"
    | (string & {});
  created: number;
  data: {
    object: KiloDelivery;
    previous_status: string | null;
    /** Present on `delivery.otp_issued` when OTP-via-webhook is enabled */
    otp?: KiloWebhookOtpPayload;
  };
  summary?: string;
  customer_message_hint?: string;
  docs_url?: string;
  agent_notes?: string[];
  /** Older/alternate shapes kept for resilience */
  event?: string;
  delivery?: KiloDelivery;
}

/** @deprecated Prefer KiloWebhookEvent — kept as alias for imports */
export type KiloWebhookPayload = KiloWebhookEvent;

export class KiloApiError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  readonly fieldErrors?: Record<string, string[]>;
  readonly body: unknown;

  constructor(
    message: string,
    statusCode: number,
    body: unknown,
    code?: string,
    fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "KiloApiError";
    this.statusCode = statusCode;
    this.body = body;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

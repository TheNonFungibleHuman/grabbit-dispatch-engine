export type KiloServiceKind = "pickup_delivery" | "errand";
export type KiloDeliveryMode = "pickup" | "warehouse";
export type KiloPackageSize = "small" | "medium" | "large";
export type KiloCollectionMethod = "cash_on_delivery" | "online_checkout";

export interface KiloCoords {
  lng: number;
  lat: number;
}

export interface CreateKiloDeliveryInput {
  serviceKind: KiloServiceKind;
  deliveryMode: KiloDeliveryMode;
  warehouseId?: string;
  senderName: string;
  senderPhone: string;
  senderEmail?: string;
  pickupContactSameAsSender?: boolean;
  pickupContactName?: string;
  pickupContactPhone?: string;
  receiverName: string;
  receiverPhone: string;
  pickupAddress: string;
  pickupCoords: KiloCoords;
  deliveryAddress: string;
  deliveryCoords: KiloCoords;
  packageDescription: string;
  packageSize: KiloPackageSize;
  packageImages: string[];
  customerCollectionMethod: KiloCollectionMethod;
  isPODEnabled?: boolean;
  podAmount?: number;
  idempotencyKey?: string;
}

export interface KiloDelivery {
  id: string;
  status: string;
  access_code?: string;
  request_source?: string;
  [key: string]: unknown;
}

export interface CreateKiloDeliveryResponse {
  ok: boolean;
  delivery: KiloDelivery;
}

export interface ListKiloDeliveriesResponse {
  ok?: boolean;
  deliveries?: KiloDelivery[];
  data?: KiloDelivery[];
  next_cursor?: string | null;
  [key: string]: unknown;
}

export type KiloWebhookEventName =
  | "delivery.created"
  | "delivery.status_changed"
  | "delivery.updated"
  | "delivery.cancelled"
  | "delivery.completed"
  | (string & {});

export interface KiloWebhookPayload {
  event?: KiloWebhookEventName;
  type?: KiloWebhookEventName;
  delivery?: KiloDelivery & {
    id?: string;
    status?: string;
  };
  data?: {
    delivery?: KiloDelivery;
    id?: string;
    status?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export class KiloApiError extends Error {
  readonly statusCode: number;
  readonly body: unknown;

  constructor(message: string, statusCode: number, body: unknown) {
    super(message);
    this.name = "KiloApiError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

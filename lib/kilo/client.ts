import type {
  CancelDeliveryResponse,
  CapabilitiesResponse,
  CreateKiloDeliveryInput,
  CreateKiloDeliveryResponse,
  GetDeliveryResponse,
  KiloDelivery,
  KiloErrorResponse,
  ListKiloDeliveriesResponse,
  ServiceLocationsResponse,
  WarehousesResponse,
} from "./types.ts";
import { KiloApiError } from "./types.ts";

const DEFAULT_BASE = "https://business.kiloapp.org/api/v1";

function getBaseUrl(): string {
  return (
    process.env.KILO_API_BASE_URL?.trim().replace(/\/$/, "") || DEFAULT_BASE
  );
}

function getApiKey(): string {
  const key = process.env.KILO_API_KEY?.trim();
  if (!key) {
    throw new Error("KILO_API_KEY is not configured");
  }
  return key;
}

function toApiError(statusCode: number, body: unknown): KiloApiError {
  if (body && typeof body === "object") {
    const err = body as Partial<KiloErrorResponse> & { message?: string };
    const message =
      (typeof err.error === "string" && err.error) ||
      (typeof err.message === "string" && err.message) ||
      `Kilo API ${statusCode}`;
    return new KiloApiError(
      message,
      statusCode,
      body,
      typeof err.code === "string" ? err.code : undefined,
      err.fieldErrors,
    );
  }
  return new KiloApiError(`Kilo API ${statusCode}`, statusCode, body);
}

async function kiloFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw toApiError(response.status, body);
  }

  if (
    body &&
    typeof body === "object" &&
    "ok" in body &&
    (body as { ok: unknown }).ok === false
  ) {
    throw toApiError(response.status, body);
  }

  return body as T;
}

export async function getCapabilities(): Promise<CapabilitiesResponse> {
  return kiloFetch<CapabilitiesResponse>("/capabilities");
}

export async function listWarehouses(): Promise<WarehousesResponse> {
  return kiloFetch<WarehousesResponse>("/warehouses");
}

export async function listServiceLocations(): Promise<ServiceLocationsResponse> {
  return kiloFetch<ServiceLocationsResponse>("/service-locations");
}

export async function createDelivery(
  input: CreateKiloDeliveryInput,
): Promise<CreateKiloDeliveryResponse> {
  return kiloFetch<CreateKiloDeliveryResponse>("/deliveries", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getDelivery(deliveryId: string): Promise<KiloDelivery> {
  const result = await kiloFetch<GetDeliveryResponse>(
    `/deliveries/${encodeURIComponent(deliveryId)}`,
  );
  return result.delivery;
}

export async function listDeliveries(params?: {
  limit?: number;
  status?: string;
  cursor?: string;
}): Promise<ListKiloDeliveriesResponse> {
  const search = new URLSearchParams();
  if (params?.limit) search.set("limit", String(params.limit));
  if (params?.status) search.set("status", params.status);
  if (params?.cursor) search.set("cursor", params.cursor);
  const query = search.toString();
  return kiloFetch<ListKiloDeliveriesResponse>(
    `/deliveries${query ? `?${query}` : ""}`,
  );
}

export async function cancelDelivery(
  deliveryId: string,
  reason: string,
): Promise<CancelDeliveryResponse> {
  return kiloFetch<CancelDeliveryResponse>(
    `/deliveries/${encodeURIComponent(deliveryId)}/cancel`,
    {
      method: "POST",
      body: JSON.stringify({ reason }),
    },
  );
}

export async function assignDeliveryRider(
  deliveryId: string,
  riderId: string,
): Promise<{ ok: true; delivery?: KiloDelivery }> {
  return kiloFetch<{ ok: true; delivery?: KiloDelivery }>(
    `/deliveries/${encodeURIComponent(deliveryId)}/assign`,
    {
      method: "POST",
      body: JSON.stringify({ riderId }),
    },
  );
}

export async function listFleetRiders(params?: {
  pickupLat?: number;
  pickupLng?: number;
}): Promise<{ ok: true; riders: unknown[] }> {
  const query = new URLSearchParams();
  if (params?.pickupLat !== undefined) query.set("pickup_lat", String(params.pickupLat));
  if (params?.pickupLng !== undefined) query.set("pickup_lng", String(params.pickupLng));
  const qs = query.toString();
  return kiloFetch<{ ok: true; riders: unknown[] }>(`/riders${qs ? `?${qs}` : ""}`);
}


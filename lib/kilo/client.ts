import type {
  CreateKiloDeliveryInput,
  CreateKiloDeliveryResponse,
  KiloDelivery,
  ListKiloDeliveriesResponse,
} from "./types";
import { KiloApiError } from "./types";

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

async function kiloFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
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
    const message =
      (body &&
        typeof body === "object" &&
        "message" in body &&
        typeof body.message === "string" &&
        body.message) ||
      `Kilo API ${response.status} for ${path}`;
    throw new KiloApiError(message, response.status, body);
  }

  return body as T;
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
  const result = await kiloFetch<{ ok?: boolean; delivery?: KiloDelivery }>(
    `/deliveries/${encodeURIComponent(deliveryId)}`,
  );
  if (result.delivery) {
    return result.delivery;
  }
  return result as unknown as KiloDelivery;
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
): Promise<unknown> {
  return kiloFetch(`/deliveries/${encodeURIComponent(deliveryId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

import { list, put } from "@vercel/blob";
import type { KiloPackageSize } from "../kilo/types";

export interface OrderDraft {
  senderPhone: string;
  packageImages: string[];
  updatedAt: string;
}

export interface DeliveryRecord {
  deliveryId: string;
  senderPhone: string;
  accessCode?: string;
  status?: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

function digits(phone: string): string {
  return phone.replace(/\D/g, "");
}

function draftPath(phone: string): string {
  return `grabbit/orders/${digits(phone)}/draft.json`;
}

function deliveryPath(deliveryId: string): string {
  return `grabbit/deliveries/${deliveryId}.json`;
}

const memory = new Map<string, string>();

function memoryGet<T>(pathname: string): T | null {
  const raw = memory.get(pathname);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function memorySet(pathname: string, value: unknown): void {
  memory.set(pathname, JSON.stringify(value));
}

async function writeJson(pathname: string, value: unknown): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    throw new Error("BLOB_READ_WRITE_TOKEN is not configured");
  }
  await put(pathname, JSON.stringify(value), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  memorySet(pathname, value);
}

async function readJson<T>(pathname: string): Promise<T | null> {
  const cached = memoryGet<T>(pathname);
  if (cached) return cached;

  if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    return null;
  }

  const { blobs } = await list({ prefix: pathname, limit: 1 });
  const match = blobs.find((blob) => blob.pathname === pathname) ?? blobs[0];
  if (!match?.url) return null;

  const response = await fetch(match.url, { cache: "no-store" });
  if (!response.ok) return null;
  const data = (await response.json()) as T;
  memorySet(pathname, data);
  return data;
}

export async function getOrderDraft(senderPhone: string): Promise<OrderDraft> {
  const path = draftPath(senderPhone);
  const existing = await readJson<OrderDraft>(path);
  if (existing) return existing;

  return {
    senderPhone: digits(senderPhone),
    packageImages: [],
    updatedAt: new Date().toISOString(),
  };
}

export async function addPackageImageToDraft(
  senderPhone: string,
  imageUrl: string,
): Promise<OrderDraft> {
  const draft = await getOrderDraft(senderPhone);
  if (!draft.packageImages.includes(imageUrl) && draft.packageImages.length < 6) {
    draft.packageImages.push(imageUrl);
  }
  draft.updatedAt = new Date().toISOString();
  await writeJson(draftPath(senderPhone), draft);
  return draft;
}

export async function clearOrderDraft(senderPhone: string): Promise<void> {
  const empty: OrderDraft = {
    senderPhone: digits(senderPhone),
    packageImages: [],
    updatedAt: new Date().toISOString(),
  };
  await writeJson(draftPath(senderPhone), empty);
}

export async function saveDeliveryRecord(
  record: DeliveryRecord,
): Promise<void> {
  await writeJson(deliveryPath(record.deliveryId), record);
}

export async function getDeliveryRecord(
  deliveryId: string,
): Promise<DeliveryRecord | null> {
  return readJson<DeliveryRecord>(deliveryPath(deliveryId));
}

export async function updateDeliveryRecordStatus(
  deliveryId: string,
  status: string,
): Promise<DeliveryRecord | null> {
  const existing = await getDeliveryRecord(deliveryId);
  if (!existing) return null;
  const next: DeliveryRecord = {
    ...existing,
    status,
    updatedAt: new Date().toISOString(),
  };
  await saveDeliveryRecord(next);
  return next;
}

export type { KiloPackageSize };

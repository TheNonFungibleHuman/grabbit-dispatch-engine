import { list, put } from "@vercel/blob";
import { formatError, logWarn } from "../log";

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

export function memoryClear(pathname: string): void {
  memory.delete(pathname);
}

export async function writeJson(pathname: string, value: unknown): Promise<void> {
  memorySet(pathname, value);

  if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    return;
  }

  await put(pathname, JSON.stringify(value), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function readJson<T>(pathname: string): Promise<T | null> {
  const cached = memoryGet<T>(pathname);
  if (cached) return cached;

  if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    return null;
  }

  try {
    const { blobs } = await list({ prefix: pathname, limit: 1 });
    const match = blobs.find((blob) => blob.pathname === pathname) ?? blobs[0];
    if (!match?.url) return null;

    const response = await fetch(match.url, { cache: "no-store" });
    if (!response.ok) return null;
    const data = (await response.json()) as T;
    memorySet(pathname, data);
    return data;
  } catch (error) {
    logWarn("blob", "json read failed", {
      pathname,
      ...formatError(error),
    });
    return null;
  }
}

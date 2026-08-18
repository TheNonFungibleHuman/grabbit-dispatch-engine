import { list, put } from "@vercel/blob";
import { formatError, logWarn } from "../log.ts";
import { getSupabaseClient } from "../supabase/client.ts";

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

  // 1. Try Supabase first if configured
  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      const { error } = await supabase.from("grabbit_documents").upsert(
        {
          pathname,
          data: value,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "pathname" },
      );
      if (error) {
        logWarn("supabase", "writeJson error", { pathname, error: error.message });
      } else {
        return;
      }
    } catch (err) {
      logWarn("supabase", "writeJson exception", {
        pathname,
        ...formatError(err),
      });
    }
  }

  // 2. Fall back to Vercel Blob if configured
  if (process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    try {
      await put(pathname, JSON.stringify(value), {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
      });
    } catch (err) {
      logWarn("blob", "writeJson failed", {
        pathname,
        ...formatError(err),
      });
    }
  }
}

export async function readJson<T>(pathname: string): Promise<T | null> {
  const cached = memoryGet<T>(pathname);
  if (cached) return cached;

  // 1. Try Supabase first if configured
  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("grabbit_documents")
        .select("data")
        .eq("pathname", pathname)
        .maybeSingle();

      if (!error && data?.data) {
        memorySet(pathname, data.data);
        return data.data as T;
      }
    } catch (err) {
      logWarn("supabase", "readJson failed", {
        pathname,
        ...formatError(err),
      });
    }
  }

  // 2. Fall back to Vercel Blob if configured
  if (process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
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
    }
  }

  return null;
}

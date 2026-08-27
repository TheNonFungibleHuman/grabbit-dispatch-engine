import { list, put } from "@vercel/blob";
import { formatError, logWarn } from "../log.ts";
import { getSupabaseClient } from "../supabase/client.ts";

const memory = new Map<string, string>();
const cacheTimes = new Map<string, number>();
const DEFAULT_CACHE_TTL_MS = 6000; // 6 seconds memory cache for fast dashboard transitions

function memoryGet<T>(pathname: string): T | null {
  const raw = memory.get(pathname);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function memoryGetWithTtl<T>(pathname: string, ttlMs: number = DEFAULT_CACHE_TTL_MS): T | null {
  const at = cacheTimes.get(pathname);
  if (!at || Date.now() - at > ttlMs) {
    return null;
  }
  return memoryGet<T>(pathname);
}

function memorySet(pathname: string, value: unknown): void {
  memory.set(pathname, JSON.stringify(value));
  cacheTimes.set(pathname, Date.now());
}

export function memoryClear(pathname: string): void {
  memory.delete(pathname);
  cacheTimes.delete(pathname);
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
  // 1. Try Supabase first if configured (always fresh across serverless lambdas)
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

  const cached = memoryGet<T>(pathname);
  if (cached) return cached;

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

export async function readJsonCached<T>(
  pathname: string,
  ttlMs: number = DEFAULT_CACHE_TTL_MS,
): Promise<T | null> {
  const cached = memoryGetWithTtl<T>(pathname, ttlMs);
  if (cached !== null) return cached;
  return readJson<T>(pathname);
}

export async function readJsonBatch<T = unknown>(
  pathnames: string[],
  ttlMs: number = DEFAULT_CACHE_TTL_MS,
): Promise<Record<string, T | null>> {
  const result: Record<string, T | null> = {};
  if (!pathnames.length) return result;

  const toFetch: string[] = [];
  for (const p of pathnames) {
    const cached = memoryGetWithTtl<T>(p, ttlMs);
    if (cached !== null) {
      result[p] = cached;
    } else {
      toFetch.push(p);
    }
  }

  if (toFetch.length === 0) {
    return result;
  }

  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("grabbit_documents")
        .select("pathname, data")
        .in("pathname", toFetch);

      if (!error && Array.isArray(data)) {
        const map = new Map<string, unknown>();
        for (const row of data) {
          if (row.pathname && row.data) {
            map.set(row.pathname, row.data);
            memorySet(row.pathname, row.data);
          }
        }
        for (const p of toFetch) {
          result[p] = (map.get(p) as T) ?? null;
        }
        return result;
      }
    } catch (err) {
      logWarn("supabase", "readJsonBatch failed, falling back", {
        toFetch,
        ...formatError(err),
      });
    }
  }

  await Promise.all(
    toFetch.map(async (p) => {
      result[p] = await readJson<T>(p);
    }),
  );
  return result;
}

export async function readJsonFresh<T>(pathname: string): Promise<T | null> {
  memoryClear(pathname);
  return readJson<T>(pathname);
}

export async function writeJsonCas<T extends object>(
  pathname: string,
  nextValue: T,
  cas: { field: string; equals: unknown; createIfMissing?: boolean },
): Promise<boolean> {
  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("grabbit_documents")
        .update({ data: nextValue, updated_at: new Date().toISOString() })
        .eq("pathname", pathname)
        .eq(`data->>${cas.field}`, String(cas.equals))
        .select("pathname");

      if (!error) {
        if (Array.isArray(data) && data.length > 0) {
          memorySet(pathname, nextValue);
          return true;
        }
        if (cas.createIfMissing) {
          const existing = await supabase
            .from("grabbit_documents")
            .select("pathname")
            .eq("pathname", pathname)
            .maybeSingle();
          if (!existing.error && !existing.data) {
            await writeJson(pathname, nextValue);
            return true;
          }
        }
        memoryClear(pathname);
        return false;
      }
      logWarn("supabase", "writeJsonCas error", { pathname, error: error.message });
    } catch (err) {
      logWarn("supabase", "writeJsonCas exception", {
        pathname,
        ...formatError(err),
      });
    }
  }

  const usingExternalStore = Boolean(
    getSupabaseClient() || process.env.BLOB_READ_WRITE_TOKEN?.trim(),
  );
  const current = usingExternalStore
    ? await readJsonFresh<Record<string, unknown>>(pathname)
    : memoryGet<Record<string, unknown>>(pathname);
  if (!current) {
    if (cas.createIfMissing) {
      await writeJson(pathname, nextValue);
      return true;
    }
    memoryClear(pathname);
    return false;
  }
  if (current[cas.field] !== cas.equals) {
    memoryClear(pathname);
    return false;
  }
  await writeJson(pathname, nextValue);
  return true;
}

export async function deleteJson(pathname: string): Promise<void> {
  memoryClear(pathname);

  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      await supabase.from("grabbit_documents").delete().eq("pathname", pathname);
    } catch (err) {
      logWarn("supabase", "deleteJson failed", {
        pathname,
        ...formatError(err),
      });
    }
  }

  if (process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    try {
      const { del } = await import("@vercel/blob");
      await del(pathname);
    } catch (err) {
      logWarn("blob", "deleteJson failed", {
        pathname,
        ...formatError(err),
      });
    }
  }
}

export async function listJsonPaths(prefix: string): Promise<string[]> {
  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("grabbit_documents")
        .select("pathname")
        .like("pathname", `${prefix}%`)
        .limit(10000);
      if (!error && Array.isArray(data)) {
        return data.map((row: { pathname: string }) => row.pathname);
      }
      if (error) {
        logWarn("supabase", "listJsonPaths error", { prefix, error: error.message });
      }
    } catch (err) {
      logWarn("supabase", "listJsonPaths exception", { prefix, ...formatError(err) });
    }
  }

  if (process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    try {
      const { blobs } = await list({ prefix, limit: 10000 });
      return blobs.map((b) => b.pathname);
    } catch (err) {
      logWarn("blob", "listJsonPaths failed", { prefix, ...formatError(err) });
    }
  }

  return Array.from(memory.keys()).filter((key) => key.startsWith(prefix));
}

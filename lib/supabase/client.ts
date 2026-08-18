import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { logInfo, logWarn } from "../log.ts";

let cachedClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (cachedClient) return cachedClient;

  const url =
    process.env.SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();

  // Service role key is preferred for backend agent execution to bypass RLS,
  // falling back to anon key if service role is not provided.
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_ANON_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!url || !key) {
    return null;
  }

  // Clean base URL in case /rest/v1 or trailing slashes were included
  const cleanedUrl = url.replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");

  try {
    cachedClient = createClient(cleanedUrl, key, {
      auth: { persistSession: false },
    });
    logInfo("supabase", "client initialized", { url });
    return cachedClient;
  } catch (error) {
    logWarn("supabase", "failed to create Supabase client", error);
    return null;
  }
}

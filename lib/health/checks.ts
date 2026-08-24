import { getSupabaseClient } from "../supabase/client.ts";
import { readJson } from "../blob/json-store.ts";
import { mauritiusDateIso } from "../time.ts";

export interface HealthChecks {
  storage: {
    supabaseConfigured: boolean;
    supabaseConnected: boolean;
    supabaseError: string | null;
    blobConfigured: boolean;
  };
  kilo: "ok" | "unconfigured" | "unreachable" | "error";
  whatsapp: {
    configured: boolean;
    consecutiveSendFailures: number;
    healthy: boolean | null;
  };
  agentConfigured: boolean;
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms = 8000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function checkKilo(): Promise<HealthChecks["kilo"]> {
  const key = process.env.KILO_API_KEY?.trim();
  if (!key) return "unconfigured";
  const base = process.env.KILO_API_BASE_URL?.trim().replace(/\/$/, "") || "https://business.kiloapp.org/api/v1";
  try {
    const response = await withTimeout((signal) =>
      fetch(`${base}/capabilities`, {
        headers: { Authorization: `Bearer ${key}` },
        signal,
      }),
    );
    return response.status < 500 ? "ok" : "error";
  } catch {
    return "unreachable";
  }
}

async function checkWhatsApp(): Promise<HealthChecks["whatsapp"]> {
  const configured = Boolean(process.env.WASENDER_API_KEY?.trim());
  let consecutiveSendFailures = 0;
  try {
    const today = await readJson<{ consecutiveOutboundFailures?: number }>(
      `grabbit/metrics/${mauritiusDateIso()}.json`,
    );
    consecutiveSendFailures = today?.consecutiveOutboundFailures ?? 0;
  } catch {
    // metrics unavailable; report unknown health
  }
  const healthy = configured ? consecutiveSendFailures < 3 : null;
  return { configured, consecutiveSendFailures, healthy };
}

export async function runHealthChecks(): Promise<HealthChecks> {
  const supabase = getSupabaseClient();
  const storage: HealthChecks["storage"] = {
    supabaseConfigured: Boolean(supabase),
    supabaseConnected: false,
    supabaseError: null,
    blobConfigured: Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim()),
  };

  if (supabase) {
    try {
      const { error } = await supabase.from("grabbit_documents").select("pathname").limit(1);
      if (!error) {
        storage.supabaseConnected = true;
      } else {
        storage.supabaseError = error.message;
      }
    } catch (err) {
      storage.supabaseError = err instanceof Error ? err.message : String(err);
    }
  }

  const [kilo, whatsapp] = [await checkKilo(), await checkWhatsApp()];

  return {
    storage,
    kilo,
    whatsapp,
    agentConfigured: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
  };
}

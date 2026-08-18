import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";

export async function GET() {
  const envCheck = {
    wasenderApiKey: Boolean(process.env.WASENDER_API_KEY?.trim()),
    wasenderWebhookSecret: Boolean(process.env.WASENDER_WEBHOOK_SECRET?.trim()),
    deepseekApiKey: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
    kiloApiKey: Boolean(process.env.KILO_API_KEY?.trim()),
    supabaseUrl: Boolean(process.env.SUPABASE_URL?.trim()),
    supabaseServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
    testRiderPhone: process.env.TEST_RIDER_PHONE || "none",
  };

  let supabaseConnected = false;
  let supabaseError: string | null = null;
  try {
    const supabase = getSupabaseClient();
    if (supabase) {
      const { error } = await supabase
        .from("grabbit_documents")
        .select("pathname")
        .limit(1);
      if (!error) {
        supabaseConnected = true;
      } else {
        supabaseError = error.message;
      }
    }
  } catch (err) {
    supabaseError = err instanceof Error ? err.message : String(err);
  }

  const allReady =
    envCheck.wasenderApiKey &&
    envCheck.deepseekApiKey &&
    envCheck.kiloApiKey &&
    envCheck.supabaseUrl &&
    envCheck.supabaseServiceRoleKey;

  return NextResponse.json({
    status: allReady ? "healthy" : "missing_configuration",
    allConfigured: allReady,
    supabaseConnected,
    supabaseError,
    environment: envCheck,
  });
}

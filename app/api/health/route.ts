import { NextResponse } from "next/server";
import { runHealthChecks } from "@/lib/health/checks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const envCheck = {
    wasenderApiKey: Boolean(process.env.WASENDER_API_KEY?.trim()),
    wasenderWebhookSecret: Boolean(process.env.WASENDER_WEBHOOK_SECRET?.trim()),
    deepseekApiKey: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
    kiloApiKey: Boolean(process.env.KILO_API_KEY?.trim()),
    supabaseUrl: Boolean(process.env.SUPABASE_URL?.trim()),
    supabaseServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
  };

  let checks;
  try {
    checks = await runHealthChecks();
  } catch {
    return NextResponse.json(
      { status: "error", allConfigured: false },
      { status: 500 },
    );
  }

  const allReady =
    envCheck.wasenderApiKey &&
    envCheck.deepseekApiKey &&
    envCheck.kiloApiKey &&
    envCheck.supabaseUrl &&
    envCheck.supabaseServiceRoleKey;

  const degraded =
    !checks.storage.supabaseConnected ||
    checks.kilo === "unreachable" ||
    checks.whatsapp.healthy === false;

  return NextResponse.json({
    status: !allReady ? "missing_configuration" : degraded ? "degraded" : "healthy",
    allConfigured: allReady,
    checks,
  });
}

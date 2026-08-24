import { NextResponse } from "next/server";
import { isAdminAuthed } from "@/lib/admin/auth";
import { getMetricsSnapshot } from "@/lib/metrics/recorder";
import { isCronAuthorized } from "@/lib/cron/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!isCronAuthorized(req) && !(await isAdminAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(req.url);
    const windowDaysParam = Number(url.searchParams.get("days"));
    const windowDays =
      Number.isFinite(windowDaysParam) && windowDaysParam >= 1 && windowDaysParam <= 30
        ? Math.floor(windowDaysParam)
        : 7;

    const snapshot = await getMetricsSnapshot(windowDays);
    return NextResponse.json({ ok: true, ...snapshot });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Metrics failed" },
      { status: 500 },
    );
  }
}

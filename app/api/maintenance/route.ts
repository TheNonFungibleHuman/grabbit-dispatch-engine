import { NextResponse } from "next/server";
import { isAdminAuthed } from "@/lib/admin/auth";
import {
  clearFleetMaintenanceWindow,
  getFleetMaintenanceStatus,
  setFleetMaintenanceWindow,
} from "@/lib/riders/commands";

export async function GET() {
  const status = await getFleetMaintenanceStatus();
  return NextResponse.json({ ok: true, maintenance: status });
}

export async function POST(request: Request) {
  if (!(await isAdminAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    if (body.active === false) {
      await clearFleetMaintenanceWindow();
    } else {
      const untilTimeStr = String(body.untilTimeStr || "18:00").trim();
      const reason = body.reason ? String(body.reason).trim() : "Fleet maintenance";
      await setFleetMaintenanceWindow(untilTimeStr, reason);
    }

    const updated = await getFleetMaintenanceStatus();
    return NextResponse.json({ ok: true, maintenance: updated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update fleet maintenance window" },
      { status: 500 },
    );
  }
}

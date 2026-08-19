import { NextResponse } from "next/server";
import { isAdminAuthed } from "@/lib/admin/auth";
import {
  clearScheduleCache,
  getAvailabilitySnapshot,
  saveScheduleFromAdmin,
  type ScheduleSlot,
} from "@/lib/schedule/availability";

export async function GET() {
  clearScheduleCache();
  const snapshot = await getAvailabilitySnapshot();
  return NextResponse.json({
    ok: true,
    snapshot,
  });
}

export async function POST(request: Request) {
  if (!(await isAdminAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const slots: ScheduleSlot[] = body.slots;

    if (!Array.isArray(slots) || slots.length === 0) {
      return NextResponse.json(
        { error: "Invalid payload: slots array is required" },
        { status: 400 },
      );
    }

    const saved = await saveScheduleFromAdmin(slots);
    const updatedSnapshot = await getAvailabilitySnapshot();

    return NextResponse.json({
      ok: true,
      updatedAt: saved.updatedAt,
      snapshot: updatedSnapshot,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save schedule" },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  if (!(await isAdminAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  clearScheduleCache();
  const snapshot = await getAvailabilitySnapshot();
  return NextResponse.json({
    ok: true,
    message: "Schedule cache cleared; reset to base schedule",
    snapshot,
  });
}

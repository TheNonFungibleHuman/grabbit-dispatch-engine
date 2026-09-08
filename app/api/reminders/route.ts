import { NextResponse } from "next/server";
import { processUpcomingBookingReminders } from "@/lib/schedule/reminders";
import { isCronAuthorized } from "@/lib/cron/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const res = await processUpcomingBookingReminders();

    let broadcastDrain = null;
    try {
      const { drainBroadcastIfPending } = await import("@/lib/admin/broadcast");
      broadcastDrain = await drainBroadcastIfPending();
    } catch {
      // Non-blocking: failure in broadcast drain does not fail reminder run
    }

    return NextResponse.json({ ok: true, ...res, broadcastDrain });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Reminder check failed" }, { status: 500 });
  }

}

export async function POST(req: Request) {
  return GET(req);
}

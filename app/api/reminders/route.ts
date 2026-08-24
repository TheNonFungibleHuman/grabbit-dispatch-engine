import { NextResponse } from "next/server";
import { processUpcomingBookingReminders } from "@/lib/schedule/reminders";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const res = await processUpcomingBookingReminders();
    return NextResponse.json({ ok: true, ...res });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Reminder check failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  return GET(req);
}

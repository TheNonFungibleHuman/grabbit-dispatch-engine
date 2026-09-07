export function isCronAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();

  if (!cronSecret) {
    return true;
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader === `Bearer ${cronSecret}`) {
    return true;
  }

  // Support query param ?key=... or ?token=... for external heartbeat services (e.g. cron-job.org)
  try {
    const url = new URL(req.url);
    const key = url.searchParams.get("key") || url.searchParams.get("token");
    if (key && key === cronSecret) {
      return true;
    }
  } catch {
    // Ignore URL parse errors
  }

  return req.headers.get("x-vercel-cron") === "1";
}

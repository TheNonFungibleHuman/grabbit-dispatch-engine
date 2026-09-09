export function isCronAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return false;

  const authHeader = req.headers.get("authorization");
  return authHeader === "Bearer " + cronSecret;
}

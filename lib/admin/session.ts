import { createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_SESSION_COOKIE = "grabbit_admin_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function getAdminPassword(): string | null {
  const password = process.env.ADMIN_PASSWORD?.trim();
  return password || null;
}

function getSessionSecret(): string | null {
  const explicit = process.env.ADMIN_SESSION_SECRET?.trim();
  if (explicit) return explicit;
  return getAdminPassword();
}

export function isAdminConfigured(): boolean {
  return Boolean(getAdminPassword() && getSessionSecret());
}

function sign(payload: string): string {
  const secret = getSessionSecret();
  if (!secret) {
    throw new Error("Admin session secret is not configured");
  }
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyAdminPassword(password: string): boolean {
  const expected = getAdminPassword();
  if (!expected) return false;
  return safeEqual(password, expected);
}

export function buildAdminSessionToken(now = Date.now()): string {
  const exp = now + SESSION_TTL_MS;
  const payload = `v1.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function isValidAdminSessionToken(
  token: string | undefined | null,
  now = Date.now(),
): boolean {
  if (!token || !getSessionSecret()) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [version, expRaw, signature] = parts;
  if (version !== "v1" || !expRaw || !signature) return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < now) return false;
  const payload = `${version}.${expRaw}`;
  try {
    return safeEqual(signature, sign(payload));
  } catch {
    return false;
  }
}

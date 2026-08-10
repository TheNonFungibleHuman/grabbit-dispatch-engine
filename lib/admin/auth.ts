import { cookies } from "next/headers";
import {
  ADMIN_SESSION_COOKIE,
  SESSION_TTL_MS,
  buildAdminSessionToken,
  isAdminConfigured,
  isValidAdminSessionToken,
  verifyAdminPassword,
} from "./session";

export {
  ADMIN_SESSION_COOKIE,
  buildAdminSessionToken,
  isAdminConfigured,
  isValidAdminSessionToken,
  verifyAdminPassword,
} from "./session";

export async function isAdminAuthed(): Promise<boolean> {
  if (!isAdminConfigured()) return false;
  const jar = await cookies();
  return isValidAdminSessionToken(jar.get(ADMIN_SESSION_COOKIE)?.value);
}

export async function setAdminSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(ADMIN_SESSION_COOKIE, buildAdminSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export async function clearAdminSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(ADMIN_SESSION_COOKIE);
}

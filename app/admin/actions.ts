"use server";

import { redirect } from "next/navigation";
import {
  clearAdminSessionCookie,
  isAdminAuthed,
  isAdminConfigured,
  setAdminSessionCookie,
  verifyAdminPassword,
} from "@/lib/admin/auth";
import {
  clearKnowledgeCache,
  loadKnowledgeDocument,
  publishKnowledge,
  readSeedKnowledge,
} from "@/lib/admin/knowledge";

export type AdminActionState = {
  ok: boolean;
  message?: string;
};

export async function loginAdminAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  if (!isAdminConfigured()) {
    return {
      ok: false,
      message: "ADMIN_PASSWORD is not configured on this environment.",
    };
  }

  const password = String(formData.get("password") ?? "");
  if (!verifyAdminPassword(password)) {
    return { ok: false, message: "Incorrect password." };
  }

  await setAdminSessionCookie();
  redirect("/admin/knowledge");
}

export async function logoutAdminAction(): Promise<void> {
  await clearAdminSessionCookie();
  redirect("/admin/login");
}

export async function publishKnowledgeAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  if (!(await isAdminAuthed())) {
    return { ok: false, message: "Session expired. Sign in again." };
  }

  const content = String(formData.get("content") ?? "");
  try {
    const doc = await publishKnowledge(content);
    return {
      ok: true,
      message: `Published ${doc.updatedAt.replace("T", " ").slice(0, 19)} UTC`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Publish failed",
    };
  }
}

export async function resetKnowledgeToSeedAction(): Promise<AdminActionState> {
  if (!(await isAdminAuthed())) {
    return { ok: false, message: "Session expired. Sign in again." };
  }

  try {
    clearKnowledgeCache();
    const seed = readSeedKnowledge();
    const doc = await publishKnowledge(seed);
    return {
      ok: true,
      message: `Reset to docs.md seed and published (${doc.content.length} chars)`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Reset failed",
    };
  }
}

export async function getKnowledgeEditorData() {
  return loadKnowledgeDocument();
}

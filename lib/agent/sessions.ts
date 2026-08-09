/**
 * Conversation continuity is scoped per customer phone number.
 * Each sender maps to their own Gemini previous_interaction_id only,
 * so Customer A and Customer B never share history.
 *
 * Warm instances keep an in-memory cache; Blob persists the pointer across
 * Vercel cold starts so chat history can continue.
 */
import { list, put } from "@vercel/blob";

interface ChatSessionRecord {
  senderPhone: string;
  previousInteractionId: string;
  updatedAt: string;
}

const previousInteractionBySender = new Map<string, string>();
const blobMemory = new Map<string, ChatSessionRecord>();

export function normalizeSender(sender: string): string {
  return sender.replace(/\D/g, "");
}

function sessionPath(sender: string): string {
  return `grabbit/sessions/${normalizeSender(sender)}/chat.json`;
}

async function readSession(
  sender: string,
): Promise<ChatSessionRecord | null> {
  const pathname = sessionPath(sender);
  const cached = blobMemory.get(pathname);
  if (cached) return cached;

  if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    return null;
  }

  try {
    const { blobs } = await list({ prefix: pathname, limit: 1 });
    const match = blobs.find((blob) => blob.pathname === pathname) ?? blobs[0];
    if (!match?.url) return null;

    const response = await fetch(match.url, { cache: "no-store" });
    if (!response.ok) return null;
    const data = (await response.json()) as ChatSessionRecord;
    blobMemory.set(pathname, data);
    return data;
  } catch (error) {
    console.warn("[sessions] blob read failed", {
      pathname,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function writeSession(record: ChatSessionRecord): Promise<void> {
  const pathname = sessionPath(record.senderPhone);
  blobMemory.set(pathname, record);

  if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    return;
  }

  await put(pathname, JSON.stringify(record), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function getPreviousInteractionId(
  sender: string,
): Promise<string | undefined> {
  const key = normalizeSender(sender);
  const cached = previousInteractionBySender.get(key);
  if (cached) return cached;

  const stored = await readSession(sender);
  const id = stored?.previousInteractionId?.trim();
  if (!id) return undefined;

  previousInteractionBySender.set(key, id);
  console.info("[sessions] restored interaction id from blob", {
    sender: key,
    previousInteractionId: id,
  });
  return id;
}

export async function setPreviousInteractionId(
  sender: string,
  interactionId: string,
): Promise<void> {
  const key = normalizeSender(sender);
  const id = interactionId.trim();
  if (!id) return;

  previousInteractionBySender.set(key, id);

  try {
    await writeSession({
      senderPhone: key,
      previousInteractionId: id,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn("[sessions] failed to persist interaction id", {
      sender: key,
      previousInteractionId: id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function clearPreviousInteractionId(
  sender: string,
): Promise<void> {
  const key = normalizeSender(sender);
  previousInteractionBySender.delete(key);
  blobMemory.delete(sessionPath(sender));

  try {
    await writeSession({
      senderPhone: key,
      previousInteractionId: "",
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn("[sessions] failed to clear persisted interaction id", {
      sender: key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

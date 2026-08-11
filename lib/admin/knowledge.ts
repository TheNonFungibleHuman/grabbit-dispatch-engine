import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryClear, readJson, writeJson } from "../blob/json-store";
import { logInfo } from "../log";
import { prepareKnowledgeForPrompt } from "./knowledge-format";

export { prepareKnowledgeForPrompt } from "./knowledge-format";

export const KNOWLEDGE_BLOB_PATH = "grabbit/admin/knowledge.json";

/** How long a warm instance may reuse knowledge before re-reading Blob. */
const KNOWLEDGE_FRESH_TTL_MS = 0;

export interface KnowledgeDocument {
  content: string;
  updatedAt: string;
  source: "blob" | "seed";
}

export interface KnowledgeBundle {
  document: KnowledgeDocument;
  prepared: string;
}

let freshBundle: { fetchedAt: number; bundle: KnowledgeBundle } | null = null;

export function clearKnowledgeCache(): void {
  freshBundle = null;
  memoryClear(KNOWLEDGE_BLOB_PATH);
}

export function readSeedKnowledge(): string {
  return readFileSync(join(process.cwd(), "docs.md"), "utf8");
}

export async function loadKnowledgeDocument(args?: {
  /** When true, bypass in-memory Blob cache (used by the live agent). */
  bypassMemory?: boolean;
}): Promise<KnowledgeDocument> {
  if (args?.bypassMemory) {
    memoryClear(KNOWLEDGE_BLOB_PATH);
  }

  const stored = await readJson<{ content?: string; updatedAt?: string }>(
    KNOWLEDGE_BLOB_PATH,
  );
  if (stored?.content?.trim()) {
    return {
      content: stored.content,
      updatedAt: stored.updatedAt ?? new Date(0).toISOString(),
      source: "blob",
    };
  }

  return {
    content: readSeedKnowledge(),
    updatedAt: new Date(0).toISOString(),
    source: "seed",
  };
}

export async function publishKnowledge(content: string): Promise<KnowledgeDocument> {
  const trimmed = content.replace(/\s+$/u, "\n");
  if (!trimmed.trim()) {
    throw new Error("Knowledge content cannot be empty");
  }

  const doc: KnowledgeDocument = {
    content: trimmed,
    updatedAt: new Date().toISOString(),
    source: "blob",
  };

  // Drop any stale warm-instance copy before/after write.
  clearKnowledgeCache();
  await writeJson(KNOWLEDGE_BLOB_PATH, {
    content: doc.content,
    updatedAt: doc.updatedAt,
  });
  freshBundle = {
    fetchedAt: Date.now(),
    bundle: {
      document: doc,
      prepared: prepareKnowledgeForPrompt(doc.content),
    },
  };
  logInfo("admin", "knowledge published", {
    chars: doc.content.length,
    updatedAt: doc.updatedAt,
  });
  return doc;
}

/**
 * Fresh knowledge for the agent. Re-reads Blob frequently so an Admin
 * Publish is picked up on the next WhatsApp turn in the same chat.
 */
export async function getKnowledgeBundle(): Promise<KnowledgeBundle> {
  if (
    freshBundle &&
    Date.now() - freshBundle.fetchedAt < KNOWLEDGE_FRESH_TTL_MS
  ) {
    return freshBundle.bundle;
  }

  const document = await loadKnowledgeDocument({ bypassMemory: true });
  const bundle: KnowledgeBundle = {
    document,
    prepared: prepareKnowledgeForPrompt(document.content),
  };
  freshBundle = { fetchedAt: Date.now(), bundle };
  return bundle;
}

export async function getKnowledgeForPrompt(): Promise<string> {
  const bundle = await getKnowledgeBundle();
  return bundle.prepared;
}

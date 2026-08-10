import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryClear, readJson, writeJson } from "../blob/json-store";
import { logInfo } from "../log";
import { prepareKnowledgeForPrompt } from "./knowledge-format";

export { prepareKnowledgeForPrompt } from "./knowledge-format";

export const KNOWLEDGE_BLOB_PATH = "grabbit/admin/knowledge.json";

export interface KnowledgeDocument {
  content: string;
  updatedAt: string;
  source: "blob" | "seed";
}

let preparedCache: { raw: string; prepared: string } | null = null;

export function clearKnowledgeCache(): void {
  preparedCache = null;
  memoryClear(KNOWLEDGE_BLOB_PATH);
}

export function readSeedKnowledge(): string {
  return readFileSync(join(process.cwd(), "docs.md"), "utf8");
}

export async function loadKnowledgeDocument(): Promise<KnowledgeDocument> {
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

  await writeJson(KNOWLEDGE_BLOB_PATH, {
    content: doc.content,
    updatedAt: doc.updatedAt,
  });
  preparedCache = null;
  logInfo("admin", "knowledge published", {
    chars: doc.content.length,
    updatedAt: doc.updatedAt,
  });
  return doc;
}

export async function getKnowledgeForPrompt(): Promise<string> {
  const doc = await loadKnowledgeDocument();
  if (preparedCache && preparedCache.raw === doc.content) {
    return preparedCache.prepared;
  }
  const prepared = prepareKnowledgeForPrompt(doc.content);
  preparedCache = { raw: doc.content, prepared };
  return prepared;
}

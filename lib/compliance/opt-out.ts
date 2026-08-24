import { readJson, writeJson } from "../blob/json-store.ts";
import { logInfo } from "../log.ts";

export const SUPPRESSED_PHONES_PATH = "grabbit/admin/suppressed-phones.json";

interface SuppressionIndex {
  phones: Record<string, string>;
}

const OPT_OUT_TOKENS = [
  "stop",
  "stopall",
  "stop all",
  "unsubscribe",
  "opt out",
  "optout",
  "remove me",
  "delete my number",
];

const RESUBSCRIBE_TOKENS = ["start", "unstop", "subscribe", "resubscribe"];

function normalizeCommandText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchesOptOut(text: string): boolean {
  const normalized = normalizeCommandText(text);
  if (!normalized) return false;
  return OPT_OUT_TOKENS.includes(normalized);
}

export function matchesResubscribe(text: string): boolean {
  const normalized = normalizeCommandText(text);
  if (!normalized) return false;
  return RESUBSCRIBE_TOKENS.includes(normalized);
}

export function suppressedPhoneKey(phone: string): string {
  return phone.replace(/\D/g, "");
}

async function loadIndex(): Promise<SuppressionIndex> {
  const stored = await readJson<SuppressionIndex>(SUPPRESSED_PHONES_PATH);
  return { phones: stored?.phones ?? {} };
}

export async function suppressCustomerPhone(phone: string, source = "whatsapp_stop"): Promise<void> {
  const key = suppressedPhoneKey(phone);
  if (!key) return;
  const index = await loadIndex();
  index.phones[key] = new Date().toISOString();
  await writeJson(SUPPRESSED_PHONES_PATH, index);
  logInfo("compliance", "customer opted out of broadcasts", { phone: key, source });
}

export async function unsuppressCustomerPhone(phone: string): Promise<boolean> {
  const key = suppressedPhoneKey(phone);
  if (!key) return false;
  const index = await loadIndex();
  if (!(key in index.phones)) return false;
  delete index.phones[key];
  await writeJson(SUPPRESSED_PHONES_PATH, index);
  logInfo("compliance", "customer re-subscribed to broadcasts", { phone: key });
  return true;
}

export async function isCustomerSuppressed(phone: string): Promise<boolean> {
  const key = suppressedPhoneKey(phone);
  if (!key) return false;
  const index = await loadIndex();
  return key in index.phones;
}

export async function listSuppressedPhones(): Promise<string[]> {
  const index = await loadIndex();
  return Object.keys(index.phones);
}

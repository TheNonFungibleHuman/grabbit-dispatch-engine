import { readJson, writeJson } from "../blob/json-store.ts";
import { formatError, logInfo, logWarn } from "../log.ts";

export interface PendingPaymentProof {
  customerPhone: string;
  bank?: string;
  amount?: number;
  currency?: string;
  referenceId?: string;
  status?: "successful" | "failed" | "pending";
  notes?: string;
  receivedAt: string;
  expiresAt: number; // Unix ms
}

interface PendingProofsStore {
  proofs: Record<string, PendingPaymentProof>;
}

const PENDING_PROOFS_PATH = "grabbit/payments/pending-proofs.json";
const PROOF_TTL_MS = 30 * 60 * 1000; // 30 minutes validity

function cleanPhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * Save an advance payment receipt received before a booking exists.
 */
export async function savePendingPaymentProof(proof: {
  customerPhone: string;
  bank?: string;
  amount?: number;
  currency?: string;
  referenceId?: string;
  status?: "successful" | "failed" | "pending";
  notes?: string;
}): Promise<void> {
  const phone = cleanPhone(proof.customerPhone);
  if (!phone) return;

  try {
    const store = (await readJson<PendingProofsStore>(PENDING_PROOFS_PATH)) || { proofs: {} };
    store.proofs[phone] = {
      ...proof,
      customerPhone: phone,
      receivedAt: new Date().toISOString(),
      expiresAt: Date.now() + PROOF_TTL_MS,
    };
    await writeJson(PENDING_PROOFS_PATH, store);

    logInfo("pending_proofs", "stored advance payment proof for customer", {
      phone,
      bank: proof.bank,
      amount: proof.amount,
      ref: proof.referenceId,
    });
  } catch (err) {
    logWarn("pending_proofs", "failed to save pending payment proof", formatError(err));
  }
}

/**
 * Retrieve and consume an advance payment proof if still valid.
 */
export async function getAndConsumePendingPaymentProof(
  customerPhone: string,
  expectedFare?: number,
): Promise<PendingPaymentProof | null> {
  const phone = cleanPhone(customerPhone);
  if (!phone) return null;

  try {
    const store = (await readJson<PendingProofsStore>(PENDING_PROOFS_PATH)) || { proofs: {} };
    const proof = store.proofs[phone];
    if (!proof) return null;

    // Check expiry
    if (Date.now() > proof.expiresAt) {
      delete store.proofs[phone];
      await writeJson(PENDING_PROOFS_PATH, store);
      return null;
    }

    // Delete after consumption
    delete store.proofs[phone];
    await writeJson(PENDING_PROOFS_PATH, store);

    logInfo("pending_proofs", "consumed advance payment proof for new booking", {
      phone,
      bank: proof.bank,
      amount: proof.amount,
      referenceId: proof.referenceId,
      matchedFare: expectedFare,
    });

    return proof;
  } catch (err) {
    logWarn("pending_proofs", "failed to consume pending payment proof", formatError(err));
    return null;
  }
}

/**
 * Peek without consuming (useful for context notes).
 */
export async function peekPendingPaymentProof(
  customerPhone: string,
): Promise<PendingPaymentProof | null> {
  const phone = cleanPhone(customerPhone);
  if (!phone) return null;

  try {
    const store = (await readJson<PendingProofsStore>(PENDING_PROOFS_PATH)) || { proofs: {} };
    const proof = store.proofs[phone];
    if (!proof) return null;

    if (Date.now() > proof.expiresAt) {
      delete store.proofs[phone];
      await writeJson(PENDING_PROOFS_PATH, store);
      return null;
    }

    return proof;
  } catch {
    return null;
  }
}

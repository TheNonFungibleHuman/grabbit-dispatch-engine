import { ADMIN_PHONES, FLEET_RIDERS, isAuthorizedRiderOrAdmin } from "../riders/config.ts";
import { listAllPreBookings } from "../orders/pre-booking.ts";
import { sendCustomerText } from "../wasender/send-tracked.ts";
import { readJson, writeJson } from "../blob/json-store.ts";
import { formatError, logInfo, logWarn } from "../log.ts";

export interface BroadcastRecord {
  broadcastId: string;
  adminPhone: string;
  messageText: string;
  recipientCount: number;
  recipients: string[];
  status: "draft" | "sending" | "completed" | "cancelled";
  createdAt: string;
  sentAt?: string;
  sentCount?: number;
  failedCount?: number;
}

const BROADCAST_LATEST_KEY = "grabbit/admin/broadcasts/latest.json";

function broadcastPath(id: string): string {
  return `grabbit/admin/broadcasts/${id}.json`;
}

export async function getAllUniqueCustomerPhones(): Promise<string[]> {
  const customerSet = new Set<string>();

  // Exclude list
  const excluded = new Set<string>();
  for (const admin of ADMIN_PHONES) {
    excluded.add(admin.replace(/\D/g, ""));
  }
  for (const rider of FLEET_RIDERS) {
    if (rider.phone) excluded.add(rider.phone.replace(/\D/g, ""));
  }

  // 1. From pre-bookings
  try {
    const allBookings = await listAllPreBookings();
    for (const b of allBookings) {
      if (b.customerPhone) {
        const clean = b.customerPhone.replace(/\D/g, "");
        if (clean.length >= 7 && !excluded.has(clean)) {
          customerSet.add(clean);
        }
      }
    }
  } catch (err) {
    logWarn("broadcast", "failed to scan bookings for broadcast recipients", formatError(err));
  }

  return Array.from(customerSet);
}

export async function previewCustomerBroadcast(args: {
  adminPhone: string;
  messageText: string;
}): Promise<{
  ok: boolean;
  broadcastId?: string;
  recipientCount?: number;
  previewText: string;
  error?: string;
}> {
  const auth = isAuthorizedRiderOrAdmin(args.adminPhone);
  if (!auth.isAdmin) {
    return {
      ok: false,
      previewText: "",
      error: "Access Denied: Only authorized Grabbit Admins can send broadcasts.",
    };
  }

  const recipients = await getAllUniqueCustomerPhones();
  if (recipients.length === 0) {
    return {
      ok: false,
      previewText: "No active customer phone numbers found in system yet.",
      error: "No recipients found",
    };
  }

  const broadcastId = `bc_${Date.now()}`;
  const record: BroadcastRecord = {
    broadcastId,
    adminPhone: args.adminPhone,
    messageText: args.messageText.trim(),
    recipientCount: recipients.length,
    recipients,
    status: "draft",
    createdAt: new Date().toISOString(),
  };

  await writeJson(broadcastPath(broadcastId), record);
  await writeJson(BROADCAST_LATEST_KEY, { broadcastId });

  const preview = [
    `📢 *Broadcast Campaign Preview*`,
    `*Audience:* ${recipients.length} active Grabbit customers`,
    `*Message:*`,
    `"${record.messageText}"`,
    "",
    `⚠️ *Safety Guard:* Reply *YES* or *CONFIRM* to immediately dispatch this message to all ${recipients.length} customers.`,
  ].join("\n");

  return {
    ok: true,
    broadcastId,
    recipientCount: recipients.length,
    previewText: preview,
  };
}

export async function executeCustomerBroadcast(args: {
  adminPhone: string;
  broadcastId?: string;
}): Promise<{
  ok: boolean;
  sentCount: number;
  message: string;
  error?: string;
}> {
  const auth = isAuthorizedRiderOrAdmin(args.adminPhone);
  if (!auth.isAdmin) {
    return {
      ok: false,
      sentCount: 0,
      message: "Access Denied: Only authorized Grabbit Admins can execute broadcasts.",
    };
  }

  let targetId = args.broadcastId;
  if (!targetId) {
    const latest = await readJson<{ broadcastId: string }>(BROADCAST_LATEST_KEY);
    targetId = latest?.broadcastId;
  }

  if (!targetId) {
    return {
      ok: false,
      sentCount: 0,
      message: "No pending broadcast draft found. Please create one by asking me to broadcast first.",
    };
  }

  const record = await readJson<BroadcastRecord>(broadcastPath(targetId));
  if (!record || record.status !== "draft") {
    return {
      ok: false,
      sentCount: 0,
      message: `Broadcast draft ${targetId} is not available for sending (status: ${record?.status || "missing"}).`,
    };
  }

  record.status = "sending";
  record.sentAt = new Date().toISOString();
  await writeJson(broadcastPath(targetId), record);

  logInfo("broadcast", "starting customer broadcast execution", {
    broadcastId: targetId,
    recipients: record.recipients.length,
  });

  let sentCount = 0;
  let failedCount = 0;

  for (const phone of record.recipients) {
    try {
      const e164 = phone.startsWith("+") ? phone : `+${phone}`;
      await sendCustomerText({
        to: e164,
        text: record.messageText,
      });
      sentCount++;
      // Safe delay between messages to protect WhatsApp number reputation
      await new Promise((r) => setTimeout(r, 1200));
    } catch (err) {
      logWarn("broadcast", "failed to deliver broadcast message to phone", {
        phone,
        error: formatError(err),
      });
      failedCount++;
    }
  }

  record.status = "completed";
  record.sentCount = sentCount;
  record.failedCount = failedCount;
  await writeJson(broadcastPath(targetId), record);

  logInfo("broadcast", "completed customer broadcast execution", {
    broadcastId: targetId,
    sentCount,
    failedCount,
  });

  return {
    ok: true,
    sentCount,
    message: `🚀 *Broadcast Dispatched!*\nSuccessfully delivered message to *${sentCount} customers* (${failedCount} failed).`,
  };
}

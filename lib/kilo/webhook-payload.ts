import type { KiloDelivery, KiloWebhookPayload } from "./types";

export interface KiloWebhookOtp {
  code: string;
  receiverPhone?: string;
  reason?: string;
  channel?: string;
}

export interface ExtractedKiloWebhook {
  deliveryId?: string;
  status?: string;
  accessCode?: string;
  otp?: KiloWebhookOtp;
  customerMessageHint?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractDeliveryObject(
  payload: KiloWebhookPayload,
): Partial<KiloDelivery> | null {
  const fromObject = payload.data?.object;
  if (fromObject && typeof fromObject === "object") {
    return fromObject;
  }
  if (payload.delivery && typeof payload.delivery === "object") {
    return payload.delivery;
  }
  const data = asRecord(payload.data);
  const nested = data?.delivery;
  if (nested && typeof nested === "object") {
    return nested as Partial<KiloDelivery>;
  }
  return null;
}

function extractOtp(payload: KiloWebhookPayload): KiloWebhookOtp | undefined {
  const data = asRecord(payload.data);
  const otp = asRecord(data?.otp);
  if (!otp) {
    return undefined;
  }
  const code = readString(otp.code);
  if (!code) {
    return undefined;
  }
  return {
    code,
    receiverPhone: readString(otp.receiver_phone),
    reason: readString(otp.reason),
    channel: readString(otp.channel),
  };
}

/**
 * Normalize Kilo webhook JSON into the fields we need for WhatsApp updates.
 * Prefer `data.otp.code` for OTP events — never invent a code.
 */
export function extractKiloWebhook(
  payload: KiloWebhookPayload,
): ExtractedKiloWebhook {
  const delivery = extractDeliveryObject(payload);

  return {
    deliveryId: readString(delivery?.id),
    status: readString(delivery?.status),
    accessCode: readString(delivery?.access_code ?? undefined),
    otp: extractOtp(payload),
    customerMessageHint: readString(payload.customer_message_hint),
  };
}

export function resolveWebhookNotifyPhone(args: {
  otpReceiverPhone?: string;
  recordSenderPhone?: string;
  deliveryReceiverPhone?: string | null;
  deliverySenderPhone?: string | null;
}): string | undefined {
  return (
    readString(args.otpReceiverPhone) ??
    readString(args.recordSenderPhone) ??
    readString(args.deliveryReceiverPhone ?? undefined) ??
    readString(args.deliverySenderPhone ?? undefined)
  );
}

export function toWhatsAppE164(phone: string): string {
  if (phone.startsWith("+")) {
    return phone;
  }
  return `+${phone.replace(/\D/g, "")}`;
}

export function isOtpIssuedEvent(event: string): boolean {
  return event.toLowerCase().includes("otp_issued");
}

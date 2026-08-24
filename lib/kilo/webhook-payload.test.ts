import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractKiloWebhook,
  isOtpIssuedEvent,
  resolveWebhookNotifyPhone,
  toWhatsAppE164,
} from "./webhook-payload.ts";
import type { KiloWebhookPayload } from "./types.ts";

describe("extractKiloWebhook", () => {
  it("reads id, status and access_code from data.object", () => {
    const extracted = extractKiloWebhook({
      event: "delivery.updated",
      data: {
        object: {
          id: "kd_123",
          status: "delivered",
          access_code: "ACC-9",
        },
      },
    } as unknown as KiloWebhookPayload);

    assert.equal(extracted.deliveryId, "kd_123");
    assert.equal(extracted.status, "delivered");
    assert.equal(extracted.accessCode, "ACC-9");
  });

  it("falls back to payload.delivery then data.delivery shapes", () => {
    const viaDelivery = extractKiloWebhook({
      delivery: { id: "kd_top", status: "picked_up" },
    } as unknown as KiloWebhookPayload);
    assert.equal(viaDelivery.deliveryId, "kd_top");

    const viaNested = extractKiloWebhook({
      data: { delivery: { id: "kd_nested" } },
    } as unknown as KiloWebhookPayload);
    assert.equal(viaNested.deliveryId, "kd_nested");
  });

  it("never invents a delivery id when none exists", () => {
    const extracted = extractKiloWebhook({ event: "ping" } as unknown as KiloWebhookPayload);
    assert.equal(extracted.deliveryId, undefined);
  });

  it("extracts OTP with receiver phone but refuses empty codes", () => {
    const good = extractKiloWebhook({
      data: { otp: { code: "4821", receiver_phone: "+2301234" } },
    } as unknown as KiloWebhookPayload);
    assert.equal(good.otp?.code, "4821");
    assert.equal(good.otp?.receiverPhone, "+2301234");

    const bad = extractKiloWebhook({
      data: { otp: { code: "   " } },
    } as unknown as KiloWebhookPayload);
    assert.equal(bad.otp, undefined);
  });

  it("passes through customer message hints", () => {
    const extracted = extractKiloWebhook({
      customer_message_hint: "Rider is nearby",
    } as unknown as KiloWebhookPayload);
    assert.equal(extracted.customerMessageHint, "Rider is nearby");
  });
});

describe("isOtpIssuedEvent", () => {
  it("matches otp events case-insensitively", () => {
    assert.equal(isOtpIssuedEvent("delivery.otp_issued"), true);
    assert.equal(isOtpIssuedEvent("OTP_ISSUED"), true);
    assert.equal(isOtpIssuedEvent("delivery.updated"), false);
  });
});

describe("resolveWebhookNotifyPhone precedence", () => {
  it("prefers otp receiver over record over delivery fields", () => {
    const resolved = resolveWebhookNotifyPhone({
      otpReceiverPhone: "230111",
      recordSenderPhone: "230222",
      deliveryReceiverPhone: "230333",
      deliverySenderPhone: "230444",
    });
    assert.equal(resolved, "230111");

    const fallback = resolveWebhookNotifyPhone({
      recordSenderPhone: "",
      deliveryReceiverPhone: null,
      deliverySenderPhone: "230444",
    });
    assert.equal(fallback, "230444");
  });
});

describe("toWhatsAppE164", () => {
  it("normalizes digits with a plus prefix", () => {
    assert.equal(toWhatsAppE164("+230 5123"), "+230 5123");
    assert.equal(toWhatsAppE164("2305123"), "+2305123");
    assert.equal(toWhatsAppE164("(230) 5123"), "+2305123");
  });
});

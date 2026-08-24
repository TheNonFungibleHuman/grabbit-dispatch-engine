import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSenderPhone, parseWasenderWebhookPayload } from "./parse.ts";
import type { WasenderIncomingMessage } from "./types.ts";
import { verifyWasenderSignature } from "./verify.ts";

describe("verifyWasenderSignature", () => {
  it("accepts an exact matching secret", () => {
    assert.equal(verifyWasenderSignature("super-secret", "super-secret"), true);
  });

  it("rejects missing or mismatched signatures", () => {
    assert.equal(verifyWasenderSignature(null, "super-secret"), false);
    assert.equal(verifyWasenderSignature("wrong", "super-secret"), false);
    assert.equal(verifyWasenderSignature("super-secret", ""), false);
  });
});

describe("parseWasenderWebhookPayload", () => {
  it("parses a messages.received payload", () => {
    const payload = parseWasenderWebhookPayload({
      event: "messages.received",
      timestamp: 1633456789,
      data: {
        messages: {
          key: {
            id: "3EB0X123456789",
            fromMe: false,
            remoteJid: "1234567890@s.whatsapp.net",
            cleanedSenderPn: "1234567890",
          },
          messageBody: "Hello",
        },
      },
    });

    assert.equal(payload.event, "messages.received");
  });

  it("rejects invalid payloads", () => {
    assert.throws(() => parseWasenderWebhookPayload(null), /JSON object/);
    assert.throws(() => parseWasenderWebhookPayload({}), /event name/);
  });
});

describe("getSenderPhone", () => {
  it("prefers cleaned participant/sender phone numbers", () => {
    const message: WasenderIncomingMessage = {
      key: {
        id: "1",
        fromMe: false,
        remoteJid: "999@lid",
        cleanedSenderPn: "99900000028",
      },
    };

    assert.equal(getSenderPhone(message), "99900000028");
  });
});

describe("outbound AI message tracking", () => {
  it("tracks AI outbound IDs to differentiate from manual human takeover", async () => {
    const { isOutboundAiMessage, registerOutboundAiMessage } = await import("./send-tracked.ts");
    assert.equal(await isOutboundAiMessage("manual_msg_123"), false);
    await registerOutboundAiMessage("ai_msg_456");
    assert.equal(await isOutboundAiMessage("ai_msg_456"), true);
    assert.equal(await isOutboundAiMessage("manual_msg_123"), false);
  });
});

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { mapDraftToCreateDeliveryInput } from "./map-order.ts";
import { statusMessageForCustomer } from "./status-messages.ts";
import { verifyKiloSignature } from "./verify.ts";

describe("verifyKiloSignature", () => {
  it("accepts a valid signed payload", () => {
    const secret = "whsec_test_secret";
    const rawBody = JSON.stringify({ hello: "world" });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", secret)
      .update(`${t}.${rawBody}`)
      .digest("hex");

    assert.equal(verifyKiloSignature(secret, rawBody, `t=${t},v1=${v1}`), true);
  });

  it("rejects bad signatures and stale timestamps", () => {
    const secret = "whsec_test_secret";
    const rawBody = "{}";
    const stale = Math.floor(Date.now() / 1000) - 1000;
    const v1 = createHmac("sha256", secret)
      .update(`${stale}.${rawBody}`)
      .digest("hex");

    assert.equal(verifyKiloSignature(secret, rawBody, "t=1,v1=deadbeef"), false);
    assert.equal(
      verifyKiloSignature(secret, rawBody, `t=${stale},v1=${v1}`),
      false,
    );
  });
});

describe("mapDraftToCreateDeliveryInput", () => {
  it("maps a complete draft with real coords and idempotency", () => {
    const payload = mapDraftToCreateDeliveryInput({
      draft: {
        senderName: "Ada",
        senderPhone: "99900000028",
        receiverName: "Grace",
        receiverPhone: "+99900000022",
        pickupAddress: "KFC Triolet",
        deliveryAddress: "Calebasses main road",
        packageDescription: "2 burgers",
        packageSize: "small",
        packageImages: ["https://cdn.example.com/package-1.jpg"],
        idempotencyKey: "wa-msg-12345678",
      },
      pickupCoords: { lng: 57.545, lat: -20.059 },
      deliveryCoords: { lng: 57.56, lat: -20.11 },
    });

    assert.equal(payload.serviceKind, "pickup_delivery");
    assert.equal(payload.deliveryMode, "pickup");
    assert.equal(payload.customerCollectionMethod, "cash_on_delivery");
    assert.equal(payload.senderPhone, "+99900000028");
    assert.equal(payload.idempotencyKey, "wa-msg-12345678");
    assert.deepEqual(payload.pickupCoords, { lng: 57.545, lat: -20.059 });
  });

  it("rejects fake zero coords and missing images", () => {
    assert.throws(
      () =>
        mapDraftToCreateDeliveryInput({
          draft: {
            senderName: "Ada",
            senderPhone: "+99900000028",
            receiverName: "Grace",
            receiverPhone: "+99900000022",
            pickupAddress: "KFC Triolet",
            deliveryAddress: "Calebasses",
            packageDescription: "Food",
            packageImages: [],
            idempotencyKey: "wa-msg-12345678",
          },
          pickupCoords: { lng: 57.5, lat: -20.0 },
          deliveryCoords: { lng: 57.6, lat: -20.1 },
        }),
      /1 to 6/,
    );

    assert.throws(
      () =>
        mapDraftToCreateDeliveryInput({
          draft: {
            senderName: "Ada",
            senderPhone: "+99900000028",
            receiverName: "Grace",
            receiverPhone: "+99900000022",
            pickupAddress: "KFC Triolet",
            deliveryAddress: "Calebasses",
            packageDescription: "Food",
            packageImages: ["https://cdn.example.com/a.jpg"],
            idempotencyKey: "wa-msg-12345678",
          },
          pickupCoords: { lng: 0, lat: 0 },
          deliveryCoords: { lng: 57.6, lat: -20.1 },
        }),
      /real geocoded/,
    );
  });
});

describe("statusMessageForCustomer", () => {
  it("returns calm customer-facing updates", () => {
    assert.match(
      statusMessageForCustomer({
        event: "delivery.completed",
        status: "completed",
      }),
      /complete/i,
    );
    assert.match(
      statusMessageForCustomer({
        event: "delivery.cancelled",
        status: "cancelled",
      }),
      /cancelled/i,
    );
  });
});

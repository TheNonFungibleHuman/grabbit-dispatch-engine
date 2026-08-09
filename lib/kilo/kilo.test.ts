import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  composeServiceLocationAddress,
  expandUnitOptions,
  matchServiceLocations,
  resolveUnitFollowUp,
} from "./locations.ts";
import { mapDraftToCreateDeliveryInput } from "./map-order.ts";
import { statusMessageForCustomer } from "./status-messages.ts";
import type { KiloServiceLocation } from "./types.ts";
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

  it("rejects fake zero coords and missing images for pickup_delivery", () => {
    assert.throws(
      () =>
        mapDraftToCreateDeliveryInput({
          draft: {
            serviceKind: "pickup_delivery",
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
      /pickup_delivery/,
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

  it("allows empty packageImages for errand at_place and link", () => {
    const atPlace = mapDraftToCreateDeliveryInput({
      draft: {
        serviceKind: "errand",
        errandMode: "at_place",
        senderName: "Ada",
        senderPhone: "+99900000028",
        receiverName: "Grace",
        receiverPhone: "+99900000022",
        pickupAddress: "KFC Mahogany",
        deliveryAddress: "Songhai",
        packageDescription: "2-Piece Chicken Meal",
        packageImages: [],
        idempotencyKey: "wa-msg-errand-1",
      },
      pickupCoords: { lng: 57.545, lat: -20.059 },
      deliveryCoords: { lng: 57.56, lat: -20.11 },
    });
    assert.equal(atPlace.serviceKind, "errand");
    assert.equal(atPlace.errandMode, "at_place");
    assert.deepEqual(atPlace.packageImages, []);

    const link = mapDraftToCreateDeliveryInput({
      draft: {
        serviceKind: "errand",
        errandMode: "link",
        errandLinks: [
          { url: "https://shop.example.com/item", note: "Size M" },
        ],
        senderName: "Ada",
        senderPhone: "+99900000028",
        receiverName: "Grace",
        receiverPhone: "+99900000022",
        pickupAddress: "Online shop",
        deliveryAddress: "Songhai",
        packageDescription: "Shirt",
        packageImages: [],
        idempotencyKey: "wa-msg-errand-2",
      },
      pickupCoords: { lng: 57.545, lat: -20.059 },
      deliveryCoords: { lng: 57.56, lat: -20.11 },
    });
    assert.equal(link.errandMode, "link");
    assert.equal(link.errandLinks?.[0]?.url, "https://shop.example.com/item");
  });

  it("requires packageImages for errand photo mode", () => {
    assert.throws(
      () =>
        mapDraftToCreateDeliveryInput({
          draft: {
            serviceKind: "errand",
            errandMode: "photo",
            senderName: "Ada",
            senderPhone: "+99900000028",
            receiverName: "Grace",
            receiverPhone: "+99900000022",
            pickupAddress: "Shop",
            deliveryAddress: "Songhai",
            packageDescription: "Snacks",
            packageImages: [],
            idempotencyKey: "wa-msg-errand-3",
          },
          pickupCoords: { lng: 57.545, lat: -20.059 },
          deliveryCoords: { lng: 57.56, lat: -20.11 },
        }),
      /errandMode is photo/,
    );
  });
});

describe("service locations helpers", () => {
  const sample: KiloServiceLocation = {
    id: "loc_1",
    name: "Queen's Hall",
    address: "Triolet Road",
    category: "hostel",
    coords: { lng: 57.55, lat: -20.05 },
    countryCode: "MU",
    stateCode: null,
    countryName: "Mauritius",
    stateName: null,
    unit: {
      label: "Room",
      mode: "list",
      ranges: [{ prefix: "R", suffix: "", start: 1, end: 3, pad: 2 }],
      values: ["R10"],
      allowCustom: false,
      required: true,
    },
  };

  it("matches place names and expands units", () => {
    const matches = matchServiceLocations("queens hall", [sample]);
    assert.equal(matches[0]?.id, "loc_1");
    assert.deepEqual(expandUnitOptions(sample.unit), ["R01", "R02", "R03", "R10"]);
    assert.equal(
      composeServiceLocationAddress(sample, "R02"),
      "Queen's Hall — Triolet Road — R02",
    );
    assert.equal(resolveUnitFollowUp(sample.unit).status, "ask_list");
  });

  it("matches short landmark queries like Songhai", () => {
    const songhai: KiloServiceLocation = {
      ...sample,
      id: "loc_songhai",
      name: "Songhai Hostel",
      address: "Near campus gate",
    };
    const matches = matchServiceLocations("What about Songhai?", [
      sample,
      songhai,
    ]);
    assert.equal(matches[0]?.id, "loc_songhai");
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

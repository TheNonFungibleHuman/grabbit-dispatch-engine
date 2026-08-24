import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  estimateBookingFare,
  formatFareTableForPrompt,
  quoteDeliveryFee,
  quoteTripFare,
} from "./fares.ts";

describe("quoteTripFare", () => {
  it("prices every canonical zone one-way and round", () => {
    const cases: Array<[string, number, number]> = [
      ["Pamplemousses Garden", 50, 100],
      ["Grand Baie Express bus station", 50, 100],
      ["Grand Baie", 50, 100],
      ["SSRN Hospital", 40, 80],
      ["Mahogany Shopping Promenade", 40, 80],
      ["Calebasses", 130, 260],
      ["Calabasses village", 130, 260],
      ["Pamplemousses town", 100, 200],
    ];

    for (const [destination, oneWay, round] of cases) {
      assert.equal(quoteTripFare(destination, "one_way")?.amountRs, oneWay, destination);
      assert.equal(quoteTripFare(destination, "round_trip")?.amountRs, round, destination);
    }
  });

  it("keeps garden and town price tiers distinct despite shared prefix", () => {
    assert.equal(quoteTripFare("Pamplemousses Garden", "one_way")?.zone, "Pamplemousses Garden");
    assert.equal(quoteTripFare("Pamplemousses", "one_way")?.zone, "Pamplemousses Town");
  });

  it("normalizes case, spacing, and hyphen variants", () => {
    assert.equal(quoteTripFare("  SSRN   hospital ", "one_way")?.amountRs, 40);
    assert.equal(quoteTripFare("GRAND-BAIE bus", "round_trip")?.amountRs, 100);
  });

  it("defaults to one-way pricing when tripType is omitted", () => {
    assert.equal(quoteTripFare("SSRN Hospital")?.roundTrip, false);
    assert.equal(quoteTripFare("SSRN Hospital")?.amountRs, 40);
  });

  it("returns null for unknown destinations instead of inventing a fare", () => {
    assert.equal(quoteTripFare("Port Louis Waterfront"), null);
    assert.equal(quoteTripFare(""), null);
  });
});

describe("quoteDeliveryFee", () => {
  it("charges Rs 200 when either end touches Pamplemousses", () => {
    assert.equal(quoteDeliveryFee("ALCHE", "Pamplemousses pharmacy"), 200);
    assert.equal(quoteDeliveryFee("Pamplemousses town", "ALCHE"), 200);
  });

  it("charges the standard Rs 100 elsewhere", () => {
    assert.equal(quoteDeliveryFee("Mahogany KFC", "ALCHE gate"), 100);
    assert.equal(quoteDeliveryFee(undefined, undefined), 100);
  });
});

describe("estimateBookingFare parity with legacy rundown table", () => {
  it("matches previous revenue-report amounts", () => {
    const base = {
      pickupAddress: "ALCHE",
      serviceKind: "trip" as const,
      packageDescription: "",
    };

    assert.equal(estimateBookingFare({ ...base, deliveryAddress: "Mahogany", tripType: "round_trip" }), 80);
    assert.equal(estimateBookingFare({ ...base, deliveryAddress: "Calebasses", tripType: "one_way" }), 130);
    assert.equal(estimateBookingFare({ ...base, deliveryAddress: "Pamplemousses Garden", tripType: "round_trip" }), 100);
    assert.equal(
      estimateBookingFare({
        ...base,
        deliveryAddress: "Mahogany",
        tripType: undefined,
        packageDescription: "Round ride for Customer C",
      }),
      80,
    );
    assert.equal(
      estimateBookingFare({ ...base, serviceKind: "pickup_delivery", deliveryAddress: "Pamplemousses" }),
      200,
    );
    assert.equal(
      estimateBookingFare({ ...base, serviceKind: "errand", deliveryAddress: "Mahogany" }),
      100,
    );
  });
});

describe("formatFareTableForPrompt", () => {
  it("renders the full canonical table with both tiers", () => {
    const table = formatFareTableForPrompt();
    assert.match(table, /Delivery Fees \(fixed by system\): Mahogany \/ ALCHE: Rs 100 \| Pamplemousses: Rs 200/);
    for (const amount of ["Rs 50 (Round: Rs 100)", "Rs 40 (Round: Rs 80)", "Rs 130 (Round: Rs 260)", "Rs 100 (Round: Rs 200)"]) {
      assert.ok(table.includes(amount), `missing ${amount}`);
    }
  });
});

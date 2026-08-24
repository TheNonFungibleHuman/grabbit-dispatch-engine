import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isCustomerSuppressed,
  listSuppressedPhones,
  matchesOptOut,
  matchesResubscribe,
  suppressCustomerPhone,
  unsuppressCustomerPhone,
} from "./opt-out.ts";

describe("opt-out command matching", () => {
  it("matches bare opt-out commands only", () => {
    for (const text of ["STOP", "stop!", "Stop All", "UNSUBSCRIBE", "opt out", "Remove Me"]) {
      assert.equal(matchesOptOut(text), true, text);
    }
  });

  it("ignores sentences and unrelated words", () => {
    for (const text of ["stop it please", "how do I unsubscribe later", "cancelled", "yes"]) {
      assert.equal(matchesOptOut(text), false, text);
    }
  });

  it("matches resubscribe commands", () => {
    for (const text of ["START", "Unstop", "subscribe", "RESUBSCRIBE"]) {
      assert.equal(matchesResubscribe(text), true, text);
    }
    assert.equal(matchesResubscribe("start the trip"), false);
  });
});

describe("suppression lifecycle", () => {
  it("suppresses, detects, and un-suppresses a phone", async () => {
    const phone = "+23051188999";
    const digits = phone.replace(/\D/g, "");

    await suppressCustomerPhone(phone);
    assert.equal(await isCustomerSuppressed(phone), true);
    assert.ok((await listSuppressedPhones()).includes(digits));

    assert.equal(await unsuppressCustomerPhone(phone), true);
    assert.equal(await isCustomerSuppressed(phone), false);
    assert.equal(await unsuppressCustomerPhone(phone), false);
  });
});

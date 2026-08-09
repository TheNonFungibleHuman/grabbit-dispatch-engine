import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  customerReplyForFailedBooking,
  looksLikeFalseBookingSuccess,
} from "./booking-guard.ts";

describe("booking-guard", () => {
  it("asks for a photo when booking failed for missing images", () => {
    assert.match(
      customerReplyForFailedBooking(
        "Need at least 1 package photo. Ask the customer to send a clear photo.",
      ),
      /photo/i,
    );
  });

  it("detects false booking success wording", () => {
    assert.equal(
      looksLikeFalseBookingSuccess(
        "Awesome! Your order has been received. Our team will process it.",
      ),
      true,
    );
    assert.equal(
      looksLikeFalseBookingSuccess("Please send a package photo first 🙂"),
      false,
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  customerReplyForFailedBooking,
  looksLikeFalseBookingSuccess,
  looksLikeFalseDeferredOrderPromise,
  fabricatedTrackingLinks,
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

  it("asks for room/unit from structured follow-up errors", () => {
    assert.match(
      customerReplyForFailedBooking("Need Room for Songhai."),
      /Room for Songhai/i,
    );
  });

  it("asks for a link on link-errand failures", () => {
    assert.match(
      customerReplyForFailedBooking({
        error: "errandMode=link requires errandLinks",
        fieldErrors: { errandLinks: ["At least one https link is required"] },
      }),
      /link/i,
    );
  });

  it("treats image_host_rejected as an internal hiccup, not a customer gap", () => {
    assert.match(
      customerReplyForFailedBooking({
        error:
          "No allowed image hosts configured. Add your CDN/media hostnames before creating deliveries via API.",
        code: "image_host_rejected",
      }),
      /hiccup|moment/i,
    );
    assert.doesNotMatch(
      customerReplyForFailedBooking({
        error:
          "No allowed image hosts configured. Add your CDN/media hostnames before creating deliveries via API.",
        code: "image_host_rejected",
      }),
      /resend in one line|photo of the order/i,
    );
  });

  it("explains closed hours and next slot on outside_service_hours", () => {
    assert.match(
      customerReplyForFailedBooking({
        error:
          "Closed for on-demand booking right now (Mauritius time). Next open Mauritius slot today: 5:00 pm -6:00 pm (SHERIF).",
        code: "outside_service_hours",
      }),
      /outside rider hours|5:00 pm -6:00 pm/i,
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
      looksLikeFalseBookingSuccess("Please send a package photo first ­ƒÖé"),
      false,
    );
  });

  it("detects false deferred / logged-for-tomorrow promises", () => {
    assert.equal(
      looksLikeFalseDeferredOrderPromise(
        "Yes, your request has been logged with our team for tomorrow between 1:00 pm - 2:00 pm!",
      ),
      true,
    );
  });
});

describe("fabricatedTrackingLinks", () => {
  const REAL = "https://delivery.grabbit-express.com/track/DEL_1/ABC";

  it("flags tracking links absent from the model context", () => {
    const reply = `Confirmed! ${REAL}\nAlso https://delivery.grabbit-express.com/track/DEL_2/XYZ`;
    const forged = fabricatedTrackingLinks(reply, JSON.stringify({ messages: [{ content: REAL }] }));
    assert.equal(forged.length, 1);
    assert.match(forged[0], /DEL_2/);
  });

  it("allows links that genuinely appear in tool output or history", () => {
    const forged = fabricatedTrackingLinks(`Your live link: ${REAL}`, `tool result echoed ${REAL} earlier`);
    assert.equal(forged.length, 0);
  });

  it("returns empty when the reply contains no links at all", () => {
    assert.equal(fabricatedTrackingLinks("No links here", "{}").length, 0);
  });
});

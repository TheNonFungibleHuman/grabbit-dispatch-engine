import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isContentFreeMessage } from "./format.ts";
import {
  isIdenticalRecentReply,
  normalizeReplyText,
  rememberSentReply,
  shouldSuppressDuplicateReply,
} from "./reply-guard.ts";

describe("Content-free inbound messages (Pacifique ellipsis regression)", () => {
  it("detects bare ellipses and punctuation-only texts", () => {
    assert.equal(isContentFreeMessage("…"), true);
    assert.equal(isContentFreeMessage("..."), true);
    assert.equal(isContentFreeMessage("."), true);
    assert.equal(isContentFreeMessage("?"), true);
    assert.equal(isContentFreeMessage("!!"), true);
    assert.equal(isContentFreeMessage(""), true);
    assert.equal(isContentFreeMessage("   "), true);
  });

  it("detects emoji-only texts", () => {
    assert.equal(isContentFreeMessage("👍"), true);
    assert.equal(isContentFreeMessage("😊🙏"), true);
  });

  it("preserves meaningful mid-order inputs", () => {
    assert.equal(isContentFreeMessage("2"), false);
    assert.equal(isContentFreeMessage("9am"), false);
    assert.equal(isContentFreeMessage("cash"), false);
    assert.equal(isContentFreeMessage("ok thanks"), false);
    assert.equal(isContentFreeMessage("Is possible to get a trip to ssrn now"), false);
  });
});

describe("Cross-instance outbound duplicate reply guard", () => {
  const recipient = "+99900000013";

  it("normalizes case and whitespace before comparison", () => {
    assert.equal(normalizeReplyText("  Your Trip Is Ready!  "), "your trip is ready!");
    assert.equal(normalizeReplyText("Your   trip\nis ready!"), "your trip is ready!");
  });

  it("suppresses an identical reply inside the window", async () => {
    const text = "Your trip for tomorrow 8:45 am is confirmed with Moses. Have a great ride!";
    await rememberSentReply(recipient, text);
    assert.equal(await shouldSuppressDuplicateReply(recipient, text), true);
    assert.equal(await shouldSuppressDuplicateReply(recipient, text.toUpperCase()), true);
  });

  it("allows different replies to the same recipient", async () => {
    await rememberSentReply(`${recipient}2`, "Your trip is booked for 8:45 am.");
    assert.equal(
      await shouldSuppressDuplicateReply(`${recipient}2`, "Your delivery window is 9:15 am."),
      false,
    );
  });

  it("allows identical replies after the window expires", () => {
    const candidate = "Your trip is ready.";
    const fresh = { text: candidate, at: Date.now() };
    assert.equal(isIdenticalRecentReply(candidate, fresh), true);

    const stale = { text: candidate, at: Date.now() - 61_000 };
    assert.equal(isIdenticalRecentReply(candidate, stale), false);

    assert.equal(isIdenticalRecentReply(candidate, null), false);
  });
});

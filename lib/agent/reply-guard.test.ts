import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isContentFreeMessage } from "./format.ts";
import {
  isDistinctShortReply,
  isIdenticalRecentReply,
  isNearDuplicateRecentReply,
  normalizeReplyText,
  rememberSentReply,
  shouldSuppressDuplicateReply,
  textSimilarity,
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


describe("Near-duplicate confirmation card suppression (5-second duplicate cards)", () => {
  const cardA =
    "Your passenger trip for today at 4:00 pm is confirmed and assigned to rider Thierry! Fare: Rs 150. Contact your rider directly if needed.";
  const cardB =
    "Great news! Your passenger trip for today at 4:00 pm is confirmed and assigned to rider Thierry. Fare is Rs 150 — contact your rider directly if needed!";

  it("computes word-level Jaccard similarity", () => {
    assert.equal(textSimilarity("hello world", "hello world"), 1);
    assert.equal(textSimilarity("hello world", "completely different words"), 0);
    assert.equal(textSimilarity("", "anything"), 0);
    assert.equal(textSimilarity("  ", ""), 0);
    const partial = textSimilarity("a b c d", "a b c e");
    assert.ok(partial > 0 && partial < 1);
  });

  it("suppresses a paraphrased confirmation card within the 10s window", async () => {
    const recipient = "+99900000014";
    await rememberSentReply(recipient, cardA);
    assert.equal(await shouldSuppressDuplicateReply(recipient, cardB), true);
  });

  it("detects near-duplicates via isNearDuplicateRecentReply directly", () => {
    const now = Date.now();
    const previous = { text: cardA, at: now - 5_000 };
    assert.equal(isNearDuplicateRecentReply(cardB, previous, now), true);
  });

  it("allows the same near-duplicate after the 10s window expires", () => {
    const now = Date.now();
    const previous = { text: cardA, at: now - 11_000 };
    assert.equal(isNearDuplicateRecentReply(cardB, previous, now), false);
    assert.equal(isNearDuplicateRecentReply(cardB, { text: cardA, at: Number.NaN }, now), false);
    assert.equal(isNearDuplicateRecentReply(cardB, null, now), false);
  });

  it("never suppresses distinct short replies after a confirmation card", async () => {
    const recipient = "+99900000015";
    await rememberSentReply(recipient, cardA);
    assert.equal(
      await shouldSuppressDuplicateReply(recipient, "Noted, payment in cash! Have a great ride 🛵⚡"),
      false,
    );
    assert.equal(
      await shouldSuppressDuplicateReply(recipient, "Already locked in for you! See you soon! 🛵⚡"),
      false,
    );
  });

  it("identifies distinct short replies via isDistinctShortReply", () => {
    assert.equal(isDistinctShortReply("Noted, payment in cash!", cardA), true);
    assert.equal(isDistinctShortReply(cardB, cardA), false);
    assert.equal(isDistinctShortReply("ok", null), false);
  });

  it("allows a genuinely different long message (no false positive)", async () => {
    const recipient = "+99900000016";
    await rememberSentReply(recipient, cardA);
    const followUp =
      "Your weekly summary: 12 trips completed this week across Grand Baie and Pamplemousses with total revenue of Rs 2,400.";
    assert.equal(await shouldSuppressDuplicateReply(recipient, followUp), false);
  });

  it("ignores near-duplicates when either message is below the token floor", () => {
    const now = Date.now();
    const short = "trip confirmed rider Thierry";
    const previous = { text: short, at: now - 1_000 };
    assert.equal(isNearDuplicateRecentReply(`${short} today`, previous, now), false);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendTranscriptEntry,
  loadTranscript,
} from "./transcript.ts";

describe("chat transcript memory ceiling", () => {
  it("retains the last 40 entries instead of 12", async () => {
    const phone = "+99900000026";
    for (let i = 1; i <= 45; i++) {
      await appendTranscriptEntry(phone, { role: "customer", text: `msg ${i}` });
    }

    const transcript = await loadTranscript(phone);
    assert.equal(transcript.entries.length, 40);
    assert.equal(transcript.entries[0].text, "msg 6");
    assert.equal(transcript.entries[39].text, "msg 45");
  });
});

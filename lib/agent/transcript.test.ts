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

  it("persists adminInjected flag and context reflection", async () => {
    const phone = "+99900000064";
    await appendTranscriptEntry(phone, {
      role: "agent",
      text: "Sorry we cannot take your trip right now because you owe Rs 150 from yesterday.",
      adminInjected: true,
    });

    const transcript = await loadTranscript(phone);
    const last = transcript.entries[transcript.entries.length - 1];
    assert.equal(last.adminInjected, true);
    assert.match(last.text, /owe Rs 150/);

    const { buildAgentContextNote } = await import("./tools.ts");
    const note = await buildAgentContextNote({ senderPhone: phone });
    assert.match(note, /RECENT ADMIN DIRECTIVE/);
    assert.match(note, /owe Rs 150/);
  });
});


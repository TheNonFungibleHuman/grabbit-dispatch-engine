import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyOpsEvent,
  emptyOpsState,
  listTakeoverThreads,
  type OpsEvent,
} from "./model.ts";

function event(
  partial: Omit<OpsEvent, "id" | "at"> & { id?: string; at?: string },
): OpsEvent {
  return {
    id: partial.id ?? "e1",
    at: partial.at ?? "2026-08-10T12:00:00.000Z",
    phone: partial.phone,
    type: partial.type,
    messageId: partial.messageId,
    preview: partial.preview,
    error: partial.error,
  };
}

describe("ops model", () => {
  it("tracks inbound/outbound success and clears takeover after a good send", () => {
    let state = emptyOpsState();
    state = applyOpsEvent(
      state,
      event({
        phone: "+99900000028",
        type: "inbound_received",
        preview: "hello",
      }),
    );
    state = applyOpsEvent(
      state,
      event({
        phone: "99900000028",
        type: "outbound_failed",
        error: "protection",
        at: "2026-08-10T12:01:00.000Z",
      }),
    );

    assert.equal(state.stats.inbound, 1);
    assert.equal(state.stats.outboundFailed, 1);
    assert.equal(state.stats.needsTakeover, 1);
    assert.equal(listTakeoverThreads(state)[0]?.phone, "99900000028");
    assert.match(listTakeoverThreads(state)[0]?.takeoverReason ?? "", /protection/i);

    state = applyOpsEvent(
      state,
      event({
        phone: "99900000028",
        type: "outbound_sent",
        preview: "we are back",
        at: "2026-08-10T12:02:00.000Z",
      }),
    );

    assert.equal(state.stats.outboundSuccess, 1);
    assert.equal(state.threads["99900000028"]?.needsTakeover, false);
    assert.equal(state.stats.needsTakeover, 0);
  });

  it("marks agent failures in stats without takeover unless send also fails", () => {
    let state = emptyOpsState();
    state = applyOpsEvent(
      state,
      event({
        phone: "99900000012",
        type: "agent_failed",
        error: "gemini timeout",
      }),
    );
    assert.equal(state.stats.agentFailed, 1);
    assert.equal(state.threads["99900000012"]?.needsTakeover, false);

    state = applyOpsEvent(
      state,
      event({
        phone: "99900000012",
        type: "outbound_failed",
        error: "protection",
        at: "2026-08-10T12:01:00.000Z",
      }),
    );
    assert.equal(state.threads["99900000012"]?.needsTakeover, true);
  });
});

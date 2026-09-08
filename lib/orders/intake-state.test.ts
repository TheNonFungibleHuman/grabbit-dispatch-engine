import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractIntakeState } from "./intake-state.ts";
import type { TranscriptEntry } from "../agent/transcript.ts";

describe("extractIntakeState", () => {
  it("extracts route and time from a single customer message", () => {
    const entries: TranscriptEntry[] = [
      {
        at: new Date().toISOString(),
        role: "customer",
        text: "Hi, I need a ride from ALCHE Main Gate to Mahogany at 2:30 pm. I will pay cash.",
      },
    ];

    const state = extractIntakeState(entries);
    assert.equal(state.serviceKind, "trip");
    assert.equal(state.pickup, "ALCHE Main Gate");
    assert.equal(state.dropoff, "Mahogany Promenade");
    assert.equal(state.time, "2:30 pm");
    assert.equal(state.paymentMethod, "cash");
    assert.ok(state.summaryNote);
    assert.match(state.summaryNote, /Pickup=ALCHE Main Gate ✓/);
    assert.match(state.summaryNote, /Drop-off=Mahogany Promenade ✓/);
  });

  it("extracts parameters across multiple conversation turns without re-asking", () => {
    const entries: TranscriptEntry[] = [
      {
        at: new Date().toISOString(),
        role: "customer",
        text: "Can I get a ride to Mahogany Promenade?",
      },
      {
        at: new Date().toISOString(),
        role: "agent",
        text: "Sure! What time would you like to be picked up?",
      },
      {
        at: new Date().toISOString(),
        role: "customer",
        text: "12:45 pm from Songhai",
      },
    ];

    const state = extractIntakeState(entries);
    assert.equal(state.serviceKind, "trip");
    assert.equal(state.dropoff, "Mahogany Promenade");
    assert.equal(state.pickup, "Songhai Residence, ALCHE");
    assert.equal(state.time, "12:45 pm");
    assert.ok(state.summaryNote);
    assert.match(state.summaryNote, /Pickup=Songhai Residence, ALCHE ✓/);
    assert.match(state.summaryNote, /Time=12:45 pm ✓/);
  });

  it("extracts food delivery items and shop", () => {
    const entries: TranscriptEntry[] = [
      {
        at: new Date().toISOString(),
        role: "customer",
        text: "I want to order food from Pappagallo: 1x Spicy Meat Lovers Pizza to Aksum",
      },
    ];

    const state = extractIntakeState(entries);
    assert.equal(state.serviceKind, "delivery");
    assert.equal(state.pickup, "Pappagallo, Mahogany");
    assert.equal(state.dropoff, "Aksum Residence, ALCHE");
    assert.ok(state.packageDescription);
    assert.match(state.packageDescription, /Pizza/i);
  });
});

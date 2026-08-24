import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addAgentTokenUsage,
  getMetricsSnapshot,
  noteOutboundResult,
  recordMetric,
} from "./recorder.ts";
import { readJson, writeJson } from "../blob/json-store.ts";
import { addDaysIso, mauritiusDateIso } from "../time.ts";

describe("metrics recorder", () => {
  it("accumulates counters and token usage per Mauritius day", async () => {
    await recordMetric("test_counter", 2);
    await recordMetric("test_counter");
    await addAgentTokenUsage(120, 80);

    const snapshot = await getMetricsSnapshot(1);
    assert.equal(snapshot.totals.test_counter, 3);
    assert.ok(snapshot.tokens.prompt >= 120);
    assert.ok(snapshot.tokens.completion >= 80);
    assert.equal(snapshot.days.length, 1);
    assert.equal(snapshot.days[0].date, mauritiusDateIso());
  });

  it("alerts once at the failure threshold, honors cooldown, and recovers on success", async () => {
    const today = mauritiusDateIso();
    const path = `grabbit/metrics/${today}.json`;
    const seed = (await readJson<Record<string, unknown>>(path)) ?? {};
    seed.consecutiveOutboundFailures = 0;
    delete seed.lastOutboundAlertAt;
    seed.counters = { ...((seed.counters as Record<string, number>) ?? {}) };
    await writeJson(path, seed);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
      await noteOutboundResult(false);
      await noteOutboundResult(false);
      const afterTwo = await readJson<{ consecutiveOutboundFailures?: number; lastOutboundAlertAt?: string }>(path);
      assert.equal(afterTwo?.consecutiveOutboundFailures, 2);
      assert.ok(!afterTwo?.lastOutboundAlertAt, "two failures must not alert");

      await noteOutboundResult(false);
      const afterThird = await readJson<{ lastOutboundAlertAt?: string }>(path);
      assert.ok(afterThird?.lastOutboundAlertAt, "third consecutive failure must alert");

      const stampedAt = Date.parse(afterThird!.lastOutboundAlertAt!);
      await noteOutboundResult(false);
      const afterFourth = await readJson<{ lastOutboundAlertAt?: string; consecutiveOutboundFailures?: number }>(
        path,
      );
      assert.equal(Date.parse(afterFourth!.lastOutboundAlertAt!), stampedAt, "cooldown suppresses repeats");

      await noteOutboundResult(true);
      const recovered = await readJson<{ consecutiveOutboundFailures?: number }>(path);
      assert.equal(recovered?.consecutiveOutboundFailures, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aggregates multi-day windows", async () => {
    const today = mauritiusDateIso();
    const yesterdayPath = `grabbit/metrics/${addDaysIso(today, -1)}.json`;
    const prev = (await readJson<Record<string, unknown>>(yesterdayPath)) ?? {};
    prev.date = addDaysIso(today, -1);
    const counters = (prev.counters as Record<string, number>) ?? {};
    counters.window_probe = (counters.window_probe ?? 0) + 5;
    prev.counters = counters;
    await writeJson(yesterdayPath, prev);

    const snapshot = await getMetricsSnapshot(7);
    assert.ok((snapshot.totals.window_probe ?? 0) >= 5);
    assert.equal(snapshot.days.length, 7);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runHealthChecks } from "./checks.ts";
import { writeJson } from "../blob/json-store.ts";
import { mauritiusDateIso } from "../time.ts";

describe("health deep-checks", () => {
  it("returns a fully-formed posture report without throwing", async () => {
    const checks = await runHealthChecks();

    assert.equal(typeof checks.storage.supabaseConfigured, "boolean");
    assert.equal(typeof checks.storage.blobConfigured, "boolean");
    assert.ok(
      ["ok", "unconfigured", "unreachable", "error"].includes(checks.kilo),
      `unexpected kilo status ${checks.kilo}`,
    );
    assert.equal(typeof checks.agentConfigured, "boolean");
    assert.equal(typeof checks.whatsapp.configured, "boolean");
    assert.ok(checks.whatsapp.consecutiveSendFailures >= 0);
    if (!checks.whatsapp.configured) {
      assert.equal(checks.whatsapp.healthy, null);
    } else {
      assert.equal(typeof checks.whatsapp.healthy, "boolean");
    }
  });

  it("derives WhatsApp channel health from the send-failure streak", async () => {
    await writeJson(`grabbit/metrics/${mauritiusDateIso()}.json`, {
      consecutiveOutboundFailures: 5,
    });

    const degraded = await runHealthChecks();
    assert.equal(degraded.whatsapp.consecutiveSendFailures, 5);
    if (degraded.whatsapp.configured) {
      assert.equal(degraded.whatsapp.healthy, false);
    } else {
      assert.equal(degraded.whatsapp.healthy, null);
    }
  });
});

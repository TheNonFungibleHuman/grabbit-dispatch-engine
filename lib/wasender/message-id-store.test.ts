import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  claimInboundMessageId,
  completeInboundMessageId,
  resetMessageIdStoreForTests,
  INBOUND_DEDUP_STORE_PATH,
} from "./message-id-store.ts";

describe("inbound message claim lifecycle", () => {
  it("moves new → done and blocks duplicates", async () => {
    const id = `wamid.test.${Date.now()}`;
    assert.equal(await claimInboundMessageId(id), "new");
    assert.equal(await claimInboundMessageId(id), "in_flight");
    await completeInboundMessageId(id);
    assert.equal(await claimInboundMessageId(id), "done");
  });

  it("treats legacy numeric entries as already done", async () => {
    const { writeJson, readJson } = await import("../blob/json-store.ts");

    const legacyId = `wamid.legacy.${Date.now()}`;
    const store = (await readJson<{ ids: Record<string, unknown> }>(INBOUND_DEDUP_STORE_PATH)) ?? {
      ids: {},
    };
    store.ids[legacyId] = Date.now();
    await writeJson(INBOUND_DEDUP_STORE_PATH, store);

    resetMessageIdStoreForTests();
    assert.equal(await claimInboundMessageId(legacyId), "done");
  });

  it("reclaims stale in-flight claims so crashed handlers retry safely", async () => {
    const { writeJson, readJson } = await import("../blob/json-store.ts");
    const staleId = `wamid.stale.${Date.now()}`;

    const store = (await readJson<{ ids: Record<string, unknown> }>(INBOUND_DEDUP_STORE_PATH)) ?? {
      ids: {},
    };
    store.ids[staleId] = { s: "p", t: Date.now() - 120_000 };
    await writeJson(INBOUND_DEDUP_STORE_PATH, store);

    resetMessageIdStoreForTests();
    assert.equal(await claimInboundMessageId(staleId), "new");

    resetMessageIdStoreForTests();
    const updated = (await readJson<{ ids: Record<string, unknown> }>(INBOUND_DEDUP_STORE_PATH)) ?? {
      ids: {},
    };
    const entry = updated.ids[staleId] as { s: string; t: number };
    assert.equal(entry.s, "p");
    assert.ok(entry.t > Date.now() - 10_000);
  });
});

describe("registry freshness re-sync", () => {
  it("merges sibling-instance completions on stale cache reads", async () => {
    const { writeJson, readJson } = await import("../blob/json-store.ts");
    const id = `wamid.fresh.${Date.now()}`;

    process.env.GRABBIT_DEDUP_FRESH_MS = "0";
    resetMessageIdStoreForTests();

    assert.equal(await claimInboundMessageId(id), "new");

    const store = (await readJson<{ ids: Record<string, unknown> }>(INBOUND_DEDUP_STORE_PATH)) ?? {
      ids: {},
    };
    store.ids[id] = { s: "d", t: Date.now() };
    await writeJson(INBOUND_DEDUP_STORE_PATH, store);

    assert.equal(await claimInboundMessageId(id), "done");

    delete process.env.GRABBIT_DEDUP_FRESH_MS;
    resetMessageIdStoreForTests();
  });
});

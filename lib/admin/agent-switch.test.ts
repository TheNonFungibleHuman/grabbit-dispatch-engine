import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("agent switch defaults", () => {
  it("treats missing enabled as on (safe default for unconfigured blob)", () => {
    const stored: { enabled?: boolean } = {};
    const enabled = stored.enabled !== false;
    assert.equal(enabled, true);

    assert.equal(({ enabled: false } as { enabled?: boolean }).enabled !== false, false);
    assert.equal(({ enabled: true } as { enabled?: boolean }).enabled !== false, true);
  });
});

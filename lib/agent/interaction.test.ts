import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildFunctionResultInput,
  extractInteractionText,
  getFunctionCalls,
  summarizeInteraction,
} from "./interaction.ts";

describe("interaction steps schema", () => {
  it("reads function_call steps from the May 2026 schema", () => {
    const interaction = {
      id: "int_1",
      status: "requires_action",
      steps: [
        {
          type: "thought",
          summary: [{ type: "text", text: "Check Songhai" }],
        },
        {
          type: "function_call",
          id: "fc_1",
          name: "match_service_location",
          arguments: { query: "Songhai", role: "dropoff" },
        },
      ],
    };

    const calls = getFunctionCalls(interaction);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, "match_service_location");
    assert.equal(calls[0]?.id, "fc_1");
    assert.equal(extractInteractionText(interaction), "");
    assert.deepEqual(summarizeInteraction(interaction).stepTypes, [
      "thought",
      "function_call",
    ]);
  });

  it("extracts text from model_output steps when output_text is missing", () => {
    const interaction = {
      id: "int_2",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [{ type: "text", text: "Songhai is one of our spots." }],
        },
      ],
    };

    assert.equal(
      extractInteractionText(interaction),
      "Songhai is one of our spots.",
    );
  });

  it("still supports legacy outputs arrays", () => {
    const interaction = {
      id: "int_3",
      status: "requires_action",
      outputs: [
        {
          type: "function_call",
          id: "fc_legacy",
          name: "match_service_location",
          arguments: { query: "Library", role: "pickup" },
        },
      ],
    };

    const calls = getFunctionCalls(interaction);
    assert.equal(calls[0]?.id, "fc_legacy");
  });

  it("builds function_result input with call_id", () => {
    const payload = buildFunctionResultInput({
      name: "match_service_location",
      callId: "fc_1",
      result: { ok: true, matches: [] },
    });

    assert.equal(payload.type, "function_result");
    assert.equal(payload.call_id, "fc_1");
    assert.equal(payload.result[0]?.type, "text");
    assert.match(payload.result[0]?.text ?? "", /"ok":true/);
  });
});

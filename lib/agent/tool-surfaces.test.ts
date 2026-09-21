import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEEPSEEK_AGENT_TOOLS,
  getDeepSeekToolsForRole,
} from "./tools.ts";

const names = (tools: typeof DEEPSEEK_AGENT_TOOLS) => tools.map((t) => t.function.name);

describe("role-scoped tool surfaces (Phase 4)", () => {
  it("admin gets the full 21-tool surface", () => {
    const tools = getDeepSeekToolsForRole("admin");
    assert.equal(tools.length, DEEPSEEK_AGENT_TOOLS.length);
  });

  it("customers never see admin-only tools", () => {
    const customer = names(getDeepSeekToolsForRole("customer"));
    const adminOnly = [
      "preview_admin_broadcast",
      "execute_admin_broadcast",
      "admin_reply_to_customer",
      "set_fleet_maintenance_window",
      "admin_cancel_or_delete_booking",
      "clear_all_escalations",
      "admin_view_customer_chat",
      "post_summary_to_google_chat",
      "send_rider_broadcast_or_message",
      "mark_trip_paid_on_kilo",
      "update_booking_details",
    ];
    for (const tool of adminOnly) {
      assert.ok(!customer.includes(tool), `customer surface must not include ${tool}`);
    }
    // Core booking tools remain available.
    assert.ok(customer.includes("schedule_trip_or_delivery"));
    assert.ok(customer.includes("escalate_to_admin"));
  });

  it("riders get only their operational tools", () => {
    const rider = names(getDeepSeekToolsForRole("rider"));
    assert.deepEqual(
      [...rider].sort(),
      ["check_rider_assigned_trips", "escalate_to_admin", "notify_customer_of_rider_update"].sort(),
    );
  });

  it("customer surface is meaningfully smaller than admin", () => {
    assert.ok(getDeepSeekToolsForRole("customer").length <= 8);
  });
});

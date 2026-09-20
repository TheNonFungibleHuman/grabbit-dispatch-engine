#!/usr/bin/env node
/**
 * Eval runner — deterministic regression harness for the Grabbit agent.
 *
 * Runs the golden dataset against the pure decision layer and prints a
 * per-scenario report. Exits non-zero if any scenario fails.
 *
 * Usage: npm run eval
 */
import { GOLDEN_DATASET } from "./golden-dataset.ts";
import { runScenarios, type ScenarioResult } from "./runner.ts";

function report(results: ScenarioResult[]): number {
  let failedScenarios = 0;
  let failedTurns = 0;
  let totalTurns = 0;

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(" 🛵 GRABBIT AGENT — EVAL HARNESS");
  console.log("═══════════════════════════════════════════════════════════\n");

  for (const scenario of results) {
    totalTurns += scenario.turns.length;
    const icon = scenario.ok ? "✔" : "✖";
    const tag = scenario.incident ? ` [${scenario.incident}]` : "";
    console.log(`${icon} ${scenario.id} — ${scenario.title}${tag}`);
    for (const turn of scenario.turns) {
      if (!turn.ok) {
        failedTurns += 1;
        console.log(`    ✗ ${turn.label}`);
        if (turn.error) console.log(`      ${turn.error}`);
      }
    }
    if (!scenario.ok) failedScenarios += 1;
  }

  console.log("\n───────────────────────────────────────────────────────────");
  console.log(`Scenarios: ${results.length}  (passed ${results.length - failedScenarios}, failed ${failedScenarios})`);
  console.log(`Turns:     ${totalTurns}  (passed ${totalTurns - failedTurns}, failed ${failedTurns})`);
  console.log("───────────────────────────────────────────────────────────\n");

  if (failedScenarios > 0) {
    console.error("❌ Eval harness FAILED — regression(s) detected.\n");
    return 1;
  }
  console.log("✅ All scenarios passed.\n");
  return 0;
}

const results = runScenarios(GOLDEN_DATASET);
process.exit(report(results));

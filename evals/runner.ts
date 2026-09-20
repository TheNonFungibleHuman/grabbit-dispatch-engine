import assert from "node:assert/strict";
import type { Scenario, ScenarioTurn, TextMatcher } from "./scenario-types.ts";
import {
  isBareGreeting,
  isContentFreeMessage,
  isShortAcknowledgement,
  sanitizeWhatsAppText,
} from "../lib/agent/format.ts";
import {
  isDistinctShortReply,
  isIdenticalRecentReply,
  isNearDuplicateRecentReply,
  normalizeReplyText,
  textSimilarity,
} from "../lib/agent/reply-guard.ts";
import { customerDateLabel, resolveRelativeDateWord } from "../lib/time.ts";

export interface TurnResult {
  label: string;
  action: string;
  ok: boolean;
  expected?: string;
  actual?: string;
  error?: string;
}

export interface ScenarioResult {
  id: string;
  title: string;
  incident?: string;
  turns: TurnResult[];
  ok: boolean;
}

function applyMatcher(actual: string, matcher: TextMatcher): string | null {
  if ("contains" in matcher) {
    return actual.includes(matcher.contains)
      ? null
      : `expected to contain ${JSON.stringify(matcher.contains)}`;
  }
  if ("notContains" in matcher) {
    return actual.includes(matcher.notContains)
      ? `expected NOT to contain ${JSON.stringify(matcher.notContains)}`
      : null;
  }
  if ("matches" in matcher) {
    const re = new RegExp(matcher.matches, "i");
    return re.test(actual) ? null : `expected to match /${matcher.matches}/i`;
  }
  return actual === matcher.equals ? null : `expected ${JSON.stringify(matcher.equals)}`;
}

function runTurn(turn: ScenarioTurn): { result: unknown; text: string } {
  const now = turn.now ? new Date(turn.now) : new Date();
  switch (turn.action) {
    case "customerDateLabel": {
      const result = customerDateLabel(turn.dateIso ?? turn.input ?? "", now);
      return { result, text: String(result) };
    }
    case "resolveRelativeDateWord": {
      const result = resolveRelativeDateWord(turn.input ?? "", now);
      return { result, text: String(result) };
    }
    case "isBareGreeting": {
      const result = isBareGreeting(turn.input ?? "");
      return { result, text: String(result) };
    }
    case "isContentFreeMessage": {
      const result = isContentFreeMessage(turn.input ?? "");
      return { result, text: String(result) };
    }
    case "isShortAcknowledgement": {
      const result = isShortAcknowledgement(turn.input ?? "");
      return { result, text: String(result) };
    }
    case "sanitizeWhatsAppText": {
      const result = sanitizeWhatsAppText(turn.input ?? "");
      return { result, text: result };
    }
    case "normalizeReplyText": {
      const result = normalizeReplyText(turn.input ?? "");
      return { result, text: result };
    }
    case "textSimilarity": {
      const result = textSimilarity(turn.input ?? "", turn.previous ?? "");
      return { result, text: String(result) };
    }
    case "isNearDuplicateRecentReply": {
      const result = isNearDuplicateRecentReply(
        turn.input ?? "",
        turn.previous ? { text: turn.previous, at: now.getTime() - (turn.previousAgeMs ?? 0) } : null,
        now.getTime(),
      );
      return { result, text: String(result) };
    }
    case "isDistinctShortReply": {
      const result = isDistinctShortReply(turn.input ?? "", turn.previous ?? null);
      return { result, text: String(result) };
    }
    case "isIdenticalRecentReply": {
      const result = isIdenticalRecentReply(
        turn.input ?? "",
        turn.previous ? { text: turn.previous, at: now.getTime() } : null,
        now.getTime(),
      );
      return { result, text: String(result) };
    }
    case "evaluateSlotRules":
      throw new Error("evaluateSlotRules is exercised through lib/orders/pre-booking.test.ts; use it there.");
    default:
      throw new Error(`Unknown action: ${turn.action}`);
  }
}

export function runScenario(scenario: Scenario): ScenarioResult {
  const turns: TurnResult[] = [];
  for (const turn of scenario.turns) {
    try {
      const { result, text } = runTurn(turn);
      const failures: string[] = [];
      if (turn.expect.result !== undefined) {
        try {
          assert.deepStrictEqual(result, turn.expect.result);
        } catch {
          failures.push(`result: expected ${JSON.stringify(turn.expect.result)}, got ${JSON.stringify(result)}`);
        }
      }
      for (const matcher of turn.expect.text ?? []) {
        const failure = applyMatcher(text, matcher);
        if (failure) failures.push(`text ${failure} — got ${JSON.stringify(text)}`);
      }
      turns.push({
        label: turn.label,
        action: turn.action,
        ok: failures.length === 0,
        expected: JSON.stringify(turn.expect.result ?? turn.expect.text),
        actual: text,
        error: failures.join("; ") || undefined,
      });
    } catch (error) {
      turns.push({
        label: turn.label,
        action: turn.action,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    id: scenario.id,
    title: scenario.title,
    incident: scenario.incident,
    turns,
    ok: turns.every((t) => t.ok),
  };
}

export function runScenarios(scenarios: Scenario[]): ScenarioResult[] {
  return scenarios.map(runScenario);
}

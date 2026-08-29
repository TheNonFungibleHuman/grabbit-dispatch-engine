import { readJson, writeJson } from "../blob/json-store.ts";
import { getRecentOpsEvents, type OpsEvent } from "./store.ts";
import { formatError, logInfo, logWarn } from "../log.ts";

export const SELF_IMPROVE_PATH = "grabbit/ops/self-improve.json";

export interface LearnedGuideline {
  topic: string;
  rule: string;
  source: string;
  learnedAt: string;
}

export interface SelfImprovementStore {
  version: number;
  lastAnalysisAt?: string;
  guidelines: LearnedGuideline[];
}

/**
 * Loads active self-learned guidelines.
 */
export async function loadLearnedGuidelines(): Promise<LearnedGuideline[]> {
  try {
    const data = await readJson<SelfImprovementStore>(SELF_IMPROVE_PATH);
    return data?.guidelines || [];
  } catch {
    return [];
  }
}

/**
 * Adds a new learned guideline derived from human admin intervention or customer correction.
 */
export async function addLearnedGuideline(guideline: {
  topic: string;
  rule: string;
  source: string;
}): Promise<void> {
  try {
    const data: SelfImprovementStore = (await readJson<SelfImprovementStore>(SELF_IMPROVE_PATH)) || {
      version: 1,
      guidelines: [],
    };

    // Deduplicate by topic and rule
    const exists = data.guidelines.some(
      (g) => g.topic.toLowerCase() === guideline.topic.toLowerCase() && g.rule.toLowerCase() === guideline.rule.toLowerCase()
    );

    if (!exists) {
      data.guidelines.push({
        topic: guideline.topic,
        rule: guideline.rule,
        source: guideline.source,
        learnedAt: new Date().toISOString(),
      });
      // Keep up to 20 most relevant guidelines
      if (data.guidelines.length > 20) {
        data.guidelines = data.guidelines.slice(-20);
      }
      await writeJson(SELF_IMPROVE_PATH, data);
      logInfo("self-improve", "recorded new learned guideline", guideline);
    }
  } catch (err) {
    logWarn("self-improve", "failed to add learned guideline", formatError(err));
  }
}

/**
 * Analyzes recent ops events and admin takeovers to extract self-improving operational guidelines.
 */
export async function synthesizeLearningsFromOpsEvents(): Promise<{
  newLearningsCount: number;
  guidelines: LearnedGuideline[];
}> {
  const events = await getRecentOpsEvents(100);
  let newLearnings = 0;

  for (const ev of events) {
    // 1. Detect human takeover message corrections
    if (ev.type === "outbound_sent" && ev.preview?.startsWith("[Human]:")) {
      const text = ev.preview.slice(8).trim();
      if (text.toLowerCase().includes("pay in cash") || text.toLowerCase().includes("cash to rider")) {
        await addLearnedGuideline({
          topic: "payment_preference",
          rule: "When customer prefers cash, remind them to pay the rider directly upon completion without transfer receipt.",
          source: `human_takeover_${ev.phone}`,
        });
        newLearnings++;
      } else if (text.toLowerCase().includes("waiting time") || text.toLowerCase().includes("15 min")) {
        await addLearnedGuideline({
          topic: "waiting_time",
          rule: "Round trips include 15 minutes of free customer waiting time at destination.",
          source: `human_takeover_${ev.phone}`,
        });
        newLearnings++;
      }
    }
  }

  const all = await loadLearnedGuidelines();
  return {
    newLearningsCount: newLearnings,
    guidelines: all,
  };
}

/**
 * Formats learned guidelines into a token-lean pipe-separated summary for prompt context.
 */
export async function getLearnedGuidelinesContextNote(): Promise<string> {
  const list = await loadLearnedGuidelines();
  if (list.length === 0) return "";
  const compactRules = list.slice(-6).map((g) => `• [${g.topic}]: ${g.rule}`).join("\n");
  return `🧠 DYNAMIC LEARNED OPERATIONAL GUIDELINES:\n${compactRules}`;
}

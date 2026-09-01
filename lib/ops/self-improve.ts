import { readJson, writeJson } from "../blob/json-store.ts";
import { logInfo } from "../log.ts";

export const SELF_IMPROVE_PATH = "grabbit/ops/self-improve.json";

export interface LearnedGuideline {
  topic: string;
  rule: string;
  source: string;
  learnedAt: string;
}

export interface SelfImprovementStore {
  version: number;
  guidelines: LearnedGuideline[];
}

export async function loadLearnedGuidelines(): Promise<LearnedGuideline[]> {
  try {
    const data = await readJson<SelfImprovementStore>(SELF_IMPROVE_PATH);
    return data?.guidelines || [];
  } catch {
    return [];
  }
}

export async function addLearnedGuideline(guideline: {
  topic: string;
  rule: string;
  source: string;
}): Promise<void> {
  const data: SelfImprovementStore = (await readJson<SelfImprovementStore>(SELF_IMPROVE_PATH)) || {
    version: 1,
    guidelines: [],
  };

  const exists = data.guidelines.some(
    (g) => g.topic.toLowerCase() === guideline.topic.toLowerCase() && g.rule.toLowerCase() === guideline.rule.toLowerCase(),
  );

  if (!exists) {
    data.guidelines.push({
      ...guideline,
      learnedAt: new Date().toISOString(),
    });
    if (data.guidelines.length > 20) data.guidelines = data.guidelines.slice(-20);
    await writeJson(SELF_IMPROVE_PATH, data);
    logInfo("self-improve", "recorded new learned guideline", guideline);
  }
}

export async function getLearnedGuidelinesContextNote(): Promise<string> {
  const list = await loadLearnedGuidelines();
  if (list.length === 0) return "";
  const compactRules = list.slice(-6).map((g) => `• [${g.topic}]: ${g.rule}`).join("\n");
  return `🧠 DYNAMIC LEARNED OPERATIONAL GUIDELINES:\n${compactRules}`;
}

import { memoryClear, readJson, writeJson } from "../blob/json-store.ts";
import { logInfo } from "../log.ts";

export const AGENT_SWITCH_PATH = "grabbit/admin/agent-switch.json";

export interface AgentSwitchState {
  /** When false, inbound WhatsApp messages are not answered by the AI. */
  enabled: boolean;
  updatedAt: string;
}

const DEFAULT_STATE: AgentSwitchState = {
  enabled: true,
  updatedAt: new Date(0).toISOString(),
};

const FRESH_TTL_MS = 2_000;
let cache: { fetchedAt: number; state: AgentSwitchState } | null = null;

export function clearAgentSwitchCache(): void {
  cache = null;
  memoryClear(AGENT_SWITCH_PATH);
}

export async function getAgentSwitchState(args?: {
  bypassMemory?: boolean;
}): Promise<AgentSwitchState> {
  if (
    !args?.bypassMemory &&
    cache &&
    Date.now() - cache.fetchedAt < FRESH_TTL_MS
  ) {
    return cache.state;
  }

  if (args?.bypassMemory) {
    memoryClear(AGENT_SWITCH_PATH);
  }

  const stored = await readJson<Partial<AgentSwitchState>>(AGENT_SWITCH_PATH);
  const state: AgentSwitchState = {
    enabled: stored?.enabled !== false,
    updatedAt: stored?.updatedAt ?? DEFAULT_STATE.updatedAt,
  };
  cache = { fetchedAt: Date.now(), state };
  return state;
}

export async function isAgentEnabled(): Promise<boolean> {
  const state = await getAgentSwitchState({ bypassMemory: true });
  return state.enabled;
}

export async function setAgentEnabled(enabled: boolean): Promise<AgentSwitchState> {
  const state: AgentSwitchState = {
    enabled,
    updatedAt: new Date().toISOString(),
  };
  clearAgentSwitchCache();
  await writeJson(AGENT_SWITCH_PATH, state);
  cache = { fetchedAt: Date.now(), state };
  logInfo("admin", enabled ? "agent enabled" : "agent disabled", {
    updatedAt: state.updatedAt,
  });
  return state;
}

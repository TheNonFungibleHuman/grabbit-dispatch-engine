import { readJson, writeJson } from "../blob/json-store.ts";
import { formatError, logWarn } from "../log.ts";
import { addDaysIso, mauritiusDateIso } from "../time.ts";

const METRICS_DIR = "grabbit/metrics/";
const OUTBOUND_ALERT_THRESHOLD = 3;
const OUTBOUND_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

export interface DailyMetrics {
  date: string;
  counters: Record<string, number>;
  tokens: { prompt: number; completion: number };
  consecutiveOutboundFailures: number;
  lastOutboundAlertAt?: string;
}

function dayPath(dateIso: string): string {
  return `${METRICS_DIR}${dateIso}.json`;
}

async function loadDay(dateIso: string): Promise<DailyMetrics> {
  const stored = await readJson<Partial<DailyMetrics>>(dayPath(dateIso));
  return {
    date: dateIso,
    counters: stored?.counters ?? {},
    tokens: stored?.tokens ?? { prompt: 0, completion: 0 },
    consecutiveOutboundFailures: stored?.consecutiveOutboundFailures ?? 0,
    lastOutboundAlertAt: stored?.lastOutboundAlertAt,
  };
}

async function saveDay(metrics: DailyMetrics): Promise<void> {
  await writeJson(dayPath(metrics.date), metrics);
}

export async function recordMetric(key: string, n = 1): Promise<void> {
  try {
    const metrics = await loadDay(mauritiusDateIso());
    metrics.counters[key] = (metrics.counters[key] ?? 0) + n;
    await saveDay(metrics);
  } catch (err) {
    logWarn("metrics", "failed to record metric", { key, ...formatError(err) });
  }
}

export async function addAgentTokenUsage(promptTokens: number, completionTokens: number): Promise<void> {
  try {
    const metrics = await loadDay(mauritiusDateIso());
    metrics.tokens.prompt += promptTokens || 0;
    metrics.tokens.completion += completionTokens || 0;
    await saveDay(metrics);
  } catch (err) {
    logWarn("metrics", "failed to record token usage", formatError(err));
  }
}

export async function noteOutboundResult(ok: boolean): Promise<void> {
  try {
    const metrics = await loadDay(mauritiusDateIso());
    if (ok) {
      metrics.consecutiveOutboundFailures = 0;
      await saveDay(metrics);
      return;
    }
    metrics.consecutiveOutboundFailures += 1;
    const streak = metrics.consecutiveOutboundFailures;
    const cooledDown =
      !metrics.lastOutboundAlertAt ||
      Date.now() - Date.parse(metrics.lastOutboundAlertAt) > OUTBOUND_ALERT_COOLDOWN_MS;
    await saveDay(metrics);

    if (streak >= OUTBOUND_ALERT_THRESHOLD && cooledDown) {
      const fresh = await loadDay(mauritiusDateIso());
      if (
        !fresh.lastOutboundAlertAt ||
        Date.now() - Date.parse(fresh.lastOutboundAlertAt) > OUTBOUND_ALERT_COOLDOWN_MS
      ) {
        fresh.lastOutboundAlertAt = new Date().toISOString();
        await saveDay(fresh);
        logWarn("metrics", "outbound failure streak triggered admin alert", { streak });
        const { notifyAdminEscalation } = await import("../riders/notify-rider.ts");
        await notifyAdminEscalation({
          customerPhone: "system",
          customerName: "WhatsApp Send Pipeline",
          reason: `${streak} consecutive outbound WhatsApp sends failed. Delivery channel may be down — please check the Wasender session.`,
          recentContext: "Automated resilience alert from /lib/metrics",
        });
      }
    }
  } catch (err) {
    logWarn("metrics", "failed to note outbound result", formatError(err));
  }
}

export interface MetricsSnapshot {
  generatedAt: string;
  windowDays: number;
  totals: Record<string, number>;
  tokens: { prompt: number; completion: number };
  outboundFailureStreak: number;
  days: DailyMetrics[];
}

export async function getMetricsSnapshot(windowDays = 7): Promise<MetricsSnapshot> {
  const today = mauritiusDateIso();
  const days: DailyMetrics[] = [];
  for (let i = 0; i < windowDays; i++) {
    days.push(await loadDay(addDaysIso(today, -i)));
  }

  const totals: Record<string, number> = {};
  let prompt = 0;
  let completion = 0;
  for (const day of days) {
    for (const [key, value] of Object.entries(day.counters)) {
      totals[key] = (totals[key] ?? 0) + value;
    }
    prompt += day.tokens.prompt;
    completion += day.tokens.completion;
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    totals,
    tokens: { prompt, completion },
    outboundFailureStreak: days[0]?.consecutiveOutboundFailures ?? 0,
    days,
  };
}

import { readJson, writeJson } from "../blob/json-store.ts";
import { formatError, logWarn } from "../log.ts";
import { mauritiusDateIso } from "../time.ts";
import { reconcileOrphanedBookings } from "./booking-store.ts";

const SWEEP_STATE_PATH = "grabbit/ops/orphan-sweep.json";

export async function runDailyOrphanSweep(
  now = new Date(),
): Promise<{ ran: boolean; readmitted?: number }> {
  const todayIso = mauritiusDateIso(now);
  const state = await readJson<{ lastSweepDateIso?: string }>(SWEEP_STATE_PATH);
  if (state?.lastSweepDateIso === todayIso) {
    return { ran: false };
  }

  try {
    const result = await reconcileOrphanedBookings();
    await writeJson(SWEEP_STATE_PATH, {
      lastSweepDateIso: todayIso,
      scanned: result.scanned,
      readmitted: result.readmitted,
      sweptAt: new Date().toISOString(),
    });
    return { ran: true, readmitted: result.readmitted };
  } catch (err) {
    logWarn("orphan-sweep", "daily orphan sweep failed", formatError(err));
    return { ran: false };
  }
}

/**
 * src/jobs/retryStrandedQuarantine.ts
 *
 * Every 15 minutes: try again to remove a quarantine block from the FortiGates
 * that could not be reached when their asset was released (business rule 165,
 * `Asset.quarantineStranded`). Each entry carries its own backoff — 15 minutes,
 * doubling to a six-hour ceiling — so the tick is the granularity, not the
 * cadence: a gate that comes back after a maintenance window clears within
 * minutes, one that is gone for good costs four attempts a day until an
 * operator dismisses it.
 *
 * Web / all role only (imported under runsSchedulers in src/app.ts): it calls
 * devices, and one process must own that. On an install with nothing stranded
 * — the normal state — a tick is a single read that returns no rows.
 */

import { logger } from "../utils/logger.js";
import { retryAllStrandedQuarantine } from "../services/quarantineStrandedService.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 15 * 60 * 1000;

defineJob({
  name: "retryStrandedQuarantine",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: 3 * 60 * 1000,
  run: async () => {
    const r = await retryAllStrandedQuarantine();
    if (r.assets > 0) logger.info({ ...r }, "Retried stranded quarantine entries");
  },
});

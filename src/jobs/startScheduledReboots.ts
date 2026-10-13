/**
 * src/jobs/startScheduledReboots.ts
 *
 * Every 60 s: fire the reboots operators booked for now (business rule 115,
 * the rule-93 shape) — start them through `startReboot`, which re-takes every
 * gate, or record and email why not. Web/all role only (imported under
 * runsSchedulers): the reboot runner watches the device from this process
 * with `setImmediate`, and the boot sweep that fails orphaned runs lives on
 * the same role. A booking is claimed before it fires, so a retry never fires
 * it twice.
 *
 * Import this module from src/app.ts (startBackgroundJobs) to activate it.
 */

import { logger } from "../utils/logger.js";
import { runDueRebootSchedules } from "../services/rebootScheduleService.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 60 * 1000;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runInstrumentedJob("startScheduledReboots", async () => {
      const res = await runDueRebootSchedules();
      if (res.started + res.refused + res.missed > 0) logger.info(res, "scheduled reboots fired");
    });
  } catch (err: any) {
    logger.warn({ err: err?.message }, "startScheduledReboots job failed (non-fatal)");
  } finally {
    running = false;
  }
}

// Boot delay: after failOrphanedRebootRuns has swept what a restart left behind.
setTimeout(tick, 50_000);
setInterval(tick, INTERVAL_MS);

/**
 * src/jobs/startScheduledFirmwareUpgrades.ts
 *
 * Every 60 s: fire the firmware upgrades operators booked for now (business
 * rule 93) — start them through `startFirmwareUpgrade`, which re-takes every
 * rule-87 gate, or record and email why not. Web/all role only (imported under
 * runsSchedulers): the flash runs with `setImmediate` on the process that holds
 * the image on disk, so the starter must live there too. Best-effort: a failed
 * tick logs and retries next interval; a booking is claimed before it fires,
 * so a retry never fires it twice.
 *
 * Import this module from src/app.ts (startBackgroundJobs) to activate it.
 */

import { logger } from "../utils/logger.js";
import { runDueSchedules } from "../services/firmwareScheduleService.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 60 * 1000;
let running = false;

async function tick(): Promise<void> {
  if (running) return; // a slow SMTP send on a refusal must not stack ticks
  running = true;
  try {
    await runInstrumentedJob("startScheduledFirmwareUpgrades", async () => {
      const res = await runDueSchedules();
      if (res.started + res.refused + res.missed > 0) {
        logger.info(res, "scheduled firmware upgrades fired");
      }
    });
  } catch (err: any) {
    logger.warn({ err: err?.message }, "startScheduledFirmwareUpgrades job failed (non-fatal)");
  } finally {
    running = false;
  }
}

// Boot delay: after the DB is ready and after failOrphanedFirmwareRuns has
// swept the runs a restart left behind (it runs once at boot, on this role).
setTimeout(tick, 45_000);
setInterval(tick, INTERVAL_MS);

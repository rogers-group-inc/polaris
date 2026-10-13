/**
 * src/jobs/failOrphanedRebootRuns.ts
 *
 * Startup sweep: a reboot run (business rule 115) is watched from the web
 * process's memory, so one that was queued, sending or rebooting when the
 * process died can never finish. Mark each one failed, release its
 * maintenance hold, and say in the Event that the device needs checking.
 *
 * Deliberately NOT marker-guarded, like failOrphanedFirmwareRuns: a boot with
 * no orphans is one cheap indexed read. Web / all role only, where the runs
 * live.
 *
 * Import from src/app.ts to activate.
 */

import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";
import { failOrphanedRebootRuns } from "../services/rebootService.js";

async function sweep(): Promise<void> {
  try {
    await runInstrumentedJob("failOrphanedRebootRuns", async () => {
      const n = await failOrphanedRebootRuns();
      if (n > 0) logger.warn({ count: n }, "reboot runs orphaned by a restart were marked failed — check those devices");
    });
  } catch (err: any) {
    logger.error({ err: err?.message ?? String(err) }, "orphaned reboot run sweep failed");
  }
}

void sweep();

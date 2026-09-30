/**
 * src/jobs/failOrphanedFirmwareRuns.ts
 *
 * Startup sweep: a firmware upgrade run (business rule 87) is driven from the
 * web process's memory — the image is on this host's disk and there is no
 * queue — so a run that was queued or running when the process died can never
 * finish. Mark each one failed, release its maintenance hold, and say in the
 * Event that the device may still be flashing and needs checking by hand.
 *
 * Deliberately NOT marker-guarded: the answer is different on every boot, and
 * a boot with no orphans is one cheap indexed read (the partial index on
 * status). Runs on the web / all role only, where the runs live; a
 * split-role monitor process must not fail runs another process is driving.
 *
 * Import from src/app.ts to activate.
 */

import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";
import { failOrphanedFirmwareRuns } from "../services/firmwareUpgradeService.js";

async function sweep(): Promise<void> {
  try {
    await runInstrumentedJob("failOrphanedFirmwareRuns", async () => {
      const n = await failOrphanedFirmwareRuns();
      if (n > 0) logger.warn({ count: n }, "firmware upgrade runs orphaned by a restart were marked failed — verify those devices by hand");
    });
  } catch (err: any) {
    logger.error({ err: err?.message ?? String(err) }, "orphaned firmware run sweep failed");
  }
}

void sweep();

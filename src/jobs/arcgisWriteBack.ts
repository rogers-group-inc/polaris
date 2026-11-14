/**
 * src/jobs/arcgisWriteBack.ts
 *
 * 60-second drain of the cable-run write-back queue (business rule 185): every
 * pending run and tombstone goes to the ArcGIS layer of the one integration
 * with write-back on. The save of an edit session also pushes straight away
 * (cableRunService's routes → kickWriteBack); this tick catches what that
 * missed — ArcGIS unreachable, a restart, a retry of refused runs. When no
 * integration writes, a tick is one indexed query.
 *
 * syncWriteBack holds an advisory lock, so a push from the web role and this
 * tick never send the same run twice. Scheduler (discovery) role only.
 *
 * Import this module from src/app.ts to activate it.
 */

import { logger } from "../utils/logger.js";
import { syncWriteBack } from "../services/arcgisWriteBackService.js";
import { defineJob } from "./_defineJob.js";

defineJob({
  name: "arcgisWriteBack",
  intervalMs: 60 * 1000,
  firstRunDelayMs: 90_000,
  run: async () => {
    const r = await syncWriteBack();
    if (r.sent || r.deleted || r.failed) logger.debug(r, "arcgisWriteBack tick completed");
  },
});

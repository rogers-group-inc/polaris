/**
 * src/jobs/reconcileAppMapAutoMap.ts
 *
 * Periodic re-apply of the Application Map's auto-map selection — the mechanism
 * behind "and future assets too".
 *
 * Saving the selection applies it inline, so the operator sees pins land right
 * away. This tick is what catches everything that couldn't be known then: a host
 * built today, an agent installed an hour ago, a program that only just started
 * running and therefore only just appeared in the inventory the selection matches
 * against.
 *
 * 30 minutes rather than per-scrape: `persistAssetProcesses` /
 * `persistAssetServices` run per asset every few minutes, so hooking them would
 * turn one fleet reconcile into thousands. New pins showing up within half an hour
 * is the right trade for a monitoring surface.
 *
 * The apply is strictly additive and skips assets with nothing fresh, so a tick
 * with no new inventory writes nothing and logs nothing.
 *
 * defineJob (src/jobs/_defineJob.ts) skips a tick while the previous one is
 * still running, and logs a failed tick at error as { err, job }; it never throws.
 *
 * Import this module from src/app.ts to activate it.
 */

import { reconcileAutoMap } from "../services/appMapDiscoveryService.js";
import { logEvent } from "../services/eventLogService.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 30 * 60 * 1000;
const STARTUP_DELAY_MS = 120 * 1000;

defineJob({
  name: "reconcileAppMapAutoMap",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: STARTUP_DELAY_MS,
  run: async () => {
    const summary = await reconcileAutoMap();
    if (summary.devices > 0) {
      logEvent({
        action: "application_map.automap.reconciled",
        resourceType: "application_map",
        resourceId: "discovery",
        message:
          `Auto-map reconcile pinned ${summary.processPins} process(es) + ` +
          `${summary.servicePins} service(s) across ${summary.devices} device(s)`,
        details: summary,
      });
    }
  },
});

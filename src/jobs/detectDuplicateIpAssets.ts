/**
 * src/jobs/detectDuplicateIpAssets.ts
 *
 * Periodic duplicate-address sweep (also runs shortly after boot): raises,
 * refreshes and auto-closes the `duplicate-ip` Conflict flavour — two or more
 * network-present Assets recording the same `ipAddress`. Business rule 40; the
 * whole decision set (what counts as a current claim, what counts as two
 * devices, the dedup/suppression model) lives in
 * src/services/duplicateIpConflictService.ts.
 *
 * Why a sweep and not a write-time hook: an asset's IP is staged by ~17
 * projection write sites (discovery phases, agent pushes, sighting-driven
 * updates, the operator form), and a duplicate is a property of the FLEET
 * rather than of the write that created it — one grouped query answers it for
 * every address at once. At 2000 assets the scan is a single SQL statement
 * whose CTE narrows to duplicated addresses before returning anything, so the
 * result set is the collisions, not the fleet.
 *
 * Cadence: 10 minutes. A duplicate address is an outage-shaped problem that an
 * operator wants told about promptly, and the pass is one query plus writes
 * only on change (a clean fleet issues zero writes).
 */

import { logger } from "../utils/logger.js";
import { defineJob } from "./_defineJob.js";
import {
  reconcileDuplicateIpConflicts,
  logScanFailure,
} from "../services/duplicateIpConflictService.js";

const INTERVAL_MS = 10 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 45_000;

// Delayed first run: discovery and the monitor loops are still settling at
// boot, and a half-populated fleet is the one moment stale claims look current.
defineJob({
  name: "detectDuplicateIpAssets",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: FIRST_RUN_DELAY_MS,
  run: async () => {
    const result = await reconcileDuplicateIpConflicts();
    if (result.raised || result.closed || result.groups) {
      logger.info(result, "duplicate-ip conflict reconcile complete");
    }
  },
  onError: (err: any) => {
    logScanFailure(err);
  },
});

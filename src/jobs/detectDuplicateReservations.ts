/**
 * src/jobs/detectDuplicateReservations.ts
 *
 * Periodic duplicate-reservation sweep (also runs shortly after boot): raises,
 * refreshes and auto-closes the `duplicate-reservation` Conflict flavour — an
 * asset holding two or more DHCP reservations. Business rule 139; what counts
 * and the dedup model live in src/services/duplicateReservationConflictService.ts.
 *
 * Why a sweep: a reservation reaches an asset through its MAC list, and both
 * sides are written by many paths (discovery's reservation sync, the operator's
 * reserve / release, every MAC writer). Two queries answer it for the fleet —
 * the active gate bindings, then the MAC rows they name — and at 2000 assets
 * that is a few thousand narrow rows. Writes only on change.
 *
 * Cadence: 10 minutes, the duplicate-IP sweep's: discovery runs no faster, and
 * a stale reservation is an address problem, not an outage.
 */

import { logger } from "../utils/logger.js";
import { defineJob } from "./_defineJob.js";
import {
  reconcileDuplicateReservationConflicts,
  logScanFailure,
} from "../services/duplicateReservationConflictService.js";

const INTERVAL_MS = 10 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 50_000;

defineJob({
  name: "detectDuplicateReservations",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: FIRST_RUN_DELAY_MS,
  run: async () => {
    const result = await reconcileDuplicateReservationConflicts();
    if (result.raised || result.closed || result.refreshed) {
      logger.info(result, "duplicate-reservation conflict reconcile complete");
    }
  },
  onError: (err: any) => {
    logScanFailure(err);
  },
});

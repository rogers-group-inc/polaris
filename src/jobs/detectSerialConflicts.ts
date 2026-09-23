/**
 * src/jobs/detectSerialConflicts.ts
 *
 * Periodic serial-number sweep (also runs shortly after boot): raises,
 * refreshes and auto-closes both serial Conflict flavours — `serial-two-
 * controllers` (one managed device on two FortiGates' rosters) and
 * `duplicate-serial` (one serial on two Asset rows). Business rule 83; every
 * decision — what makes a serial usable, what folds an HA cluster into one
 * claimant, how long a claim stays current — lives in
 * src/services/duplicateSerialConflictService.ts.
 *
 * Why a sweep and not a write-time hook: the contested-claim flavour is only
 * visible ACROSS discovery runs. The second gate's claim is written by a
 * different integration's pass, often hours after the first, so the write that
 * creates the collision cannot see it — only a later read of the accumulated
 * claims can. The duplicate-record flavour is a fleet property for the same
 * reason duplicate-IP is, and is answered by one grouped query.
 *
 * Cadence: 30 minutes, three times slower than the duplicate-address sweep. A
 * contested serial is a correctness problem rather than an outage — the device
 * stays monitored throughout, its record just keeps changing owner — and the
 * evidence it reads only changes when an integration completes a discovery
 * run, which no install does every ten minutes. A clean fleet issues zero
 * writes beyond the claim prune.
 */

import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";
import {
  reconcileSerialConflicts,
  logScanFailure,
} from "../services/duplicateSerialConflictService.js";

const INTERVAL_MS = 30 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 90_000;

async function detectSerialConflicts(): Promise<void> {
  try {
    await runInstrumentedJob("detectSerialConflicts", async () => {
      const result = await reconcileSerialConflicts();
      if (result.raised || result.closed || result.contestedSerials || result.duplicateSerials) {
        logger.info(result, "serial conflict reconcile complete");
      }
    });
  } catch (err) {
    logScanFailure(err);
  }
}

// Delayed first run, and later than the duplicate-IP sweep's: this one reads
// claims that the boot-time discovery runs are still writing, and a pass that
// sees one gate's roster but not the other's would raise nothing anyway.
setTimeout(detectSerialConflicts, FIRST_RUN_DELAY_MS);
setInterval(detectSerialConflicts, INTERVAL_MS);

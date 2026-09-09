/**
 * src/jobs/platformLifecycleWatch.ts
 *
 * Scheduled job: re-observe the platform stack daily and emit a
 * `platform.lifecycle_changed` Event when its state has moved. This is the ONLY
 * caller of recordPlatformLifecycleTransition — the route deliberately is not,
 * because a lifecycle condition is true for months and letting a page load
 * re-fire the Event would let a browser refresh spam the on-call inbox.
 *
 * Daily rather than on the capacity cadence: the thing being watched moves on a
 * calendar, not on a workload. A version does not go end-of-life between two
 * ten-minute ticks.
 *
 * Import from src/app.ts to activate:
 *   await importJob("./jobs/platformLifecycleWatch.js");
 */

import {
  getPlatformLifecycle,
  recordPlatformLifecycleTransition,
  lifecycleStateIsFresh,
} from "../services/platformLifecycleService.js";
import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * +90s. After capacityWatch's first run (+60s) so the two do not contend for
 * the connection pool during boot, and late enough that TimescaleDB detection
 * has populated the extension version this reads from cache.
 */
const FIRST_RUN_DELAY_MS = 90_000;

async function runWatch(): Promise<void> {
  try {
    await runInstrumentedJob("platformLifecycleWatch", async () => {
      // Age guard, the same shape ouiRefresh uses. Without it a restart loop
      // re-fires the transition Event on every boot, which is exactly the
      // behaviour that makes an alerting channel worth ignoring.
      if (await lifecycleStateIsFresh()) {
        logger.debug("platform lifecycle state is fresh — skipping this run");
        return;
      }

      const result = await getPlatformLifecycle({ force: true });
      if (result.datasetError) {
        // Nothing to compare against; say so once rather than recording a
        // transition to a state we could not compute.
        logger.warn({ err: result.datasetError }, "platform lifecycle dataset unreadable — skipping transition check");
        return;
      }

      await recordPlatformLifecycleTransition(result);
      logger.info(
        {
          severity: result.severity,
          needsAttention: result.components.filter(
            (c) => c.grade.severity === "warning" || c.grade.severity === "critical",
          ).length,
          datasetReviewedAt: result.datasetReviewedAt,
        },
        "platform lifecycle check complete",
      );
    });
  } catch (err) {
    logger.error(err, "platform lifecycle watch failed");
  }
}

setTimeout(runWatch, FIRST_RUN_DELAY_MS);
setInterval(runWatch, INTERVAL_MS);

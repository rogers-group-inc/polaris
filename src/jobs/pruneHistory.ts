/**
 * src/jobs/pruneHistory.ts
 *
 * Daily retention for the tables that only ever grew (business rule 158):
 * cleared alerts and their delivery rows, sent quiet-time summaries, idle
 * automation state rows, finished discovery runs, FortiGate sightings past the
 * quarantine window, and finished Discovery scan runs. The windows and the
 * reasoning are in services/historyRetentionService.ts.
 *
 * Web / all role only (imported under runsSchedulers in src/app.ts), like
 * pruneEvents. The first run is five minutes after boot — late enough to stay
 * out of the way of startup, early enough that an install restarted nightly
 * still prunes. Each run is bounded, so an install with years of history
 * catches up over several runs rather than in one long transaction.
 */

import { logger } from "../utils/logger.js";
import { logEvent } from "../services/eventLogService.js";
import { pruneHistory } from "../services/historyRetentionService.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 24 * 60 * 60 * 1000;

defineJob({
  name: "pruneHistory",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: 5 * 60 * 1000,
  run: async () => {
    const { result, errors } = await pruneHistory();
    const total = Object.values(result).reduce((a, b) => a + b, 0);
    if (total > 0) logger.info({ ...result }, "Pruned history past its retention");
    // Deleting alert history is the one prune an operator may be asked about
    // later ("where did last year's alerts go"), so it is on the record.
    if (result.alerts > 0) {
      await logEvent({
        action: "alert_history.pruned",
        resourceType: "setting",
        resourceName: "alertHistoryRetention",
        actor: "system:retention",
        level: "info",
        message: `Deleted ${result.alerts} cleared alert${result.alerts === 1 ? "" : "s"} older than the alert history retention period`,
        details: { ...result },
      });
    }
    if (errors.length > 0) throw new Error(`history retention: ${errors.join("; ")}`);
  },
});

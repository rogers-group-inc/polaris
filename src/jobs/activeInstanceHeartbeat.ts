/**
 * src/jobs/activeInstanceHeartbeat.ts
 *
 * Re-stamps `Setting("ha.activeInstance")` every 30s with this host's name and
 * pid, so the database itself records which host is running the schedulers.
 * The boot-time counterpart (checkActiveInstanceConflict, called from
 * src/app.ts) refuses to start when a DIFFERENT hostname holds a fresh stamp —
 * the last line of defence against two app instances on one database. Rationale
 * and the three layers in front of it are in haHeartbeatService's header.
 *
 * Every 10th tick also samples pg_current_wal_lsn() into a 24h ring, which is
 * how an operator sizes the WAN link and the replication slot cap BEFORE
 * enabling HA — it starts collecting the day this ships, not the day the HA
 * tab is first opened.
 *
 * Web/all role only (imported under runsSchedulers), which is the same
 * single-instance surface the stamp is asserting. Best-effort throughout: a
 * failed tick logs and retries.
 *
 * Import this module from src/app.ts (startBackgroundJobs) to activate it.
 */

import { logger } from "../utils/logger.js";
import {
  stampActiveInstance,
  appendWalSample,
  isHeartbeatEnabled,
  HEARTBEAT_INTERVAL_MS,
  WAL_SAMPLE_EVERY_TICKS,
} from "../services/haHeartbeatService.js";
import { runInstrumentedJob } from "./_metrics.js";

let ticks = 0;

async function runActiveInstanceHeartbeat(): Promise<void> {
  try {
    await runInstrumentedJob("activeInstanceHeartbeat", async () => {
      await stampActiveInstance();
      ticks += 1;
      if (ticks % WAL_SAMPLE_EVERY_TICKS === 1) {
        // First tick included: one sample lands immediately after boot so a
        // freshly restarted host is not a 5-minute hole in the ring.
        await appendWalSample();
      }
    });
  } catch (err: any) {
    logger.warn({ err: err?.message }, "activeInstanceHeartbeat job failed (non-fatal)");
  }
}

// The stamp gates the OTHER host's boot, so claim it promptly rather than on a
// long boot delay — but leave a moment for the DB pool to come up.
if (isHeartbeatEnabled()) {
  setTimeout(runActiveInstanceHeartbeat, 5_000);
  setInterval(runActiveInstanceHeartbeat, HEARTBEAT_INTERVAL_MS);
} else {
  logger.debug("active-instance heartbeat disabled (non-production or POLARIS_HA_HEARTBEAT=off)");
}

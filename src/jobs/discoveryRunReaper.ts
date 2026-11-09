/**
 * src/jobs/discoveryRunReaper.ts
 *
 * 60-second reaper — clears orphaned DiscoveryRun rows so a crashed/restarted
 * discovery worker doesn't leave an integration stuck in `running` forever
 * (which would block re-triggering through triggerDiscovery's isRunActive
 * check).
 *
 * It reaps the ROW only. The pg-boss job the dead worker held is a separate
 * thing, and it is what occupies the polaris-discovery-run singleton slot:
 * that is released by the queue's job heartbeat (queueService ensureQueues)
 * or, on a cancel-watchdog force-exit, by the watchdog itself. A reaped row
 * with its job still `active` reads as "Discover queues, then errors" — the
 * prod 2026-10-01 incident.
 *
 * Marks any `queued`/`running` row whose `workerHeartbeatAt` is older than
 * REAP_STALE_AFTER_MS (or null with a `createdAt` older than the same window)
 * as `error`. The runDiscovery executor refreshes the heartbeat on a 60s
 * timer independently of progress, so a healthy run keeps it current; only a
 * dead/crashed worker stops heartbeating.
 *
 * defineJob (src/jobs/_defineJob.ts) skips a tick while the previous one is
 * still running, and logs a failed tick at error as { err, job }; it never throws. Pinned to the
 * `runsSchedulers` capability (web/all role) so it runs in exactly one process.
 *
 * Imported by src/app.ts's role-gated startBackgroundJobs to activate.
 */

import { reapStaleRuns } from "../services/discoveryRunState.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 60 * 1000;
// 3 missed 60s heartbeats with margin — a healthy run keeps it well under 60s
// stale, so 3 min as the orphan threshold catches a crashed worker within a
// minute of the third missed beat while never reaping a live one.
const REAP_STALE_AFTER_MS = 3 * 60 * 1000;

// Self-start on import (the role-gated dynamic import in app.ts is what
// determines whether this module loads at all — only web/all imports it).
defineJob({
  name: "discoveryRunReaper",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: 0,
  run: async () => {
    await reapStaleRuns(REAP_STALE_AFTER_MS);
  },
});

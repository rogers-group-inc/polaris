/**
 * src/jobs/capacityWatch.ts
 *
 * Scheduled job: builds a capacity snapshot every 10 minutes and records a
 * `capacity.severity_changed` / `capacity.severity_recovered` Event once a
 * severity change (ok ↔ watch ↔ warning ↔ critical, either direction) has
 * held for the configured alert hold.
 *
 * Business rule 105: this job is the ONE evaluator. The Maintenance tab's
 * routes grade capacity for display only; they never record a transition.
 * When they did, each graded with different inputs from this job (no
 * pg_settings read, no advisor gaps), so an admin page load and the next tick
 * disagreed about the same host and each wrote a transition the other undid.
 * The job therefore grades with the full inputs — the PostgreSQL tuning check
 * and the Capacity Advisor's gap reasons — exactly what /capacity-advisor
 * shows, so the alert and the page describe one severity.
 *
 * The alert flows out through the syslog/SFTP archival pipeline even when
 * nobody is logged in — the case where the DB is on the verge of dying and
 * the UI is moments from becoming unreachable.
 *
 * Import this module from src/app.ts to activate it.
 */

import { logger } from "../utils/logger.js";
import {
  getCapacitySnapshotWithAdvisor,
  recordCapacityTransition,
  CAPACITY_WATCH_INTERVAL_MS,
} from "../services/capacityService.js";
import { computePgTuning, pgTuningToAdvisorShape } from "../services/pgTuningService.js";
import { setDbPoolGauges, setCapacityGauges } from "../metrics.js";
import { runInstrumentedJob } from "./_metrics.js";

async function runCapacityWatch(): Promise<void> {
  try {
    await runInstrumentedJob("capacityWatch", async () => {
      // Three counts and one pg_settings read — cheap at any fleet size, and
      // without it the job could never see `pg_tuning_needed` while the page
      // could. The two-pass orchestrator also refreshes the Capacity Advisor
      // cache, so the Maintenance tab's first load does not wait on it, and
      // this 10-min tick is what warms the pg_stat_database rate baseline so
      // the first measured disk-I/O verdict lands.
      const tuning = await computePgTuning();
      const { snapshot: snap } = await getCapacitySnapshotWithAdvisor({
        pgTuningNeeded: tuning?.pgTuningNeeded ?? false,
        pgTuning: pgTuningToAdvisorShape(tuning),
      });
      await recordCapacityTransition(snap);
      setDbPoolGauges(snap.database.connectionPool);
      setCapacityGauges({
        severity: snap.severity,
        volumes: snap.appHost.volumes.map(v => ({
          volume: v.paths[0] ?? "(unknown)",
          roles: v.roles.join(","),
          freeBytes: v.freeBytes,
          totalBytes: v.totalBytes,
        })),
        sampleTables: snap.database.sampleTables.map(t => ({
          table: t.name,
          deadTupRatio: t.deadTupRatio,
        })),
        databaseSizeBytes: snap.database.sizeBytes,
        steadyStateSizeBytes: snap.workload.steadyStateSizeBytes,
      });
    });
  } catch (err: any) {
    logger.warn({ err: err?.message }, "capacityWatch job failed (non-fatal)");
  }
}

// Run once on startup after a short delay so the DB connection is ready, then
// every 10 minutes. The startup pass also establishes the baseline severity
// stored in the `capacity.lastSeverity` Setting on first boot.
setTimeout(runCapacityWatch, 60_000);
setInterval(runCapacityWatch, CAPACITY_WATCH_INTERVAL_MS);

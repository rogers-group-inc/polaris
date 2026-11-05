/**
 * src/jobs/scheduledBackup.ts
 *
 * Periodic scheduler: takes an automatic database backup on the operator's
 * cadence, prunes old scheduled copies to the retention count, and optionally
 * copies each finished backup to an off-host directory.
 *
 * Default-OFF (`backupSchedule.enabled === false`), so an upgrade never starts
 * writing gigabytes unasked and never competes with an enterprise backup product
 * that may already cover this Postgres instance. Server Settings → Maintenance →
 * Scheduled Backups is where it gets turned on.
 *
 * Runs on the SCHEDULER role only (like every other reconciler in this
 * directory), so a multi-process install takes one backup, not one per monitor
 * replica. Ticks every 5 minutes and asks the pure `isScheduledBackupDue` —
 * cheap, and it means a host that was down through its window backs up shortly
 * after boot instead of skipping a day.
 *
 * Import this module from src/app.ts to activate it:
 *   import "./jobs/scheduledBackup.js";
 */

import { logger } from "../utils/logger.js";
import { logEvent } from "../services/eventLogService.js";
import { defineJob } from "./_defineJob.js";
import { createBackup, listBackups, deleteBackup } from "../services/backupService.js";
import {
  getBackupSchedule,
  isScheduledBackupDue,
  recordScheduledBackupOutcome,
  copyBackupOffHost,
} from "../services/backupScheduleService.js";

const INTERVAL_MS = 5 * 60 * 1000;

/**
 * Delete the oldest SCHEDULED backups beyond the retention count.
 *
 * Scoped to `kind === "scheduled"` (id prefix `bk-scheduled-` on rows written
 * before `kind` existed): a scheduled cadence must never prune the manual backup
 * an operator took deliberately, or the pre-update recovery point.
 */
async function pruneScheduledBackups(retainCount: number): Promise<number> {
  const all = await listBackups(); // newest-first
  const scheduled = all.filter((b) => b.kind === "scheduled" || b.id.startsWith("bk-scheduled-"));
  const excess = scheduled.slice(retainCount);
  let pruned = 0;
  for (const b of excess) {
    try {
      await deleteBackup(b.id, "system:scheduled-backup");
      pruned++;
    } catch (err) {
      logger.warn({ err, backupId: b.id }, "scheduledBackup: could not prune an old scheduled backup");
    }
  }
  return pruned;
}

// Boot delay so migrations and the first-boot jobs have settled before a
// potentially long-running dump competes with them for the DB.
defineJob({
  name: "scheduledBackup",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: 120_000,
  run: async () => {
    const schedule = await getBackupSchedule();
    if (!isScheduledBackupDue(schedule, new Date())) return;

    logger.info(
      { intervalHours: schedule.intervalHours, retainCount: schedule.retainCount },
      "scheduledBackup: taking an automatic database backup",
    );

    let record;
    let path: string;
    try {
      ({ record, path } = await createBackup({
        password: schedule.passphrase,
        kind: "scheduled",
        actor: "system:scheduled-backup",
      }));
    } catch (err: any) {
      // A failing scheduled backup is exactly the kind of thing that stays
      // invisible until it matters, so it gets a warning Event (which flows
      // out through syslog/SFTP archival) as well as a log line and the
      // lastError the settings card renders.
      const detail = err?.message || String(err);
      await recordScheduledBackupOutcome({ ok: false, error: detail });
      await logEvent({
        level: "error",
        action: "server.backup.scheduled_failed",
        resourceType: "backup",
        actor: "system:scheduled-backup",
        message: `Scheduled database backup FAILED: ${detail}`,
        details: { error: detail },
      });
      logger.error({ err }, "scheduledBackup: backup failed");
      return;
    }

    // Off-host copy is best-effort: the local backup already succeeded, and an
    // unmounted or full share must not mark the run failed.
    if (schedule.copyToDir) {
      try {
        const dest = await copyBackupOffHost(path, record.filename, schedule.copyToDir);
        logger.info({ dest }, "scheduledBackup: copied backup off-host");
      } catch (err: any) {
        await logEvent({
          level: "warning",
          action: "server.backup.offhost_copy_failed",
          resourceType: "backup",
          resourceId: record.id,
          resourceName: record.filename,
          actor: "system:scheduled-backup",
          message: `Scheduled backup succeeded but the off-host copy to ${schedule.copyToDir} failed: ${err?.message || err}`,
          details: { copyToDir: schedule.copyToDir, error: String(err?.message || err) },
        });
        logger.warn({ err, copyToDir: schedule.copyToDir }, "scheduledBackup: off-host copy failed");
      }
    }

    const pruned = await pruneScheduledBackups(schedule.retainCount);
    await recordScheduledBackupOutcome({ ok: true });
    logger.info(
      { backupId: record.id, sizeBytes: record.size, pruned },
      "scheduledBackup: backup complete",
    );
  },
});

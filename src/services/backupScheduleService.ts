/**
 * src/services/backupScheduleService.ts — operator-configured automatic backups.
 *
 * Before this existed, the ONLY ways a Polaris database got backed up were an
 * operator clicking Backup on the Maintenance tab and the pre-update backup. No
 * job, no timer, no cron, and docs/INSTALL.md never told the operator to set one
 * up — so an install where nobody remembered to click had no recovery point at
 * all, and every copy that did exist sat on the same host (often the same
 * volume) as the database it protected.
 *
 * Shape: one `backupSchedule` Setting row.
 *   enabled       — default FALSE. Many sites already back this Postgres up with
 *                   an enterprise product; a new mechanism must not start
 *                   writing gigabytes on upgrade without being asked.
 *   intervalHours — 1..168 (a week). Simple interval rather than cron: the
 *                   reconciler is a tick, and "every N hours since the last
 *                   successful run" survives restarts without a cron parser.
 *   hourUtc       — optional 0..23. When set, runs are pinned to that UTC hour
 *                   so a daily backup lands in a maintenance window.
 *   retainCount   — how many SCHEDULED backups to keep on disk (1..50). Manual
 *                   and pre-update backups are never pruned by this.
 *   passphrase    — optional. Encrypts scheduled backups with the same
 *                   POLARIS\0 envelope as manual ones. Stored in this Setting
 *                   row, so it is masked on read like every other secret; see
 *                   the note in the ARCHITECTURE Operability section about
 *                   keeping the passphrase somewhere other than the host it
 *                   protects.
 *   copyToDir     — optional absolute path (a mounted share) that each finished
 *                   backup is COPIED to. This is the off-host half: without it,
 *                   losing the host loses the database and every backup of it.
 *
 * Deliberately not a MaintenanceSchedule-style recurrence: that vocabulary is
 * about asset windows, and a backup cadence needs none of it.
 */

import { makeFilePrivate } from "../utils/privateFiles.js";
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createSettingStore } from "./settingsStore.js";
import { AppError } from "../utils/errors.js";
import { SECRET_MASK, isMaskedSecret } from "../utils/secretMask.js";
import { validateBackupPassword } from "../utils/backupPassword.js";

export const BACKUP_SCHEDULE_SETTING_KEY = "backupSchedule";

export interface BackupSchedule {
  enabled: boolean;
  intervalHours: number;
  /** Pin runs to this UTC hour (0-23), or null for "any hour". */
  hourUtc: number | null;
  retainCount: number;
  /** Passphrase for scheduled backups, or null for unencrypted. */
  passphrase: string | null;
  /** Absolute directory each finished backup is copied to, or null. */
  copyToDir: string | null;
  /** ISO timestamp of the last SUCCESSFUL scheduled run (written by the job). */
  lastRunAt: string | null;
  /** Failure message from the most recent attempt, or null when it succeeded. */
  lastError: string | null;
}

export const MIN_INTERVAL_HOURS = 1;
export const MAX_INTERVAL_HOURS = 168;
export const MIN_RETAIN = 1;
export const MAX_RETAIN = 50;

export function defaultBackupSchedule(): BackupSchedule {
  return {
    enabled: false,
    intervalHours: 24,
    hourUtc: null,
    retainCount: 7,
    passphrase: null,
    copyToDir: null,
    lastRunAt: null,
    lastError: null,
  };
}

function parseBackupSchedule(raw: unknown): BackupSchedule {
  const d = defaultBackupSchedule();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    intervalHours: clampInt(r.intervalHours, MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS, d.intervalHours),
    hourUtc: typeof r.hourUtc === "number" && r.hourUtc >= 0 && r.hourUtc <= 23 ? Math.floor(r.hourUtc) : null,
    retainCount: clampInt(r.retainCount, MIN_RETAIN, MAX_RETAIN, d.retainCount),
    passphrase: typeof r.passphrase === "string" && r.passphrase.length > 0 ? r.passphrase : null,
    copyToDir: typeof r.copyToDir === "string" && r.copyToDir.trim().length > 0 ? r.copyToDir.trim() : null,
    lastRunAt: typeof r.lastRunAt === "string" ? r.lastRunAt : null,
    lastError: typeof r.lastError === "string" ? r.lastError : null,
  };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

const store = createSettingStore<BackupSchedule>({
  key: BACKUP_SCHEDULE_SETTING_KEY,
  ttlMs: 30_000,
  parse: parseBackupSchedule,
});

/** Full settings INCLUDING the passphrase — internal callers (the job) only. */
export async function getBackupSchedule(): Promise<BackupSchedule> {
  return store.get();
}

/** API-shaped read: the passphrase is replaced by the shared mask sentinel. */
export async function getBackupScheduleMasked(): Promise<BackupSchedule> {
  const s = await store.get();
  return { ...s, passphrase: s.passphrase ? SECRET_MASK : null };
}

export function invalidateBackupScheduleCache(): void {
  store.invalidate();
}

/**
 * Merge and persist operator input.
 *
 * Secret handling matches the Integration / Credential / NotificationChannel
 * convention: a masked passphrase round-tripped from the UI preserves the
 * stored value, an empty string clears it, and a new value is strength-checked
 * with the same floor manual backups use.
 */
export async function saveBackupSchedule(input: Partial<BackupSchedule>): Promise<BackupSchedule> {
  const current = await store.get();

  let passphrase = current.passphrase;
  if (input.passphrase !== undefined) {
    if (input.passphrase === null || input.passphrase === "") {
      passphrase = null;
    } else if (isMaskedSecret(input.passphrase)) {
      passphrase = current.passphrase; // untouched round-trip
    } else {
      try {
        passphrase = validateBackupPassword(input.passphrase);
      } catch (e: any) {
        throw new AppError(400, e?.message || "Invalid backup passphrase");
      }
    }
  }

  let copyToDir = current.copyToDir;
  if (input.copyToDir !== undefined) {
    const raw = (input.copyToDir ?? "").trim();
    if (!raw) {
      copyToDir = null;
    } else {
      // Relative paths would resolve against the service's cwd, which is not
      // something an operator can reason about. Require an absolute path.
      if (!isAbsolute(raw)) throw new AppError(400, "Off-host copy directory must be an absolute path");
      copyToDir = raw;
    }
  }

  const next: BackupSchedule = {
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    intervalHours: input.intervalHours !== undefined
      ? clampInt(input.intervalHours, MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS, current.intervalHours)
      : current.intervalHours,
    hourUtc: input.hourUtc !== undefined
      ? (input.hourUtc === null ? null : clampInt(input.hourUtc, 0, 23, current.hourUtc ?? 0))
      : current.hourUtc,
    retainCount: input.retainCount !== undefined
      ? clampInt(input.retainCount, MIN_RETAIN, MAX_RETAIN, current.retainCount)
      : current.retainCount,
    passphrase,
    copyToDir,
    // Run bookkeeping is owned by the job, never by operator input.
    lastRunAt: current.lastRunAt,
    lastError: current.lastError,
  };

  await store.save(next);
  return next;
}

/** Job-owned: record the outcome of an attempt without touching operator fields. */
export async function recordScheduledBackupOutcome(outcome: { ok: boolean; error?: string }): Promise<void> {
  const current = await store.get();
  await store.save({
    ...current,
    lastRunAt: outcome.ok ? new Date().toISOString() : current.lastRunAt,
    lastError: outcome.ok ? null : (outcome.error ?? "unknown error").slice(0, 500),
  });
}

/**
 * Is a scheduled backup due now?
 *
 * Pure so the cadence is unit-testable without a clock or a database. Rules:
 *   - disabled → never due
 *   - never run → due immediately (so enabling produces a recovery point now,
 *     rather than intervalHours from now)
 *   - otherwise due once intervalHours have elapsed since the last SUCCESS
 *   - when hourUtc is pinned, an otherwise-due run waits for that hour
 */
export function isScheduledBackupDue(schedule: BackupSchedule, now: Date): boolean {
  if (!schedule.enabled) return false;
  if (!schedule.lastRunAt) return true;

  const last = new Date(schedule.lastRunAt).getTime();
  if (!Number.isFinite(last)) return true;
  const elapsedHours = (now.getTime() - last) / 3_600_000;
  if (elapsedHours < schedule.intervalHours) return false;

  if (schedule.hourUtc !== null && now.getUTCHours() !== schedule.hourUtc) {
    // Overdue by a full extra interval means the pinned hour has been missed
    // (host was down, or the interval is shorter than a day) — run anyway
    // rather than waiting indefinitely for an hour that keeps being missed.
    return elapsedHours >= schedule.intervalHours * 2;
  }
  return true;
}

/**
 * Copy a finished backup to the operator's off-host directory.
 *
 * Best-effort by design: the local backup already succeeded, and a full or
 * unmounted share must not turn a good backup into a failed run. The caller
 * logs whatever this throws.
 */
export async function copyBackupOffHost(sourcePath: string, filename: string, copyToDir: string): Promise<string> {
  if (!existsSync(sourcePath)) throw new Error(`backup file ${sourcePath} vanished before the off-host copy`);
  await mkdir(copyToDir, { recursive: true });
  const dest = join(copyToDir, filename);
  await copyFile(sourcePath, dest);
  // Private where the share supports modes (rule 117); a share that does not
  // is the operator's mount options to set.
  makeFilePrivate(dest);
  return dest;
}

/**
 * src/services/updateService.ts — In-app update service
 *
 * Checks for new versions via git, runs the full update pipeline
 * (backup → pull → npm ci → tsc → prisma migrate → restart),
 * and tracks progress via a status file that survives restarts.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { getAppVersion } from "../utils/version.js";
import { deriveNginxServerName, derivePolarisPort } from "../utils/publicUrl.js";
import { renderNginxConfig } from "./nginxRenderer.js";
import { getProxyConfig, saveProxyConfig } from "./proxyConfigService.js";
import {
  defaultApiDocsSettings,
  deriveApiDocsNginxAllow,
  getApiDocsSettings,
} from "./apiDocsAccessService.js";
import { resolveDashPort } from "../utils/dashConfig.js";
import { createBackup } from "./backupService.js";

/**
 * Every shell-out in this file goes through `execAsync`, which is a thin
 * indirection over promisified `exec` rather than the promisified function
 * itself. Two reasons:
 *
 *  - applyUpdate is the highest-blast-radius path in the repo (git checkout,
 *    npm ci, prisma migrate deploy, systemd restart) and had no coverage beyond
 *    update-train selection. Its step SEQUENCING and its fail-and-stop contract
 *    at each gate are exactly what a test needs to pin, and neither is testable
 *    if the shell is hard-wired.
 *  - The indirection is one function call, so nothing about production behavior
 *    changes; `_setExecRunnerForTests(null)` restores the real runner.
 */
type ExecResult = { stdout: string; stderr: string };
export type ExecRunner = (cmd: string, opts?: Record<string, unknown>) => Promise<ExecResult>;

const _realExec = promisify(exec) as unknown as ExecRunner;
let _execRunner: ExecRunner = _realExec;

const execAsync: ExecRunner = (cmd, opts) => _execRunner(cmd, opts);

/** Test seam. Pass null to restore the real `exec`. */
export function _setExecRunnerForTests(fn: ExecRunner | null): void {
  _execRunner = fn ?? _realExec;
}

/** How much command output a failed step keeps for the operator. */
const STEP_ERROR_CHARS = 1500;

/** Per-step ceilings. Named so the enforced limit and the limit quoted in the
 *  failure message can never drift apart. A step that overruns is reported as a
 *  timeout, never as a command failure. */
const NPM_CI_TIMEOUT_MS = 15 * 60_000;
const PRISMA_GENERATE_TIMEOUT_MS = 2 * 60_000;
const BUILD_TIMEOUT_MS = 5 * 60_000;
const MIGRATE_TIMEOUT_MS = 5 * 60_000;

/**
 * Turn a rejected `execAsync` into the line an operator can actually act on.
 *
 * Two things this fixes, both learned from a prod update that failed
 * undiagnosably on 2026-09-08:
 *
 * 1. **Keep the TAIL, not the head.** Every step used
 *    `(err.stderr || err.message).slice(0, 500)`. npm writes its config and
 *    EBADENGINE warnings FIRST and its actual `npm error` lines LAST, so a
 *    500-char head is reliably all warnings and none of the cause — the failed
 *    step reported four `EBADENGINE` notices about Node versions and cut off
 *    mid-sentence, while the real reason was never shown. `npm ci` on that host
 *    then succeeded by hand, which is the signature of a timeout rather than a
 *    dependency problem.
 * 2. **Name a timeout as a timeout.** `child_process.exec` enforces `timeout`
 *    by SIGTERMing the child and rejecting with whatever output had accumulated
 *    — no error text of its own. The step therefore looked like a command
 *    failure with a confusing message instead of "this took longer than the
 *    limit". `npm ci` wipes node_modules before it installs, so a timeout kill
 *    leaves the host with NO dependencies while the running process keeps
 *    serving from already-loaded modules: the install is fine until the next
 *    restart, which then fails to boot. An operator has to be told that plainly.
 */
function stepFailureDetail(err: any, timeoutMs?: number): string {
  const killedByTimeout =
    err?.killed === true || err?.signal === "SIGTERM" || err?.code === "ETIMEDOUT";
  const out = String(err?.stderr || err?.stdout || err?.message || err || "").trim();
  const tail = out.length > STEP_ERROR_CHARS ? "…" + out.slice(-STEP_ERROR_CHARS) : out;
  if (killedByTimeout) {
    const secs = timeoutMs ? Math.round(timeoutMs / 1000) : null;
    return (
      `timed out${secs ? ` after ${secs}s` : ""} and was terminated` +
      ` — the command did not fail, it ran out of time. Re-running the update is safe and` +
      ` is usually faster (a warm npm cache turns a multi-minute install into seconds).` +
      (tail ? ` Last output: ${tail}` : "")
    );
  }
  return tail || "no output captured";
}

/**
 * Test seam: clear the in-flight guard.
 *
 * On the SUCCESS path `_applying` is deliberately never reset — the pipeline's
 * last act is to restart the service, so the flag dies with the process and a
 * second Apply cannot race the restart. Deliberately NOT folded into
 * clearUpdateStatus(), which is the operator-facing Dismiss button: clearing the
 * guard there would let someone dismiss a running update and start a second one
 * on top of it.
 */
export function _resetApplyingForTests(): void {
  _applying = false;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(__dirname, "..", "..");
const STATUS_FILE = join(APP_DIR, ".update-status.json");

// Git repository the in-app updater fetches/pulls from. Operators can point
// installs at a fork or internal mirror by setting POLARIS_UPDATE_REPO in .env.
// When set, the URL is applied to the `origin` remote before every fetch/pull
// (see ensureUpdateRemote), so all the downstream
// `origin/HEAD || origin/main || origin/master` plumbing keeps working
// unchanged. When UNSET, the install's existing `origin` is left untouched —
// i.e. it updates from whatever it was cloned from (the canonical upstream for
// a normal install, or a fork's own origin for a fork-based install).

/** The configured override, or null when POLARIS_UPDATE_REPO is unset/empty. */
function configuredUpdateRepo(): string | null {
  return (process.env.POLARIS_UPDATE_REPO || "").trim() || null;
}

/** Read the install's current `origin` remote URL (null if none / git fails). */
async function currentOriginUrl(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git remote get-url origin", {
      cwd: APP_DIR,
      timeout: 10000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The repo the updater will pull from, and where that choice comes from.
 * `source: "env"` → POLARIS_UPDATE_REPO is set and overrides origin;
 * `source: "origin"` → unset, so the existing `origin` remote is used as-is.
 * Surfaced on the Application Updates card so operators can see + trust it.
 */
export async function getUpdateRepoInfo(): Promise<{
  url: string | null;
  source: "env" | "origin";
}> {
  const env = configuredUpdateRepo();
  if (env) return { url: env, source: "env" };
  return { url: await currentOriginUrl(), source: "origin" };
}

/**
 * Point the `origin` remote at POLARIS_UPDATE_REPO before a fetch/pull. No-op
 * when the var is unset (leaves the install's cloned-from origin untouched).
 * Idempotent — only rewrites the URL when it differs from what git already
 * has. Non-fatal: a failure here just leaves the existing remote in place and
 * is logged.
 */
async function ensureUpdateRemote(): Promise<void> {
  const desired = configuredUpdateRepo();
  if (!desired) return; // unset → update from the existing origin as-is
  try {
    const current = await currentOriginUrl();
    if (current === desired) return;
    await execAsync(`git remote set-url origin "${desired}"`, {
      cwd: APP_DIR,
      timeout: 10000,
    });
    logger.info({ from: current, to: desired }, "In-app update: repointed origin remote to POLARIS_UPDATE_REPO");
  } catch (err: any) {
    // No origin remote yet, or set-url failed — add it. If even that fails,
    // leave whatever's there and let the fetch surface a clear error.
    try {
      await execAsync(`git remote add origin "${desired}"`, {
        cwd: APP_DIR,
        timeout: 10000,
      });
      logger.info({ to: desired }, "In-app update: added origin remote for POLARIS_UPDATE_REPO");
    } catch (addErr: any) {
      logger.warn(
        { err: err?.message, addErr: addErr?.message, desired },
        "In-app update: could not set origin remote URL — proceeding with existing remote",
      );
    }
  }
}

export interface UpdateStatus {
  state:
    | "idle"
    | "checking"
    | "available"
    | "up-to-date"
    | "applying"
    | "complete"
    | "failed"
    | "restarting"
    | "disabled";
  step?: string;
  steps?: { name: string; status: "pending" | "running" | "done" | "failed"; message?: string }[];
  error?: string;
  currentVersion?: string;
  latestVersion?: string;
  currentCommit?: string;
  latestCommit?: string;
  commitsBehind?: number;
  changes?: string[];
  backupFile?: string;
  startedAt?: string;
  completedAt?: string;
  // When state === "disabled": human-readable hint on how to update outside the app.
  method?: string;
  // Which update train this status reflects (nightly = branch tip, release =
  // latest release tag). Stamped on every checkForUpdates result.
  train?: UpdateTrain;
  // Release train only: the release tag the status is measured against.
  releaseTag?: string;
  // Informational note surfaced in the UI (e.g. release train with no tags yet).
  note?: string;
}

/**
 * Update train selector.
 *   - "nightly": track the tip of the update branch (every commit) — the
 *     historical default behavior.
 *   - "release": track the latest published release tag only, so operators on
 *     the release train receive vetted, tagged builds instead of every commit.
 * Persisted in the `update.train` Setting; defaults to "nightly".
 */
export type UpdateTrain = "nightly" | "release";

export async function getUpdateTrain(): Promise<UpdateTrain> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: "update.train" } });
    return row?.value === "release" ? "release" : "nightly";
  } catch {
    return "nightly";
  }
}

export async function setUpdateTrain(train: UpdateTrain): Promise<void> {
  const value: UpdateTrain = train === "release" ? "release" : "nightly";
  await prisma.setting.upsert({
    where: { key: "update.train" },
    update: { value },
    create: { key: "update.train", value },
  });
}

/**
 * Resolve the nightly-train comparison ref (the update branch tip): the first
 * of origin/HEAD → origin/main → origin/master that exists. Avoids the inline
 * `2>/dev/null || …` shell fallback chain (which doesn't behave on cmd.exe).
 */
async function resolveNightlyRef(): Promise<string> {
  for (const r of ["origin/HEAD", "origin/main", "origin/master"]) {
    try {
      await execAsync(`git rev-parse --verify --quiet ${r}`, { cwd: APP_DIR, timeout: 10000 });
      return r;
    } catch {
      // ref doesn't exist — try the next candidate
    }
  }
  return "origin/HEAD";
}

/**
 * The highest release tag by version sort, or null when none exist. A "release
 * tag" is any tag beginning with a digit or `v`+digit (e.g. `v1.0.0`, `1.2`).
 * The release train activates once the first such tag is published.
 */
async function latestReleaseTag(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `git tag --list --sort=-v:refname "v[0-9]*" "[0-9]*"`,
      { cwd: APP_DIR, timeout: 10000 },
    );
    const tags = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    return tags[0] || null;
  } catch {
    return null;
  }
}

/** True when HEAD is not on a branch (e.g. checked out at a release tag). */
async function isDetachedHead(): Promise<boolean> {
  try {
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
      cwd: APP_DIR,
      timeout: 10000,
    });
    return stdout.trim() === "HEAD";
  } catch {
    return false;
  }
}

/** The default branch name (origin/HEAD → main → master), for returning to the
 *  nightly train from a detached release checkout. */
async function resolveDefaultBranch(): Promise<string> {
  try {
    const { stdout } = await execAsync("git rev-parse --abbrev-ref origin/HEAD", {
      cwd: APP_DIR,
      timeout: 10000,
    });
    const branch = stdout.trim().replace(/^origin\//, "");
    if (branch && branch !== "HEAD") return branch;
  } catch {
    // fall through to the fixed candidates
  }
  for (const b of ["main", "master"]) {
    try {
      await execAsync(`git rev-parse --verify --quiet refs/heads/${b}`, {
        cwd: APP_DIR,
        timeout: 10000,
      });
      return b;
    } catch {
      // not a local branch — try next
    }
  }
  return "main";
}

/**
 * Compare the installed code (HEAD) against a target ref (a branch tip for
 * nightly, a tag for release) and derive the version + change list. Avoids the
 * `^{commit}` / `2>/dev/null` shell idioms that misbehave on cmd.exe.
 */
async function computeTargetInfo(ref: string): Promise<{
  currentCommit: string;
  latestCommit: string;
  commitsBehind: number;
  changes: string[];
  version: string;
}> {
  const { stdout: localFull } = await execAsync("git rev-list -n 1 HEAD", { cwd: APP_DIR });
  const currentCommit = localFull.trim().slice(0, 7);
  const { stdout: remoteFull } = await execAsync(`git rev-list -n 1 ${ref}`, { cwd: APP_DIR });
  const latestCommit = remoteFull.trim().slice(0, 7);

  let commitsBehind = 0;
  let changes: string[] = [];
  if (currentCommit !== latestCommit) {
    try {
      const { stdout: behindStr } = await execAsync(`git rev-list --count HEAD..${ref}`, {
        cwd: APP_DIR,
      });
      commitsBehind = parseInt(behindStr.trim(), 10) || 0;
    } catch {}
    try {
      const { stdout: logStr } = await execAsync(`git log --oneline HEAD..${ref}`, {
        cwd: APP_DIR,
      });
      changes = logStr.trim().split("\n").filter(Boolean);
    } catch {}
  }

  let version = "unknown";
  try {
    const { stdout: pkg } = await execAsync(`git show ${ref}:package.json`, { cwd: APP_DIR });
    const pkgVersion = JSON.parse(pkg).version || "0.9.0";
    const [rMajor, rMinor] = pkgVersion.split(".");
    const { stdout: count } = await execAsync(`git rev-list --count ${ref}`, { cwd: APP_DIR });
    version = computeVersion(`${rMajor}.${rMinor}`, count.trim());
  } catch {}

  return { currentCommit, latestCommit, commitsBehind, changes, version };
}

let _status: UpdateStatus = { state: "idle" };
let _applying = false;

// In-app updates rely on a writable git checkout at APP_DIR. Detect deployments
// where that's missing — most commonly the Docker image, where the runtime
// stage doesn't ship git or a .git tree — and surface a friendlier "disabled"
// status instead of letting `git fetch` fail with a generic ENOENT.
//
// Computed once at module load — neither signal changes at runtime.
const _updateEnvironment = (function detectUpdateEnvironment(): {
  available: boolean;
  reason?: string;
  method?: string;
} {
  const inDocker = existsSync("/.dockerenv");
  const hasGitDir = existsSync(join(APP_DIR, ".git"));

  if (!hasGitDir) {
    if (inDocker) {
      return {
        available: false,
        reason: "In-app updates are disabled in Docker.",
        method:
          "To update, pull the latest image and recreate the container. " +
          "Data and settings persist on the mounted state volume.",
      };
    }
    return {
      available: false,
      reason: "In-app updates are disabled — no git checkout at the install path.",
      method: "Update by reinstalling the application package.",
    };
  }
  return { available: true };
})();

function disabledStatus(): UpdateStatus {
  return {
    state: "disabled",
    currentVersion: readCurrentVersion(),
    error: _updateEnvironment.reason,
    method: _updateEnvironment.method,
  };
}

function readPackageMinor(): string {
  try {
    for (const rel of ["../../package.json", "../package.json"]) {
      const p = join(__dirname, rel);
      if (existsSync(p)) {
        const v = JSON.parse(readFileSync(p, "utf-8")).version || "0.9.0";
        const [major, minor] = v.split(".");
        return `${major}.${minor}`;
      }
    }
  } catch {}
  return "0.9";
}

function computeVersion(majorMinor: string, commitCount: string | number): string {
  return `${majorMinor}.${commitCount}`;
}

// Running-process version is derived once at startup by src/utils/version.ts;
// re-exporting under the original local name keeps the rest of this file
// unchanged and keeps the "latest version" computation below (which still
// uses readPackageMinor + computeVersion against an upstream commit count)
// independent of the cached running-process value.
const readCurrentVersion = getAppVersion;

function saveStatus() {
  try {
    writeFileSync(STATUS_FILE, JSON.stringify(_status, null, 2));
  } catch (err) {
    logger.warn({ err }, "Failed to write update status file");
  }
}

function loadStatusFromDisk(): UpdateStatus | null {
  try {
    if (existsSync(STATUS_FILE)) {
      return JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
    }
  } catch {}
  return null;
}

/**
 * On server startup, check if we just restarted after an update.
 */
export function initUpdateStatus() {
  const saved = loadStatusFromDisk();
  if (saved && saved.state === "restarting") {
    saved.state = "complete";
    saved.completedAt = new Date().toISOString();
    saved.latestVersion = readCurrentVersion();
    // Mark all steps done
    if (saved.steps) {
      saved.steps.forEach((s) => {
        if (s.status === "running" || s.status === "pending") s.status = "done";
      });
    }
    _status = saved;
    saveStatus();
    logger.info(
      { from: saved.currentVersion, to: saved.latestVersion },
      "Update completed after restart"
    );
  } else if (saved && (saved.state === "complete" || saved.state === "failed")) {
    _status = saved;
  }
}

export function getUpdateStatus(): UpdateStatus {
  if (!_updateEnvironment.available) return disabledStatus();
  return { ..._status, steps: _status.steps ? [..._status.steps] : undefined };
}

export function isUpdateMechanismAvailable(): boolean {
  return _updateEnvironment.available;
}

export function clearUpdateStatus() {
  _status = { state: "idle" };
  try {
    if (existsSync(STATUS_FILE)) unlinkSync(STATUS_FILE);
  } catch {}
}

/**
 * Return the most recent commits on the installed code (`git log` on HEAD).
 * Used by the Application Updates card to show "what's been applied" history.
 */
export async function getRecentCommits(
  limit = 20
): Promise<{ hash: string; date: string; subject: string }[]> {
  const n = Math.max(1, Math.min(100, Math.floor(limit) || 20));
  try {
    const { stdout } = await execAsync(
      `git log -n ${n} --pretty=format:%h%x09%ad%x09%s --date=short`,
      { cwd: APP_DIR, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const t1 = line.indexOf("\t");
        const t2 = line.indexOf("\t", t1 + 1);
        if (t1 === -1 || t2 === -1) return { hash: line, date: "", subject: "" };
        return {
          hash: line.slice(0, t1),
          date: line.slice(t1 + 1, t2),
          subject: line.slice(t2 + 1),
        };
      });
  } catch {
    return [];
  }
}

/**
 * Check if a newer version is available on the remote.
 */
export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!_updateEnvironment.available) {
    _status = disabledStatus();
    return _status;
  }
  const train = await getUpdateTrain();
  _status = { state: "checking", currentVersion: readCurrentVersion(), train };

  try {
    // Make sure origin points at the configured update repo (POLARIS_UPDATE_REPO)
    // before fetching. Fetch branches AND tags so both trains have fresh refs.
    await ensureUpdateRemote();
    await execAsync("git fetch --all --tags --prune", { cwd: APP_DIR, timeout: 30000 });

    // Resolve the comparison target: the update branch tip (nightly) or the
    // latest release tag (release).
    let ref: string;
    let releaseTag: string | undefined;
    if (train === "release") {
      const tag = await latestReleaseTag();
      if (!tag) {
        // Release train, but nothing tagged yet — report up-to-date with a note
        // rather than an error. Activates automatically once a release is cut.
        _status = {
          state: "up-to-date",
          currentVersion: readCurrentVersion(),
          commitsBehind: 0,
          train,
          note:
            "No published releases yet. The release train will offer an update " +
            "once the first release is tagged.",
        };
        return _status;
      }
      ref = tag;
      releaseTag = tag;
    } else {
      ref = await resolveNightlyRef();
    }

    const info = await computeTargetInfo(ref);

    if (info.currentCommit === info.latestCommit) {
      _status = {
        state: "up-to-date",
        currentVersion: readCurrentVersion(),
        currentCommit: info.currentCommit,
        latestCommit: info.latestCommit,
        latestVersion: info.version,
        commitsBehind: 0,
        train,
        releaseTag,
      };
      return _status;
    }

    _status = {
      state: "available",
      currentVersion: readCurrentVersion(),
      latestVersion: info.version,
      currentCommit: info.currentCommit,
      latestCommit: info.latestCommit,
      commitsBehind: info.commitsBehind,
      changes: info.changes,
      train,
      releaseTag,
    };
    return _status;
  } catch (err: any) {
    _status = {
      state: "failed",
      error: "Failed to check for updates: " + (err.message || String(err)),
      currentVersion: readCurrentVersion(),
      train,
    };
    return _status;
  }
}

/**
 * Apply the available update. Runs asynchronously in the background.
 *
 * @param password Optional AES-256-GCM password for encrypting the pre-update
 *                 database backup. When set, the backup is wrapped in the same
 *                 POLARIS\0 envelope used by manual backups so the existing
 *                 restore flow accepts it.
 * @param allowWithoutBackup Proceed even if the pre-update backup fails. Default
 *                 false, which ABORTS the update instead — a failed backup means
 *                 the irreversible `prisma migrate deploy` ahead has no rollback
 *                 point. The Apply endpoint only sets this when the operator has
 *                 explicitly confirmed it.
 */
export async function applyUpdate(
  password?: string | null,
  allowWithoutBackup = false,
): Promise<void> {
  if (!_updateEnvironment.available) {
    _status = disabledStatus();
    return;
  }
  if (_applying) return;
  _applying = true;

  const train = await getUpdateTrain();

  const steps: NonNullable<UpdateStatus["steps"]> = [
    { name: "Backup database", status: "pending", message: "" },
    { name: "Pull latest code", status: "pending", message: "" },
    { name: "Install dependencies", status: "pending", message: "" },
    { name: "Generate Prisma client", status: "pending", message: "" },
    { name: "Build TypeScript", status: "pending", message: "" },
    { name: "Run migrations", status: "pending", message: "" },
    { name: "Restart service", status: "pending", message: "" },
  ];

  _status = {
    state: "applying",
    currentVersion: readCurrentVersion(),
    currentCommit: _status.currentCommit,
    latestVersion: _status.latestVersion,
    latestCommit: _status.latestCommit,
    commitsBehind: _status.commitsBehind,
    changes: _status.changes,
    startedAt: new Date().toISOString(),
    steps,
  };
  saveStatus();

  function setStep(idx: number, status: "running" | "done" | "failed", message?: string) {
    steps[idx].status = status;
    if (message) steps[idx].message = message;
    _status.steps = steps;
    saveStatus();
  }

  function failUpdate(idx: number, error: string) {
    setStep(idx, "failed", error);
    _status.state = "failed";
    _status.error = error;
    saveStatus();
    _applying = false;
  }

  try {
    // ── Step 1: Backup database ──
    // Delegates to services/backupService.ts (streamed pg_dump → gzip →
    // optional cipher → file, connection via PG* env vars, Timescale-aware
    // restore on the way back). It also registers the file in backup_history so
    // the Maintenance tab shows it with a Download button.
    setStep(0, "running");
    const skipBackupSetting = await prisma.setting.findUnique({ where: { key: "update.skip_backup" } });
    if (skipBackupSetting?.value === true) {
      setStep(0, "done", "Backup skipped (disabled in settings)");
    } else {
      try {
        const { record } = await createBackup({
          password: password && password.length > 0 ? password : null,
          kind: "pre-update",
          actor: "system:update",
        });
        _status.backupFile = record.filename;
        setStep(0, "done", `Backup created (${Math.round(record.size / 1024)} KB${record.encrypted ? ", encrypted" : ""})`);
      } catch (err: any) {
        // FATAL by default. This used to call setStep(0, "done", "Backup
        // skipped: ...") and continue: the update then ran `git pull`, `npm ci`
        // and `prisma migrate deploy` with no rollback point, while the
        // Application Updates card showed step 1 as a completed green step.
        // Migrations are not reversible, so a silently-missing backup is the
        // difference between a bad update and an unrecoverable one.
        //
        // Two deliberate ways to proceed without a backup, both explicit:
        //   - the `update.skip_backup` Setting (handled above), or
        //   - allowWithoutBackup on this call, which the Apply endpoint only
        //     sets when the operator ticks the confirmation checkbox.
        const detail = err?.message || "pg_dump not available";
        if (!allowWithoutBackup) {
          failUpdate(0, `Pre-update backup failed: ${detail}. Fix the backup path, or re-run the update with "proceed without a backup" ticked if you accept the risk.`);
          logger.error({ err }, "Pre-update backup failed — update aborted");
          return;
        }
        setStep(0, "failed", `Backup failed, proceeding anyway (operator override): ${detail}`);
        logger.warn({ err }, "Pre-update backup failed — continuing because allowWithoutBackup was set");
      }
    }

    // ── Step 2: Pull latest code ──
    setStep(1, "running");
    try {
      // Ensure origin points at the configured update repo (POLARIS_UPDATE_REPO)
      // before pulling — covers the case where applyUpdate runs without a
      // preceding checkForUpdates, or the env changed since the last check.
      await ensureUpdateRemote();
      await execAsync("git checkout -- package-lock.json", {
        cwd: APP_DIR,
        timeout: 10000,
      }).catch(() => {});
      if (train === "release") {
        // Release train: check out the latest release tag (detached HEAD).
        // Moving HEAD in either direction is fine — an operator switching from
        // nightly to release may be checking out an earlier tagged commit.
        await execAsync("git fetch --all --tags --prune", {
          cwd: APP_DIR,
          timeout: 60000,
        });
        const tag = await latestReleaseTag();
        if (!tag) {
          failUpdate(1, "No release tags found — nothing to install on the release train.");
          return;
        }
        await execAsync(`git checkout --detach ${tag}`, {
          cwd: APP_DIR,
          timeout: 60000,
        });
        setStep(1, "done", `Checked out release ${tag}`);
      } else {
        // Nightly train: fast-forward the current branch. If HEAD is detached
        // (we were previously on the release train), return to the default
        // branch first so `git pull` has an upstream to track.
        if (await isDetachedHead()) {
          const branch = await resolveDefaultBranch();
          await execAsync(`git checkout ${branch}`, { cwd: APP_DIR, timeout: 30000 });
        }
        const { stdout } = await execAsync("git pull --ff-only", {
          cwd: APP_DIR,
          timeout: 60000,
        });
        setStep(1, "done", stdout.trim().split("\n").pop() || "Updated");
      }
    } catch (err: any) {
      failUpdate(1, "git update failed: " + (err.stderr || err.message));
      return;
    }

    // ── Step 3: Install dependencies ──
    setStep(2, "running");
    try {
      await execAsync("npm ci --production=false", {
        cwd: APP_DIR,
        // 15 min, not 5. `npm ci` always deletes node_modules and reinstalls
        // every package (~615 here), so a COLD npm cache means downloading the
        // whole tree — minutes on a modest host, and the 5-minute ceiling
        // SIGTERMed it mid-install on prod (2026-09-08), leaving that host with
        // no node_modules at all. The step is idempotent and the pipeline stops
        // on failure either way, so a generous ceiling costs nothing; a tight
        // one costs an install.
        timeout: NPM_CI_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
      setStep(2, "done");
    } catch (err: any) {
      failUpdate(
        2,
        "npm ci failed: " + stepFailureDetail(err, NPM_CI_TIMEOUT_MS) +
          " — dependencies on this host are now INCOMPLETE (npm ci removes node_modules" +
          " before installing). The running service keeps working from modules already" +
          " loaded in memory, but do not restart it until an install succeeds.",
      );
      return;
    }

    // ── Step 4: Generate Prisma client ──
    // Explicit step — don't rely on `npm ci` postinstall having fired. A
    // partially-failed `npm ci` (transient network blip, future `--ignore-scripts`,
    // etc.) leaves the generated client stale, then step 6's `migrate deploy`
    // drops columns the running client still selects → every Asset read/write
    // crashes with `column "<name>" does not exist`.
    setStep(3, "running");
    try {
      await execAsync("npx prisma generate", { cwd: APP_DIR, timeout: PRISMA_GENERATE_TIMEOUT_MS });
      setStep(3, "done");
    } catch (err: any) {
      failUpdate(3, "Prisma generate failed: " + stepFailureDetail(err, PRISMA_GENERATE_TIMEOUT_MS));
      return;
    }

    // ── Step 5: Build TypeScript ──
    // Clean `dist/` first so stale compiled JS from a previous build (e.g.
    // generated-client files Prisma renamed between versions) can't shadow
    // the fresh tsc output. tsc itself is non-destructive — without this,
    // a file that exists in `dist/` but no longer in `src/` lingers forever.
    //
    // Build via `npm run build` (not bare `npx tsc`) so the post-tsc asset
    // copy in scripts/copy-build-assets.mjs runs — it mirrors the bundled
    // std MIB .txt files into dist/services/stdMibs/, which tsc won't emit.
    // Without that, every std SNMP-walk (LLDP-MIB etc.) on the updated
    // install fails with "Standard MIB ... is not installed on the server".
    setStep(4, "running");
    try {
      const distDir = join(APP_DIR, "dist");
      if (existsSync(distDir)) {
        await execAsync(`rm -rf "${distDir}"`, { cwd: APP_DIR, timeout: 30000 }).catch(async () => {
          // Windows fallback: rm isn't available in cmd.exe. Use Node's fs.rmSync
          // via -e so we don't introduce a hard PowerShell dependency.
          await execAsync(
            `node -e "require('fs').rmSync('dist',{recursive:true,force:true})"`,
            { cwd: APP_DIR, timeout: 30000 },
          );
        });
      }
      await execAsync("npm run build", { cwd: APP_DIR, timeout: BUILD_TIMEOUT_MS });
      setStep(4, "done");
    } catch (err: any) {
      failUpdate(4, "TypeScript build failed: " + stepFailureDetail(err, BUILD_TIMEOUT_MS));
      return;
    }

    // ── Step 6: Run migrations ──
    setStep(5, "running");
    try {
      await execAsync("npx prisma migrate deploy", {
        cwd: APP_DIR,
        timeout: MIGRATE_TIMEOUT_MS,
      });
      setStep(5, "done");
    } catch (err: any) {
      failUpdate(5, "Migration failed: " + stepFailureDetail(err, MIGRATE_TIMEOUT_MS));
      return;
    }

    // ── Step 7: Restart service ──
    setStep(6, "running", "Restarting...");
    _status.state = "restarting";
    _status.latestVersion = readCurrentVersion();
    saveStatus();

    logger.info("Update applied — restarting service...");

    // Schedule restart after response is sent
    setTimeout(() => {
      restartService();
    }, 1500);
  } catch (err: any) {
    _status.state = "failed";
    _status.error = "Unexpected error: " + (err.message || String(err));
    saveStatus();
    _applying = false;
  }
}

/**
 * Restart the service using the platform's service manager.
 *
 * Multi-process (POLARIS_ROLE set, e.g. web) must restart the WHOLE group, not
 * just this process — otherwise the monitor/discovery units keep running the
 * OLD code against the freshly-migrated schema (the exact column-mismatch
 * failure the updater guards against). Single-process ("all", role unset) keeps
 * the historical single-unit restart.
 *
 * The updater only runs on the web/all role (it owns the git checkout + status
 * file), so this is always called from the web process.
 */
export async function restartService() {
  const isWindows = process.platform === "win32";

  if (isWindows) {
    // Restart each per-role NSSM service, web LAST so its status page survives
    // through the workers' restart. Detached so it survives this process's exit.
    const cmd = "C:\\nssm\\nssm.exe restart PolarisDiscovery & C:\\nssm\\nssm.exe restart PolarisMonitor1 & C:\\nssm\\nssm.exe restart PolarisWeb";
    const child = spawn("cmd.exe", ["/c", cmd], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    // spawn() reports a missing/unspawnable binary asynchronously via the
    // 'error' event, NOT via the synchronous try/catch below. Without this
    // listener an ENOENT (no cmd.exe on PATH, etc.) bubbles as an unhandled
    // error and crashes the process before the self-exit timeout fires.
    child.on("error", (err) => {
      logger.warn({ err: err.message }, "nssm restart spawn failed; relying on self-exit + supervisor (NSSM / dev watcher / podman restart policy) to bring the process back");
    });
    child.unref();
    setTimeout(() => { process.exit(0); }, 5000);
  } else {
    // Restart the full group via a transient unit so the restart survives our
    // own exit (a detached child stays in web's cgroup and would be killed when
    // web restarts; systemd-run runs it as an independent transient unit).
    // Requires a polkit/sudo grant for the polaris user to manage polaris.target
    // — see docs/INSTALL.md. Falls back to a plain exit so at least web cycles.
    //
    // Auto-sync shipped unit files before restarting. A Polaris update that
    // ships unit-file changes (new env var on a worker role, hardening
    // directive, etc.) only lands the new content in /opt/polaris/deploy/;
    // /etc/systemd/system/ still holds whatever the operator cp'd in at
    // install time. Without the sync + daemon-reload below, the restart
    // would cycle the processes against the OLD unit definitions and ship
    // no env changes. cmp-only-overwrite means a no-op when nothing
    // changed; operator customization should live in <unit>.d/*.conf
    // drop-ins (per docs/INSTALL.md) — those survive any cp. The transient
    // unit's contents run as root via the manage-units polkit grant, so
    // the polaris user doesn't need direct cp access to /etc/systemd/system/.
    // Chained with && so a failed cp or daemon-reload aborts the restart
    // and leaves the system running the old code/units pair (the rollback
    // path knows how to repair from there).
    // Proxy mode: in addition to the systemd unit-file sync, also stage +
    // validate any updated nginx config from deploy/nginx/polaris.conf into
    // /etc/nginx/conf.d/polaris.conf, then reload nginx BEFORE the target
    // restart. Order matters: if Polaris restarts first and the new build
    // expects a new nginx behavior (new location block etc.), there'd be a
    // brief window of 404s. Failure mode: if nginx -t rejects the staged
    // config, we LOG and skip the reload (existing nginx config keeps
    // running) rather than fail the whole restart. Mirrors
    // deploy/update-linux.sh:sync_nginx_config() so manual + in-app paths
    // land the same end state.
    const proxyMode = Boolean(process.env.POLARIS_PROXY_CERT_PATH);
    // Render the operator's proxyConfig into /etc/nginx/conf.d/polaris.conf
    // before spawning the transient unit. Only fires when managedMode=true
    // — pre-adoption installs see their hand-edited file left alone, and
    // the GUI's drift banner stays up until the operator clicks Adopt.
    //
    // Drift check: if live file's sha256 doesn't match proxyConfig.lastAppliedHash,
    // somebody hand-edited the config after our last write. Refuse to clobber
    // and log a warning; the next operator visit to the GUI sees the drift
    // banner and forces explicit re-adoption.
    //
    // Optimistic hash update: record lastAppliedHash to the freshly-
    // rendered sha256 BEFORE the transient unit runs. If `nginx -t` fails
    // and the unit reverts, the DB hash will diverge from the (reverted)
    // live file — the GUI's getDriftStatus picks that up on the next visit.
    const STAGED_UPDATE_CONF = "/run/polaris-nginx-stage/polaris.conf.from-update";
    let nginxSync = "";
    if (proxyMode) {
      try {
        const cfg = await getProxyConfig();
        if (!cfg.managedMode) {
          logger.info("In-app update: skipping nginx config render — proxyConfig.managedMode is false (operator hasn't adopted)");
        } else {
          // The /api docs allow-block renders from its own Setting. A read
          // failure here must not abort the nginx sync mid-update — fall back
          // to the shipped default (rfc1918+loopback), which the app-level
          // gate would be enforcing anyway.
          const apiDocsAllow = await getApiDocsSettings()
            .then(deriveApiDocsNginxAllow)
            .catch(() => deriveApiDocsNginxAllow(defaultApiDocsSettings()));
          const rendered = renderNginxConfig({
            config: cfg,
            serverName: deriveNginxServerName(),
            polarisPort: derivePolarisPort(),
            dashPort: resolveDashPort(),
            apiDocsAllow,
          });
          let driftDetected = false;
          try {
            const live = readFileSync("/etc/nginx/conf.d/polaris.conf", "utf8");
            const liveSha = createHash("sha256").update(live).digest("hex");
            if (cfg.lastAppliedHash && liveSha !== cfg.lastAppliedHash) {
              driftDetected = true;
              logger.warn(
                { liveSha, expected: cfg.lastAppliedHash },
                "In-app update: /etc/nginx/conf.d/polaris.conf has been hand-edited since the last apply — refusing to clobber; GUI will surface drift banner",
              );
            }
          } catch {
            // Live file unreadable; transient unit's existence check skips the swap.
          }
          if (!driftDetected) {
            mkdirSync("/run/polaris-nginx-stage", { recursive: true });
            writeFileSync(STAGED_UPDATE_CONF, rendered.contents, { mode: 0o644 });
            await saveProxyConfig({
              lastAppliedAt: new Date().toISOString(),
              lastAppliedHash: rendered.sha256,
            });
            nginxSync = [
              `if [ -f ${STAGED_UPDATE_CONF} ]; then`,
              `  cp -p /etc/nginx/conf.d/polaris.conf /etc/nginx/conf.d/polaris.conf.bak.$(date +%s) 2>/dev/null || true`,
              `  cp -f ${STAGED_UPDATE_CONF} /etc/nginx/conf.d/polaris.conf.new`,
              `  mv -f /etc/nginx/conf.d/polaris.conf.new /etc/nginx/conf.d/polaris.conf`,
              `  rm -f ${STAGED_UPDATE_CONF}`,
              `  if nginx -t >/dev/null 2>&1; then`,
              `    systemctl reload nginx && logger -t polaris-updater "Synced nginx config from rendered template (sha256=${rendered.sha256.slice(0, 12)}) and reloaded"`,
              `  else`,
              `    logger -t polaris-updater "ERROR: nginx -t failed on rendered config; reverting"`,
              `    latest_bak=$(ls -1t /etc/nginx/conf.d/polaris.conf.bak.* 2>/dev/null | head -1)`,
              `    [ -n "$latest_bak" ] && cp -f "$latest_bak" /etc/nginx/conf.d/polaris.conf`,
              `  fi`,
              `fi`,
            ].join("\n");
          }
        }
      } catch (err: any) {
        logger.warn({ err: err?.message }, "In-app update: nginx config render failed — falling back to no-op (leaving live config untouched)");
      }
    }
    // Sync the in-app nginx GUI helpers (wrapper + sudoers + tmpfiles entry +
    // polaris↔nginx group membership). Runs unconditionally on every update;
    // cmp -s + usermod-guard make each step idempotent. Outside proxy mode
    // the wrapper and sudoers are inert, the tmpfiles dir is unused, and
    // the usermod is gated on `getent group nginx` so it's a no-op.
    const nginxHelperSync = [
      `if [ -f ${APP_DIR}/deploy/scripts/polaris-nginx-apply.sh ] && ! cmp -s ${APP_DIR}/deploy/scripts/polaris-nginx-apply.sh /usr/local/sbin/polaris-nginx-apply 2>/dev/null; then`,
      `  install -o root -g root -m 0755 ${APP_DIR}/deploy/scripts/polaris-nginx-apply.sh /usr/local/sbin/polaris-nginx-apply`,
      `  logger -t polaris-updater "Synced /usr/local/sbin/polaris-nginx-apply"`,
      `fi`,
      `if [ -f ${APP_DIR}/deploy/sudoers.d/polaris-nginx ] && ! cmp -s ${APP_DIR}/deploy/sudoers.d/polaris-nginx /etc/sudoers.d/polaris-nginx 2>/dev/null; then`,
      `  install -o root -g root -m 0440 ${APP_DIR}/deploy/sudoers.d/polaris-nginx /etc/sudoers.d/polaris-nginx`,
      `  logger -t polaris-updater "Synced /etc/sudoers.d/polaris-nginx"`,
      `fi`,
      `if [ -f ${APP_DIR}/deploy/tmpfiles.d/polaris-nginx.conf ] && ! cmp -s ${APP_DIR}/deploy/tmpfiles.d/polaris-nginx.conf /etc/tmpfiles.d/polaris-nginx.conf 2>/dev/null; then`,
      `  install -o root -g root -m 0644 ${APP_DIR}/deploy/tmpfiles.d/polaris-nginx.conf /etc/tmpfiles.d/polaris-nginx.conf`,
      `  systemd-tmpfiles --create /etc/tmpfiles.d/polaris-nginx.conf >/dev/null 2>&1 || true`,
      `  logger -t polaris-updater "Synced /etc/tmpfiles.d/polaris-nginx.conf"`,
      `fi`,
      `if getent group nginx >/dev/null 2>&1 && ! id -nG polaris 2>/dev/null | grep -qw nginx; then`,
      `  usermod -aG nginx polaris`,
      `  logger -t polaris-updater "Added polaris user to nginx group (cert file readability)"`,
      `fi`,
    ].join("\n");

    logger.info(
      { proxyMode },
      "Syncing unit files (and nginx config in proxy mode) and restarting polaris.target for update...",
    );
    const syncScript = [
      "set -e",
      nginxHelperSync,
      nginxSync,
      // install-if-missing, not just overwrite-on-change: a unit that ships
      // for the first time in an update (e.g. polaris-dash.service) must land
      // on upgraded hosts too — cmp-only would leave nginx proxying /dash to
      // a port nothing listens on. polaris.target's Wants= picks a newly
      // installed unit up on the same restart.
      `for f in ${APP_DIR}/deploy/polaris-web.service ${APP_DIR}/deploy/polaris-monitor@.service ${APP_DIR}/deploy/polaris-discovery.service ${APP_DIR}/deploy/polaris-dash.service ${APP_DIR}/deploy/polaris-migrate.service ${APP_DIR}/deploy/polaris.target; do`,
      `  name="$(basename "$f")"`,
      `  target="/etc/systemd/system/$name"`,
      `  if [ ! -f "$target" ] || ! cmp -s "$f" "$target"; then`,
      `    cp -f "$f" "$target"`,
      `    logger -t polaris-updater "Synced unit file: $name (operator edits to the main unit file are clobbered; use $name.d/*.conf drop-ins for customization)"`,
      `  fi`,
      `done`,
      `systemctl daemon-reload`,
      `systemctl restart polaris.target`,
    ].filter(Boolean).join("\n");
    try {
      const child = spawn("systemd-run", ["--no-block", "/bin/sh", "-c", syncScript], {
        detached: true,
        stdio: "ignore",
      });
      // spawn() reports a missing binary asynchronously via the 'error' event,
      // NOT through this try/catch. Without the listener an ENOENT (no
      // systemd-run on PATH — dev containers without systemd, npm-run-dev on
      // a non-systemd host, etc.) bubbles as an unhandled error and crashes
      // the process before the self-exit timeout fires, leaving the container
      // / watcher with no listener bound on 3000. With the listener attached,
      // we log + drop into the same self-exit path the prod-failure case uses
      // and let the supervisor (systemd in prod, podman restart policy in the
      // dev container, the operator's terminal in npm-run-dev-on-host) bring
      // the process back.
      child.on("error", (err) => {
        logger.warn({ err: err.message }, "systemd-run for group restart unavailable; relying on self-exit + supervisor (systemd / podman / dev watcher) to bring the process back");
      });
      child.unref();
    } catch (err: any) {
      logger.warn({ err: err?.message }, "systemd-run for group restart failed; falling back to self-exit");
    }
    setTimeout(() => { process.exit(0); }, 3000);
  }
}


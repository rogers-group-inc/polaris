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
import { logEvent } from "./eventLogService.js";

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
/**
 * Registry reachability preflight. Short on purpose: this only has to answer
 * "can npm talk to the registry at all", and a hung proxy should not add
 * minutes to an update that is about to fail anyway.
 */
const NPM_PING_TIMEOUT_MS = 45_000;
/**
 * The ping itself, with npm told to fail FAST. npm's defaults are
 * fetch-timeout=300000 (5 min per attempt) and fetch-retries=2, so on a
 * connection that drops rather than refuses, npm cannot produce a single line
 * of its own diagnostic inside a 45 s ceiling — the preflight would always be
 * SIGTERMed first and report "timed out" with nothing else, which is exactly
 * what prod showed on 2026-09-09. With these flags a hang surfaces in 15 s as
 * npm's own ETIMEDOUT/ECONNRESET/UNABLE_TO_GET_ISSUER_CERT_LOCALLY, and there is
 * room for a second attempt (below) so a transient stall is not a failed update.
 */
const NPM_PING_CMD = "npm ping --fetch-retries=0 --fetch-timeout=15000";
const NPM_PING_ATTEMPTS = 2;
const NPM_PING_RETRY_DELAY_MS = 3_000;
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
/** child_process.exec enforces `timeout` by SIGTERM and rejects with no text of its own. */
function isTimeoutKill(err: any): boolean {
  return err?.killed === true || err?.signal === "SIGTERM" || err?.code === "ETIMEDOUT";
}

/**
 * `npm ping` hits `/-/ping`, which Nexus, Artifactory and Verdaccio mirrors do
 * not all implement. A 404 means the registry ANSWERED — transport and TLS are
 * fine — so it must not block an install that `npm ci` would complete.
 */
function registryAnsweredWith404(err: any): boolean {
  return /\bE404\b|404 Not Found/i.test(String(err?.stderr || err?.stdout || err?.message || ""));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The default re-run advice is written for `npm ci`; steps with different economics pass their own. */
const WARM_CACHE_ADVICE =
  "Re-running the update is safe and is usually faster (a warm npm cache turns a multi-minute install into seconds).";

function stepFailureDetail(
  err: any,
  opts: { timeoutMs?: number; elapsedMs?: number; retryAdvice?: string } = {},
): string {
  const killedByTimeout = isTimeoutKill(err);
  const out = String(err?.stderr || err?.stdout || err?.message || err || "").trim();
  const tail = out.length > STEP_ERROR_CHARS ? "…" + out.slice(-STEP_ERROR_CHARS) : out;
  if (killedByTimeout) {
    // Quote the MEASURED time when the step was timed, and the limit beside
    // it. The old text quoted only the constant, so "timed out after 45s" was
    // an assertion about the config, not an observation about the run.
    const limit = opts.timeoutMs ? Math.round(opts.timeoutMs / 1000) : null;
    const measured = opts.elapsedMs != null ? Math.round(opts.elapsedMs / 1000) : null;
    const when =
      measured != null && limit != null ? ` after ${measured}s (limit ${limit}s)`
      : limit != null ? ` after ${limit}s`
      : "";
    return (
      `timed out${when} and was terminated` +
      ` — the command did not fail, it ran out of time. ${opts.retryAdvice ?? WARM_CACHE_ADVICE}` +
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
  steps?: {
    name: string;
    status: "pending" | "running" | "done" | "failed";
    message?: string;
    /** Stamped when the step starts; durationMs when it ends. Without these a
     *  "timed out after 45s" could only ever quote the constant, never the
     *  clock — and after a Dismiss the only record of how long anything took
     *  was gone (2026-09-09). */
    startedAt?: string;
    durationMs?: number;
  }[];
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
    // The other half of server.update.applied: the new code booted. Fire-and-
    // forget — this runs during startup and must not gate it.
    void logEvent({
      level: "info",
      action: "server.update.completed",
      resourceType: "server",
      actor: "system:update",
      message: `Update completed: v${saved.currentVersion ?? "?"} → v${saved.latestVersion ?? "?"} is running`,
      details: {
        fromVersion: saved.currentVersion ?? null,
        toVersion: saved.latestVersion ?? null,
        fromCommit: saved.currentCommit ?? null,
        toCommit: saved.latestCommit ?? null,
        startedAt: saved.startedAt ?? null,
        completedAt: saved.completedAt ?? null,
        train: saved.train ?? null,
      },
    });
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
  actor: string = "system:update",
): Promise<void> {
  if (!_updateEnvironment.available) {
    _status = disabledStatus();
    return;
  }
  if (_applying) return;
  _applying = true;

  const train = await getUpdateTrain();

  // Audit trail. Until 2026-09-09 the updater wrote NO Event rows: its only
  // durable record was .update-status.json, which the Dismiss button deletes.
  // A prod failure that afternoon left nothing to answer "how long did the
  // step take", "has this happened before" or "what commit were we on" — the
  // forensics were done off a screenshot. CLAUDE.md's rule that every
  // audit-worthy mutation writes an Event applies to a git pull onto a
  // production host at least as much as to anything else.
  const audit = {
    train,
    fromVersion: readCurrentVersion(),
    fromCommit: _status.currentCommit ?? null,
    toVersion: _status.latestVersion ?? null,
    toCommit: _status.latestCommit ?? null,
    allowWithoutBackup,
  };
  const pipelineStartedAt = Date.now();

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

  await logEvent({
    level: "info",
    action: "server.update.started",
    resourceType: "server",
    actor,
    message:
      `Update started (${train} train): v${audit.fromVersion}` +
      (audit.fromCommit ? ` @ ${audit.fromCommit}` : "") +
      (audit.toVersion ? ` → v${audit.toVersion}` : "") +
      (audit.toCommit ? ` @ ${audit.toCommit}` : "") +
      (allowWithoutBackup ? " (proceed-without-backup confirmed)" : ""),
    details: audit,
  });

  function setStep(idx: number, status: "running" | "done" | "failed", message?: string) {
    const now = Date.now();
    steps[idx].status = status;
    if (message) steps[idx].message = message;
    if (status === "running") {
      steps[idx].startedAt = new Date(now).toISOString();
    } else if (steps[idx].startedAt) {
      steps[idx].durationMs = Math.max(0, now - Date.parse(steps[idx].startedAt!));
    }
    _status.steps = steps;
    saveStatus();
  }

  /** Milliseconds since the step started; undefined when it never ran. */
  function elapsed(idx: number): number | undefined {
    const s = steps[idx].startedAt;
    return s ? Math.max(0, Date.now() - Date.parse(s)) : undefined;
  }

  function failUpdate(idx: number, error: string) {
    setStep(idx, "failed", error);
    _status.state = "failed";
    _status.error = error;
    saveStatus();
    _applying = false;
    const stepMs = steps[idx].durationMs;
    // Fire-and-forget: logEvent never throws, and the caller is already on the
    // failure path — nothing here should be able to make it worse.
    void logEvent({
      level: "error",
      action: "server.update.failed",
      resourceType: "server",
      actor,
      message:
        `Update failed at "${steps[idx].name}"` +
        (stepMs != null ? ` after ${Math.round(stepMs / 1000)}s` : "") +
        ` (${Math.round((Date.now() - pipelineStartedAt) / 1000)}s into the update): ${error}`,
      details: {
        ...audit,
        step: steps[idx].name,
        stepIndex: idx,
        stepDurationMs: stepMs ?? null,
        pipelineDurationMs: Date.now() - pipelineStartedAt,
        steps: steps.map((s) => ({ name: s.name, status: s.status, durationMs: s.durationMs ?? null })),
      },
    });
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

    // PREFLIGHT, and the ordering is the whole point. `npm ci` deletes
    // node_modules BEFORE it installs, so it destroys a working dependency tree
    // and only then discovers it cannot reach the registry. That is how a
    // config problem becomes an availability problem: on 2026-09-09 a corporate
    // TLS-inspecting proxy made npm fail UNABLE_TO_GET_ISSUER_CERT_LOCALLY, and
    // prod was left serving from modules already in memory, unable to survive a
    // restart, until an install succeeded. Nothing was wrong with the host, the
    // code, or the update — only with what npm trusted.
    //
    // `npm ping` and not a raw fetch: it goes through npm's own config, so it
    // exercises the same registry URL, proxy settings and cafile that `npm ci`
    // is about to use. A fetch from this process would test Node's TLS but miss
    // an npmrc-level registry or proxy override.
    //
    // The trade-off, stated so nobody has to rediscover it: an install whose
    // npm cache already satisfies the whole lockfile could have completed with
    // no network at all, and this preflight now blocks it. That is deliberate.
    // Whether the cache can satisfy the lockfile is not knowable cheaply, so the
    // choice is between occasionally refusing an update that would have worked
    // and occasionally leaving a host that cannot restart. The first is a
    // message; the second is an outage.
    //
    // Two attempts, fast-fail each (NPM_PING_CMD), 3 s apart. The day this
    // preflight shipped it failed a prod update on a host whose registry access
    // was fine — one outbound connection stalled for 45 s and never recovered,
    // and with npm's default 5-minute fetch-timeout the only output was the
    // PING notice. A single fast-fail attempt would have turned that blip into
    // a fast failure, which is no better; two attempts tell a stall from a
    // block. A 404 counts as reachable: the registry answered.
    let pingErr: any = null;
    for (let attempt = 1; attempt <= NPM_PING_ATTEMPTS; attempt++) {
      try {
        await execAsync(NPM_PING_CMD, {
          cwd: APP_DIR,
          timeout: NPM_PING_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        });
        pingErr = null;
        break;
      } catch (err: any) {
        if (registryAnsweredWith404(err)) {
          logger.warn(
            { stderr: String(err?.stderr || "").trim().slice(-300) },
            "npm ping got a 404 — the registry answered but has no /-/ping (private mirror?); proceeding",
          );
          pingErr = null;
          break;
        }
        pingErr = err;
        if (attempt < NPM_PING_ATTEMPTS) {
          logger.warn(
            { attempt, timedOut: isTimeoutKill(err), err: String(err?.stderr || err?.message || "").trim().slice(-300) },
            "npm ping failed; retrying once",
          );
          await sleep(NPM_PING_RETRY_DELAY_MS);
        }
      }
    }
    if (pingErr) {
      // A hang and a refusal have different causes, and the message used to
      // name only the refusal's. A TLS-inspection failure is FAST and LOUD
      // (UNABLE_TO_GET_ISSUER_CERT_LOCALLY within a second); a connection that
      // sits silent for the whole window is being dropped — firewall, proxy or
      // DNS — and telling the operator to set NODE_EXTRA_CA_CERTS sends them
      // the wrong way.
      const detail = stepFailureDetail(pingErr, {
        timeoutMs: NPM_PING_TIMEOUT_MS,
        elapsedMs: elapsed(2),
        retryAdvice: "Re-running will fail the same way until the cause is fixed.",
      });
      const causes = isTimeoutKill(pingErr)
        ? ` The registry did not answer at all (${NPM_PING_ATTEMPTS} attempts, ${NPM_PING_RETRY_DELAY_MS / 1000}s apart) — a hang, not a refusal.` +
          " A TLS-inspecting proxy fails fast with UNABLE_TO_GET_ISSUER_CERT_LOCALLY, so this points at an outbound firewall" +
          " or proxy DROPPING the connection, or DNS. Reproduce from this host as the service user:" +
          ` cd ${APP_DIR} && ${NPM_PING_CMD}.`
        : " Usual causes: a TLS-inspecting proxy (npm fails UNABLE_TO_GET_ISSUER_CERT_LOCALLY because Node ignores" +
          " the OS trust store — set NODE_EXTRA_CA_CERTS, see docs/INSTALL.md → \"Networks that inspect TLS\")," +
          " an outbound firewall rule, or no internet on this host.";
      failUpdate(
        2,
        "Cannot reach the npm registry: " + detail +
          " — stopped BEFORE installing, so this host's dependencies are untouched and it is safe to restart." +
          causes + " Fix the cause and re-run; nothing needs undoing.",
      );
      return;
    }

    try {
      // --include=dev, not the deprecated --production=false: npm 11 warns
      // "Use `--omit=dev` instead" on every run, which lands in the operator's
      // error output and reads like part of the failure.
      await execAsync("npm ci --include=dev", {
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
        "npm ci failed: " + stepFailureDetail(err, { timeoutMs: NPM_CI_TIMEOUT_MS, elapsedMs: elapsed(2) }) +
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
      failUpdate(3, "Prisma generate failed: " + stepFailureDetail(err, { timeoutMs: PRISMA_GENERATE_TIMEOUT_MS, elapsedMs: elapsed(3) }));
      return;
    }

    // ── Step 5: Build TypeScript ──
    // Clean `dist/` first so stale compiled JS from a previous build (e.g.
    // generated-client files Prisma renamed between versions) can't shadow
    // the fresh tsc output. tsc itself is non-destructive — without this,
    // a file that exists in `dist/` but no longer in `src/` lingers forever.
    //
    // Build via `npm run build` (not bare `npx tsc`) so the post-tsc asset
    // copy in scripts/copy-build-assets.mjs runs — it mirrors every non-.ts
    // runtime asset into dist/, which tsc won't emit. Two ride this copy, and
    // both fail silently and only in production without it:
    //   - the bundled std MIB .txt files → dist/services/stdMibs/. Every std
    //     SNMP-walk (LLDP-MIB etc.) then fails with "Standard MIB ... is not
    //     installed on the server".
    //   - the platform end-of-life dataset → dist/data/. The Platform
    //     Lifecycle card then renders "Unavailable" on the Maintenance tab.
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
      failUpdate(4, "TypeScript build failed: " + stepFailureDetail(err, { timeoutMs: BUILD_TIMEOUT_MS, elapsedMs: elapsed(4) }));
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
      failUpdate(5, "Migration failed: " + stepFailureDetail(err, { timeoutMs: MIGRATE_TIMEOUT_MS, elapsedMs: elapsed(5) }));
      return;
    }

    // ── Step 7: Restart service ──
    setStep(6, "running", "Restarting...");
    _status.state = "restarting";
    _status.latestVersion = readCurrentVersion();
    saveStatus();

    logger.info("Update applied — restarting service...");

    // Awaited, not fire-and-forget: the process exits in 1.5s and this row is
    // the record that the update reached the restart. "completed" is written
    // by initUpdateStatus() on the other side of it.
    await logEvent({
      level: "info",
      action: "server.update.applied",
      resourceType: "server",
      actor,
      message:
        `Update applied in ${Math.round((Date.now() - pipelineStartedAt) / 1000)}s — restarting` +
        ` (v${audit.fromVersion} → v${_status.latestVersion ?? "?"})`,
      details: {
        ...audit,
        toVersion: _status.latestVersion ?? audit.toVersion,
        pipelineDurationMs: Date.now() - pipelineStartedAt,
        steps: steps.map((s) => ({ name: s.name, status: s.status, durationMs: s.durationMs ?? null })),
      },
    });

    // Schedule restart after response is sent
    setTimeout(() => {
      restartService();
    }, 1500);
  } catch (err: any) {
    _status.state = "failed";
    _status.error = "Unexpected error: " + (err.message || String(err));
    saveStatus();
    _applying = false;
    void logEvent({
      level: "error",
      action: "server.update.failed",
      resourceType: "server",
      actor,
      message: `Update failed with an unexpected error ${Math.round((Date.now() - pipelineStartedAt) / 1000)}s in: ${err?.message || String(err)}`,
      details: { ...audit, pipelineDurationMs: Date.now() - pipelineStartedAt },
    });
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
      // HA (docs/HA.md): the updater only ever runs on the ACTIVE node, so
      // the standby is now one commit behind. Poke it to pull the new tree
      // immediately rather than waiting up to a minute for its own reconcile
      // timer — that window is when a failover would start the standby on
      // code older than the freshly-migrated schema. Best-effort, and inert
      // on a non-HA install (no marker file, no script).
      // Lockstep: deploy/update-linux.sh calls notify-peer at the end too.
      `if [ -f /etc/polaris/ha-node ] && [ -x /usr/local/sbin/polaris-ha-role ]; then`,
      `  /usr/local/sbin/polaris-ha-role notify-peer || logger -t polaris-updater "HA: notify-peer failed; the standby will sync on its own timer"`,
      `fi`,
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


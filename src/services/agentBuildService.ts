/**
 * src/services/agentBuildService.ts — Polaris Agent build runner
 *
 * Drives the "Build agent binaries" button on Server Settings → Maintenance.
 * Single in-memory state map + single-build mutex (queueing comes in a
 * follow-on commit). One build runs all 6 platform/arch combinations
 * serially via `go build` direct invocation (no `make` dependency — Windows
 * hosts don't ship GNU make by default).
 *
 * Lifecycle:
 *
 *   POST /server-settings/agents/build  → startBuild()
 *       → setImmediate(runBuild) returns immediately
 *       → phase: preparing → building:linux-amd64 → ... → writing-manifest → complete
 *         (or → failed at any step)
 *
 * UI polls GET /build/:buildId every 2 s to render the progress strip;
 * UI polls GET /build/current on tab mount to rehydrate any in-flight
 * build the operator left running when they switched tabs.
 *
 * Per the Phase A foundation commit, the version stamped into the binaries
 * + used as the directory name + written to manifest.json comes from
 * `getAgentVersion()` (reads `agent/VERSION`), NOT `getAppVersion()`.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rename, writeFile, stat, readdir, rm } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";
import { AGENT_BIN_DIR, STATE_DIR } from "../utils/paths.js";
import { AppError } from "../utils/errors.js";
import { getAgentVersion, getAgentSourceDir } from "../utils/version.js";
import { parseGoVersion, deriveTrack, compareTracks } from "../utils/platformVersions.js";
import { logEvent } from "./eventLogService.js";
import { truncate } from "../utils/text.js";
import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import {
  AGENT_SERVER_URL_SETTING_KEY,
  inferOwnServerUrl,
  inferOwnServerUrlSync,
} from "./agentInstallService.js";
import {
  getSigningConfigRaw,
  signingAvailability,
  signFile,
  recordSigningFailure,
  clearSigningFailure,
  SigningCancelledError,
} from "./agentSigningService.js";

const execFileAsync = promisify(execFile);

// ─── Public types ─────────────────────────────────────────────────────

export const PLATFORMS = [
  { os: "linux",   arch: "amd64" },
  { os: "linux",   arch: "arm64" },
  { os: "darwin",  arch: "amd64" },
  { os: "darwin",  arch: "arm64" },
  { os: "windows", arch: "amd64" },
  { os: "windows", arch: "arm64" },
] as const;

export type BuildPhase =
  | "queued"
  | "preparing"
  | "building:linux-amd64"
  | "building:linux-arm64"
  | "building:darwin-amd64"
  | "building:darwin-arm64"
  | "building:windows-amd64"
  | "building:windows-arm64"
  | "signing"
  | "writing-manifest"
  | "complete"
  | "failed"
  | "cancelled";

export interface BuildStep {
  platform: string;
  arch:     string;
  status:   "pending" | "running" | "success" | "failed";
  elapsedMs?: number;
  error?:    string;
}

export interface BuildState {
  buildId:     string;
  version:     string;
  phase:       BuildPhase;
  steps:       BuildStep[];
  /** When the build was enqueued (different from startedAt for queued builds). */
  queuedAt:    Date;
  startedAt?:  Date;
  finishedAt?: Date;
  goVersion?:  string;
  error?:      string;
  /** Username of the operator who triggered, or "system:..." for automated. */
  actor:       string;
  /** Set by cancelBuild(); runBuild() checks between platforms + abandons. */
  cancelled?:  boolean;
  /**
   * Active `go build` child process while one is running. Set on each
   * step, cleared on exit. DELETE route uses this to SIGTERM/SIGKILL.
   * Not serialized on the API (route layer drops it before sending).
   */
  activeChild?: import("node:child_process").ChildProcess;
}

// ─── Module-local state ───────────────────────────────────────────────
//
// Single-slot active + FIFO queue (depth cap 3). Two simultaneous POSTs
// land in a stable order thanks to Node's single-threadedness: neither
// can interleave between the queue-length check and the enqueue.

/** Max depth of waiting builds. Beyond this the route 409s. */
const QUEUE_DEPTH_LIMIT = 3;

/** Drop completed/failed/cancelled entries older than this from `buildStates`. */
const FINISHED_STATE_TTL_MS = 60 * 60 * 1000;

const buildStates: Map<string, BuildState> = new Map();
let currentBuildId: string | null = null;
const buildQueue: string[] = [];

export class BuildQueueFullError extends Error {
  constructor() {
    super(`Build queue is full (${QUEUE_DEPTH_LIMIT} already queued). Wait for one to finish.`);
    this.name = "BuildQueueFullError";
  }
}

// ─── Go-detection ─────────────────────────────────────────────────────

/**
 * The Go minor line the agent build requires — the single source of truth for
 * that number. `agent/go.mod`'s `go` directive, the install scripts' accept
 * regexes and the "install Go N+" copy in the UI and the docs all state the
 * same floor; this is the one the running app enforces, and every
 * operator-facing string below interpolates it rather than repeating it.
 *
 * Bumping it is one site of many: the full list is
 * .claude/skills/polaris-tech-lifecycle/references/version-pin-inventory.md,
 * and `npm run check:versions` asserts they agree.
 */
export const GO_MINIMUM = "1.26";

export interface GoAvailability {
  /** The `go` binary ran. Deliberately unchanged in meaning — see below. */
  ok:       boolean;
  /** Raw `go version` output, for display. */
  version?: string;
  /** Parsed version, e.g. "1.22.7". Absent when unparseable. */
  versionNumber?: string;
  /** Minor line, e.g. "1.22". Absent when unparseable. */
  track?:   string;
  /** False only when the version parsed AND is below GO_MINIMUM. */
  meetsMinimum?: boolean;
  error?:   string;
}

/**
 * Probe the host's Go toolchain.
 *
 * Not cached, because Go can be installed or removed on the host without
 * restarting Polaris and operators expect "install Go and reload" to just
 * work. The exec is cheap (<10 ms when Go is on PATH).
 *
 * `ok` keeps its original meaning — "the binary ran" — so nothing downstream
 * changes behaviour silently. `meetsMinimum` is the new signal, and it is what
 * the build gate reads.
 *
 * Before this, the check only confirmed `go version` exited 0 while five
 * surfaces told the operator "install Go 1.22+". A host with an older
 * toolchain therefore passed the preflight, showed an enabled Build button,
 * and failed later inside `go build` — surfacing as a bare compiler error or
 * "missing go.sum entry" instead of the preflight message that already
 * existed. bookworm-slim shipping Go 1.21 is exactly that case, which is why
 * the Dockerfile pulls golang from backports.
 *
 * An UNPARSEABLE version is treated as meeting the minimum, on purpose:
 * refusing to build on a vendored or `devel` toolchain we simply failed to
 * recognize is a worse outcome than the bug this fixes.
 */
export async function goAvailable(): Promise<GoAvailability> {
  try {
    const { stdout } = await execFileAsync("go", ["version"], { timeout: 5_000 });
    const raw = stdout.trim();
    const versionNumber = parseGoVersion(raw) ?? undefined;
    const track = versionNumber ? deriveTrack(versionNumber, "major.minor") ?? undefined : undefined;
    const meetsMinimum = track ? compareTracks(track, GO_MINIMUM) >= 0 : true;
    return { ok: true, version: raw, versionNumber, track, meetsMinimum };
  } catch (err: any) {
    return { ok: false, meetsMinimum: false, error: err?.message ?? "go not found on PATH" };
  }
}

// ─── Build kickoff ────────────────────────────────────────────────────

export interface StartBuildInput {
  actor: string;
}

export interface StartBuildResult {
  buildId:       string;
  version:       string;
  /** 0 = running immediately; 1..N = queued at that position (1-indexed). */
  queuePosition: number;
}

export class GoUnavailableError extends Error {
  constructor(reason: string) { super(reason); this.name = "GoUnavailableError"; }
}

export async function startBuild(input: StartBuildInput): Promise<StartBuildResult> {
  const go = await goAvailable();
  // Both messages are complete sentences naming GO_MINIMUM: callers surface
  // err.message verbatim rather than appending their own copy of the floor.
  if (!go.ok) {
    throw new GoUnavailableError(
      `Go is not available on this Polaris server (${go.error ?? "go not found on PATH"}). Install Go ${GO_MINIMUM}+ and reload, or run the OS install script, which provisions it.`,
    );
  }
  // Fail the preflight rather than the compile: before this check the build
  // started and died inside `go build` with a bare compiler error.
  if (go.meetsMinimum === false) {
    throw new GoUnavailableError(
      `Go ${go.track ?? go.versionNumber ?? "(unknown)"} is installed on this Polaris server, but building the agent requires Go ${GO_MINIMUM}+. Upgrade the toolchain and reload.`,
    );
  }
  if (buildQueue.length >= QUEUE_DEPTH_LIMIT) {
    throw new BuildQueueFullError();
  }

  const buildId = randomUUID();
  // Read version at enqueue time. If a build sits in the queue while
  // agent/VERSION is bumped, the actual build's runBuild() re-reads the
  // version at start-of-run so the binaries always match the source they
  // were built from. We stamp the at-enqueue version here just so the
  // queued-build's UI row has a stable label.
  const version = getAgentVersion();
  const state: BuildState = {
    buildId,
    version,
    phase:     "queued",
    steps:     PLATFORMS.map((p) => ({ platform: p.os, arch: p.arch, status: "pending" })),
    queuedAt:  new Date(),
    goVersion: go.version,
    actor:     input.actor,
  };
  buildStates.set(buildId, state);

  // Either kick off immediately (no active build, nothing queued) or
  // append to the queue. Both branches are sync between the check and
  // the mutation, so two concurrent POSTs can't race into "both run
  // immediately" — Node's single thread guarantees ordering.
  if (currentBuildId === null && buildQueue.length === 0) {
    activateBuild(buildId);
    await logEvent({
      action:       "agent.build.started",
      level:        "info",
      actor:        input.actor,
      resourceType: "polaris-agent",
      resourceName: version,
      message:      `Agent build v${version} started`,
      details:      { buildId, goVersion: go.version },
    });
    return { buildId, version, queuePosition: 0 };
  }

  buildQueue.push(buildId);
  const queuePosition = buildQueue.length;
  await logEvent({
    action:       "agent.build.queued",
    level:        "info",
    actor:        input.actor,
    resourceType: "polaris-agent",
    resourceName: version,
    message:      `Agent build v${version} queued (position ${queuePosition})`,
    details:      { buildId, queuePosition, goVersion: go.version },
  });
  return { buildId, version, queuePosition };
}

function activateBuild(buildId: string): void {
  const state = buildStates.get(buildId);
  if (!state) return;
  // Recompute version at start-of-build. agent/VERSION may have moved
  // between enqueue and now (operator pushed a Polaris update during the
  // wait window); the binaries should match the source they're built
  // from RIGHT NOW.
  state.version   = getAgentVersion();
  state.phase     = "preparing";
  state.startedAt = new Date();
  currentBuildId  = buildId;
  setImmediate(() => {
    runBuild(buildId).catch((err) => {
      logger.error({ err, buildId }, "Agent build crashed unexpectedly");
    });
  });
}

// ─── Build runner ─────────────────────────────────────────────────────

async function runBuild(buildId: string): Promise<void> {
  const state = buildStates.get(buildId);
  if (!state) {
    // Defensive — should never happen since startBuild populates the map
    // before scheduling runBuild.
    currentBuildId = null;
    advanceQueue();
    return;
  }

  try {
    await doRun(state);
  } catch (err: any) {
    if (err instanceof CancelledError) {
      state.phase = "cancelled";
      state.error = state.error ?? "Build cancelled by operator";
      state.finishedAt = new Date();
      // cancelBuild() emitted agent.build.cancelled; don't double-log.
    } else {
      state.phase = "failed";
      state.error = err?.message ?? String(err);
      state.finishedAt = new Date();
      await logEvent({
        action:       "agent.build.failed",
        level:        "warning",
        actor:        state.actor,
        resourceType: "polaris-agent",
        resourceName: state.version,
        message:      `Agent build v${state.version} failed: ${state.error}`,
        details:      { buildId, error: state.error },
      });
    }
  } finally {
    state.activeChild = undefined;
    currentBuildId = null;
    advanceQueue();
    gcFinishedStates();
  }
}

class CancelledError extends Error {
  constructor() { super("Build cancelled"); this.name = "CancelledError"; }
}

/**
 * Resolve module dependencies before the per-platform loop. Two scenarios:
 *
 *   1. agent/go.sum is present + complete (the happy path on a fresh
 *      release tarball where go.sum was committed). `go mod download`
 *      is a fast no-op that confirms cache state.
 *   2. agent/go.sum is missing or out of sync (operator added a
 *      dependency, or — in our case during early agent rollouts —
 *      go.sum was never committed). `go mod download` fetches every
 *      module the source imports + writes the checksums.
 *
 * We deliberately don't run `go mod tidy` here. tidy would also REMOVE
 * unused imports, which is fine in a developer workflow but unwelcome
 * in a server-side build path (an in-flight refactor mid-PR could leave
 * an import temporarily unreferenced + get rewritten without consent).
 * `mod download` is read-only-against-source.
 *
 * Failure aborts the build with a clear error (usually "no network to
 * proxy.golang.org" or "GOPROXY=off" misconfig).
 */
async function ensureGoModulesResolved(state: BuildState, agentSourceDir: string): Promise<void> {
  if (state.cancelled) throw new CancelledError();
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      "go",
      ["mod", "download"],
      {
        cwd:     agentSourceDir,
        timeout: 5 * 60_000, // first-cold-cache download can take a minute on slow links
        env: {
          ...process.env,
          HOME:        STATE_DIR,
          GOCACHE:     resolvePath(STATE_DIR, ".cache", "go-build"),
          GOMODCACHE:  resolvePath(STATE_DIR, ".cache", "go-mod"),
          GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? "local",
        },
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, _stdout, stderr) => {
        state.activeChild = undefined;
        if (err) {
          if (state.cancelled) return reject(new CancelledError());
          return reject(new Error(`go mod download failed: ${truncate(stderr || (err as any).message, 600)}`));
        }
        resolve();
      },
    );
    state.activeChild = child;
  });
}

/**
 * Run one `go build` for one platform/arch. Wraps execFile so we can
 * stash the ChildProcess on `state.activeChild` — cancelBuild() reaches
 * through that handle to SIGTERM / SIGKILL the running compiler.
 *
 * Rejects with CancelledError when the child was killed by us (we
 * detect this via state.cancelled being set), and a generic Error
 * with stderr captured otherwise.
 */
function runGoBuild(
  state: BuildState,
  opts: { cwd: string; outPath: string; os: string; arch: string; version: string },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      "go",
      [
        "build",
        "-trimpath",
        `-ldflags=-s -w -X main.version=${opts.version}`,
        "-o", opts.outPath,
        "./cmd/polaris-agent",
      ],
      {
        cwd:     opts.cwd,
        timeout: 5 * 60_000,
        env: {
          ...process.env,
          CGO_ENABLED: "0",
          GOOS:        opts.os,
          GOARCH:      opts.arch,
          HOME:        STATE_DIR,
          GOCACHE:     resolvePath(STATE_DIR, ".cache", "go-build"),
          // Match the GOMODCACHE we use in ensureGoModulesResolved so the
          // build reads the same module cache the download just populated.
          GOMODCACHE:  resolvePath(STATE_DIR, ".cache", "go-mod"),
          GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? "local",
        },
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, _stdout, stderr) => {
        state.activeChild = undefined;
        if (err) {
          if (state.cancelled) {
            return reject(new CancelledError());
          }
          // Surface stderr on the rejection so the caller's catch block
          // can preserve it on the BuildStep for the UI.
          (err as any).stderr = stderr;
          return reject(err);
        }
        resolve();
      },
    );
    state.activeChild = child;
  });
}

/**
 * Cancel a build by id. Three cases:
 *
 *   1. Queued — pluck from buildQueue, transition state to "cancelled",
 *      emit agent.build.cancelled. No process to kill.
 *   2. Running — set state.cancelled, send SIGTERM to the active child,
 *      schedule SIGKILL after 5 s grace. runBuild's catch sees
 *      CancelledError and lands in "cancelled" phase. The runBuild's
 *      finally still clears currentBuildId + advances the queue.
 *   3. Already finished (complete / failed / cancelled) — throws so the
 *      route can 409.
 */
export class BuildAlreadyFinishedError extends Error {
  constructor() { super("Build already finished"); this.name = "BuildAlreadyFinishedError"; }
}

export class BuildNotFoundError extends Error {
  constructor() { super("Build not found"); this.name = "BuildNotFoundError"; }
}

export async function cancelBuild(buildId: string, actor: string): Promise<void> {
  const state = buildStates.get(buildId);
  if (!state) throw new BuildNotFoundError();
  if (state.phase === "complete" || state.phase === "failed" || state.phase === "cancelled") {
    throw new BuildAlreadyFinishedError();
  }

  if (state.phase === "queued") {
    const idx = buildQueue.indexOf(buildId);
    if (idx >= 0) buildQueue.splice(idx, 1);
    state.phase      = "cancelled";
    state.error      = "Cancelled while queued";
    state.finishedAt = new Date();
    await logEvent({
      action:       "agent.build.cancelled",
      level:        "info",
      actor,
      resourceType: "polaris-agent",
      resourceName: state.version,
      message:      `Agent build v${state.version} cancelled (was queued)`,
      details:      { buildId, wasQueued: true },
    });
    return;
  }

  // In-flight: set the flag, kill the child. runBuild's catch handles
  // the state transition + emits the cancelled event after the catch
  // unwinds — but we emit our own log event here for the audit trail
  // since the operator wants to see it immediately. The catch block
  // doesn't re-emit (we set state.error so it knows).
  state.cancelled = true;
  await logEvent({
    action:       "agent.build.cancelled",
    level:        "info",
    actor,
    resourceType: "polaris-agent",
    resourceName: state.version,
    message:      `Agent build v${state.version} cancelled (in-flight)`,
    details:      { buildId, wasQueued: false, phase: state.phase },
  });

  const child = state.activeChild;
  if (child && !child.killed) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    setTimeout(() => {
      if (child && !child.killed) {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }, 5_000);
  }
}

/** Pop the next queued buildId and activate it. No-op if the queue is empty. */
function advanceQueue(): void {
  const nextId = buildQueue.shift();
  if (!nextId) return;
  const state = buildStates.get(nextId);
  if (!state) {
    // Build was cancelled / GC'd between enqueue + advance; try again.
    advanceQueue();
    return;
  }
  // Re-emit started event for the queued build (parity with the
  // first-build immediate-start path) so the audit trail captures
  // every build's start, not just the not-queued ones.
  void logEvent({
    action:       "agent.build.started",
    level:        "info",
    actor:        state.actor,
    resourceType: "polaris-agent",
    resourceName: state.version,
    message:      `Agent build (was queued) starting`,
    details:      { buildId: nextId, goVersion: state.goVersion ?? null },
  });
  activateBuild(nextId);
}

/** Drop completed/failed/cancelled entries older than FINISHED_STATE_TTL_MS. */
function gcFinishedStates(): void {
  const cutoff = Date.now() - FINISHED_STATE_TTL_MS;
  for (const [id, state] of buildStates) {
    if (id === currentBuildId) continue;
    if (buildQueue.includes(id)) continue;
    if (state.finishedAt && state.finishedAt.getTime() < cutoff) {
      buildStates.delete(id);
    }
  }
}

async function doRun(state: BuildState): Promise<void> {
  const agentSourceDir = getAgentSourceDir();
  if (!agentSourceDir) {
    throw new AppError(500, "agent/ source directory not found — is the release tarball complete?");
  }

  // Phase: preparing
  const versionDir = resolvePath(AGENT_BIN_DIR, state.version);
  await mkdir(versionDir,          { recursive: true });
  await mkdir(resolvePath(STATE_DIR, ".cache", "go-build"), { recursive: true });

  // Resolve module deps before the per-platform build loop. `go mod
  // download` is idempotent + cheap when go.sum is already populated;
  // when it's missing (e.g. agent/go.sum was never committed, or an
  // operator added a new dep between Polaris releases), this fetches +
  // checksums everything into the module cache so each subsequent
  // `go build` sees a consistent state. Failure here aborts the build
  // with a clear error — usually means the host has no network access
  // to proxy.golang.org or the operator's GOPROXY is misconfigured.
  await ensureGoModulesResolved(state, agentSourceDir);

  // Build each platform serially. Parallel `go build` calls thrash the
  // shared GOCACHE; serial keeps cache contention down + total time
  // around 60 s on a 2-vCPU host with a warm cache.
  for (let i = 0; i < PLATFORMS.length; i++) {
    // Bailout check between platforms: if the operator clicked Cancel
    // (which set state.cancelled), don't start the next go build.
    if (state.cancelled) {
      throw new CancelledError();
    }
    const { os, arch } = PLATFORMS[i];
    const step = state.steps[i];

    state.phase = `building:${os}-${arch}` as BuildPhase;
    step.status = "running";
    const stepStart = Date.now();

    const exeSuffix = os === "windows" ? ".exe" : "";
    const outName   = `polaris-agent-${os}-${arch}${exeSuffix}`;
    const outPath   = resolvePath(versionDir, outName);

    try {
      await runGoBuild(state, {
        cwd:     agentSourceDir,
        outPath,
        os, arch,
        version: state.version,
      });
      step.status    = "success";
      step.elapsedMs = Date.now() - stepStart;
    } catch (err: any) {
      step.status    = "failed";
      step.elapsedMs = Date.now() - stepStart;
      step.error     = truncate(err?.stderr ?? err?.message ?? String(err), 800);
      // Cancellation propagates as CancelledError so the outer catch can
      // distinguish it from a real failure (state.phase → cancelled vs
      // failed, different event severity).
      if (err instanceof CancelledError) throw err;
      throw new AppError(500, `go build failed for ${os}/${arch}: ${step.error}`);
    }
  }

  // Phase: signing (opt-in, FAIL-OPEN). When the operator has enabled
  // code signing, sign the two Windows binaries in place via jsign. A
  // failure marks the sign step failed, stamps the durable
  // `agent.signing.lastFailure` Setting (drives the sidebar alert for
  // assets:write roles), and emits a warning Event — but the build still
  // completes and ships. Signing must never block an agent rollout.
  const signedOutcome = await signWindowsBinaries(state, versionDir);

  // Phase: writing-manifest
  state.phase = "writing-manifest";
  const manifest = {
    currentVersion:    state.version,
    minimumCompatible: state.version,
    binaries: Object.fromEntries(
      PLATFORMS.map(({ os, arch }) => [
        `${os}-${arch}`,
        `polaris-agent-${os}-${arch}${os === "windows" ? ".exe" : ""}`,
      ]),
    ),
  };
  // Atomic via .tmp + rename.
  const manifestPath    = resolvePath(AGENT_BIN_DIR, "manifest.json");
  const manifestTmpPath = manifestPath + ".tmp";
  await writeFile(manifestTmpPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf-8" });
  await rename(manifestTmpPath, manifestPath);

  // Phase: complete
  state.phase      = "complete";
  state.finishedAt = new Date();
  await logEvent({
    action:       "agent.build.completed",
    level:        "info",
    actor:        state.actor,
    resourceType: "polaris-agent",
    resourceName: state.version,
    message:      `Agent build v${state.version} completed`,
    details: {
      buildId:        state.buildId,
      // startedAt is set when the build leaves the queue (activateBuild);
      // by the time this Event is emitted we're after writing-manifest so
      // it's always populated. Fallback to queuedAt for defensive math.
      totalElapsedMs: state.finishedAt.getTime() - (state.startedAt ?? state.queuedAt).getTime(),
      platforms:      state.steps.map((s) => ({ platform: s.platform, arch: s.arch, elapsedMs: s.elapsedMs })),
      signed:         signedOutcome,
    },
  });

  // Best-effort auto-upgrade: if the operator opted in via the
  // `agent.autoUpgradeOnNewBuild` Setting, fan out an upgrade-all for
  // every active agent whose version lags the brand-new manifest.
  // Fire-and-forget — each per-agent startUpgrade is itself
  // fire-and-forget under the hood, so this returns quickly. Default
  // OFF (opt-in) so routine agent/VERSION bumps don't surprise-reboot
  // every installed agent during an unrelated Polaris update.
  void (async () => {
    try {
      const row = await prisma.setting.findUnique({ where: { key: "agent.autoUpgradeOnNewBuild" } });
      const enabled = (row?.value as { enabled?: boolean } | null)?.enabled === true;
      if (!enabled) return;
      const { upgradeAllOutdated } = await import("./agentInstallService.js");
      const result = await upgradeAllOutdated("system:auto-upgrade-on-new-build");
      if (result.eligible === 0) return;
      logger.info(
        { eligible: result.eligible, queued: result.queued, version: state.version },
        "Auto-upgrade fanned out post-build",
      );
      await logEvent({
        action:       "agent.upgrade_all_auto_kickoff",
        level:        "info",
        actor:        "system:auto-upgrade-on-new-build",
        resourceType: "polaris-agent",
        resourceName: state.version,
        message:      `Auto-upgrade kicked off post-build: queued ${result.queued} of ${result.eligible} eligible agent(s) to v${state.version}`,
        details:      { buildId: state.buildId, version: state.version, eligible: result.eligible, queued: result.queued },
      });
    } catch (err) {
      logger.warn({ err }, "Post-build auto-upgrade hook crashed");
    }
  })();

  // Best-effort auto-prune: after a successful build the new version is
  // safely on disk + manifest. Now's the time to drop older versions
  // beyond the keep-last-N window. Failure here doesn't fail the build —
  // the new binaries are already published; cleanup is bonus.
  void (async () => {
    try {
      const r = await pruneOldAgentVersions();
      if (r.removed.length > 0) {
        const totalBytes = r.removed.reduce((sum, e) => sum + e.bytes, 0);
        logger.info({ removed: r.removed.length, totalBytes }, "Auto-pruned old agent versions");
        void logEvent({
          action:       "agent.versions.pruned",
          level:        "info",
          actor:        state.actor,
          resourceType: "polaris-agent",
          message:      `Auto-pruned ${r.removed.length} old agent version(s), freed ${(totalBytes / (1024*1024)).toFixed(1)} MiB`,
          details:      { removed: r.removed, protected: r.protected, trigger: "post-build" },
        });
      }
    } catch (err) {
      logger.warn({ err }, "Post-build prune failed");
    }
  })();
}

// ─── Windows binary signing (internal-CA PKCS#12 via jsign) ───────────

/**
 * Sign the two Windows binaries in place, appending one `sign / windows-<arch>`
 * step per file to `state.steps` (the progress strip renders them like build
 * rows). Returns the value stamped into agent.build.completed's `signed`
 * detail: "disabled" (signing off — nothing appended), true (all signed),
 * false (at least one failure — fail-open, build continues).
 *
 * Only cancellation propagates out of here; every other failure is contained:
 * step marked failed, `agent.signing.lastFailure` Setting stamped (the
 * sidebar-alert source for roles with assets:write), warning Event emitted.
 * A fully-signed run clears the failure stamp.
 */
async function signWindowsBinaries(state: BuildState, versionDir: string): Promise<"disabled" | boolean> {
  const cfg = await getSigningConfigRaw();
  if (!cfg.enabled) return "disabled";
  if (state.cancelled) throw new CancelledError();

  state.phase = "signing";
  const failures: Array<{ file: string; error: string }> = [];

  const avail = await signingAvailability(cfg);
  if (!avail.ok) {
    const error = truncate(avail.error ?? "signing unavailable", 800);
    state.steps.push({ platform: "sign", arch: "windows", status: "failed", error });
    failures.push({ file: "(preflight)", error });
  } else {
    // No credential-exchange step: the PKCS#12 keystore is read directly by
    // jsign, so unlike the hosted-service path there is no token to mint and
    // therefore no whole-phase failure mode before the per-file loop.
    for (const { os, arch } of PLATFORMS) {
      if (os !== "windows") continue;
      if (state.cancelled) throw new CancelledError();
      const filename = `polaris-agent-${os}-${arch}.exe`;
      const step: BuildStep = { platform: "sign", arch: `${os}-${arch}`, status: "running" };
      state.steps.push(step);
      const stepStart = Date.now();
      try {
        await signFile(state, {
          jarPath:          avail.jarPath!,
          keystorePath:     cfg.keystorePath,
          keystorePassword: cfg.keystorePassword,
          alias:            cfg.alias || undefined,
          tsaUrl:           cfg.tsaUrl,
          filePath:         resolvePath(versionDir, filename),
        });
        step.status    = "success";
        step.elapsedMs = Date.now() - stepStart;
      } catch (err: any) {
        step.elapsedMs = Date.now() - stepStart;
        if (err instanceof SigningCancelledError) {
          step.status = "failed";
          step.error  = "cancelled";
          throw new CancelledError();
        }
        step.status = "failed";
        step.error  = truncate(err?.message ?? String(err), 800);
        failures.push({ file: filename, error: step.error });
        // Fail-open: keep going — the other binary may still sign.
      }
    }
  }

  if (failures.length === 0) {
    await clearSigningFailure().catch(() => {});
    await logEvent({
      action:       "agent.build.signed",
      level:        "info",
      actor:        state.actor,
      resourceType: "polaris-agent",
      resourceName: state.version,
      message:      `Agent Windows binaries v${state.version} signed (internal CA)`,
      details:      { buildId: state.buildId, files: PLATFORMS.filter((p) => p.os === "windows").map((p) => `polaris-agent-windows-${p.arch}.exe`) },
    });
    return true;
  }

  await recordSigningFailure({
    at:      new Date().toISOString(),
    buildId: state.buildId,
    version: state.version,
    files:   failures.map((f) => f.file),
    error:   failures[0].error,
  }).catch((err) => logger.warn({ err }, "Failed to persist signing-failure stamp"));
  await logEvent({
    action:       "agent.build.sign_failed",
    level:        "warning",
    actor:        state.actor,
    resourceType: "polaris-agent",
    resourceName: state.version,
    message:      `Agent build v${state.version}: code signing failed — Windows binaries shipped UNSIGNED (${failures.map((f) => f.file).join(", ")})`,
    details:      { buildId: state.buildId, failures },
  });
  return false;
}

// ─── Read helpers (route layer + UI) ──────────────────────────────────

/** Strip non-serializable fields (activeChild) before sending to API consumers. */
function publicView(state: BuildState | null): BuildState | null {
  if (!state) return null;
  const { activeChild: _drop, ...rest } = state;
  return rest as BuildState;
}

export function getBuild(buildId: string): BuildState | null {
  return publicView(buildStates.get(buildId) ?? null);
}

export function getCurrentBuild(): BuildState | null {
  if (currentBuildId === null) return null;
  return publicView(buildStates.get(currentBuildId) ?? null);
}

/**
 * Snapshot the active build + the FIFO queue in one go. UI polls this
 * to rehydrate state when the operator switches tabs back to Maintenance.
 */
export function getCurrentBuildAndQueue(): { current: BuildState | null; queue: BuildState[] } {
  const current = getCurrentBuild();
  const queue   = buildQueue
    .map((id) => publicView(buildStates.get(id) ?? null))
    .filter((s): s is BuildState => !!s);
  return { current, queue };
}

/** Queue depth limit, exported for the UI / docs. */
export const QUEUE_DEPTH = QUEUE_DEPTH_LIMIT;

// ─── Inventory ────────────────────────────────────────────────────────

export interface InventoryFile {
  platform: string;
  arch:     string;
  filename: string;
  present:  boolean;
  sizeBytes?: number;
  mtime?:    string;
}

export interface InventoryResult {
  goAvailable: boolean;
  goVersion?:  string;
  goError?:    string;
  /**
   * Go is present but too old to build the agent. Distinct from goAvailable
   * false so the UI can say "Go 1.21 is too old (need 1.22+)" instead of the
   * misleading "Go is not installed".
   */
  goTooOld?:   boolean;
  /** The floor the build enforces, so the UI never hardcodes the number. */
  goMinimum:   string;
  manifest:    { currentVersion: string; minimumCompatible?: string; binaries: Record<string, string> } | null;
  files:       InventoryFile[];
  agentSourceVersion: string;
  /**
   * Versions on disk that aren't manifest.currentVersion. Drives the
   * "Clean up old binaries" line + button on the Maintenance card.
   * Total bytes is what the operator sees as "freed if you click Clean up";
   * the actual prune helper respects keep-last-N + in-use protection so
   * the real freed bytes can be smaller. Cheap to compute (one readdir).
   */
  oldVersions: Array<{ version: string; bytes: number; mtime: string }>;
  /**
   * What the agent.conf's server_url would be stamped to RIGHT NOW if an
   * operator clicked Install. Three fields:
   *   effective: the actual URL (operator override OR derived from cert)
   *   override:  what the UI-settable Setting holds (null = derive default)
   *   derived:   what would be used without the override (cert / env / etc)
   * UI uses these to render the input + a "Default would be: <derived>"
   * placeholder so operators can see what they'd inherit if they clear
   * the override.
   */
  serverUrl: {
    effective: string;
    override:  string | null;
    derived:   string;
  };
}

/**
 * Snapshot of what's available right now: is Go on PATH? what does the
 * on-disk manifest say? which platform binaries are present + their
 * sizes / mtimes? what's the agent source's claimed version?
 *
 * The agent source version is the comparison key — the UI shows a
 * "v{currentVersion} (latest: v{agentSourceVersion})" hint when the
 * manifest's currentVersion is behind getAgentVersion().
 */
export async function getInventory(): Promise<InventoryResult> {
  const go = await goAvailable();
  const agentSourceVersion = getAgentVersion();

  let manifest: InventoryResult["manifest"] = null;
  const manifestPath = resolvePath(AGENT_BIN_DIR, "manifest.json");
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.currentVersion === "string") {
      manifest = parsed;
    }
  } catch { /* manifest missing or malformed — both render as "no builds yet" */ }

  const files: InventoryFile[] = [];
  for (const { os, arch } of PLATFORMS) {
    const filename = `polaris-agent-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
    let present = false, sizeBytes: number | undefined, mtime: string | undefined;
    if (manifest) {
      const p = resolvePath(AGENT_BIN_DIR, manifest.currentVersion, filename);
      try {
        const st = await stat(p);
        present = true;
        sizeBytes = st.size;
        mtime = st.mtime.toISOString();
      } catch { /* not present */ }
    }
    files.push({ platform: os, arch, filename, present, sizeBytes, mtime });
  }

  // Scan data/agents/ subdirectories for versions OTHER than the current
  // manifest version. We don't filter by the keep-last-N policy here —
  // the UI shows "N old versions retained (X MiB)"; the prune helper
  // applies the policy at prune time so the actual freed bytes can
  // be lower.
  const oldVersions: InventoryResult["oldVersions"] = [];
  try {
    const entries = await readdir(AGENT_BIN_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!VERSION_DIR_RE.test(e.name)) continue;
      if (manifest && e.name === manifest.currentVersion) continue;
      const dir = resolvePath(AGENT_BIN_DIR, e.name);
      let bytes = 0;
      let mtimeMs = 0;
      try {
        const subEntries = await readdir(dir, { withFileTypes: true });
        for (const f of subEntries) {
          if (!f.isFile()) continue;
          try {
            const fs = await stat(resolvePath(dir, f.name));
            bytes += fs.size;
            if (fs.mtimeMs > mtimeMs) mtimeMs = fs.mtimeMs;
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
      oldVersions.push({ version: e.name, bytes, mtime: new Date(mtimeMs || 0).toISOString() });
    }
    oldVersions.sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());
  } catch { /* directory missing — no old versions */ }

  // Server-URL: render what install would actually use right now (effective),
  // alongside the raw operator-set override (so the UI input is editable) and
  // the cert-derived default (so the placeholder names what they'd inherit
  // if they cleared the override). All three are read independently so the
  // override field stays editable to its current value even when the live
  // effective URL came from somewhere else (e.g. POLARIS_PUBLIC_URL env).
  let serverUrlOverride: string | null = null;
  try {
    const row = await prisma.setting.findUnique({ where: { key: AGENT_SERVER_URL_SETTING_KEY } });
    const raw = (row?.value as { url?: string } | null)?.url;
    if (raw && typeof raw === "string" && raw.trim()) {
      serverUrlOverride = raw.trim().replace(/\/$/, "");
    }
  } catch { /* Setting table unreachable — treat as unset */ }
  const serverUrlEffective = await inferOwnServerUrl();
  const serverUrlDerived   = inferOwnServerUrlSync();

  return {
    goAvailable: go.ok,
    goVersion:   go.version,
    goError:     go.error,
    goTooOld:    go.ok && go.meetsMinimum === false,
    goMinimum:   GO_MINIMUM,
    manifest,
    files,
    agentSourceVersion,
    oldVersions,
    serverUrl: {
      effective: serverUrlEffective,
      override:  serverUrlOverride,
      derived:   serverUrlDerived,
    },
  };
}

// ─── Per-version cleanup ──────────────────────────────────────────────
//
// data/agents/ accumulates one subdirectory per Build click. Six binaries
// per version at ~10 MB each = ~60 MB per build; over a year of agent/
// edits that's gigabytes of orphan binaries. Policy: a version directory
// is deletable iff
//
//   1. it is NOT the current manifest.currentVersion, AND
//   2. it is NOT in use by any live ManagedAgent (installStatus !==
//      "revoked"; the binary must remain serveable while an agent is
//      still on disk somewhere), AND
//   3. it is NOT within the most-recent N versions (default 3; env
//      POLARIS_AGENT_KEEP_VERSIONS) ordered by directory mtime desc.
//
// (1) + (2) protect correctness; (3) is the rollback-comfort knob.

export interface PruneResult {
  scanned:    number;
  /**
   * Per-version protection records so the UI can render a specific
   * "kept by X" reason instead of a vague "in use or within keep-last-N"
   * lump. `reason` priority when multiple rules apply: `in-use` > `current`
   * > `keep-last-n` (most-specific to least-specific).
   *   - `current`     — version matches manifest.currentVersion
   *   - `in-use`      — a non-revoked ManagedAgent reports this agentVersion
   *   - `keep-last-n` — within the rollback-comfort window
   */
  protected:  Array<{ version: string; reason: "current" | "in-use" | "keep-last-n" }>;
  /**
   * Knob that decided the keep-last-N window (3 by default, configurable
   * via POLARIS_AGENT_KEEP_VERSIONS). Returned so the UI can name the
   * actual N in the "nothing to prune" message.
   */
  keepLastN:  number;
  removed:    Array<{ version: string; bytes: number }>;
}

const VERSION_DIR_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

function keepLastN(): number {
  const raw = process.env.POLARIS_AGENT_KEEP_VERSIONS;
  if (!raw) return 3;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 3;
  return n;
}

export async function pruneOldAgentVersions(): Promise<PruneResult> {
  // Manifest current version is always protected.
  const manifestPath = resolvePath(AGENT_BIN_DIR, "manifest.json");
  let manifestCurrent: string | null = null;
  try {
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(manifestPath, "utf-8"));
    if (parsed && typeof parsed.currentVersion === "string") manifestCurrent = parsed.currentVersion;
  } catch { /* no manifest yet — nothing inherently protected by it */ }

  // Live agents are protected — their hosts may still need to fetch the
  // binary (e.g. install retry, uninstall script lookup, drift recovery).
  // installStatus === "revoked" no longer needs the binary; everything
  // else does.
  let inUseVersions: Set<string>;
  try {
    const rows = await prisma.managedAgent.findMany({
      where: { installStatus: { not: "revoked" } },
      select: { agentVersion: true },
    });
    inUseVersions = new Set(rows.map((r) => r.agentVersion).filter((v): v is string => !!v));
  } catch {
    // Defensive: if we can't read the table, fail closed — protect
    // everything and prune nothing.
    inUseVersions = new Set();
    return { scanned: 0, protected: [], keepLastN: keepLastN(), removed: [] };
  }

  let entries;
  try {
    entries = await readdir(AGENT_BIN_DIR, { withFileTypes: true });
  } catch {
    return { scanned: 0, protected: [], keepLastN: keepLastN(), removed: [] };
  }
  const versionDirs: Array<{ name: string; path: string; mtimeMs: number }> = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!VERSION_DIR_RE.test(e.name)) continue;
    const p = resolvePath(AGENT_BIN_DIR, e.name);
    try {
      const st = await stat(p);
      versionDirs.push({ name: e.name, path: p, mtimeMs: st.mtimeMs });
    } catch { /* race with rm — skip */ }
  }

  // Newest-first by mtime so the keep-last-N comparison reads naturally.
  versionDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = keepLastN();
  const recentlyMade = new Set(versionDirs.slice(0, keep).map((v) => v.name));

  // Per-version protection reason — assign the MOST-SPECIFIC reason that
  // applies so the UI's "nothing to prune" toast names the actual cause.
  // Priority: in-use > current > keep-last-n.
  const reasonByVersion = new Map<string, "current" | "in-use" | "keep-last-n">();
  for (const v of versionDirs) {
    if (inUseVersions.has(v.name))                reasonByVersion.set(v.name, "in-use");
    else if (manifestCurrent && v.name === manifestCurrent) reasonByVersion.set(v.name, "current");
    else if (recentlyMade.has(v.name))            reasonByVersion.set(v.name, "keep-last-n");
  }

  const removed: Array<{ version: string; bytes: number }> = [];
  for (const v of versionDirs) {
    if (reasonByVersion.has(v.name)) continue;
    // Compute size before delete so the operator can see what they freed.
    let bytes = 0;
    try {
      const sub = await readdir(v.path, { withFileTypes: true });
      for (const f of sub) {
        if (!f.isFile()) continue;
        try {
          const fs = await stat(resolvePath(v.path, f.name));
          bytes += fs.size;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    try {
      await rm(v.path, { recursive: true, force: true });
      removed.push({ version: v.name, bytes });
    } catch (err: any) {
      logger.warn({ err, version: v.name }, "Failed to remove old agent version directory");
    }
  }

  return {
    scanned:    versionDirs.length,
    protected:  Array.from(reasonByVersion.entries()).map(([version, reason]) => ({ version, reason })),
    keepLastN:  keep,
    removed,
  };
}

// ─── Small utilities ──────────────────────────────────────────────────


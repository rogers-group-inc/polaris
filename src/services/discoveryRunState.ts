/**
 * src/services/discoveryRunState.ts — DB-backed live state for discovery runs.
 *
 * Replaces the former in-memory `activeDiscovery` Map in integrations.ts. The
 * `discovery`-role process executes a run and writes its progress here; the
 * `web`-role process reads it for the /discoveries endpoint, isDiscoveryRunning,
 * the slow-run check, and the backup-restore guard. In the single-process `all`
 * role both sides are the same process — the DB round-trips are cheap and keep
 * one code path across topologies.
 *
 * The hot progress writes (per discovery event) are coalesced through an
 * in-memory `RunAccumulator` the worker mutates synchronously; it flushes to the
 * row on a throttle + on terminal transitions, so a chatty FMG run doesn't
 * hammer the DB.
 */

import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { logger } from "../utils/logger.js";

export type DiscoveryRunStatus = "queued" | "running" | "completed" | "aborted" | "error";

export interface ActiveDeviceEntry {
  name: string;
  startedAt: number; // epoch ms
}

/**
 * In-memory accumulator the discovery worker mutates as progress events fire.
 * Mirrors the fields the old ActiveDiscoveryEntry tracked. `flushRunProgress`
 * serializes the live bits onto the DiscoveryRun row.
 */
export interface RunAccumulator {
  integrationId: string;
  integrationName: string;
  type: string;
  startedAt: number;
  totalDevices: number | null;
  completedCount: number;
  skippedOfflineCount: number;
  skippedErrorCount: number;
  /**
   * Names of the devices behind `skippedErrorCount` — a gate discovery could
   * not read at all this run (no mgmt IP resolvable, direct REST unreachable).
   *
   * In memory only, deliberately: the count is what the live UI needs, and the
   * names are needed exactly once, in the end-of-run summary Event, which this
   * process writes before the run ends. Persisting them would be a column that
   * only ever has one reader. Bounded by the device roster, so a fleet-sized
   * Set of names at 2000 gates is still kilobytes.
   *
   * Why it exists at all: a skipped gate is otherwise invisible. Its per-device
   * skip line is one Event among the thousands a run writes, the count is
   * folded into "done" in the progress bar, and nothing on the ASSET says it
   * has not been read — so a gate silently frozen at stale data looks exactly
   * like a healthy one (prod 2026-09, an 1801F HA pair on old firmware).
   */
  skippedErrorDevices: Set<string>;
  activeDevices: Map<string, number>; // device name → startedAt epoch ms
  // NOTE: slow-alert flags are NOT tracked here. Slow detection runs in the
  // web/scheduler role (checkForSlowRuns) and owns the slowAlerted /
  // slowAlertedDevices columns; the worker's flush must not touch them or it
  // would clobber the web-set flags.
}

export function newRunAccumulator(integrationId: string, integrationName: string, type: string, startedAt: number): RunAccumulator {
  return {
    integrationId,
    integrationName,
    type,
    startedAt,
    totalDevices: null,
    completedCount: 0,
    skippedOfflineCount: 0,
    skippedErrorCount: 0,
    skippedErrorDevices: new Set(),
    activeDevices: new Map(),
  };
}

/**
 * Enqueue-time upsert: stamp a fresh `queued` row, clearing any prior run's
 * counters / flags / cancel request for this integration. The `@unique`
 * integrationId means a re-trigger reuses the row.
 */
export async function upsertQueuedRun(args: {
  integrationId: string;
  integrationName: string;
  type: string;
  actor: string;
  scopeDeviceName?: string;
}): Promise<void> {
  const base = {
    integrationName: args.integrationName,
    type: args.type,
    status: "queued",
    actor: args.actor,
    startedAt: null,
    finishedAt: null,
    totalDevices: null,
    completedCount: 0,
    skippedOfflineCount: 0,
    skippedErrorCount: 0,
    activeDevices: [],
    slowAlerted: false,
    slowAlertedDevices: [],
    cancelRequested: false,
    workerHeartbeatAt: null,
    // Scoped single-FortiGate re-discovery marker; a later full run's upsert
    // resets it to NULL along with the rest of the counters.
    scopeDeviceName: args.scopeDeviceName ?? null,
  };
  // createdAt is reset on every enqueue so elapsed-time math against the row
  // reflects the current run's age, not the row's lifetime. The row is keyed
  // on integrationId and reused across runs, so Prisma's @default(now()) only
  // fires the very first time — without this, a re-triggered integration's
  // queued-window elapsedMs would point at the original first-ever creation.
  await prisma.discoveryRun.upsert({
    where: { integrationId: args.integrationId },
    create: { integrationId: args.integrationId, ...base },
    update: { ...base, createdAt: new Date() },
  });
}

/** Worker marks the run started: status=running, startedAt, first heartbeat. */
export async function markRunStarted(integrationId: string, startedAt: Date): Promise<void> {
  await prisma.discoveryRun.update({
    where: { integrationId },
    data: { status: "running", startedAt, workerHeartbeatAt: new Date() },
  });
}

/** Flush the live accumulator onto the row (throttled by the caller). */
export async function flushRunProgress(acc: RunAccumulator): Promise<void> {
  const activeDevices: ActiveDeviceEntry[] = [...acc.activeDevices.entries()].map(([name, startedAt]) => ({ name, startedAt }));
  await prisma.discoveryRun.update({
    where: { integrationId: acc.integrationId },
    data: {
      totalDevices: acc.totalDevices,
      completedCount: acc.completedCount,
      skippedOfflineCount: acc.skippedOfflineCount,
      skippedErrorCount: acc.skippedErrorCount,
      activeDevices: activeDevices as unknown as Prisma.InputJsonValue,
      workerHeartbeatAt: new Date(),
      // slowAlerted / slowAlertedDevices intentionally omitted — owned by the
      // web-role slow-run check, not the worker.
    },
  }).catch((err) => {
    // Progress flushes are best-effort — never let a transient DB hiccup kill
    // a discovery run. The next flush (or the terminal finishRun) recovers.
    logger.debug({ err, integrationId: acc.integrationId }, "discovery run progress flush failed");
  });
}

/**
 * Lightweight worker liveness ping — touches `workerHeartbeatAt` without
 * serializing the rest of the accumulator. Called on a 60s timer inside
 * `runDiscovery` so a quiet phase (long FMG roster fetch, slow SNMP walk)
 * doesn't look stale to the reaper. Best-effort; a transient DB hiccup
 * doesn't kill the run.
 */
export async function touchWorkerHeartbeat(integrationId: string): Promise<void> {
  await prisma.discoveryRun.updateMany({
    where: { integrationId, status: { in: ["queued", "running"] } },
    data: { workerHeartbeatAt: new Date() },
  }).catch(() => {});
}

/** Terminal transition: completed | aborted | error. Clears active devices. */
export async function finishRun(integrationId: string, status: DiscoveryRunStatus): Promise<void> {
  await prisma.discoveryRun.update({
    where: { integrationId },
    data: { status, finishedAt: new Date(), workerHeartbeatAt: new Date(), activeDevices: [] },
  }).catch((err) => {
    logger.warn({ err, integrationId, status }, "discovery run finalize failed");
  });
}

/** True when a queued or running row exists for this integration. */
export async function isRunActive(integrationId: string): Promise<boolean> {
  const n = await prisma.discoveryRun.count({
    where: { integrationId, status: { in: ["queued", "running"] } },
  });
  return n > 0;
}

/** True when ANY integration has a queued/running run (backup-restore guard). */
export async function anyRunActive(): Promise<boolean> {
  const n = await prisma.discoveryRun.count({ where: { status: { in: ["queued", "running"] } } });
  return n > 0;
}

/** Read the cancel flag; the worker polls this and aborts when true. */
export async function isCancelRequested(integrationId: string): Promise<boolean> {
  const row = await prisma.discoveryRun.findUnique({
    where: { integrationId },
    select: { cancelRequested: true },
  });
  return row?.cancelRequested === true;
}

/**
 * Request cancellation of an active run. Returns true when a queued/running row
 * was flipped (so the route can 204), false when there was nothing to cancel
 * (404). Only the worker actually aborts — this just sets the flag it polls.
 */
export async function requestCancel(integrationId: string): Promise<boolean> {
  const res = await prisma.discoveryRun.updateMany({
    where: { integrationId, status: { in: ["queued", "running"] } },
    data: { cancelRequested: true },
  });
  return res.count > 0;
}

export type DiscoveryRunRow = Awaited<ReturnType<typeof listActiveRuns>>[number];

/** All queued/running runs — drives the /discoveries endpoint + slow-run check. */
export async function listActiveRuns() {
  return prisma.discoveryRun.findMany({
    where: { status: { in: ["queued", "running"] } },
    orderBy: { startedAt: "asc" },
  });
}

/** Persist slow-alert flags computed by checkForSlowRuns. */
export async function persistSlowFlags(integrationId: string, slowAlerted: boolean, slowAlertedDevices: string[]): Promise<void> {
  await prisma.discoveryRun.update({
    where: { integrationId },
    data: { slowAlerted, slowAlertedDevices },
  }).catch(() => {});
}

/**
 * Reaper: a discovery process that crashed leaves a `running` row with a stale
 * heartbeat. Mark any running/queued row whose heartbeat predates the cutoff as
 * `error` so the integration isn't stuck "in flight" forever and a re-trigger's
 * upsert can reclaim it. Returns the number reaped.
 */
export async function reapStaleRuns(maxStaleMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxStaleMs);
  const res = await prisma.discoveryRun.updateMany({
    where: {
      status: { in: ["queued", "running"] },
      OR: [
        { workerHeartbeatAt: { lt: cutoff } },
        { workerHeartbeatAt: null, createdAt: { lt: cutoff } },
      ],
    },
    data: { status: "error", finishedAt: new Date(), activeDevices: [] },
  });
  if (res.count > 0) logger.warn({ reaped: res.count, maxStaleMs }, "reaped stale discovery run(s)");
  return res.count;
}

/**
 * src/services/probePatchBuffer.ts
 *
 * Periodic batch-flush buffer for the per-probe `Asset` row update issued by
 * `recordProbeResult` (monitorStatus, lastMonitorAt, lastResponseTimeMs,
 * consecutiveFailures / consecutiveSuccesses, monitorStatusChangedAt). At
 * 2000+ monitored assets the cheap response-time probe fires once per asset
 * per resolved interval — each probe used to issue one `prisma.asset.update`
 * which consumes one Prisma pool connection and holds it across the network
 * round-trip + lock acquisition. The cumulative result was the largest
 * remaining per-tick connection draw on the monitor hot loop.
 *
 * Buffer semantics
 * ────────────────
 * The buffer is a `Map<assetId, ProbePatch>` of in-flight state writes,
 * flushed as one bulk `UPDATE ... FROM (VALUES ...)` statement per 2 s
 * window. Within one window, a second probe for the same asset overwrites
 * the first patch (last-write-wins) EXCEPT for `monitorStatusChangedAt` —
 * if probe N transitioned (stamp set) and probe N+1 didn't (stamp omitted),
 * we preserve probe N's stamp on merge so the DB ends up with the actual
 * transition timestamp instead of NULL-erasing it.
 *
 * Read-your-writes
 * ────────────────
 * The five-state machine in `recordProbeResult` computes the next state
 * from `monitorStatus + consecutiveFailures + consecutiveSuccesses`. Those
 * three columns can be up to one flush window stale on disk, so the
 * recordProbeResult call site overlays the pending buffer entry onto the
 * loaded Asset row BEFORE running the state machine. Without this, two
 * back-to-back failed probes in the same window would each compute
 * `newCf = 1` against the on-disk `consecutiveFailures = 0`, and the
 * threshold counting would silently break.
 *
 * Failure mode
 * ────────────
 * On flush failure (after `retryOnDeadlock` exhausts retries), the stale
 * snapshot is conditionally re-prepended: each (assetId, patch) pair is
 * restored only if the buffer no longer holds an entry for that asset.
 * Concurrent enqueues that landed during the awaited write represent
 * fresher state and win; the failed snapshot fills the gaps. Trade-off:
 * up to 2 s of state writes can be lost on a hard crash. Acceptable
 * because the next probe tick observes current state (the row in DB is
 * just one cycle behind on counters) and recomputes — the state machine
 * is self-healing within one additional probe cycle.
 *
 * SIGTERM-safe: `shutdownFlushProbePatchBuffer()` is awaited from the
 * graceful-shutdown hook in `app.ts` so any in-flight state writes drain
 * before the process exits.
 *
 * Trade-off documented vs the sampleWriteBuffer's append-only contract:
 * this buffer holds STATE writes (last-write-wins per asset), not
 * append-only time-series rows. The contracts are different by design;
 * the in-memory shape (Map<id, patch> vs Array<row>), the merge rule
 * (last-write-wins-with-stamp-preservation vs concat), and the flush
 * SQL (UPDATE FROM VALUES vs createMany) are all chosen accordingly.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { retryOnDeadlock } from "../utils/dbRetry.js";
import {
  startProbePatchWriteTimer,
  setProbePatchBufferDepth,
} from "../metrics.js";
import type { MonitorStatus } from "../utils/monitorStatus.js";

export interface ProbePatch {
  monitorStatus: MonitorStatus;
  lastMonitorAt: Date;
  lastResponseTimeMs: number | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /** Set only on a status transition; undefined means "no change this tick — keep the prior stamp". */
  monitorStatusChangedAt?: Date;
  /** Latest device uptime reading (whole seconds); undefined on a probe that
   *  didn't report uptime — the flush COALESCEs to keep the prior value rather
   *  than nulling it. Captured by the SNMP / FortiOS / agent probe paths. */
  lastUptimeSec?: number;
  /** Set only when a reboot was detected this tick; undefined preserves the prior stamp. */
  lastRebootAt?: Date;
  /** Cadence anchor for the sysDescr identity read — set only on the probe
   *  that actually carried sysDescr (one extra varbind, ~every 10 min per
   *  asset). Rides this buffer rather than costing its own UPDATE, which is
   *  what the buffer is for; undefined preserves the prior stamp, so a device
   *  that publishes no sysDescr at all simply stays due and keeps paying one
   *  varbind. See Asset.lastDescrAt. */
  lastDescrAt?: Date;
  /** Set only on the success that ended an outage (down/unknown -> answering);
   *  undefined preserves the prior stamp. The packet-loss ratio's recovery
   *  anchor — see Asset.recoveryStartedAt and business rule 29b. */
  recoveryStartedAt?: Date;
  /** Armed on the transition INTO down, disarmed on the transition into up;
   *  undefined on every other outcome preserves the prior value. Carries the
   *  confirmation run across a mid-run miss — see Asset.awaitingRecoveryConfirm
   *  and business rule 36. Note the preserve-on-absent here is over a BOOLEAN,
   *  so the merge and the flush both have to use `??` / COALESCE rather than
   *  truthiness: `false` is a real value that must land. */
  awaitingRecoveryConfirm?: boolean;
  /** Set only on a SUCCESSFUL probe — advances Asset.lastSeen/lastSeenSource so
   *  polling is the authority for presence on monitored assets. Undefined on a
   *  failed probe so a down asset's lastSeen freezes at its last success
   *  (the flush COALESCEs to preserve the prior value rather than nulling it). */
  lastSeen?: Date;
  lastSeenSource?: string;
  /** Set TOGETHER, only on the success that starts a new polling run for an
   *  address (a different IP, or back from down/unknown); undefined preserves
   *  the prior run. The address-confidence score's polling evidence —
   *  Asset.ipConfirmedFor / ipConfirmedSince, business rule 103. */
  ipConfirmedFor?: string;
  ipConfirmedSince?: Date;
}

// Module-level buffer. One in-flight patch per asset; new patches collapse
// onto the existing entry per the merge rule below.
const buffer = new Map<string, ProbePatch>();

// Flush early when the buffer crosses this size. At 2000+ monitored assets
// every 5 s probe tick can drop ~333 entries / second into the buffer, so a
// 5000-entry threshold = roughly the 2 s window's natural depth. Burst
// publishers (a manual probe-all-now triggered by /probe-now flooded across
// the fleet) hit the threshold and flush early instead of waiting.
const SIZE_THRESHOLD = 5000;

// Buffer hold window. Matches sampleWriteBuffer's 2 s — the two buffers
// flush on the same cadence by design so the UI status pill + sample chart
// lag together rather than diverging.
export const FLUSH_INTERVAL_MS = 2000;

const TABLE_LABEL = "assets:probe";

let flushing = false;

/**
 * Look up the pending in-flight patch for an asset. `recordProbeResult`
 * calls this AFTER loading the asset row and BEFORE running the state
 * machine, so the counter and status reads see the latest write — not the
 * DB row, which may be up to one flush window stale.
 */
export function getPendingProbePatch(assetId: string): ProbePatch | null {
  return buffer.get(assetId) ?? null;
}

/**
 * Enqueue a state patch for one asset. Last-write-wins for the rolling
 * state (monitorStatus / lastMonitorAt / counters / lastResponseTimeMs).
 *
 * `monitorStatusChangedAt` is preserved across merges when the new patch
 * doesn't carry one (because the in-flight patch transitioned and a
 * subsequent probe didn't, the DB should still receive the transition
 * stamp). If both patches carry stamps the newer one wins.
 */
export function enqueueProbePatch(assetId: string, patch: ProbePatch): void {
  const existing = buffer.get(assetId);
  if (existing) {
    buffer.set(assetId, {
      ...patch,
      monitorStatusChangedAt:
        patch.monitorStatusChangedAt ?? existing.monitorStatusChangedAt,
      // Preserve-on-absent: a probe that didn't report uptime (or didn't
      // detect a reboot) merging onto a prior patch must not erase its
      // uptime/reboot stamps.
      lastUptimeSec: patch.lastUptimeSec ?? existing.lastUptimeSec,
      lastRebootAt: patch.lastRebootAt ?? existing.lastRebootAt,
      lastDescrAt: patch.lastDescrAt ?? existing.lastDescrAt,
      // Same preserve-on-absent rule: an ordinary probe merging onto the
      // recovery probe in the same 2s window must not erase the recovery
      // anchor, or the loss ratio silently keeps counting the outage.
      recoveryStartedAt: patch.recoveryStartedAt ?? existing.recoveryStartedAt,
      // Same rule, and `??` is load-bearing: a patch disarming the run carries
      // `false`, which `||` would discard in favour of the armed `true`.
      awaitingRecoveryConfirm:
        patch.awaitingRecoveryConfirm ?? existing.awaitingRecoveryConfirm,
      // A failed probe (no lastSeen) merging onto a successful one in the same
      // window must not erase the success's presence stamp.
      lastSeen: patch.lastSeen ?? existing.lastSeen,
      lastSeenSource: patch.lastSeenSource ?? existing.lastSeenSource,
      // The run start travels as a pair: a later probe that didn't restart the
      // run must not erase the start an earlier one in this window recorded.
      ...(patch.ipConfirmedFor !== undefined
        ? { ipConfirmedFor: patch.ipConfirmedFor, ipConfirmedSince: patch.ipConfirmedSince }
        : { ipConfirmedFor: existing.ipConfirmedFor, ipConfirmedSince: existing.ipConfirmedSince }),
    });
  } else {
    buffer.set(assetId, patch);
  }
  setProbePatchBufferDepth(TABLE_LABEL, buffer.size);
  if (buffer.size >= SIZE_THRESHOLD) void flushProbePatchBuffer();
}

/**
 * Drain the entire buffer to disk as a single bulk UPDATE ... FROM (VALUES ...)
 * statement. Re-entrant safe via `flushing`; a periodic tick that fires while
 * a prior flush is mid-write becomes a no-op.
 */
export async function flushProbePatchBuffer(): Promise<void> {
  if (flushing) return;
  if (buffer.size === 0) return;
  flushing = true;
  // Snapshot + clear the buffer up front so concurrent enqueues during the
  // awaited write land in a fresh map.
  const snapshot: Array<[string, ProbePatch]> = [];
  for (const entry of buffer.entries()) snapshot.push(entry);
  buffer.clear();
  setProbePatchBufferDepth(TABLE_LABEL, 0);
  const stopTimer = startProbePatchWriteTimer();
  try {
    await retryOnDeadlock(() => writeBatch(snapshot));
  } catch (err: unknown) {
    // Re-prepend on retry-exhausted failure, but only for entries the buffer
    // doesn't already hold — concurrent enqueues during the awaited write
    // represent fresher state and should win.
    logger.warn(
      { err: (err as Error)?.message, rowCount: snapshot.length },
      "probePatchBuffer: flush failed; restoring rows missing from current buffer",
    );
    for (const [id, patch] of snapshot) {
      if (!buffer.has(id)) buffer.set(id, patch);
    }
    setProbePatchBufferDepth(TABLE_LABEL, buffer.size);
  } finally {
    stopTimer();
    flushing = false;
  }
}

/**
 * Single bulk UPDATE that lands every patch in one statement. Uses
 * UPDATE ... FROM (VALUES ...) so per-row column data flows through one
 * SQL parse + plan + execution, not N. `monitorStatusChangedAt` uses
 * COALESCE(v.changed_at, t."monitorStatusChangedAt") so the
 * conditionally-stamped column preserves the existing row value when this
 * patch didn't transition.
 */
async function writeBatch(rows: ReadonlyArray<readonly [string, ProbePatch]>): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const tuples: string[] = [];
  let p = 1;
  for (const [id, patch] of rows) {
    tuples.push(
      `($${p++}::text, $${p++}::text, $${p++}::timestamp, ` +
      `$${p++}::int, $${p++}::int, $${p++}::int, $${p++}::timestamp, ` +
      `$${p++}::int, $${p++}::timestamp, $${p++}::timestamp, $${p++}::text, ` +
      `$${p++}::timestamp, $${p++}::boolean, $${p++}::timestamp, ` +
      `$${p++}::text, $${p++}::timestamp)`,
    );
    params.push(
      id,
      patch.monitorStatus,
      patch.lastMonitorAt.toISOString(),
      patch.lastResponseTimeMs,
      patch.consecutiveFailures,
      patch.consecutiveSuccesses,
      patch.monitorStatusChangedAt
        ? patch.monitorStatusChangedAt.toISOString()
        : null,
      patch.lastUptimeSec ?? null,
      patch.lastRebootAt ? patch.lastRebootAt.toISOString() : null,
      patch.lastSeen ? patch.lastSeen.toISOString() : null,
      patch.lastSeenSource ?? null,
      patch.recoveryStartedAt ? patch.recoveryStartedAt.toISOString() : null,
      patch.awaitingRecoveryConfirm ?? null,
      patch.lastDescrAt ? patch.lastDescrAt.toISOString() : null,
      patch.ipConfirmedFor ?? null,
      patch.ipConfirmedSince ? patch.ipConfirmedSince.toISOString() : null,
    );
  }
  const sql =
    `UPDATE "assets" AS t SET ` +
    `"monitorStatus"          = v.status, ` +
    `"lastMonitorAt"          = v.last_monitor_at, ` +
    `"lastResponseTimeMs"     = v.rt, ` +
    `"consecutiveFailures"    = v.cf, ` +
    `"consecutiveSuccesses"   = v.cs, ` +
    `"monitorStatusChangedAt" = COALESCE(v.changed_at, t."monitorStatusChangedAt"), ` +
    // These columns preserve the prior row value when this patch didn't carry
    // one (no uptime reported / no reboot / failed probe) — same COALESCE
    // pattern as changed_at. A failed probe omits lastSeen so a down asset's
    // presence stamp freezes at its last successful poll.
    `"lastUptimeSec"          = COALESCE(v.uptime_sec, t."lastUptimeSec"), ` +
    `"lastRebootAt"           = COALESCE(v.reboot_at, t."lastRebootAt"), ` +
    `"lastSeen"               = COALESCE(v.last_seen, t."lastSeen"), ` +
    `"lastSeenSource"         = COALESCE(v.last_seen_source, t."lastSeenSource"), ` +
    `"recoveryStartedAt"      = COALESCE(v.recovery_started_at, t."recoveryStartedAt"), ` +
    `"awaitingRecoveryConfirm" = COALESCE(v.awaiting_recovery_confirm, t."awaitingRecoveryConfirm"), ` +
    `"lastDescrAt"            = COALESCE(v.last_descr_at, t."lastDescrAt"), ` +
    `"ipConfirmedFor"         = COALESCE(v.ip_confirmed_for, t."ipConfirmedFor"), ` +
    `"ipConfirmedSince"       = COALESCE(v.ip_confirmed_since, t."ipConfirmedSince") ` +
    `FROM (VALUES ${tuples.join(", ")}) ` +
    `AS v(id, status, last_monitor_at, rt, cf, cs, changed_at, uptime_sec, reboot_at, last_seen, last_seen_source, recovery_started_at, awaiting_recovery_confirm, last_descr_at, ip_confirmed_for, ip_confirmed_since) ` +
    `WHERE t."id" = v.id`;
  await prisma.$executeRawUnsafe(sql, ...params);
}

// ─── Boot + shutdown ──────────────────────────────────────────────────────

let flushTimer: NodeJS.Timeout | null = null;

/**
 * Start the periodic flush tick. Safe to call multiple times — second and
 * later calls are no-ops. Called once from app.ts at startup, paired with
 * the sample-write buffer.
 */
export function startProbePatchBuffer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushProbePatchBuffer();
  }, FLUSH_INTERVAL_MS);
  // .unref() so the timer doesn't keep the event loop alive during a
  // graceful shutdown — the shutdown path awaits a final flush explicitly.
  flushTimer.unref?.();
}

/**
 * Final drain before process exit. Called from the SIGTERM/SIGINT hook
 * in app.ts. Idempotent — safe to call even if the timer never started.
 */
export async function shutdownFlushProbePatchBuffer(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flushProbePatchBuffer();
}

// ─── Test hooks ───────────────────────────────────────────────────────────

export const __test__ = {
  getBufferDepth(): number {
    return buffer.size;
  },
  getPatch(assetId: string): ProbePatch | undefined {
    return buffer.get(assetId);
  },
  reset(): void {
    buffer.clear();
    flushing = false;
    setProbePatchBufferDepth(TABLE_LABEL, 0);
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  },
  flush: flushProbePatchBuffer,
};

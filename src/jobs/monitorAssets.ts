/**
 * src/jobs/monitorAssets.ts
 *
 * Periodic asset monitoring tick. Splits work across TWO independent ticking
 * loops so a slow heavy collection (telemetry / systemInfo) on a wedged host
 * can't hold up per-minute probe polling for the rest of the fleet:
 *
 *   - Light loop  (probe + fastFiltered + sdwan + loss sweep): ticks every 5 s
 *   - Heavy loop  (telemetry + systemInfo): ticks every 30 s, also runs the
 *                 daily sample-retention prune
 *
 * Each loop has its own `running` guard. A long-running heavy pass blocks
 * ONLY future heavy ticks; the light loop keeps firing on its own clock and
 * re-evaluates which assets are due every 5 s.
 *
 * Behavior dispatches on `Setting.monitor.queueMode` (captured at boot):
 *
 *   "cursor" (default) — Each tick calls runMonitorPass() to drain all due
 *                        work in-process via the cursor worker pool.
 *                        Default concurrency is CPU-aware
 *                        (POLARIS_PROBE_CONCURRENCY / POLARIS_HEAVY_CONCURRENCY).
 *
 *   "pgboss"           — Each tick scans the same due-asset set and submits
 *                        one job per (assetId, cadence), bulk-inserted per
 *                        queue, to the pg-boss queues registered in
 *                        queueService.startPgbossWorkers(). Workers
 *                        (potentially across multiple processes once we go
 *                        horizontal) drain the queues. The stately queue
 *                        policy + per-job singletonKey absorbs duplicates so
 *                        the publisher can re-evaluate every tick without
 *                        piling up stale jobs.
 *
 * Cadence pacing is per-asset (Asset.monitorIntervalSec / telemetryIntervalSec
 * / systemInfoIntervalSec, falling back to the global defaults), so the
 * tick interval is intentionally faster than any reasonable cadence —
 * isDue() filters out assets that aren't due yet.
 */

import { cpus } from "node:os";
import {
  runMonitorPass,
  runRetentionPrune,
  loadMonitorPassCandidates,
  resolveDueCadences,
  passSweepIntervalSec,
  type DuePassContext,
  type MonitorCadence,
} from "../services/monitoringService.js";
import { assetIdsWithEnabledWidgets } from "../services/customWidgetEnablementService.js";
import { getBootTimeMode, publishMonitorJobsBulk, publishMonitorSweepJob, publishProbeBatchJob } from "../services/queueService.js";
import { chunkForSweep } from "../utils/lossSweep.js";
import { setMonitoredAssets, setMonitorWorkers } from "../metrics.js";
import { defineJob } from "./_defineJob.js";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";

const PROBE_TICK_MS = 5_000;
const HEAVY_TICK_MS = 30_000;

function resolveConcurrency(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

const PROBE_CONCURRENCY = resolveConcurrency(
  "POLARIS_PROBE_CONCURRENCY",
  Math.max(8, Math.min(64, cpus().length * 2)),
);
const HEAVY_CONCURRENCY = resolveConcurrency(
  "POLARIS_HEAVY_CONCURRENCY",
  Math.max(4, Math.min(32, cpus().length)),
);

logger.info(
  { probeConcurrency: PROBE_CONCURRENCY, heavyConcurrency: HEAVY_CONCURRENCY, cores: cpus().length },
  "Monitor worker concurrency configured",
);

// Seed the worker-count gauge with cursor-mode caps. When pg-boss starts up
// later it overwrites these with its own per-queue localConcurrency values
// (see startPgbossWorkers); when pg-boss fails to start, the cursor caps
// remain — which is what the process is actually using in that fallback.
setMonitorWorkers({
  probe:        PROBE_CONCURRENCY,
  fastFiltered: PROBE_CONCURRENCY,
  telemetry:    HEAVY_CONCURRENCY,
  systemInfo:   HEAVY_CONCURRENCY,
});


/**
 * pg-boss publisher. Loads the same candidates as runMonitorPass
 * (loadMonitorPassCandidates), asks the same per-asset question
 * (resolveDueCadences), and submits one job per (assetId, cadence) to the
 * matching pg-boss queue, bulk-inserted per queue after the loop. Duplicates
 * of a still-queued job are absorbed by the stately queue policy +
 * singletonKey, so calling this every tick is safe.
 *
 * The candidate select and the due decision used to be mirrored copies kept
 * "in lockstep" by comment; they drifted (CQ-B035), so both now live once in
 * monitoringService and only the publishing differs here.
 */
/** Assets per batched-probe job. Smaller than the loss sweep's 500 because this
 *  payload carries a target + timeout per asset rather than a bare id, and
 *  because a status probe holding a worker slot delays down detection. */
const PROBE_BATCH_CHUNK = 250;

async function publishDueWork(cadences: MonitorCadence[]): Promise<void> {
  const enabled = new Set<MonitorCadence>(cadences);
  const now = new Date();

  // The per-integration verbose-debug flag used to ride a per-asset join of
  // the ENTIRE integration config — the same handful of blobs serialized once
  // per asset row, 2000× per tick. One integration read per tick resolves the
  // flag instead.
  const [integrations, candidates, widgetAssetIds] = await Promise.all([
    prisma.integration.findMany({ select: { id: true, config: true } }),
    // The SAME loader and select as the cursor pass (CQ-B035): two hand-kept
    // selects drifted, and the publisher's never loaded `monitored`, so the
    // loss sweep's eligibility predicate dropped every asset in pg-boss mode.
    // MONITOR_CANDIDATE_WHERE inside excludes assets in maintenance mode, so
    // both queue modes stop ALL server-driven polling during a window.
    loadMonitorPassCandidates(),
    // Assets with a custom widget switched on (business rule 130) — one query
    // per tick, and only on the tick that publishes the cadence.
    enabled.has("customWidget") ? assetIdsWithEnabledWidgets() : Promise.resolve(new Set<string>()),
  ]);

  // verboseDebug per integration, resolved once per tick: `verboseLogging`
  // must be true AND within the 30-minute auto-disable window. Workers check
  // the stamped flag to decide whether to emit pickup/finish lines.
  const verboseByIntegration = new Map<string, boolean>();
  for (const i of integrations) {
    const cfg = i.config as Record<string, unknown> | null;
    verboseByIntegration.set(
      i.id,
      cfg != null &&
        cfg.verboseLogging === true &&
        (typeof cfg.verboseLoggingEnabledAt !== "string" ||
          Date.now() - new Date(cfg.verboseLoggingEnabledAt as string).getTime() < 30 * 60 * 1000),
    );
  }

  // Every per-asset cadence job accumulates here and is bulk-inserted per
  // queue after the loop (publishMonitorJobsBulk) — the awaited per-asset
  // send() this replaces issued up to eight serialized round trips per asset,
  // which on a REST/SNMP-heavy fleet meant thousands of INSERTs inside one 5s
  // tick: the likeliest way for the tick to overrun its budget and silently
  // skip under the runningProbe guard. Same per-job singletonKey, so the
  // coalescing contract is unchanged.
  const dueJobs = new Map<MonitorCadence, Array<{ assetId: string; transport?: string; assetType?: string; verboseDebug?: boolean; probeIntervalSec?: number }>>();
  const queueJob = (
    cadence: MonitorCadence,
    assetId: string,
    labels: { transport?: string; assetType?: string; verboseDebug?: boolean; probeIntervalSec?: number },
  ): void => {
    let arr = dueJobs.get(cadence);
    if (!arr) { arr = []; dueJobs.set(cadence, arr); }
    arr.push({ assetId, ...labels });
  };

  // Assets due a loss burst this tick, accumulated across the loop and
  // published as chunks afterwards — the sweep measures a batch in one process
  // (utils/burstPing.ts), so it must not be enqueued one asset at a time.
  const sweepDue: string[] = [];
  // ICMP assets due a status probe this tick, published as chunks after the
  // loop. Each carries its RESOLVED timeout so the worker does not re-walk the
  // settings hierarchy per asset (and so a batch can never hand one asset
  // another's timeout — they are bucketed by it). The resolved interval rides
  // along too, so the worker can drop an asset an earlier, still-active chunk
  // has already polled (monitorStatus.probeStillDue).
  const probeBatchDue: Array<{ id: string; target: string; timeoutMs: number; intervalSec: number }> = [];

  // Same sweep cadence the cursor pass resolves (passSweepIntervalSec).
  const ctx: DuePassContext = {
    enabled, now, widgetAssetIds,
    sweepIntervalSec: await passSweepIntervalSec(candidates.length),
  };

  for (const a of candidates) {
    // WHICH cadences are due is resolveDueCadences, shared with the cursor
    // pass (monitoringService.computeDueWork) — the two due-sets are
    // contractually identical, so there is one implementation. This loop only
    // decides how to publish each due cadence.
    const { eff, due } = await resolveDueCadences(a, ctx);

    // Per-cadence transport labels for the work-duration histogram: each
    // cadence is labeled with the polling method it actually uses (probe →
    // responseTimePolling, telemetry → cpuMemoryPolling, systemInfo +
    // fastFiltered → interfacesPolling).
    const assetType = a.assetType ?? "unknown";
    // Per-integration verbose debug toggle, resolved once per tick above.
    const verboseDebug = a.discoveredByIntegrationId
      ? (verboseByIntegration.get(a.discoveredByIntegrationId) ?? false)
      : false;
    const labels    = { transport: eff.responseTimePolling || "unknown", assetType, verboseDebug };
    const telLabels = { transport: eff.cpuMemoryPolling    || "unknown", assetType, verboseDebug };
    const ifLabels  = { transport: eff.interfacesPolling   || "unknown", assetType, verboseDebug };

    if (due.probe) {
      // ICMP is collected here and published as chunks after the loop; every
      // other transport needs its own authenticated session (snmpMultiGet
      // batches OIDs WITHIN one session; it cannot span hosts).
      if (due.probeBatchTarget) {
        probeBatchDue.push({ id: a.id, target: due.probeBatchTarget, timeoutMs: eff.probeTimeoutMs, intervalSec: due.probeIntervalSec });
      } else {
        queueJob("probe", a.id, { ...labels, probeIntervalSec: due.probeIntervalSec });
      }
    }
    if (due.telemetry)    queueJob("telemetry",    a.id, telLabels);
    if (due.systemInfo)   queueJob("systemInfo",   a.id, ifLabels);
    if (due.fastFiltered) queueJob("fastFiltered", a.id, ifLabels);
    if (due.lldp)         queueJob("lldp",         a.id, { transport: eff.lldpPolling || "unknown", assetType, verboseDebug });
    if (due.storage)      queueJob("storage",      a.id, { transport: eff.storagePolling || "unknown", assetType, verboseDebug });
    if (due.customWidget) queueJob("customWidget", a.id, { transport: "snmp", assetType, verboseDebug });
    if (due.processes)    queueJob("processes",    a.id, { transport: eff.processesPolling ?? "unknown", assetType, verboseDebug });
    if (due.eventLog)     queueJob("eventLog",     a.id, { transport: eff.eventLogPolling ?? "unknown", assetType, verboseDebug });
    if (due.sdwan)        queueJob("sdwan",        a.id, { transport: "rest_api", assetType, verboseDebug });
    // One job per asset would put back the ~2000 process spawns a minute that
    // batching exists to remove.
    if (due.lossSample)   sweepDue.push(a.id);
  }

  // Flush the accumulated per-asset cadences — one bulk INSERT per queue.
  for (const [cadence, jobs] of dueJobs) {
    await publishMonitorJobsBulk(cadence, jobs);
  }

  // One job per chunk, keyed by chunk INDEX so a backed-up sweep coalesces
  // rather than piling on (see publishMonitorSweepJob).
  // Batched ICMP status probes. A smaller chunk than the loss sweep on purpose:
  // this payload carries a target and a timeout per asset rather than bare ids,
  // and one job is one worker slot held for the whole bucket set.
  let probeChunk = 0;
  for (let i = 0; i < probeBatchDue.length; i += PROBE_BATCH_CHUNK) {
    await publishProbeBatchJob(probeBatchDue.slice(i, i + PROBE_BATCH_CHUNK), probeChunk++);
  }

  let chunkIndex = 0;
  for (const c of chunkForSweep(sweepDue)) {
    await publishMonitorSweepJob("lossSample", c, chunkIndex++, { transport: "icmp", verboseDebug: false });
  }

  // Passive gets its own bucket: folding it into "unknown" would read as
  // "never probed" about devices that are being polled perfectly well.
  const total = candidates.length;
  let up = 0, down = 0, passive = 0;
  for (const a of candidates) {
    if (a.monitorStatus === "up") up++;
    else if (a.monitorStatus === "down") down++;
    else if (a.monitorStatus === "passive") passive++;
  }
  setMonitoredAssets(total, { up, down, passive, unknown: total - up - down - passive });
}

// Light loop: response time, fast-filtered interfaces, SD-WAN, loss samples.
// Runs at import, then every PROBE_TICK_MS; defineJob skips a tick while the
// previous pass is still publishing / probing.
defineJob({
  name: "monitorAssets.probe",
  intervalMs: PROBE_TICK_MS,
  firstRunDelayMs: 0,
  run: async () => {
    if (getBootTimeMode() === "pgboss") {
      await publishDueWork(["probe", "fastFiltered", "sdwan", "lossSample"]);
    } else {
      const stats = await runMonitorPass({
        cadences: ["probe", "fastFiltered", "sdwan", "lossSample"],
        concurrency: PROBE_CONCURRENCY,
      });
      if (stats.probed > 0 || stats.fastFiltered.collected > 0 || stats.sdwan.collected > 0 || stats.lossSample.collected > 0) {
        logger.debug({ stats }, "Light monitor pass complete");
      }
    }
  },
});

// Heavy loop: telemetry, system info, LLDP / storage / processes / event log,
// custom widgets, and the fleet-coordinated retention prune.
defineJob({
  name: "monitorAssets.heavy",
  intervalMs: HEAVY_TICK_MS,
  firstRunDelayMs: 0,
  run: async () => {
    if (getBootTimeMode() === "pgboss") {
      // Phase 2 carve-out: LLDP + Storage publish on the heavy tick alongside
      // telemetry + systemInfo. Cursor mode keeps the legacy
      // ["telemetry", "systemInfo"] set for those two — the cursor pass
      // doesn't drive the LLDP/Storage queues (pg-boss-only); the existing
      // systemInfo walk picks up LLDP + Storage as session-coalesced side
      // effects on cursor installs. The agentless "processes" and "eventLog"
      // cadences have NO side effect to ride, so they dispatch explicitly in
      // BOTH modes.
      // Manufacturer custom widgets (business rule 130) have no side effect to
      // ride either, so they dispatch in BOTH modes too.
      await publishDueWork(["telemetry", "systemInfo", "lldp", "storage", "processes", "eventLog", "customWidget"]);
    } else {
      const stats = await runMonitorPass({
        cadences: ["telemetry", "systemInfo", "processes", "eventLog", "customWidget"],
        concurrency: HEAVY_CONCURRENCY,
      });
      if (stats.telemetry.collected > 0 || stats.systemInfo.collected > 0 || stats.processes.collected > 0) {
        logger.debug({ stats }, "Heavy monitor pass complete");
      }
    }
    // Fleet-coordinated retention prune. runRetentionPrune owns the
    // due-check (persisted timestamp) + the cross-replica advisory lock, so
    // this is cheap and safe to call every heavy tick: the common not-due
    // path is a single indexed Setting read, and at most one monitor replica
    // fleet-wide ever runs the actual prune. (Replaces the old in-memory
    // `lastPruneAt = 0` trigger that fired on every process boot and, under a
    // restart loop, fanned into the 2026-06-17 DELETE pile-up.)
    const prune = await runRetentionPrune();
    if (!prune.skipped && (prune.monitor > 0 || prune.telemetry > 0 || prune.systemInfo > 0)) {
      logger.info(
        { pruned: prune.monitor, telPruned: prune.telemetry, sysPruned: prune.systemInfo },
        "Pruned old monitor samples",
      );
    }
  },
});

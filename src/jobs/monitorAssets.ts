/**
 * src/jobs/monitorAssets.ts
 *
 * Periodic asset monitoring tick. Splits work across TWO independent ticking
 * loops so a slow heavy collection (telemetry / systemInfo) on a wedged host
 * can't hold up per-minute probe polling for the rest of the fleet:
 *
 *   - Light loop  (probe + fastFiltered): ticks every 5 s
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
  resolveMonitorSettings,
  resolveProbeIntervalSec,
  MONITOR_CANDIDATE_WHERE,
  type MonitorCadence,
} from "../services/monitoringService.js";
import { getBootTimeMode, publishMonitorJobsBulk, publishMonitorSweepJob, publishProbeBatchJob } from "../services/queueService.js";
import {
  lossSweepIncludes,
  lossSweepIsDue,
  chunkForSweep,
  configuredSweepIntervalSec,
  resolveSweepIntervalSec,
} from "../utils/lossSweep.js";
import { detectFping } from "../utils/burstPing.js";
import { responseTimeProbeShouldQueue } from "../utils/pollingCompatibility.js";
import { runsHeavyCadences } from "../utils/monitorStatus.js";
import { setMonitoredAssets, setMonitorWorkers } from "../metrics.js";
import { runInstrumentedJob } from "./_metrics.js";
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

let runningProbe = false;
let runningHeavy = false;

/**
 * pg-boss publisher. Queries the same candidate set as runMonitorPass, runs
 * the same isDue() per-cadence checks, and submits one job per (assetId,
 * cadence) to the appropriate pg-boss queue, bulk-inserted per queue after
 * the loop. Duplicates of a still-queued job are absorbed by the stately
 * queue policy + singletonKey, so calling this every tick is safe.
 *
 * Note: small amount of intentional code duplication with runMonitorPass —
 * the candidate query and isDue logic are mirrored. Keeping the cursor and
 * publisher paths separate (rather than parametrizing runMonitorPass) makes
 * each one clearer to read and easier to evolve independently. Both paths
 * call `resolveMonitorSettings` per asset and use the same `isDue` semantics,
 * so the due-set is always identical between modes.
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
  // flag instead; `type` stays joined below (a scalar, and the identical
  // select the cursor twin uses in loadMonitorPassCandidates).
  const [integrations, candidates] = await Promise.all([
    prisma.integration.findMany({ select: { id: true, config: true } }),
    prisma.asset.findMany({
    // Shared with runMonitorPass — excludes assets in maintenance mode so
    // both queue modes stop ALL server-driven polling during a window.
    where: MONITOR_CANDIDATE_WHERE,
    select: {
      id: true,
      assetType: true,
      discoveredByIntegrationId: true,
      // Joined for the resolver — picks the source-default polling method.
      discoveredByIntegration: { select: { type: true } },
      monitorStatus: true,
      // Both counters ride the pg-boss payload for the probe worker; the
      // cursor path selects them too.
      consecutiveFailures: true, consecutiveSuccesses: true,
      lastMonitorAt: true, monitorIntervalSec: true,
      // ICMP loss-sampler inputs — mirrors loadMonitorPassCandidates.
      lastLossSampleAt: true, ipAddress: true, dnsName: true, hostname: true, status: true,
      lastTelemetryAt: true, cpuMemoryIntervalSec: true, temperatureIntervalSec: true,
      lastSystemInfoAt: true, systemInfoIntervalSec: true,
      // Phase 2 carve-out: LLDP + Storage each have their own cadence + queue.
      lastLldpAt:    true, lldpIntervalSec:    true,
      lastStorageAt: true, storageIntervalSec: true,
      // Agentless processes cadence (ssh/winrm): inventory anchor + the 60s
      // pinned/mapped sub-pass anchor + the pin arrays that arm the sub-pass.
      lastProcessesAt: true, lastProcessPinsAt: true, processesIntervalSec: true,
      processesPolling: true,
      monitoredProcesses: true, mappedProcesses: true,
      // Agentless event-log cadence due-calc inputs.
      lastEventLogAt: true, eventLogPolling: true,
      probeTimeoutMs: true,
      responseTimePolling: true,
      cpuMemoryPolling:    true,
      temperaturePolling:  true,
      interfacesPolling:   true,
      lldpPolling:         true,
      storagePolling:      true,
      monitoredInterfaces: true,
      monitoredStorage: true,
      monitoredIpsecTunnels: true,
      dependencySuppressed: true,
    },
    }),
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

  function isDue(last: Date | null, intervalSec: number): boolean {
    if (intervalSec <= 0) return false;
    if (!last) return true;
    return now.getTime() - last.getTime() >= intervalSec * 1000;
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
  // THE SWEEP CADENCE, resolved once per tick: the operator's interval, floored
  // at what the installed pinger can actually finish for a fleet this size.
  // Without fping the fallback forks per host, so a large fleet genuinely cannot
  // hold 60s and publishing at 60s anyway would just rely on the chunk jobs'
  // singleton keys to coalesce — graceful, but it wastes a tick every cycle and
  // hides the real cadence from the operator. `candidates.length` is the fleet
  // rather than the sweep-eligible subset, which errs toward the wider interval:
  // the eligible set is not known until the loop below has run.
  const sweepIntervalSec = resolveSweepIntervalSec(
    configuredSweepIntervalSec(),
    candidates.length,
    await detectFping(),
  );
  // ICMP assets due a status probe this tick, published as chunks after the
  // loop. Each carries its RESOLVED timeout so the worker does not re-walk the
  // settings hierarchy per asset (and so a batch can never hand one asset
  // another's timeout — they are bucketed by it). The resolved interval rides
  // along too, so the worker can drop an asset an earlier, still-active chunk
  // has already polled (monitorStatus.probeStillDue).
  const probeBatchDue: Array<{ id: string; target: string; timeoutMs: number; intervalSec: number }> = [];

  for (const a of candidates) {
    // Resolve effective settings via the four-tier hierarchy. Cached after
    // first lookup per (integration|manual, assetType) bucket.
    const eff = await resolveMonitorSettings({
      ...a,
      discoveredByIntegrationType: a.discoveredByIntegration?.type ?? null,
    });
    // Probe cadence: 2× the resolved interval when dependency-suppressed
    // (parent down), otherwise the configured cadence — no acceleration while a
    // failure/recovery run is being confirmed (that was the fast-confirm
    // re-probe; extra resolution during a run is now the ICMP loss sampler's
    // job, and it feeds packet loss only). ONE implementation shared with the
    // cursor path (monitoringService.computeDueWork) — the two due-sets are
    // contractually identical, and a second copy of this arithmetic is exactly
    // how they'd drift.
    const probeIntervalSec = resolveProbeIntervalSec(a, eff);
    const probe      = isDue(a.lastMonitorAt,    probeIntervalSec);
    // Pragmatic stream-split: cpuMemoryIntervalSeconds drives the unified
    // telemetry tick; collectTelemetry covers temperature in the same
    // session. A follow-up commit will split the dispatcher loop so
    // temperature gets its own independent cadence.
    const telemetry  = isDue(a.lastTelemetryAt,  eff.cpuMemoryIntervalSeconds);
    const systemInfo = isDue(a.lastSystemInfoAt, eff.systemInfoIntervalSeconds);
    // Phase 2 carve-out: LLDP + Storage run on independent cadences. The
    // legacy systemInfo path still walks both as side effects on a shared
    // SNMP session — persistLldpNeighbors + enqueueStorageSamples are
    // idempotent against any overlap so the dedicated cadences don't need
    // to suppress when systemInfo is also due.
    const lldp       = isDue(a.lastLldpAt,    eff.lldpIntervalSeconds);
    const storage    = isDue(a.lastStorageAt, eff.storageIntervalSeconds);
    const hasFastPin =
      (Array.isArray(a.monitoredInterfaces)   && a.monitoredInterfaces.length   > 0) ||
      (Array.isArray(a.monitoredStorage)      && a.monitoredStorage.length      > 0) ||
      (Array.isArray(a.monitoredIpsecTunnels) && a.monitoredIpsecTunnels.length > 0);

    // Pre-queue eligibility — mirrors the same checks in monitoringService
    // runMonitorPass. Assets that can never produce telemetry/systemInfo data
    // (managed switches/APs on REST API, methods with no telemetry delivery)
    // must be excluded here too, otherwise their timestamps never advance and
    // they permanently inflate the pg-boss queue on every tick.
    const isManagedSwitchOrAp = a.assetType === "switch" || a.assetType === "access_point";
    // "vcenter" (hypervisor-view quickStats) deliberately passes this gate —
    // it delivers telemetry via the per-integration warm cache.
    // ssh / winrm used to be excluded here because no collector existed;
    // agentlessHostService supplies one now. Keep in lockstep with
    // monitoringService.computeDueWork.
    const canTelemetry =
      eff.cpuMemoryPolling !== null &&
      eff.cpuMemoryPolling !== "icmp"  &&
      !(eff.cpuMemoryPolling === "rest_api" && isManagedSwitchOrAp);
    // systemInfo carries three streams (interfaces / lldp / storage). Treat
    // the cadence as runnable when ANY is enabled — collectSystemInfo gates
    // each stream internally. Mirrors the matching block in
    // monitoringService.runMonitorPass; keep them in sync.
    const anySysInfoStream =
      eff.interfacesPolling !== null ||
      eff.lldpPolling       !== null ||
      eff.storagePolling    !== null;
    const canSystemInfo =
      anySysInfoStream &&
      !(eff.interfacesPolling === "rest_api" && isManagedSwitchOrAp);

    // Heavy-cadence suppression: "up" AND not dependency-suppressed runs
    // telemetry / systemInfo / fastFiltered — plus a PASSIVE asset whose last
    // probe succeeded, since a passive device is still polled and its charts
    // are meant to keep filling. See the matching comment in
    // monitoringService.runMonitorPass; the shared predicate is what keeps
    // these two documented-lockstep twins from drifting.
    const isUp = runsHeavyCadences(a);

    // Per-cadence transport labels for the work-duration histogram. Each
    // cadence is labeled with the polling method it actually uses
    // (probe → responseTimePolling, telemetry → telemetryPolling,
    // systemInfo + fastFiltered → interfacesPolling). All four resolve
    // through the same hierarchy, so by this point eff.* is the source
    // of truth — same fidelity as runMonitorPass in monitoringService.
    const assetType = a.assetType ?? "unknown";
    const probeTransport = eff.responseTimePolling || "unknown";
    const telTransport   = eff.cpuMemoryPolling    || "unknown";
    const ifTransport    = eff.interfacesPolling   || "unknown";
    // Per-integration verbose debug toggle, resolved once per tick above.
    const verboseDebug = a.discoveredByIntegrationId
      ? (verboseByIntegration.get(a.discoveredByIntegrationId) ?? false)
      : false;
    const labels = { transport: probeTransport, assetType, verboseDebug };
    const telLabels = { transport: telTransport, assetType, verboseDebug };
    const ifLabels  = { transport: ifTransport,  assetType, verboseDebug };

    // Gates on the resolved method like every other stream below. Keep in
    // lockstep with the matching push in monitoringService.computeDueWork —
    // both call the shared predicate for exactly that reason.
    if (probe && enabled.has("probe") && responseTimeProbeShouldQueue(eff.responseTimePolling)) {
      // ICMP is the ONE transport where a single process can serve many hosts,
      // so it is collected here and published as chunks after the loop. Every
      // other transport stays one job per asset — SNMP, WinRM, SSH and REST
      // each need their own authenticated conversation with their own
      // credentials, so there is nothing to batch (snmpMultiGet batches OIDs
      // WITHIN one session; it cannot span hosts).
      if (eff.responseTimePolling === "icmp" && a.ipAddress) {
        probeBatchDue.push({ id: a.id, target: a.ipAddress, timeoutMs: eff.probeTimeoutMs, intervalSec: probeIntervalSec });
      } else {
        queueJob("probe", a.id, { ...labels, probeIntervalSec });
      }
    }
    if (telemetry && canTelemetry && isUp && enabled.has("telemetry")) {
      queueJob("telemetry", a.id, telLabels);
    }
    if (systemInfo && canSystemInfo && isUp && enabled.has("systemInfo")) {
      queueJob("systemInfo", a.id, ifLabels);
    }
    if (probe && hasFastPin && canSystemInfo && !systemInfo && isUp && enabled.has("fastFiltered")) {
      queueJob("fastFiltered", a.id, ifLabels);
    }
    // Phase 2 carve-out: LLDP rides "isUp" gate just like systemInfo because
    // it's a heavy SNMP-MIB / FortiOS REST walk we don't want hitting dead
    // hosts. Skipped when the resolved lldpPolling is disabled or not delivered.
    if (lldp && isUp && enabled.has("lldp") && eff.lldpPolling && eff.lldpPolling !== "disabled") {
      const lldpTransport = eff.lldpPolling || "unknown";
      queueJob("lldp", a.id, { transport: lldpTransport, assetType, verboseDebug });
    }
    // The dedicated storage cadence covers SNMP (hrStorageTable) and the
    // agentless transports (df / Get-Volume). Agent hosts push on their own
    // schedule and vCenter storage rides the system-info pass, so neither
    // belongs on this queue. Keep in lockstep with computeDueWork.
    if (storage && isUp && enabled.has("storage") &&
        (eff.storagePolling === "snmp" || eff.storagePolling === "ssh" || eff.storagePolling === "winrm")) {
      const storageTransport = eff.storagePolling || "unknown";
      queueJob("storage", a.id, { transport: storageTransport, assetType, verboseDebug });
    }
    // Agentless processes cadence — ssh/winrm only (agent-mode assets
    // self-collect; SNMP hrSWRunTable stays declared-but-unimplemented). Due
    // when the inventory interval elapsed OR pins/mapped names arm the 60s
    // sub-pass; runProcessesFor re-derives which sub-passes to run and stamps
    // the anchors even on failure so a bad credential can't re-queue every
    // tick. isUp gate: authenticated transports shouldn't hammer unconfirmed
    // hosts. Keep in sync with the matching block in runMonitorPass.
    if (isUp && enabled.has("processes") &&
        (eff.processesPolling === "ssh" || eff.processesPolling === "winrm")) {
      const procPins =
        ((a.monitoredProcesses?.length ?? 0) + (a.mappedProcesses?.length ?? 0)) > 0;
      const processesDue =
        isDue(a.lastProcessesAt, eff.processesIntervalSeconds) ||
        (procPins && isDue(a.lastProcessPinsAt, 60));
      if (processesDue) {
        queueJob("processes", a.id, { transport: eff.processesPolling, assetType, verboseDebug });
      }
    }
    // Agentless event-log cadence (ssh/winrm), same shape and the same isUp
    // gate as processes above. runEventLogFor re-checks the global
    // agentEventLog master switch and stamps its anchor even on failure, so a
    // bad credential can't re-queue every tick. Keep in sync with
    // computeDueWork.
    if (isUp && enabled.has("eventLog") &&
        (eff.eventLogPolling === "ssh" || eff.eventLogPolling === "winrm") &&
        isDue(a.lastEventLogAt, eff.eventLogIntervalSeconds)) {
      queueJob("eventLog", a.id, { transport: eff.eventLogPolling, assetType, verboseDebug });
    }
    // ICMP loss sweep: a uniform burst at EVERY eligible asset, whatever state
    // it is in. Deliberately NOT gated on isUp like the cadences above, and
    // deliberately not gated on monitorStatus either — the old sampler ran only
    // while an asset looked bad, and that window WAS the sampling bias that got
    // it disabled (utils/lossSweep.ts). Collected here and published in chunks
    // after the loop: one job per asset would put back the ~2000 process spawns
    // a minute that batching exists to remove. Keep in sync with computeDueWork.
    if (enabled.has("lossSample") &&
        lossSweepIncludes(a, eff) &&
        lossSweepIsDue(a.lastLossSampleAt, now, sweepIntervalSec)) {
      sweepDue.push(a.id);
    }
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

async function probeTick(): Promise<void> {
  if (runningProbe) return;
  runningProbe = true;
  try {
    await runInstrumentedJob("monitorAssets.probe", async () => {
      if (getBootTimeMode() === "pgboss") {
        await publishDueWork(["probe", "fastFiltered", "lossSample"]);
      } else {
        const stats = await runMonitorPass({
          cadences: ["probe", "fastFiltered", "lossSample"],
          concurrency: PROBE_CONCURRENCY,
        });
        if (stats.probed > 0 || stats.fastFiltered.collected > 0 || stats.lossSample.collected > 0) {
          logger.debug({ stats }, "Light monitor pass complete");
        }
      }
    });
  } catch (err) {
    logger.error({ err }, "Light monitor tick failed");
  } finally {
    runningProbe = false;
  }
}

async function heavyTick(): Promise<void> {
  if (runningHeavy) return;
  runningHeavy = true;
  try {
    await runInstrumentedJob("monitorAssets.heavy", async () => {
      if (getBootTimeMode() === "pgboss") {
        // Phase 2 carve-out: LLDP + Storage publish on the heavy tick alongside
        // telemetry + systemInfo. Cursor mode keeps the legacy
        // ["telemetry", "systemInfo"] set for those two — the cursor pass
        // doesn't drive the LLDP/Storage queues (pg-boss-only); the existing
        // systemInfo walk picks up LLDP + Storage as session-coalesced side
        // effects on cursor installs. The agentless "processes" and "eventLog"
        // cadences have NO side effect to ride, so they dispatch explicitly in
        // BOTH modes.
        await publishDueWork(["telemetry", "systemInfo", "lldp", "storage", "processes", "eventLog"]);
      } else {
        const stats = await runMonitorPass({
          cadences: ["telemetry", "systemInfo", "processes", "eventLog"],
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
    });
  } catch (err) {
    logger.error({ err }, "Heavy monitor tick failed");
  } finally {
    runningHeavy = false;
  }
}

probeTick();
heavyTick();
setInterval(probeTick, PROBE_TICK_MS);
setInterval(heavyTick, HEAVY_TICK_MS);

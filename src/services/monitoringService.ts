/**
 * src/services/monitoringService.ts
 *
 * Asset uptime / response-time monitoring. Runs an authenticated probe per
 * asset based on `Asset.monitorType`:
 *   - fortimanager / fortigate → FortiOS REST GET /api/v2/monitor/system/status
 *   - activedirectory          → reuses the AD integration's bindDn/bindPassword;
 *                                Windows hosts get a WinRM SOAP Identify, Linux
 *                                hosts (realm-joined) get an SSH connect+auth
 *   - snmp                     → net-snmp authenticated GET on sysUpTime
 *   - winrm                    → SOAP Identify with HTTP basic auth
 *   - ssh                      → ssh2 connect+authenticate
 *   - icmp                     → spawn the system ping
 *
 * A "successful" probe means the credential authenticated and the device
 * answered (so a misconfigured credential surfaces as down rather than up).
 *
 * Each probe writes one AssetMonitorSample row (responseTimeMs is null on
 * failure — that's the "packet loss" signal). The asset's
 * `consecutiveFailures` counter rolls forward; when it crosses
 * `monitor.failureThreshold`, the asset transitions to `monitorStatus = "down"`
 * and a single `monitor.status_changed` Event is emitted. Recovery
 * transitions emit one as well.
 *
 * CQ-B061: the probes, collectors, persisters and the settings resolver now
 * live in src/services/monitoring/*.ts (layered, none imports this file back);
 * this file keeps the pass orchestration and re-exports every public name.
 */

import { tryCompileSafeRegex } from "../utils/safeRegex.js";
import type { Prisma } from "../generated/prisma/client.js";
import { performance } from "node:perf_hooks";

import { prisma } from "../db.js";
// NOTE: agentlessProcessService imports back from this module with
// `import type` only, so this pair can't cycle at runtime.
import { collectProcessesSsh, collectProcessesWinrm, type AgentlessProcessResult } from "./agentlessProcessService.js";
import {
  collectHostSsh, collectHostWinrm, collectEventLogSsh, collectEventLogWinrm,
  type AgentlessEventLogEntry,
} from "./agentlessHostService.js";
import { ingestOsEventLog, getAgentEventLogConfig } from "./osEventLogService.js";
import { ipv6Dialable } from "./ipv6GateService.js";
import { applyTransform } from "../utils/symbolTransforms.js";
import {
  lossSweepIncludes,
  lossSweepTarget,
  lossSweepIsDue,
  chunkForSweep,
  configuredSweepIntervalSec,
  resolveSweepIntervalSec,
} from "../utils/lossSweep.js";
import { burstPing, pingTargets, detectFping } from "../utils/burstPing.js";
import { stampsRecoveryAnchor } from "../utils/probeLossAnchor.js";
import { pollingRunStart } from "../utils/addressConfidence.js";
import { parseFortiosMemberList, buildFortiswitchTrunkMembers, findFortiswitchUplinkPorts } from "../utils/fortiswitchCmdb.js";
// Re-exported so existing import sites (unit tests, etc.) keep resolving these
// from monitoringService; implementations live in utils/fortiswitchCmdb.ts.
export { parseFortiosMemberList, buildFortiswitchTrunkMembers, findFortiswitchUplinkPorts };
import { logEvent, type LogEventInput } from "./eventLogService.js";
import { logger } from "../utils/logger.js";
import { adBindFallbackAllowed, adBindFallbackIntegration } from "../utils/adBindFallback.js";
import { resolveOidSync, ensureRegistryLoaded, type ResolveScope } from "./oidRegistry.js";
import { pickDbProfile } from "./profileResolver.js";
import {
  startPassTimer,
  startWorkTimer,
  recordWorkOutcome,
  recordProbe,
  setMonitoredAssets,
  setQueueDepth,
  startSampleWriteTimer,
} from "../metrics.js";
import { enqueueMonitorSample, enqueueStorageSamples, enqueueProcessSamples } from "./sampleWriteBuffer.js";
import { joinStateRows } from "../utils/stateProbes.js";
import { enqueueProbePatch, getPendingProbePatch } from "./probePatchBuffer.js";
import { recoveryPollsFor, resolveDownDetection } from "./downDetectionService.js";
import {
  isConfigStatusEdge,
  monitorStatusFor,
  nextFailureBucket,
  probeStillDue,
  runsHeavyCadences,
  statusEventDecision,
  statusEventPairs,
  type MonitorStatus,
} from "../utils/monitorStatus.js";
import { assetSourceKindFromIntegrationType, isFortinetIntegrationType, responseTimeProbeShouldQueue } from "../utils/pollingCompatibility.js";
import { enabledWidgetIdsForAsset, assetIdsWithEnabledWidgets, widgetProfileForAsset } from "./customWidgetEnablementService.js";
import { collectGenericApiWidgetSamples } from "./genericApiMonitorService.js";
import { propagateAfterStatusChange } from "./dependencyTreeService.js";
import { triggerRetryAfterStatusChange } from "./reservationService.js";
import { formatUptimeLong } from "../utils/uptime.js";
import { pickRestApiCredential } from "../utils/fortinetRestCredential.js";

// CQ-B061 — the address every stream dials (monitoring/dial.ts).
import { dial } from "./monitoring/dial.js";

// CQ-B061 — the monitor settings hierarchy + resolver (monitoring/monitorSettings.ts).
import { type MonitorTierSettings, type ResolvedMonitorSettings, resolveSdwanIntervalSec, PROBE_ASSET_OMIT, type AssetMonitorContext, resolveMonitorSettings, loadClassOverrideStreamCredential, resolveSnmpConfigForStream, resolveAgentlessCredConfig, winrmConnFrom, loadSnmpCredentialConfigForFortinetAsset } from "./monitoring/monitorSettings.js";

// CQ-B061 — the stream sample / result types (monitoring/types.ts).
import { type ProbeResult, type TelemetrySample, type StorageSample, type HardwareSensorSample, type LldpNeighborSample, type CollectionResult, type AssetMonitorSnapshot } from "./monitoring/types.js";

// CQ-B061 — finish() + the verbose phase spans (monitoring/common.ts).
import { monitorPhaseStorage, startPhase } from "./monitoring/common.js";

// CQ-B061 — the SNMP session layer (monitoring/snmpCore.ts).
import { OID, snmpWalk, snmpVbToString, snmpVbToNumber, withSnmpSession } from "./monitoring/snmpCore.js";

// CQ-B061 — the SNMP collectors (monitoring/snmpCollectors.ts).
import { collectVendorDiskFallback, collectLldpOnlySnmp } from "./monitoring/snmpCollectors.js";

// CQ-B061 — the FortiOS REST collectors (monitoring/fortiosCollectors.ts).
import { buildFortinetConfig, collectLldpOnlyFortinet, collectSdwanFortinet } from "./monitoring/fortiosCollectors.js";

// CQ-B061 — process connections, LLDP neighbours, wireless stations (monitoring/neighborPersistence.ts).
import { persistProcessConnections, persistLldpNeighbors } from "./monitoring/neighborPersistence.js";

// CQ-B061 — poll attempt / success stamps (business rule 118) (monitoring/pollStamps.ts).
import { recordTelemetryResult, recordHardwareSensorResult } from "./monitoring/pollStamps.js";

// CQ-B061 — recordSystemInfoResult + its stream persisters (monitoring/systemInfoPersist.ts).
import { persistPerfSlaSampleStream, recordSystemInfoResult, persistSdwanRules, persistAssetProcesses } from "./monitoring/systemInfoPersist.js";

// CQ-B061 — the response-time probes (monitoring/probes.ts).
import { probeAsset, probeHttp } from "./monitoring/probes.js";

// CQ-B061 — per-stream collection dispatch (monitoring/streamCollection.ts).
import { loadTelemetryAsset, type TelemetryAssetRow, collectTelemetry, collectHardwareSensors, collectFastFiltered, recordFastFilteredResult, collectSystemInfo } from "./monitoring/streamCollection.js";
export { collectTelemetry, collectHardwareSensors, collectSystemInfo } from "./monitoring/streamCollection.js";

export { probeAsset, probeCredentialAgainstHost } from "./monitoring/probes.js";

export { persistAgentAddressRows, recordSystemInfoResult, type AssetProcessInput, persistAssetProcesses } from "./monitoring/systemInfoPersist.js";

export { telemetrySuccessStamps, systemInfoSuccessStamps, recordTelemetryResult, recordHardwareSensorResult } from "./monitoring/pollStamps.js";

export { type ProcessConnectionInput, persistProcessConnections, persistManagedApLldpNeighbors } from "./monitoring/neighborPersistence.js";

export { type VcenterReading } from "./monitoring/vcenterFmgCollectors.js";

export { fetchFortinetControllerInventory } from "./monitoring/fortinetControllers.js";

export { snmpWalkRaw } from "./monitoring/snmpCollectors.js";

export { invalidateLldpMatchCache } from "./monitoring/lldpMatchIndex.js";

export { type ProbeResult, type TelemetrySample, type InterfaceSample, type StorageSample, type HardwareSensorSample, type LldpNeighborSample, type SystemInfoSample, type CollectionResult, type AssetMonitorSnapshot } from "./monitoring/types.js";

export { type MonitorTierSettings, type ResolvedMonitorSettings, getAdMonitorProtocol, SDWAN_INTERVAL_DEFAULT_SEC, resolveSdwanIntervalSec, invalidateMonitorSettingsCache, PROBE_ASSET_OMIT, type FleetCadences, fleetCadences, resolveMonitorSettings, resolveMonitorSettingsWithProvenance } from "./monitoring/monitorSettings.js";

// CQ-B061 — sample retention pruning (monitoring/retentionPrune.ts).
export { RETENTION_PRUNE_INTERVAL_MS, runRetentionPrune } from "./monitoring/retentionPrune.js";

// ─── Persisting a probe result ──────────────────────────────────────────────

/**
 * Apply a probe result to the asset row + history. Updates
 * monitorStatus / consecutiveFailures, writes one AssetMonitorSample, and
 * fires a single monitor.status_changed Event on transition.
 */
export async function recordProbeResult(
  assetId: string,
  result: ProbeResult,
  /** Optional pre-loaded asset row. The cursor + pg-boss hot loop already
   *  loaded the asset inside probeAsset; passing it here skips a second
   *  findUnique per probe, cutting steady-state pool acquisitions at peak. */
  preloadedAsset?: AssetMonitorSnapshot | null,
  /** Set by the Polaris Agent /samples handler when the result came from
   *  the agent on the host (a real RTT, not the synthetic periodic-tick).
   *  Bypasses the agent-polling guard below so the agent's real samples
   *  drive the five-state machine. The default (periodic-loop callers
   *  leaving this false/undefined) keeps the guard active so the
   *  synthetic no-op probeAsset doesn't churn state.
   *
   *  `observedAt` is when the reading was actually TAKEN, when the caller
   *  knows it to be earlier than the moment it is recorded. The batched ICMP
   *  probe passes the instant its echoes went out: the chunk only returns once
   *  its slowest target times out, so stamping at record time would place
   *  every reading up to a probe timeout late and stretch the cadence by the
   *  same amount. It sets the sample timestamp and the `lastMonitorAt` anchor
   *  only; status-change time and Events still use the record time.
   *
   *  `timeoutMs` is how long THIS probe waited before giving up — the asset's
   *  resolved `probeTimeoutMs`, which the caller has already computed to run
   *  the probe at all. Recorded on the sample when the probe FAILED, so a
   *  count window can fill the miss with the time it actually cost rather than
   *  dropping it or inventing a zero (business rule 67). Absent from a caller
   *  that has no timeout of its own (the agent's real samples) and ignored on
   *  a success, which carries a real RTT. */
  opts?: { fromAgent?: boolean; observedAt?: Date; timeoutMs?: number },
): Promise<void> {
  const loaded = preloadedAsset ?? await prisma.asset.findUnique({
    where: { id: assetId },
    select: {
      id: true,
      hostname: true,
      assetType: true,
      monitored: true,
      monitorStatus: true,
      lastUptimeSec: true,
      consecutiveFailures: true,
      consecutiveSuccesses: true,
      discoveredByIntegrationId: true,
      monitorIntervalSec: true,
      cpuMemoryIntervalSec: true,
      temperatureIntervalSec: true,
      systemInfoIntervalSec: true,
      probeTimeoutMs: true,
      dependencySuppressed: true,
      ipAddress: true, ipv6Address: true,
      ipConfirmedFor: true,
      ipConfirmedSince: true,
    },
  });
  if (!loaded) return;

  // Overlay any pending probe-patch buffer entry onto the loaded row so the
  // state machine reads its own writes within the flush window. Without this
  // overlay, two back-to-back failed probes inside the same 2 s window would
  // each see consecutiveFailures=0 on disk and each compute newCf=1; the
  // second probe's patch would overwrite the first and the failureThreshold
  // counter would never advance past 1. The overlay only touches the three
  // fields the state machine uses; everything else (hostname, assetType,
  // intervals, etc.) flows through unchanged from the DB read.
  const pending = getPendingProbePatch(assetId);
  const asset = pending
    ? {
        ...loaded,
        monitorStatus:        pending.monitorStatus,
        consecutiveFailures:  pending.consecutiveFailures,
        consecutiveSuccesses: pending.consecutiveSuccesses,
        // A run started earlier in this window must not be restarted by the
        // next probe reading the stale row (rule 103).
        ...(pending.ipConfirmedFor !== undefined
          ? { ipConfirmedFor: pending.ipConfirmedFor, ipConfirmedSince: pending.ipConfirmedSince ?? null }
          : {}),
      }
    : loaded;

  // A skipped probe is not a reading. No sample, no counter movement, no
  // state transition — just the cadence anchor, so the next tick is spaced
  // normally rather than re-firing immediately for every asset behind a
  // hypervisor manager that is currently unreachable.
  if (result.skipped) {
    await prisma.asset.update({ where: { id: assetId }, data: { lastMonitorAt: new Date() } });
    return;
  }

  // Resolve effective settings through the hierarchy. NOTE the down threshold
  // is NOT read from here any more — `failureThreshold` on the settings tiers
  // is dormant (see the deprecation note on MonitorTierSettings). This resolver
  // still supplies the cadence and the probe timeout.
  const effective = await resolveMonitorSettings(asset);

  // Agent-mode response-time: the Polaris Agent runs on the host and pushes
  // its own samples (with real RTTs) through POST /api/v1/agents/samples.
  // Periodic-tick probeAsset for these assets returns a synthetic success;
  // we MUST NOT let that synthetic result run the state machine or write
  // an AssetMonitorSample row — it would clobber the agent's real signal.
  // The /samples inbound handler calls this function with opts.fromAgent
  // so the agent's real samples DO drive the state machine.
  //
  // The one exception is `agentSilent` (business rule 86): the agent should
  // have pushed by now and has not, so the missing push IS the miss. It runs
  // the full path below — failed sample, bucket, status, cadence stamp — so
  // the covering automation's missedPolls calls a dead host down.
  if (effective.responseTimePolling === "agent" && !opts?.fromAgent && !result.agentSilent) return;

  // WHO decides this device is down: the covering down-detection automation,
  // most-specific-wins (business rule 18's ladder). null = no automation covers
  // it, so we render no verdict at all and the asset reads "passive".
  //
  // The SAME automation decides the way back. The bucket's drain is the floor —
  // as many answers as it took misses, exactly as failureThreshold used to —
  // and the automation's reset sustain raises it when the operator asked for a
  // longer confirmation run ("down after 3 missed, reset after 5 received").
  // Converted from the stored seconds at THIS asset's cadence, so a rule
  // authored against a 60s interval still means five polls on a device polled
  // every five minutes rather than one.
  //
  // One Map lookup in the steady state; see downDetectionService for why this
  // is safe on a per-probe path at 2000 assets.
  const verdict = await resolveDownDetection(assetId);
  const threshold = verdict?.threshold ?? null;
  const recoveryPolls = verdict ? recoveryPollsFor(verdict, effective.intervalSeconds) : 0;

  const now = new Date();
  const observedAt = opts?.observedAt ?? now;
  const previousStatus = asset.monitorStatus ?? "unknown";
  // Counter update. `consecutiveFailures` is a LEAKY BUCKET WITH A CEILING, not
  // a run length and no longer an unbounded debt — see business rule 30 and
  // `nextFailureBucket`, which owns the whole arithmetic so the probe path, the
  // browser replay and the email replay cannot drift.
  //
  // A miss adds one, a success TAKES ONE BACK (floored at 0). The run-length
  // version forgot an outage the instant one packet answered, so a device
  // alternating miss/answer/miss/answer sat at cf=1 forever and never reached
  // ANY verdict, while a device that had already missed threshold-1 times was
  // handed a clean slate by a single lucky poll. The bucket keeps the debt.
  //
  // What the bucket does NOT do any more is keep accruing once the outage is
  // declared. It locks at `bucketCapFor(threshold, recoveryPolls)` — the larger
  // of the missed-poll count and the automation's reset count — so recovery
  // costs exactly what the operator wrote down instead of one answered poll per
  // minute the device happened to be dark. Unbounded, an overnight outage left
  // cf ≈ 480 and the asset read `down` for the whole of the following morning
  // while answering every probe, with its alert repeating and escalating
  // throughout.
  const newCf = nextFailureBucket(asset.consecutiveFailures ?? 0, result.success, threshold, recoveryPolls);
  // Still maintained and still written: it is a true fact about the device, it
  // is charted, and the probe-patch overlay carries it. It decides nothing —
  // the bucket's own level is now the whole of the recovery arithmetic.
  const newCs = result.success ? (asset.consecutiveSuccesses ?? 0) + 1     : 0;

  // Six-state machine — a pure function of the bucket level above and the
  // outcome of THIS probe (`monitorStatusFor`). `previousStatus` does not
  // participate: the bucket carries every bit of history the verdict needs.
  //
  //   passive                     — no down-detection automation covers this
  //                                 asset, so Polaris renders NO verdict. Still
  //                                 polled, sampled and charted; the bucket
  //                                 still moves, it is simply never compared.
  //
  //   cf = 0                      → up          (green — the debt is paid off)
  //   this probe answered         → recovering  (climbing back, misses left)
  //   missed, cf >= threshold     → down        (the verdict, in the covering
  //                                 automation's own severity colour)
  //   missed, cf <  threshold     → warning     (amber — "Missed N")
  //
  // The ANSWERED branch is unconditional as of 2026-09-01. It used to sit below
  // the threshold test, so a probe that answered while the bucket was still at
  // or above the threshold read `down` — defensible for a verdict, but the
  // response-time chart cannot paint an `ok` point red and fell through to the
  // series green, so a long outage drew red → GREEN → blue → green and looked
  // like the device recovered twice. With the bucket locked, an answered probe
  // during an outage is unambiguously the device climbing back.
  //
  // It does not clear the alert early. DOWN_ALERT_HOLDING_STATES holds a down
  // alert through `down`/`recovering`/`warning`, so the alert ends when the
  // asset reads `up` — which is precisely when the drain has served the
  // automation's reset count. That is why the separate `owesRecoveryConfirmation`
  // hold at cf 0, and the `Asset.awaitingRecoveryConfirm` bit it read, are gone:
  // the cap does that work, and it does it without needing memory.
  //
  // Down is still sticky in exactly one direction — it holds until the bucket
  // drains below the threshold — and a miss anywhere in the climb re-locks it
  // at the cap, so a flapping device cannot walk itself out of an outage.
  //
  // The previous name for `recovering` was "pending".
  const nextStatus: MonitorStatus = monitorStatusFor(newCf, result.success, threshold);

  // Buffer the sample row — the periodic flush in sampleWriteBuffer will
  // batch this with every other monitor sample seen in the same 2 s
  // window into one createMany. Cuts per-probe pool acquisitions from
  // (read + create + update) to (read + update); the sample inserts
  // collapse from N individual creates to one createMany per flush.
  // Reboot detection: the SNMP probe reads sysUpTime as its reachability OID;
  // a decrease vs. the last reading means the device rebooted between probes.
  // A small tolerance avoids false positives from counter wrap / clock skew on
  // a flat reading. Only meaningful when this probe carried an uptime value.
  const uptimeSec = result.success && typeof result.uptimeSec === "number" ? result.uptimeSec : null;
  const prevUptimeSec = asset.lastUptimeSec ?? null;
  const rebooted = uptimeSec !== null && prevUptimeSec !== null && uptimeSec < prevUptimeSec - 60;

  enqueueMonitorSample({
    assetId,
    timestamp: observedAt,
    success: result.success,
    responseTimeMs: result.success ? result.responseTimeMs : null,
    error: result.success ? null : (result.error ?? null),
    uptimeSec,
    // Mark the miss as EXPLAINED when the parent was dark at probe time. The
    // probe keeps running while suppressed (full cadence — the device may still
    // answer over a redundant path, and its own count is what lets it leave
    // Dep. Down with its parent, business rule 38(c)), so these rows
    // exist either way; the flag is what lets every chart draw the stretch grey
    // instead of the red dive that claims an unexplained outage. Read off the
    // asset row rather than re-derived here: `dependencySuppressed` is owned by
    // the 60s reconciler + its post-status-change hook, and re-deciding it on
    // the probe path would give two answers to one question. Only ever set on a
    // failure — a suppressed device that ANSWERS is a plain success.
    dependencyDown: !result.success && asset.dependencySuppressed === true ? true : null,
    // And mark the miss as being THE OUTAGE when this probe is what declares
    // (or continues) one. Packet loss steps over these rows, because a miss
    // taken while the device is down is the outage the down automation already
    // alerts on — counting it as loss trails a second alert behind every
    // recovery, for a window's worth of ticks after the device came back
    // (business rule 29h). Read off `nextStatus`, the status this probe RESULTS
    // in, so the misses below the threshold — amber on the strip, "Missed" on
    // the pill — still count as loss and only the ones the operator's own
    // automation calls Down do not. Only ever set on a failure.
    assetDown: !result.success && nextStatus === "down" ? true : null,
    // And record what the miss COST: the timeout this probe waited out. Only
    // on a failure (a success has a real RTT) and only when the caller knew it
    // — the agent's samples carry no timeout of ours. This is what lets a
    // count window read a missed poll as "at least this slow" instead of
    // discarding it, without the engine re-resolving monitor settings per
    // asset on its own tick (business rule 67).
    timeoutMs: !result.success && typeof opts?.timeoutMs === "number" && opts.timeoutMs > 0
      ? Math.round(opts.timeoutMs)
      : null,
  });

  // Buffer the state write — the periodic flush in probePatchBuffer collapses
  // every patch seen in the same 2 s window into one bulk UPDATE FROM VALUES
  // statement, cutting per-probe pool acquisitions from one prisma.asset.update
  // per asset to one bulk update per flush across the whole fleet. The
  // overlay above means the state machine still reads its own writes within
  // the window; the side effects below (Event log, propagate hook, retry
  // hook) all run synchronously on in-memory values so audit + latency-
  // optimization paths don't wait for the flush. Stamp monitorStatusChangedAt
  // on every state change (up↔warning↔recovering↔down, including
  // unknown→anything). The Event log fires on up ↔ down only (see below);
  // this column is the source for the Dashboard Monitor Alerts duration.
  enqueueProbePatch(assetId, {
    monitorStatus: nextStatus,
    lastMonitorAt: observedAt,
    lastResponseTimeMs: result.success ? result.responseTimeMs : null,
    consecutiveFailures: newCf,
    consecutiveSuccesses: newCs,
    // `awaitingRecoveryConfirm` is deliberately NOT written any more. The bucket
    // cap serves the automation's reset count on its own, so the bit decides
    // nothing; the column survives dormant (the `cooldownSec` precedent) and is
    // zeroed fleet-wide once by jobs/clampFailureBucket.
    monitorStatusChangedAt: previousStatus !== nextStatus ? now : undefined,
    // The packet-loss anchor (business rule 29b): the success that ended an
    // outage. "down"/"unknown" are the only states a device leaves on a
    // success without having been answering, so this stamps exactly the
    // recovery entry — whether it lands in "recovering" or (threshold 1) goes
    // straight to "up". A warning->up recovery deliberately does NOT stamp: a
    // flapping device passes through warning constantly, and anchoring there
    // would collapse its loss window to the last few probes and read 0%.
    // Undefined otherwise, so the flush's COALESCE keeps the prior stamp until
    // the next outage ends.
    recoveryStartedAt: stampsRecoveryAnchor(previousStatus, result.success) ? now : undefined,
    // Advance the stored uptime to this reading (undefined leaves it
    // untouched on probes that didn't report uptime — see the COALESCE in
    // probePatchBuffer); stamp the reboot timestamp only when a drop was
    // detected this tick.
    lastUptimeSec: uptimeSec ?? undefined,
    lastRebootAt: rebooted ? now : undefined,
    // The probe carried sysDescr this tick, so the identity read is done for
    // another DESCR_READ_INTERVAL_SEC. Stamped whenever the string came back
    // — parseable or not — because an unparseable answer is still an answer,
    // and re-asking every 60s would never start parsing. Undefined otherwise,
    // so the flush's COALESCE keeps the prior stamp.
    lastDescrAt: result.sysDescr ? now : undefined,
    // Presence: a successful probe IS the authoritative "last online" signal
    // for a monitored asset (bumpLastSeen defers discovery-origin evidence on
    // monitored assets to this). `now` is always the freshest evidence, so set
    // unconditionally on success; a failed probe leaves both undefined so the
    // flush COALESCE freezes lastSeen at the last successful poll.
    lastSeen: result.success ? now : undefined,
    lastSeenSource: result.success ? "probe" : undefined,
    // Rule 103's polling evidence: a new run starts on this address.
    ...pollingRunStart(asset, result.success, previousStatus, !!opts?.fromAgent || effective.responseTimePolling === "agent", now),
  });

  // Reboot is an edge-triggered audit event, like monitor.status_changed.
  // resourceName/details carry hostname + IP so the Recent Reboots widget can
  // render without re-reading the Asset.
  if (rebooted) {
    logEvent({
      action: "device.reboot",
      resourceType: "asset",
      resourceId: assetId,
      resourceName: asset.hostname || undefined,
      level: "warning",
      message: `Reboot detected: ${asset.hostname || assetId} uptime ${formatUptimeLong(prevUptimeSec)} → ${formatUptimeLong(uptimeSec)}`,
      details: { hostname: asset.hostname ?? null, previousUptimeSec: prevUptimeSec, uptimeSec },
    });
    // Business rule 115(b): a device that has rebooted no longer needs the
    // reboot booked for it. Lazy import — the probe path loads it only on a
    // reboot. Fire-and-forget like the Event above; it never throws.
    void import("./rebootScheduleCancel.js").then(({ cancelPendingRebootAfterReboot }) =>
      cancelPendingRebootAfterReboot({ assetId, cause: "detected", actor: "system:monitor", resourceName: asset.hostname || undefined }),
    ).catch(() => undefined);
  }

  // Entering or leaving "passive" is a CONFIGURATION edge, not a device edge:
  // it happens the instant an operator saves, rescopes or deletes a
  // down-detection automation, and one such save can move thousands of assets
  // across the line at once. Treating it as a device transition would burst one
  // Event and one dependency propagation PER ASSET from a single click. The
  // rule-CRUD audit trail (notification_rule.updated) already records the cause,
  // and the fleet-wide "nothing is being judged" case gets its own one-shot
  // Event from downDetectionService.
  const configEdge = isConfigStatusEdge(previousStatus, nextStatus);

  // Edge-triggered audit events — up ↔ down only (statusEventDecision). A
  // missed poll (→warning) and its recovery are NOT logged: one lost SNMP reply
  // every few minutes used to fill the Events page with up/warning pairs that
  // described no outage. The propagate / retry side-effects below are a
  // separate guard and are unchanged.
  const statusEvent = statusEventDecision(previousStatus, nextStatus);
  if (statusEvent !== "skip") {
    const statusEventInput: LogEventInput = {
      action: "monitor.status_changed",
      resourceType: "asset",
      resourceId: assetId,
      resourceName: asset.hostname || undefined,
      level: nextStatus === "up" ? "info" : "warning",
      message:
        `Monitor: ${asset.hostname || assetId} ${nextStatus === "up" ? "down" : previousStatus} → ${nextStatus}` +
        (result.error ? ` (${result.error})` : ""),
      details: {
        previousStatus,
        nextStatus,
        responseTimeMs: result.success ? result.responseTimeMs : null,
        error: result.error ?? null,
        consecutiveFailures:  newCf,
        consecutiveSuccesses: newCs,
      },
    };
    if (statusEvent === "log") logEvent(statusEventInput);
    else void logStatusEventIfPaired(assetId, nextStatus === "up" ? "up" : "down", statusEventInput);
  }

  if (!configEdge && previousStatus !== nextStatus && (nextStatus === "up" || nextStatus === "down")) {
    // Fire-and-forget latency hook: propagate the confirmed-up / confirmed-down
    // edge into descendant `dependencySuppressed` state immediately so heavy
    // cadences pause within milliseconds of the parent flipping to "down"
    // (and resume the moment it recovers). The 60s reconciler is the source
    // of truth; this just shortens the worst-case lag from ~60s to one
    // probe-tick on the parent.
    void propagateAfterStatusChange(assetId);
    // When a firewall comes back up, kick the queued-reservation retry job
    // so pending DHCP reservations on its subnets push immediately instead
    // of waiting for the next 60s retryQueuedReservationPushes tick. The
    // helper short-circuits to zero work when nothing is queued, so this is
    // cheap even on every up-transition.
    if (nextStatus === "up") {
      void triggerRetryAfterStatusChange(assetId);
    }
  }
}

/**
 * Write an up/down `monitor.status_changed` Event whose edge leaves recovering /
 * warning only when it alternates with the asset's latest status Event
 * (statusEventPairs): an up that ends an outage, a down that starts a new one.
 * Runs only on those edges, so it is one indexed read (Event
 * @@index([assetId, timestamp])) per edge, never per poll.
 */
async function logStatusEventIfPaired(assetId: string, next: "up" | "down", input: LogEventInput): Promise<void> {
  try {
    const last = await prisma.event.findFirst({
      where: { assetId, action: "monitor.status_changed" },
      orderBy: { timestamp: "desc" },
      select: { details: true },
    });
    const lastNext = (last?.details as { nextStatus?: unknown } | null)?.nextStatus;
    if (statusEventPairs(lastNext, next)) await logEvent(input);
  } catch (err) {
    logger.warn({ err, assetId }, "monitor.status_changed recovery lookup failed");
  }
}

// ─── Bulk pass + sample retention ───────────────────────────────────────────

interface RunStats {
  probed:    number;
  succeeded: number;
  failed:    number;
  /** System tab cadences. Tallied separately so a slow telemetry call doesn't look like a probe failure. */
  telemetry:    { collected: number; failed: number };
  systemInfo:   { collected: number; failed: number };
  fastFiltered: { collected: number; failed: number };
  /** Agentless (ssh/winrm) processes cadence — cursor mode only. */
  processes:    { collected: number; failed: number };
  /** Agentless (ssh/winrm) OS event-log cadence — cursor mode only. */
  eventLog:     { collected: number; failed: number };
  /** FortiOS SD-WAN SLA + rule selection (its own cadence, light loop). */
  sdwan:        { collected: number; failed: number };
  /** ICMP packet-loss sampler (warning/recovering assets only). */
  lossSample:   { collected: number; failed: number };
  /** Manufacturer custom widgets switched on per asset (business rule 130). */
  customWidget: { collected: number; failed: number };
}

/**
 * Per-poll cap on agentless event-log entries. The sink applies its own
 * per-push and per-asset-hourly caps on top; this one bounds the SSH/WinRM
 * payload and the parse, before any of that runs.
 */
const EVENT_LOG_MAX_ENTRIES_PER_POLL = 300;

export type MonitorCadence = "probe" | "telemetry" | "systemInfo" | "fastFiltered" | "lldp" | "storage" | "processes" | "eventLog" | "sdwan" | "lossSample" | "customWidget";

/**
 * The manufacturer custom-widget cadence's interval (business rule 130): the
 * asset's resolved HARDWARE-SENSOR interval, so a widget polls as often as the
 * temperature stream is set to. One function so the pg-boss publisher
 * (monitorAssets.publishDueWork) and computeDueWork cannot drift.
 */
export function customWidgetIntervalSec(eff: Pick<MonitorTierSettings, "temperatureIntervalSeconds">): number {
  return eff.temperatureIntervalSeconds;
}

/**
 * Per-cadence outcome tally returned by the runFooFor() functions. Used by
 * both runMonitorPass (rolls into RunStats) and the upcoming pg-boss workers
 * (logs only; pg-boss tracks job state independently). `crash` is reserved
 * for unexpected exceptions; `failure` covers expected sad-path returns
 * like "probe ran but credential failed" or "telemetry returned no data".
 */
export type CadenceOutcome = "success" | "failure" | "crash";

/**
 * Per-work-item label set, stamped onto the work-duration histogram +
 * outcome counter so operators can slice by device-class × transport to
 * find which combo is the bottleneck. Callers that already know these (the
 * monitorAssets publisher and runMonitorPass) pass them in to avoid a
 * second DB read on the worker side; legacy callers pass "unknown".
 */
export interface WorkItemLabels {
  /** Resolved per-cadence polling method (probe=responseTimePolling, telemetry=telemetryPolling, systemInfo+fastFiltered=interfacesPolling). */
  transport: string;
  /** Asset.assetType (one of the 8 AssetType enum values). */
  assetType: string;
  /**
   * Enable verbose per-phase timing logs for this work item. Forwarded from
   * the pg-boss job payload's `verboseDebug` flag (which is set by the
   * publisher when the asset's source integration has `config.verboseLogging`
   * on). Routed through `monitorPhaseStorage.run` at the runFooFor entry
   * point so every `startPhase` call inside the async chain emits a
   * `monitor.phase` log line. Never stamped into Prometheus labels —
   * cardinality stays bounded.
   */
  verbose?: boolean;
}

/**
 * Run a single response-time probe for one asset, write the sample, update
 * Asset row state (monitorStatus / lastMonitorAt / consecutiveFailures),
 * record metrics. `labels` stamp the work histogram + per-transport probe
 * histogram so operators can slice by asset_type × transport.
 */
/** One asset in a batched ICMP probe, as the publisher resolved it. */
export interface ProbeBatchItem {
  id: string;
  /** The address to ping — `Asset.ipAddress`, matching probeAsset's icmp branch. */
  target: string;
  /** The RESOLVED probeTimeoutMs, carried from the publisher so the worker does
   *  not re-walk the monitor-settings hierarchy 250 times. */
  timeoutMs: number;
  /** The RESOLVED probe interval (`resolveProbeIntervalSec`), carried for the
   *  same reason, so the worker can drop an asset already polled since the
   *  chunk was published (`probeStillDue`). Optional so a chunk queued before
   *  this field existed still runs unfiltered. */
  intervalSec?: number;
}

/**
 * BATCHED ICMP status probe for one chunk of assets.
 *
 * This is the same measurement `runProbeFor` makes, for the one transport where
 * a single process can serve every host. `pingHost` forks per asset per
 * interval, so a 2000-asset ICMP fleet spawned ~2000 processes a minute for one
 * echo each; bucketed through fping that is a handful. The packets were never
 * the cost.
 *
 * Three things are deliberately NOT changed, because this is business rule 30's
 * path and its semantics are the product:
 *
 * 1. **ONE echo per asset per cycle.** Down is defined in missed POLLS, so
 *    sending more echoes here would redefine what a missed poll means. Bursts
 *    belong to the loss sweep.
 * 2. **Per-asset verdicts through `recordProbeResult`**, one call each, exactly
 *    as the unbatched path does. Nothing about the state machine, the leaky
 *    bucket, reboot detection or dependency marking is reimplemented here — the
 *    batch changes how the reading is TAKEN, never how it is judged.
 * 3. **Each asset's own timeout is honoured** (`bucketByTimeout`), so a batch
 *    cannot silently give one asset another's setting.
 *
 * It is also cheaper on the database than the path it replaces: one findMany
 * for the whole chunk, and each snapshot handed to `recordProbeResult` so it
 * skips its own findUnique — where the unbatched path pays one read per asset.
 *
 * A target ABSENT from the ping result was never attempted (an unresolvable
 * name, no pinger on PATH). It is left entirely alone — no sample, no counter
 * movement, not even a cadence stamp — because recording it as a failed probe
 * would march a fleet toward `down` on a DNS outage.
 */
export async function runProbeBatchFor(items: ProbeBatchItem[], labels: WorkItemLabels): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("probe", labels);
  const batchStart = Date.now();
  try {
    if (items.length === 0) {
      recordWorkOutcome("probe", "success", labels);
      return "success";
    }
    const snapshots = await prisma.asset.findMany({
      where: { id: { in: items.map((i) => i.id) } },
      select: {
        id: true, hostname: true, assetType: true, monitored: true, monitorStatus: true,
        lastUptimeSec: true, consecutiveFailures: true, consecutiveSuccesses: true,
        discoveredByIntegrationId: true, monitorIntervalSec: true, cpuMemoryIntervalSec: true,
        temperatureIntervalSec: true, systemInfoIntervalSec: true, probeTimeoutMs: true,
        dependencySuppressed: true, cpuMemoryTimeoutMs: true, temperatureTimeoutMs: true,
        systemInfoTimeoutMs: true, lastMonitorAt: true,
        ipAddress: true, ipv6Address: true, ipConfirmedFor: true, ipConfirmedSince: true,
      },
    });
    const byId = new Map(snapshots.map((a) => [a.id, a as AssetMonitorSnapshot]));
    const lastMonitorAtById = new Map(snapshots.map((a) => [a.id, a.lastMonitorAt]));

    // Re-check only the CHEAP half at pickup — a pg-boss job can land seconds
    // after publication and the asset may have been un-monitored since. The
    // monitor-settings hierarchy was already resolved by the publisher and
    // re-walking it per asset would cost more than the batch it guards, which
    // is why `timeoutMs` and `intervalSec` ride the payload.
    //
    // "Still due" is the other half. This chunk may have queued behind an
    // ACTIVE job holding the same chunk index, published one tick earlier while
    // that job was still waiting on its slowest target. Every asset that job
    // already recorded is dropped here, so each asset gets one reading per
    // cadence (see `probeStillDue`).
    const pickedUpAt = new Date();
    let alreadyPolled = 0;
    const live = items.filter((i) => {
      if (byId.get(i.id)?.monitored !== true) return false;
      if (!probeStillDue(lastMonitorAtById.get(i.id), i.intervalSec, pickedUpAt, getPendingProbePatch(i.id)?.lastMonitorAt)) {
        alreadyPolled++;
        return false;
      }
      return true;
    });
    if (alreadyPolled > 0) {
      logger.debug({ chunk: items.length, alreadyPolled }, "Batched ICMP probe dropped assets already polled since publication");
    }
    if (live.length === 0) {
      recordWorkOutcome("probe", "success", labels);
      return "success";
    }

    // The instant the echoes go out, which is when every reading below was
    // taken. Recording them at completion would place them up to one probe
    // timeout late: the chunk waits for its slowest target.
    const sentAt = new Date();
    const results = await pingTargets(
      live.map((i) => ({ target: i.target, timeoutMs: i.timeoutMs })),
      { count: 1 },
    );

    let attempted = 0;
    let failed = 0;
    for (const item of live) {
      const r = results.get(item.target);
      // Never attempted — not a miss. Deliberately leaves the cadence anchor
      // alone too, so the next tick retries rather than treating a resolver
      // blip as a completed poll.
      if (!r || r.sent === 0) continue;
      const success = r.received > 0;
      // The RTT ping itself measured, not wall clock around a spawn. On a batch
      // the wall clock is meaningless anyway — every host in a bucket shares one
      // invocation, so there is no per-asset duration to report.
      const result: ProbeResult = success
        ? { success: true, responseTimeMs: Math.max(0, Math.round(r.avgRttMs ?? 0)) }
        : { success: false, responseTimeMs: item.timeoutMs, error: "no echo reply" };
      attempted++;
      if (!success) failed++;
      try {
        await recordProbeResult(item.id, result, byId.get(item.id) ?? null, { observedAt: sentAt, timeoutMs: item.timeoutMs });
      } catch (err) {
        // One asset's state write must not abandon the rest of the chunk.
        logger.error({ err, assetId: item.id }, "Batched ICMP probe failed to record a result");
      }
    }

    // One histogram observation per asset ACTUALLY attempted — an unresolvable
    // target is not a probe and must not be counted as one in either bucket.
    // The duration is the batch amortised across them: a bucket shares a single
    // invocation, so there is no per-asset wall clock to report, and dividing
    // is the honest way to keep polaris_probe_duration comparable with the
    // unbatched path rather than reporting one 2-second probe per chunk.
    const perAssetSec = (Date.now() - batchStart) / Math.max(1, attempted) / 1000;
    for (let i = 0; i < attempted; i++) {
      recordProbe(labels.transport, perAssetSec, i < attempted - failed ? "success" : "failure");
    }
    recordWorkOutcome("probe", "success", labels);
    return "success";
  } catch (err) {
    logger.error({ err, chunk: items.length }, "Batched ICMP probe crashed");
    recordWorkOutcome("probe", "crash", labels);
    return "crash";
  } finally {
    stopWork();
  }
}

export async function runProbeFor(
  assetId: string,
  labels: WorkItemLabels,
  /** The resolved probe interval the publisher carried on the job. When set, a
   *  job that queued behind an already-finished poll of the same asset is
   *  dropped (`probeStillDue`). Absent (cursor mode, older jobs) = always run. */
  dueIntervalSec?: number,
): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("probe", labels);
  const probeStart = Date.now();
  try {
    // probeAsset stashes its loaded asset row into `probeOut.snapshot` so
    // recordProbeResult can reuse it for the state-machine update — one
    // findUnique per probe instead of two.
    const probeOut: { snapshot?: AssetMonitorSnapshot; dueIntervalSec?: number; timeoutMs?: number } = { dueIntervalSec };
    const result = await probeAsset(assetId, probeOut);
    // Already polled this cycle by the job this one queued behind: no reading,
    // no anchor stamp, no probe metric. The work itself ran cleanly.
    if (result.duplicate) {
      recordWorkOutcome("probe", "success", labels);
      return "success";
    }
    const probeMs = Date.now() - probeStart;
    await recordProbeResult(assetId, result, probeOut.snapshot ?? null, { timeoutMs: probeOut.timeoutMs });
    // A skipped probe measured nothing, so it is charted nowhere and counted
    // as neither outcome — the cadence ran cleanly, it simply had nothing to
    // ask. See ProbeResult.skipped.
    if (result.skipped) {
      recordWorkOutcome("probe", "success", labels);
      return "success";
    }
    if (result.success) {
      recordProbe(labels.transport, probeMs / 1000, "success");
      recordWorkOutcome("probe", "success", labels);
      return "success";
    }
    recordProbe(labels.transport, probeMs / 1000, "failure");
    recordWorkOutcome("probe", "failure", labels);
    return "failure";
  } catch (err) {
    const probeMs = Date.now() - probeStart;
    logger.error({ err, assetId }, "Monitor probe crashed");
    recordProbe(labels.transport, probeMs / 1000, "failure");
    recordWorkOutcome("probe", "crash", labels);
    return "crash";
  } finally {
    stopWork();
  }
}

/**
 * Telemetry pull (CPU/memory + hardware sensors) for one asset. The two
 * streams dispatch independently — cpuMemoryPolling drives CPU/memory while
 * temperaturePolling drives the hardware-sensor scrape — but they run together
 * on the telemetry cadence trigger. Returns `success` on a clean run
 * regardless of whether data was collected (supported=false is a normal
 * outcome for ICMP/SSH-monitored assets). `failure` means at least one
 * supported stream returned no data (timed-out, rejected, etc.).
 */
export async function runTelemetryFor(assetId: string, labels: WorkItemLabels): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("telemetry", labels);
  try {
    // Run CPU/memory and temperature in parallel — different transports
    // (possibly different credentials, MIBs, even different protocols), so
    // serializing would double the wall-time of a typical telemetry pass.
    // Each catch keeps a transport failure on one stream from poisoning the
    // other; thrown errors are packaged into the result shape.
    // ONE asset read for the whole pass, handed to all three collectors.
    // Each used to fetch the same row itself — two of them concurrently right
    // here — so a telemetry tick opened three wide reads of Asset (~170
    // columns) plus their credential and integration joins to collect from one
    // device. See TELEMETRY_ASSET_INCLUDE.
    const asset = await loadTelemetryAsset(assetId);
    const [tr, temp] = await Promise.all([
      collectTelemetry(assetId, asset).catch((err: unknown) => {
        logger.debug({ err, assetId }, "CPU/memory collection threw");
        return { supported: true, error: (err as Error)?.message || "Telemetry collection failed" } as CollectionResult<TelemetrySample>;
      }),
      collectHardwareSensors(assetId, asset).catch((err: unknown) => {
        logger.debug({ err, assetId }, "Hardware sensor collection threw");
        return { supported: true, error: (err as Error)?.message || "Hardware sensor collection failed" } as CollectionResult<HardwareSensorSample[]>;
      }),
    ]);
    await Promise.all([
      recordTelemetryResult(assetId, tr),
      recordHardwareSensorResult(assetId, temp),
    ]);
    // Generic API widgets ride the telemetry cadence. Fire-and-forget so a
    // slow feed can't drag the telemetry tick — failures log inside the helper
    // without escalating to a cadence crash. Manufacturer widgets have their
    // own cadence (runCustomWidgetsFor, business rule 130).
    void collectAndRecordGenericApiWidgets(assetId, asset).catch((err) => {
      logger.debug({ err, assetId }, "Custom widget collection failed");
    });
    // Outcome aggregates both streams. Success when each stream either
    // delivered (data present, including empty array for a sensor-less
    // device) or wasn't supported on this transport in the first place;
    // failure when at least one supported stream came back with an error
    // and no data.
    const cpuMemOk = !tr.supported   || tr.data   !== undefined;
    const tempOk   = !temp.supported || temp.data !== undefined;
    if (cpuMemOk && tempOk) {
      recordWorkOutcome("telemetry", "success", labels);
      return "success";
    }
    recordWorkOutcome("telemetry", "failure", labels);
    return "failure";
  } catch (err) {
    logger.error({ err, assetId }, "Telemetry collection crashed");
    recordWorkOutcome("telemetry", "crash", labels);
    return "crash";
  } finally {
    stopWork();
  }
}

// ─── Custom widget collector (Slice 7b) ──────────────────────────────────
// Walks each applicable ManufacturerCustomWidget against the asset via
// SNMP, persists results into AssetCustomWidgetSample, and bumps the
// asset's lastCustomWidgetAt timestamp. SNMP-only in v1 — operators who
// need FortiOS REST custom queries should define them as SNMP symbols via
// FORTINET-FORTIGATE-MIB equivalents (the editor's symbol picker doesn't
// distinguish today, but only SNMP symbols actually walk here).
//
// The collector reuses the asset's already-resolved customWidgetPolling /
// customWidgetCredential / customWidgetTimeoutMs settings; when polling
// resolves to "disabled" the pass is silently skipped so the
// Asset.lastCustomWidgetAt stays stale (the tab surfaces a banner).
/** Per-probe row cap — see the truncation warning in the state branch below. */
const MAX_STATE_ROWS_PER_PROBE = 500;

async function collectManufacturerWidgetSamples(
  assetId: string,
  asset: NonNullable<TelemetryAssetRow>,
  enabledIds: Set<string>,
): Promise<WidgetSampleSet> {
  if (enabledIds.size === 0) return NO_WIDGET_SAMPLES;

  // The governing profile, decided exactly as for telemetry (business rule
  // 131): keyed by the canonical manufacturer, else its "also applies when".
  // An asset with no manufacturer can still be governed through its OS.
  const profile = widgetProfileForAsset(asset);
  if (!profile || profile.widgets.length === 0) return NO_WIDGET_SAMPLES;

  // Business rule 130: only the widgets switched ON for this asset poll it,
  // and only while they still apply (per-model gating mirrors the read
  // endpoint) — a row left behind by a model change polls nothing.
  const modelStr = asset.model ?? "";
  const widgets = profile.widgets.filter((w) => {
    if (!enabledIds.has(w.id)) return false;
    if (!w.modelPattern) return true;
    // RE2 (business rule 116); a pattern RE2 cannot compile matches nothing.
    return tryCompileSafeRegex(w.modelPattern, { ignoreCase: true })?.test(modelStr) ?? false;
  });
  if (widgets.length === 0) return NO_WIDGET_SAMPLES;

  // Two transports now live in this pass. An "http" widget names a request
  // rather than an OID, so it neither needs an SNMP credential nor obeys the
  // SNMP polling gate below — gating it there would make an HTTP check depend
  // on whether the device also answers SNMP, which is exactly the coupling the
  // move away from a polling method was meant to remove.
  const httpWidgets = widgets.filter((w: any) => w.widgetType === "http");
  const snmpWidgets = widgets.filter((w: any) => w.widgetType !== "http");

  const effective = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  // Business rule 130: the per-asset switch IS the gate. SNMP widgets no longer
  // borrow cpuMemoryPolling — a UPS has no CPU to poll, and making its battery
  // widgets wait on a CPU/memory stream set to SNMP was the coupling this rule
  // removed. Only an explicit asset-level customWidgetPolling "disabled" (a
  // legacy override with no editor) still turns the SNMP half off.
  const snmpEnabled = asset.customWidgetPolling !== "disabled";

  // An HTTP check is the one transport happy to dial a NAME rather than an IP:
  // a TLS check against a name is the check an operator means, since the cert
  // and any vhost routing are keyed on it.
  const host = dial(asset);
  const httpHost = dial(asset) || asset.dnsName || asset.hostname;
  if (!host && !httpHost) return NO_WIDGET_SAMPLES;
  if (!snmpEnabled && httpWidgets.length === 0) return NO_WIDGET_SAMPLES;

  // Credential: the first SNMP credential on the asset, in order custom
  // widget → hardware sensors → CPU/memory → generic monitor (the widgets run
  // on the hardware-sensor cadence, so that stream's credential is the next
  // most specific), then the FMG/FortiGate integration fallback. Custom
  // widgets MUST have an SNMP credential — there's no FortiOS REST equivalent.
  let snmpCfg: Record<string, unknown> | null = null;
  const candidates = [asset.customWidgetCredential, asset.temperatureCredential, asset.cpuMemoryCredential, asset.monitorCredential];
  const snmpCred = candidates.find((c) => c?.type === "snmp");
  const direct = candidates.find((c) => !!c) ?? null;
  if (snmpCred) {
    snmpCfg = snmpCred.config as Record<string, unknown>;
  } else if (isFortinetIntegrationType(asset.discoveredByIntegration?.type)) {
    try {
      snmpCfg = await loadSnmpCredentialConfigForFortinetAsset(direct, asset.discoveredByIntegration);
    } catch { snmpCfg = null; }
  }
  // A missing SNMP credential no longer aborts the whole pass — it only means
  // the SNMP half has nothing to authenticate with.
  const runSnmp = snmpEnabled && !!snmpCfg && !!host && snmpWidgets.length > 0;
  if (!runSnmp && httpWidgets.length === 0) return NO_WIDGET_SAMPLES;

  await ensureRegistryLoaded();
  // The asset's own scope, then the governing profile's — where the widget's
  // MIB was uploaded (business rule 131).
  const scope: ResolveScope = { manufacturer: asset.manufacturer, model: asset.model, profileManufacturer: profile.manufacturer };
  const timeoutMs = asset.customWidgetTimeoutMs ?? effective.temperatureTimeoutMs;

  const samples: Array<{ widgetId: string; kind: "scalar" | "table"; value: any }> = [];
  // State probes (widgetType "state") normalize to 0/1 and land in their own
  // table — see the branch below.
  const stateRows: Array<{
    probeId: string; rowKey: string; rowLabel: string; value: number; rawValue: string | null;
  }> = [];
  if (runSnmp) {
  try {
    await withSnmpSession(host as string, snmpCfg as Record<string, unknown>, async (session) => {
      for (const w of snmpWidgets) {
        try {
          // http widgets carry no OID and are collected by their own pass.
          if (!w.symbol) continue;
          const oid = resolveOidSync(w.symbol, scope);
          if (!oid) continue;
          if (w.widgetType === "state" && w.stateMap) {
            // ── State probe ───────────────────────────────────────────────
            // Same walk as a numeric widget; the difference is that each
            // reading is mapped through the probe's DECLARED true/false rule
            // (utils/stateProbes) at scrape time rather than being compared to
            // a threshold later. Storing the boolean means the engine never has
            // to know a vendor's polarity — and an operator editing the mapping
            // fixes every future reading in one place.
            const values = await snmpWalk(session, oid);
            // Row names come from a sibling column of the same table, joined on
            // the shared OID index. Without it the rows are only nameable by
            // bare index, which differs per model.
            let labels: Map<string, unknown> | null = null;
            if (w.type === "table" && w.labelSymbol) {
              const labelOid = resolveOidSync(w.labelSymbol, scope);
              if (labelOid) {
                try {
                  const walked = await snmpWalk(session, labelOid);
                  labels = new Map<string, unknown>();
                  for (const [suffix, v] of walked.entries()) labels.set(suffix, snmpVbToString(v));
                } catch (err) {
                  // A missing name column must not cost us the alarm state.
                  logger.debug({ err, assetId, widgetId: w.id, symbol: w.labelSymbol }, "State probe label walk failed");
                  labels = null;
                }
              }
            }
            const rows = joinStateRows(values, labels, w.stateMap);
            // A scalar probe is one device-wide flag: take the first readable
            // row and drop the index, so its dimension key stays "" and the
            // alert reads as being about the device.
            let kept = w.type === "scalar" ? rows.slice(0, 1) : rows;
            // Backstop against an operator pointing a probe at a huge subtree
            // (every row becomes a per-scrape DB row AND a firing-state row in
            // the engine). Loudly truncated rather than silently — a probe
            // that's quietly dropping rows would look like a healthy one.
            if (kept.length > MAX_STATE_ROWS_PER_PROBE) {
              logger.warn(
                { assetId, widgetId: w.id, symbol: w.symbol, rows: kept.length, cap: MAX_STATE_ROWS_PER_PROBE },
                "State probe returned more rows than the cap — truncating; narrow the probe's symbol to a single column",
              );
              kept = kept.slice(0, MAX_STATE_ROWS_PER_PROBE);
            }
            for (const r of kept) {
              stateRows.push({
                probeId:  w.id,
                rowKey:   w.type === "scalar" ? "" : r.rowKey,
                rowLabel: w.type === "scalar" ? w.name : r.rowLabel,
                value:    r.value,
                rawValue: r.raw || null,
              });
            }
            continue;
          }
          if (w.type === "scalar") {
            // Scalar: walk one OID, take first/only value as a number.
            const rows = await snmpWalk(session, oid);
            let val: number | null = null;
            for (const v of rows.values()) {
              const n = snmpVbToNumber(v);
              if (n != null) { val = n; break; }
            }
            if (val == null) continue;
            // Apply transform if one is configured on the widget.
            const transformed = applyTransform(val, w.transform);
            samples.push({ widgetId: w.id, kind: "scalar", value: transformed });
          } else {
            // Table: walk the whole subtree and serialize as one row per
            // OID-suffix with the raw value (operators decode further via
            // the widget's displayOptions at render time).
            const rows = await snmpWalk(session, oid);
            const arr: any[] = [];
            for (const [suffix, v] of rows.entries()) {
              const numeric = snmpVbToNumber(v);
              arr.push({
                index: suffix || ".0",
                value: numeric != null ? numeric : snmpVbToString(v),
              });
            }
            if (arr.length === 0) continue;
            samples.push({ widgetId: w.id, kind: "table", value: arr });
          }
        } catch (err) {
          logger.debug({ err, assetId, widgetId: w.id, symbol: w.symbol }, "Custom widget walk failed");
        }
      }
    }, timeoutMs);
  } catch (err) {
    // Session-level failure — log and move on. Deliberately NOT a return: an
    // http widget on the same profile must still be collected when the SNMP
    // agent is down, which is half the point of having the check at all.
    logger.debug({ err, assetId }, "Custom widget SNMP session failed");
  }
  }

  // ── HTTP checks ───────────────────────────────────────────────────────────
  // Each widget contributes TWO rows: a 0/1 pass/fail to AssetStateSample —
  // alertable through the existing `customStateValue` metric with no engine
  // change — and the round-trip time as a scalar gauge, so a slow-but-passing
  // endpoint is visible before it starts failing.
  //
  // The 0/1 is always written, pass or fail. That is the opposite of the state
  // PROBE rule (which drops an unreadable row, because 0 there is a positive
  // claim of health about hardware that may not exist): here a failed request
  // IS the reading, and dropping it would make an outage indistinguishable from
  // a device nobody checked. The response-time gauge is written only on success
  // — a failed request has no meaningful duration to chart.
  if (httpWidgets.length > 0 && httpHost) {
    const httpTimeoutMs = asset.customWidgetTimeoutMs ?? effective.temperatureTimeoutMs;
    await Promise.all(httpWidgets.map(async (w: any) => {
      try {
        const check = (w.httpCheck ?? {}) as Record<string, unknown>;
        // The credential is read per widget rather than from the asset chain:
        // it belongs to the CHECK, which is a property of the manufacturer
        // profile, not of how this particular asset is monitored.
        let auth: Record<string, unknown> | null = null;
        if (w.credentialId) {
          const cred = await prisma.credential.findUnique({
            where:  { id: w.credentialId },
            select: { config: true, type: true },
          });
          if (cred?.type === "http") auth = cred.config as Record<string, unknown>;
        }
        const started = performance.now();
        const res = await probeHttp(
          httpHost,
          check,
          started,
          httpTimeoutMs,
          // Per-asset path override — the escape hatch for the single device
          // whose endpoint sits somewhere else. Model targeting covers the rest.
          asset.httpCheckPath,
          undefined,
          auth,
        );
        stateRows.push({
          probeId:  w.id,
          rowKey:   "",
          rowLabel: w.name,
          value:    res.success ? 1 : 0,
          rawValue: res.success ? null : ((res as any).error ?? "check failed"),
        });
        if (res.success) {
          samples.push({ widgetId: w.id, kind: "scalar", value: res.responseTimeMs });
        }
      } catch (err) {
        logger.debug({ err, assetId, widgetId: w.id }, "HTTP check widget failed");
      }
    }));
  }

  return { samples, stateRows };
}

/** One pass's widget readings: scalar / table samples, and state rows. */
interface WidgetSampleSet {
  samples: Array<{ widgetId: string; kind: "scalar" | "table"; value: any }>;
  stateRows: Array<{ probeId: string; rowKey: string; rowLabel: string; value: number; rawValue: string | null }>;
}
const NO_WIDGET_SAMPLES: WidgetSampleSet = { samples: [], stateRows: [] };

/**
 * The Generic API half of the custom widgets (rule 100(i)) — the widgets an
 * integration defines for the assets it lists. Still rides the telemetry
 * cadence: they are the integration's, not a manufacturer profile's, and carry
 * no per-asset switch. The manufacturer half moved to its own cadence
 * (`runCustomWidgetsFor`, business rule 130).
 */
async function collectAndRecordGenericApiWidgets(assetId: string, preloaded?: TelemetryAssetRow): Promise<void> {
  const asset = preloaded !== undefined ? preloaded : await loadTelemetryAsset(assetId);
  if (!asset || !asset.monitored) return;
  const generic = await collectGenericApiWidgetSamples(assetId).catch((err) => {
    logger.debug({ err, assetId }, "Generic API widget pass failed");
    return NO_WIDGET_SAMPLES;
  });
  await recordWidgetSampleSet(assetId, generic);
}

/**
 * The manufacturer custom-widget pass (business rule 130): its own cadence,
 * due off `lastCustomWidgetAttemptAt` at the asset's resolved hardware-sensor
 * interval, queued only for an asset with at least one widget switched on.
 * Polls exactly the switched-on widgets that still apply. The attempt is
 * stamped first, whatever follows (rule 118), so a device that never answers
 * is asked once per interval rather than on every heavy tick.
 */
export async function runCustomWidgetsFor(assetId: string, labels: WorkItemLabels): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("customWidget", labels);
  try {
    await prisma.asset.updateMany({ where: { id: assetId }, data: { lastCustomWidgetAttemptAt: new Date() } });
    const asset = await loadTelemetryAsset(assetId);
    if (!asset || !asset.monitored) {
      recordWorkOutcome("customWidget", "success", labels);
      return "success";
    }
    const enabled = await enabledWidgetIdsForAsset(assetId);
    if (enabled.size === 0) {
      recordWorkOutcome("customWidget", "success", labels);
      return "success";
    }
    const set = await collectManufacturerWidgetSamples(assetId, asset, enabled);
    if (set.samples.length === 0 && set.stateRows.length === 0) {
      // Widgets are switched on but nothing came back: no credential, no
      // address, or the device did not answer.
      recordWorkOutcome("customWidget", "failure", labels);
      return "failure";
    }
    await recordWidgetSampleSet(assetId, set);
    recordWorkOutcome("customWidget", "success", labels);
    return "success";
  } catch (err) {
    logger.error({ err, assetId }, "Custom widget pass crashed");
    recordWorkOutcome("customWidget", "crash", labels);
    return "crash";
  } finally {
    stopWork();
  }
}

/** Write one pass's widget readings and stamp `lastCustomWidgetAt` (the last
 *  SUCCESS) in one transaction. A set with nothing in it writes nothing. */
async function recordWidgetSampleSet(assetId: string, set: WidgetSampleSet): Promise<void> {
  const { samples, stateRows } = set;
  if (samples.length === 0 && stateRows.length === 0) return;
  try {
    await prisma.$transaction([
      ...(samples.length
        ? [prisma.assetCustomWidgetSample.createMany({
            data: samples.map((s) => ({
              assetId,
              widgetId: s.widgetId,
              kind:     s.kind,
              value:    s.value as any,
            })),
          })]
        : []),
      ...(stateRows.length
        ? [prisma.assetStateSample.createMany({
            data: stateRows.map((s) => ({
              assetId,
              probeId:  s.probeId,
              rowKey:   s.rowKey,
              rowLabel: s.rowLabel,
              value:    s.value,
              rawValue: s.rawValue,
            })),
          })]
        : []),
      prisma.asset.update({
        where: { id: assetId },
        data:  { lastCustomWidgetAt: new Date() },
      }),
    ]);
  } catch (err) {
    logger.warn({ err, assetId }, "Custom widget sample persistence failed");
  }
}

/**
 * Full system-info pass (interfaces + storage + IPsec + LLDP) for one
 * asset. Same supported / data / failure semantics as telemetry.
 */
export async function runSystemInfoFor(assetId: string, labels: WorkItemLabels): Promise<CadenceOutcome> {
  return monitorPhaseStorage.run(
    { assetId, cadence: "systemInfo", verbose: !!labels.verbose },
    async () => {
      const stopWork = startWorkTimer("systemInfo", labels);
      const endHandler = startPhase("systeminfo.handler");
      try {
        const endCollect = startPhase("systeminfo.collect");
        const sr = await collectSystemInfo(assetId);
        endCollect({ supported: sr.supported, hasData: !!sr.data, hasError: !!sr.error });
        const endPersist = startPhase("systeminfo.persist");
        await recordSystemInfoResult(assetId, sr);
        endPersist();
        if (sr.supported) {
          if (sr.data) {
            recordWorkOutcome("systemInfo", "success", labels);
            return "success";
          }
          recordWorkOutcome("systemInfo", "failure", labels);
          return "failure";
        }
        recordWorkOutcome("systemInfo", "success", labels);
        return "success";
      } catch (err) {
        logger.error({ err, assetId }, "System info collection crashed");
        recordWorkOutcome("systemInfo", "crash", labels);
        return "crash";
      } finally {
        endHandler();
        stopWork();
      }
    },
  );
}

/**
 * Fast-filtered scrape for the operator-pinned subset (interfaces + storage
 * + IPsec). Same supported / data / failure semantics as systemInfo.
 */
export async function runFastFilteredFor(assetId: string, labels: WorkItemLabels): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("fastFiltered", labels);
  try {
    const fr = await collectFastFiltered(assetId);
    await recordFastFilteredResult(assetId, fr);
    if (fr.supported) {
      if (fr.data) {
        recordWorkOutcome("fastFiltered", "success", labels);
        return "success";
      }
      recordWorkOutcome("fastFiltered", "failure", labels);
      return "failure";
    }
    recordWorkOutcome("fastFiltered", "success", labels);
    return "success";
  } catch (err) {
    logger.error({ err, assetId }, "Fast-cadence scrape crashed");
    recordWorkOutcome("fastFiltered", "crash", labels);
    return "crash";
  } finally {
    stopWork();
  }
}

/**
 * Phase 2 carve-out: LLDP-only pass for one asset. Walks the LLDP-MIB
 * (`collectLldpOnlySnmp`) or hits `/api/v2/monitor/system/interface/lldp-neighbors`
 * (`collectLldpOnlyFortinet`) per the resolved `lldpPolling` and persists via
 * the same `persistLldpNeighbors` full-replace path the legacy
 * `collectSystemInfo` uses — so this is idempotent against any in-flight
 * systemInfo pass that also walked LLDP on a session-coalesced tick.
 *
 * Stamps `Asset.lastLldpAt` on every successful pass so the publisher in
 * `monitorAssets.ts` knows when the next LLDP job is due.
 */
export async function runLldpFor(assetId: string, labels: WorkItemLabels): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("lldp", labels);
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      omit: PROBE_ASSET_OMIT,
      include: { monitorCredential: true, interfacesCredential: true, lldpCredential: true, discoveredByIntegration: true },
    });
    if (!asset || !asset.monitored) {
      recordWorkOutcome("lldp", "success", labels);
      return "success";
    }
    const effective = await resolveMonitorSettings({
      ...asset,
      discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
    });
    const lldpPolling = effective.lldpPolling;
    if (!lldpPolling || lldpPolling === "disabled" || lldpPolling === "agent") {
      recordWorkOutcome("lldp", "success", labels);
      return "success";
    }
    const targetIp = dial(asset) || ((lldpPolling === "winrm" || lldpPolling === "ssh") ? (asset.dnsName || asset.hostname) : null);
    if (!targetIp) {
      recordWorkOutcome("lldp", "failure", labels);
      return "failure";
    }
    const integration = asset.discoveredByIntegration ?? null;
    const isFortinetSrc = isFortinetIntegrationType(integration?.type);
    const lldpTimeout   = effective.lldpTimeoutMs;
    let neighbors: LldpNeighborSample[] | undefined;
    let sourceLabel: "fortios" | "snmp" = "snmp";
    if (lldpPolling === "rest_api") {
      if (!isFortinetSrc || !integration) {
        recordWorkOutcome("lldp", "failure", labels);
        return "failure";
      }
      sourceLabel = "fortios";
      neighbors = await collectLldpOnlyFortinet(targetIp, integration as any, lldpTimeout, pickRestApiCredential(asset.lldpCredential, asset.monitorCredential)).catch(() => undefined);
    } else if (lldpPolling === "snmp") {
      // Per-stream credential wins, then asset default, then integration fallback.
      const effectiveLldpCred = asset.lldpCredential ?? asset.monitorCredential;
      // Soft resolution: chain exhaustion or a Fortinet-lookup throw both
      // leave snmpCfg null (this runner skips rather than errors).
      let snmpCfg: Record<string, unknown> | null = null;
      try {
        const resolved = await resolveSnmpConfigForStream(effectiveLldpCred, effective.lldpCredentialId, isFortinetSrc, integration);
        snmpCfg = resolved.error !== undefined ? null : resolved.cfg;
      } catch { snmpCfg = null; }
      if (!snmpCfg) {
        recordWorkOutcome("lldp", "failure", labels);
        return "failure";
      }
      sourceLabel = "snmp";
      neighbors = await collectLldpOnlySnmp(targetIp, snmpCfg, lldpTimeout).catch(() => undefined);
    } else {
      // winrm / ssh / icmp don't deliver LLDP today.
      recordWorkOutcome("lldp", "success", labels);
      return "success";
    }
    if (neighbors === undefined) {
      // Transport failure — don't wipe existing rows, don't bump lastLldpAt
      // (so the next tick retries promptly).
      recordWorkOutcome("lldp", "failure", labels);
      return "failure";
    }
    await persistLldpNeighbors(assetId, neighbors, new Date(), sourceLabel);
    await prisma.asset.update({ where: { id: assetId }, data: { lastLldpAt: new Date() } });
    recordWorkOutcome("lldp", "success", labels);
    return "success";
  } catch (err) {
    logger.error({ err, assetId }, "LLDP-only scrape crashed");
    recordWorkOutcome("lldp", "crash", labels);
    return "crash";
  } finally {
    stopWork();
  }
}

/**
 * Phase 2 carve-out: Storage-only pass for one asset. SNMP-only — FortiOS
 * appliances expose no mountable storage and WinRM is not yet supported.
 * Walks HOST-RESOURCES-MIB hrStorageTable; falls back to the vendor disk
 * scalar pair (e.g. FortiSwitch `fsSysDiskUsage` / `fsSysDiskCapacity`) when
 * the table is empty.
 *
 * Stamps `Asset.lastStorageAt` on every successful pass.
 */
/**
 * Persist a dedicated storage-cadence scrape. Shared by the SNMP and the
 * agentless (ssh/winrm) paths so both stamp cadence and advance the anchor
 * identically.
 *
 * This cadence walks ALL mountpaths, so each row is stamped by whether its
 * mountPath is operator-pinned: pinned → "fast" (full retention + rollups),
 * unpinned → "slow" (24h, never rolled up).
 */
async function persistStorageOnly(
  assetId: string,
  storage: StorageSample[],
  monitoredStorage: string[],
): Promise<void> {
  const now = new Date();
  const pinnedStorage = new Set(monitoredStorage);
  if (storage.length > 0) {
    enqueueStorageSamples(
      storage.map((s) => ({
        assetId,
        timestamp: now,
        cadence:    pinnedStorage.has(s.mountPath) ? ("fast" as const) : ("slow" as const),
        mountPath:  s.mountPath,
        totalBytes: s.totalBytes != null ? BigInt(Math.round(s.totalBytes)) : null,
        usedBytes:  s.usedBytes  != null ? BigInt(Math.round(s.usedBytes))  : null,
      })),
    );
  }
  await prisma.asset.update({ where: { id: assetId }, data: { lastStorageAt: now } });
}

export async function runStorageFor(assetId: string, labels: WorkItemLabels): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("storage", labels);
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      omit: PROBE_ASSET_OMIT,
      include: { monitorCredential: true, interfacesCredential: true, discoveredByIntegration: true },
    });
    if (!asset || !asset.monitored) {
      recordWorkOutcome("storage", "success", labels);
      return "success";
    }
    const effective = await resolveMonitorSettings({
      ...asset,
      discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
    });
    const storagePolling = effective.storagePolling;
    // SNMP walks the hrStorageTable; ssh/winrm read df / Get-Volume. Every
    // other method either has no storage story (icmp, rest_api — FortiOS
    // publishes no mountable storage) or delivers it elsewhere: the agent
    // pushes on its own schedule, and vCenter storage rides the system-info
    // pass out of the warm cache rather than this dedicated cadence.
    if (storagePolling !== "snmp" && storagePolling !== "ssh" && storagePolling !== "winrm") {
      recordWorkOutcome("storage", "success", labels);
      return "success";
    }
    const targetIp = dial(asset)
      || ((storagePolling === "ssh" || storagePolling === "winrm") ? (asset.dnsName || asset.hostname) : null);
    if (!targetIp) {
      recordWorkOutcome("storage", "failure", labels);
      return "failure";
    }

    if (storagePolling === "ssh" || storagePolling === "winrm") {
      const cred = await resolveAgentlessCredConfig(
        asset.interfacesCredential ?? asset.monitorCredential,
        effective.interfacesCredentialId,
        storagePolling,
        adBindFallbackIntegration(asset, asset.discoveredByIntegration ?? null),
      );
      if (!cred) {
        recordWorkOutcome("storage", "failure", labels);
        return "failure";
      }
      const opts = { telemetry: false, interfaces: false, storage: true, timeoutMs: effective.storageTimeoutMs };
      const res = await (storagePolling === "ssh"
        ? collectHostSsh(targetIp, cred, opts)
        : collectHostWinrm(winrmConnFrom(targetIp, cred, effective.storageTimeoutMs), opts)
      ).catch(() => undefined);
      // undefined = the command failed; leave stored rows alone rather than
      // wiping a host's mounts because one scrape timed out.
      if (!res?.storage) {
        recordWorkOutcome("storage", "failure", labels);
        return "failure";
      }
      await persistStorageOnly(assetId, res.storage, asset.monitoredStorage || []);
      recordWorkOutcome("storage", "success", labels);
      return "success";
    }
    // Storage shares the interfaces credential at probe time — there's no
    // per-stream storage credential column. Per-stream interfaces credential
    // wins, then asset default, then class-override interfacesCredentialId,
    // then integration fallback.
    const effectiveIfacesCred = asset.interfacesCredential ?? asset.monitorCredential;
    const integration = asset.discoveredByIntegration ?? null;
    const isFortinetSrc = isFortinetIntegrationType(integration?.type);
    // Soft resolution: chain exhaustion or a Fortinet-lookup throw both
    // leave snmpCfg null (this runner skips rather than errors).
    let snmpCfg: Record<string, unknown> | null = null;
    try {
      const resolved = await resolveSnmpConfigForStream(effectiveIfacesCred, effective.interfacesCredentialId, isFortinetSrc, integration);
      snmpCfg = resolved.error !== undefined ? null : resolved.cfg;
    } catch { snmpCfg = null; }
    if (!snmpCfg) {
      recordWorkOutcome("storage", "failure", labels);
      return "failure";
    }
    const storage = await collectStorageOnlySnmp(targetIp, snmpCfg, asset.manufacturer, asset.model, effective.storageTimeoutMs, asset.assetType).catch(() => undefined);
    if (storage === undefined) {
      recordWorkOutcome("storage", "failure", labels);
      return "failure";
    }
    await persistStorageOnly(assetId, storage, asset.monitoredStorage || []);
    recordWorkOutcome("storage", "success", labels);
    return "success";
  } catch (err) {
    logger.error({ err, assetId }, "Storage-only scrape crashed");
    recordWorkOutcome("storage", "crash", labels);
    return "crash";
  } finally {
    stopWork();
  }
}

// Fixed cadence of the agentless pinned/mapped sub-pass (pinned cpu/mem
// telemetry + mapped connection discovery) — mirrors the agent's 60s
// processTelemetry / processConnections loops.
const PROCESS_PINS_INTERVAL_SEC = 60;

/**
 * Agentless `processes` cadence: full inventory at processesIntervalSeconds +
 * a 60s pinned/mapped sub-pass (cpu/mem telemetry rows for monitoredProcesses,
 * connection rows for mappedProcesses), over SSH or WinRM in one transport
 * session. Agent-mode assets never reach the collectors — the agent runs its
 * own loops; SNMP stays declared-but-unimplemented for this stream.
 *
 * Unlike runStorageFor, the cadence anchors (lastProcessesAt /
 * lastProcessPinsAt) are stamped EVEN ON FAILURE: SSH/WinRM are authenticated
 * transports, and a host with a bad credential must not be re-attempted every
 * heavy tick (AD-lockout / fail2ban exposure). Failures are metrics + debug
 * log only — no Event spam.
 */
/**
 * Agentless OS event-log cadence (ssh / winrm).
 *
 * Feeds the SAME sink the agent's eventLog stream uses — `ingestOsEventLog`,
 * which curates entries into the audit Event table and already applies the
 * min-level filter, dedupe, per-push cap and per-asset hourly rate cap. So the
 * only new work is collecting entries in that shape and honouring the global
 * `agentEventLog` master switch, which gates BOTH paths: an operator who turned
 * the feature off must not have an agentless poller keep filling the audit log.
 *
 * The collection window is derived from the stream's own interval rather than a
 * fixed row count. A poll that asked for "the last N entries" would either miss
 * a burst or re-ingest the same quiet hour repeatedly; asking for "everything
 * since a bit longer ago than my last run" is the shape that neither drops nor
 * duplicates. The overlap is deliberate and cheap — the sink dedupes.
 *
 * `lastEventLogAt` is stamped **even on failure**, exactly as
 * `runProcessesFor` stamps its anchors: an agentless stream that re-fires every
 * tick against a bad credential is an AD-lockout risk, and this is the one
 * stream where a retry storm would also flood the table it writes into.
 */
export async function runEventLogFor(assetId: string, labels: WorkItemLabels): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("eventLog", labels);
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      omit: PROBE_ASSET_OMIT,
      include: { monitorCredential: true, eventLogCredential: true, discoveredByIntegration: true },
    });
    if (!asset || !asset.monitored) {
      recordWorkOutcome("eventLog", "success", labels);
      return "success";
    }
    const effective = await resolveMonitorSettings({
      ...asset,
      discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
    });
    const method = effective.eventLogPolling;
    if (method !== "ssh" && method !== "winrm") {
      // agent-mode assets self-collect; no other transport delivers this.
      recordWorkOutcome("eventLog", "success", labels);
      return "success";
    }

    // Master switch first — before any anchor write or network call, so a
    // disabled feature costs nothing per tick.
    const cfg = await getAgentEventLogConfig();
    if (!cfg.enabled) {
      recordWorkOutcome("eventLog", "success", labels);
      return "success";
    }

    // Stamp the anchor up front so every exit below — success, failure, throw —
    // leaves the cadence spaced. See the header.
    const stampAnchor = () =>
      prisma.asset.update({ where: { id: assetId }, data: { lastEventLogAt: new Date() } }).catch(() => {});

    const targetIp = dial(asset) || asset.dnsName || asset.hostname;
    if (!targetIp) {
      await stampAnchor();
      recordWorkOutcome("eventLog", "failure", labels);
      return "failure";
    }

    const cred = await resolveAgentlessCredConfig(
      asset.eventLogCredential ?? asset.monitorCredential,
      effective.eventLogCredentialId,
      method,
      adBindFallbackIntegration(asset, asset.discoveredByIntegration ?? null),
    );
    if (!cred) {
      await stampAnchor();
      recordWorkOutcome("eventLog", "failure", labels);
      return "failure";
    }

    const intervalSec = effective.eventLogIntervalSeconds ?? 600;
    // 1.5× the interval: enough overlap that a slow tick cannot open a hole,
    // small enough that the duplicate load stays trivial. The sink dedupes.
    const sinceMinutes = Math.max(1, Math.ceil((intervalSec * 1.5) / 60));
    const opts = { sinceMinutes, maxEntries: EVENT_LOG_MAX_ENTRIES_PER_POLL, timeoutMs: Math.max(effective.eventLogTimeoutMs ?? 15_000, 30_000) };

    let entries: AgentlessEventLogEntry[] | undefined;
    try {
      entries = method === "ssh"
        ? await collectEventLogSsh(targetIp, cred, opts)
        : await collectEventLogWinrm(winrmConnFrom(targetIp, cred, opts.timeoutMs), opts);
    } catch (err) {
      logger.debug({ err, assetId }, "Agentless event-log collection failed");
      entries = undefined;
    }

    await stampAnchor();
    if (entries === undefined) {
      recordWorkOutcome("eventLog", "failure", labels);
      return "failure";
    }
    if (entries.length > 0) {
      await ingestOsEventLog(assetId, asset.hostname ?? null, entries, cfg);
    }
    recordWorkOutcome("eventLog", "success", labels);
    return "success";
  } catch (err) {
    logger.error({ err, assetId }, "Agentless event-log cadence crashed");
    recordWorkOutcome("eventLog", "crash", labels);
    return "crash";
  } finally {
    stopWork();
  }
}

/**
 * Should this asset get an SD-WAN pass at all? ONE predicate shared by both
 * due paths (computeDueWork here, publishDueWork in jobs/monitorAssets.ts) and
 * re-checked by runSdwanFor at pickup, so the three cannot drift.
 *
 * Same reach as when SD-WAN rode the system-info pass: the integration pulls
 * SD-WAN (`intervalSec` non-null — see resolveSdwanIntervalSec), and the asset
 * is polled over FortiOS REST — the SD-WAN endpoints are REST-only, and an
 * operator who moved a gate's interfaces to SNMP did so because REST is not
 * available to it. Managed FortiSwitches / FortiAPs have no SD-WAN and aren't
 * directly REST-able. Liveness (the isUp gate) is applied by the callers.
 */
export function sdwanShouldQueue(
  a: { assetType: string | null },
  eff: { interfacesPolling: string | null },
  intervalSec: number | null,
): intervalSec is number {
  if (intervalSec == null || intervalSec <= 0) return false;
  if (eff.interfacesPolling !== "rest_api") return false;
  return a.assetType !== "switch" && a.assetType !== "access_point";
}

/**
 * The interval the SD-WAN cadence is actually polling one asset at, or null
 * when nothing polls it (unmonitored / decommissioned / disabled, the
 * integration doesn't pull SD-WAN, or the gate is not on FortiOS REST). Backs
 * the SD-WAN tab's freshness strips, which turn amber past this figure — so it
 * must be the SAME eligibility the scheduler applies (sdwanShouldQueue), not
 * the system-info cadence the stream used to ride.
 */
export async function resolveSdwanPollIntervalForAsset(assetId: string): Promise<number | null> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    omit: PROBE_ASSET_OMIT,
    include: { discoveredByIntegration: { select: { type: true } } },
  });
  if (!asset || !asset.monitored || asset.status === "decommissioned" || asset.status === "disabled") return null;
  const effective = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  const intervalSec = resolveSdwanIntervalSec(asset);
  return sdwanShouldQueue(asset, effective, intervalSec) ? intervalSec : null;
}

/**
 * SD-WAN cadence: Performance SLA health-check readings + SD-WAN service-rule
 * selection for one FortiGate, on the integration's `sdwanIntervalSeconds`
 * (default 60s). Split out of the system-info pass 2026-09 — riding that pass
 * meant SLA latency / jitter / loss (and the alerts on them) moved only as
 * often as interfaces were scraped, 10 minutes by default. Two small REST GETs
 * per gate; nothing else from the system-info walk is repeated.
 *
 * `lastSdwanAt` is stamped **even on failure**, like lastEventLogAt: this runs
 * on the 5s light loop, and a gate that stopped answering must be asked once
 * per interval, not once per tick.
 */
export async function runSdwanFor(assetId: string, labels: WorkItemLabels): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("sdwan", labels);
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      omit: PROBE_ASSET_OMIT,
      include: { monitorCredential: true, interfacesCredential: true, discoveredByIntegration: true },
    });
    if (!asset || !asset.monitored) {
      recordWorkOutcome("sdwan", "success", labels);
      return "success";
    }
    const integration = asset.discoveredByIntegration ?? null;
    const effective = await resolveMonitorSettings({
      ...asset,
      discoveredByIntegrationType: integration?.type ?? null,
    });
    // Re-check at pickup (after the resolver warmed the sidecar): the toggle
    // may have been switched off, or the transport changed, since publish.
    if (!integration || !sdwanShouldQueue(asset, effective, resolveSdwanIntervalSec(asset))) {
      recordWorkOutcome("sdwan", "success", labels);
      return "success";
    }

    const now = new Date();
    await prisma.asset.update({ where: { id: assetId }, data: { lastSdwanAt: now } }).catch(() => {});

    const sdwanHost = dial(asset);
    if (!sdwanHost) {
      recordWorkOutcome("sdwan", "failure", labels);
      return "failure";
    }
    const fg = buildFortinetConfig(
      sdwanHost,
      integration as any,
      pickRestApiCredential(asset.interfacesCredential, asset.monitorCredential),
    );
    if ("error" in fg) {
      recordWorkOutcome("sdwan", "failure", labels);
      return "failure";
    }
    const sdwan = await collectSdwanFortinet(fg, effective.systemInfoTimeoutMs);
    if (!sdwan.reachable) {
      recordWorkOutcome("sdwan", "failure", labels);
      return "failure";
    }
    persistPerfSlaSampleStream(assetId, sdwan.perfSla, now);
    // Rules are CURRENT-STATE (no history): full-replace when the CMDB read
    // succeeded (even to []), untouched when it didn't. Mirrors the LLDP /
    // wireless-station delete-replace pattern. The SLA stream above stays a
    // time-series.
    if (sdwan.sdwanRules) {
      const stopWrite = startSampleWriteTimer("asset_sdwan_rules");
      await persistSdwanRules(assetId, sdwan.sdwanRules);
      stopWrite();
    }
    recordWorkOutcome("sdwan", "success", labels);
    return "success";
  } catch (err) {
    logger.error({ err, assetId }, "SD-WAN cadence crashed");
    recordWorkOutcome("sdwan", "crash", labels);
    return "crash";
  } finally {
    stopWork();
  }
}

export async function runProcessesFor(assetId: string, labels: WorkItemLabels): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("processes", labels);
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      omit: PROBE_ASSET_OMIT,
      include: { monitorCredential: true, processesCredential: true, discoveredByIntegration: true },
    });
    if (!asset || !asset.monitored) {
      recordWorkOutcome("processes", "success", labels);
      return "success";
    }
    const effective = await resolveMonitorSettings({
      ...asset,
      discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
    });
    const method = effective.processesPolling;
    if (method !== "ssh" && method !== "winrm") {
      // agent-mode assets self-collect; other methods don't deliver processes.
      recordWorkOutcome("processes", "success", labels);
      return "success";
    }

    const now = new Date();
    const isDue = (last: Date | null, sec: number): boolean =>
      sec > 0 && (!last || now.getTime() - last.getTime() >= sec * 1000);
    const pinNames = (asset.monitoredProcesses ?? []) as string[];
    const mapNames = (asset.mappedProcesses ?? []) as string[];
    const inventoryDue = isDue(asset.lastProcessesAt, effective.processesIntervalSeconds);
    const pinsDue = pinNames.length + mapNames.length > 0 && isDue(asset.lastProcessPinsAt, PROCESS_PINS_INTERVAL_SEC);
    if (!inventoryDue && !pinsDue) {
      recordWorkOutcome("processes", "success", labels);
      return "success";
    }
    // Stamp whichever sub-passes we're about to attempt — success or failure —
    // so the publisher doesn't re-queue a failing host every tick.
    const stampAnchors = async (): Promise<void> => {
      const data: Record<string, Date> = {};
      if (inventoryDue) data.lastProcessesAt = now;
      if (pinsDue) data.lastProcessPinsAt = now;
      await prisma.asset.update({ where: { id: assetId }, data }).catch(() => {});
    };

    const fail = async (reason: string): Promise<CadenceOutcome> => {
      await stampAnchors();
      logger.debug({ assetId, method, reason }, "Agentless processes collection failed");
      recordWorkOutcome("processes", "failure", labels);
      return "failure";
    };

    const targetIp = dial(asset);
    if (!targetIp) return await fail("asset has no IP address");

    // Credential chain — mirrors the probe dispatch: per-stream credential →
    // asset default → class-override credential → AD bind fallback.
    const integration = asset.discoveredByIntegration ?? null;
    const isAdSrc = assetSourceKindFromIntegrationType(integration?.type ?? null) === "activedirectory";
    const effCred = asset.processesCredential ?? asset.monitorCredential;
    let credConfig: Record<string, unknown> | null =
      effCred?.type === method ? (effCred.config as Record<string, unknown>) : null;
    if (!credConfig) {
      const classCred = await loadClassOverrideStreamCredential(effective.processesCredentialId, method);
      if (classCred) credConfig = classCred.config as Record<string, unknown>;
    }
    if (!credConfig && isAdSrc && integration && adBindFallbackAllowed(asset)) {
      const cfg = (integration.config as Record<string, unknown>) || {};
      const username = String(cfg.bindDn || "");
      const password = String(cfg.bindPassword || "");
      if (username && password) {
        credConfig = method === "winrm"
          ? { username, password, useHttps: true, port: 5986 }
          : { username, password, port: 22 };
      }
    }
    if (!credConfig) return await fail(`no ${method} credential selected`);

    const opts = {
      inventory: inventoryDue,
      monitored: pinsDue ? pinNames : [],
      mapped:    pinsDue ? mapNames : [],
      timeoutMs: effective.processesTimeoutMs,
    };
    let result: AgentlessProcessResult;
    try {
      if (method === "ssh") {
        result = await collectProcessesSsh(targetIp, credConfig, opts);
      } else {
        result = await collectProcessesWinrm({
          host:      targetIp,
          username:  String(credConfig.username || ""),
          password:  String(credConfig.password || ""),
          useHttps:  credConfig.useHttps !== false,
          port:      typeof credConfig.port === "number" ? credConfig.port : undefined,
          verifyTls: credConfig.verifyTls === true,
          // PS cold-start + the WinRS Receive poll loop realistically need
          // more headroom than the 10s stream default.
          timeoutMs: Math.max(effective.processesTimeoutMs, 30_000),
        }, opts);
      }
    } catch (err: any) {
      return await fail(err?.message || "collection error");
    }

    if (result.inventory) {
      await persistAssetProcesses(assetId, result.inventory);
    }
    if (result.telemetry && result.telemetry.length > 0) {
      enqueueProcessSamples(result.telemetry.map((t) => ({
        assetId,
        timestamp:     now,
        cadence:       "fast" as const,
        name:          t.name,
        cpuPct:        t.cpuPct,
        memRssBytes:   t.memRssBytes,
        instanceCount: t.instanceCount,
      })));
    }
    if (result.connections && result.connections.length > 0) {
      await persistProcessConnections(assetId, result.connections);
    }
    await stampAnchors();
    recordWorkOutcome("processes", "success", labels);
    return "success";
  } catch (err) {
    logger.error({ err, assetId }, "Agentless processes scrape crashed");
    recordWorkOutcome("processes", "crash", labels);
    return "crash";
  } finally {
    stopWork();
  }
}

/**
 * ICMP loss sweep for ONE CHUNK of assets. See utils/burstPing.ts for the
 * batching argument and utils/lossSweep.ts for who is in the sweep and why the
 * window is uniform rather than "while things look bad".
 *
 * Four properties this runner must keep:
 *
 * 1. It NEVER calls recordProbeResult. Rows are enqueued straight to the sample
 *    buffer, so nothing here can move consecutiveFailures / consecutiveSuccesses
 *    or monitorStatus. Down stays a statement about the operator's configured
 *    transport at the operator's configured cadence, because ICMP does not
 *    authenticate the device it reaches.
 *
 * 2. responseTimeMs is NULL. A burst's mean RTT is a different transport's
 *    timing (ICMP answers in ~1-5ms where SNMP takes 20-200ms), so letting it
 *    into the column would dent every response-time chart and drag a "slow
 *    response time" automation's reading down mid-incident. probeKind="icmp" is
 *    the belt; the NULL is the braces.
 *
 * 3. A target that could not be ATTEMPTED writes no row and does not stamp its
 *    anchor. burstPing omits a host it never reached the network for (an
 *    unresolvable name, a missing pinger) rather than reporting it at 100%, and
 *    that distinction has to survive here: recording those as total loss would
 *    turn a DNS outage into a fleet-wide packet-loss event.
 *
 * 4. The anchor is stamped for every asset we DID attempt in ONE updateMany.
 *    A host that never answers must not be re-queued every tick, and 500
 *    sequential per-asset updates on a 60s cadence is exactly the anti-pattern
 *    the fleet-scale review exists to catch.
 *
 * Eligibility is re-checked here because a pg-boss job can be picked up seconds
 * after publication — but only the CHEAP half (monitored, maintenance, target),
 * since the monitor-settings hierarchy was already resolved per asset by the
 * publisher and re-resolving it 500 times would cost more than the sweep it
 * guards.
 */
export async function runLossSweepFor(assetIds: string[], labels: WorkItemLabels): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("lossSample", labels);
  try {
    if (assetIds.length === 0) {
      recordWorkOutcome("lossSample", "success", labels);
      return "success";
    }
    const assets = await prisma.asset.findMany({
      where: { id: { in: assetIds } },
      select: {
        id: true, monitored: true, status: true, dependencySuppressed: true,
        monitorStatus: true,
        ipAddress: true, ipv6Address: true, dnsName: true, hostname: true,
      },
    });
    // Cheap re-check only (see the doc above). Passing responseTimePolling null
    // is not a claim that the stream is enabled — it says this pass is not the
    // thing resolving that, which the publisher already did.
    const eligible = assets.filter((a) => lossSweepIncludes(a, { responseTimePolling: null }, undefined, ipv6Dialable()));
    if (eligible.length === 0) {
      recordWorkOutcome("lossSample", "success", labels);
      return "success";
    }

    // Several assets can share one address (an HA pair mid-failover, a stale
    // duplicate row). Ping it ONCE and fan the single reading out to each:
    // pinging twice would double the traffic and, worse, hand two assets
    // different readings of the same link.
    const byTarget = new Map<string, string[]>();
    for (const a of eligible) {
      const t = lossSweepTarget(a, ipv6Dialable());
      if (!t) continue;
      const list = byTarget.get(t);
      if (list) list.push(a.id);
      else byTarget.set(t, [a.id]);
    }
    const suppressed = new Set(
      eligible.filter((a) => a.dependencySuppressed === true).map((a) => a.id),
    );
    // The sweep reaches no verdict of its own (it never calls
    // recordProbeResult), so unlike the probe path it has no `nextStatus` to
    // read — it marks its misses against the verdict the operator's configured
    // transport has ALREADY reached. Same marker, same reason: a burst fired
    // into a declared outage measures the outage, not the link (rule 29h).
    const declaredDown = new Set(
      eligible.filter((a) => a.monitorStatus === "down").map((a) => a.id),
    );

    const now = new Date();
    const results = await burstPing(Array.from(byTarget.keys()));

    const attempted: string[] = [];
    for (const [target, ids] of byTarget) {
      const r = results.get(target);
      if (!r) continue; // never attempted — not loss, and not a completed cycle
      const success = r.received > 0;
      for (const id of ids) {
        enqueueMonitorSample({
          assetId: id,
          timestamp: now,
          success,
          responseTimeMs: null,
          error: success ? null : "no echo reply",
          probeKind: "icmp",
          packetsSent: r.sent,
          packetsReceived: r.received,
          // The same marking the probe path applies (business rule 38b): a miss
          // the upstream explains is drawn grey, not as an accusation.
          dependencyDown: !success && suppressed.has(id) ? true : undefined,
          assetDown: !success && declaredDown.has(id) ? true : undefined,
        });
        attempted.push(id);
      }
    }

    if (attempted.length > 0) {
      await prisma.asset.updateMany({
        where: { id: { in: attempted } },
        data: { lastLossSampleAt: now },
      });
    }
    recordWorkOutcome("lossSample", "success", labels);
    return "success";
  } catch (err) {
    logger.debug({ err, chunk: assetIds.length }, "ICMP loss sweep crashed");
    recordWorkOutcome("lossSample", "crash", labels);
    return "crash";
  } finally {
    stopWork();
  }
}

/**
 * Storage-only SNMP walk. Same shape as the storage portion of
 * collectSystemInfoSnmp — hrStorageTable first, vendor disk scalar pair as
 * fallback. Used by `runStorageFor` to walk just the storage table without
 * incurring the full IF-MIB / LLDP-MIB session cost.
 */
async function collectStorageOnlySnmp(
  host: string,
  config: Record<string, unknown>,
  manufacturer: string | null | undefined,
  model: string | null | undefined,
  timeoutMs?: number,
  assetType?: string | null,
): Promise<StorageSample[]> {
  const vendorProfile = pickDbProfile({
    manufacturer: manufacturer ?? null,
    os:           null,
    model:        model ?? null,
    assetType:    assetType ?? null,
  });
  const vendorScope: ResolveScope = { manufacturer: manufacturer ?? null, model: model ?? null, profileManufacturer: vendorProfile?.profileManufacturer };
  return await withSnmpSession(host, config, async (session) => {
    const storage: StorageSample[] = [];
    try {
      const types = await snmpWalk(session, OID.hrStorageType);
      const diskIdxs = [...types.entries()].filter(([, v]) => {
        const t = snmpVbToString(v);
        return t === OID.hrStorageFixedDisk || t === OID.hrStorageRemovableDisk;
      }).map(([k]) => k);
      if (diskIdxs.length > 0) {
        const [descrs, units, sizes, useds] = await Promise.all([
          snmpWalk(session, OID.hrStorageDescr).catch(() => new Map()),
          snmpWalk(session, OID.hrStorageAllocationUnits).catch(() => new Map()),
          snmpWalk(session, OID.hrStorageSize).catch(() => new Map()),
          snmpWalk(session, OID.hrStorageUsed).catch(() => new Map()),
        ]);
        for (const idx of diskIdxs) {
          const u = snmpVbToNumber(units.get(idx)) ?? 1;
          const s = snmpVbToNumber(sizes.get(idx));
          const ud = snmpVbToNumber(useds.get(idx));
          storage.push({
            mountPath:  snmpVbToString(descrs.get(idx)) || `disk-${idx}`,
            totalBytes: s != null  ? s * u  : null,
            usedBytes:  ud != null ? ud * u : null,
          });
        }
      }
    } catch { /* fall through to vendor fallback */ }
    if (storage.length === 0) {
      const vendorRow = await collectVendorDiskFallback(session, vendorProfile, vendorScope);
      if (vendorRow) storage.push(vendorRow);
    }
    return storage;
  }, timeoutMs);
}

/**
 * Candidate filter shared by BOTH monitor work-selection paths — the cursor
 * pass below and the pg-boss publisher in jobs/monitorAssets.ts (which
 * imports it). This is the single place that decides which assets receive
 * server-driven polling: `monitored: true`, MINUS assets in maintenance mode
 * (status="maintenance" — the maintenanceScheduler holds that status while
 * a window is open; `monitored` itself stays true so the operator's intent
 * survives the window). Every derived cadence (probe / fastFiltered /
 * telemetry / systemInfo / lldp / storage) flows through these two queries,
 * so excluding an asset here stops ALL of its polling. Deliberately NOT
 * applied to the operator's explicit Poll Now (`POST /assets/:id/probe-now`)
 * — a manual probe is a diagnostic, and notifications are suppressed during
 * maintenance anyway. Agent PUSHES also keep landing: maintenance stops
 * server-driven polling, not inbound agent samples.
 */
export const MONITOR_CANDIDATE_WHERE = {
  monitored: true,
  status: { not: "maintenance" },
} as const;

/**
 * One iteration of the monitor job. Picks assets due for the requested
 * cadences and runs the due work in parallel. Each cadence has its own due
 * check + per-asset interval override (`monitorIntervalSec`,
 * `telemetryIntervalSec`, `systemInfoIntervalSec`).
 *
 * `cadences` selects which cadences this pass owns. The job layer
 * (`monitorAssets.ts`) splits the cadences across two independent ticking
 * loops — light (`probe` + `fastFiltered`) every 5s and heavy (`telemetry`
 * + `systemInfo`) every 30s — so a wedged systemInfo on dead hosts can't
 * hold up per-minute probe polling across ticks. Default is all four
 * cadences so call sites that don't care (e.g. `POST /assets/:id/probe-now`)
 * still see the legacy "do everything" behavior.
 *
 * Each cadence is its own queue item — workers pull single-cadence items
 * rather than the full per-asset pipeline. A 30s SNMP-walk timeout on one
 * host's systemInfo no longer holds up the cheap probe of the next asset:
 * any free worker can pick up that probe immediately. Probes are queued
 * first so when the worker pool is saturated, the lightweight cadence
 * drains before the heavy ones.
 */
/** The cursor pass's candidate load — mirrored (deliberately, see the note in
 *  monitorAssets.ts publishDueWork) by the pg-boss publisher's own query. */
/**
 * The ONE candidate select both monitor paths load: the cursor pass
 * (loadMonitorPassCandidates → computeDueWork) and the pg-boss publisher
 * (jobs/monitorAssets.ts publishDueWork). Two hand-kept copies drifted three
 * ways before this existed (CQ-B035): the publisher never selected
 * `monitored`, so lossSweepIncludes dropped every asset and pg-boss mode
 * published no loss sweep at all; and neither copy selected every per-asset
 * override the resolver reads, so an unselected column read as "inherit" and
 * the due-check ran an operator's per-asset processes / event-log interval or
 * per-stream REST credential as if it were not set.
 *
 * The `satisfies` clause is the guard: every AssetMonitorContext key except
 * the derived `discoveredByIntegrationType` must be selected, so adding a
 * resolver input without selecting it here is a type error rather than a
 * silently wrong cadence. All scalars, mostly null: at 2000 assets the cost
 * is a few dozen KB per tick, against no JSON blob at all.
 */
const MONITOR_PASS_CANDIDATE_SELECT = {
      id: true,
      // Redundant against MONITOR_CANDIDATE_WHERE, and selected anyway so the
      // shared eligibility predicates can be EVALUATED here rather than
      // relying on the WHERE to have already been true. lossSweepIncludes
      // tests `monitored === true`, so an unselected column reads as
      // undefined and silently excludes every asset from the sweep — a
      // whole cadence collecting nothing, with no error anywhere.
      monitored: true,
      assetType: true,
      discoveredByIntegrationId: true,
      // Joined for the resolver — picks the source-default polling method
      // (rest_api for fortinet, icmp for everything else). Without this the
      // resolver maps every candidate to "manual" and the cadence calculation
      // silently drifts.
      discoveredByIntegration: { select: { type: true } },
      // Both counters: the fast-confirm re-probe (business rule 30) reads the
      // run in progress, and consecutiveSuccesses is what tells a recovery
      // being confirmed apart from a steady-up asset.
      monitorStatus: true, consecutiveFailures: true, consecutiveSuccesses: true,
      lastMonitorAt: true, monitorIntervalSec: true,
      // ICMP loss-sampler inputs: its own cadence anchor, and the addressable
      // identity to ping (ipAddress, else the DNS name — a directory-discovered
      // host often carries only the latter, and `ping` resolves a name fine).
      // `status` is belt-and-braces: MONITOR_CANDIDATE_WHERE already excludes
      // maintenance, and the sampler predicate re-checks it anyway.
      lastLossSampleAt: true, ipAddress: true, ipv6Address: true, dnsName: true, hostname: true, status: true,
      // The heavy streams are due off their last ATTEMPT, not their last
      // success (business rule 118) — a failing device waits a cadence.
      lastTelemetryAttemptAt: true, cpuMemoryIntervalSec: true, temperatureIntervalSec: true,
      lastSystemInfoAttemptAt: true, systemInfoIntervalSec: true,
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
      // Agentless processes cadence (ssh/winrm): due-calc inputs. The runner
      // (runProcessesFor) re-loads the asset itself; these keep the cursor
      // pass's due-set aligned with the pg-boss publisher's.
      processesPolling: true,
      lastProcessesAt: true, lastProcessPinsAt: true,
      monitoredProcesses: true, mappedProcesses: true,
      // Same, for the agentless event-log cadence.
      eventLogPolling: true, lastEventLogAt: true,
      // Manufacturer custom-widget cadence anchor (business rules 118 + 130).
      lastCustomWidgetAttemptAt: true,
      // SD-WAN cadence anchor; its interval comes from the integration sidecar
      // (resolveSdwanIntervalSec), not a per-asset column.
      lastSdwanAt: true,
      dependencySuppressed: true,
      // Dedicated LLDP + Storage cadences (pg-boss only — the cursor pass
      // carries both as systemInfo side effects): their anchors.
      lastLldpAt: true, lastStorageAt: true,
      // Every remaining resolver input (the satisfies clause below enforces
      // it): per-asset interval / timeout overrides, MIB ids, and the
      // per-stream credential ids — an own REST token keeps `rest_api` where
      // the integration cannot make a FortiOS call (resolveStream).
      lldpIntervalSec: true, storageIntervalSec: true,
      processesIntervalSec: true, eventLogIntervalSec: true,
      cpuMemoryTimeoutMs: true, temperatureTimeoutMs: true, systemInfoTimeoutMs: true,
      processesTimeoutMs: true, eventLogTimeoutMs: true,
      responseTimeMibId: true, cpuMemoryMibId: true, temperatureMibId: true,
      interfacesMibId: true, lldpMibId: true, processesMibId: true,
      responseTimeCredentialId: true, cpuMemoryCredentialId: true, temperatureCredentialId: true,
      interfacesCredentialId: true, lldpCredentialId: true,
} satisfies Prisma.AssetSelect & Record<Exclude<keyof AssetMonitorContext, "discoveredByIntegrationType">, true>;

export async function loadMonitorPassCandidates() {
  return prisma.asset.findMany({
    where: MONITOR_CANDIDATE_WHERE,
    select: MONITOR_PASS_CANDIDATE_SELECT,
  });
}
export type MonitorPassCandidate = Awaited<ReturnType<typeof loadMonitorPassCandidates>>[number];

type MonitorWorkKind = "probe" | "telemetry" | "systemInfo" | "fastFiltered" | "processes" | "eventLog" | "sdwan" | "lossSample" | "customWidget";
type MonitorWork = { id: string; kind: MonitorWorkKind };
/**
 * Effective probe spacing in seconds for one asset.
 *
 * The response-time poll runs at EXACTLY the configured cadence in every state
 * — dependency-suppressed included (business rule 38(c)). A suppressed asset
 * used to drop to 2× the interval on the theory that it would not answer until
 * its parent recovered, but its own leaky bucket keeps counting under the
 * suppression, and that is the count it leaves Dep. Down with: when the parent
 * comes back, the device behind it is answering again at the same moment, and
 * half-rate polling made it drain its bucket half as fast as the parent did —
 * so every layer down a dependency chain read `recovering` for longer than the
 * layer above it, for no reason but the clamp.
 *
 * No acceleration either, including while a failure or recovery run is being
 * confirmed. There is
 * deliberately no acceleration: `down` is declared by `failureThreshold`
 * consecutive misses of the configured method at the configured cadence, so
 * time-to-down is `failureThreshold × intervalSeconds` and the figure an
 * operator reads off the monitor-settings card is the figure they get.
 *
 * The fast-confirm re-probe that used to live here (business rule 30,
 * 2026-08-17) was removed alongside the ICMP loss sampler change. Extra
 * resolution is now the uniform loss sweep's job (`utils/lossSweep.ts`),
 * and it feeds packet-loss statistics ONLY — it never touches the counters,
 * because ICMP cannot authenticate the device it reaches and a second transport
 * voting on `down` would make the state mean whichever of the two answered
 * last. `fastConfirmIntervalSec` stays on the settings tiers as a dormant
 * column (dropping it would cost an irreversible migration for no gain) and is
 * now read by nothing.
 */
export function resolveProbeIntervalSec(
  eff: Pick<MonitorTierSettings, "intervalSeconds">,
): number {
  return eff.intervalSeconds;
}

export interface DueMonitorWork {
  probes: MonitorWork[];
  fastFiltereds: MonitorWork[];
  telemetries: MonitorWork[];
  systemInfos: MonitorWork[];
  processesWork: MonitorWork[];
  eventLogWork: MonitorWork[];
  sdwanWork: MonitorWork[];
  lossSamples: MonitorWork[];
  customWidgetWork: MonitorWork[];
  /** ICMP assets due a probe, batched rather than dispatched per item. */
  probeBatch: ProbeBatchItem[];
}

/**
 * Is a cadence due? `intervalSec <= 0` disables the cadence; a never-stamped
 * anchor is due at once. The one arithmetic every per-asset cadence uses.
 */
function cadenceDue(last: Date | null | undefined, intervalSec: number, now: Date): boolean {
  if (intervalSec <= 0) return false;
  if (!last) return true;
  return now.getTime() - last.getTime() >= intervalSec * 1000;
}

/**
 * THE SWEEP CADENCE for one pass: the operator's interval, floored at what the
 * installed pinger can actually finish for a fleet this size. Without fping the
 * fallback forks per host, so a large fleet genuinely cannot hold 60s.
 * `candidateCount` is the fleet rather than the sweep-eligible subset, which
 * errs toward the wider interval: the eligible set is not known until the
 * due loop has run. Resolved once per pass by both monitor paths.
 */
export async function passSweepIntervalSec(candidateCount: number): Promise<number> {
  return resolveSweepIntervalSec(configuredSweepIntervalSec(), candidateCount, await detectFping());
}

/** Per-pass inputs to resolveDueCadences, computed once by the caller. */
export interface DuePassContext {
  enabled: Set<MonitorCadence>;
  now: Date;
  /** Assets with a manufacturer custom widget switched on (business rule 130). */
  widgetAssetIds: Set<string>;
  /** passSweepIntervalSec() for this pass. */
  sweepIntervalSec: number;
}

/** Which cadences one asset is due, already filtered by `enabled`. */
export interface DueCadences {
  probe: boolean;
  /** Resolved probe cadence (resolveProbeIntervalSec); rides the probe job. */
  probeIntervalSec: number;
  /** The address an ICMP probe dials when it is batched; null = one job per asset. */
  probeBatchTarget: string | null;
  telemetry: boolean;
  systemInfo: boolean;
  fastFiltered: boolean;
  /** pg-boss only: the cursor pass never enables lldp / storage. */
  lldp: boolean;
  storage: boolean;
  processes: boolean;
  eventLog: boolean;
  customWidget: boolean;
  sdwan: boolean;
  lossSample: boolean;
}

/**
 * The due decision for ONE candidate, shared by the cursor pass
 * (computeDueWork) and the pg-boss publisher (jobs/monitorAssets.ts
 * publishDueWork). The two due-sets are contractually identical, and until
 * this existed they were two hand-kept copies that drifted (CQ-B035): the
 * publisher still excluded managed FortiAPs from REST telemetry four months
 * after the cursor path started collecting it. Callers only decide what to DO
 * with a due cadence (a work item, a pg-boss job, a batch entry).
 *
 * DB-read-only: resolves the effective settings through the four-tier
 * hierarchy (memoized per (integration|manual, assetType) bucket) and applies
 * the cadence + eligibility gates. Returns `eff` because the publisher labels
 * each job with the resolved transport.
 */
export async function resolveDueCadences(
  a: MonitorPassCandidate,
  ctx: DuePassContext,
): Promise<{ eff: ResolvedMonitorSettings; due: DueCadences }> {
  const { enabled, now } = ctx;
  const isDue = (last: Date | null | undefined, intervalSec: number) => cadenceDue(last, intervalSec, now);
  const eff = await resolveMonitorSettings({
    ...a,
    discoveredByIntegrationType: a.discoveredByIntegration?.type ?? null,
  });

  // Probe cadence is the resolved intervalSeconds in every state — no backoff
  // for down hosts, and no acceleration while a failure/recovery run is being
  // confirmed. Down-host suppression below stops heavy cadences regardless;
  // the cheap response-time probe keeps firing at base cadence so recovery is
  // detected within one tick — dependency-suppressed assets included, since
  // their own count is what lets them leave Dep. Down with their parent
  // (business rule 38(c)). Extra resolution DURING a run is the ICMP loss
  // sweep's job (utils/lossSweep.ts): it feeds packet loss only and never
  // touches the state machine's counters.
  const probeIntervalSec = resolveProbeIntervalSec(eff);
  const probeDue = isDue(a.lastMonitorAt, probeIntervalSec);
  // Pragmatic stream-split: CPU/memory's cadence is the unified "telemetry
  // due" trigger; collectTelemetry still pulls temperature on the same
  // session. Due off the ATTEMPT stamps (business rule 118): a failure waits
  // one cadence like a success does. The success stamps are the UI's.
  const telemetryDue  = isDue(a.lastTelemetryAttemptAt,  eff.cpuMemoryIntervalSeconds);
  const systemInfoDue = isDue(a.lastSystemInfoAttemptAt, eff.systemInfoIntervalSeconds);
  const hasFastPin =
    (Array.isArray(a.monitoredInterfaces)   && a.monitoredInterfaces.length   > 0) ||
    (Array.isArray(a.monitoredStorage)      && a.monitoredStorage.length      > 0) ||
    (Array.isArray(a.monitoredIpsecTunnels) && a.monitoredIpsecTunnels.length > 0);

  // Pre-queue eligibility. collectTelemetry / collectSystemInfo return
  // {supported:false} for these cases, which means neither attempt stamp ever
  // advances and the asset sits in the work queue on EVERY heavy tick —
  // permanently inflating pass duration (cursor) or the queue (pg-boss).
  //
  // Managed FortiSwitches are not directly REST-able: their telemetry and
  // system-info endpoints live on the parent FortiGate, and the
  // controller-status table reports up/down only. Managed FortiAPs DO have
  // REST telemetry (collectTelemetryFortiapRest, piggybacking on
  // /api/v2/monitor/wifi/managed_ap), so the telemetry gate excludes switches
  // only; system info excludes both. Operators who want more flip the
  // integration's FortiSwitches/APs subtab to direct SNMP.
  // "vcenter" (hypervisor-view quickStats) deliberately passes — it delivers
  // telemetry via the per-integration warm cache. ssh / winrm pass too
  // (agentlessHostService); icmp carries no payload.
  const isManagedSwitchOrAp = a.assetType === "switch" || a.assetType === "access_point";
  const canTelemetry =
    eff.cpuMemoryPolling !== null &&
    eff.cpuMemoryPolling !== "icmp" &&
    !(eff.cpuMemoryPolling === "rest_api" && a.assetType === "switch");
  // systemInfo carries three streams (interfaces / lldp / storage); runnable
  // when ANY is enabled — collectSystemInfo gates each stream internally.
  const anySysInfoStream =
    eff.interfacesPolling !== null ||
    eff.lldpPolling       !== null ||
    eff.storagePolling    !== null;
  const canSystemInfo =
    anySysInfoStream &&
    !(eff.interfacesPolling === "rest_api" && isManagedSwitchOrAp);

  // Heavy-cadence suppression: confirmed up AND not dependency-suppressed
  // (or passive with a last probe that succeeded — its charts keep filling).
  // See runsHeavyCadences for the per-state rationale. The cheap probe keeps
  // firing in every state so recovery is detected within one cadence.
  const isUp = runsHeavyCadences(a);

  // The probe gates on its resolved method like every stream below —
  // "disabled" means don't poll, and queueing it anyway is what let an
  // off-switch read as an outage.
  const probe = probeDue && enabled.has("probe") && responseTimeProbeShouldQueue(eff.responseTimePolling);
  // ICMP is the ONE transport where a single process serves many hosts (one
  // fping per timeout bucket), so it is batched. Every other transport needs
  // its own authenticated conversation and stays one item per asset. The
  // target is the IPv4, else (IPv6 on) the primary IPv6 — business rule 128.
  const probeBatchTarget = probe && eff.responseTimePolling === "icmp" ? dial(a) : null;

  // Fast-cadence pinned scrape rides the probe cadence. Skipped while the
  // full systemInfo pass is due — same OIDs twice, and the full pass covers
  // the pinned subset. `systemInfoDue` is the asset's overall due state, not
  // whether THIS pass handles systemInfo, so it holds across the light and
  // heavy loops: fast-filtered waits until systemInfo stamps its attempt.
  const fastFiltered =
    probeDue && hasFastPin && canSystemInfo && !systemInfoDue && isUp && enabled.has("fastFiltered");

  // Dedicated LLDP + Storage cadences (pg-boss only; the cursor systemInfo
  // walk covers both as session-coalesced side effects, and the persisters
  // are idempotent against the overlap). isUp-gated: heavy walks. Storage's
  // own queue covers SNMP and the agentless transports only — agent hosts push
  // on their own schedule and vCenter storage rides the system-info pass.
  const lldp =
    isUp && enabled.has("lldp") && !!eff.lldpPolling && eff.lldpPolling !== "disabled" &&
    isDue(a.lastLldpAt, eff.lldpIntervalSeconds);
  const storage =
    isUp && enabled.has("storage") &&
    (eff.storagePolling === "snmp" || eff.storagePolling === "ssh" || eff.storagePolling === "winrm") &&
    isDue(a.lastStorageAt, eff.storageIntervalSeconds);

  // Agentless processes (ssh/winrm only — agent hosts self-collect). Due when
  // the inventory interval elapsed OR pins / mapped names arm the 60s
  // sub-pass; runProcessesFor re-derives which sub-passes to run and stamps
  // the anchors even on failure, so a bad credential cannot re-queue every
  // tick. isUp: authenticated transports do not hammer unconfirmed hosts.
  const procPins = ((a.monitoredProcesses?.length ?? 0) + (a.mappedProcesses?.length ?? 0)) > 0;
  const processes =
    isUp && enabled.has("processes") &&
    (eff.processesPolling === "ssh" || eff.processesPolling === "winrm") &&
    (isDue(a.lastProcessesAt, eff.processesIntervalSeconds) ||
      (procPins && isDue(a.lastProcessPinsAt, PROCESS_PINS_INTERVAL_SEC)));
  // Agentless event log — same shape and gate; runEventLogFor re-checks the
  // agentEventLog master switch and stamps its anchor even on failure.
  const eventLog =
    isUp && enabled.has("eventLog") &&
    (eff.eventLogPolling === "ssh" || eff.eventLogPolling === "winrm") &&
    isDue(a.lastEventLogAt, eff.eventLogIntervalSeconds);
  // Manufacturer custom widgets (business rule 130): only for an asset with a
  // widget switched on, at the hardware-sensor interval. No polling-method
  // gate — the per-asset switch is the gate.
  const customWidget =
    isUp && enabled.has("customWidget") && ctx.widgetAssetIds.has(a.id) &&
    isDue(a.lastCustomWidgetAttemptAt, customWidgetIntervalSec(eff));
  // SD-WAN (FortiOS SLA + rule selection), on the light loop so a 60s interval
  // lands on time. The interval is read AFTER resolveMonitorSettings above,
  // which warms the sidecar it lives in.
  const sdwanIntervalSec = resolveSdwanIntervalSec(a);
  const sdwan =
    isUp && enabled.has("sdwan") &&
    sdwanShouldQueue(a, eff, sdwanIntervalSec) &&
    isDue(a.lastSdwanAt, sdwanIntervalSec);
  // ICMP loss sweep: a uniform burst at EVERY eligible asset, whatever state it
  // is in — deliberately NOT gated on isUp or monitorStatus; the old sampler's
  // warning/recovering window was itself the bias that got it disabled
  // (utils/lossSweep.ts). Its own anchor, independent of `probe`.
  const lossSample =
    enabled.has("lossSample") &&
    lossSweepIncludes(a, eff, undefined, ipv6Dialable()) &&
    lossSweepIsDue(a.lastLossSampleAt, now, ctx.sweepIntervalSec);

  return {
    eff,
    due: {
      probe, probeIntervalSec, probeBatchTarget,
      telemetry: telemetryDue && canTelemetry && isUp && enabled.has("telemetry"),
      systemInfo: systemInfoDue && canSystemInfo && isUp && enabled.has("systemInfo"),
      fastFiltered, lldp, storage, processes, eventLog, customWidget, sdwan, lossSample,
    },
  };
}

/**
 * The due-set computation extracted from runMonitorPass (2026-08; unit tests
 * in tests/unit/computeDueWork.test.ts pin the eligibility semantics).
 * DB-READ-ONLY: resolves each candidate's effective settings (cached) and
 * applies the cadence + eligibility gates — no transports are touched.
 */
/**
 * Ceiling on ICMP loss samples queued by ONE cursor-mode pass. See the guard at
 * the end of computeDueWork for why dropping beats queueing.
 */
export const LOSS_SAMPLES_MAX_PER_PASS = 200;

export async function computeDueWork(
  candidates: MonitorPassCandidate[],
  enabled: Set<MonitorCadence>,
  now: Date,
  // Assets with at least one manufacturer custom widget switched on (business
  // rule 130) — loaded once per pass by the caller, never per asset here.
  widgetAssetIds: Set<string> = new Set(),
): Promise<DueMonitorWork> {
  const probes: MonitorWork[]       = [];
  const fastFiltereds: MonitorWork[] = [];
  const telemetries: MonitorWork[]  = [];
  const systemInfos: MonitorWork[]  = [];
  const processesWork: MonitorWork[] = [];
  const eventLogWork: MonitorWork[] = [];
  const sdwanWork: MonitorWork[] = [];
  const lossSamples: MonitorWork[] = [];
  const customWidgetWork: MonitorWork[] = [];
  const probeBatch: ProbeBatchItem[] = [];
  // Same sweep cadence the pg-boss publisher resolves (passSweepIntervalSec).
  const ctx: DuePassContext = {
    enabled, now, widgetAssetIds,
    sweepIntervalSec: await passSweepIntervalSec(candidates.length),
  };
  for (const a of candidates) {
    // The decision is resolveDueCadences, shared with the pg-boss publisher;
    // this loop only turns each due cadence into a work item.
    const { eff, due } = await resolveDueCadences(a, ctx);
    if (due.probe) {
      if (due.probeBatchTarget) {
        probeBatch.push({ id: a.id, target: due.probeBatchTarget, timeoutMs: eff.probeTimeoutMs, intervalSec: due.probeIntervalSec });
      } else {
        probes.push({ id: a.id, kind: "probe" });
      }
    }
    if (due.telemetry)    telemetries.push({ id: a.id, kind: "telemetry" });
    if (due.systemInfo)   systemInfos.push({ id: a.id, kind: "systemInfo" });
    if (due.fastFiltered) fastFiltereds.push({ id: a.id, kind: "fastFiltered" });
    if (due.processes)    processesWork.push({ id: a.id, kind: "processes" });
    if (due.eventLog)     eventLogWork.push({ id: a.id, kind: "eventLog" });
    if (due.customWidget) customWidgetWork.push({ id: a.id, kind: "customWidget" });
    if (due.sdwan)        sdwanWork.push({ id: a.id, kind: "sdwan" });
    // Swept in BATCHES rather than dispatched per asset (see runMonitorPass),
    // which is the whole reason a fleet-wide window is affordable.
    if (due.lossSample)   lossSamples.push({ id: a.id, kind: "lossSample" });
  }
  // Cursor-mode starvation guard. runMonitorPass awaits the WHOLE pass before
  // returning and the light tick holds a `running` guard, so a site-wide outage
  // that puts hundreds of assets into `warning` at once could make one pass long
  // enough to delay the next tick — starving the response-time probes that
  // decide whether those assets are actually down, which is the one thing this
  // cadence must never do. Loss samples are best-effort resolution, so the
  // honest response is to drop the excess rather than to queue it: the next tick
  // recomputes the due-set anyway, and each asset's own 10s anchor means the
  // ones that were dropped are the ones most likely to be picked next.
  // pg-boss mode does not need this — it has its own pool and a 15s job expiry.
  if (lossSamples.length > LOSS_SAMPLES_MAX_PER_PASS) {
    logger.warn(
      { due: lossSamples.length, cap: LOSS_SAMPLES_MAX_PER_PASS },
      "loss-sample due-set truncated to protect probe cadence (cursor mode)",
    );
    lossSamples.length = LOSS_SAMPLES_MAX_PER_PASS;
  }
  return { probes, probeBatch, fastFiltereds, telemetries, systemInfos, processesWork, eventLogWork, sdwanWork, lossSamples, customWidgetWork };
}

export async function runMonitorPass(opts?: { concurrency?: number; cadences?: MonitorCadence[] }): Promise<RunStats> {
  const enabled = new Set<MonitorCadence>(
    opts?.cadences ?? ["probe", "fastFiltered", "telemetry", "systemInfo"],
  );
  const endPassTimer = startPassTimer();
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 8, 32));
  const now = new Date();

  const candidates = await loadMonitorPassCandidates();

  // Asset-count gauges. Set every pass so the Grafana view stays current
  // even when the fleet size changes between ticks.
  let upCount = 0, downCount = 0, passiveCount = 0, unknownCount = 0;
  for (const a of candidates) {
    if (a.monitorStatus === "up") upCount++;
    else if (a.monitorStatus === "down") downCount++;
    // Passive gets its own bucket: folding it into "unknown" would read as
    // "never probed" about devices that are being polled perfectly well.
    else if (a.monitorStatus === "passive") passiveCount++;
    else unknownCount++;
  }
  setMonitoredAssets(candidates.length, { up: upCount, down: downCount, passive: passiveCount, unknown: unknownCount });

  // Per-asset resolved transport labels for the work-duration histogram and
  // per-probe histogram. Probe uses responseTimePolling; telemetry uses
  // telemetryPolling; systemInfo + fastFiltered use interfacesPolling.
  // Falls back to the integration-source default when the per-asset column
  // is null (full resolver fidelity would require the class-override +
  // tier-3 lookup but that's overkill for a metric label).
  //
  // Source defaults (from polaris-monitoring-discovery -> polling-methods-streams.md): fortimanager/fortigate → rest_api on
  // probe / telemetry / interfaces; everything else → icmp on probe and
  // null (= "not delivered") on the other streams. The publishDueWork +
  // canTelemetry/canSystemInfo gates already block work items whose stream
  // resolves to null, so in practice the non-fortinet null case here
  // doesn't reach a worker — the "not_delivered" label is a defensive
  // fallback only.
  function defaultProbeTransport(integrationType: string | null | undefined): string {
    return (isFortinetIntegrationType(integrationType)) ? "rest_api" : "icmp";
  }
  function defaultHeavyTransport(integrationType: string | null | undefined): string {
    return (isFortinetIntegrationType(integrationType)) ? "rest_api" : "not_delivered";
  }
  const transportByCadenceById = new Map<string, Record<MonitorCadence, string>>();
  const assetTypeById = new Map<string, string>();
  for (const a of candidates) {
    const integrationType = a.discoveredByIntegration?.type;
    const probeT = a.responseTimePolling || defaultProbeTransport(integrationType);
    const telT   = a.cpuMemoryPolling    || defaultHeavyTransport(integrationType);
    const ifT    = a.interfacesPolling   || defaultHeavyTransport(integrationType);
    transportByCadenceById.set(a.id, {
      probe:        probeT,
      telemetry:    telT,
      systemInfo:   ifT,
      fastFiltered: ifT,
      // Phase 2 carve-out: LLDP + Storage cadences are pg-boss-only and don't
      // dispatch through runMonitorPass in cursor mode. Fill the transport
      // labels anyway so the histogram label set is complete if a future
      // cursor-mode dispatcher needs them.
      lldp:         a.lldpPolling    || ifT,
      storage:      a.storagePolling || ifT,
      processes:    a.processesPolling || "not_delivered",
      eventLog:     a.eventLogPolling  || "not_delivered",
      // SD-WAN only ever runs over FortiOS REST (sdwanShouldQueue).
      sdwan:        "rest_api",
      // The loss sampler is ICMP by definition, whatever the response-time
      // stream uses — that IS the finding the label should carry.
      lossSample:   "icmp",
      // Manufacturer widgets are SNMP walks (plus HTTP checks, a minority).
      customWidget: "snmp",
    });
    assetTypeById.set(a.id, a.assetType ?? "unknown");
  }

  // One query per pass, and only when this pass dispatches the cadence.
  const widgetAssetIds = enabled.has("customWidget") ? await assetIdsWithEnabledWidgets() : new Set<string>();
  const { probes, probeBatch, fastFiltereds, telemetries, systemInfos, processesWork, eventLogWork, sdwanWork, lossSamples, customWidgetWork } =
    await computeDueWork(candidates, enabled, now, widgetAssetIds);

  // Order matters: probes first so a saturated worker pool drains the cheap
  // cadence ahead of the heavy walks. Fast-filtered scrapes ride the same
  // 60s cadence as probes and are still small relative to a full systemInfo
  // pass, so they queue right behind probes. Telemetry and systemInfo bring
  // up the rear — those are what actually time out on dead hosts, and they
  // shouldn't get to block per-minute polling for the rest of the fleet.
  // Loss samples sit directly behind probes: they are single pings with a 5s
  // timeout, and a sample delayed past its 10s cadence is worthless (the next
  // one is already due), so queueing them behind the heavy walks would mean
  // collecting nothing during exactly the incident they exist to measure.
  // They still yield to probes, which decide whether the asset is down at all.
  // lossSamples are deliberately NOT in this array: the sweep is batched, so it
  // runs as one call over all due ids after the per-asset pass rather than as
  // one work item per asset. Dispatching it per item would put back exactly the
  // per-host process spawn the batching exists to remove.
  // SD-WAN sits behind fastFiltered on the light loop: two small REST GETs,
  // still behind the probes that decide whether anything is down.
  const work: MonitorWork[] = [...probes, ...fastFiltereds, ...sdwanWork, ...telemetries, ...customWidgetWork, ...systemInfos, ...processesWork, ...eventLogWork];

  setQueueDepth({
    customWidget: customWidgetWork.length,
    probe: probes.length,
    fastFiltered: fastFiltereds.length,
    telemetry: telemetries.length,
    systemInfo: systemInfos.length,
    processes: processesWork.length,
    eventLog: eventLogWork.length,
    sdwan: sdwanWork.length,
    lossSample: lossSamples.length,
  });

  const stats: RunStats = {
    probed: 0, succeeded: 0, failed: 0,
    telemetry:  { collected: 0, failed: 0 },
    systemInfo: { collected: 0, failed: 0 },
    fastFiltered: { collected: 0, failed: 0 },
    processes:  { collected: 0, failed: 0 },
    eventLog:   { collected: 0, failed: 0 },
    sdwan:      { collected: 0, failed: 0 },
    lossSample: { collected: 0, failed: 0 },
    customWidget: { collected: 0, failed: 0 },
  };
  if (work.length === 0) {
    endPassTimer();
    return stats;
  }

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < work.length) {
      const idx = cursor++;
      const w = work[idx];
      const runWork = async () => {
        const assetType = assetTypeById.get(w.id) ?? "unknown";
        const transports = transportByCadenceById.get(w.id);
        const labelFor = (cadence: MonitorCadence): WorkItemLabels => ({
          assetType,
          transport: transports?.[cadence] ?? "unknown",
        });
        switch (w.kind) {
          case "probe": {
            const outcome = await runProbeFor(w.id, labelFor("probe"));
            stats.probed++;
            if (outcome === "success") stats.succeeded++; else stats.failed++;
            break;
          }
          case "telemetry": {
            const outcome = await runTelemetryFor(w.id, labelFor("telemetry"));
            if (outcome === "success") stats.telemetry.collected++;
            else stats.telemetry.failed++;
            break;
          }
          case "systemInfo": {
            const outcome = await runSystemInfoFor(w.id, labelFor("systemInfo"));
            if (outcome === "success") stats.systemInfo.collected++;
            else stats.systemInfo.failed++;
            break;
          }
          case "fastFiltered": {
            const outcome = await runFastFilteredFor(w.id, labelFor("fastFiltered"));
            if (outcome === "success") stats.fastFiltered.collected++;
            else stats.fastFiltered.failed++;
            break;
          }
          case "processes": {
            const outcome = await runProcessesFor(w.id, labelFor("processes"));
            if (outcome === "success") stats.processes.collected++;
            else stats.processes.failed++;
            break;
          }
          case "eventLog": {
            const outcome = await runEventLogFor(w.id, labelFor("eventLog"));
            if (outcome === "success") stats.eventLog.collected++;
            else stats.eventLog.failed++;
            break;
          }
          case "sdwan": {
            const outcome = await runSdwanFor(w.id, labelFor("sdwan"));
            if (outcome === "success") stats.sdwan.collected++;
            else stats.sdwan.failed++;
            break;
          }
          case "customWidget": {
            const outcome = await runCustomWidgetsFor(w.id, labelFor("customWidget"));
            if (outcome === "success") stats.customWidget.collected++;
            else stats.customWidget.failed++;
            break;
          }

        }
      };
      await runWork();
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, () => worker()));
    // The loss sweep runs as ONE batched call per chunk after the per-asset
    // work, not as work items inside it. Sequential across chunks on purpose:
    // each chunk is already one fping process pinging up to 500 hosts, and
    // running several of those at once would multiply the packet rate without
    // shortening the sweep, which is bounded by burst period rather than by
    // host count. Its failures never fail the pass — loss is resolution, and
    // the response-time probes in `work` above are what decide reachability.
    // Batched ICMP status probes, before the loss sweep: this is the cadence
    // that decides whether a device is down, and it must not queue behind a
    // resolution-only measurement.
    for (let i = 0; i < probeBatch.length; i += 250) {
      const slice = probeBatch.slice(i, i + 250);
      const outcome = await runProbeBatchFor(slice, { assetType: "mixed", transport: "icmp" });
      if (outcome === "success") stats.probed += slice.length;
    }
    for (const c of chunkForSweep(lossSamples.map((w) => w.id))) {
      // A chunk spans many asset types, so per-type labelling is a category
      // error here rather than a missing lookup — "mixed" says so honestly
      // instead of attributing a 500-host sweep to whichever type came first.
      const outcome = await runLossSweepFor(c, { assetType: "mixed", transport: "icmp" });
      if (outcome === "success") stats.lossSample.collected += c.length;
      else stats.lossSample.failed += c.length;
    }
  } finally {
    endPassTimer();
  }
  return stats;
}
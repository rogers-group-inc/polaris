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
 */

import { toNonNegativeInt, toFiniteOrNull } from "../utils/num.js";
import { trimTrailing } from "../utils/trimTrailing.js";
import { tryCompileSafeRegex } from "../utils/safeRegex.js";
import { pinnedAgentFor } from "../utils/pinnedTlsAgent.js";
import { chunkArray } from "../utils/chunk.js";
import type { Prisma } from "../generated/prisma/client.js";
import { normalizeMacOrNull } from "../utils/mac.js";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import {
  type HttpCheckConfig,
  type HttpProbeDiagnostics,
  MAX_BODY_BYTES,
  bodyExcerpt,
  describeHttpTarget,
  evaluateHttpCheck,
  resolveHttpTarget,
  resolveHttpAuthMode,
  type HttpAuthConfig,
} from "../utils/httpCheck.js";
import {
  parseDigestChallenge,
  buildDigestAuthorization,
  authSchemesOffered,
  newCnonce,
} from "../utils/digestAuth.js";
import { URL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import * as snmp from "net-snmp";
import { Client as SshClient } from "ssh2";
import { buildHostVerifier } from "../utils/remoteExec.js";

import { prisma } from "../db.js";
import { retryOnDeadlock } from "../utils/dbRetry.js";
import { diffInventory, normalizeBytes, normalizeCpuPct, sameInventoryRow } from "../utils/inventoryDelta.js";
// NOTE: agentlessProcessService imports back from this module with
// `import type` only, so this pair can't cycle at runtime.
import { collectProcessesSsh, collectProcessesWinrm, type AgentlessProcessResult } from "./agentlessProcessService.js";
import {
  collectHostSsh, collectHostWinrm, collectEventLogSsh, collectEventLogWinrm,
  type AgentlessEventLogEntry,
} from "./agentlessHostService.js";
import { ingestOsEventLog, getAgentEventLogConfig } from "./osEventLogService.js";
import { AppError } from "../utils/errors.js";
import { matchesWildcard } from "../utils/integrationFilter.js";
import { bareInterfaceIp, bareHost, interfaceIpIsUnaddressed, isIpv6Address, urlHost } from "../utils/cidr.js";
import { pickInterfaceAddresses, splitInterfaceAddresses } from "../utils/interfaceAddress.js";
import { ipv6Dialable, ipv6Enabled } from "./ipv6GateService.js";
import {
  IP_ADDRESS_IF_INDEX_OID,
  IP_ADDRESS_TYPE_OID,
  addressesByIfIndexFromIpAddressTable,
  addressesByIfIndexFromIpAddrTable,
} from "../utils/snmpIpAddressTable.js";
import { parseInterfaceIpv6 } from "../utils/fortiosIpv6.js";
import { fortiosSecondaryIpStrings } from "../utils/fortiosSecondaryIp.js";
import { FORTIOS_INTERFACE_CMDB_FORMAT } from "../utils/fortiosInterfaceRef.js";
import { applyTransform } from "../utils/symbolTransforms.js";
import { createTtlCache } from "../utils/ttlCache.js";
import { expandMacRange } from "../utils/macAddresses.js";
import { reconcileInterfaceMacs } from "./macAddressService.js";
import { persistInterfaces, loadInterfaceIdentity, repairInterfacePins } from "./interfaceInventoryService.js";
import {
  buildInterfaceIdentity,
  canonicalInterfaceName,
  canonicalizeInterfaceRows,
} from "../utils/interfaceIdentity.js";
import { makeOidMonotonicGuard } from "../utils/oidCompare.js";
import { burstPingHost } from "../utils/icmpPing.js";
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
import {
  parseFortiosMemberList,
  buildFortiswitchTrunkMembers,
  findFortiswitchUplinkPorts,
  parseFortiswitchMclagPeers,
  parseFortiswitchPortDescriptions,
  parseFortiswitchPortVlan,
  fortiosVlanIdByName,
  FORTISWITCH_MONITOR_PORT_FORMAT,
  type FortiswitchMclagPeer,
  type FortiswitchPortVlan,
} from "../utils/fortiswitchCmdb.js";
// Re-exported so existing import sites (unit tests, etc.) keep resolving these
// from monitoringService; implementations live in utils/fortiswitchCmdb.ts.
export { parseFortiosMemberList, buildFortiswitchTrunkMembers, findFortiswitchUplinkPorts };
import { fgRequest, FortiosAuthPausedError, type FortiGateConfig } from "./fortigateService.js";
import { fetchVcenterQuickStats, fetchVcenterHostSnapshot } from "./vcenterService.js";
import {
  fmgProxyRest,
  resolveDeviceMgmtIpViaFmg,
  fetchRosterConnectivity,
  type FortiManagerConfig,
  type RosterDeviceStatus,
} from "./fortimanagerService.js";
import { logEvent, logEventsBatch, buildConnectionChangedEvent, buildFirmwareChangedEvent, type LogEventInput } from "./eventLogService.js";
import { projectAssetFromSources } from "../utils/assetProjection.js";
import { lookupOuiOverride } from "./ouiService.js";
import { resolveAssetTypeCached } from "../utils/assetTypeMatch.js";
import { SYS_OIDS, scalarInstanceOid, pickScalar } from "../utils/snmpIdentity.js";
import {
  parseVendorSysDescr,
  sameDescrObserved,
  descrReadDue,
  type SysDescrDetail,
} from "../utils/snmpDescrIdentity.js";
import { maybeEmitChangeEvents, wirelessRoamEventsWanted, type ChangeItem } from "./notificationChangeEvents.js";
import { isChangeActionSubscribed } from "./notificationRuleService.js";
import { logger } from "../utils/logger.js";
import { adBindFallbackAllowed, adBindFallbackIntegration } from "../utils/adBindFallback.js";
import { parseFortiapTelemetrySnapshot, isCanonicalFortiapVersion } from "../utils/fortiapMonitorRow.js";
import { readSystemStatus } from "../utils/fortiosEnvelope.js";
import { reconcileFortinetLiveVersions, fortigateLiveVersionFor } from "./fortinetLiveVersionService.js";
import type { ApRadioSample, ApVapSample } from "../utils/fortiapMonitorRow.js";
import {
  FAP_RADIO_OID, FAP_VAP_OID, decodeRadioMode, decodeChannelWidth, decodeRadioType,
  parseStationInfoCount, parseVapSuffix,
} from "../utils/fortiapRadioSnmp.js";
import { persistApRadioInventory } from "./apRadioService.js";
import { normalizeFortiapInterfaceName, fortiapInterfaceAliases } from "../utils/fortiapInterfaceAlias.js";
import type { ApLldpNeighborSample } from "../utils/fortiapLldp.js";
import { deriveRadioBand } from "../utils/fortiapRadioBand.js";
import { resolveOidSync, ensureRegistryLoaded, type ResolveScope } from "./oidRegistry.js";
import {
  deriveDiskBytes,
  type VendorTelemetryProfile,
} from "./vendorTelemetryProfiles.js";
import { pickDbProfile, type ProfileSubject } from "./profileResolver.js";
import {
  startPassTimer,
  startWorkTimer,
  recordWorkOutcome,
  recordProbe,
  setMonitoredAssets,
  setQueueDepth,
  startSampleWriteTimer,
} from "../metrics.js";
import {
  enqueueMonitorSample,
  enqueueTelemetrySample,
  enqueueHardwareSensorSamples,
  enqueueInterfaceSamples,
  enqueueStorageSamples,
  enqueueIpsecTunnelSamples,
  enqueuePerfSlaSamples,
  enqueueProcessSamples,
  type InterfaceSampleRow,
} from "./sampleWriteBuffer.js";
import {
  classifyHardwareSensor,
  normalizeRestAlarmStatus,
  sensorTableRows,
  classifyEntitySensor,
  entityOperStatusToAlarm,
  entityTypeColumnTrusted,
  pseOperStatusToAlarm,
  unitsDisplayLooksOptical,
} from "../utils/hardwareSensors.js";
import {
  attributeSfpSensors,
  sfpSensorName,
  type EntitySensorLayoutRow,
  type SfpAttribution,
} from "../utils/sfpOptics.js";
import { poeClassLabel, poeIfNameByIndex, poeStatusLabel, poeWalkOutcome } from "../utils/poePorts.js";
import { entityPhysicalClassLabel, entityPhysicalIsInventory } from "../utils/hardwareSensors.js";
import { dot3DuplexLabel, ifStatusLabel, snmpIfTypeLabel } from "../utils/ifMib.js";
import { recordInterfaceLinkEvents } from "./interfaceLinkEventService.js";
import { basePortToIfName, fdbStatusIsUsable, fdbStatusLabel, resolveFdbIdentity, type FdbEntry } from "../utils/macForwarding.js";
import { buildArpNeighbors, arpNeighborsFromFortiosRest, type ArpNeighborEntry } from "../utils/arpNeighbors.js";
import { persistAssetArpNeighbors } from "./arpTableService.js";
import { decodePortList, derivePortVlans, isVlanId, type PortVlanConfig, type VlanMembership } from "../utils/portVlans.js";
import { matchTrunkPeer, parseTrunkPortMap, stripTrunkRoleSuffix, trunkMemberMap, type TrunkPortEntry } from "../utils/fortiswitchTrunkMap.js";
import { parseFortiosIpsec, parseFortiosSslVpn, type IpsecTunnelSample, type IpsecConnectionSample } from "../utils/fortiosIpsec.js";
import { persistIpsecConnections } from "./ipsecConnectionService.js";
import { joinStateRows } from "../utils/stateProbes.js";
import { enqueueProbePatch, getPendingProbePatch } from "./probePatchBuffer.js";
import { recoveryPollsFor, resolveDownDetection } from "./downDetectionService.js";
import { AGENT_REPORTING_STATUSES, judgeAgentSilence } from "../utils/agentSilence.js";
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
import { assetSourceKindFromIntegrationType, isFortinetIntegrationType, isWorkloadPollingMethod, responseTimeProbeShouldQueue } from "../utils/pollingCompatibility.js";
import {
  collectHardwareSensorsWorkload,
  collectSystemInfoWorkload,
  collectTelemetryWorkload,
  probeWorkload,
} from "./workloadMonitorService.js";
import { enabledWidgetIdsForAsset, assetIdsWithEnabledWidgets, widgetProfileForAsset } from "./customWidgetEnablementService.js";
import {
  collectGenericApiWidgetSamples,
  collectHardwareSensorsGenericApi,
  collectSystemInfoGenericApi,
  collectTelemetryGenericApi,
  probeGenericApi,
} from "./genericApiMonitorService.js";
import { propagateAfterStatusChange } from "./dependencyTreeService.js";
import { buildInfraParentIndex, controllerGateIdOf, type InfraParentCandidate } from "../utils/fortinetParentKey.js";
import { indexLldpHostname, pickLldpHostnameMatch, type LldpHostnameMatchIndex } from "../utils/lldpHostnameMatch.js";
import { triggerRetryAfterStatusChange } from "./reservationService.js";
import { recordIpHistoryEntries } from "./assetIpHistoryService.js";
import { DISCOVERED_ADDRESS_SOURCES } from "./assetAddressService.js";
import { snmpTicksToSeconds, formatUptimeLong } from "../utils/uptime.js";
import { pickRestApiCredential, restApiCredentialAuth, type CredentialLike } from "../utils/fortinetRestCredential.js";

// CQ-B061 — the address every stream dials (monitoring/dial.ts).
import { dial } from "./monitoring/dial.js";

// CQ-B061 — the monitor settings hierarchy + resolver (monitoring/monitorSettings.ts).
import { MonitorTierSettings, ResolvedMonitorSettings, HARDCODED_FLOOR, sysUpTimeOid, COLLECTOR_REQUEST_TIMEOUT_MS, resolveSdwanIntervalSec, PROBE_ASSET_OMIT, AssetMonitorContext, resolveMonitorSettings, loadClassOverrideStreamCredential, resolveSnmpConfigForStream, resolveAgentlessCredConfig, winrmConnFrom, loadSnmpCredentialConfigForFortinetAsset } from "./monitoring/monitorSettings.js";
export { MonitorTierSettings, ResolvedMonitorSettings, getAdMonitorProtocol, SDWAN_INTERVAL_DEFAULT_SEC, SDWAN_INTERVAL_MIN_SEC, SDWAN_INTERVAL_MAX_SEC, sdwanIntervalFromConfig, resolveSdwanIntervalSec, invalidateMonitorSettingsCache, defaultPollingForSource, PROBE_ASSET_OMIT, FleetCadences, fleetCadences, resolveMonitorSettings, resolveMonitorSettingsWithProvenance } from "./monitoring/monitorSettings.js";

// CQ-B061 — sample retention pruning (monitoring/retentionPrune.ts).
export { RETENTION_PRUNE_INTERVAL_MS, runRetentionPrune } from "./monitoring/retentionPrune.js";


export interface ProbeResult {
  success: boolean;
  /** Wall-clock duration of the probe, rounded to integer ms. */
  responseTimeMs: number;
  /** Short human-readable reason on failure; null on success. */
  error?: string;
  /**
   * Device uptime in whole seconds, when the probe transport can supply it
   * for free: SNMP sysUpTime (read as the reachability OID anyway), FortiOS
   * system status, and the Polaris Agent (host.Uptime via the responseTime
   * stream). undefined for transports that don't report it (ICMP/SSH/WinRM).
   * recordProbeResult stamps Asset.lastUptimeSec + drives reboot detection
   * (lastRebootAt + device.reboot Event) from it.
   */
  uptimeSec?: number;
  /**
   * The firmware the device reported, when the probe read it for free — today
   * only the FortiOS REST probe (`system/status` envelope `version`). Consumed
   * by probeAsset's live-version reconcile; nothing else reads it.
   */
  firmwareVersion?: string;
  /**
   * "This was not a measurement." Set when the transport could not ask the
   * thing that answers FOR the asset — today only the vCenter probe, when the
   * vCenter server itself is unreachable. `recordProbeResult` writes no sample
   * and moves no counter for a skipped probe; it only bumps `lastMonitorAt` so
   * the cadence keeps its spacing instead of retrying on every tick.
   *
   * Deliberately NOT a failure: a device behind an unreachable hypervisor
   * manager is a device Polaris has no opinion about, and counting it would
   * declare an entire virtual fleet down the moment vCenter hiccups.
   */
  skipped?: boolean;
  /**
   * "Somebody already took this reading." Set by `probeAsset` when a queued
   * probe job reaches a worker after a later job has already polled the asset
   * (see `probeStillDue`). Unlike `skipped`, this must not even stamp
   * `lastMonitorAt`: the earlier job's stamp IS the cadence anchor, and
   * overwriting it would push the next poll later for no reason. `runProbeFor`
   * returns before `recordProbeResult` when it sees this.
   */
  duplicate?: boolean;
  /**
   * "The agent should have reported by now and has not." Set by `probeAsset`
   * on an agent-mode asset whose enrolled agent has been silent past its
   * window (business rule 86, `judgeAgentSilence`). It is the ONE synthetic
   * agent-mode result `recordProbeResult` lets through: a real failed reading,
   * so the covering automation's missedPolls can call a dead host down.
   */
  agentSilent?: boolean;
  /**
   * The device's raw sysDescr, when the probe was asked to carry it.
   *
   * Only the SNMP transport can supply this, and only on the tick where
   * `Asset.lastDescrAt` says the identity read is due — it rides the GET the
   * probe was already making (one extra varbind, same packet, same session,
   * same per-host gate) rather than opening a session of its own. An
   * unreadable or absent sysDescr leaves this undefined and NEVER fails the
   * probe: the probe's job is liveness, and a device that answered sysUpTime
   * is up whatever it says about its own name.
   */
  sysDescr?: string;
}

/**
 * Slim subset of Asset columns that `recordProbeResult` needs for its
 * state-machine update. Lets the hot loop (runProbeFor) preload the asset
 * once and skip the second findUnique inside recordProbeResult.
 *
 * The type is structural — fields named the same as on the Asset model so
 * a `Prisma.AssetGetPayload<...>` row (the shape probeAsset already loads
 * with its includes) satisfies it without an explicit map step.
 */
export interface AssetMonitorSnapshot {
  id: string;
  hostname: string | null;
  assetType: string;
  monitored: boolean;
  monitorStatus: string | null;
  /** Last SNMP sysUpTime reading (whole seconds); drives reboot detection. */
  lastUptimeSec?: number | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  discoveredByIntegrationId: string | null;
  monitorIntervalSec: number | null;
  cpuMemoryIntervalSec: number | null;
  temperatureIntervalSec: number | null;
  systemInfoIntervalSec: number | null;
  probeTimeoutMs: number | null;
  /** Parent dark at load time — tags a failed probe as an explained miss. */
  dependencySuppressed?: boolean | null;
  cpuMemoryTimeoutMs?: number | null;
  temperatureTimeoutMs?: number | null;
  systemInfoTimeoutMs?: number | null;
  /** The address probed, and the polling run on it (business rule 103). */
  ipAddress?: string | null;
  ipConfirmedFor?: string | null;
  ipConfirmedSince?: Date | null;
}

/**
 * Pull only IPsec tunnels from FortiOS REST. Used when the interfaces
 * transport is "snmp" but we still want IPsec history on the System tab.
 * Best-effort: returns undefined on any failure so the SNMP-path system-info
 * still succeeds without IPsec.
 */
async function collectIpsecOnlyFortinetSafe(
  host: string,
  integration: { type: string; config: Record<string, unknown> },
  timeoutMs?: number,
  credential?: CredentialLike | null,
  opts: { includeSslVpn?: boolean } = {},
): Promise<FortiIpsecCollection | undefined> {
  try {
    const fg = buildFortinetConfig(host, integration, credential);
    if ("error" in fg) return undefined;
    return await collectIpsecFortinet(fg, timeoutMs, opts);
  } catch {
    return undefined;
  }
}

// ─── Agent silence (business rule 86) ──────────────────────────────────────
//
// The silence clock for an agent-mode asset never starts before this process
// was listening: its boot, or the last time the whole fleet was seen dark
// (Polaris could not receive, so nobody's silence counted). See
// src/utils/agentSilence.ts for the verdict itself.
let agentListeningSince = new Date();

// Freshest lastSeenAt across every agent expected to report, plus how many
// there are. One aggregate over ManagedAgent, cached briefly: a silence check
// only runs on an OVERDUE agent-mode asset, but at 2000 agents a dead site can
// make hundreds of them due in one tick, and they all ask the same question.
const AGENT_FLEET_CACHE_MS = 10_000;
let agentFleetCache: { at: number; value: { freshestLastSeenAt: Date | null; reportingAgents: number } } | null = null;

async function agentFleetLiveness(): Promise<{ freshestLastSeenAt: Date | null; reportingAgents: number }> {
  const nowMs = Date.now();
  if (agentFleetCache && nowMs - agentFleetCache.at < AGENT_FLEET_CACHE_MS) return agentFleetCache.value;
  const agg = await prisma.managedAgent.aggregate({
    where: {
      installStatus: { in: [...AGENT_REPORTING_STATUSES] },
      bearerHash: { not: null },
      bearerRevokedAt: null,
    },
    _max: { lastSeenAt: true },
    _count: { _all: true },
  });
  const value = { freshestLastSeenAt: agg._max.lastSeenAt ?? null, reportingAgents: agg._count._all };
  agentFleetCache = { at: nowMs, value };
  return value;
}

/** Test seam: reset the rule 86 process state (boot instant + fleet cache). */
export function __resetAgentSilenceStateForTests(listeningSince: Date = new Date()): void {
  agentListeningSince = listeningSince;
  agentFleetCache = null;
}

// ─── Probe entry point ──────────────────────────────────────────────────────

/**
 * Run a single probe against the asset (no DB writes — caller persists).
 * The probe always returns a result; thrown errors are caught and packaged
 * into `{ success: false, error }` so the monitor loop never aborts.
 *
 * Hot loop callers pass `out` to surface the loaded asset row to the
 * subsequent `recordProbeResult` call — that lets recordProbeResult skip
 * its own findUnique on the state-machine update path. The /probe-now
 * route doesn't bother (one operator-triggered request, savings don't
 * matter); leaves `out` undefined and pays the second read.
 *
 * `out.dueIntervalSec` is the resolved probe interval the pg-boss publisher
 * carried on the job. When set, an asset already polled since the job was
 * published returns `{ duplicate: true }` without touching the network (see
 * `probeStillDue`). The row is already loaded, so the check costs nothing.
 */
export async function probeAsset(
  assetId: string,
  out?: { snapshot?: AssetMonitorSnapshot; dueIntervalSec?: number; timeoutMs?: number },
): Promise<ProbeResult> {
  const start = performance.now();
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      omit: PROBE_ASSET_OMIT,
      include: {
        monitorCredential: true,
        responseTimeCredential: true,
        discoveredByIntegration: true,
        // Rule 86: the agent-mode branch below judges silence from these.
        managedAgent: {
          select: { installStatus: true, bearerHash: true, bearerRevokedAt: true, bearerIssuedAt: true, lastSeenAt: true },
        },
      },
    });
    if (!asset) return finish(start, false, "Asset not found");
    // Surface the loaded asset to the caller so `recordProbeResult` can
    // skip its own findUnique. The fields in `AssetMonitorSnapshot` are a
    // subset of what this `include` already pulled — no extra DB cost.
    if (out) out.snapshot = asset;
    // A job that queued behind an ACTIVE job for the same asset: that job has
    // already taken this cycle's reading. A slow probe to a dark host
    // (probeTimeoutMs ~ one 5s publisher tick) is how the second job gets queued.
    if (
      out?.dueIntervalSec !== undefined &&
      !probeStillDue(asset.lastMonitorAt, out.dueIntervalSec, new Date(), getPendingProbePatch(assetId)?.lastMonitorAt)
    ) {
      return { success: false, responseTimeMs: 0, duplicate: true };
    }
    if (!asset.monitored) return finish(start, false, "Monitoring disabled");
    const effectiveRTCred = asset.responseTimeCredential ?? asset.monitorCredential;

    // Resolve effective settings (probeTimeoutMs + responseTimePolling) through
    // the four-tier hierarchy. The resolver's source-default fallback always
    // populates responseTimePolling — fortinet → "rest_api", everything else
    // → "icmp" — so dispatch never falls through to the legacy monitorType.
    const effective = await resolveMonitorSettings({
      ...asset,
      discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
    });
    const timeoutMs = effective.probeTimeoutMs;
    // Hand it back the way the asset snapshot is handed back: the caller needs
    // it to record what a MISS cost (business rule 67), and it has already been
    // resolved here through the four-tier hierarchy. Re-resolving it at the
    // record site would be a second answer to one question.
    if (out) out.timeoutMs = timeoutMs;
    const polling   = effective.responseTimePolling;
    if (!polling) return finish(start, false, "No response-time polling method configured");

    // "Disabled" means DO NOT POLL — it is not a transport, and it is not a
    // failure. Without this branch the dispatch below falls all the way through
    // to the unknown-method error, which `recordProbeResult` then writes as a
    // failed sample that counts toward the covering automation's missedPolls —
    // turning the operator's off-switch into a manufactured outage. The
    // `skipped` contract is exactly right here for the same reason it is right
    // for an unreachable vCenter: nothing was measured, so no sample, no counter
    // movement, just the cadence anchor. The queue publishers gate on this too
    // (computeDueWork + jobs/monitorAssets.ts), so in the steady state we never
    // reach here — this stays as the correctness backstop for the
    // operator-triggered /probe-now path and for a "disabled" already sitting in
    // a JSON tier that no publisher gate can see.
    if (polling === "disabled") {
      return { success: false, responseTimeMs: 0, skipped: true };
    }

    // Agent owns its own probe cadence and pushes samples directly via
    // POST /api/v1/agents/samples. The hot monitor loop must not call out
    // to the host. While the agent is reporting, return a synthetic success
    // so the probeTotal counter increments under transport="agent" but no DB
    // write happens (recordProbeResult below early-returns for agent-mode
    // assets).
    //
    // What the agent cannot push is its own death: a dead host sends nothing,
    // so nothing ever moved its status. Business rule 86 — once an enrolled
    // agent has been silent past its window, THIS is the missed poll, returned
    // as a real failure (`agentSilent`) that recordProbeResult lets through.
    // A fleet-wide silence is Polaris failing to receive, not the hosts dying:
    // skipped (no reading), and it restarts every agent's silence clock.
    if (polling === "agent") {
      const now = new Date();
      const verdict = judgeAgentSilence({
        agent: asset.managedAgent,
        intervalSeconds: effective.intervalSeconds,
        now,
        listeningSince: agentListeningSince,
        fleet: asset.managedAgent ? await agentFleetLiveness() : { freshestLastSeenAt: null, reportingAgents: 0 },
      });
      if (verdict.kind === "fleetDark") {
        agentListeningSince = now;
        return { success: false, responseTimeMs: 0, skipped: true };
      }
      if (verdict.kind === "silent") {
        return {
          success: false,
          responseTimeMs: 0,
          agentSilent: true,
          error: `Polaris Agent has not reported since ${verdict.since.toISOString()}`,
        };
      }
      return finish(start, true);
    }

    const integration  = asset.discoveredByIntegration ?? null;
    const sourceKind   = assetSourceKindFromIntegrationType(integration?.type ?? null);
    const isFortinetSrc = isFortinetIntegrationType(sourceKind);
    const isAdSrc       = sourceKind === "activedirectory";

    // REST-API probes for managed FortiSwitches/FortiAPs query the parent
    // FortiGate's controller-status table, not the asset itself — so they
    // THE TIMER FOR THE DEVICE, taken here rather than at the top of the
    // function. `start` above is stamped before a findUnique with three
    // includes and the whole monitor-settings resolution — measured at ~4ms
    // for the query alone against a local Postgres — so every responseTimeMs
    // Polaris has ever recorded, on EVERY transport, carried a few
    // milliseconds of Polaris's own bookkeeping. The column is called
    // round-trip time and is charted as the device's latency, so that
    // overhead is simply wrong. `start` stays for the validation failures
    // below, where the number means nothing anyway.
    const dispatchStart = performance.now();

    // don't need an asset IP and dispatch before the IP guard below.
    if (
      polling === "rest_api" &&
      isFortinetSrc &&
      integration &&
      (asset.assetType === "switch" || asset.assetType === "access_point")
    ) {
      return await probeFortinetController(asset, integration as any, dispatchStart, timeoutMs);
    }

    // Asks FortiManager's own device database instead of the device. Needs no
    // asset IP (FMG is the target), so it dispatches before the IP guard —
    // which also means it reaches a gate Polaris has no route to.
    if (polling === "fortimanager") {
      if (!integration) {
        return finish(start, false, "FortiManager polling requires a FortiManager integration");
      }
      return await probeFortimanagerNative(asset, integration as any, dispatchStart);
    }

    // vCenter probes ask the vCenter SERVER about the asset, so they need no
    // asset IP at all — a VM whose guest exposes no address to Polaris, and an
    // ESXi host added to vCenter by a name that never resolved, are both still
    // probeable. Dispatches before the IP guard for exactly that reason.
    if (polling === "vcenter") {
      return await probeVcenter(assetId, dispatchStart);
    }
    // Unraid / TrueNAS: the same posture — the host's API answers for the
    // asset, so no asset IP is needed (services/workloadMonitorService.ts).
    if (isWorkloadPollingMethod(polling)) {
      return await probeWorkload(assetId, dispatchStart);
    }
    // Generic API: the integration's own response-time query answers for the
    // asset (rule 100(i)) — no asset IP needed, the workload posture.
    if (polling === "genericapi") {
      return await probeGenericApi(assetId);
    }

    // AD-discovered Windows hosts often have no IP yet (only dnsName/hostname),
    // and WinRM/SSH resolve FQDNs fine — fall back so the probe can still run
    // when the polling method is one that doesn't need an IPv4 literal. "http"
    // is in that set for a reason beyond DNS resolution: a TLS check against a
    // name is the check an operator means (the cert and any vhost routing are
    // keyed on the hostname), so a name is not merely tolerated here, it is
    // preferable when the asset has one and no IP.
    const adFallback = asset.dnsName || asset.hostname;
    const targetIp =
      dial(asset) ||
      ((polling === "winrm" || polling === "ssh") ? adFallback : null);
    if (!targetIp) return finish(start, false, "Asset has no IP address");

    if (polling === "icmp") {
      return await probeIcmp(targetIp, dispatchStart, timeoutMs);
    }
    // NOTE: there is no `polling === "http"` branch. The HTTP check was retired
    // as a polling method (2026-08) and is now a manufacturer custom widget —
    // `probeHttp` below is still the engine, but the widget collector calls it,
    // not this dispatch, and its result lands in AssetStateSample rather than
    // moving monitorStatus. See utils/pollingCompatibility.ts.
    if (polling === "rest_api") {
      // Fortinet-discovered firewalls reuse the integration's stored API token.
      // (Managed FortiSwitches/FortiAPs are dispatched earlier, above, since
      // they query the parent FortiGate rather than the asset's own IP.)
      // Manual REST API targets pull from a stored "restapi"-typed credential.
      if (isFortinetSrc && integration) {
        const result = await probeFortinet(targetIp, integration as any, dispatchStart, timeoutMs, effectiveRTCred);
        // Proxy mode only: after a successful FortiGate probe, pre-warm the
        // switch + AP controller-inventory cache so children that fire within
        // the 30 s TTL window get a free cache hit instead of a separate FMG
        // proxy call. Fire-and-forget — don't add to the FortiGate's RTT.
        // Direct mode keeps children independent (no proxy bottleneck, and
        // per-device parallelism is up to 20).
        // The running firmware rode the probe: keep Asset.osVersion current
        // between discoveries (fortinetLiveVersionService). Best-effort — an
        // identity write must never turn a successful probe into a failure.
        if (result.success && result.firmwareVersion && asset.assetType === "firewall") {
          try {
            await reconcileFortinetLiveVersions([{
              assetId: asset.id,
              hostname: asset.hostname,
              currentOsVersion: asset.osVersion,
              liveVersion: fortigateLiveVersionFor(integration.type, result.firmwareVersion),
              reader: "fortios-probe",
            }]);
          } catch (err: any) {
            logger.debug({ assetId: asset.id, err: err?.message }, "fortinet live version reconcile failed");
          }
        }
        if (
          result.success &&
          integration.type === "fortimanager" &&
          (integration.config as Record<string, unknown>).useProxy !== false &&
          asset.hostname
        ) {
          void fetchFortinetControllerInventory(integration as any, asset.hostname, "switches", timeoutMs).catch(() => {});
          void fetchFortinetControllerInventory(integration as any, asset.hostname, "aps",     timeoutMs).catch(() => {});
        }
        return result;
      }
      if (effectiveRTCred?.type === "restapi") {
        return await probeRestApiCredential(effectiveRTCred.config as Record<string, unknown>, dispatchStart, timeoutMs);
      }
      return finish(start, false, "REST API polling requires either a Fortinet integration or a REST API credential");
    }
    if (polling === "snmp") {
      // Per-stream asset credential wins, then asset default, then class-
      // override credential, then integration fallback (shared chain in
      // resolveSnmpConfigForStream). A Fortinet-lookup throw becomes a
      // probe failure with the lookup's message, as before.
      let probeCfg: Record<string, unknown>;
      try {
        const resolved = await resolveSnmpConfigForStream(effectiveRTCred, effective.responseTimeCredentialId, isFortinetSrc, integration);
        if (resolved.error !== undefined) return finish(start, false, resolved.error);
        probeCfg = resolved.cfg;
      } catch (err: any) {
        return finish(start, false, err?.message || "SNMP credential lookup failed");
      }
      const snmpRes = await probeSnmp(
        targetIp, probeCfg, dispatchStart, timeoutMs, descrReadDue(asset.lastDescrAt),
      );
      // The identity read rode this probe. Reconcile it here — the probe path
      // is the only reader that reaches an SNMP asset with no heavy stream
      // enabled, which is exactly the camera case: response time on SNMP and
      // nothing else. Best-effort by construction: an identity write must
      // never turn a successful probe into a failed one, and the anchor is
      // stamped by recordProbeResult off `result.sysDescr` regardless, so a
      // device whose blob we cannot parse is not re-read every tick.
      if (snmpRes.sysDescr) {
        const detail = parseVendorSysDescr(snmpRes.sysDescr);
        if (detail) {
          try {
            await applyDescrIdentity(asset.id, detail, snmpRes.sysDescr, asset);
          } catch (err: any) {
            logger.debug(
              { assetId: asset.id, err: err?.message },
              "sysDescr identity reconcile failed",
            );
          }
        }
      }
      return snmpRes;
    }
    if (polling === "winrm") {
      // Per-stream credential wins, then asset default, then AD bind fallback.
      if (effectiveRTCred?.type === "winrm") {
        return await probeWinRm(targetIp, effectiveRTCred.config as Record<string, unknown>, dispatchStart, timeoutMs);
      }
      if (isAdSrc && integration && adBindFallbackAllowed(asset)) {
        const cfg      = (integration.config as Record<string, unknown>) || {};
        const username = String(cfg.bindDn || "");
        const password = String(cfg.bindPassword || "");
        if (!username || !password) return finish(start, false, "Active Directory bind credentials not configured");
        return await probeWinRm(targetIp, { username, password, useHttps: true, port: 5986 }, dispatchStart, timeoutMs);
      }
      return finish(start, false, "No WinRM credential selected");
    }
    if (polling === "ssh") {
      // Per-stream credential wins, then asset default, then AD bind fallback.
      if (effectiveRTCred?.type === "ssh") {
        return await probeSsh(targetIp, effectiveRTCred.config as Record<string, unknown>, dispatchStart, timeoutMs);
      }
      if (isAdSrc && integration && adBindFallbackAllowed(asset)) {
        const cfg      = (integration.config as Record<string, unknown>) || {};
        const username = String(cfg.bindDn || "");
        const password = String(cfg.bindPassword || "");
        if (!username || !password) return finish(start, false, "Active Directory bind credentials not configured");
        return await probeSsh(targetIp, { username, password, port: 22 }, dispatchStart, timeoutMs);
      }
      return finish(start, false, "No SSH credential selected");
    }
    // RETIRED METHOD SAFETY NET. "http" was a polling method until 2026-08 and
    // is now a manufacturer custom widget. A stored value can still arrive here
    // because `assertPollingCompatible` validates WRITES only — nothing
    // re-checks what is already in the DB, and the value can sit in a JSON tier
    // (manualMonitorSettings, Integration.config per-class blocks) that no
    // migration realistically reaches. Falling through to the unknown-method
    // failure below would fail every probe on those assets, i.e. silently
    // false-down them fleet-wide. ICMP is the honest substitute: it is the
    // universal response-time fallback and gives up/down without content, which
    // is the closest thing to what the operator had configured.
    // The cast is load-bearing: `PollingMethod` no longer includes "http", so
    // the compiler is certain this branch is dead. It is not — the value comes
    // from the DATABASE, which the type system has no say over. This is exactly
    // the case where a narrowed union describes intent rather than reality.
    if ((polling as string) === "http") {
      logger.warn(
        { assetId: asset.id, hostname: asset.hostname },
        'Asset still configured for the retired "http" polling method — probing over ICMP instead. ' +
        "Re-point the Response Time stream; the HTTP check now lives on a manufacturer custom widget.",
      );
      return await probeIcmp(targetIp, dispatchStart, timeoutMs);
    }
    return finish(start, false, `Unknown polling method "${polling}"`);
  } catch (err: any) {
    return finish(start, false, err?.message || "Unknown probe error");
  }
}

function finish(startedAt: number, success: boolean, error?: string): ProbeResult {
  const ms = Math.max(0, Math.round(performance.now() - startedAt));
  return success ? { success, responseTimeMs: ms } : { success: false, responseTimeMs: ms, error };
}

// ─── Probe implementations ──────────────────────────────────────────────────

async function probeFortinet(
  host: string,
  integration: { type: string; config: Record<string, unknown> },
  start: number,
  timeoutMs: number,
  credential?: CredentialLike | null,
): Promise<ProbeResult> {
  // SNMP routing is handled by the dispatcher in probeAsset via the
  // resolved responseTimePolling field. By the time we get here the polling
  // method already resolved to "rest_api" — only Fortinet-discovered
  // firewalls hit this function.

  // Same credential/verifySsl assembly the FortiOS collectors use.
  const fgConfig = buildFortinetConfig(host, integration, credential);
  if ("error" in fgConfig) return finish(start, false, fgConfig.error);

  try {
    // /api/v2/monitor/system/status doubles as our liveness check; capture
    // the body so we can read device uptime for free instead of discarding it.
    // `envelope: true` because the running firmware (`version`) is an envelope
    // field; the uptime reader already accepts both the envelope and `results`.
    const res = await fgRequest<any>(fgConfig, "GET", "/api/v2/monitor/system/status", { timeoutMs, envelope: true });
    const ok = finish(start, true);
    const up = fortinetUptimeSecondsFromStatus(res);
    if (up !== null) ok.uptimeSec = up;
    const version = readSystemStatus(res).version;
    if (version) ok.firmwareVersion = version;
    return ok;
  } catch (err: any) {
    // Inside a 401 pause the request was never sent: not a reading, not a miss (rule 96).
    if (err instanceof FortiosAuthPausedError) return { success: false, responseTimeMs: 0, skipped: true, error: err.message };
    return finish(start, false, err?.message || "FortiOS request failed");
  }
}

/**
 * Pull device uptime (seconds) from a FortiOS /api/v2/monitor/system/status
 * response. FortiOS surfaces uptime under a few shapes across versions; we
 * probe the known candidates and treat any plain number as seconds.
 *
 * VERIFY on a real FortiOS 7.x device — confirm which field is populated and
 * its unit (compare against `get system performance status`). If system/status
 * doesn't carry uptime on the deployed version, move this capture into
 * collectTelemetryFortinet (which already calls resource/usage) instead.
 */
function fortinetUptimeSecondsFromStatus(res: any): number | null {
  if (res == null || typeof res !== "object") return null;
  const candidates = [res.uptime, res.results?.uptime, res.results?.system_uptime, res.system_uptime];
  for (const c of candidates) {
    const n = typeof c === "number" ? c : Number(c);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return null;
}

// ─── Fortinet controller-status probe (managed switches & APs) ──────────────
//
// Managed FortiSwitches and FortiAPs aren't directly REST-able — they're
// proxied through the parent FortiGate's switch-controller / wireless-
// controller subsystems. The authoritative up/down signal for them is the
// controller's `managed-switch/status` or `wifi/managed_ap` table.
//
// The probe fetches the controller's full inventory in one call and looks
// up the asset by its serial number. Multiple switches/APs on the same
// controller share one inventory call within a short TTL window so the
// probe rate stays bounded by controller-count, not device-count — important
// for FMG proxy mode (concurrency = 1).

interface FortinetControllerEntry {
  /** True when the controller reports this device as currently online. */
  connected: boolean;
  /** Raw status string the controller reported, surfaced in failure errors. */
  status: string;
  /**
   * For `kind="aps"` rows only: telemetry snapshot parsed off the same
   * managed_ap row. Lets the AP telemetry + temperature collectors reuse
   * the controller-cache fetch instead of issuing their own /wifi/managed_ap
   * call. Undefined on switches and on AP rows where FortiOS didn't return
   * the relevant fields.
   */
  apTelemetry?: import("../utils/fortiapMonitorRow.js").FortiapTelemetrySnapshot;
  /**
   * The firmware the device is running, as the controller reports it — the
   * same `os_version` string discovery stores on the fortiswitch / fortiap
   * source, so the live-version reconcile (fortinetLinkStateService →
   * fortinetLiveVersionService) compares like with like. Undefined when the
   * row carried no usable version.
   */
  osVersion?: string;
}

export interface FortinetControllerFetchResult {
  inventory: Map<string, FortinetControllerEntry>;
  /**
   * Wall-clock duration of the upstream call that produced this inventory.
   * Reported as the RTT for every probe that consumes this result — the
   * fresh fetcher, every concurrent in-flight waiter, and every cache hit
   * within the TTL window — so all switches/APs under one parent FortiGate
   * show a consistent RTT instead of the lead-worker eating ~650 ms while
   * its peers report a misleading ~2 ms (the in-process cache-lookup time).
   */
  fetchDurationMs: number;
}

interface FortinetControllerCacheEntry {
  fetchedAt: number;
  fetchDurationMs: number;
  inventory: Map<string, FortinetControllerEntry>;
}

const FORTINET_CONTROLLER_CACHE_TTL_MS = 30_000;
const fortinetControllerCache = new Map<string, FortinetControllerCacheEntry>();

// Cache of (integrationId::deviceName) → management IP for the parent FortiGate.
// Populated from Asset.ipAddress (set during discovery) so the probe path
// never needs to hit FMG's CMDB just to learn an IP we already know. TTL is
// intentionally long — management IPs change only when the operator
// reconfigures the device, and a stale entry self-heals on the next discovery
// run which re-stamps Asset.ipAddress. Falls back to resolveDeviceMgmtIpViaFmg
// only when the FortiGate asset hasn't been discovered yet or has no IP set.
const CONTROLLER_MGMT_IP_CACHE_TTL_MS = 5 * 60_000; // 5 minutes
interface ControllerMgmtIpEntry { ip: string; cachedAt: number; }
const controllerMgmtIpCache = new Map<string, ControllerMgmtIpEntry>();

/** Exported for tests (rule 111): where a managed switch's / AP's controller token is sent. */
export async function resolveControllerMgmtIp(
  integrationId: string,
  deviceName: string,
  fmgConfig: FortiManagerConfig,
): Promise<string | null> {
  const cacheKey = `${integrationId}::${deviceName}`;
  const cached = controllerMgmtIpCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CONTROLLER_MGMT_IP_CACHE_TTL_MS) {
    return cached.ip;
  }

  // Primary: look up the FortiGate's already-discovered Asset.ipAddress.
  // This is the same IP that discovery resolved via resolveDeviceMgmtIpViaFmg
  // and stamped on the asset — no need to hit FMG again. Use case-insensitive
  // hostname matching because FortiOS device names can be stored in different
  // case than what ends up in the topology blob's controllerFortigate field.
  // Only a firewall THIS integration manages: the answer is where the
  // integration's FortiGate token is sent, so a hand-made "firewall" asset
  // with a matching name must never qualify (rule 111). A gate whose
  // discoveredByIntegrationId was cleared (integration delete + recreate)
  // falls through to the FMG CMDB lookup below instead.
  const fgAsset = await prisma.asset.findFirst({
    where: {
      hostname: { equals: deviceName, mode: "insensitive" },
      assetType: "firewall",
      discoveredByIntegrationId: integrationId,
    },
    select: { ipAddress: true },
  });
  if (fgAsset?.ipAddress) {
    controllerMgmtIpCache.set(cacheKey, { ip: fgAsset.ipAddress, cachedAt: Date.now() });
    return fgAsset.ipAddress;
  }

  // Fallback: FortiGate not yet discovered as an asset (or has no IP stamped).
  // Hit FMG CMDB the old way so fresh installs and edge cases still work.
  const ip = await resolveDeviceMgmtIpViaFmg(fmgConfig, deviceName, undefined, integrationId);
  if (ip) {
    controllerMgmtIpCache.set(cacheKey, { ip, cachedAt: Date.now() });
  }
  return ip;
}

// Coalesce concurrent inventory fetches against the same controller. Without
// this, every worker that wakes up on the same 60s tick races past the
// cache-miss check and fires its own fmgProxyRest call — N workers × 1
// upstream request, hammering FMG (which drops parallel sessions above
// ~1–2 in the reference deployment, surfacing as code -11 = "permission
// denied / session limit"). The promise-singleton pattern below funnels N
// concurrent callers into one upstream call; the cache then absorbs
// follow-on calls within the 30 s TTL.
const inflightControllerFetch = new Map<string, Promise<FortinetControllerFetchResult>>();

function controllerCacheKey(integrationId: string, deviceName: string, kind: "switches" | "aps"): string {
  return `${integrationId}::${deviceName}::${kind}`;
}

/**
 * Fetch a FortiOS REST path from a controller FortiGate through whichever
 * transport the integration prescribes. One home for the dispatch the three
 * controller fetchers (inventory / wifi clients / switch-ports CMDB) each
 * carried a private copy of until the 2026-08 audit:
 *
 *  - fortimanager + useProxy=false → STRICT bypass: direct REST against the
 *    device's mgmt IP (resolveControllerMgmtIp). Polaris never silently
 *    falls back to proxy — if the direct path can't be assembled (missing
 *    token / mgmt interface / unresolvable mgmt IP) the call fails with a
 *    precondition-specific error so the operator sees what's misconfigured.
 *    A silent fallback would turn "I disabled proxy" into "…except when
 *    something else is wrong, in which case it re-enables itself and
 *    overruns FMG's parallel-session limit."
 *  - fortimanager (proxy, default) → /sys/proxy/json via fmgProxyRest, with
 *    an AbortController-backed timeout.
 *  - fortigate → direct REST with the integration's own config.
 *
 * `label` names the caller in the unsupported-type error.
 */
async function fetchViaFortinetTransport(
  integration: { id: string; type: string; config: Record<string, unknown> },
  deviceName: string,
  path: string,
  timeoutMs: number,
  label: string,
): Promise<unknown> {
  if (integration.type === "fortimanager") {
    const fmgConfig = integration.config as unknown as FortiManagerConfig;
    if (fmgConfig.useProxy === false) {
      if (!fmgConfig.fortigateApiToken) {
        throw new AppError(
          409,
          "Direct mode is enabled (useProxy=false) but no FortiGate API token is configured on the integration. " +
          "Set fortigateApiToken on the integration's Settings tab, or re-enable proxy mode.",
        );
      }
      if (!fmgConfig.mgmtInterface?.trim()) {
        throw new AppError(
          409,
          "Direct mode is enabled (useProxy=false) but mgmtInterface is empty. " +
          "Set the FortiGate management interface name (e.g. \"mgmt\", \"port1\") on the integration's Settings tab.",
        );
      }
      const mgmtIp = await resolveControllerMgmtIp(integration.id, deviceName, fmgConfig);
      if (!mgmtIp) {
        throw new AppError(
          502,
          `Direct mode: could not resolve ${deviceName}'s management IP ` +
          `(not found in Polaris asset inventory or FMG CMDB interface "${fmgConfig.mgmtInterface || "mgmt"}").`,
        );
      }
      const directConfig: FortiGateConfig = {
        host: mgmtIp,
        port: 443,
        apiUser: fmgConfig.fortigateApiUser || "",
        apiToken: fmgConfig.fortigateApiToken,
        verifySsl: fmgConfig.fortigateVerifySsl === true,
      };
      return fgRequest<unknown>(directConfig, "GET", path, { timeoutMs });
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fmgProxyRest<unknown>(fmgConfig, deviceName, "GET", path, { signal: ac.signal, integrationId: integration.id });
    } finally {
      clearTimeout(timer);
    }
  }
  if (integration.type === "fortigate") {
    return fgRequest<unknown>(integration.config as unknown as FortiGateConfig, "GET", path, { timeoutMs });
  }
  throw new AppError(500, `Unsupported integration type for ${label}: ${integration.type}`);
}

/** FortiOS responses arrive either as a bare array or `{ results: [...] }`. */
function unwrapFortiosRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  return Array.isArray((raw as any)?.results) ? (raw as any).results : [];
}

/**
 * Exported for `fortinetLinkStateService`, which sweeps the same two
 * controller tables for every FortiGate-managed switch/AP — not just the ones
 * whose `responseTimePolling` resolves to `rest_api`. Sharing this function
 * (rather than the service issuing its own call) is what lets the sweep ride
 * the probe path's reads where both are running: they land on the same 30s
 * cache entry whenever their independent 60s timers fall in one window, which
 * is some of the time, not all of it. The point is the CEILING either way —
 * two calls per controller per tick regardless of how many devices hang off
 * it.
 *
 * Keep the cache module-local to monitoringService: a second cache in the
 * other service would double the upstream rate it exists to bound.
 */
export async function fetchFortinetControllerInventory(
  integration: { id: string; type: string; config: Record<string, unknown> },
  deviceName: string,
  kind: "switches" | "aps",
  timeoutMs: number,
): Promise<FortinetControllerFetchResult> {
  const cacheKey = controllerCacheKey(integration.id, deviceName, kind);
  const cached = fortinetControllerCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < FORTINET_CONTROLLER_CACHE_TTL_MS) {
    return { inventory: cached.inventory, fetchDurationMs: cached.fetchDurationMs };
  }
  // If another worker already kicked off the fetch for this controller +
  // kind, wait on its promise instead of firing our own. Critical at scale
  // — the alternative is N concurrent upstream calls per controller per
  // 60s tick. In proxy mode that hits FMG's parallel-session limit (code
  // -11 "invalid or expired API token"); in direct mode it hits the
  // FortiGate's REST-admin session limit (token lockouts). The promise-
  // singleton below funnels N concurrent callers into one outbound call
  // regardless of mode; the 30s cache absorbs follow-on calls.
  const inflight = inflightControllerFetch.get(cacheKey);
  if (inflight) return inflight;

  const fetchPromise = (async (): Promise<FortinetControllerFetchResult> => {
    const fetchStartedAt = performance.now();
    try {
      const path = kind === "switches"
        ? "/api/v2/monitor/switch-controller/managed-switch/status"
        : "/api/v2/monitor/wifi/managed_ap";
      const rawRows = await fetchViaFortinetTransport(integration, deviceName, path, timeoutMs, "Fortinet controller probe");
      const rows = unwrapFortiosRows(rawRows);
      const inventory = new Map<string, FortinetControllerEntry>();
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        const serial = String(r.serial || r.sn || r.wtp_id || "").trim();
        if (!serial) continue;
        const status = String(r.status || r.state || "");
        const connected = kind === "switches"
          // Managed switch reports `status: "Connected" | "Disconnected"`.
          ? status === "Connected"
          // Managed APs report `status: "online" | "offline" | "discovered" | ...`
          // — only "online"/"connected" count as up.
          : (status === "online" || status === "connected");
        const entry: FortinetControllerEntry = { connected, status };
        // APs: os_version is live; the cached version/firmware_version fields
        // lag upgrades and are trusted only in the canonical shape — the same
        // pick parseFortiapMonitorRow makes for discovery.
        const osVersion = kind === "switches"
          ? String(r.os_version || "").trim()
          : (String(r.os_version || "").trim()
              || [String(r.version || ""), String(r.firmware_version || "")].find(isCanonicalFortiapVersion)
              || "");
        if (osVersion) entry.osVersion = osVersion;
        if (kind === "aps") {
          // Parse the AP-row telemetry snapshot once at fetch time so the
          // cache absorbs both probe + telemetry + temperature consumers.
          const snap = parseFortiapTelemetrySnapshot(r);
          if (snap.cpuPct !== undefined || snap.memTotalMb !== undefined || snap.sensorTemperatures) {
            entry.apTelemetry = snap;
          }
        }
        inventory.set(serial.toUpperCase(), entry);
      }

      const fetchDurationMs = Math.max(0, Math.round(performance.now() - fetchStartedAt));
      fortinetControllerCache.set(cacheKey, { fetchedAt: Date.now(), fetchDurationMs, inventory });
      return { inventory, fetchDurationMs };
    } finally {
      // Always clear the inflight entry — successful fetches are now in the
      // cache; failed fetches need a clean slate so the next call can retry
      // without waiting on a rejected promise.
      inflightControllerFetch.delete(cacheKey);
    }
  })();

  inflightControllerFetch.set(cacheKey, fetchPromise);
  return fetchPromise;
}

// ─── vCenter warm caches ───────────────────────────────────────────────────
//
// The "vcenter" polling method reads a monitored VM's or ESXi host's state
// from the vCenter SERVER rather than from the device itself: ONE batched SOAP
// fetch per vCenter integration per 30s tick serves every asset that
// integration discovered, so the per-asset cost is a Map lookup. Two caches,
// because the two managed-object types are two different property fetches:
//
//   VirtualMachine → fetchVcenterQuickStats     CPU/RAM, power state, uptime,
//                                               guest filesystems, guest vNICs
//   HostSystem     → fetchVcenterHostSnapshot   CPU/RAM, connection state,
//                                               uptime, pNICs + VMkernel NICs,
//                                               and the datastore inventory a
//                                               host's storage figures come from
//
// Both follow the controller-inventory cache pattern above (TTL +
// promise-singleton in-flight guard, so N workers waking on the same tick
// coalesce into one upstream call). Entries are keyed by the SAME externalId
// forms the AssetSource rows carry.
//
// WHY THE VM CACHE IS KEYED TWICE: the sync writes `instanceUuid` when the
// detail call produced one and `${integrationId}:${moref}` when it didn't, so
// both forms have to hit.

interface VcenterQuickStatsCacheEntry {
  fetchedAt: number;
  fetchDurationMs: number;
  stats: Map<string, import("./vcenterService.js").VcenterVmQuickStats>;
}

// ─── FortiManager roster warm cache ────────────────────────────────────────
//
// Backs the "fortimanager" polling method: one NATIVE /dvmdb/adom/<adom>/device
// read per integration per tick, serving every gate that integration manages.
// Same TTL + promise-singleton shape as the controller-inventory and vCenter
// caches above, and for the same reason — without the in-flight guard, N
// workers waking on one 60s tick would each fire their own upstream call.
//
// Native reads are NOT in FMG's /sys/proxy/json concurrency-1 lane, so this is
// genuinely cheap: ~187 gates cost one request rather than 187 serialized ones.
interface FmgRosterCacheEntry {
  fetchedAt: number;
  fetchDurationMs: number;
  /** Upper-cased serial → the chassis's reachability as FMG understands it. */
  bySerial: Map<string, RosterDeviceStatus>;
}

const FMG_ROSTER_CACHE_TTL_MS = 30_000;
const fmgRosterCache = new Map<string, FmgRosterCacheEntry>();
const inflightFmgRoster = new Map<string, Promise<FmgRosterCacheEntry>>();

async function fetchFmgRosterCached(
  integration: { id: string; config: Record<string, unknown> },
): Promise<FmgRosterCacheEntry> {
  const cached = fmgRosterCache.get(integration.id);
  if (cached && Date.now() - cached.fetchedAt < FMG_ROSTER_CACHE_TTL_MS) return cached;
  const inflight = inflightFmgRoster.get(integration.id);
  if (inflight) return inflight;

  const p = (async (): Promise<FmgRosterCacheEntry> => {
    const startedAt = performance.now();
    try {
      const rows = await fetchRosterConnectivity(
        integration.config as unknown as FortiManagerConfig,
        undefined,
        integration.id,
      );
      const bySerial = new Map<string, RosterDeviceStatus>();
      // A cluster primary appears at the top level AND inside ha_slave[]. The
      // ha_slave row is the per-member one, so let it win — it is what carries
      // a standby's own state, and for the primary the two agree.
      for (const r of rows) {
        const prev = bySerial.get(r.serial);
        if (!prev || (!prev.haMember && r.haMember)) bySerial.set(r.serial, r);
      }
      const entry: FmgRosterCacheEntry = {
        fetchedAt: Date.now(),
        fetchDurationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        bySerial,
      };
      fmgRosterCache.set(integration.id, entry);
      return entry;
    } finally {
      inflightFmgRoster.delete(integration.id);
    }
  })();

  inflightFmgRoster.set(integration.id, p);
  return p;
}

/**
 * Response-time probe that asks FortiManager rather than the device.
 *
 * Needs no asset IP — dispatched before the IP guard in probeAsset, like the
 * controller and vCenter probes — and identifies the chassis by SERIAL. Never
 * by name: `fortinetTopology.deviceName` is FMG's device name, which is known
 * to diverge from the gate's configured hostname on real fleets (the trap
 * utils/fortinetParentKey.ts exists for), and a name mismatch here would read
 * as "gone from FortiManager".
 *
 * FMG unreachable ⇒ SKIPPED, not failed. Identical reasoning to the vCenter
 * probe (business rule 30): the thing that answers for the device is not the
 * device, so one FortiManager outage must never declare a whole fleet down at
 * the same instant. A gate that FMG answers about and reports disconnected IS
 * a real failure.
 *
 * Carries no uptime — FMG's roster has none — so this method drives no reboot
 * detection. That is called out in the matrix header.
 */
async function probeFortimanagerNative(
  asset: { serialNumber: string | null; hostname: string | null },
  integration: { id: string; type: string; config: Record<string, unknown> },
  start: number,
): Promise<ProbeResult> {
  if (integration.type !== "fortimanager") {
    return finish(start, false, "FortiManager polling requires a FortiManager integration");
  }
  const serial = (asset.serialNumber || "").trim().toUpperCase();
  if (!serial) {
    return finish(start, false, "Cannot poll via FortiManager — asset has no serial number recorded");
  }

  let entry: FmgRosterCacheEntry;
  try {
    entry = await fetchFmgRosterCached(integration);
  } catch (err: any) {
    // Could not ASK. Not a measurement, so not a miss.
    return { success: false, responseTimeMs: 0, skipped: true, error: err?.message || "FortiManager roster query failed" };
  }

  const row = entry.bySerial.get(serial);
  if (!row) {
    return {
      success: false,
      responseTimeMs: entry.fetchDurationMs,
      error: "Not present in FortiManager's device roster",
    };
  }
  if (!row.connected) {
    return {
      success: false,
      responseTimeMs: entry.fetchDurationMs,
      error: `FortiManager reports the device disconnected (${row.raw})`,
    };
  }
  // The RTT is the shared upstream call's duration, not a measurement of the
  // device — the same honesty the controller and vCenter probes apply.
  return { success: true, responseTimeMs: entry.fetchDurationMs };
}

interface VcenterHostCacheEntry {
  fetchedAt: number;
  fetchDurationMs: number;
  hosts: Map<string, import("./vcenterService.js").VcenterHostStats>;
  /** Datastores mounted by each host moref — the host's storage stream. */
  datastoresByHostMoref: Map<string, import("./vcenterService.js").DiscoveredVcenterDatastore[]>;
}

const VCENTER_QUICKSTATS_CACHE_TTL_MS = 30_000;
const vcenterQuickStatsCache = new Map<string, VcenterQuickStatsCacheEntry>();
const inflightVcenterQuickStats = new Map<string, Promise<VcenterQuickStatsCacheEntry>>();
const vcenterHostCache = new Map<string, VcenterHostCacheEntry>();
const inflightVcenterHost = new Map<string, Promise<VcenterHostCacheEntry>>();

async function fetchVcenterQuickStatsCached(
  integration: { id: string; config: Record<string, unknown> },
): Promise<VcenterQuickStatsCacheEntry> {
  const cached = vcenterQuickStatsCache.get(integration.id);
  if (cached && Date.now() - cached.fetchedAt < VCENTER_QUICKSTATS_CACHE_TTL_MS) {
    return cached;
  }
  const inflight = inflightVcenterQuickStats.get(integration.id);
  if (inflight) return inflight;

  const fetchPromise = (async (): Promise<VcenterQuickStatsCacheEntry> => {
    const fetchStartedAt = performance.now();
    try {
      const rows = await fetchVcenterQuickStats(
        integration.config as unknown as import("./vcenterService.js").VcenterConfig,
        undefined,
        // The monitoring cache is the one caller that wants per-core CPU;
        // discovery reads none of those columns and must not pay for a
        // QueryPerf over the whole vCenter to fill them.
        { withPerCoreCpu: true },
      );
      const stats = new Map<string, import("./vcenterService.js").VcenterVmQuickStats>();
      for (const row of rows) {
        if (row.instanceUuid) stats.set(row.instanceUuid, row);
        stats.set(`${integration.id}:${row.moref}`, row);
      }
      const entry: VcenterQuickStatsCacheEntry = {
        fetchedAt: Date.now(),
        fetchDurationMs: Math.max(0, Math.round(performance.now() - fetchStartedAt)),
        stats,
      };
      vcenterQuickStatsCache.set(integration.id, entry);
      return entry;
    } finally {
      inflightVcenterQuickStats.delete(integration.id);
    }
  })();

  inflightVcenterQuickStats.set(integration.id, fetchPromise);
  return fetchPromise;
}

async function fetchVcenterHostSnapshotCached(
  integration: { id: string; config: Record<string, unknown> },
): Promise<VcenterHostCacheEntry> {
  const cached = vcenterHostCache.get(integration.id);
  if (cached && Date.now() - cached.fetchedAt < VCENTER_QUICKSTATS_CACHE_TTL_MS) {
    return cached;
  }
  const inflight = inflightVcenterHost.get(integration.id);
  if (inflight) return inflight;

  const fetchPromise = (async (): Promise<VcenterHostCacheEntry> => {
    const fetchStartedAt = performance.now();
    try {
      const snap = await fetchVcenterHostSnapshot(
        integration.config as unknown as import("./vcenterService.js").VcenterConfig,
        undefined,
        { withPerCoreCpu: true },
      );
      // The snapshot reports its two halves separately (discovery needs the
      // datastore half even when host properties are refused). For monitoring
      // the host half IS the reading, so a failure there has to THROW rather
      // than cache an empty map — an empty map would read as "this host left
      // the inventory", which fails the probe. Thrown, it becomes
      // `unreachable` in readVcenterAsset, which skips instead.
      if (snap.hostError) throw new AppError(502, snap.hostError);
      const hosts = new Map<string, import("./vcenterService.js").VcenterHostStats>();
      for (const h of snap.hosts) hosts.set(`${integration.id}:${h.moref}`, h);
      const datastoresByHostMoref = new Map<string, import("./vcenterService.js").DiscoveredVcenterDatastore[]>();
      for (const ds of snap.datastores) {
        for (const hostMoref of ds.hostMorefs) {
          const list = datastoresByHostMoref.get(hostMoref);
          if (list) list.push(ds);
          else datastoresByHostMoref.set(hostMoref, [ds]);
        }
      }
      const entry: VcenterHostCacheEntry = {
        fetchedAt: Date.now(),
        fetchDurationMs: Math.max(0, Math.round(performance.now() - fetchStartedAt)),
        hosts,
        datastoresByHostMoref,
      };
      vcenterHostCache.set(integration.id, entry);
      return entry;
    } finally {
      inflightVcenterHost.delete(integration.id);
    }
  })();

  inflightVcenterHost.set(integration.id, fetchPromise);
  return fetchPromise;
}

/**
 * One asset's current reading from vCenter, whatever role it plays.
 *
 * The four outcomes are deliberately distinct because the PROBE treats them
 * differently, and that distinction is the whole safety story for making
 * "vcenter" the response-time default:
 *
 *   vm / host   — vCenter answered ABOUT this asset. Its own fields decide
 *                 up/down.
 *   absent      — vCenter answered, and this asset was not in the answer (VM
 *                 deleted at source, or the polling method is configured on an
 *                 asset that carries no vCenter source). A real finding: the
 *                 probe FAILS and says why.
 *   unreachable — Polaris could not ask (vCenter down, credential rejected,
 *                 integration disabled). That is a fact about vCenter, not
 *                 about the device, so the probe is SKIPPED rather than
 *                 counted: one vCenter outage must not declare every VM and
 *                 host in the fleet down at the same instant.
 */
export type VcenterReading =
  | { kind: "vm"; row: import("./vcenterService.js").VcenterVmQuickStats; fetchDurationMs: number }
  | {
      kind: "host";
      row: import("./vcenterService.js").VcenterHostStats;
      datastores: import("./vcenterService.js").DiscoveredVcenterDatastore[];
      fetchDurationMs: number;
    }
  | { kind: "absent"; error: string }
  | { kind: "unreachable"; error: string };

/**
 * Resolve an asset's vCenter reading through its AssetSource row — NOT through
 * discoveredByIntegration, because a VM that AD/Entra discovered first keeps
 * the directory integration there even after a vCenter sync merges into it.
 */
async function readVcenterAsset(assetId: string): Promise<VcenterReading> {
  const source = await prisma.assetSource.findFirst({
    where: { assetId, sourceKind: { in: ["vcenter-vm", "vcenter-host"] } },
    select: {
      externalId: true,
      sourceKind: true,
      integration: { select: { id: true, type: true, config: true, enabled: true } },
    },
    // A vcenter-vm row wins if an asset somehow carries both.
    orderBy: { sourceKind: "asc" },
  });
  if (!source) {
    return { kind: "absent", error: "vCenter polling requires a vCenter-discovered VM or ESXi host (no vCenter source on file)" };
  }
  if (!source.integration || source.integration.type !== "vcenter") {
    return { kind: "absent", error: "The asset's vCenter source is not linked to a vCenter integration" };
  }
  if (source.integration.enabled === false) {
    return { kind: "unreachable", error: "The linked vCenter integration is disabled" };
  }
  const integration = { id: source.integration.id, config: (source.integration.config ?? {}) as Record<string, unknown> };

  if (source.sourceKind === "vcenter-vm") {
    let entry: VcenterQuickStatsCacheEntry;
    try {
      entry = await fetchVcenterQuickStatsCached(integration);
    } catch (err: any) {
      return { kind: "unreachable", error: err?.message || "vCenter quickStats fetch failed" };
    }
    const row = entry.stats.get(source.externalId);
    if (!row) return { kind: "absent", error: "VM not present in the vCenter inventory (removed or renamed?)" };
    return { kind: "vm", row, fetchDurationMs: entry.fetchDurationMs };
  }

  let entry: VcenterHostCacheEntry;
  try {
    entry = await fetchVcenterHostSnapshotCached(integration);
  } catch (err: any) {
    return { kind: "unreachable", error: err?.message || "vCenter host property fetch failed" };
  }
  const row = entry.hosts.get(source.externalId);
  if (!row) return { kind: "absent", error: "ESXi host not present in the vCenter inventory (removed from vCenter?)" };
  return { kind: "host", row, datastores: entry.datastoresByHostMoref.get(row.moref) ?? [], fetchDurationMs: entry.fetchDurationMs };
}

/** vCenter's own word for "powered on", across the REST (upper-snake) and SOAP (camel) spellings. */
function vcenterPoweredOn(state: string | null): boolean {
  return state === "poweredOn" || state === "POWERED_ON";
}

/**
 * Response-time probe against the vCenter server's view of the asset.
 *
 * The RTT reported is the UPSTREAM fetch duration — the vCenter round trip
 * shared by every asset on that integration this tick, not a measurement of
 * the device. It is charted as a response time because it is the latency of
 * the thing actually being asked; an operator wanting the guest's own network
 * latency points the Response Time stream at ICMP instead.
 */
async function probeVcenter(assetId: string, start: number): Promise<ProbeResult> {
  const reading = await readVcenterAsset(assetId);
  if (reading.kind === "unreachable") {
    // Not a measurement. See the VcenterReading doc comment.
    logger.debug({ assetId, reason: reading.error }, "vCenter probe skipped — could not reach vCenter");
    return { success: false, responseTimeMs: 0, skipped: true, error: reading.error };
  }
  if (reading.kind === "absent") {
    return { success: false, responseTimeMs: Math.max(0, Math.round(performance.now() - start)), error: reading.error };
  }
  if (reading.kind === "vm") {
    // A VM's power state IS the whole signal. Absent (rather than "poweredOff")
    // means the property did not come back, which is no reading — never a down
    // verdict pinned on a VM that is probably running.
    if (reading.row.powerState === null) {
      return { success: false, responseTimeMs: 0, skipped: true, error: "vCenter reported no power state for this VM" };
    }
    if (!vcenterPoweredOn(reading.row.powerState)) {
      return { success: false, responseTimeMs: reading.fetchDurationMs, error: `VM is ${reading.row.powerState}` };
    }
    const ok: ProbeResult = { success: true, responseTimeMs: reading.fetchDurationMs };
    if (reading.row.uptimeSec !== null) ok.uptimeSec = reading.row.uptimeSec;
    return ok;
  }
  const state = reading.row.connectionState;
  if (state !== "connected") {
    return { success: false, responseTimeMs: reading.fetchDurationMs, error: `ESXi host is ${state || "not connected"} in vCenter` };
  }
  // A host has a SECOND independent signal, so an absent power state is not a
  // gap: vCenter said the host is connected, which it could not do about a
  // host that is off. Only an explicit non-poweredOn value fails here.
  if (reading.row.powerState !== null && !vcenterPoweredOn(reading.row.powerState)) {
    return { success: false, responseTimeMs: reading.fetchDurationMs, error: `ESXi host is ${reading.row.powerState}` };
  }
  const ok: ProbeResult = { success: true, responseTimeMs: reading.fetchDurationMs };
  if (reading.row.uptimeSec !== null) ok.uptimeSec = reading.row.uptimeSec;
  return ok;
}

/**
 * Hypervisor-view CPU/RAM telemetry for a vCenter VM or ESXi host. Reads the
 * warm cache, so the per-asset cost is a Map lookup.
 *
 * A VM reports GUEST memory usage (what the guest thinks it is using) against
 * its configured RAM; a host reports consumed host memory against installed
 * RAM. Both are absolute bytes — the UI derives the percentage.
 */
async function collectTelemetryVcenter(assetId: string): Promise<CollectionResult<TelemetrySample>> {
  const reading = await readVcenterAsset(assetId);
  if (reading.kind === "absent" || reading.kind === "unreachable") {
    return { supported: true, error: reading.error };
  }
  const MIB = 1024 * 1024;
  if (reading.kind === "vm") {
    const row = reading.row;
    if (!vcenterPoweredOn(row.powerState)) {
      return { supported: true, error: `VM is not powered on (${row.powerState})` };
    }
    const cpuPct =
      row.cpuUsageMhz !== null && row.cpuMaxMhz !== null && row.cpuMaxMhz > 0
        ? Math.min(100, Math.max(0, (row.cpuUsageMhz / row.cpuMaxMhz) * 100))
        : null;
    return {
      supported: true,
      data: {
        cpuPct,
        // Absolute bytes — the UI prefers bytes and derives mem% downstream.
        memUsedBytes:  row.guestMemUsageMB !== null ? row.guestMemUsageMB * MIB : null,
        memTotalBytes: row.memTotalMB      !== null ? row.memTotalMB * MIB      : null,
        cpuCorePcts: row.cpuCorePcts,
        // The guest's configured RAM as the hypervisor is backing it. A VM
        // sets no `memConsumedBytes` — that band is the host's, and a row
        // carrying both would stack the same memory under two names.
        memPrivateBytes:    row.memPrivateBytes,
        memSharedBytes:     row.memSharedBytes,
        memBalloonedBytes:  row.memBalloonedBytes,
        memSwappedBytes:    row.memSwappedBytes,
        memCompressedBytes: row.memCompressedBytes,
      },
    };
  }
  const host = reading.row;
  if (host.connectionState !== "connected") {
    return { supported: true, error: `ESXi host is ${host.connectionState || "not connected"} in vCenter` };
  }
  const cpuPct =
    host.cpuUsageMhz !== null && host.cpuTotalMhz !== null && host.cpuTotalMhz > 0
      ? Math.min(100, Math.max(0, (host.cpuUsageMhz / host.cpuTotalMhz) * 100))
      : null;
  return {
    supported: true,
    data: {
      cpuPct,
      memUsedBytes:  host.memUsageBytes,
      memTotalBytes: host.memTotalBytes,
      cpuCorePcts: host.cpuCorePcts,
      // Installed RAM as ESXi is spending it. `consumed` mirrors
      // memUsedBytes deliberately: memUsedBytes is the aggregate every
      // threshold and automation reads, and the band is the same quantity
      // taking its place in a stack. Private/shared/compressed are a VM's
      // bands and stay null here.
      memConsumedBytes:  host.memUsageBytes,
      memBalloonedBytes: host.memBalloonedBytes,
      memSwappedBytes:   host.memSwappedBytes,
    },
  };
}

/**
 * Interfaces + storage for a vCenter-polled asset, from the same warm cache.
 *
 * The null-vs-empty contract from vcenterService is load-bearing here. A VM
 * whose Tools are absent reports `guestDisks: null` / `guestNics: null`, which
 * becomes an EMPTY array — and `recordSystemInfoResult` skips an empty
 * interface list rather than wiping the inventory, exactly as it does for a
 * FortiOS token that answered 200 with no results. Storage is a time series,
 * so an empty list simply records nothing for this tick.
 *
 * ESXi interface semantics:
 *   pNIC — `speedMb` is present only while the link is UP; ESXi omits
 *          linkSpeed on a down port, which is what operStatus reads.
 *   vmk  — a VMkernel port rides a portgroup, not an uplink, so it publishes
 *          no link state of its own. operStatus stays null rather than
 *          claiming "up".
 */
export function buildVcenterSystemInfo(reading: VcenterReading): SystemInfoSample {
  const interfaces: InterfaceSample[] = [];
  const storage: StorageSample[] = [];

  if (reading.kind === "vm") {
    for (const nic of reading.row.guestNics ?? []) {
      interfaces.push({
        ifName:     nic.label,
        operStatus: nic.connected === null ? null : nic.connected ? "up" : "down",
        macAddress: nic.macAddress,
        ipAddress:  nic.ipAddress,
        ipv6Address: nic.ipv6Address,
      });
    }
    for (const fs of reading.row.guestDisks ?? []) {
      storage.push({
        mountPath:  fs.path,
        totalBytes: fs.capacityBytes,
        usedBytes:  fs.capacityBytes !== null && fs.freeBytes !== null ? fs.capacityBytes - fs.freeBytes : null,
      });
    }
    return { interfaces, storage };
  }

  if (reading.kind === "host") {
    // Virtual networking becomes the PARENT layer over the physical ports,
    // reusing exactly the shape a FortiSwitch trunk already draws
    // (`ifType: "aggregate"` + `ifParent` on the members — see
    // overlayFortiswitchTrunkMembers). The System tab's interface table nests
    // on `ifParent` with no changes: a vSwitch collapses to show its uplinks
    // and VMkernel ports beneath it.
    //
    // Uplinks are matched by DEVICE NAME, which is why the parsers read
    // `spec.bridge.nicDevice` / `spec.backing.pnicSpec[].pnicDevice` rather
    // than the `pnic[]` key arrays — the keys would need a mapping table and
    // the names join directly.
    const vswitches = reading.row.vswitches ?? [];
    const uplinkParent = new Map<string, string>();
    for (const vsw of vswitches) {
      for (const uplink of vsw.uplinks) {
        if (!uplinkParent.has(uplink)) uplinkParent.set(uplink, vsw.name);
      }
    }
    // A VMkernel port rides a PORT GROUP, and the port group names both its
    // vSwitch and its VLAN — so one name-to-name join gives a vmk both its
    // parent and the VLAN tag it actually sits on. (`vmk.portgroup` is the
    // port group NAME as the host publishes it, so no MoRef plumbing.)
    const pgByName = new Map<string, import("./vcenterService.js").VcenterHostPortgroup>();
    for (const pg of reading.row.portgroups ?? []) pgByName.set(pg.name, pg);

    const pnicUp = new Map<string, boolean>();
    for (const pnic of reading.row.pnics ?? []) {
      const up = pnic.speedMb !== null;
      pnicUp.set(pnic.device, up);
      interfaces.push({
        ifName:     pnic.device,
        operStatus: up ? "up" : "down",
        speedBps:   pnic.speedMb !== null ? pnic.speedMb * 1_000_000 : null,
        // linkSpeed carries speed and duplex together, so both are absent on a
        // down link and duplex needs no separate gate.
        duplex:     up && pnic.duplex !== null ? (pnic.duplex ? "full" : "half") : null,
        macAddress: pnic.macAddress,
        ifType:     "physical",
        ifParent:   uplinkParent.get(pnic.device) ?? null,
      });
    }
    for (const vmk of reading.row.vnics ?? []) {
      const pg = vmk.portgroup ? pgByName.get(vmk.portgroup) : undefined;
      interfaces.push({
        ifName:      vmk.device,
        macAddress:  vmk.macAddress,
        ipAddress:   vmk.ipAddress,
        ipv6Address: vmk.ipv6Address,
        // A vmk publishes no link state of its own — see the note above the
        // function — so operStatus stays absent rather than claiming "up".
        vlanId:      pg?.vlanId ?? null,
        ifParent:    pg?.vswitchName ?? null,
      });
    }
    // Synthesize the switch rows LAST so the uplink states above are known.
    // A vSwitch's own state is derived: it is up while any uplink is up, down
    // when every uplink is dark, and NULL when it has no uplinks at all —
    // an internal-only vSwitch is working exactly as configured and must not
    // read as an outage.
    for (const vsw of vswitches) {
      const known = vsw.uplinks.filter((u) => pnicUp.has(u));
      interfaces.push({
        ifName:     vsw.name,
        ifType:     "aggregate",
        operStatus: known.length === 0 ? null : known.some((u) => pnicUp.get(u)) ? "up" : "down",
        // Deliberately no speedBps: vCenter publishes no aggregate rate, and
        // summing live uplinks would invent a figure the source never stated.
      });
    }
    // A host's storage is the datastores it has mounted. Host-local volumes
    // backing no datastore (the ESXi boot bank) are not reported — nothing
    // acts on their free space.
    //
    // A SHARED datastore is therefore reported once per host that mounts it,
    // with the same numbers. That is deliberate: "how full is the storage this
    // host is running on" is the question being asked, and answering it only
    // on whichever host happened to be listed first would make the tab lie on
    // every other host. The cost is that a fleet-wide rule on a full shared
    // datastore fires once per mounting host — scope such a rule to one host,
    // or read the datastore table on the Virtualization section, which is
    // per-datastore by construction.
    for (const ds of reading.datastores) {
      storage.push({
        mountPath:  ds.name,
        totalBytes: ds.capacityBytes,
        usedBytes:  ds.capacityBytes !== null && ds.freeBytes !== null ? ds.capacityBytes - ds.freeBytes : null,
      });
    }
    return { interfaces, storage };
  }

  return { interfaces, storage };
}

/**
 * System-info (interfaces + storage) for a vCenter-polled asset. Each stream is
 * gated on its OWN resolved polling method, matching the independence rule the
 * SNMP path already follows.
 */
async function collectSystemInfoVcenter(
  assetId: string,
  effective: { interfacesPolling: string | null; storagePolling: string | null },
): Promise<CollectionResult<SystemInfoSample>> {
  const reading = await readVcenterAsset(assetId);
  if (reading.kind === "absent" || reading.kind === "unreachable") {
    return { supported: true, error: reading.error };
  }
  const data = buildVcenterSystemInfo(reading);
  if (effective.interfacesPolling !== "vcenter") data.interfaces = [];
  if (effective.storagePolling    !== "vcenter") data.storage = [];
  return { supported: true, data };
}

// ─── Wireless-station signal overlay ──────────────────────────────────────
//
// The SNMP fapStationTable carries no per-client RSSI — signal/noise live only
// on the WiFi controller (FortiGate), exposed at /api/v2/monitor/wifi/client.
// One call returns every client on the controller, so we cache it per
// (integration, controller) with the same 30s TTL + inflight-coalescing the
// inventory fetcher uses and let every AP on that controller share it. At 2000
// assets this is one REST call per controller per scrape window, not one per
// AP. Best-effort: any failure leaves signal/noise null and the SNMP-sourced
// station rows persist unchanged. Stations are matched by normalized client
// MAC (a client associates to one AP at a time, so MAC alone scopes correctly).

interface WifiClientSignal {
  signalStrength: number | null;
  noise: number | null;
}
// normalized client MAC (colon-uppercase) → signal
type WifiClientSignalMap = Map<string, WifiClientSignal>;

interface WifiClientCacheEntry {
  fetchedAt: number;
  clients: WifiClientSignalMap;
}

const fortinetWifiClientCache = new Map<string, WifiClientCacheEntry>();
const inflightWifiClientFetch = new Map<string, Promise<WifiClientSignalMap>>();

function wifiClientCacheKey(integrationId: string, deviceName: string): string {
  return `${integrationId}::${deviceName}::wifi-clients`;
}

function wifiClientNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

async function fetchFortinetWifiClients(
  integration: { id: string; type: string; config: Record<string, unknown> },
  deviceName: string,
  timeoutMs: number,
): Promise<WifiClientSignalMap> {
  const cacheKey = wifiClientCacheKey(integration.id, deviceName);
  const cached = fortinetWifiClientCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < FORTINET_CONTROLLER_CACHE_TTL_MS) {
    return cached.clients;
  }
  const inflight = inflightWifiClientFetch.get(cacheKey);
  if (inflight) return inflight;

  const fetchPromise = (async (): Promise<WifiClientSignalMap> => {
    try {
      const path = "/api/v2/monitor/wifi/client";
      const rawRows = await fetchViaFortinetTransport(integration, deviceName, path, timeoutMs, "wifi/client fetch");
      const rows = unwrapFortiosRows(rawRows);
      const clients: WifiClientSignalMap = new Map();
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        const macRaw = String(r.mac ?? r.sta_mac ?? r.station_mac ?? "").trim();
        if (!macRaw) continue;
        const mac = macRaw.toUpperCase().replace(/-/g, ":");
        if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) continue;
        clients.set(mac, {
          signalStrength: wifiClientNum(r.signal ?? r.signal_strength ?? r.rssi),
          noise:          wifiClientNum(r.noise),
        });
      }

      fortinetWifiClientCache.set(cacheKey, { fetchedAt: Date.now(), clients });
      return clients;
    } finally {
      inflightWifiClientFetch.delete(cacheKey);
    }
  })();

  inflightWifiClientFetch.set(cacheKey, fetchPromise);
  return fetchPromise;
}

// ─── FortiSwitch port VLAN overlay ────────────────────────────────────────
//
// Managed FortiSwitches expose interface counters via SNMP IF-MIB, but the
// per-port VLAN config (native PVID + tagged allow-list) lives only on the
// parent FortiGate's CMDB at /api/v2/cmdb/switch-controller/managed-switch.
// Read per controller as: the switch list (serials only), each switch's
// `ports` child table with only the parsed attributes, and the gate's VLAN
// interfaces (name → id). Cached per (integration, controller) with the same
// 30s TTL the inventory fetcher uses. Best-effort — overlay failures never
// break the interface scrape. SNMP-monitored non-Fortinet switches don't get
// VLAN data here (they get Q-BRIDGE-MIB, collectPortVlansSnmp).

// Per-switch view of the controller's managed-switch CMDB: per-port VLAN
// config plus the trunk → physical-member-ports map. The trunk map is the
// authoritative equivalent of the FortiSwitch's own `config switch trunk`
// (auto-ISL FortiLink uplinks are auto-named after the switch serial and
// carry exactly one member); the controller exposes it on the same payload
// the VLAN overlay already reads, so it costs no extra query.
interface FortiswitchSwitchPorts {
  // portName → vlan config
  vlanByPort: Map<string, FortiswitchPortVlan>;
  // trunkName → physical member port names (in CMDB order)
  trunkMembers: Map<string, string[]>;
  // MCLAG ICL legs to the peer switch (one per local mclag-icl-port). Empty on
  // switches not in an MCLAG pair. Read from the same payload the VLAN/trunk
  // maps already parse, so it costs no extra query.
  mclagPeers: FortiswitchMclagPeer[];
  // portName → operator-set port description from the controller CMDB. SNMP
  // IF-MIB has no equivalent, so this overlay is the only way switch-port
  // rows get a discovered `description` (display fallback for interface
  // comments + the read side of description sync). Same free payload.
  descriptionByPort: Map<string, string>;
}

// switchSerialUpper → per-switch ports view
type FortiswitchControllerPortsMap = Map<string, FortiswitchSwitchPorts>;

interface FortiswitchControllerPortsCacheEntry {
  fetchedAt: number;
  ports: FortiswitchControllerPortsMap;
}

const fortiswitchControllerPortsCache = new Map<string, FortiswitchControllerPortsCacheEntry>();
const inflightFortiswitchPortsFetch = new Map<string, Promise<FortiswitchControllerPortsMap>>();

function fortiswitchPortsCacheKey(integrationId: string, deviceName: string): string {
  return `${integrationId}::${deviceName}::fsw-ports`;
}

// VLAN parsing (names → ids, ranges, the "all" sentinel) lives in
// utils/fortiswitchCmdb.ts → parseFortiswitchPortVlan.

/**
 * Turn the per-switch reads into the per-switch ports view. Pure, exported for
 * tests: `switches` are the managed-switch rows (serial keys only), `portsBySwitchId`
 * each switch's `ports` child table, keyed by its `switch-id`, and
 * `vlanIdByName` the controller's VLAN interfaces (fortiosVlanIdByName). A
 * switch whose ports read failed is absent from `portsBySwitchId` and is left
 * out of the result, as a switch with no `ports` always was.
 */
export function buildFortiswitchControllerPortsMap(
  switches: unknown[],
  portsBySwitchId: ReadonlyMap<string, unknown[]>,
  vlanIdByName: ReadonlyMap<string, number>,
): FortiswitchControllerPortsMap {
  const map: FortiswitchControllerPortsMap = new Map();
  for (const row of switches) {
    const r = (row ?? {}) as Record<string, unknown>;
    const serial = String(r.sn || r["switch-id"] || r.name || "").trim();
    const portsRaw = portsBySwitchId.get(String(r["switch-id"] ?? ""));
    if (!serial || !Array.isArray(portsRaw)) continue;
    const portMap = new Map<string, FortiswitchPortVlan>();
    for (const p of portsRaw) {
      const portName = String((p as Record<string, unknown>)?.["port-name"] ?? "").trim();
      if (!portName) continue;
      portMap.set(portName, parseFortiswitchPortVlan(p, vlanIdByName));
    }
    // Trunk → physical-member map: operator LACP bundles (`members`) +
    // FortiLink auto-ISL uplinks (`isl-local-trunk-name` on each physical
    // member). The interface overlay uses this to back-fill ifParent so
    // the topology renderer swaps the opaque trunk name for the real
    // physical port. See buildFortiswitchTrunkMembers. (The child read lists
    // trunk rows first rather than last; physical ports keep their order, and
    // the ISL members are physical ports, so the map is unchanged.)
    const trunkMembers = buildFortiswitchTrunkMembers(portsRaw);
    const mclagPeers = parseFortiswitchMclagPeers(portsRaw);
    const descriptionByPort = parseFortiswitchPortDescriptions(portsRaw);
    map.set(serial.toUpperCase(), { vlanByPort: portMap, trunkMembers, mclagPeers, descriptionByPort });
  }
  return map;
}

async function fetchFortiswitchControllerPortsCmdb(
  integration: { id: string; type: string; config: Record<string, unknown> },
  deviceName: string,
  timeoutMs: number,
): Promise<FortiswitchControllerPortsMap> {
  const cacheKey = fortiswitchPortsCacheKey(integration.id, deviceName);
  const cached = fortiswitchControllerPortsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < FORTINET_CONTROLLER_CACHE_TTL_MS) {
    return cached.ports;
  }
  const inflight = inflightFortiswitchPortsFetch.get(cacheKey);
  if (inflight) return inflight;

  const fetchPromise = (async (): Promise<FortiswitchControllerPortsMap> => {
    try {
      // Three reads instead of one whole-table read (HUB1-a, two 48-port
      // switches: 342 KB → 57 KB, faster too). `format=` cannot reach inside
      // the parent's `ports` (~106 attributes a port); addressing each
      // switch's `ports` child table lets it. No `datasource=1`: on a
      // FortiLink switch it expands nothing — the VLAN fields are interface
      // NAMES with or without it — so the names are resolved here instead.
      //   1. the switch list, serial keys only (throws as the old read did);
      const switchRows = unwrapFortiosRows(await fetchViaFortinetTransport(
        integration, deviceName, "/api/v2/cmdb/switch-controller/managed-switch?format=switch-id|sn|name",
        timeoutMs, "FortiSwitch CMDB list fetch"));
      //   2. each switch's ports, only the attributes the parsers read — a
      //      failed switch is left out rather than failing the controller;
      //   3. the gate's VLAN interfaces, name → id (best-effort: without it
      //      only numeric VLAN references resolve, as before).
      const [portsBySwitchId, vlanIdByName] = await Promise.all([
        Promise.all(switchRows.map(async (row) => {
          const id = String((row as Record<string, unknown>)?.["switch-id"] ?? "").trim();
          if (!id) return null;
          try {
            const raw = await fetchViaFortinetTransport(integration, deviceName,
              `/api/v2/cmdb/switch-controller/managed-switch/${encodeURIComponent(id)}/ports?format=${FORTISWITCH_MONITOR_PORT_FORMAT}`,
              timeoutMs, "FortiSwitch CMDB ports fetch");
            return [id, unwrapFortiosRows(raw)] as const;
          } catch (err) {
            logger.debug({ err, deviceName, switchId: id }, "FortiSwitch ports read failed — that switch gets no CMDB overlay this pass");
            return null;
          }
        })).then((pairs) => new Map(pairs.filter((p): p is readonly [string, unknown[]] => p !== null))),
        fetchViaFortinetTransport(integration, deviceName, "/api/v2/cmdb/system/interface?format=name|vlanid",
          timeoutMs, "FortiGate VLAN interface fetch")
          .then((raw) => fortiosVlanIdByName(unwrapFortiosRows(raw)))
          .catch(() => new Map<string, number>()),
      ]);
      const map = buildFortiswitchControllerPortsMap(switchRows, portsBySwitchId, vlanIdByName);

      fortiswitchControllerPortsCache.set(cacheKey, { fetchedAt: Date.now(), ports: map });
      return map;
    } finally {
      inflightFortiswitchPortsFetch.delete(cacheKey);
    }
  })();

  inflightFortiswitchPortsFetch.set(cacheKey, fetchPromise);
  return fetchPromise;
}

/**
 * Back-fill the trunk → physical-member relationship onto a managed
 * FortiSwitch's interface list, mirroring what `collectSystemInfoFortinet`
 * already does for FortiGate aggregates (the `set members "portN"` back-fill).
 *
 * SNMP IF-MIB surfaces the FortiLink uplink trunk and its physical member as
 * flat, unrelated rows — the parent/member edge lives outside it, in the
 * controller CMDB or the `fsTrunkMember` scalar. Both feed this one overlay so
 * they cannot disagree about what a member row looks like. For each trunk we:
 *   - mark the trunk row `ifType="aggregate"` (only when SNMP left it null or
 *     guessed "physical" — never clobber a real aggregate type)
 *   - stamp `ifParent=<trunk>` + `ifType="physical"` on each member row.
 *
 * `synthesizeMissing` decides what happens to a member the interface list has
 * no row for, and the two sources genuinely differ. The CMDB describes ports
 * IF-MIB may not have returned at all, so it synthesizes the row (the
 * FortiGate-aggregate back-fill does the same). The scalar comes out of the
 * SAME walk as the interface list, so a member missing from it means the walk
 * named its ports something else — `ifName` failed and `ifDescr` (the
 * operator's port DESCRIPTION on a FortiSwitch) stood in. Synthesizing then
 * invents a second identity for a port already in the list under its label,
 * in the one table that IS the identity of record for interface names, so that
 * caller passes false and back-fills only.
 *
 * Downstream, `interfaceTopologyService.preferPhysical` and the controller-
 * edge swap in `map.ts` render a single-member trunk as its physical port
 * (e.g. the serial-named FortiLink uplink → `port52`). Multi-member LACP
 * bundles keep the trunk name (no single physical port to show).
 *
 * A trunk row the walk named with a role suffix (`1CD11A4549B7-0(primary)`,
 * see `stripTrunkRoleSuffix`) is RENAMED to the trunk's own name. Otherwise
 * the members point at a parent no row carries, so the System tab lists them
 * flat and the topology layer cannot resolve the trunk to its port; and the
 * suffix keeps the name out of every other place that names trunks (the
 * peer-serial inference, FortiLink trunk preservation). Only a row whose
 * stripped name the trunk map itself lists is renamed.
 *
 * Mutates `interfaces` in place; returns the number of member links stamped.
 */
export function overlayFortiswitchTrunkMembers(
  interfaces: InterfaceSample[],
  trunkMembers: Map<string, string[]>,
  opts: { synthesizeMissing?: boolean } = {},
): number {
  if (trunkMembers.size === 0) return 0;
  const byName = new Map<string, InterfaceSample>();
  for (const i of interfaces) byName.set(i.ifName, i);
  const suffixedByBase = new Map<string, InterfaceSample>();
  for (const i of interfaces) {
    const base = stripTrunkRoleSuffix(i.ifName);
    if (base !== i.ifName && !suffixedByBase.has(base)) suffixedByBase.set(base, i);
  }
  let links = 0;
  for (const [trunkName, members] of trunkMembers) {
    if (members.length === 0) continue;
    let trunkRow = byName.get(trunkName);
    if (!trunkRow) {
      const suffixed = suffixedByBase.get(trunkName);
      if (suffixed) {
        const oldName = suffixed.ifName;
        suffixed.ifName = trunkName;
        byName.delete(oldName);
        byName.set(trunkName, suffixed);
        // A VLAN or member already parented on the suffixed name follows it.
        for (const i of interfaces) if (i.ifParent === oldName) i.ifParent = trunkName;
        trunkRow = suffixed;
      }
    }
    if (trunkRow && (!trunkRow.ifType || trunkRow.ifType === "physical")) {
      trunkRow.ifType = "aggregate";
    }
    for (const memberName of members) {
      const existing = byName.get(memberName);
      if (existing) {
        if (!existing.ifParent) existing.ifParent = trunkName;
        if (!existing.ifType) existing.ifType = "physical";
      } else if (opts.synthesizeMissing !== false) {
        const synthetic: InterfaceSample = {
          ifName:   memberName,
          ifType:   "physical",
          ifParent: trunkName,
        };
        interfaces.push(synthetic);
        byName.set(memberName, synthetic);
      } else {
        continue; // unknown member port — see synthesizeMissing above
      }
      links++;
    }
  }
  return links;
}

async function probeFortinetController(
  asset: {
    id: string;
    assetType: string;
    serialNumber: string | null;
    fortinetTopology: unknown;
  },
  integration: { id: string; type: string; config: Record<string, unknown> },
  start: number,
  timeoutMs: number,
): Promise<ProbeResult> {
  const serial = (asset.serialNumber || "").trim();
  if (!serial) {
    return finish(start, false, "Cannot probe via REST API — asset has no serial number recorded");
  }

  const topology = (asset.fortinetTopology ?? {}) as Record<string, unknown>;
  let deviceName = typeof topology.controllerFortigate === "string" ? topology.controllerFortigate.trim() : "";
  // For standalone FortiGate integrations, the FortiGate IS the controller —
  // the integration's own host is the right target regardless of what's
  // recorded on the asset's topology blob.
  if (!deviceName && integration.type === "fortigate") {
    const cfg = integration.config as Record<string, unknown>;
    deviceName = String(cfg.host || "");
  }
  if (!deviceName) {
    return finish(start, false, "Cannot probe via REST API — asset has no controller FortiGate recorded");
  }

  const kind: "switches" | "aps" = asset.assetType === "access_point" ? "aps" : "switches";

  try {
    // Report the upstream controller call's duration as the asset's RTT —
    // not the locally-measured elapsed time from `start`. The cache + in-
    // flight coalescing means the worker servicing this asset may have done
    // either a fresh upstream call (~hundreds of ms over FMG/FortiOS REST),
    // a wait on a peer worker's in-flight call (same), or a pure cache hit
    // (sub-ms). Showing the local elapsed time produced jarringly different
    // RTTs across switches/APs sharing one parent FortiGate (e.g. 650 ms
    // for the lead worker, 2 ms for its peers). Surfacing the real upstream
    // duration on every consumer keeps RTT consistent across the fleet and
    // accurately reflects what FortiOS took to answer.
    const { inventory, fetchDurationMs } = await fetchFortinetControllerInventory(
      integration,
      deviceName,
      kind,
      timeoutMs,
    );
    const entry = inventory.get(serial.toUpperCase());
    if (!entry) {
      const label = kind === "switches" ? "managed-switch" : "managed-AP";
      return { success: false, responseTimeMs: fetchDurationMs, error: `Not present in ${deviceName}'s ${label} table` };
    }
    if (entry.connected) {
      return { success: true, responseTimeMs: fetchDurationMs };
    }
    const role = kind === "switches" ? "switch" : "AP";
    return {
      success: false,
      responseTimeMs: fetchDurationMs,
      error: `Controller reports ${role} status: ${entry.status || "Disconnected"}`,
    };
  } catch (err: any) {
    // The controller gate is inside a 401 pause, so nobody asked it. Counting
    // that as a miss would mark every switch / AP behind it down at once (rule 96).
    if (err instanceof FortiosAuthPausedError) return { success: false, responseTimeMs: 0, skipped: true, error: err.message };
    // Precondition failures and upstream errors don't have a meaningful
    // upstream duration; fall back to local elapsed time so the operator
    // still sees how long the failure took.
    return finish(start, false, err?.message || "Controller query failed");
  }
}

/**
 * REST-based CPU/memory collector for managed FortiAPs. The AP itself
 * isn't directly REST-able (no FortiOS REST server on the AP), so we
 * piggyback on the parent FortiGate's /api/v2/monitor/wifi/managed_ap
 * response — it carries `cpu_usage`, `mem_free`, and `mem_total` per
 * AP row. fetchFortinetControllerInventory has already parsed the
 * snapshot into entry.apTelemetry on the controller-cache hit path,
 * so all we do here is fetch (cache or upstream) and project the
 * snapshot into the TelemetrySample shape.
 *
 * Memory: FortiAP reports `mem_free` / `mem_total` in MB. We convert
 * to bytes for the AssetTelemetrySample columns and compute memUsedBytes
 * = (total − free) × 1024 × 1024. memPct is left null since the bytes
 * form is more useful for charts (a 256-MB AP at 90% looks the same as
 * a 1-GB AP at 90% otherwise).
 */
async function collectTelemetryFortiapRest(
  asset: { id: string; serialNumber: string | null; fortinetTopology: unknown },
  integration: { id: string; type: string; config: Record<string, unknown> },
  timeoutMs: number,
): Promise<CollectionResult<TelemetrySample>> {
  const serial = (asset.serialNumber || "").trim();
  if (!serial) return { supported: true, error: "FortiAP has no serial number recorded" };

  const topology = (asset.fortinetTopology ?? {}) as Record<string, unknown>;
  let deviceName = typeof topology.controllerFortigate === "string" ? topology.controllerFortigate.trim() : "";
  if (!deviceName && integration.type === "fortigate") {
    deviceName = String((integration.config as Record<string, unknown>).host || "");
  }
  if (!deviceName) return { supported: true, error: "FortiAP has no controller FortiGate recorded" };

  try {
    const { inventory } = await fetchFortinetControllerInventory(integration, deviceName, "aps", timeoutMs);
    const entry = inventory.get(serial.toUpperCase());
    if (!entry) return { supported: true, error: `FortiAP not present in ${deviceName}'s managed-AP table` };
    const snap = entry.apTelemetry;
    if (!snap) {
      // Controller returned the AP row but with no cpu/mem fields — older
      // FortiOS or feature-licensed install. Caller surfaces this as a
      // collected-with-no-data condition rather than an outright failure.
      return { supported: true, data: { cpuPct: null, memPct: null, memUsedBytes: null, memTotalBytes: null } };
    }
    const memTotalBytes = snap.memTotalMb !== undefined ? snap.memTotalMb * 1024 * 1024 : null;
    const memFreeBytes  = snap.memFreeMb  !== undefined ? snap.memFreeMb  * 1024 * 1024 : null;
    const memUsedBytes  = (memTotalBytes !== null && memFreeBytes !== null) ? memTotalBytes - memFreeBytes : null;
    return {
      supported: true,
      data: {
        cpuPct:        snap.cpuPct ?? null,
        memPct:        null,
        memUsedBytes,
        memTotalBytes,
      },
    };
  } catch (err: any) {
    return { supported: true, error: err?.message || "FortiAP controller query failed" };
  }
}

/**
 * REST-based temperature collector for managed FortiAPs. Same controller-
 * cache as collectTelemetryFortiapRest — `sensors_temperatures` is parsed
 * off the same managed_ap row into entry.apTelemetry.sensorTemperatures.
 */
async function collectHardwareSensorsFortiapRest(
  asset: { id: string; serialNumber: string | null; fortinetTopology: unknown },
  integration: { id: string; type: string; config: Record<string, unknown> },
  timeoutMs: number,
): Promise<CollectionResult<HardwareSensorSample[]>> {
  const serial = (asset.serialNumber || "").trim();
  if (!serial) return { supported: true, error: "FortiAP has no serial number recorded" };

  const topology = (asset.fortinetTopology ?? {}) as Record<string, unknown>;
  let deviceName = typeof topology.controllerFortigate === "string" ? topology.controllerFortigate.trim() : "";
  if (!deviceName && integration.type === "fortigate") {
    deviceName = String((integration.config as Record<string, unknown>).host || "");
  }
  if (!deviceName) return { supported: true, error: "FortiAP has no controller FortiGate recorded" };

  try {
    const { inventory } = await fetchFortinetControllerInventory(integration, deviceName, "aps", timeoutMs);
    const entry = inventory.get(serial.toUpperCase());
    if (!entry) return { supported: true, error: `FortiAP not present in ${deviceName}'s managed-AP table` };
    const sensors = entry.apTelemetry?.sensorTemperatures;
    if (!sensors || sensors.length === 0) {
      // No sensor fields on the row — FortiAP model that doesn't publish
      // temperatures (older indoor models). Return an empty data array so
      // the System tab shows "no sensors" rather than an error.
      return { supported: true, data: [] };
    }
    // The controller cache only exposes temperature sensors for FortiAPs.
    return {
      supported: true,
      data: sensors.map((s) => ({
        sensorName:  s.name,
        sensorClass: "temperature",
        value:       s.celsius,
        unit:        "°C",
        alarmStatus: null,
      })),
    };
  } catch (err: any) {
    return { supported: true, error: err?.message || "FortiAP controller query failed" };
  }
}

/**
 * ONE ICMP echo, reporting the round trip `ping` ITSELF measured rather than
 * the wall clock around the call.
 *
 * Wall clock here is dominated by process spawn, not by the network: 20
 * sequential single-echo pings at 127.0.0.1 measured 36ms each on Windows
 * against a reported RTT of <1ms. A LAN device with a 0.2ms round trip cannot
 * chart as 0.2ms if the number includes a fork+exec.
 *
 * The codebase already knew this in one place and drew the opposite
 * conclusion: the loss sampler wrote responseTimeMs NULL because "we spawn
 * the system ping, so the measured time is dominated by process spawn and is
 * not an RTT worth recording". True of the wall clock; not true of the figure
 * ping prints, which is the actual round trip. So we parse it out instead of
 * discarding it.
 *
 * Falls back to the wall clock when the summary carried no timing — a total
 * loss has no RTT, and a failed probe's duration is at least a real bound.
 */
async function probeIcmp(host: string, start: number, timeoutMs: number): Promise<ProbeResult> {
  const r = await burstPingHost(host, { count: 1, intervalMs: 200, timeoutMs });
  // sent === 0 means we never reached the network (no ping binary): not a
  // measurement, and not the device's fault.
  if (r.sent === 0) return finish(start, false, "ping unavailable");
  const success = r.received > 0;
  if (success && r.avgRttMs != null) {
    return { success: true, responseTimeMs: Math.max(0, Math.round(r.avgRttMs)) };
  }
  return finish(start, success, success ? undefined : "no echo reply");
}

function mapSnmpAuthProtocol(value: unknown): unknown {
  switch (value) {
    case "MD5":    return snmp.AuthProtocols.md5;
    case "SHA":    return snmp.AuthProtocols.sha;
    case "SHA224": return snmp.AuthProtocols.sha224;
    case "SHA256": return snmp.AuthProtocols.sha256;
    case "SHA384": return snmp.AuthProtocols.sha384;
    case "SHA512": return snmp.AuthProtocols.sha512;
    default: throw new AppError(400, `Unsupported SNMP v3 authProtocol "${String(value)}"`);
  }
}

function mapSnmpPrivProtocol(value: unknown): unknown {
  switch (value) {
    case "DES":     return snmp.PrivProtocols.des;
    case "AES":     return snmp.PrivProtocols.aes;
    case "AES256B": return snmp.PrivProtocols.aes256b;
    case "AES256R": return snmp.PrivProtocols.aes256r;
    default: throw new AppError(400, `Unsupported SNMP v3 privProtocol "${String(value)}"`);
  }
}

// Per-handler verbose-phase tracing. AsyncLocalStorage stashes the asset /
// cadence / verbose flag once at the cadence handler entry; every
// `startPhase(...)` call inside the async chain reads it without needing
// the flag plumbed through every collector signature. Used to diagnose
// where time goes inside a systemInfo handler that gets killed at the
// 300s pg-boss expireInSeconds cap — flip `verboseLogging` on the asset's
// originating integration and the next burst leaves a paper trail of which
// phase took 300s.
//
// `verbose: false` (the default) makes `startPhase` a no-op closure — zero
// per-tick allocation when the flag is off.
interface MonitorPhaseContext {
  assetId: string;
  cadence: "probe" | "telemetry" | "systemInfo" | "fastFiltered";
  verbose: boolean;
}
const monitorPhaseStorage = new AsyncLocalStorage<MonitorPhaseContext>();

/**
 * Open a phase span. Returns a closer that emits one `monitor.phase` log
 * with elapsed ms + any extras when called. No-op when verbose is off.
 *
 * Always pair `startPhase` with calling the returned closer in a finally
 * block so partial completion (throws mid-phase) still emits.
 */
function startPhase(name: string): (extras?: Record<string, unknown>) => void {
  const ctx = monitorPhaseStorage.getStore();
  if (!ctx?.verbose) return () => {};
  const startedAt = Date.now();
  const { assetId, cadence } = ctx;
  return (extras?: Record<string, unknown>) => {
    logger.info(
      { verbose: true, phase: name, assetId, cadence, elapsedMs: Date.now() - startedAt, ...(extras ?? {}) },
      "monitor.phase",
    );
  };
}

// Per-SNMP-target serialization gate. Many switch/AP SNMP agents are
// single-threaded — a heavy walk (IF-MIB + LLDP + storage) running in
// parallel with a cheap sysUpTime probe pins the agent's request queue
// and stretches the probe's response time from <50ms to several seconds,
// occasionally past the probe timeout (reads as "packet loss"). All
// SNMP entry points (probeSnmp / collectTelemetrySnmp / collectSystemInfoSnmp)
// run through `withSnmpGate(host, port, ...)` so probe, telemetry,
// systemInfo, and fastFiltered SNMP calls FIFO-serialize against the
// same agent within this Polaris process. FortiOS REST and FMG calls
// have their own concurrency models and aren't routed through this gate.
//
// Each waiter has a bounded wait via SNMP_GATE_WAIT_TIMEOUT_MS — when the
// currently-running collector wedges (e.g. 60s net-snmp timeout on a dead
// host), queued callers fail fast with a clear error instead of all
// waiting the full upstream duration. The wedged collector still holds
// its own slot until it returns; the timeout only bounds wait time for
// callers behind it. Default 30s — enough headroom for a legitimate
// heavy + telemetry back-to-back (~20s with default tier-3 timeouts),
// short enough to surface a hang.
type SnmpGateSlot = {
  fn: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  enqueuedAt: number;
  timer: NodeJS.Timeout | null;
  timedOut: boolean;
};
const snmpQueues = new Map<string, SnmpGateSlot[]>();
const snmpRunning = new Set<string>();

// Read per-call so tests can inject a small value via process.env without
// having to re-import the module (which is awkward inside a single-file test
// suite). Cost is negligible: one Number() coercion per gate entry, dwarfed
// by the upstream net-snmp call this serializes.
function snmpGateWaitTimeoutMs(): number {
  const raw = Number(process.env.POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

function processNextSnmpSlot(key: string): void {
  if (snmpRunning.has(key)) return;
  const queue = snmpQueues.get(key);
  if (!queue || queue.length === 0) {
    snmpQueues.delete(key);
    return;
  }
  // Skip past any slots that timed out while waiting; their rejection
  // already fired, but their queue entry remains until we drain it here.
  let slot: SnmpGateSlot | undefined;
  while ((slot = queue.shift())) {
    if (!slot.timedOut) break;
  }
  if (!slot || slot.timedOut) {
    snmpQueues.delete(key);
    return;
  }
  if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
  snmpRunning.add(key);
  const waitMs = Date.now() - slot.enqueuedAt;
  if (waitMs > 5000) {
    logger.warn({ host: key, waitMs }, "SNMP gate wait > 5s");
  }
  // Phase tracing for the current handler. Captures the wait portion
  // separately from the fn() runtime so the operator can tell at a
  // glance whether the time was spent queued (= upstream walk holding
  // the agent) or actively walking (= this asset's SNMP agent slow).
  const endPhase = startPhase("snmp.gate_wait");
  endPhase({ host: key, waitMs });
  // INTENTIONAL .then() chain — this is the per-host SNMP serialization gate's
  // slot runner: run fn(), settle the caller's promise, then release the gate
  // and pull the next queued slot. Do NOT rewrite to an async IIFE; the
  // run→settle→process-next ordering is the gate's contract.
  Promise.resolve()
    .then(() => slot.fn())
    .then(slot.resolve, slot.reject)
    .finally(() => {
      snmpRunning.delete(key);
      processNextSnmpSlot(key);
    });
}

// `waitTimeoutMs` overrides the env-derived gate wait for this one caller.
// Used by the operator snmp-walk path, whose deadline is the walk tab's
// 60s client countdown rather than the collectors' fail-fast budget.
export async function withSnmpGate<T>(host: string, port: number, fn: () => Promise<T>, waitTimeoutMs?: number): Promise<T> {
  const key = `${host}:${port}`;
  return new Promise<T>((resolve, reject) => {
    const slot: SnmpGateSlot = {
      fn: fn as () => Promise<unknown>,
      resolve: resolve as (v: unknown) => void,
      reject,
      enqueuedAt: Date.now(),
      timer: null,
      timedOut: false,
    };
    const timeoutMs = (typeof waitTimeoutMs === "number" && waitTimeoutMs > 0)
      ? waitTimeoutMs
      : snmpGateWaitTimeoutMs();
    slot.timer = setTimeout(() => {
      if (slot.timedOut) return;
      slot.timedOut = true;
      slot.timer = null;
      const waitMs = Date.now() - slot.enqueuedAt;
      logger.warn(
        { host, port, waitMs, timeoutMs },
        "SNMP gate wait timeout — failing fast",
      );
      reject(new Error(`SNMP gate timeout for ${key} after ${waitMs}ms`));
    }, timeoutMs);
    let queue = snmpQueues.get(key);
    if (!queue) { queue = []; snmpQueues.set(key, queue); }
    queue.push(slot);
    processNextSnmpSlot(key);
  });
}

async function probeSnmp(
  host: string,
  config: Record<string, unknown>,
  start: number,
  timeoutMs: number,
  wantDescr = false,
): Promise<ProbeResult> {
  const port = toNonNegativeInt(config.port, 161);
  return withSnmpGate(host, port, () => new Promise<ProbeResult>((resolve) => {
    // Reset start INSIDE the gate so reported responseTimeMs reflects only
    // the device round-trip, not the FIFO wait behind a concurrent heavy
    // walk on the same (host, port). The caller's `start` is discarded.
    start = performance.now();
    let resolved = false;
    const finishOnce = (r: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      try { (session as any)?.close?.(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finishOnce(finish(start, false, "SNMP timed out")), timeoutMs);

    let session: any;
    try {
      // Same v2c/v3 session construction the collectors use — one builder.
      session = buildSnmpSession(host, config, timeoutMs);

      session.on("error", (err: Error) => finishOnce(finish(start, false, err?.message || "SNMP error")));
      // sysDescr rides along only when the identity read is due. Two OIDs in
      // ONE GET: no extra round trip, no second session, nothing new queued.
      const oids = wantDescr ? [sysUpTimeOid, SYS_OIDS.sysDescr] : [sysUpTimeOid];
      session.get(oids, (err: Error | null, varbinds: any[]) => {
        clearTimeout(timer);
        if (err) return finishOnce(finish(start, false, err.message || "SNMP get failed"));
        if (!varbinds || varbinds.length === 0) {
          return finishOnce(finish(start, false, "SNMP returned no varbinds"));
        }
        // Keyed by OID, never by position. Agents are free to answer in any
        // order, and once this GET can carry two OIDs, reading varbinds[0]
        // would eventually file a sysDescr STRING as the device's uptime.
        const byOid = new Map<string, any>();
        for (const v of varbinds) if (v?.oid) byOid.set(String(v.oid), v);
        const upVb = byOid.get(sysUpTimeOid) ?? varbinds[0];
        if (snmp.isVarbindError(upVb)) {
          return finishOnce(finish(start, false, snmp.varbindError(upVb)));
        }
        // sysUpTime is TimeTicks (hundredths of a second since boot) — capture
        // it for free (the probe already fetched it for the liveness check);
        // drives reboot detection. snmpTicksToSeconds ignores non-finite/neg.
        const ok = finish(start, true);
        const up = snmpTicksToSeconds(upVb?.value);
        if (up !== null) ok.uptimeSec = up;
        // The identity half is strictly best-effort: an error varbind here is
        // an agent that does not publish sysDescr, not a probe failure.
        if (wantDescr) {
          const dVb = byOid.get(SYS_OIDS.sysDescr);
          if (dVb && !snmp.isVarbindError(dVb)) {
            const text = snmpVbToString(dVb.value);
            if (text) ok.sysDescr = text;
          }
        }
        finishOnce(ok);
      });
    } catch (err: any) {
      clearTimeout(timer);
      finishOnce(finish(start, false, err?.message || "SNMP setup failed"));
    }
  }));
}

async function probeWinRm(host: string, config: Record<string, unknown>, start: number, timeoutMs: number): Promise<ProbeResult> {
  const useHttps = config.useHttps !== false;
  const port = toNonNegativeInt(config.port, useHttps ? 5986 : 5985);
  const username = String(config.username || "");
  const password = String(config.password || "");
  if (!username || !password) return finish(start, false, "WinRM credential incomplete");

  // Minimal WS-Management Identify request — exercises authentication
  // without needing a configured shell/runspace.
  const body =
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" ` +
    `xmlns:wsmid="http://schemas.dmtf.org/wbem/wsman/identity/1/wsmanidentity.xsd">` +
    `<s:Header/><s:Body><wsmid:Identify/></s:Body></s:Envelope>`;

  const url = new URL(`${useHttps ? "https" : "http"}://${urlHost(host)}:${port}/wsman`); // IPv6 bracketed (rule 128)
  const auth = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

  return await new Promise<ProbeResult>((resolve) => {
    let resolved = false;
    const finishOnce = (r: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      resolve(r);
    };
    const reqFn = useHttps ? httpsRequest : httpRequest;
    const req = reqFn({
      hostname: bareHost(url.hostname),
      port: Number(url.port),
      path: url.pathname,
      method: "POST",
      headers: {
        "Authorization":  auth,
        "Content-Type":   "application/soap+xml;charset=UTF-8",
        "Content-Length": Buffer.byteLength(body).toString(),
      },
      // WinRM Basic-auth sends credentials on the wire. verifyTls: true checks
      // the CA chain; otherwise the certificate is pinned on first use and
      // checked before the Authorization header is written (business rule 113).
      rejectUnauthorized: config.verifyTls === true,
      ...(useHttps && config.verifyTls !== true ? { agent: pinnedAgentFor(bareHost(url.hostname), Number(url.port)) } : {}),
      timeout: timeoutMs,
    } as any, (res) => {
      // Drain the body so the socket can close cleanly.
      res.on("data", () => {});
      res.on("end", () => {
        if (res.statusCode === 200) return finishOnce(finish(start, true));
        if (res.statusCode === 401) return finishOnce(finish(start, false, "WinRM authentication failed"));
        finishOnce(finish(start, false, `WinRM HTTP ${res.statusCode}`));
      });
    });
    req.on("timeout", () => { try { req.destroy(); } catch {}; finishOnce(finish(start, false, "WinRM timed out")); });
    req.on("error", (err) => finishOnce(finish(start, false, err.message || "WinRM error")));
    req.write(body);
    req.end();
  });
}

async function probeSsh(host: string, config: Record<string, unknown>, start: number, timeoutMs: number): Promise<ProbeResult> {
  const port = toNonNegativeInt(config.port, 22);
  const username = String(config.username || "");
  const password = typeof config.password === "string" ? config.password : "";
  const privateKey = typeof config.privateKey === "string" ? config.privateKey : "";
  const passphrase = typeof config.passphrase === "string" ? config.passphrase : "";
  if (!username || (!password && !privateKey)) return finish(start, false, "SSH credential incomplete");

  return await new Promise<ProbeResult>((resolve) => {
    let resolved = false;
    const client = new SshClient();
    const finishOnce = (r: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      try { client.end(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finishOnce(finish(start, false, "SSH timed out")), timeoutMs);

    client.on("ready", () => {
      clearTimeout(timer);
      finishOnce(finish(start, true));
    });
    client.on("error", (err) => {
      clearTimeout(timer);
      finishOnce(finish(start, false, err.message || "SSH error"));
    });

    try {
      const opts: any = {
        host,
        port,
        username,
        readyTimeout: timeoutMs,
      };
      if (privateKey) {
        opts.privateKey = privateKey;
        // Required for an encrypted key — see remoteExec.withSshClient.
        if (passphrase) opts.passphrase = passphrase;
      } else {
        opts.password = password;
      }
      // Same server authentication as remoteExec.withSshClient — these are the
      // only two ssh2.connect sites and they must not drift apart on whether
      // the host key is checked. On unless verifyHostKey is false (rule 113).
      const verifier = buildHostVerifier(host, port, config);
      if (verifier) opts.hostVerifier = verifier;
      client.connect(opts);
    } catch (err: any) {
      clearTimeout(timer);
      finishOnce(finish(start, false, err?.message || "SSH connect failed"));
    }
  });
}

/**
 * REST API credential test — issues an HTTPS GET to the credential's
 * baseUrl with `Authorization: Bearer <apiToken>` and treats 200/204/401
 * as a successful auth round-trip (401 means the URL is reachable but
 * the token's wrong; we surface that explicitly so operators know the
 * connection isn't the problem). Other status codes get bubbled up as
 * the error message.
 *
 * Doesn't take a `host` argument — the URL is in the credential, not the
 * asset. The probe runs against config.baseUrl directly.
 */
async function probeRestApiCredential(config: Record<string, unknown>, start: number, timeoutMs: number): Promise<ProbeResult> {
  const baseUrl = String(config.baseUrl || "");
  const apiToken = String(config.apiToken || "");
  const verifyTls = config.verifyTls === true;
  if (!baseUrl) return finish(start, false, "REST API credential is missing baseUrl");
  if (!apiToken) return finish(start, false, "REST API credential is missing apiToken");
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { return finish(start, false, "REST API baseUrl is not a valid URL"); }
  const isHttps = url.protocol === "https:";
  const reqFn = isHttps ? httpsRequest : httpRequest;
  const restPort = url.port ? Number(url.port) : (isHttps ? 443 : 80);
  return await new Promise<ProbeResult>((resolve) => {
    let resolved = false;
    const finishOnce = (r: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      resolve(r);
    };
    const req = reqFn({
      hostname: bareHost(url.hostname),
      port:     restPort,
      path:     url.pathname + (url.search || ""),
      method:   "GET",
      headers:  { "Authorization": "Bearer " + apiToken, "Accept": "application/json,*/*" },
      rejectUnauthorized: !!verifyTls,
      // Rule 113(e), re-scan F6: without a CA check the bearer goes only to
      // the certificate pinned for this host:port.
      ...(isHttps && !verifyTls ? { agent: pinnedAgentFor(bareHost(url.hostname), restPort) } : {}),
      timeout:  timeoutMs,
    } as any, (res) => {
      // Drain so the socket releases.
      res.on("data", () => {});
      res.on("end", () => {
        const code = res.statusCode || 0;
        if (code === 200 || code === 204) return finishOnce(finish(start, true));
        if (code === 401 || code === 403) return finishOnce(finish(start, false, "REST API authentication failed (HTTP " + code + ")"));
        if (code === 0)                   return finishOnce(finish(start, false, "REST API request returned no status"));
        finishOnce(finish(start, false, "REST API HTTP " + code));
      });
    });
    req.on("timeout", () => { try { req.destroy(); } catch {}; finishOnce(finish(start, false, "REST API timed out")); });
    req.on("error",   (err) => finishOnce(finish(start, false, err.message || "REST API error")));
    req.end();
  });
}

/**
 * HTTP-check probe — one GET against the asset's own IP, up/down decided by the
 * status code and optionally by a string the response body must carry. The
 * check definition comes from an `http` Credential; `pathOverride` is the
 * asset's `httpCheckPath`. All the decision logic is the pure
 * `evaluateHttpCheck` (utils/httpCheck.ts) — this function owns only the socket.
 *
 * Three transport decisions worth stating, because each is the difference
 * between a check that means something and one that reads healthy while the
 * device is broken:
 *
 *  - `netGuard` is deliberately NOT applied. Every other outbound-HTTP path in
 *    Polaris (automation api_call actions, webhooks) SSRF-checks its target
 *    because the URL is attacker-influenced config pointed at arbitrary hosts.
 *    Here the target is the monitored asset's own address, which is private by
 *    definition — the same address SNMP, SSH and WinRM probes already dial —
 *    so a guard that rejects RFC1918 would reject the entire feature.
 *
 *  - Redirects are not followed (see the httpCheck.ts header): a 302 to a login
 *    page is how an HTTP health check lies about a device being up.
 *
 *  - The body is capped at MAX_BODY_BYTES and the request is torn down once the
 *    cap is reached. Without the teardown a device streaming at the check path
 *    would hold a monitor worker for the whole probe timeout, once per interval.
 */
/** One completed HTTP exchange, before any check semantics are applied. */
interface RawHttpExchange {
  statusCode: number;
  wwwAuthenticate: string | null;
  contentType: string | null;
  body: string;
  truncated: boolean;
}

async function probeHttp(
  host: string,
  config: Record<string, unknown>,
  start: number,
  timeoutMs: number,
  pathOverride?: string | null,
  out?: { diag?: HttpProbeDiagnostics },
  // The AUTH half, from an `http` Credential. Separate from `config` (the check
  // definition) since 2026-08: the check lives on a manufacturer widget and the
  // login on a credential, so one login can serve many checks and vice versa.
  // Absent = unauthenticated, which is a widget with no credential selected.
  auth?: Record<string, unknown> | null,
  // Rule 110, re-scan F58: the credential test passes netGuard's
  // guardedLookup so the typed host is judged by what it resolves to WHEN
  // the socket connects, not by an earlier separate lookup.
  lookup?: import("node:net").LookupFunction,
): Promise<ProbeResult> {
  const cfg = config as HttpCheckConfig;
  const authCfg = (auth || {}) as HttpAuthConfig;
  const target = resolveHttpTarget(cfg, pathOverride);
  const reqFn = target.useHttps ? httpsRequest : httpRequest;
  const authMode = resolveHttpAuthMode(authCfg);
  // Rule 113(e), re-scan F7: a check that sends a password or token over TLS
  // without a CA check sends it only to the pinned certificate. An
  // unauthenticated check sends nothing secret and is left alone.
  const pinned = target.useHttps && cfg.verifyTls !== true && authMode !== "none";

  /**
   * Issue exactly one GET and resolve with the exchange, or with an error
   * string when the transport never produced a response. Factored out of the
   * probe body because Digest needs the same request issued twice — once to
   * collect the challenge, once carrying the answer.
   */
  const issueOnce = (
    extraAuth: string | null,
    perRequestTimeoutMs: number,
  ): Promise<{ exchange?: RawHttpExchange; error?: string }> => {
    const headers: Record<string, string> = { "Accept": "*/*" };
    if (extraAuth) headers["Authorization"] = extraAuth;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (r: { exchange?: RawHttpExchange; error?: string }) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      const req = reqFn({
        hostname: host,
        port:     target.port,
        path:     target.path,
        method:   "GET",
        headers,
        rejectUnauthorized: cfg.verifyTls === true,
        ...(pinned ? { agent: pinnedAgentFor(host, target.port) } : {}),
        ...(lookup ? { lookup } : {}),
        timeout:  perRequestTimeoutMs,
      } as any, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const done = () => {
          // Node collapses repeated response headers into a single comma-joined
          // string for www-authenticate (set-cookie is the lone exception),
          // which is exactly the shape the challenge parser already handles.
          const wa = res.headers?.["www-authenticate"] as string | string[] | undefined;
          const ctype = res.headers?.["content-type"];
          settle({
            exchange: {
              statusCode:      res.statusCode || 0,
              wwwAuthenticate: Array.isArray(wa) ? wa.join(", ") : typeof wa === "string" ? wa : null,
              contentType:     typeof ctype === "string" ? ctype : null,
              body:            Buffer.concat(chunks).toString("utf8"),
              truncated,
            },
          });
        };
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size >= MAX_BODY_BYTES) {
            // Keep the slice that fits so a match sitting just under the cap is
            // still found, then stop: `done` runs now rather than on "end",
            // because destroying the response means "end" may never arrive.
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(0, MAX_BODY_BYTES - (size - chunk.length))));
            try { res.destroy(); } catch {}
            try { req.destroy(); } catch {}
            done();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", done);
        // A connection reset mid-body is a failed check, not a partial success.
        res.on("error", (err: any) => settle({ error: err?.message || "HTTP response error" }));
      });
      req.on("timeout", () => { try { req.destroy(); } catch {}; settle({ error: "HTTP check timed out" }); });
      req.on("error",   (err) => settle({ error: err.message || "HTTP check error" }));
      req.end();
    });
  };

  // Bearer and Basic are computable up front. Digest is not — its response hash
  // is keyed on a server-issued nonce, so the first request goes out bare and
  // the challenge comes back on the 401. "form" (a device admin login held for
  // the firmware repository, business rule 87) deliberately falls through to
  // NO header: it is not an HTTP auth scheme, the widget writer refuses it at
  // save time, and guessing Basic would post the device's admin password to
  // whatever answered.
  let preAuth: string | null = null;
  if (authMode === "bearer" && typeof authCfg.apiToken === "string" && authCfg.apiToken) {
    preAuth = "Bearer " + authCfg.apiToken;
  } else if (authMode === "basic" &&
             typeof authCfg.username === "string" && authCfg.username &&
             typeof authCfg.password === "string" && authCfg.password) {
    preAuth = "Basic " + Buffer.from(`${authCfg.username}:${authCfg.password}`).toString("base64");
  }

  const first = await issueOnce(preAuth, timeoutMs);
  if (first.error || !first.exchange) return finish(start, false, first.error || "HTTP check failed");

  let exchange = first.exchange;
  let digestNegotiated = false;
  let authNote: string | null = null;

  // ── Digest handshake ──────────────────────────────────────────────────────
  // Re-fire exactly ONCE. A server that rejects a correctly-computed response
  // will reject it again, so retrying past this turns a wrong password into a
  // request amplifier against the device.
  if (authMode === "digest" && exchange.statusCode === 401) {
    const challenge = parseDigestChallenge(exchange.wwwAuthenticate);
    if (!challenge) {
      // Named rather than left as a bare 401: a device that answers with Basic
      // only, or with a malformed challenge, is a configuration finding.
      const offered = authSchemesOffered(exchange.wwwAuthenticate);
      authNote = offered.length
        ? `Device requested ${offered.join("/")} auth, not Digest`
        : "Device returned 401 with no Digest challenge";
    } else {
      try {
        const auth = buildDigestAuthorization({
          challenge,
          username: String(authCfg.username || ""),
          password: String(authCfg.password || ""),
          method:   "GET",
          // The request-URI must be byte-identical to the request line, or the
          // HA2 hash is computed over something the server never saw.
          uri:      target.path,
          cnonce:   newCnonce(),
          nc:       1,
        });
        // Keep the whole exchange inside the caller's timeout budget rather
        // than granting a fresh one — two full timeouts would let a slow device
        // hold a monitor worker for twice the configured probe window.
        const remaining = Math.max(1000, Math.round(timeoutMs - (performance.now() - start)));
        const second = await issueOnce(auth, remaining);
        if (second.error || !second.exchange) {
          return finish(start, false, second.error || "HTTP check failed");
        }
        exchange = second.exchange;
        digestNegotiated = true;
      } catch (err: any) {
        // Thrown by buildDigestAuthorization for a qop/algorithm it refuses to
        // guess at. Surfacing the reason beats a second opaque 401.
        authNote = err?.message || "Digest authentication failed";
      }
    }
  }

  const outcome = evaluateHttpCheck({
    statusCode: exchange.statusCode,
    body:       exchange.body,
    config:     cfg,
    truncated:  exchange.truncated,
  });

  // Diagnostics only when a caller asked for them (the operator-driven Test
  // Connection path). The monitor hot path passes no out-param, so it never
  // builds an excerpt or a URL string.
  if (out) {
    const ex = bodyExcerpt(exchange.body);
    const offered = authSchemesOffered(exchange.wwwAuthenticate ?? first.exchange.wwwAuthenticate);
    out.diag = {
      url:                describeHttpTarget(host, target),
      statusCode:         exchange.statusCode,
      contentType:        exchange.contentType,
      bytesRead:          Buffer.byteLength(exchange.body),
      bodyTruncatedAtCap: exchange.truncated,
      excerpt:            ex.text,
      excerptTruncated:   ex.truncated,
      matched:            outcome.matched,
      authRequested:      offered.length ? offered : null,
      digestNegotiated,
    };
  }

  // An outcome can in principle carry error text alongside ok:true; ProbeResult
  // has no slot for "succeeded, but note this", so such a note is dropped here
  // rather than being smuggled into a success. The Test Connection modal reports
  // the outcome directly and so still shows it.
  if (!outcome.ok) {
    // `authNote` explains WHY the status is 401 when the digest handshake
    // could not be completed; without it the operator sees only the code.
    return finish(start, false, authNote ? `${outcome.error} — ${authNote}` : outcome.error);
  }
  return finish(start, true);
}

/**
 * Run a one-shot probe against `host` with the given credential type + config,
 * without touching the asset row or writing samples. Used by the credential
 * Test Connection flow in Server Settings → Credentials, where the operator
 * picks an asset just to supply the host — the asset's stored monitor
 * settings are intentionally ignored. ICMP needs no credential.
 */
export async function probeCredentialAgainstHost(
  host: string,
  type: "snmp" | "winrm" | "ssh" | "icmp" | "restapi" | "http",
  config: Record<string, unknown>,
  // `http` only: filled with the request line, status, content-type and a body
  // excerpt so the operator can TAILOR the check against what the device
  // actually returns. Nothing else populates it, and the monitor hot path never
  // passes it — see probeHttp.
  out?: { diag?: HttpProbeDiagnostics },
  // `http` only: the check definition to exercise. It no longer lives on the
  // credential (that is auth only), so the Test Connection flow supplies one
  // straight from its form — which is also what lets a check be dialled in
  // against a real device BEFORE it is saved onto a manufacturer widget.
  check?: Record<string, unknown> | null,
  // The operator-typed-host test path (rule 110, re-scan F58): `http` connects
  // through this lookup, so the address is judged when the socket connects.
  lookup?: import("node:net").LookupFunction,
): Promise<ProbeResult> {
  const start = performance.now();
  // restapi uses config.baseUrl directly, so a missing host on the asset
  // isn't a deal-breaker for that type — the credential is tested against
  // the URL stored on the credential, not the asset.
  if (!host && type !== "restapi") return finish(start, false, "Host is required");
  // No asset context, so we use the hardcoded floor's probeTimeoutMs as the
  // default. Operator-driven credential test — they can re-trigger if the
  // host is genuinely slow.
  const timeoutMs = HARDCODED_FLOOR.probeTimeoutMs;
  try {
    if (type === "icmp")    return await probeIcmp(host, start, timeoutMs);
    if (type === "snmp")    return await probeSnmp(host, config, start, timeoutMs);
    if (type === "winrm")   return await probeWinRm(host, config, start, timeoutMs);
    if (type === "ssh")     return await probeSsh(host, config, start, timeoutMs);
    if (type === "restapi") return await probeRestApiCredential(config, start, timeoutMs);
    // `config` is the credential (auth only); the CHECK comes from the caller,
    // because since the split there is nothing on the credential that says
    // which request to make. No pathOverride: the modal tests the check it was
    // handed, and the asset it may have borrowed a host from is just a routable
    // target — honouring that asset's httpCheckPath would test a different path
    // and report the result as if it were this one.
    if (type === "http")    return await probeHttp(host, check || {}, start, timeoutMs, null, out, config, lookup);
    return finish(start, false, `Unsupported credential type "${type}"`);
  } catch (err: any) {
    return finish(start, false, err?.message || "Probe failed");
  }
}

// ─── System tab: telemetry + system-info collection ────────────────────────
//
// These run on independent cadences from the response-time probe. Telemetry
// (CPU/memory) ticks every ~60s; system info (interfaces + storage) ticks
// every ~10min. ICMP and SSH cannot deliver this data. WinRM is not yet
// supported — see `collectTelemetryWinRm` / `collectSystemInfoWinRm` below.

export interface TelemetrySample {
  cpuPct?:        number | null;
  memPct?:        number | null;
  memUsedBytes?:  number | null;
  memTotalBytes?: number | null;
  /**
   * Per-core utilisation, index = core id. The `vcenter` collector is the
   * only server-side one that fills it (a VM's vCPUs, an ESXi host's
   * physical cores); the agent's copy never passes through here, arriving on
   * its own push path instead. Null, never `[]` — see the column comment.
   */
  cpuCorePcts?:   number[] | null;
  /**
   * The agent's memory bands, in bytes: memUsedBytes + buffers + cached +
   * free = memTotalBytes exactly. The agent fills them on its own push path;
   * the only server-side collector that does is a TrueNAS host (ZFS ARC as
   * `cached`, buffers 0). Never mixed with the vCenter set below.
   */
  memBuffersBytes?: number | null;
  memCachedBytes?:  number | null;
  memFreeBytes?:    number | null;
  /**
   * The vCenter memory bands, in bytes. Disjoint from the agent's
   * buffers/cache/free set and never mixed with it in one row — a VM fills
   * private/shared/ballooned/swapped/compressed, an ESXi host fills
   * consumed/ballooned/swapped. Every other collector leaves them null.
   */
  memPrivateBytes?:    number | null;
  memSharedBytes?:     number | null;
  memBalloonedBytes?:  number | null;
  memSwappedBytes?:    number | null;
  memCompressedBytes?: number | null;
  memConsumedBytes?:   number | null;
  /** Active session count (FortiGate only). Null for every other source. */
  sessionCount?:  number | null;
}

export interface InterfaceSample {
  ifName:       string;
  adminStatus?: string | null;
  operStatus?:  string | null;
  speedBps?:    number | null;
  /** Negotiated duplex of an UP link, "full" | "half"; null when down or unknown. EtherLike-MIB dot3StatsDuplexStatus (SNMP), FortiOS monitor `duplex`, the Polaris Agent, vCenter pNIC links. */
  duplex?:      string | null;
  /** The interface's IPv4 address (one bare address). IPv6 rides `ipv6Address` (business rule 126). */
  ipAddress?:   string | null;
  /** The interface's secondary IPv4 addresses, bare. FortiOS REST only (CMDB `secondary-ip`); undefined everywhere else, which means "not known", not "none". When it is an array, `ipAddress` is the interface's primary. */
  secondaryIps?: string[] | null;
  /** First reportable IPv6 on the interface — never loopback / link-local (utils/interfaceAddress.ts). Listed and kept in history; never the asset's primary address (business rule 126). */
  ipv6Address?: string | null;
  macAddress?:  string | null;
  inOctets?:    number | null;
  outOctets?:   number | null;
  /** Cumulative IF-MIB ifInErrors / FortiOS errors_in. */
  inErrors?:    number | null;
  /** Cumulative IF-MIB ifOutErrors / FortiOS errors_out. */
  outErrors?:   number | null;
  /** "physical" | "aggregate" | "vlan" | "loopback" | "tunnel" — FortiOS REST + SNMP ifType OID. */
  ifType?:      string | null;
  /** For an "aggregate" row, FortiOS's own bundle type: "aggregate" | "redundant" | "hard-switch" | "switch" (software switch) | "vap-switch". FortiOS REST only. */
  ifSubtype?:   string | null;
  /** Aggregate name (for member ports) or parent interface name (for VLANs). FortiOS REST only. */
  ifParent?:    string | null;
  /** 802.1Q VLAN ID. FortiOS REST only. */
  vlanId?:      number | null;
  /** Untagged PVID for a switch port. Managed FortiSwitches only — overlaid from the parent FortiGate's `switch-controller/managed-switch` CMDB. */
  nativeVlan?:  number | null;
  /** Tagged VLAN set for a switch port (allowed-vlans minus untagged-vlans, expanded). Managed FortiSwitches only. */
  taggedVlans?: number[] | null;
  /** True when the port has `set allowed-vlans all` — trunks every VLAN. Takes precedence over `taggedVlans` for UI display. Managed FortiSwitches only. */
  trunksAllVlans?: boolean | null;
  /** Operator-set label that overrides ifName in the UI. FortiOS CMDB `alias`; SNMP ifAlias (1.3.6.1.2.1.31.1.1.1.18). */
  alias?:       string | null;
  /** Operator-set free-text comment. FortiOS CMDB `description`; SNMP has no equivalent. */
  description?: string | null;
  /** PoE detection status from POWER-ETHERNET-MIB — "disabled" | "searching" | "delivering" | "fault" | "test" | "other-fault". SNMP only; FortiOS REST and the agent leave it null. */
  poeStatus?:   string | null;
  /** Negotiated PoE power-budget bracket, "class0".."class4". NOT a wattage measurement — RFC 3621 has no per-port wattage object. SNMP only. */
  poeClass?:    string | null;
  /** L3 addressing mode: "static" | "dhcp" | "pppoe". FortiOS CMDB `system/interface.mode`; SNMP / agent leave null. */
  addressingMode?: string | null;
}

export interface StorageSample {
  mountPath:   string;
  totalBytes?: number | null;
  usedBytes?:  number | null;
}

/** One row per hardware sensor reported by the device. `value` is the reading
 *  in `unit` (°C / RPM / V / …), null when the sensor is non-readable /
 *  not-present. `sensorClass` is the best-effort classification; `alarmStatus`
 *  is the device-reported health ("ok" / "alarm") when available. */
export interface HardwareSensorSample {
  sensorName:  string;
  sensorClass: string;
  value:       number | null;
  unit:        string | null;
  alarmStatus: string | null;
  /** The port a transceiver reading belongs to (business rule 143); absent otherwise. */
  ifName?:     string | null;
}

/**
 * One SD-WAN Performance SLA health-check reading for a single WAN member.
 * Read from /api/v2/monitor/virtual-wan/health-check. One sample per
 * (health-check, member link). latency/jitter/packetLoss are instantaneous
 * gauges (null when the member reported no value, e.g. link down).
 */
export interface PerfSlaSample {
  healthCheck: string;
  link:        string;
  // SD-WAN zone the member belongs to (CMDB members[].zone). Null when unknown.
  zone:        string | null;
  state:       "up" | "down";
  latencyMs:   number | null;
  jitterMs:    number | null;
  packetLoss:  number | null;
  // SLA target thresholds for the parent health-check (per-health-check config,
  // not per-member). Null when that metric has no configured threshold.
  latencyThresholdMs:  number | null;
  jitterThresholdMs:   number | null;
  packetLossThreshold: number | null;
}

/**
 * One SD-WAN service rule's selection state. Rule definition (name, mode,
 * candidate members) from /api/v2/cmdb/system/sdwan; `selectedMember` is the
 * runtime-active member when resolvable, else null (collector degrades
 * gracefully). One sample per (asset, rule); the detail series is the
 * failover timeline.
 */
export interface SdwanRuleSample {
  ruleName:         string;
  ruleId:           string | null;
  seq:              number | null;
  enabled:          boolean | null;
  mode:             string | null;
  criteria:         string | null;
  healthChecks:     string[];
  dst:              string[];
  status:           "up" | "down";
  selectedMember:   string | null;
  availableMembers: string[];
  // SD-WAN zone(s) the rule prefers, in priority order, when configured for
  // zone-based selection (`priority-zone`). Empty for interface-member rules.
  // When set, `availableMembers` is resolved from the member interfaces of
  // these zones so the UI can group them by zone.
  priorityZones:    string[];
}

/**
 * One LLDP neighbor seen on a local interface. Replaces (per-asset) on each
 * system-info pass that successfully queried LLDP. `localIfName` is the
 * interface on *this* asset that saw the neighbor; the chassis/port fields
 * describe the *remote* end. Capabilities is a list of tokens matching the
 * LLDP-MIB / FortiOS naming ("bridge", "router", "wlan-access-point", …).
 */
export interface LldpNeighborSample {
  localIfName:        string;
  chassisIdSubtype?:  string | null;
  chassisId?:         string | null;
  portIdSubtype?:     string | null;
  portId?:            string | null;
  portDescription?:   string | null;
  systemName?:        string | null;
  systemDescription?: string | null;
  managementIp?:      string | null;
  capabilities?:      string[];
}

/**
 * Wireless station seen connected to a FortiAP. Collected from SNMP
 * `fapStationTable` (1.3.6.1.4.1.12356.120.8.1.1) and persisted via the
 * system-info pass into AssetWirelessStation. MAC is normalized
 * colon-uppercase before persist; the persist layer resolves
 * `matchedAssetId` by MAC lookup against the endpoint inventory.
 */
interface WirelessStationSample {
  staMacAddr:      string;
  staIpAddr?:      string | null;
  ssid?:           string | null;
  radioId?:        number | null;
  wlanId?:         number | null;
  band?:           string | null;
  vlanId?:         number | null;
  bssid?:          string | null;
  signalStrength?: number | null;
  noise?:          number | null;
  bandwidthTx?:    number | null;
  bandwidthRx?:    number | null;
  idleSeconds?:    number | null;
}

/** One field-replaceable unit from ENTITY-MIB entPhysicalTable. */
interface PhysicalEntitySample {
  entIndex:    number;
  entClass:    string;
  descr:       string | null;
  name:        string | null;
  hardwareRev: string | null;
  firmwareRev: string | null;
  serialNum:   string | null;
  mfgName:     string | null;
  modelName:   string | null;
  isFru:       boolean;
  /** Display-only correlated interface for a transceiver; never an identity. */
  ifName:      string | null;
}

export interface SystemInfoSample {
  interfaces:    InterfaceSample[];
  storage:       StorageSample[];
  /**
   * Field-replaceable hardware inventory. `undefined` means the collector
   * didn't try (non-SNMP transport / fast cadence); `[]` means the device was
   * queried and reported no FRUs, which the persist layer treats as "wipe".
   */
  physicalEntities?: PhysicalEntitySample[];
  /**
   * Switch MAC forwarding database. Same undefined/[] contract: undefined
   * means not collected or the device answers no FDB table at all, `[]` means
   * a bridge that currently has nothing in its table.
   */
  macTable?: FdbEntry[];
  /** IP neighbour cache (ARP / NDP). Firewall-class only; see collectArpNeighborsSnmp. */
  arpNeighbors?: ArpNeighborEntry[];
  /**
   * FortiSwitch trunk -> local-port map. Same undefined/[] contract.
   */
  trunkMembers?: TrunkPortEntry[];
  ipsecTunnels?: IpsecTunnelSample[];
  /**
   * Who is connected through this gate's IPsec / SSL-VPN: ADVPN spokes and
   * shortcuts, dial-up peers, FortiClient users. Per source, the
   * undefined/[] contract: `ipsecConnections` undefined = the IPsec monitor
   * read failed or did not run (stored IPsec rows stay), `[]` = read, nobody
   * connected (wipe). `sslVpnSessions` the same for the SSL-VPN half, which
   * is a separate read that fails on its own. Full pass only.
   */
  ipsecConnections?: IpsecConnectionSample[];
  sslVpnSessions?:   IpsecConnectionSample[];
  // SD-WAN (perfSla / sdwanRules) is not part of this sample any more — it has
  // its own cadence and runner (runSdwanFor).
  /**
   * LLDP neighbors observed during this scrape. `undefined` means the
   * collector didn't try (unsupported transport / fast-cadence skip);
   * `[]` means the device was queried but reported zero neighbors and the
   * persistence layer should treat that as "wipe all stored neighbors".
   */
  lldpNeighbors?: LldpNeighborSample[];
  /** Which transport produced lldpNeighbors. Stamped onto each persisted row for diagnostics. */
  lldpSource?:    "fortios" | "snmp" | "genericapi";
  /**
   * Wireless stations connected to a FortiAP, observed during this
   * scrape. Same undefined/[] semantics as lldpNeighbors. Only populated
   * by the SNMP fapStationTable path on `assetType="access_point"`
   * assets; FortiOS-REST AP telemetry path stays undefined.
   */
  wirelessStations?: WirelessStationSample[];
  /** The AP's radios + the SSIDs each one broadcasts (FORTINET-FORTIAP-MIB's
   *  fapRadioTable + fapVapTable). Absent when the tables could not be read —
   *  "unknown, do not wipe", the same contract as the two above. */
  apRadios?: ApRadioSample[];
  /**
   * MCLAG ICL peers (FortiSwitch only), from the parent FortiGate's
   * switch-controller managed-switch CMDB. Same undefined/[] semantics as LLDP:
   * `undefined` = not collected (leave stored rows alone), an array (even empty)
   * = full-replace the asset's ICL-peer rows. Current-state, no history.
   */
  mclagPeers?: FortiswitchMclagPeer[];
  /**
   * FortiLink-enabled interface names (the fortilink-flagged interfaces + their
   * member ports) seen on this FortiGate, from CMDB `system/interface`. Used to
   * exclude FortiLink links from LLDP when the integration's
   * `excludeFortilinkLldp` toggle is on. Only populated by the FortiOS REST
   * path (which fetches CMDB); `[]` when CMDB returned no fortilink interfaces,
   * `undefined` when CMDB wasn't fetched (SNMP-interfaces path).
   */
  fortilinkInterfaces?: string[];
  /**
   * Real hardware model detected during the scrape, when the matched vendor
   * profile carries a model-identity query (FortiSwitch fsSysVersion — the
   * value has the firmware version appended after the model token, and the
   * profile's parse strips it). `undefined`/null = not collected or
   * unrecognized → leave Asset.model alone. recordSystemInfoResult adopts a
   * non-null value onto Asset.model only while the stored model is empty or
   * still the generic discovery literal ("FortiSwitch…"), so an
   * operator-typed model is never overwritten.
   */
  detectedModel?: string | null;
  /**
   * What the vendor's OWN sysDescr format stated, when the vendor publishes
   * one Polaris can read (utils/snmpDescrIdentity.ts). `undefined` for every
   * other device, which is most of them — and the reason this is safe to
   * collect fleet-wide: no readable layout, no opinion, no write.
   */
  descrIdentity?: SysDescrDetail;
  /** The raw sysDescr behind it, so Asset.os can follow the firmware. */
  sysDescr?: string | null;
}

export interface CollectionResult<T> {
  /** false → monitor type can't deliver this data; caller should not stamp lastXxxAt */
  supported: boolean;
  /** Set on a successful collection (even if some sub-fields are null). */
  data?: T;
  /** Short failure reason; only set when supported && data is undefined. */
  error?: string;
}

/** Cap on the amount of work a single subtree walk will do. Guards against pathological devices that publish huge ifTables. */
const SNMP_WALK_MAX = 1000;

/**
 * The asset shape the three telemetry-cadence collectors need, as ONE load.
 *
 * They ran a `findUnique` each — same row, three times, two of them
 * concurrently (runTelemetryFor's Promise.all) — and Asset is the widest
 * table in the schema at ~170 columns including six JSON blobs
 * (fortinetTopology, virtualization, managementAccess, quarantineTargets,
 * associatedUsers, descriptionSync), none of which a collector reads. The
 * include is the UNION of what the three needed, so a standalone caller
 * trades one or two extra credential joins for the same asset payload, and
 * the cadence pass drops from three wide reads to one.
 */
const TELEMETRY_ASSET_INCLUDE = {
  monitorCredential:       true,
  cpuMemoryCredential:     true,
  temperatureCredential:   true,
  customWidgetCredential:  true,
  discoveredByIntegration: true,
} as const;

function loadTelemetryAsset(assetId: string) {
  return prisma.asset.findUnique({ where: { id: assetId }, omit: PROBE_ASSET_OMIT, include: TELEMETRY_ASSET_INCLUDE });
}

/** One row of TELEMETRY_ASSET_INCLUDE — what the collectors accept preloaded. */
export type TelemetryAssetRow = Awaited<ReturnType<typeof loadTelemetryAsset>>;

export async function collectTelemetry(assetId: string, preloaded?: TelemetryAssetRow): Promise<CollectionResult<TelemetrySample>> {
  const asset = preloaded !== undefined ? preloaded : await loadTelemetryAsset(assetId);
  if (!asset)            return { supported: false, error: "Asset not found" };
  if (!asset.monitored)  return { supported: false };

  // Resolve the per-stream polling method. Source-default fallback gives us
  // a value (rest_api on Fortinet, null on AD/Entra/Win/Manual since the
  // telemetry stream isn't delivered there by default).
  const effective = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  // CPU/memory dispatch. Hardware sensors are collected separately by
  // `collectHardwareSensors` so operators can run CPU/memory over REST while
  // the hardware-sensor scrape uses SNMP (branch-class FortiGate workaround
  // when /api/v2/monitor/system/sensor-info is unreliable). The two streams
  // share the telemetry cadence today; an independent temperatureIntervalSeconds
  // timer can land in a follow-up.
  const polling = effective.cpuMemoryPolling;
  if (!polling) return { supported: false };
  // Agent-mode: the Polaris Agent on the host pushes telemetry via
  // POST /api/v1/agents/samples on its own schedule. Periodic puller stays
  // out of the way — `recordTelemetryResult` already no-ops on supported=false.
  if (polling === "agent") return { supported: false };
  const telemetryTimeout = effective.cpuMemoryTimeoutMs;

  // vCenter quickStats need no asset IP (the vCenter server is the target),
  // so this dispatches BEFORE the IP guard below. The collector resolves the
  // integration via the asset's vcenter-vm AssetSource row.
  if (polling === "vcenter") {
    return await collectTelemetryVcenter(assetId);
  }
  if (isWorkloadPollingMethod(polling)) {
    return await collectTelemetryWorkload(assetId);
  }
  if (polling === "genericapi") {
    return await collectTelemetryGenericApi(assetId);
  }

  // FQDN fallback for credentialed methods that resolve hostnames natively.
  const targetIp =
    dial(asset) ||
    ((polling === "winrm" || polling === "ssh") ? (asset.dnsName || asset.hostname) : null);
  if (!targetIp) return { supported: false, error: "Asset has no IP address" };

  const integration   = asset.discoveredByIntegration ?? null;
  const isFortinetSrc = isFortinetIntegrationType(integration?.type);

  try {
    if (polling === "rest_api") {
      // Telemetry over REST API is FortiOS-specific. Manual REST API
      // credentials don't yet have a telemetry shape — `{ supported: false }`
      // until that lands.
      if (!isFortinetSrc || !integration) return { supported: false };
      // Managed FortiSwitches aren't directly REST-able — they don't speak
      // FortiOS REST and the integration's API token isn't valid against
      // them. The probe path redirects to the parent FortiGate's
      // controller-status table, but there's no controller-side endpoint
      // that exposes CPU / memory for a managed switch. Operators who want
      // switch telemetry flip to SNMP. **Managed FortiAPs are different**:
      // /api/v2/monitor/wifi/managed_ap returns cpu_usage + mem_free +
      // mem_total + sensors_temperatures per AP, so the controller-cache
      // doubles as a telemetry source. See collectTelemetryFortiapRest.
      if (asset.assetType === "switch") return { supported: false };
      if (asset.assetType === "access_point") {
        return await collectTelemetryFortiapRest(asset, integration as any, telemetryTimeout);
      }
      // Per-gate token, when the operator selected one on this stream. The
      // FortiAP branch above deliberately gets none: that read goes to the
      // PARENT gate controller table, so it authenticates as the parent.
      const data = await collectTelemetryFortinet(
        targetIp,
        integration as any,
        telemetryTimeout,
        pickRestApiCredential(asset.cpuMemoryCredential, asset.monitorCredential),
      );
      return { supported: true, data };
    }
    if (polling === "snmp") {
      // Per-stream asset credential wins, then asset default, then class-
      // override credential, then integration fallback. CPU/memory reads from
      // cpuMemoryCredential — hardware sensors have their own credential resolved
      // inside `collectHardwareSensors` so the two streams can authenticate
      // independently when an operator points each at a different community.
      const effectiveTelemetryCred = asset.cpuMemoryCredential ?? asset.monitorCredential;
      const resolvedTelemetryCfg = await resolveSnmpConfigForStream(effectiveTelemetryCred, effective.cpuMemoryCredentialId, isFortinetSrc, integration);
      if (resolvedTelemetryCfg.error !== undefined) {
        return { supported: true, error: resolvedTelemetryCfg.error };
      }
      const snmpCfg = resolvedTelemetryCfg.cfg;
      const data = await collectTelemetrySnmp(
        targetIp,
        snmpCfg,
        asset.manufacturer,
        asset.model,
        asset.os,
        telemetryTimeout,
        effective.cpuMemoryMibId,
        asset.assetType,
      );
      return { supported: true, data };
    }
    // Agentless CPU/memory over SSH (Linux /proc) or WinRM (CIM). These
    // silently returned {supported:false} until 2026-08-28 — accepted at every
    // validator, recorded as a healthy tick, collecting nothing.
    if (polling === "ssh" || polling === "winrm") {
      const cred = await resolveAgentlessCredConfig(
        asset.cpuMemoryCredential ?? asset.monitorCredential,
        effective.cpuMemoryCredentialId,
        polling,
        adBindFallbackIntegration(asset, integration),
      );
      if (!cred) return { supported: true, error: `No ${polling === "ssh" ? "SSH" : "WinRM"} credential selected` };
      const res = polling === "ssh"
        ? await collectHostSsh(targetIp, cred, { telemetry: true, interfaces: false, storage: false, timeoutMs: telemetryTimeout })
        : await collectHostWinrm(winrmConnFrom(targetIp, cred, telemetryTimeout), { telemetry: true, interfaces: false, storage: false, timeoutMs: telemetryTimeout });
      if (!res.telemetry) return { supported: true, error: "Host returned no CPU/memory reading" };
      return { supported: true, data: res.telemetry };
    }
    // icmp carries no payload.
    return { supported: false };
  } catch (err: any) {
    return { supported: true, error: err?.message || "Telemetry collection failed" };
  }
}

/**
 * Temperature scrape for one asset. Dispatches on `temperaturePolling` —
 * deliberately separate from `cpuMemoryPolling` so an operator can run
 * CPU/memory over REST while temperature scrapes over SNMP (the common
 * branch-class FortiGate workaround when /api/v2/monitor/system/sensor-info
 * is unreliable on the platform's FortiOS build). Uses the temperature-
 * specific credential / MIB / timeout returned by the four-tier resolver.
 *
 * Cadence note: today temperature shares the telemetry cadence trigger
 * (cpuMemoryIntervalSeconds drives when `runTelemetryFor` fires both
 * streams). An independent temperatureIntervalSeconds timer is a future
 * follow-up — see `temperatureIntervalSec` on the schema.
 */
export async function collectHardwareSensors(assetId: string, preloaded?: TelemetryAssetRow): Promise<CollectionResult<HardwareSensorSample[]>> {
  const asset = preloaded !== undefined ? preloaded : await loadTelemetryAsset(assetId);
  if (!asset)            return { supported: false, error: "Asset not found" };
  if (!asset.monitored)  return { supported: false };

  const effective = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  const polling = effective.temperaturePolling;
  if (!polling) return { supported: false };
  // Agent-mode: the Polaris Agent on the host pushes temperature samples
  // alongside its telemetry stream via POST /api/v1/agents/samples on its
  // own schedule. Periodic puller stays out of the way.
  if (polling === "agent") return { supported: false };
  const timeoutMs = effective.temperatureTimeoutMs;
  // Unraid / TrueNAS: the host's disk temperatures, from the cached snapshot.
  if (isWorkloadPollingMethod(polling)) {
    return await collectHardwareSensorsWorkload(assetId);
  }
  if (polling === "genericapi") {
    return await collectHardwareSensorsGenericApi(assetId);
  }

  const targetIp =
    dial(asset) ||
    ((polling === "winrm" || polling === "ssh") ? (asset.dnsName || asset.hostname) : null);
  if (!targetIp) return { supported: false, error: "Asset has no IP address" };

  const integration         = asset.discoveredByIntegration ?? null;
  const isFortinetSrc       = isFortinetIntegrationType(integration?.type);

  try {
    if (polling === "rest_api") {
      // Temperature over REST API is FortiOS-specific (sensor-info endpoint).
      // Managed FortiSwitches aren't directly REST-able. Managed FortiAPs
      // expose temperatures via /api/v2/monitor/wifi/managed_ap → handled
      // by collectTemperaturesFortiapRest (controller cache).
      if (!isFortinetSrc || !integration) return { supported: false };
      if (asset.assetType === "switch")   return { supported: false };
      if (asset.assetType === "access_point") {
        return await collectHardwareSensorsFortiapRest(asset, integration as any, timeoutMs);
      }
      const fg = buildFortinetConfig(
        targetIp,
        integration as any,
        pickRestApiCredential(asset.temperatureCredential, asset.monitorCredential),
      );
      if ("error" in fg) throw new AppError(409, fg.error);
      const data = await collectHardwareSensorsFortinet(fg, timeoutMs);
      return { supported: true, data };
    }
    if (polling === "snmp") {
      // Per-stream asset credential wins, then asset default, then class-
      // override credential, then integration fallback. Same priority chain
      // as cpuMemoryCredential but resolved against the temperature-stream
      // columns so the two streams can authenticate independently.
      const effectiveTempCred = asset.temperatureCredential ?? asset.monitorCredential;
      const resolvedTempCfg = await resolveSnmpConfigForStream(effectiveTempCred, effective.temperatureCredentialId, isFortinetSrc, integration);
      if (resolvedTempCfg.error !== undefined) {
        return { supported: true, error: resolvedTempCfg.error };
      }
      const snmpCfg = resolvedTempCfg.cfg;
      const data = await collectHardwareSensorsViaSnmpSession(
        targetIp,
        snmpCfg,
        asset.manufacturer,
        asset.model,
        asset.os,
        timeoutMs,
        effective.temperatureMibId,
        asset.assetType,
      );
      return { supported: true, data };
    }
    // winrm / ssh / icmp don't deliver hardware-sensor data.
    return { supported: false };
  } catch (err: any) {
    return { supported: true, error: err?.message || "Hardware sensor collection failed" };
  }
}

/**
 * Open an SNMP session and run the collectHardwareSensorsSnmp walk inside it.
 * Shares collectTelemetrySnmp's MIB-pin handling (`profileSubjectFor`), so
 * pinning an uploaded MIB on the temperature stream feeds the right
 * manufacturer / module name / model into `pickDbProfile`.
 */
async function collectHardwareSensorsViaSnmpSession(
  host: string,
  config: Record<string, unknown>,
  manufacturer?: string | null,
  model?: string | null,
  os?: string | null,
  timeoutMs?: number,
  temperatureMibId?: string | null,
  assetType?: string | null,
): Promise<HardwareSensorSample[]> {
  await ensureRegistryLoaded();
  const profile = pickDbProfile(
    await profileSubjectFor({ manufacturer, model, os, assetType, pinnedMibId: temperatureMibId }),
  );
  // The asset's own scope, then the governing profile's (business rule 131).
  const scope: ResolveScope = { manufacturer, model, profileManufacturer: profile?.profileManufacturer };
  return await withSnmpSession(host, config, async (session) => {
    return await collectHardwareSensorsSnmp(session, profile, scope);
  }, timeoutMs);
}

/**
 * Light variant of collectSystemInfo that only returns the interfaces, storage
 * mountpoints, and IPsec tunnels the operator pinned for fast-cadence polling
 * (Asset.monitoredInterfaces / monitoredStorage / monitoredIpsecTunnels). The
 * underlying fetch still walks the full set on each protocol (one SNMP session
 * or one FortiOS round-trip), but the filter keeps us from writing noisy rows
 * for everything else once per minute. IPsec is only fetched from FortiOS when
 * tunnels are pinned — the endpoint can be slow on busy gateways and we don't
 * want to hammer it from the fast cadence unless asked.
 */
async function collectFastFiltered(assetId: string): Promise<CollectionResult<SystemInfoSample>> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    omit: PROBE_ASSET_OMIT,
    include: { monitorCredential: true, interfacesCredential: true, discoveredByIntegration: true },
  });
  if (!asset)            return { supported: false, error: "Asset not found" };
  if (!asset.monitored)  return { supported: false };
  const wantedIfaces  = (asset.monitoredInterfaces   || []) as string[];
  const wantedStorage = (asset.monitoredStorage      || []) as string[];
  const wantedTunnels = (asset.monitoredIpsecTunnels || []) as string[];
  if (wantedIfaces.length === 0 && wantedStorage.length === 0 && wantedTunnels.length === 0) {
    return { supported: false };
  }

  const effective = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  const polling = effective.interfacesPolling;
  if (!polling) return { supported: false };
  // Agent-mode: the Polaris Agent on the host pushes interface/storage/tunnel
  // samples on its own schedule via POST /api/v1/agents/samples.
  if (polling === "agent") return { supported: false };
  const sysInfoTimeout = effective.systemInfoTimeoutMs;

  // vCenter: the pinned subset is filtered out of the same warm-cache reading
  // the full pass uses, so the fast cadence costs a Map lookup and gives pinned
  // vNICs / guest mounts per-minute resolution. No asset IP needed.
  if (polling === "vcenter") {
    const vcReading = await readVcenterAsset(assetId);
    if (vcReading.kind === "absent" || vcReading.kind === "unreachable") {
      return { supported: true, error: vcReading.error };
    }
    const vcFull = buildVcenterSystemInfo(vcReading);
    const wantIfVc = new Set(wantedIfaces);
    const wantStVc = new Set(wantedStorage);
    return {
      supported: true,
      data: {
        interfaces: wantedIfaces.length ? vcFull.interfaces.filter((i) => wantIfVc.has(i.ifName)) : [],
        storage: (wantedStorage.length && effective.storagePolling === "vcenter")
          ? vcFull.storage.filter((s) => wantStVc.has(s.mountPath))
          : [],
      },
    };
  }

  // Unraid / TrueNAS: the pinned subset of the same cached snapshot.
  if (isWorkloadPollingMethod(polling)) {
    return await collectSystemInfoWorkload(assetId, effective, { interfaces: wantedIfaces, storage: wantedStorage });
  }
  if (polling === "genericapi" || effective.storagePolling === "genericapi") {
    return await collectSystemInfoGenericApi(assetId, effective, { interfaces: wantedIfaces, storage: wantedStorage });
  }

  const targetIp =
    dial(asset) ||
    ((polling === "winrm" || polling === "ssh") ? (asset.dnsName || asset.hostname) : null);
  if (!targetIp) return { supported: false, error: "Asset has no IP address" };

  const integration   = asset.discoveredByIntegration ?? null;
  const isFortinetSrc = isFortinetIntegrationType(integration?.type);
  const isManagedSwitchOrAp = asset.assetType === "switch" || asset.assetType === "access_point";

  try {
    let full: SystemInfoSample;
    if (polling === "rest_api") {
      if (!isFortinetSrc || !integration) return { supported: false };
      // Managed FortiSwitches / FortiAPs aren't directly REST-able; the
      // parent FortiGate's controller-status table doesn't expose per-port
      // counters or storage. Operators flip the integration's
      // FortiSwitches / FortiAPs subtab to direct SNMP polling to enable
      // this stream. Same guard as collectTelemetry.
      if (isManagedSwitchOrAp) return { supported: false };
      // Only ask FortiOS for IPsec when a tunnel is actually pinned —
      // /api/v2/monitor/vpn/ipsec is the slow endpoint we want to avoid on
      // the fast cadence. Fast cadence always skips LLDP — neighbors don't
      // change between full system-info passes often enough to merit
      // re-walking the table once a minute.
      full = await collectSystemInfoFortinet(targetIp, integration as any, {
        includeIpsec: wantedTunnels.length > 0,
        includeLldp:  false,
        timeoutMs:    sysInfoTimeout,
      }, pickRestApiCredential(asset.interfacesCredential, asset.monitorCredential));
    } else if (polling === "snmp") {
      const effectiveIfacesCred = asset.interfacesCredential ?? asset.monitorCredential;
      const resolvedIfCfg = await resolveSnmpConfigForStream(effectiveIfacesCred, effective.interfacesCredentialId, isFortinetSrc, integration);
      if (resolvedIfCfg.error !== undefined) {
        return { supported: true, error: resolvedIfCfg.error };
      }
      const snmpCfg = resolvedIfCfg.cfg;
      // Wire-level filtered scrape: pulls only the columns/rows we actually
      // need (pinned ifNames + pinned mountPaths) instead of walking the full
      // IF-MIB / hrStorage subtrees. On a 48-port switch with one pinned
      // interface this is ~13 OIDs in one PDU vs. ~770 OID-fetches across 16
      // column walks under the legacy path — drops fast-cadence p90 from
      // multi-second to sub-second on busy fleets. See `collectFastFilteredSnmp`
      // for the three-phase rationale (discovery walks → multi-GET → assembly).
      full = await collectFastFilteredSnmp(targetIp, snmpCfg, {
        wantedIfaces:  wantedIfaces,
        wantedStorage: wantedStorage,
        timeoutMs:     sysInfoTimeout,
      });
      // Fortinet-discovered firewalls running SNMP still benefit from the
      // integration's interface filter (CMDB blocklist) and from the FortiOS
      // IPsec overlay — the two endpoints are independent of the SNMP path.
      // The CMDB filter is a no-op when the SNMP scrape already filtered to
      // the operator-pinned set (operators don't pin interfaces they've also
      // filtered out), but we keep the call to preserve the same defense-in-
      // depth behavior as the heavy cadence.
      if (isFortinetSrc && integration) {
        applyFortiInterfaceFilter(full.interfaces, integration as any);
        // Skip managed FortiSwitches / FortiAPs — not directly REST-able, no IPsec.
        // See the matching guard + rationale in collectSystemInfo.
        if (!isManagedSwitchOrAp && wantedTunnels.length > 0) {
          const ipsec = await collectIpsecOnlyFortinetSafe(targetIp, integration as any, sysInfoTimeout, pickRestApiCredential(asset.interfacesCredential, asset.monitorCredential));
          // Tunnels only: the connection rows are the full pass's to write.
          if (ipsec !== undefined) full.ipsecTunnels = ipsec.tunnels;
        }
      }
    } else {
      // winrm / ssh / icmp don't yet deliver interfaces / storage. Same
      // story as collectTelemetry.
      return { supported: false };
    }
    const wantIf = new Set(wantedIfaces);
    const wantSt = new Set(wantedStorage);
    const wantTn = new Set(wantedTunnels);
    const interfaces = wantedIfaces.length  ? full.interfaces.filter((i) => wantIf.has(i.ifName)) : [];
    // Storage is its own stream — drop pinned-storage scrapes when the resolved
    // storagePolling isn't SNMP. Same independence rule as the full systemInfo
    // pass above.
    const storage    = (wantedStorage.length && effective.storagePolling === "snmp")
      ? full.storage.filter((s) => wantSt.has(s.mountPath))
      : [];
    const ipsecTunnels = (wantedTunnels.length && Array.isArray(full.ipsecTunnels))
      ? full.ipsecTunnels.filter((t) => wantTn.has(t.tunnelName))
      : undefined;
    return { supported: true, data: { interfaces, storage, ipsecTunnels } };
  } catch (err: any) {
    return { supported: true, error: err?.message || "Fast-cadence scrape failed" };
  }
}

/**
 * Persist a fast-cadence scrape. Mirrors recordSystemInfoResult for the three
 * sample tables, but does NOT touch Asset.associatedIps (that is owned by the
 * full system-info pass) and does NOT advance lastSystemInfoAt — the fast pass
 * is supplementary and the next full scrape is still gated on its own cadence.
 */
export async function recordFastFilteredResult(assetId: string, result: CollectionResult<SystemInfoSample>): Promise<void> {
  if (!result.supported || !result.data) return;
  const d = result.data;
  const now = new Date();
  // Same reconciliation as the full pass, and this is the path that actually
  // produced the bad alert: the fast pass resolves PINNED names against the
  // device, so a pin left behind by a description-named scrape keeps drawing
  // samples under that description — which then becomes the alert's dimension
  // ("Interface PoE status on MORGAN-221E-1 is fault"). It does NOT repair
  // pins: this pass never writes the inventory it would have to reconcile
  // against (see interfaceInventoryService's single-writer note).
  if (d.interfaces.length > 0) {
    const identity = await loadInterfaceIdentity(assetId);
    const canon = canonicalizeInterfaceRows(d.interfaces, identity);
    if (canon.renamed.length > 0 || canon.dropped > 0) {
      logger.warn(
        { assetId, ports: canon.renamed.slice(0, 5).map((r) => r.to), renamedCount: canon.renamed.length, dropped: canon.dropped },
        "fast interface scrape named ports by their description — mapped back to the port name",
      );
      d.interfaces = canon.rows;
    }
  }
  if (d.interfaces.length > 0) {
    const ifaceRows: InterfaceSampleRow[] = d.interfaces.map((i) => ({
      assetId,
      timestamp: now,
      cadence:     "fast" as const,
      ifName:      i.ifName,
      adminStatus: i.adminStatus ?? null,
      operStatus:  i.operStatus ?? null,
      speedBps:    i.speedBps != null ? BigInt(Math.round(i.speedBps)) : null,
      duplex:      i.duplex ?? null,
      // ipAddress + ipv6Address, normalised (business rule 126).
      ...splitInterfaceAddresses(i.ipAddress, i.ipv6Address, ipv6Enabled()),
      macAddress:  i.macAddress ?? null,
      inOctets:    i.inOctets  != null ? BigInt(Math.round(i.inOctets))  : null,
      outOctets:   i.outOctets != null ? BigInt(Math.round(i.outOctets)) : null,
      inErrors:    i.inErrors  != null ? BigInt(Math.round(i.inErrors))  : null,
      outErrors:   i.outErrors != null ? BigInt(Math.round(i.outErrors)) : null,
      ifType:      null,
      ifParent:    null,
      vlanId:      null,
      nativeVlan:  i.nativeVlan ?? null,
      taggedVlans: i.taggedVlans ?? [],
      trunksAllVlans: i.trunksAllVlans === true,
      alias:       i.alias       ?? null,
      description: i.description ?? null,
      addressingMode: null,
      // Passed through, NOT nulled: the fast SNMP path collects PoE so a
      // port fault is alertable on the per-minute cadence rather than
      // waiting for the next heavy scrape.
      poeStatus:   i.poeStatus ?? null,
      poeClass:    i.poeClass  ?? null,
    }));
    enqueueInterfaceSamples(ifaceRows);
    void recordInterfaceLinkEvents(ifaceRows);
  }
  if (d.storage.length > 0) {
    enqueueStorageSamples(
      d.storage.map((s) => ({
        assetId,
        timestamp: now,
        cadence:    "fast" as const,
        mountPath:  s.mountPath,
        totalBytes: s.totalBytes != null ? BigInt(Math.round(s.totalBytes)) : null,
        usedBytes:  s.usedBytes  != null ? BigInt(Math.round(s.usedBytes))  : null,
      })),
    );
  }
  if (Array.isArray(d.ipsecTunnels) && d.ipsecTunnels.length > 0) {
    enqueueIpsecTunnelSamples(
      d.ipsecTunnels.map((t) => ({
        assetId,
        timestamp: now,
        cadence:         "fast" as const,
        tunnelName:      t.tunnelName,
        parentInterface: t.parentInterface,
        remoteGateway:   t.remoteGateway,
        status:          t.status,
        incomingBytes:   t.incomingBytes != null ? BigInt(Math.round(t.incomingBytes)) : null,
        outgoingBytes:   t.outgoingBytes != null ? BigInt(Math.round(t.outgoingBytes)) : null,
        proxyIdCount:    t.proxyIdCount,
      })),
    );
  }
}

// ─── collectSystemInfo overlay helpers (split 2026-08 — the dispatch gates
// are pinned in tests/integration/collectSystemInfoGates.test.ts; each
// overlay below is a best-effort enrichment of the in-memory SystemInfoSample
// and never fails the scrape).

/**
 * Resolve the parent-FortiGate controller name for a managed FortiSwitch /
 * FortiAP: the fortinetTopology.controllerFortigate stamp discovery wrote,
 * falling back to the standalone-FortiGate integration's host. "" = unknown.
 */
function fortinetControllerNameOf(
  asset: { fortinetTopology: unknown },
  integration: { type: string; config: unknown },
): string {
  const topology = (asset.fortinetTopology ?? {}) as Record<string, unknown>;
  const stamped = typeof topology.controllerFortigate === "string"
    ? topology.controllerFortigate.trim()
    : "";
  if (stamped) return stamped;
  if (integration.type === "fortigate") {
    return String((integration.config as Record<string, unknown>).host || "");
  }
  return "";
}

/**
 * FortiSwitch port-VLAN + trunk-member overlay (SNMP interfaces path). SNMP
 * IF-MIB gives us per-port counters but neither VLAN membership nor the
 * trunk→physical-member mapping; the parent FortiGate's switch-controller
 * CMDB carries both. One cached call per controller per 30s, keyed by
 * serial, joined onto the in-memory InterfaceSample list by port-name ==
 * ifName. Also stamps MCLAG ICL peers (definitive when the switch is in
 * CMDB; left undefined otherwise so stored rows survive — the LLDP
 * undefined-vs-[] convention). Best-effort: any failure leaves the VLAN
 * fields null on every row and the interface scrape proceeds.
 */
async function overlayFortiswitchCmdbOntoSnmp(
  asset: { assetType: string; serialNumber: string | null; fortinetTopology: unknown },
  integration: { type: string; config: unknown },
  data: SystemInfoSample,
  sysInfoTimeout: number,
): Promise<void> {
  if (asset.assetType !== "switch" || !asset.serialNumber) return;
  const controllerName = fortinetControllerNameOf(asset, integration);
  if (!controllerName) return;
  const endVlan = startPhase("systeminfo.snmp.fortiswitch_vlan_overlay");
  try {
    const portsMap = await fetchFortiswitchControllerPortsCmdb(
      integration as any,
      controllerName,
      sysInfoTimeout,
    );
    const portsForSwitch = portsMap.get(asset.serialNumber.toUpperCase());
    // When the switch is present in the controller CMDB we know its
    // MCLAG state definitively — stamp it (empty array = wipe stale
    // ICL rows) even if the VLAN map is empty. Leaving it undefined
    // when the switch isn't in CMDB preserves stored rows (no-wipe),
    // matching the LLDP undefined-vs-[] convention.
    if (portsForSwitch) {
      data.mclagPeers = portsForSwitch.mclagPeers;
    }
    if (portsForSwitch && portsForSwitch.vlanByPort.size > 0) {
      let overlaid = 0;
      for (const iface of data.interfaces) {
        // Port description comes from the same CMDB payload; SNMP
        // leaves description null on every switch-port row, so
        // this overlay is its only source.
        const desc = portsForSwitch.descriptionByPort.get(iface.ifName);
        if (desc && !iface.description) iface.description = desc;
        const cfg = portsForSwitch.vlanByPort.get(iface.ifName);
        if (!cfg) continue;
        // Config truth wins over the SNMP-derived values -- but only where it
        // actually says something. A port the controller lists with no native
        // VLAN and no allow-list must not blank out what dot1qPvid reported;
        // that is the difference between "the CMDB disagrees" and "the CMDB is
        // silent about this port".
        if (cfg.nativeVlan != null) iface.nativeVlan = cfg.nativeVlan;
        if (cfg.taggedVlans.length > 0 || cfg.trunksAllVlans) iface.taggedVlans = cfg.taggedVlans;
        iface.trunksAllVlans = cfg.trunksAllVlans;
        overlaid++;
      }
      const trunkOverlaid = overlayFortiswitchTrunkMembers(
        data.interfaces,
        portsForSwitch.trunkMembers,
      );
      endVlan({ overlaid, total: data.interfaces.length, trunkLinks: trunkOverlaid, mclagPeers: portsForSwitch.mclagPeers.length });
    } else {
      endVlan({ overlaid: 0, total: data.interfaces.length, reason: "switch_not_in_cmdb" });
    }
  } catch (err: any) {
    endVlan({ overlaid: 0, total: data.interfaces.length, error: err?.message || String(err) });
  }
}

/**
 * FortiAP wireless-station signal overlay (SNMP interfaces path).
 * fapStationTable (SNMP) gives us the connected clients + band, but
 * per-client RSSI lives only on the controller's /api/v2/monitor/wifi/client.
 * One cached call per controller, joined onto the in-memory station list by
 * normalized MAC. Best-effort: any failure leaves signal/noise null.
 */
async function overlayFortiapStationSignals(
  asset: { assetType: string; fortinetTopology: unknown },
  integration: { type: string; config: unknown },
  data: SystemInfoSample,
  sysInfoTimeout: number,
): Promise<void> {
  if (asset.assetType !== "access_point") return;
  if (!Array.isArray(data.wirelessStations) || data.wirelessStations.length === 0) return;
  const controllerName = fortinetControllerNameOf(asset, integration);
  if (!controllerName) return;
  const endSignal = startPhase("systeminfo.snmp.wifi_signal_overlay_rest");
  try {
    const signals = await fetchFortinetWifiClients(integration as any, controllerName, sysInfoTimeout);
    let overlaid = 0;
    for (const st of data.wirelessStations) {
      const sig = signals.get(st.staMacAddr.toUpperCase());
      if (!sig) continue;
      st.signalStrength = sig.signalStrength;
      st.noise          = sig.noise;
      overlaid++;
    }
    endSignal({ overlaid, total: data.wirelessStations.length });
  } catch (err: any) {
    endSignal({ overlaid: 0, total: data.wirelessStations.length, error: err?.message || String(err) });
  }
}

/**
 * Cross-transport LLDP overlay: when the chosen LLDP source differs from the
 * interfaces transport the collection above already used, fetch the neighbor
 * list over LLDP's own transport and stamp it (with its source) onto the
 * sample. No-op when the transports agree or the overlay isn't applicable.
 */
async function overlayCrossTransportLldp(
  data: SystemInfoSample,
  opts: {
    targetIp: string;
    integration: { type: string; config: unknown } | null;
    interfacesPolling: string;
    lldpPolling: string | null;
    lldpSnmpCfg: Record<string, unknown> | null;
    isFortinetSrc: boolean;
    isManagedSwitchOrAp: boolean;
    sysInfoTimeout: number;
    /** The LLDP stream own per-gate REST token, when one is selected. */
    restCredential?: CredentialLike | null;
  },
): Promise<void> {
  const { targetIp, integration, interfacesPolling, lldpPolling, lldpSnmpCfg, isFortinetSrc, isManagedSwitchOrAp, sysInfoTimeout } = opts;
  if (lldpPolling === "snmp" && interfacesPolling === "rest_api" && lldpSnmpCfg) {
    const endOverlay = startPhase("systeminfo.lldp_overlay_snmp");
    const neighbors = await collectLldpOnlySnmp(targetIp, lldpSnmpCfg, sysInfoTimeout).catch(() => undefined);
    endOverlay({ neighbors: neighbors?.length ?? null });
    if (neighbors !== undefined) {
      data.lldpNeighbors = neighbors;
      data.lldpSource    = "snmp";
    }
  } else if (lldpPolling === "rest_api" && interfacesPolling === "snmp" && isFortinetSrc && integration && !isManagedSwitchOrAp) {
    const endOverlay = startPhase("systeminfo.lldp_overlay_rest");
    const neighbors = await collectLldpOnlyFortinet(targetIp, integration as any, sysInfoTimeout, opts.restCredential).catch(() => undefined);
    endOverlay({ neighbors: neighbors?.length ?? null });
    if (neighbors !== undefined) {
      data.lldpNeighbors = neighbors;
      data.lldpSource    = "fortios";
    }
  }
}

/**
 * FortiLink LLDP exclusion (opt-in per integration, default off). Drop LLDP
 * neighbors learned on FortiLink-enabled interfaces — the fortilink aggregate
 * + its member ports — so internal FortiGate↔FortiSwitch links don't clutter
 * the Neighbor column. Authoritative source is the CMDB `fortilink` flag.
 * FortiGate firewalls only (the CMDB query targets the polled device; managed
 * switches/APs carry no FortiGate CMDB here). The REST-interfaces path
 * already fetched CMDB (data.fortilinkInterfaces is set, possibly []); the
 * SNMP-interfaces path didn't, so we make one gated CMDB call. Peer-inferred
 * FortiLink rows are unaffected — they're synthesized from topology, not LLDP.
 */
async function applyFortilinkLldpExclusion(
  data: SystemInfoSample,
  opts: {
    targetIp: string;
    integration: { type: string; config: unknown } | null;
    isFortinetSrc: boolean;
    isManagedSwitchOrAp: boolean;
    sysInfoTimeout: number;
    /** The interfaces stream own per-gate REST token, when one is selected. */
    restCredential?: CredentialLike | null;
  },
): Promise<void> {
  const { targetIp, integration, isFortinetSrc, isManagedSwitchOrAp, sysInfoTimeout } = opts;
  if (
    !isFortinetSrc || !integration || isManagedSwitchOrAp ||
    ((integration as any).config as any)?.excludeFortilinkLldp !== true ||
    !Array.isArray(data.lldpNeighbors) || data.lldpNeighbors.length === 0
  ) {
    return;
  }
  const endFl = startPhase("systeminfo.lldp_fortilink_exclude");
  let fortilinkSet: Set<string> | null =
    data.fortilinkInterfaces !== undefined ? new Set(data.fortilinkInterfaces) : null;
  if (fortilinkSet === null) {
    const fg = buildFortinetConfig(targetIp, integration as any, opts.restCredential);
    fortilinkSet = "error" in fg ? new Set() : await fetchFortilinkInterfaceSet(fg, sysInfoTimeout).catch(() => new Set<string>());
  }
  const before = data.lldpNeighbors.length;
  if (fortilinkSet.size > 0) {
    data.lldpNeighbors = data.lldpNeighbors.filter((n) => !fortilinkSet!.has(n.localIfName));
  }
  endFl({ excluded: before - data.lldpNeighbors.length, fortilinkIfs: fortilinkSet.size });
}

export async function collectSystemInfo(assetId: string): Promise<CollectionResult<SystemInfoSample>> {
  const endLoad = startPhase("systeminfo.load_asset");
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    omit: PROBE_ASSET_OMIT,
    include: { monitorCredential: true, interfacesCredential: true, lldpCredential: true, discoveredByIntegration: true },
  });
  endLoad({ found: !!asset });
  if (!asset)            return { supported: false, error: "Asset not found" };
  if (!asset.monitored)  return { supported: false };

  const endResolve = startPhase("systeminfo.resolve_settings");
  const effective = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  endResolve();
  const interfacesPolling = effective.interfacesPolling;
  const lldpPolling       = effective.lldpPolling;
  // No interfaces stream → no system-info to collect. LLDP-only without an
  // interfaces context isn't meaningful (we'd have nothing to attach the
  // neighbors to in the System tab table).
  if (!interfacesPolling) return { supported: false };
  // Agent-mode: the Polaris Agent on the host pushes interface + storage +
  // LLDP samples on its own schedule. Periodic puller stays out of the way.
  if (interfacesPolling === "agent") return { supported: false };
  const sysInfoTimeout = effective.systemInfoTimeoutMs;

  // vCenter serves interfaces + storage out of the per-integration warm cache
  // and needs no asset IP — same reason the probe dispatches early. Dispatches
  // when EITHER stream is on the method: one reading answers both, so an
  // operator who routes interfaces elsewhere (or off) and leaves storage on
  // vCenter still gets their mounts, and the branch gates each stream on its
  // own resolved method.
  if (interfacesPolling === "vcenter" || effective.storagePolling === "vcenter") {
    return await collectSystemInfoVcenter(assetId, effective);
  }
  if (isWorkloadPollingMethod(interfacesPolling) || isWorkloadPollingMethod(effective.storagePolling)) {
    return await collectSystemInfoWorkload(assetId, effective);
  }
  // Generic API: each of interfaces / storage / LLDP from its own monitor
  // query, for whichever of them resolves to the method (rule 100(i)).
  if (interfacesPolling === "genericapi" || effective.storagePolling === "genericapi" || lldpPolling === "genericapi") {
    return await collectSystemInfoGenericApi(assetId, effective);
  }

  const targetIp =
    dial(asset) ||
    ((interfacesPolling === "winrm" || interfacesPolling === "ssh") ? (asset.dnsName || asset.hostname) : null);
  if (!targetIp) return { supported: false, error: "Asset has no IP address" };

  const integration   = asset.discoveredByIntegration ?? null;
  const isFortinetSrc = isFortinetIntegrationType(integration?.type);
  const isManagedSwitchOrAp = asset.assetType === "switch" || asset.assetType === "access_point";

  try {
    if (interfacesPolling === "rest_api" || interfacesPolling === "snmp") {
      // Mixed-transport branch: interfaces and LLDP can independently be
      // REST or SNMP. Per-stream credential wins, then asset default, then
      // integration fallback. Pre-load credentials for whichever streams need SNMP.
      const effectiveIfacesCred = asset.interfacesCredential ?? asset.monitorCredential;
      const effectiveLldpCred   = asset.lldpCredential        ?? asset.monitorCredential;
      let snmpCfg: Record<string, unknown> | null = null;     // for the shared session (interfaces SNMP path)
      let lldpSnmpCfg: Record<string, unknown> | null = null; // for LLDP-only cross-transport overlay
      if (interfacesPolling === "snmp") {
        const resolvedIf = await resolveSnmpConfigForStream(effectiveIfacesCred, effective.interfacesCredentialId, isFortinetSrc, integration);
        if (resolvedIf.error !== undefined) {
          return { supported: true, error: resolvedIf.error };
        }
        snmpCfg = resolvedIf.cfg;
      }
      if (lldpPolling === "snmp") {
        if (interfacesPolling === "snmp") {
          // Same SNMP session covers LLDP; lldpSnmpCfg stays null (snmpCfg is used).
        } else {
          // Cross-transport: LLDP needs its own session with the LLDP credential.
          const resolvedLldp = await resolveSnmpConfigForStream(effectiveLldpCred, effective.lldpCredentialId, isFortinetSrc, integration, "No SNMP credential selected for LLDP stream");
          if (resolvedLldp.error !== undefined) {
            return { supported: true, error: resolvedLldp.error };
          }
          lldpSnmpCfg = resolvedLldp.cfg;
        }
      }
      // REST API for interfaces requires a Fortinet integration.
      if (interfacesPolling === "rest_api" && (!isFortinetSrc || !integration)) {
        return { supported: false };
      }
      // Managed FortiSwitches / FortiAPs aren't directly REST-able. Same
      // guard as collectTelemetry / collectFastFiltered — operators flip the
      // integration's FortiSwitches / FortiAPs subtab to direct SNMP polling
      // (which sets interfacesPolling to "snmp" via the integration tier or
      // a class override) to enable this stream on those asset types.
      if (interfacesPolling === "rest_api" && isManagedSwitchOrAp) {
        return { supported: false };
      }

      let data: SystemInfoSample;
      if (interfacesPolling === "snmp") {
        // SNMP-path interfaces+storage. Fetch LLDP via the same session iff
        // the LLDP polling agrees; otherwise leave it out and overlay below.
        const endSnmp = startPhase("systeminfo.snmp.session");
        data = await collectSystemInfoSnmp(targetIp, snmpCfg!, {
          includeLldp:  lldpPolling === "snmp",
          timeoutMs:    sysInfoTimeout,
          manufacturer: asset.manufacturer,
          model:        asset.model,
          os:           asset.os,
          assetType:    asset.assetType,
        });
        endSnmp({ interfaces: data.interfaces.length, storage: data.storage.length, lldp: data.lldpNeighbors?.length ?? null });
        if (isFortinetSrc && integration) {
          applyFortiInterfaceFilter(data.interfaces, integration as any);
          // IPsec always via REST when the source is Fortinet — SNMP has no equivalent.
          // BUT skip managed FortiSwitches / FortiAPs: they aren't directly REST-able
          // (their telemetry / system-info lives on the parent FortiGate) and they have
          // no IPsec. Without this guard the overlay fires a FortiOS REST call straight
          // at the switch/AP's own IP:443 every system-info pass — a standalone GUI
          // listener accepts the TCP/TLS handshake but never answers the API call,
          // leaving idle sockets and hammering the device's weak management CPU
          // (prod incident: FortiSwitch ICMP packet loss). Same !isManagedSwitchOrAp
          // guard the REST telemetry / system-info / fast-filtered paths already use.
          if (!isManagedSwitchOrAp) {
            const endIpsec = startPhase("systeminfo.snmp.ipsec_overlay_rest");
            const ipsec = await collectIpsecOnlyFortinetSafe(
              targetIp, integration as any, sysInfoTimeout,
              pickRestApiCredential(asset.interfacesCredential, asset.monitorCredential),
              { includeSslVpn: asset.assetType === "firewall" },
            );
            endIpsec({ tunnels: ipsec?.tunnels.length ?? null, connections: ipsec?.connections?.length ?? null });
            if (ipsec !== undefined) {
              data.ipsecTunnels     = ipsec.tunnels;
              data.ipsecConnections = ipsec.connections;
              data.sslVpnSessions   = ipsec.sslVpnSessions;
            }
          }
          await overlayFortiswitchCmdbOntoSnmp(asset, integration, data, sysInfoTimeout);
          await overlayFortiapStationSignals(asset, integration, data, sysInfoTimeout);
        }
      } else {
        // FortiOS REST path. Skip the FortiOS LLDP call when LLDP is on SNMP.
        const endRest = startPhase("systeminfo.rest.fortinet");
        data = await collectSystemInfoFortinet(targetIp, integration as any, {
          includeIpsec: true,
          includeLldp:  lldpPolling === "rest_api",
          // SD-WAN is NOT collected here any more: it has its own cadence
          // (runSdwanFor, default 60s) so SLA readings no longer wait on the
          // interface scrape's 10-minute default.
          // Firewall-class only, matching where the SNMP branch gates it.
          includeArp:   asset.assetType === "firewall",
          // Remote-access users only exist on a gate.
          includeSslVpn: asset.assetType === "firewall",
          timeoutMs:    sysInfoTimeout,
        }, pickRestApiCredential(asset.interfacesCredential, asset.monitorCredential));
        endRest({ interfaces: data.interfaces.length, ipsec: data.ipsecTunnels?.length ?? null, lldp: data.lldpNeighbors?.length ?? null });
      }

      await overlayCrossTransportLldp(data, {
        targetIp, integration, interfacesPolling, lldpPolling, lldpSnmpCfg,
        isFortinetSrc, isManagedSwitchOrAp, sysInfoTimeout,
        restCredential: pickRestApiCredential(asset.lldpCredential, asset.monitorCredential),
      });
      // Storage stream is independent of interfaces. Storage rows only come
      // from the SNMP path (HOST-RESOURCES-MIB + vendor disk fallback); when
      // the operator has storage routed anywhere but SNMP — including the
      // FMG/FortiGate source default of "disabled" — drop the rows the SNMP
      // walk produced as a side effect of the interfaces query.
      if (effective.storagePolling !== "snmp") {
        data.storage = [];
      }
      await applyFortilinkLldpExclusion(data, {
        targetIp, integration, isFortinetSrc, isManagedSwitchOrAp, sysInfoTimeout,
        restCredential: pickRestApiCredential(asset.interfacesCredential, asset.monitorCredential),
      });
      return { supported: true, data };
    }
    // Agentless interfaces + storage over SSH (sysfs / df) or WinRM
    // (Get-NetAdapter / Get-Volume). Both streams ride ONE connection, which is
    // the whole point at fleet scale — the handshake dominates, not the parse.
    // Storage is gated on its own resolved method, like every other path here.
    if (interfacesPolling === "ssh" || interfacesPolling === "winrm") {
      const method = interfacesPolling;
      const cred = await resolveAgentlessCredConfig(
        asset.interfacesCredential ?? asset.monitorCredential,
        effective.interfacesCredentialId,
        method,
        adBindFallbackIntegration(asset, integration),
      );
      if (!cred) return { supported: true, error: `No ${method === "ssh" ? "SSH" : "WinRM"} credential selected` };
      const wantStorage = effective.storagePolling === method;
      const opts = { telemetry: false, interfaces: true, storage: wantStorage, timeoutMs: sysInfoTimeout };
      const res = method === "ssh"
        ? await collectHostSsh(targetIp, cred, opts)
        : await collectHostWinrm(winrmConnFrom(targetIp, cred, sysInfoTimeout), opts);
      // `undefined` from a failed command means "leave stored rows alone";
      // only an empty ARRAY is a successful scrape that found nothing.
      return {
        supported: true,
        data: {
          interfaces: res.interfaces ?? [],
          storage: wantStorage ? (res.storage ?? []) : [],
        },
      };
    }
    // icmp — no payload to gather.
    return { supported: false };
  } catch (err: any) {
    return { supported: true, error: err?.message || "System info collection failed" };
  }
}

// ─── FortiOS collectors ─────────────────────────────────────────────────────
//
// FortiOS exposes CPU and memory only as percentages via the resource/usage
// monitor, so memUsedBytes/memTotalBytes are left null. The interface monitor
// returns the cumulative tx/rx counters and link state. There's no real
// notion of mountable storage on a FortiGate, so the storage list stays empty.

/**
 * Assemble the auth for a direct FortiOS REST call against `host`.
 *
 * Two token sources, in this order:
 *
 *   1. `credential` — a `restapi`-typed Credential the operator selected on
 *      THIS asset's stream. Per-gate by nature, and the only way to poll a
 *      fleet where every gate carries its own api-user.
 *   2. the integration's own stored token — fleet-wide by construction (the
 *      FMG Monitoring tab says so in as many words), which is why (1) exists.
 *
 * The credential supplies auth + port + TLS verification only; `host` is
 * always the caller's, i.e. the asset's own address. See
 * utils/fortinetRestCredential.ts for why its baseUrl host is deliberately
 * not honoured here.
 */
function buildFortinetConfig(
  host: string,
  integration: { type: string; config: Record<string, unknown> },
  credential?: CredentialLike | null,
): FortiGateConfig | { error: string } {
  const cfg = integration.config || {};
  const cred = pickRestApiCredential(credential);
  if (cred) {
    const auth = restApiCredentialAuth(cred.config);
    if ("error" in auth) return auth;
    return { host, ...auth };
  }
  let apiUser  = "";
  let apiToken = "";
  if (integration.type === "fortimanager") {
    apiUser  = String(cfg.fortigateApiUser  || "");
    apiToken = String(cfg.fortigateApiToken || "");
    if (!apiToken) return { error: "No FortiGate API token: this FortiManager integration has none configured (Monitoring tab), and this asset's stream has no REST API credential selected" };
  } else {
    apiUser  = String(cfg.apiUser  || "");
    apiToken = String(cfg.apiToken || "");
    if (!apiToken) return { error: "No FortiGate API token: this integration has none configured, and this asset's stream has no REST API credential selected" };
  }
  return {
    host,
    apiUser,
    apiToken,
    verifySsl: cfg.verifySsl !== true ? false : true,
  };
}

async function collectTelemetryFortinet(host: string, integration: { type: string; config: Record<string, unknown> }, timeoutMs?: number, credential?: CredentialLike | null): Promise<TelemetrySample> {
  const fg = buildFortinetConfig(host, integration, credential);
  if ("error" in fg) throw new AppError(409, fg.error);

  // /api/v2/monitor/system/resource/usage returns a `results` object keyed by
  // resource name (cpu, mem, disk, session, ...). Each entry can be either an
  // array of {interval, current, historical} samples or a single object,
  // depending on FortiOS version. Pull whatever's freshest.
  //
  // Hardware sensors are NOT pulled here — collectHardwareSensors dispatches on
  // its own polling method (which may resolve to SNMP even when CPU/memory is
  // on REST, e.g. when /api/v2/monitor/system/sensor-info is unreliable on the
  // branch-class FortiGate and the operator routes hardware sensors to SNMP).
  const res = await fgRequest<any>(fg, "GET", "/api/v2/monitor/system/resource/usage", { query: { scope: "global" }, timeoutMs });
  const cpuPct = pickFortinetUsage(res?.cpu);
  const memPct = pickFortinetUsage(res?.mem ?? res?.memory);
  // Session count rides the same response. It's an absolute count, not a
  // percentage — pull it without the 0-100 clamp.
  const sessionCount = pickFortinetUsage(res?.session, false);
  return { cpuPct, memPct, memUsedBytes: null, memTotalBytes: null, sessionCount };
}

// FortiOS exposes temperature, fan, voltage, and power sensors at one endpoint.
// We keep EVERY sensor (not just temperature), classifying by the device's own
// `type` field when present (name heuristic otherwise) and capturing the alarm
// flag. Older FortiOS firmwares 404 this endpoint — caller swallows the failure.
async function collectHardwareSensorsFortinet(fg: FortiGateConfig, timeoutMs?: number): Promise<HardwareSensorSample[]> {
  const res = await fgRequest<any>(fg, "GET", "/api/v2/monitor/system/sensor-info", { timeoutMs });
  const list: HardwareSensorSample[] = [];
  const arr = Array.isArray(res) ? res : (Array.isArray(res?.results) ? res.results : []);
  for (const s of arr) {
    if (!s || typeof s !== "object") continue;
    const obj  = s as Record<string, unknown>;
    const name = String(obj.name || "").trim();
    if (!name) continue;
    const restType = obj.type != null ? String(obj.type) : null;
    const { sensorClass, unit } = classifyHardwareSensor(name, restType);
    const value = obj.value;
    const n = typeof value === "number" ? value : (typeof value === "string" ? Number(value) : NaN);
    list.push({
      sensorName:  name,
      sensorClass,
      value:       Number.isFinite(n) ? Math.round((n as number) * 1000) / 1000 : null,
      unit,
      alarmStatus: normalizeRestAlarmStatus(obj.alarm ?? obj.alarm_status ?? obj.status),
    });
  }
  return list;
}

// Extract the freshest gauge value from a FortiOS resource/usage node.
// `clamp` (default true) folds the value into 0-100 for percentages (cpu/mem);
// pass false for absolute counts (e.g. session count).
function pickFortinetUsage(node: unknown, clamp = true): number | null {
  const conv = (n: number): number | null =>
    clamp ? clampPct(n) : (Number.isFinite(n) ? n : null);
  if (node == null) return null;
  // Flat number?
  if (typeof node === "number" && Number.isFinite(node)) return conv(node);
  // Object with `current`?
  if (typeof node === "object" && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    if (typeof obj.current === "number") return conv(obj.current);
    // historical may be the freshest; take the last entry
    if (Array.isArray(obj.historical) && obj.historical.length > 0) {
      const last = obj.historical[obj.historical.length - 1];
      if (typeof last === "number") return conv(last);
    }
  }
  // Array of {interval, current, historical} — pick the entry with shortest
  // interval (typically "1-min"), falling back to the first.
  if (Array.isArray(node) && node.length > 0) {
    const sorted = [...node].sort((a, b) => intervalRank(a?.interval) - intervalRank(b?.interval));
    for (const entry of sorted) {
      if (entry == null) continue;
      if (typeof entry.current === "number") return conv(entry.current);
      if (Array.isArray(entry.historical) && entry.historical.length > 0) {
        const last = entry.historical[entry.historical.length - 1];
        if (typeof last === "number") return conv(last);
      }
    }
  }
  return null;
}

function intervalRank(s: unknown): number {
  // 1-min < 10-min < 30-min < 1-hour < 1-day < anything else
  switch (s) {
    case "1-min":  return 0;
    case "10-min": return 1;
    case "30-min": return 2;
    case "1-hour": return 3;
    case "1-day":  return 4;
    default:       return 5;
  }
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n * 100) / 100;
}

// ─── FortiOS interface parse/merge cores (split 2026-08) ────────────────────
// Pure functions over the two REST payloads (CMDB system/interface + monitor
// system/interface) so the payload quirks — hyphenated member keys, the
// ipv4_addresses vs legacy `ip` fallback, Mbps→bps, aggregate-member
// synthesis — are unit-testable with fixtures
// (tests/unit/fortiInterfaceParse.test.ts). collectSystemInfoFortinet keeps
// the transport fan-out + error semantics.

export interface FortiCmdbInterfaceEntry {
  type: string | null;
  parent: string | null;
  vlanId: number | null;
  members: string[];
  alias: string | null;
  description: string | null;
  addressingMode: string | null;
  /** The CMDB's `status` — "up" | "down" — which is the ADMIN status, i.e.
   *  whether the interface is configured up at all.
   *
   *  It has to come from here because the MONITOR endpoint does not carry it:
   *  `/api/v2/monitor/system/interface` reports `link` (the oper status) and
   *  nothing else status-shaped. Confirmed on FortiOS 7.6.7 against the lab
   *  gates — the monitor payload's `status` is `undefined` on every entry,
   *  while the CMDB's is "up"/"down" on all of them. */
  adminStatus: string | null;
  /** The CMDB's configured IPv4 address, bare (mask stripped), or null when
   *  unset / 0.0.0.0. Only read for interfaces the monitor endpoint omits —
   *  see `backfillFortiCmdbOnlyTunnels`; the monitor's runtime IP wins
   *  everywhere else. */
  ipAddress: string | null;
  /** The interface's configured secondary IPv4 addresses (CMDB `secondary-ip`
   *  child table), bare, in CMDB order; empty when there are none. The
   *  monitor endpoint does not say which of an interface's addresses is the
   *  secondary, so this is the only source of that distinction. */
  secondaryIps: string[];
  /** The CMDB's configured IPv6 (`ipv6.ip6-address`, else the first
   *  `ip6-extra-addr`), via utils/fortiosIpv6.ts → parseInterfaceIpv6;
   *  null when unset / link-local. The monitor endpoint carries no IPv6 at
   *  all (FortiOS 7.6.7 / 8.0.1), so this is the interface's only IPv6
   *  source on both transports (business rule 126). A dhcp / pppoe /
   *  delegated interface's IPv6 is runtime state the CMDB does not hold. */
  ipv6Address: string | null;
  /** A `type tunnel` interface's underlay (CMDB `interface`, e.g. "wan1");
   *  null for every other type and for FortiOS's built-in per-VDOM
   *  pseudo-tunnels (`ssl.root`, `l2t.root`, `naf.root`), which carry none. */
  tunnelUnderlay: string | null;
}

/**
 * Build the name → CMDB-metadata map from a `/api/v2/cmdb/system/interface`
 * response. Tolerates both the bare-array and `{results: []}` envelope
 * shapes; a null/failed response yields an empty map (callers fall back to
 * monitor-only types — same as the original try/catch).
 */
export function parseFortiCmdbInterfaceTable(cmdbRes: unknown): Map<string, FortiCmdbInterfaceEntry> {
  const cmdbByName = new Map<string, FortiCmdbInterfaceEntry>();
  if (!cmdbRes) return cmdbByName;
  const arr = Array.isArray(cmdbRes)
    ? cmdbRes
    : (Array.isArray((cmdbRes as any)?.results) ? (cmdbRes as any).results : []);
  for (const c of arr) {
    if (!c || typeof c !== "object" || typeof c.name !== "string") continue;
    const t = typeof c.type === "string" ? c.type : null;
    // CMDB `member` is an array of { "interface-name": "<port>" } entries on
    // aggregate and hard-switch / vap-switch interfaces. The FortiOS REST
    // envelope returns the key with a hyphen — the JS-friendly underscore
    // form (`interface_name`) doesn't exist, and accessing it would silently
    // yield undefined, collapsing the members list to empty. `q_origin_key`
    // duplicates the value for the table's primary key, so it's a reliable
    // fallback when a firmware variant drops `interface-name`.
    const members: string[] = Array.isArray(c.member)
      ? c.member.map((m: any) => {
          if (typeof m === "string") return m;
          if (m && typeof m === "object") {
            if (typeof m["interface-name"] === "string") return m["interface-name"];
            if (typeof m.q_origin_key  === "string") return m.q_origin_key;
            if (typeof m.interface_name === "string") return m.interface_name;
          }
          return null;
        }).filter(Boolean)
      : [];
    const alias       = typeof c.alias       === "string" && c.alias.trim()       ? c.alias.trim()       : null;
    const description = typeof c.description === "string" && c.description.trim() ? c.description.trim() : null;
    // L3 addressing mode — CMDB `mode` is "static" | "dhcp" | "pppoe". Keep
    // only known values so a firmware-specific surprise doesn't leak into the
    // UI; anything else (or absent) leaves addressingMode null.
    const rawMode = typeof c.mode === "string" ? c.mode.trim().toLowerCase() : "";
    const addressingMode = (rawMode === "static" || rawMode === "dhcp" || rawMode === "pppoe") ? rawMode : null;
    // Only the two values FortiOS actually uses; anything else is treated as
    // unknown rather than passed through, for the same reason `mode` is.
    const rawStatus = typeof c.status === "string" ? c.status.trim().toLowerCase() : "";
    const adminStatus = rawStatus === "up" || rawStatus === "down" ? rawStatus : null;
    // FortiOS REST gives `ip` as "x.x.x.x y.y.y.y"; tolerate the [ip, mask]
    // array shape the FMG device DB uses.
    const rawIp = Array.isArray(c.ip) ? c.ip[0] : c.ip;
    const ipAddress = typeof rawIp === "string" && !interfaceIpIsUnaddressed(rawIp)
      ? bareInterfaceIp(rawIp)
      : null;
    // Secondary rows carry their own `ip` in the same two shapes. FortiOS REST
    // spells the table `secondary-IP` — see utils/fortiosSecondaryIp.ts.
    const secondaryIps: string[] = [];
    for (const rawSec of fortiosSecondaryIpStrings(c)) {
      if (interfaceIpIsUnaddressed(rawSec)) continue;
      const bare = bareInterfaceIp(rawSec);
      if (bare !== ipAddress && !secondaryIps.includes(bare)) secondaryIps.push(bare);
    }
    cmdbByName.set(c.name, {
      type:    t,
      parent:  t === "vlan" && typeof c.interface === "string" ? c.interface : null,
      vlanId:  t === "vlan" && typeof c.vlanid === "number" ? c.vlanid : null,
      members,
      alias,
      description,
      addressingMode,
      adminStatus,
      ipAddress,
      secondaryIps,
      ipv6Address: parseInterfaceIpv6(c).addresses[0]?.ipAddress ?? null,
      tunnelUnderlay: t === "tunnel" && typeof c.interface === "string" && c.interface.trim() ? c.interface.trim() : null,
    });
  }
  return cmdbByName;
}

/**
 * A software switch's member ports live in `/api/v2/cmdb/system/switch-interface`,
 * not on its `system/interface` row (which carries `type: "switch"` and no
 * `member`, unlike a hardware switch). Copy them onto the CMDB map's entry so
 * `backfillFortiAggregateMembers` nests them under the switch like any other
 * bundle. Only entries the interface table already knows are touched, and an
 * entry that already has members keeps them. Tolerates both REST envelopes; a
 * failed read (null) changes nothing. Mutates `cmdbByName` in place.
 */
export function applyFortiSoftwareSwitchMembers(
  cmdbByName: Map<string, FortiCmdbInterfaceEntry>,
  switchIfaceRes: unknown,
): void {
  if (!switchIfaceRes) return;
  const rows = Array.isArray(switchIfaceRes)
    ? switchIfaceRes
    : (Array.isArray((switchIfaceRes as any)?.results) ? (switchIfaceRes as any).results : []);
  for (const r of rows) {
    if (!r || typeof r !== "object" || typeof r.name !== "string") continue;
    const entry = cmdbByName.get(r.name);
    if (!entry || entry.members.length > 0) continue;
    const members: string[] = Array.isArray(r.member)
      ? r.member.map((m: any) => {
          if (typeof m === "string") return m;
          if (m && typeof m === "object") {
            if (typeof m["interface-name"] === "string") return m["interface-name"];
            if (typeof m.q_origin_key === "string") return m.q_origin_key;
          }
          return null;
        }).filter(Boolean)
      : [];
    if (members.length > 0) entry.members = members;
  }
}

/**
 * Merge the `/api/v2/monitor/system/interface` payload with the CMDB map
 * into InterfaceSample rows. CMDB type/parent/vlanid/alias/description win;
 * the monitor payload supplies runtime state (link, counters, IP, MAC,
 * speed — reported in Mbps, converted to bps here).
 */
export function buildFortiInterfaceSamples(
  monitorObj: Record<string, any>,
  cmdbByName: Map<string, FortiCmdbInterfaceEntry>,
): InterfaceSample[] {
  const interfaces: InterfaceSample[] = [];
  for (const [name, info] of Object.entries(monitorObj)) {
    if (!info || typeof info !== "object") continue;
    const i = info as any;
    // Pick the first IPv4 if the device exposes a list, else fall back to the legacy `ip` string.
    let ip: string | null = null;
    if (Array.isArray(i.ipv4_addresses) && i.ipv4_addresses.length > 0) {
      const a = i.ipv4_addresses[0];
      ip = typeof a === "string" ? a : (a?.ip || null);
    } else if (typeof i.ip === "string") {
      ip = i.ip.split(" ")[0];
    }
    const speedMbps = typeof i.speed === "number" ? i.speed : null;
    // Prefer CMDB type/parent/vlanid; fall back to whatever the monitor
    // payload happened to include.
    const cmdbEntry = cmdbByName.get(name);
    const rawType   = cmdbEntry?.type ?? (typeof i.type === "string" ? i.type : null);
    const rawParent = cmdbEntry?.parent ?? (i.type === "vlan" && typeof i.interface === "string" ? i.interface : null);
    const rawVlanId = cmdbEntry?.vlanId ?? (i.type === "vlan" && typeof i.vlanid === "number" ? i.vlanid : null);
    interfaces.push({
      ifName:      name,
      // CMDB FIRST, exactly like type/parent/vlanId above. The monitor payload
      // has no `status` field at all on FortiOS 7.6.7 — it carries `link` and
      // nothing else status-shaped — so reading it from `i` alone left
      // adminStatus null on every interface of every standalone FortiGate.
      //
      // That was not a cosmetic gap: business rule 57 skips an `ifOperStatus`
      // reading whose adminStatus is not "up" (an admin-downed port is
      // deliberately down, not an outage), so a null silently disabled EVERY
      // interface-down automation on a standalone-discovered gate. The
      // automation saved, looked correct on the Devices step, and never fired.
      // Found against the lab gates 2026-09-21; the monitor fallback stays for
      // any firmware that does populate it.
      adminStatus: cmdbEntry?.adminStatus
        ?? (i.status === "down" ? "down" : i.status === "up" ? "up" : (i.status ?? null)),
      operStatus:  i.link === false ? "down" : i.link === true ? "up" : null,
      speedBps:    speedMbps != null ? Math.round(speedMbps * 1_000_000) : null,
      duplex:      fortiMonitorDuplex(i.link, i.duplex),
      ipAddress:   ip,
      // Only the CMDB knows which addresses are secondary; without it the
      // field stays undefined ("not known") rather than claiming "none".
      secondaryIps: cmdbEntry ? cmdbEntry.secondaryIps.filter((s) => s !== ip) : undefined,
      ipv6Address: cmdbEntry?.ipv6Address ?? null,
      macAddress:  typeof i.mac === "string" ? i.mac.toUpperCase() : null,
      inOctets:    toFiniteOrNull(i.rx_bytes),
      outOctets:   toFiniteOrNull(i.tx_bytes),
      inErrors:    toFiniteOrNull(i.rx_errors  ?? i.errors_in),
      outErrors:   toFiniteOrNull(i.tx_errors  ?? i.errors_out),
      ifType:      normalizeFortiIfType(rawType),
      ifSubtype:   fortiIfSubtype(rawType),
      ifParent:    rawParent,
      vlanId:      rawVlanId,
      alias:       cmdbEntry?.alias       ?? null,
      description: cmdbEntry?.description ?? null,
      addressingMode: cmdbEntry?.addressingMode ?? null,
    });
  }
  return interfaces;
}

/**
 * FortiOS monitor `duplex` → "full" | "half" | null. The field is numeric:
 * 1 on a full-duplex link that is up, 0 on a link that is down (confirmed on
 * FortiOS 7.6.7 and 8.0.1 against the lab gates). 0 on a link that IS up can
 * only be half duplex. A down link has no duplex at all, so `link` gates it.
 */
export function fortiMonitorDuplex(link: unknown, duplex: unknown): string | null {
  if (link !== true || typeof duplex !== "number") return null;
  if (duplex === 1) return "full";
  if (duplex === 0) return "half";
  return null;
}

/**
 * Back-fill ifParent on member ports of aggregate / hard-switch / vap-switch
 * interfaces. CMDB carries the canonical `member` array; we also accept the
 * monitor-side `member` array as a fallback.
 *
 * Member ports owned by an aggregate (the `set members "port15" "port16"`
 * ports under FortiLink) are typically *omitted* from the monitor endpoint —
 * FortiOS treats them as subordinate to the aggregate and doesn't surface
 * them as standalone interfaces. CMDB still lists them. For those, synthesize
 * a row from CMDB metadata so the System tab tree can render them nested
 * under their aggregate; runtime fields stay null because the monitor
 * endpoint never returned counters for them. Mutates `interfaces` in place.
 */
export function backfillFortiAggregateMembers(
  interfaces: InterfaceSample[],
  monitorObj: Record<string, any>,
  cmdbByName: Map<string, FortiCmdbInterfaceEntry>,
): void {
  const ifMap = new Map(interfaces.map((s) => [s.ifName, s]));
  for (const iface of interfaces.slice()) {
    if (iface.ifType !== "aggregate") continue;
    const cmdbEntry = cmdbByName.get(iface.ifName);
    const monitorEntry = monitorObj[iface.ifName] as any;
    const members =
      cmdbEntry?.members.length ? cmdbEntry.members :
      Array.isArray(monitorEntry?.member) ? monitorEntry.member.map(String) : [];
    for (const memberName of members) {
      const memberStr = String(memberName);
      const existing = ifMap.get(memberStr);
      if (existing) {
        if (!existing.ifParent) existing.ifParent = iface.ifName;
        continue;
      }
      const memberCmdb = cmdbByName.get(memberStr);
      const synthetic: InterfaceSample = {
        ifName:      memberStr,
        adminStatus: null,
        operStatus:  null,
        speedBps:    null,
        ipAddress:   null,
        macAddress:  null,
        inOctets:    null,
        outOctets:   null,
        inErrors:    null,
        outErrors:   null,
        ifType:      memberCmdb?.type ? normalizeFortiIfType(memberCmdb.type) : "physical",
        ifParent:    iface.ifName,
        vlanId:      memberCmdb?.vlanId ?? null,
        alias:       memberCmdb?.alias ?? null,
        description: memberCmdb?.description ?? null,
      };
      interfaces.push(synthetic);
      ifMap.set(memberStr, synthetic);
    }
  }
}

/**
 * Synthesize a row for a CMDB bundle the monitor endpoint omitted. FortiOS's
 * `/api/v2/monitor/system/interface` leaves a SOFTWARE switch out entirely
 * while listing its member ports and the VLANs on it (FortiOS 7.6.8, HUB1-a,
 * 2026-10-28: `Software Switch` absent, `a` / `b` / `LabSSProd` present), so
 * without this the switch never reached the inventory and its members never
 * nested. Built from the CMDB alone — admin status, configured address, alias,
 * description — with no runtime state, exactly like the tunnel back-fill
 * below. Run BEFORE `backfillFortiAggregateMembers`, which then nests the
 * members under it. A bundle the monitor did report is left alone. Mutates
 * `interfaces` in place.
 */
export function backfillFortiCmdbOnlyBundles(
  interfaces: InterfaceSample[],
  cmdbByName: Map<string, FortiCmdbInterfaceEntry>,
): void {
  const present = new Set(interfaces.map((s) => s.ifName));
  for (const [name, c] of cmdbByName) {
    const subtype = fortiIfSubtype(c.type);
    if (!subtype || present.has(name)) continue;
    interfaces.push({
      ifName:      name,
      adminStatus: c.adminStatus,
      operStatus:  null,
      speedBps:    null,
      ipAddress:   c.ipAddress,
      secondaryIps: c.secondaryIps,
      ipv6Address: c.ipv6Address,
      macAddress:  null,
      inOctets:    null,
      outOctets:   null,
      inErrors:    null,
      outErrors:   null,
      ifType:      "aggregate",
      ifSubtype:   subtype,
      ifParent:    null,
      vlanId:      null,
      alias:       c.alias,
      description: c.description,
      addressingMode: c.addressingMode,
    });
    present.add(name);
  }
}

/**
 * Synthesize rows for CMDB `type tunnel` interfaces the monitor endpoint
 * omitted — IPsec phase1-interfaces (site-to-site, dial-up and ADVPN hub /
 * spoke overlays), plus GRE / VXLAN, which FortiOS also types `tunnel`.
 *
 * `/api/v2/monitor/system/interface` leaves these out, so on a REST-polled
 * gate they never reached `asset_interfaces`: the System tab didn't list
 * them and the overlay addresses configured on them (`set ip 10.255.0.1
 * 255.255.255.255`) were never tied to the firewall. The CMDB read that
 * already runs alongside the monitor one carries both the name and the `ip`.
 *
 * Runtime fields stay null — the CMDB has no link state or counters, and the
 * tunnel's real state is its SA, which the IPsec stream owns (an SNMP
 * ifOperStatus "up" is meaningless for the same reason). The per-instance
 * shortcut interfaces ADVPN spawns at runtime (`<name>_0`, `<name>_1`…) are
 * not CMDB rows and are not synthesized; they carry the parent's address.
 * A tunnel the monitor DID report is left alone. Mutates `interfaces` in place.
 *
 * A tunnel with neither an address nor an underlay is skipped: that is the
 * shape of FortiOS's built-in per-VDOM pseudo-tunnels (`ssl.root`,
 * `l2t.root`, `naf.root`), present on every gate and never what an operator
 * means by a tunnel. An unnumbered route-based IPsec interface still has its
 * underlay, so it is kept. Confirmed against the FortiOS 7.6.7 lab gates.
 */
export function backfillFortiCmdbOnlyTunnels(
  interfaces: InterfaceSample[],
  cmdbByName: Map<string, FortiCmdbInterfaceEntry>,
): void {
  const present = new Set(interfaces.map((s) => s.ifName));
  for (const [name, c] of cmdbByName) {
    if (c.type !== "tunnel" || present.has(name)) continue;
    if (!c.ipAddress && !c.ipv6Address && !c.tunnelUnderlay) continue;
    interfaces.push({
      ifName:      name,
      adminStatus: c.adminStatus,
      operStatus:  null,
      speedBps:    null,
      ipAddress:   c.ipAddress,
      secondaryIps: c.secondaryIps,
      ipv6Address: c.ipv6Address,
      macAddress:  null,
      inOctets:    null,
      outOctets:   null,
      inErrors:    null,
      outErrors:   null,
      ifType:      "tunnel",
      ifParent:    null,
      vlanId:      null,
      alias:       c.alias,
      description: c.description,
      addressingMode: c.addressingMode,
    });
    present.add(name);
  }
}

async function collectSystemInfoFortinet(
  host: string,
  integration: { type: string; config: Record<string, unknown> },
  opts: { includeIpsec?: boolean; includeLldp?: boolean; includeArp?: boolean; includeSslVpn?: boolean; timeoutMs?: number } = {},
  credential?: CredentialLike | null,
): Promise<SystemInfoSample> {
  const fg = buildFortinetConfig(host, integration, credential);
  if ("error" in fg) throw new AppError(409, fg.error);
  const timeoutMs = opts.timeoutMs;

  // Fan out every independent FortiOS REST call in parallel. The merge logic
  // (cmdb + monitor → interfaces[]) only depends on both responses being
  // available, not on serial ordering of the requests. Sequencing them used
  // to make a healthy host's collection 5× longer than necessary; on a
  // wedged host it stacked their 15s timeouts (~75s total) instead of
  // running them concurrently (~15s).
  //
  // Per-stream error handling is preserved: cmdb fetch returns null on any
  // failure (token without cmdb scope is the common case), ipsec and lldp
  // each have their own .catch fallback, and the monitor-interface error
  // is captured and only re-thrown if it would have ended up with an empty
  // interfaces[] (matching the prior behavior where monitor failure with
  // no interfaces threw, but partial success returned).
  const endCmdb = startPhase("systeminfo.rest.cmdb_interface");
  const cmdbInterfacePromise = fgRequest<any>(fg, "GET", "/api/v2/cmdb/system/interface", { query: { vdom: "root", format: FORTIOS_INTERFACE_CMDB_FORMAT }, timeoutMs })
    .catch(() => null as any)
    .then((res) => { endCmdb({ ok: res != null }); return res; });
  // Software switch members (applyFortiSoftwareSwitchMembers). Best-effort: a
  // gate with none returns an empty list, a token without the scope fails and
  // the switch simply shows without nested members.
  const endSwitchIf = startPhase("systeminfo.rest.cmdb_switch_interface");
  const switchInterfacePromise = fgRequest<any>(fg, "GET", "/api/v2/cmdb/system/switch-interface", { query: { vdom: "root" }, timeoutMs })
    .catch(() => null as any)
    .then((res) => { endSwitchIf({ ok: res != null }); return res; });
  const endMonitorIf = startPhase("systeminfo.rest.monitor_interface");
  const monitorInterfacePromise = fgRequest<any>(fg, "GET", "/api/v2/monitor/system/interface", {
    query: { scope: "vdom", include_vlan: "true", include_aggregate: "true" },
    timeoutMs,
  })
    .then((res) => { endMonitorIf({ ok: true }); return { ok: true as const, res }; })
    .catch((err) => { endMonitorIf({ ok: false }); return { ok: false as const, err }; });
  const ipsecPromise = opts.includeIpsec
    ? (() => {
        const endIpsec = startPhase("systeminfo.rest.ipsec");
        // A failed read keeps the old contract for tunnels ([] — no samples
        // this pass) but leaves the connection halves undefined, so the
        // IPsec tab keeps its last answer instead of blanking.
        return collectIpsecFortinet(fg, timeoutMs, { includeSslVpn: opts.includeSslVpn })
          .catch((): FortiIpsecCollection => ({ tunnels: [], connections: undefined, sslVpnSessions: undefined }))
          .then((r) => { endIpsec({ tunnels: r.tunnels.length, connections: r.connections?.length ?? null }); return r; });
      })()
    : Promise.resolve<FortiIpsecCollection | undefined>(undefined);
  const lldpPromise = opts.includeLldp !== false
    ? (() => {
        const endLldp = startPhase("systeminfo.rest.lldp");
        return collectLldpNeighborsFortinet(fg, timeoutMs)
          .catch(() => undefined)
          .then((neighbors) => { endLldp({ neighbors: neighbors?.length ?? null }); return neighbors; });
      })()
    : Promise.resolve<LldpNeighborSample[] | undefined>(undefined);
  // IP neighbour cache. Same endpoint discovery already reads per gate, called
  // here so a monitored firewall refreshes it on the system-info cadence
  // instead of once per discovery interval. IPv4 only -- FortiOS exposes no
  // NDP equivalent over REST, which the SNMP path does cover.
  const arpPromise = opts.includeArp
    ? (() => {
        const endArp = startPhase("systeminfo.rest.arp");
        return fgRequest<any[]>(fg, "GET", "/api/v2/monitor/network/arp", { timeoutMs })
          .then((rows) => (Array.isArray(rows) ? arpNeighborsFromFortiosRest(rows) : undefined))
          .catch(() => undefined)
          .then((rows) => { endArp({ entries: rows?.length ?? null }); return rows; });
      })()
    : Promise.resolve<ArpNeighborEntry[] | undefined>(undefined);

  const [cmdbRes, switchIfaceRes, monitorOutcome, ipsec, lldpNeighbors, arpNeighbors] = await Promise.all([
    cmdbInterfacePromise,
    switchInterfacePromise,
    monitorInterfacePromise,
    ipsecPromise,
    lldpPromise,
    arpPromise,
  ]);

  const cmdbByName = parseFortiCmdbInterfaceTable(cmdbRes);
  applyFortiSoftwareSwitchMembers(cmdbByName, switchIfaceRes);
  // FortiLink-enabled interface set (fortilink-flagged interfaces + their member
  // ports) from the same CMDB response — fed back to the caller so the LLDP
  // exclusion filter can drop FortiLink links without a second CMDB fetch.
  const fortilinkInterfaces = [...fortilinkInterfaceNamesFromCmdb(cmdbRes)];

  let interfaces: InterfaceSample[] = [];
  if (monitorOutcome.ok) {
    const res = monitorOutcome.res;
    const obj = (res && typeof res === "object" && !Array.isArray(res)) ? res as Record<string, any> : {};
    interfaces = buildFortiInterfaceSamples(obj, cmdbByName);
    backfillFortiCmdbOnlyBundles(interfaces, cmdbByName);
    backfillFortiAggregateMembers(interfaces, obj, cmdbByName);
    backfillFortiCmdbOnlyTunnels(interfaces, cmdbByName);
  } else if (interfaces.length === 0) {
    // Monitor failed AND we have no interfaces from the (also-failing) cmdb
    // synthesis path — re-throw the original error to match the prior
    // semantics. Partial success returns whatever we managed to merge.
    throw monitorOutcome.err;
  }
  applyFortiInterfaceFilter(interfaces, integration);
  // ipsecTunnels: best-effort, already resolved above. Older FortiOS
  // firmwares 404 the endpoint and FortiGates without IPsec configured
  // return an empty list — either way the System tab just hides the
  // section. Skipped entirely on the fast (per-minute) cadence so we
  // don't hammer the endpoint.
  //
  // lldpNeighbors: also best-effort. FortiOS 6.4+ exposes the per-interface
  // neighbor list; older firmwares 404 it. An empty array is "queried
  // successfully, no neighbors" → persist layer wipes stale rows. A
  // genuine failure leaves `lldpNeighbors` undefined → persist layer
  // leaves existing rows alone. `includeLldp: false` lets the caller skip
  // this when the operator routed LLDP to SNMP; the caller overlays the
  // SNMP result onto the returned sample.
  return {
    interfaces, storage: [],
    ipsecTunnels:     ipsec?.tunnels,
    ipsecConnections: ipsec?.connections,
    sslVpnSessions:   ipsec?.sslVpnSessions,
    lldpNeighbors,
    lldpSource: opts.includeLldp !== false ? "fortios" : undefined,
    arpNeighbors,
    fortilinkInterfaces,
  };
}

/**
 * Standalone FortiOS LLDP query for the cross-transport case (interfaces ride
 * SNMP but LLDP rides REST). Same wire format as collectLldpNeighborsFortinet
 * but builds its own FortiGateConfig from the integration so the caller
 * doesn't have to.
 */
async function collectLldpOnlyFortinet(
  host: string,
  integration: { type: string; config: Record<string, unknown> },
  timeoutMs?: number,
  credential?: CredentialLike | null,
): Promise<LldpNeighborSample[] | undefined> {
  const fg = buildFortinetConfig(host, integration, credential);
  if ("error" in fg) throw new AppError(409, fg.error);
  return await collectLldpNeighborsFortinet(fg, timeoutMs).catch(() => undefined);
}

/**
 * FortiOS exposes LLDP neighbors at /api/v2/monitor/system/interface/lldp-neighbors.
 * The response shape is `{ results: [{ interface, chassis_id, port_id, ... }, …] }`.
 * Field names vary across versions (some firmwares use `local_intf` / `local_intf_name`
 * / `interface`; some use `port_desc` / `port_description`; capabilities show up
 * either as a CSV string or an array). Be defensive about every field.
 */
async function collectLldpNeighborsFortinet(fg: FortiGateConfig, timeoutMs?: number): Promise<LldpNeighborSample[]> {
  const res = await fgRequest<any>(fg, "GET", "/api/v2/monitor/system/interface/lldp-neighbors", { query: { vdom: "root" }, timeoutMs });
  const arr = Array.isArray(res?.results) ? res.results : (Array.isArray(res) ? res : []);
  const out: LldpNeighborSample[] = [];
  for (const n of arr) {
    if (!n || typeof n !== "object") continue;
    const r = n as Record<string, unknown>;
    const localIfName = pickFortiString(r["local_intf"], r["local_intf_name"], r["interface"], r["local_interface"]);
    if (!localIfName) continue;
    // Some FortiOS releases pack management addresses as an array, others as a
    // comma-separated string. Pull the first IPv4 we can find.
    let mgmt: string | null = null;
    const mgmtRaw = r["management_addresses"] ?? r["management_address"] ?? r["mgmt_addr"];
    if (Array.isArray(mgmtRaw)) {
      for (const m of mgmtRaw) {
        if (typeof m === "string" && m) { mgmt = m; break; }
        if (m && typeof m === "object") {
          const a = (m as any).address ?? (m as any).ip ?? (m as any).addr;
          if (typeof a === "string" && a) { mgmt = a; break; }
        }
      }
    } else if (typeof mgmtRaw === "string" && mgmtRaw) {
      mgmt = mgmtRaw.split(",")[0]!.trim() || null;
    }
    out.push({
      localIfName,
      chassisIdSubtype:  pickFortiString(r["chassis_id_subtype"], r["chassis_subtype"]),
      chassisId:         pickFortiString(r["chassis_id"]),
      portIdSubtype:     pickFortiString(r["port_id_subtype"], r["port_subtype"]),
      portId:            pickFortiString(r["port_id"]),
      portDescription:   pickFortiString(r["port_description"], r["port_desc"]),
      systemName:        pickFortiString(r["system_name"], r["sys_name"]),
      systemDescription: pickFortiString(r["system_description"], r["sys_desc"]),
      managementIp:      mgmt,
      capabilities:      pickFortiCapabilities(r["enabled_capabilities"] ?? r["system_capabilities"]),
    });
  }
  return out;
}

function pickFortiString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string") {
      const t = v.trim();
      if (t) return t;
    }
  }
  return null;
}

function pickFortiCapabilities(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim().toLowerCase()).filter((s) => s.length > 0);
  }
  if (typeof raw === "string") {
    return raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
  }
  return [];
}

/**
 * FortiLink-enabled interface names from a CMDB `/api/v2/cmdb/system/interface`
 * response: every interface whose `fortilink` setting is enabled, PLUS the
 * member ports of those interfaces (FortiLink is an aggregate; its members are
 * the physical ports — e.g. the `fortilink` aggregate and member `a`). This is
 * the authoritative definition of a "FortiLink interface" (the CMDB flag), not
 * a name heuristic. Used to exclude FortiLink links from LLDP collection when
 * the integration's `excludeFortilinkLldp` toggle is on. Pure + defensive about
 * the FortiOS member-array shape (same `interface-name` / `q_origin_key`
 * fallback chain collectSystemInfoFortinet uses).
 */
export function fortilinkInterfaceNamesFromCmdb(cmdbRes: unknown): Set<string> {
  const out = new Set<string>();
  const arr = Array.isArray(cmdbRes)
    ? cmdbRes
    : (Array.isArray((cmdbRes as any)?.results) ? (cmdbRes as any).results : []);
  for (const c of arr) {
    if (!c || typeof c !== "object" || typeof (c as any).name !== "string") continue;
    const fl = (c as any).fortilink;
    if (!(fl === "enable" || fl === true || fl === 1)) continue;
    out.add((c as any).name);
    const member = (c as any).member;
    if (Array.isArray(member)) {
      for (const m of member) {
        if (typeof m === "string") { if (m) out.add(m); continue; }
        if (m && typeof m === "object") {
          const v = (m as any)["interface-name"] ?? (m as any).q_origin_key ?? (m as any).interface_name;
          if (typeof v === "string" && v) out.add(v);
        }
      }
    }
  }
  return out;
}

/**
 * Fetch the FortiLink-enabled interface set directly from CMDB. Used on the
 * SNMP-interfaces path (which doesn't otherwise fetch CMDB) when the operator
 * has `excludeFortilinkLldp` on — one extra REST call, gated behind the toggle.
 * Returns an empty set on any failure (e.g. a token without CMDB scope), so a
 * failure degrades to "collect all LLDP" rather than dropping neighbors.
 */
async function fetchFortilinkInterfaceSet(fg: FortiGateConfig, timeoutMs?: number): Promise<Set<string>> {
  const res = await fgRequest<any>(fg, "GET", "/api/v2/cmdb/system/interface", { query: { vdom: "root", format: FORTIOS_INTERFACE_CMDB_FORMAT }, timeoutMs })
    .catch(() => null as any);
  return fortilinkInterfaceNamesFromCmdb(res);
}

/**
 * FortiOS exposes IPsec at /api/v2/monitor/vpn/ipsec: one entry per phase-1
 * the IKE daemon is servicing plus one per dynamic CHILD (a hub's connected
 * ADVPN spokes / dial-up peers / FortiClient users, a spoke's ADVPN
 * shortcuts — each carries `parent`). utils/fortiosIpsec.ts → parseFortiosIpsec
 * splits the two: phase-1 rows roll up into `tunnels` (the sample stream, the
 * System tab, pins — children are never pinnable, they come and go with
 * peers and traffic) and children become `connections` (the current-state
 * table behind the asset's IPsec tab). Older firmwares 404 the endpoint —
 * the caller swallows the failure.
 *
 * The CMDB phase1-interface read supplies each tunnel's parent interface,
 * the dial-up `type`, and the ADVPN / xauth / EAP flags that classify a
 * child. It is best-effort (a token without cmdb scope leaves those null)
 * and runs in parallel with the monitor read. CMDB-only synthesis (configured
 * phase-1 tunnels missing from the monitor answer get a "down" / "dynamic"
 * row) only runs when the monitor call succeeded — a monitor failure rejects
 * this function, which the caller treats as "no ipsec data", not "every
 * tunnel down".
 *
 * `includeSslVpn` adds the SSL-VPN session list (/api/v2/monitor/vpn/ssl) as
 * a third parallel read with its own failure: `sslVpnSessions` is undefined
 * when it was not asked for or did not answer, so a gate whose token lacks
 * that scope keeps whatever SSL rows it had rather than wiping them.
 */
interface FortiIpsecCollection {
  tunnels:        IpsecTunnelSample[];
  connections:    IpsecConnectionSample[] | undefined;
  sslVpnSessions: IpsecConnectionSample[] | undefined;
}

async function collectIpsecFortinet(
  fg: FortiGateConfig,
  timeoutMs?: number,
  opts: { includeSslVpn?: boolean } = {},
): Promise<FortiIpsecCollection> {
  const [cmdbResult, res, sslRes] = await Promise.all([
    fgRequest<any>(fg, "GET", "/api/v2/cmdb/vpn.ipsec/phase1-interface", { query: { vdom: "root" }, timeoutMs })
      .catch(() => null as any),
    fgRequest<any>(fg, "GET", "/api/v2/monitor/vpn/ipsec", { query: { scope: "vdom" }, timeoutMs }),
    opts.includeSslVpn
      ? fgRequest<any>(fg, "GET", "/api/v2/monitor/vpn/ssl", { timeoutMs }).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  const { tunnels, connections } = parseFortiosIpsec(cmdbResult, res);
  return {
    tunnels,
    connections,
    sslVpnSessions: sslRes === undefined || sslRes === null ? undefined : parseFortiosSslVpn(sslRes),
  };
}

/** Normalize a FortiOS SD-WAN member liveness value to "up"/"down". FortiOS
 *  health-check members report "alive"/"dead" on some versions, "up"/"down"
 *  or a numeric/boolean flag on others. */
function normalizeSdwanState(v: unknown): "up" | "down" {
  if (typeof v === "number")  return v > 0 ? "up" : "down";
  if (typeof v === "boolean") return v ? "up" : "down";
  const s = String(v ?? "").trim().toLowerCase();
  return s === "up" || s === "alive" || s === "1" || s === "true" ? "up" : "down";
}

/**
 * SD-WAN collector (FortiOS only; gated by Integration.config.pullSdwan, its own
 * cadence — runSdwanFor). Pulls two things in parallel:
 *   - Performance SLA health-check readings (/api/v2/monitor/virtual-wan/health-check):
 *     one PerfSlaSample per (health-check, WAN member) with latency/jitter/
 *     packet-loss gauges + link state.
 *   - SD-WAN service rules (/api/v2/cmdb/system/sdwan → `service`): each rule's
 *     mode + configured candidate members in priority order (seq-nums resolved
 *     to interface names via the global `members` table).
 *
 * The runtime selected member is INFERRED best-effort: the first candidate (in
 * priority order) that is up per the health-check data. FortiOS exposes no clean
 * REST endpoint for per-rule member selection, so `selectedMember` is null when
 * it can't be resolved (no health-check data covering the candidates). This is
 * good enough for sla / priority modes; load-balance spreads traffic so the
 * inferred "selected" is only the top healthy member — the UI shows `mode` so
 * the operator has context.
 *
 * Each sub-fetch degrades independently, like collectIpsecFortinet's
 * CMDB-optional handling. A failed health-check read yields no SLA samples. A
 * failed CMDB read yields `sdwanRules: undefined` — "not read", so the caller
 * leaves the stored rules alone — rather than [], which would full-replace
 * them with nothing: on a per-minute cadence one timed-out request would
 * otherwise blank the gate's SD-WAN tab. Older firmwares 404 the endpoints →
 * the same "not read" → the SD-WAN tab just hides the section. `reachable` is
 * false only when BOTH requests failed.
 *
 * NOTE (verify on a real FortiOS 7.x device): the health-check JSON shape, the
 * member-state field name (status vs state; "up"/"alive"/numeric), and the CMDB
 * service member-reference shape (members[].seq-num vs priority-members) vary by
 * version — the parsing here is defensive but should be confirmed.
 */
async function collectSdwanFortinet(
  fg: FortiGateConfig,
  timeoutMs?: number,
): Promise<{ perfSla: PerfSlaSample[]; sdwanRules: SdwanRuleSample[] | undefined; reachable: boolean }> {
  const [hcRes, sdwanRes] = await Promise.all([
    fgRequest<any>(fg, "GET", "/api/v2/monitor/virtual-wan/health-check", { query: { scope: "vdom" }, timeoutMs })
      .catch(() => null as any),
    fgRequest<any>(fg, "GET", "/api/v2/cmdb/system/sdwan", { query: { vdom: "root" }, timeoutMs })
      .catch(() => null as any),
  ]);
  const thresholds = parseSdwanSlaThresholds(sdwanRes);
  const zones = parseSdwanMemberZones(sdwanRes);
  const { perfSla, memberUp } = parsePerfSlaHealthCheck(hcRes, thresholds, zones);
  const sdwanRules = sdwanRes == null ? undefined : parseSdwanRules(sdwanRes, memberUp, zones);
  return { perfSla, sdwanRules, reachable: hcRes != null || sdwanRes != null };
}

/**
 * Build a member-interface → SD-WAN zone map from the CMDB system/sdwan
 * `members[]` (each carries `interface` + `zone`, e.g. "virtual-wan-link" /
 * "overlay"). Used to label Performance-SLA members by zone. Exported for unit
 * testing; pure.
 */
export function parseSdwanMemberZones(sdwanRes: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const root = (sdwanRes && typeof sdwanRes === "object" && (sdwanRes as any).results && typeof (sdwanRes as any).results === "object")
    ? (sdwanRes as any).results
    : sdwanRes;
  if (!root || typeof root !== "object") return out;
  const members = Array.isArray((root as any).members) ? (root as any).members : [];
  for (const m of members) {
    if (!m || typeof m !== "object") continue;
    const iface = typeof (m as any).interface === "string" ? (m as any).interface.trim() : "";
    const zone  = typeof (m as any).zone === "string" ? (m as any).zone.trim() : "";
    if (iface && zone && !out.has(iface)) out.set(iface, zone);
  }
  return out;
}

export interface SlaThreshold { latencyMs: number | null; jitterMs: number | null; packetLoss: number | null; }

/**
 * Build a healthCheck-name → SLA threshold map from the CMDB system/sdwan
 * `health-check[].sla` targets. FortiOS allows multiple SLA rows per
 * health-check; we take the max configured threshold per metric (a member
 * passes the strictest target). A 0 / absent threshold means "unset" for that
 * metric → null (no chart line).
 *
 * Each SLA row carries thresholds for ALL three metrics regardless of which are
 * actually enforced — FortiOS keeps a default `jitter-threshold` of 5ms even
 * when jitter isn't part of the SLA. The `link-cost-factor` field on the SLA
 * row names the metrics the SLA actually measures (`latency` / `jitter` /
 * `packet-loss`); a threshold for a metric NOT listed there is a disabled SLA
 * and must not surface as a chart line. We only take a metric's threshold when
 * its link-cost-factor token is present. Older FortiOS that omits the field
 * (null/empty) falls back to "all metrics enabled" so existing installs are
 * unaffected. Exported for unit testing; pure.
 */
export function parseSdwanSlaThresholds(sdwanRes: unknown): Map<string, SlaThreshold> {
  const out = new Map<string, SlaThreshold>();
  const root = (sdwanRes && typeof sdwanRes === "object" && (sdwanRes as any).results && typeof (sdwanRes as any).results === "object")
    ? (sdwanRes as any).results
    : sdwanRes;
  if (!root || typeof root !== "object") return out;
  const hcs = Array.isArray((root as any)["health-check"]) ? (root as any)["health-check"] : [];
  for (const hc of hcs) {
    if (!hc || typeof hc !== "object") continue;
    const name = typeof (hc as any).name === "string" ? (hc as any).name.trim() : "";
    if (!name) continue;
    const slas = Array.isArray((hc as any).sla) ? (hc as any).sla : [];
    let lat: number | null = null, jit: number | null = null, loss: number | null = null;
    const take = (cur: number | null, raw: unknown): number | null => {
      const n = toFiniteOrNull(raw);
      if (n == null || n <= 0) return cur;
      return cur == null ? n : Math.max(cur, n);
    };
    for (const sla of slas) {
      if (!sla || typeof sla !== "object") continue;
      const factors = parseSlaLinkCostFactors((sla as any)["link-cost-factor"]);
      // factors == null → field absent/empty → treat all metrics as enabled.
      const on = (...names: string[]) => factors == null || names.some((n) => factors.has(n));
      if (on("latency"))                    lat  = take(lat,  (sla as any)["latency-threshold"]);
      if (on("jitter"))                     jit  = take(jit,  (sla as any)["jitter-threshold"]);
      if (on("packet-loss", "packetloss"))  loss = take(loss, (sla as any)["packetloss-threshold"]);
    }
    out.set(name, { latencyMs: lat, jitterMs: jit, packetLoss: loss });
  }
  return out;
}

/** Parse a FortiOS SLA-target `link-cost-factor` field into the set of metric
 *  tokens the SLA enforces. May arrive as a space/comma-separated string
 *  ("latency packet-loss") or an array of tokens. Returns null when the field
 *  is absent/empty so callers can fall back to "all metrics enabled" for older
 *  FortiOS that omits it. */
function parseSlaLinkCostFactors(raw: unknown): Set<string> | null {
  const tokens: string[] = [];
  if (Array.isArray(raw)) {
    for (const t of raw) if (typeof t === "string" && t.trim()) tokens.push(t.trim().toLowerCase());
  } else if (typeof raw === "string" && raw.trim()) {
    for (const t of raw.trim().toLowerCase().split(/[\s,]+/)) if (t) tokens.push(t);
  }
  return tokens.length ? new Set(tokens) : null;
}

/**
 * Parse a /api/v2/monitor/virtual-wan/health-check response into PerfSlaSamples.
 * Response shape: { results: { "<hc-name>": { "<member-iface>": { latency,
 * jitter, packet_loss, status, ... }, ... }, ... } } (also accepts the
 * un-enveloped object). Returns the samples plus a member-interface → up map
 * (true if the member is up in ANY health-check) used to infer rule selection.
 * Exported for unit testing; pure (no I/O).
 */
export function parsePerfSlaHealthCheck(
  hcRes: unknown,
  thresholds?: Map<string, SlaThreshold>,
  zones?: Map<string, string>,
): { perfSla: PerfSlaSample[]; memberUp: Map<string, boolean> } {
  const perfSla: PerfSlaSample[] = [];
  const memberUp = new Map<string, boolean>();
  const hcRoot = (hcRes && typeof hcRes === "object" && (hcRes as any).results && typeof (hcRes as any).results === "object")
    ? (hcRes as any).results
    : hcRes;
  if (hcRoot && typeof hcRoot === "object") {
    for (const [hcName, members] of Object.entries(hcRoot as Record<string, any>)) {
      if (!hcName || !members || typeof members !== "object") continue;
      const thr = thresholds?.get(hcName) ?? null;
      for (const [link, m] of Object.entries(members as Record<string, any>)) {
        if (!link || !m || typeof m !== "object") continue;
        const state = normalizeSdwanState((m as any).status ?? (m as any).state ?? (m as any).alive);
        const latencyMs  = toFiniteOrNull((m as any).latency);
        const jitterMs   = toFiniteOrNull((m as any).jitter);
        const packetLoss = toFiniteOrNull((m as any).packet_loss ?? (m as any).packetloss);
        perfSla.push({
          healthCheck: hcName, link, zone: zones?.get(link) ?? null, state, latencyMs, jitterMs, packetLoss,
          latencyThresholdMs:  thr?.latencyMs ?? null,
          jitterThresholdMs:   thr?.jitterMs ?? null,
          packetLossThreshold: thr?.packetLoss ?? null,
        });
        if (state === "up") memberUp.set(link, true);
        else if (!memberUp.has(link)) memberUp.set(link, false);
      }
    }
  }
  return { perfSla, memberUp };
}

/**
 * Parse a /api/v2/cmdb/system/sdwan response into SdwanRuleSamples. `config
 * system sdwan` is a single complex object carrying a global `members` array
 * (seq-num → interface) and a `service` array of the SD-WAN rules. The runtime
 * selected member is inferred from `memberUp` (first candidate in priority order
 * that is up); null when none resolvable. Rules configured for zone-based
 * selection (`priority-zone`) carry no interface members — their candidates are
 * resolved from `memberZones` (interface → zone, from parseSdwanMemberZones)
 * preserving global-member priority order. Exported for unit testing; pure.
 */
export function parseSdwanRules(
  sdwanRes: unknown,
  memberUp: Map<string, boolean>,
  memberZones?: Map<string, string>,
): SdwanRuleSample[] {
  const sdwanRules: SdwanRuleSample[] = [];
  const sdwanRoot = (sdwanRes && typeof sdwanRes === "object" && (sdwanRes as any).results && typeof (sdwanRes as any).results === "object")
    ? (sdwanRes as any).results
    : sdwanRes;
  if (!sdwanRoot || typeof sdwanRoot !== "object") return sdwanRules;
  const seqToIface = new Map<string, string>();
  // Ordered interface list in global-member (= priority) order, used to resolve
  // a zone into its member interfaces for zone-preference rules.
  const orderedIfaces: string[] = [];
  const globalMembers = Array.isArray((sdwanRoot as any).members) ? (sdwanRoot as any).members : [];
  for (const gm of globalMembers) {
    if (!gm || typeof gm !== "object") continue;
    const seq   = (gm as any)["seq-num"] ?? (gm as any).seq_num;
    const iface = typeof (gm as any).interface === "string" ? (gm as any).interface.trim() : "";
    if (seq != null && iface) seqToIface.set(String(seq), iface);
    if (iface && !orderedIfaces.includes(iface)) orderedIfaces.push(iface);
  }
  // zone → member interfaces in priority order (built from the interface→zone
  // map + global-member ordering above).
  const zoneToIfaces = new Map<string, string[]>();
  if (memberZones) {
    for (const iface of orderedIfaces) {
      const zone = memberZones.get(iface);
      if (!zone) continue;
      const list = zoneToIfaces.get(zone) ?? [];
      if (!list.includes(iface)) list.push(iface);
      zoneToIfaces.set(zone, list);
    }
  }
  const services = Array.isArray((sdwanRoot as any).service) ? (sdwanRoot as any).service : [];
  services.forEach((svc: any, seqIdx: number) => {
    if (!svc || typeof svc !== "object") return;
    const ruleName = typeof svc.name === "string" && svc.name.trim()
      ? svc.name.trim()
      : (svc.id != null ? `rule-${svc.id}` : "");
    if (!ruleName) return;
    const ruleId = svc.id != null ? String(svc.id) : null;
    const mode = typeof svc.mode === "string" && svc.mode.trim() ? svc.mode.trim() : null;
    const enabled = svc.status == null ? null : (String(svc.status).toLowerCase() === "enable" || svc.status === true);
    const criteria = deriveSdwanCriteria(svc);
    const healthChecks = collectSdwanNameList(svc["health-check"]);
    // Destination can come from address objects + Internet-Service (ISDB) +
    // application-control entries — gather names from all the common fields.
    const dst = ([] as string[]).concat(
      collectSdwanNameList(svc.dst),
      collectSdwanNameList(svc["internet-service-name"]),
      collectSdwanNameList(svc["internet-service-custom"]),
      collectSdwanNameList(svc["internet-service-app-ctrl"]),
      collectSdwanNameList(svc["internet-service-app-ctrl-group"]),
    ).filter((v, i, arr) => v && arr.indexOf(v) === i);
    // Candidate members in priority order. FortiOS uses `members` (array of
    // { seq-num }) on most versions; some use `priority-members`. Resolve each
    // seq-num to its interface via the global members table; accept a literal
    // interface string as a fallback.
    const rawMembers =
      Array.isArray(svc.members)            ? svc.members :
      Array.isArray(svc["priority-members"]) ? svc["priority-members"] : [];
    const availableMembers: string[] = [];
    for (const rm of rawMembers) {
      let iface: string | null = null;
      if (typeof rm === "string") iface = rm.trim() || null;
      else if (rm && typeof rm === "object") {
        const seq = (rm as any)["seq-num"] ?? (rm as any).seq_num;
        if (seq != null && seqToIface.has(String(seq))) iface = seqToIface.get(String(seq))!;
        else if (typeof (rm as any).interface === "string") iface = (rm as any).interface.trim() || null;
      }
      if (iface && !availableMembers.includes(iface)) availableMembers.push(iface);
    }
    // Zone-based selection: FortiOS puts the preference in `priority-zone`
    // (zone names in priority order) and leaves the interface-member arrays
    // empty. When that's the case, expand each preferred zone into its member
    // interfaces (global-member priority order) so the rule still reports
    // candidates — without this the Members column renders empty.
    const priorityZones = collectSdwanNameList(svc["priority-zone"]);
    if (availableMembers.length === 0 && priorityZones.length > 0) {
      for (const zone of priorityZones) {
        for (const iface of zoneToIfaces.get(zone) ?? []) {
          if (!availableMembers.includes(iface)) availableMembers.push(iface);
        }
      }
    }
    let selectedMember: string | null = null;
    for (const m of availableMembers) {
      if (memberUp.get(m) === true) { selectedMember = m; break; }
    }
    const status: "up" | "down" = selectedMember ? "up" : "down";
    sdwanRules.push({
      ruleName, ruleId, seq: seqIdx, enabled, mode, criteria, healthChecks, dst,
      status, selectedMember, availableMembers, priorityZones,
    });
  });
  return sdwanRules;
}

/** Collect a list of names from a FortiOS CMDB reference field, which may be
 *  an array of { name } objects, an array of strings, or a single string. */
function collectSdwanNameList(raw: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => { if (typeof v === "string" && v.trim()) out.push(v.trim()); };
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (typeof e === "string") push(e);
      else if (e && typeof e === "object") push((e as any).name ?? (e as any)["q_origin_key"]);
    }
  } else if (typeof raw === "string") {
    push(raw);
  }
  return out;
}

/** Best-effort operator-facing criteria label, mirroring the FortiGate GUI's
 *  "Criteria" column. Derived from the service rule's mode + link-cost-factor.
 *  FortiOS field shapes vary by version — verify on a real device. */
function deriveSdwanCriteria(svc: any): string | null {
  const lcf = typeof svc["link-cost-factor"] === "string" ? svc["link-cost-factor"].trim().toLowerCase() : "";
  const lcfLabel: Record<string, string> = {
    latency: "Latency",
    jitter: "Jitter",
    "packet-loss": "Packet Loss",
    inbandwidth: "Bandwidth (in)",
    outbandwidth: "Bandwidth (out)",
    bibandwidth: "Bandwidth",
    "custom-profile-1": "Customized Profile",
  };
  if (lcf && lcfLabel[lcf]) return lcfLabel[lcf];
  const mode = typeof svc.mode === "string" ? svc.mode.trim().toLowerCase() : "";
  if (mode === "load-balance") return "Source IP";
  if (mode === "manual")       return "Manual";
  if (mode === "priority")     return "Best Quality";
  if (mode === "sla")          return "SLA";
  return null;
}

/**
 * Wildcard match used by the FMG/FortiGate integration's interface filter.
 * Mirrors src/services/fortimanagerService.ts:matchesWildcard so the System
 * tab applies the exact rule discovery uses.
 */
/**
 * Apply the FMG/FortiGate integration's interfaceInclude / interfaceExclude
 * filter to a System-tab interface list, in-place. Same rule discovery uses
 * to decide which interfaces' IPs become reservations, so the System tab
 * mirrors discovery's scope on both REST and SNMP transports.
 *
 * VLAN sub-interfaces / aggregate members survive the filter when their
 * parent does — hiding the parent would orphan the children that do match.
 */
function applyFortiInterfaceFilter(
  interfaces: InterfaceSample[],
  integration: { config?: unknown } | null | undefined,
): void {
  const cfg = (integration?.config && typeof integration.config === "object")
    ? (integration.config as Record<string, unknown>)
    : {};
  const ifInclude = Array.isArray(cfg.interfaceInclude) ? (cfg.interfaceInclude as string[]) : [];
  const ifExclude = Array.isArray(cfg.interfaceExclude) ? (cfg.interfaceExclude as string[]) : [];
  if (ifInclude.length === 0 && ifExclude.length === 0) return;
  const allowed = (name: string): boolean => {
    if (ifInclude.length > 0) return ifInclude.some((p) => fortiInterfaceWildcardMatch(p, name));
    return !ifExclude.some((p) => fortiInterfaceWildcardMatch(p, name));
  };
  const survives = new Set<string>();
  for (const i of interfaces) if (allowed(i.ifName)) survives.add(i.ifName);
  for (const i of interfaces) {
    if (!survives.has(i.ifName) && i.ifParent && survives.has(i.ifParent)) survives.add(i.ifName);
  }
  for (let k = interfaces.length - 1; k >= 0; k--) {
    if (!survives.has(interfaces[k]!.ifName)) interfaces.splice(k, 1);
  }
}

// Shared glob-lite matcher — the interface filter MUST agree with the
// discovery-side device filters, so all of them import the one canonical.
const fortiInterfaceWildcardMatch = matchesWildcard;

/** The FortiOS types that group member ports under one interface. "switch" is
 *  a SOFTWARE switch (members in `system/switch-interface`), "hard-switch" a
 *  hardware one (members on the interface row). They share ifType "aggregate"
 *  — member back-fill, the interface tree and the auto-monitor type filter all
 *  treat them alike — and keep the FortiOS name as `ifSubtype`. */
const FORTI_BUNDLE_TYPES: ReadonlySet<string> = new Set(["aggregate", "redundant", "hard-switch", "switch", "vap-switch"]);

/** `ifSubtype` for a FortiOS type: the type itself for a bundle, else null. */
export function fortiIfSubtype(raw: unknown): string | null {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.toLowerCase();
  return FORTI_BUNDLE_TYPES.has(t) ? t : null;
}

export function normalizeFortiIfType(raw: unknown): string | null {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.toLowerCase();
  if (t === "physical" || t === "wl-mesh")                                          return "physical";
  if (FORTI_BUNDLE_TYPES.has(t))                                                     return "aggregate";
  if (t === "vlan")                                                                  return "vlan";
  if (t === "loopback")                                                              return "loopback";
  if (t === "tunnel" || t === "ssl" || t === "vxlan" || t === "gre" ||
      t === "ipsec"  || t === "vdom-link")                                           return "tunnel";
  return null;
}

// ─── SNMP collectors ────────────────────────────────────────────────────────
//
// HOST-RESOURCES-MIB delivers CPU (hrProcessorLoad), memory (hrStorage rows
// where hrStorageType = hrStorageRam), and storage (hrStorage rows where the
// type is hrStorageFixedDisk). IF-MIB delivers per-interface counters. Both
// are walked once per system-info pass.

const OID = {
  hrProcessorLoad:           "1.3.6.1.2.1.25.3.3.1.2",
  hrStorageType:             "1.3.6.1.2.1.25.2.3.1.2",
  hrStorageDescr:            "1.3.6.1.2.1.25.2.3.1.3",
  hrStorageAllocationUnits:  "1.3.6.1.2.1.25.2.3.1.4",
  hrStorageSize:             "1.3.6.1.2.1.25.2.3.1.5",
  hrStorageUsed:             "1.3.6.1.2.1.25.2.3.1.6",
  hrStorageRam:              "1.3.6.1.2.1.25.2.1.2",
  hrStorageFixedDisk:        "1.3.6.1.2.1.25.2.1.4",
  hrStorageRemovableDisk:    "1.3.6.1.2.1.25.2.1.5",
  // IF-MIB
  ifDescr:        "1.3.6.1.2.1.2.2.1.2",
  ifType:         "1.3.6.1.2.1.2.2.1.3",
  ifSpeed:        "1.3.6.1.2.1.2.2.1.5",
  ifPhysAddress:  "1.3.6.1.2.1.2.2.1.6",
  ifAdminStatus:  "1.3.6.1.2.1.2.2.1.7",
  ifOperStatus:   "1.3.6.1.2.1.2.2.1.8",
  ifInOctets:     "1.3.6.1.2.1.2.2.1.10",
  ifInErrors:     "1.3.6.1.2.1.2.2.1.14",
  ifOutOctets:    "1.3.6.1.2.1.2.2.1.16",
  ifOutErrors:    "1.3.6.1.2.1.2.2.1.20",
  ifName:         "1.3.6.1.2.1.31.1.1.1.1",
  ifHCInOctets:   "1.3.6.1.2.1.31.1.1.1.6",
  ifHCOutOctets:  "1.3.6.1.2.1.31.1.1.1.10",
  ifHighSpeed:    "1.3.6.1.2.1.31.1.1.1.15",
  ifAlias:        "1.3.6.1.2.1.31.1.1.1.18",
  ipAdEntIfIndex: "1.3.6.1.2.1.4.20.1.2",
  // EtherLike-MIB (RFC 3635). Indexed by dot3StatsIndex, which the MIB
  // defines as the interface's ifIndex — so it joins IF-MIB rows directly.
  dot3StatsDuplexStatus: "1.3.6.1.2.1.10.7.2.1.19",
  // ENTITY-MIB / ENTITY-SENSOR-MIB (RFC 4133 / 3433). For temperature
  // sensors, entPhySensorType=8 (celsius). entPhySensorScale + Precision tell
  // us how to scale entPhySensorValue back to a real number; entPhysicalDescr
  // (indexed by the same physical-entity index) gives the operator-friendly
  // sensor name.
  // POWER-ETHERNET-MIB (RFC 3621) pethPsePortTable. INDEX is
  // { pethPsePortGroupIndex, pethPsePortIndex } and the MIB defines NO join
  // back to ifIndex, so rows are correlated by inference in utils/poePorts.ts.
  pethPsePortDetectionStatus:      "1.3.6.1.2.1.105.1.1.1.6",
  pethPsePortPowerClassifications: "1.3.6.1.2.1.105.1.1.1.10",
  entPhysicalDescr:       "1.3.6.1.2.1.47.1.1.1.1.2",
  // ENTITY-MIB entPhysicalTable inventory columns (RFC 4133). Walked on the
  // heavy cadence only — a transceiver's serial changes when someone swaps it,
  // not on a poll interval.
  // BRIDGE-MIB / Q-BRIDGE-MIB forwarding database (RFC 4188 / 4363).
  // dot1dBasePortIfIndex is the basePort -> ifIndex join BOTH FDB tables need:
  // dot1qTpFdbPort and dot1dTpFdbPort report a dot1dBasePort, never an ifIndex.
  // The address COLUMN is walked alongside them because the index is not
  // always the address: agents exist (FortiSwitch) that index the table by a
  // row number and publish the MAC only here. See resolveFdbIdentity.
  // IP-MIB neighbour cache (RFC 4293), bundled as `std:ip`. Two generations:
  // ipNetToPhysicalTable is current and covers IPv4 ARP *and* IPv6 NDP;
  // ipNetToMediaTable is the deprecated RFC 1213 predecessor, IPv4 only, kept
  // as the fallback for agents that never implemented the successor. On the
  // MODERN table the ifIndex and the address live only in the OID index (the
  // index objects are not-accessible), which is why utils/arpNeighbors.ts
  // decodes the suffix rather than walking them.
  ipNetToPhysicalPhysAddress: "1.3.6.1.2.1.4.35.1.4",
  ipNetToPhysicalLastUpdated: "1.3.6.1.2.1.4.35.1.5",
  ipNetToPhysicalType:        "1.3.6.1.2.1.4.35.1.6",
  ipNetToPhysicalState:       "1.3.6.1.2.1.4.35.1.7",
  ipNetToMediaPhysAddress:    "1.3.6.1.2.1.4.22.1.2",
  ipNetToMediaType:           "1.3.6.1.2.1.4.22.1.4",
  dot1dBasePortIfIndex:   "1.3.6.1.2.1.17.1.4.1.2",
  dot1qTpFdbAddress:      "1.3.6.1.2.1.17.7.1.2.2.1.1",
  dot1qTpFdbPort:         "1.3.6.1.2.1.17.7.1.2.2.1.2",
  dot1qTpFdbStatus:       "1.3.6.1.2.1.17.7.1.2.2.1.3",
  dot1dTpFdbAddress:      "1.3.6.1.2.1.17.4.3.1.1",
  dot1dTpFdbPort:         "1.3.6.1.2.1.17.4.3.1.2",
  dot1dTpFdbStatus:       "1.3.6.1.2.1.17.4.3.1.3",
  // Q-BRIDGE-MIB per-port VLAN config (RFC 4363). dot1qPvid is the port's
  // native/untagged VLAN, indexed by dot1dBasePort like the FDB tables above.
  // The two member columns are PortList BITMAPS indexed by VLAN id -- see
  // utils/portVlans.ts for the bit order, and for why the untagged column is
  // believed only when it is a strict subset of egress.
  dot1qPvid:                    "1.3.6.1.2.1.17.7.1.4.5.1.1",
  dot1qVlanStaticEgressPorts:   "1.3.6.1.2.1.17.7.1.4.3.1.2",
  dot1qVlanStaticUntaggedPorts: "1.3.6.1.2.1.17.7.1.4.3.1.4",
  // dot1qVlanCurrentTable is the fallback for an agent that keeps its VLANs
  // out of the static table. Its INDEX is { dot1qVlanTimeMark, dot1qVlanIndex },
  // so the VLAN id is the LAST index component, not the whole suffix.
  dot1qVlanCurrentEgressPorts:   "1.3.6.1.2.1.17.7.1.4.2.1.4",
  dot1qVlanCurrentUntaggedPorts: "1.3.6.1.2.1.17.7.1.4.2.1.5",
  entPhysicalClass:       "1.3.6.1.2.1.47.1.1.1.1.5",
  entPhysicalName:        "1.3.6.1.2.1.47.1.1.1.1.7",
  entPhysicalHardwareRev: "1.3.6.1.2.1.47.1.1.1.1.8",
  entPhysicalFirmwareRev: "1.3.6.1.2.1.47.1.1.1.1.9",
  entPhysicalSerialNum:   "1.3.6.1.2.1.47.1.1.1.1.11",
  entPhysicalMfgName:     "1.3.6.1.2.1.47.1.1.1.1.12",
  entPhysicalModelName:   "1.3.6.1.2.1.47.1.1.1.1.13",
  entPhysicalIsFRU:       "1.3.6.1.2.1.47.1.1.1.1.16",
  // POWER-ETHERNET-MIB pethMainPseTable (RFC 3621) - the UNIT-level PSE:
  // nominal budget, what is actually being delivered, and the PSE's own
  // health bit. Indexed by pethMainPseGroupIndex (one group on a standalone
  // switch, several on a stack/chassis). Note the extra pethMainPseObjects
  // level in the chain: pethObjects(.1) -> .3 -> Table(.1) -> Entry(.1).
  // FortiSwitch trunk -> physical port map (`fsTrunkMember`). A single
  // OctetString, NOT a table, hence the trailing .0 — the switch publishes its
  // whole trunk/member relationship in one string. See
  // utils/fortiswitchTrunkMap.ts for the format and why matching is a suffix
  // test rather than a reconstruction.
  fsTrunkMember:               "1.3.6.1.4.1.12356.106.3.1.0",
  // Same object one level deeper. The constant above shipped at this depth and
  // silently returned noSuchObject on every switch (a scalar GET resolves an
  // error varbind to null, so the whole trunk overlay just never ran); the walk
  // that caught it named `fsTrunkMember.0` at ...106.3.1.0. Kept as a fallback
  // GET rather than deleted because it is one extra round trip only on a switch
  // that answered nothing at the MIB-stated OID, and a firmware that publishes
  // it deeper cannot be ruled out from one device.
  fsTrunkMemberAlt:            "1.3.6.1.4.1.12356.106.3.1.1.0",
  pethMainPsePower:            "1.3.6.1.2.1.105.1.3.1.1.2",
  pethMainPseOperStatus:       "1.3.6.1.2.1.105.1.3.1.1.3",
  pethMainPseConsumptionPower: "1.3.6.1.2.1.105.1.3.1.1.4",
  entPhySensorType:       "1.3.6.1.2.1.99.1.1.1.1",
  entPhySensorScale:      "1.3.6.1.2.1.99.1.1.1.2",
  entPhySensorPrecision:  "1.3.6.1.2.1.99.1.1.1.3",
  entPhySensorValue:      "1.3.6.1.2.1.99.1.1.1.4",
  entPhySensorOperStatus: "1.3.6.1.2.1.99.1.1.1.5",
  // Textual unit label. RFC 3433's type enum has no dBm member, so this is the
  // only place a device can declare that a reading is optical power.
  entPhySensorUnitsDisplay: "1.3.6.1.2.1.99.1.1.1.6",
  // FORTINET-FORTIGATE-MIB::fgHwSensorTable left this map in 2026-10 (business
  // rule 132): it is the Fortinet profile's sensor-table row now, three symbol
  // NAMES resolved from the uploaded MIB (vendorTelemetryProfiles →
  // FORTIGATE_SENSOR_COLUMNS). Branch-class FortiGates (40F/60F/61F/91G/101F)
  // still depend on it — they implement neither ENTITY-SENSOR-MIB nor the
  // FortiOS REST sensor-info endpoint.
  // LLDP-MIB (RFC 4957). lldpLocPortTable maps localPortNum → ifName/alias so
  // we can stitch lldpRemTable rows back to a real interface. lldpRemTable is
  // indexed by (timeMark, localPortNum, remIndex); we only care about the
  // last two halves, so callers strip the leading timeMark when keying. The
  // management-addr table is indexed by (timeMark, localPortNum, remIndex,
  // addrSubtype, addrLen, addr...) — same dance.
  lldpLocPortIdSubtype:    "1.0.8802.1.1.2.1.3.7.1.2",
  lldpLocPortId:           "1.0.8802.1.1.2.1.3.7.1.3",
  lldpLocPortDesc:         "1.0.8802.1.1.2.1.3.7.1.4",
  lldpRemChassisIdSubtype: "1.0.8802.1.1.2.1.4.1.1.4",
  lldpRemChassisId:        "1.0.8802.1.1.2.1.4.1.1.5",
  lldpRemPortIdSubtype:    "1.0.8802.1.1.2.1.4.1.1.6",
  lldpRemPortId:           "1.0.8802.1.1.2.1.4.1.1.7",
  lldpRemPortDesc:         "1.0.8802.1.1.2.1.4.1.1.8",
  lldpRemSysName:          "1.0.8802.1.1.2.1.4.1.1.9",
  lldpRemSysDesc:          "1.0.8802.1.1.2.1.4.1.1.10",
  lldpRemSysCapEnabled:    "1.0.8802.1.1.2.1.4.1.1.12",
  lldpRemManAddr:          "1.0.8802.1.1.2.1.4.2.1",
  // FORTINET-FORTIAP-MIB::fapStationTable — wireless clients connected to a
  // FortiAP. INDEX = { fapStaRadioId, fapStaWlanId, fapStaMacAddr } where the
  // MAC is encoded as length-prefixed 6 octets (SMIv2 default for OCTET
  // STRING in INDEX), so each row's suffix is 9 parts:
  //   <radioId>.<wlanId>.6.<b0>.<b1>.<b2>.<b3>.<b4>.<b5>
  // collectWirelessStationsSnmp walks fapStaSSID as the discriminator
  // (every row has it set), then looks up the parallel columns by the
  // identical suffix.
  fapStaBSSID:        "1.3.6.1.4.1.12356.120.8.1.1.4",
  fapStaVlanId:       "1.3.6.1.4.1.12356.120.8.1.1.5",
  fapStaIpAddr:       "1.3.6.1.4.1.12356.120.8.1.1.6",
  fapStaSSID:         "1.3.6.1.4.1.12356.120.8.1.1.7",
  // FORTINET-FORTIAP-MIB::fapRadioTable (1.3.6.1.4.1.12356.120.4.1.1), INDEX =
  // { fapRadioIndex }. There is no band column, so we derive band per radio
  // from fapRadioType + fapRadioChannelOper (see utils/fortiapRadioBand) and
  // join it onto stations by radioId == fapRadioIndex.
  fapRadioType:        "1.3.6.1.4.1.12356.120.4.1.1.6",
  fapRadioChannelOper: "1.3.6.1.4.1.12356.120.4.1.1.14",
};

function buildSnmpSession(host: string, config: Record<string, unknown>, timeoutMs?: number): any {
  const port = toNonNegativeInt(config.port, 161);
  const version = config.version === "v3" ? "v3" : "v2c";
  // Caller-supplied timeout (resolved from the per-stream tier hierarchy)
  // overrides the legacy floor — but only when positive. A 0 or negative
  // value would silently disable timeouts in net-snmp, so we treat anything
  // unreasonable as "use the floor".
  const effectiveTimeout = (typeof timeoutMs === "number" && timeoutMs > 0)
    ? timeoutMs
    : COLLECTOR_REQUEST_TIMEOUT_MS;
  // net-snmp defaults to "udp4", which cannot reach an IPv6 target — an asset
  // polled on its primary IPv6 (business rule 128) needs the udp6 socket.
  const transport = isIpv6Address(host) ? "udp6" : "udp4";
  if (version === "v2c") {
    return snmp.createSession(host, String(config.community || ""), {
      port,
      transport,
      version: snmp.Version2c,
      timeout: effectiveTimeout,
      retries: 0,
    });
  }
  const securityLevel = config.securityLevel === "noAuthNoPriv"
    ? snmp.SecurityLevel.noAuthNoPriv
    : config.securityLevel === "authNoPriv"
      ? snmp.SecurityLevel.authNoPriv
      : snmp.SecurityLevel.authPriv;
  const user: any = { name: String(config.username || ""), level: securityLevel };
  if (securityLevel !== snmp.SecurityLevel.noAuthNoPriv) {
    user.authProtocol = mapSnmpAuthProtocol(config.authProtocol);
    user.authKey      = String(config.authKey || "");
  }
  if (securityLevel === snmp.SecurityLevel.authPriv) {
    user.privProtocol = mapSnmpPrivProtocol(config.privProtocol);
    user.privKey      = String(config.privKey || "");
  }
  return snmp.createV3Session(host, user, {
    port,
    transport,
    version: snmp.Version3,
    timeout: effectiveTimeout,
    retries: 0,
  });
}

/**
 * A broken agent returned an OID that doesn't lexicographically follow the
 * previous one — net-snmp's walk would re-anchor on it and spin forever
 * (seen in the field: ControlByWeb X-4xx echoes the queried OID back on
 * GETBULK). 502 because the device answered, just wrongly.
 */
function walkLoopError(baseOid: string, prevOid: string, oid: string): AppError {
  return new AppError(
    502,
    `SNMP walk of ${baseOid} aborted: agent returned a non-increasing OID (${oid} after ${prevOid}) — ` +
    `the device's SNMP agent is stuck in a GETNEXT/GETBULK loop instead of advancing. ` +
    `Try an SNMP v1 credential (avoids GETBULK) or a device firmware update.`,
  );
}

/**
 * Walk an OID subtree and return varbinds keyed by the index suffix that
 * follows `baseOid.`. Stops once `maxRows` rows have been collected, or
 * rejects if the agent stops advancing (walk loop).
 *
 * `maxRows` defaults to SNMP_WALK_MAX, which is sized for ifTable-shaped
 * walks. The forwarding-database walks pass their own (larger) cap: a switch
 * with more MACs than SNMP_WALK_MAX would otherwise be truncated here,
 * SILENTLY and below the truncation warning MAC_TABLE_ROW_CAP exists to
 * raise — and a partial FDB makes the per-port MAC counts, and any topology
 * inference drawn from them, quietly wrong.
 */
function snmpWalk(session: any, baseOid: string, maxRows: number = SNMP_WALK_MAX): Promise<Map<string, any>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, any>();
    const prefix = baseOid + ".";
    const guard = makeOidMonotonicGuard();
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      if (err) reject(err);
      else resolve(out);
    };
    try {
      session.subtree(
        baseOid,
        20, // maxRepetitions
        (varbinds: any[]) => {
          for (const vb of varbinds) {
            if (snmp.isVarbindError(vb)) continue;
            if (typeof vb.oid !== "string") continue;
            // Loop guard runs BEFORE the prefix filter: a broken agent that
            // echoes `baseOid` itself never matches `prefix`, so `out` never
            // grows and the SNMP_WALK_MAX cap alone would never trip — the
            // walk would spin forever holding the per-host SNMP gate.
            if (!guard.advance(vb.oid)) {
              finish(walkLoopError(baseOid, guard.last()!, vb.oid));
              return true; // stop the underlying net-snmp walk
            }
            if (!vb.oid.startsWith(prefix)) continue;
            const suffix = vb.oid.slice(prefix.length);
            out.set(suffix, vb.value);
            if (out.size >= maxRows) {
              finish();
              return true;
            }
          }
        },
        (err?: Error) => finish(err),
      );
    } catch (err: any) {
      finish(err);
    }
  });
}

function snmpVbToString(v: unknown): string {
  if (v == null) return "";
  if (Buffer.isBuffer(v)) return v.toString("utf8").replace(/\u0000+$/, "");
  return String(v);
}

/**
 * Decode a varbind value to a number, or null when the device said nothing.
 *
 * **An unanswered OID is null, never 0.** `snmpGetScalar` resolves `null` for
 * an error varbind (noSuchObject / noSuchInstance / endOfMibView), and the
 * `Number(v)` tail below reads `Number(null)` as a perfectly finite 0 — so a
 * scalar the device does not publish decoded as a confident zero. That cost a
 * FortiSwitch model whose fsSysCpuUsage / fsSysMemUsage do not sit at
 * ...12356.106.4.1.{2,3}.0 its entire CPU & Memory graph: both series read a
 * flat 0.0% forever, and because 0 is not null the HOST-RESOURCES-MIB fallback
 * in `collectTelemetrySnmp` never ran either, so nothing ever corrected it
 * (prod 2026-08-31, FortiSwitchRugged-112D-POE). Same invariant as business
 * rule 24's alarm bit: a source that publishes no value must never have its
 * absence mapped to 0.
 *
 * An EMPTY value gets the same answer for the same reason — an empty OCTET
 * STRING arrives as a zero-length Buffer, and `Number("")` is also 0.
 *
 * A Buffer longer than 8 bytes still falls through to the string coercion,
 * which is how an agent that publishes a wide counter as a decimal OCTET
 * STRING decodes.
 */
export function snmpVbToNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  if (Buffer.isBuffer(v)) {
    if (v.length === 0) return null;
    if (v.length <= 8) {
      let n = 0n;
      for (const b of v) n = (n << 8n) | BigInt(b);
      return Number(n);
    }
  }
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function snmpMacFromBuffer(v: unknown): string | null {
  if (!Buffer.isBuffer(v) || v.length !== 6) return null;
  return Array.from(v).map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

async function withSnmpSession<T>(host: string, config: Record<string, unknown>, fn: (s: any) => Promise<T>, timeoutMs?: number, gateWaitTimeoutMs?: number): Promise<T> {
  // Route every heavy SNMP collector (telemetry / systemInfo / LLDP overlay
  // / operator snmp-walk) through the per-host SNMP gate so a heavy walk
  // doesn't overlap with the cheap response-time probe on the same agent.
  // probeSnmp (which builds its own session for the sysUpTime get) also
  // acquires the same gate — both paths key on host:port so they FIFO.
  const port = toNonNegativeInt(config.port, 161);
  return withSnmpGate(host, port, async () => {
    const session = buildSnmpSession(host, config, timeoutMs);
    // net-snmp emits 'error' rather than throwing for socket/listener errors;
    // attach a no-op listener so a stray error doesn't kill the process. The
    // walk itself will still propagate the error through its callback.
    session.on?.("error", () => {});
    try {
      return await fn(session);
    } finally {
      try { session.close?.(); } catch {}
    }
  }, gateWaitTimeoutMs);
}

interface SnmpWalkRow {
  oid: string;
  type: string;
  value: string;
}

export interface SnmpWalkResult {
  rows: SnmpWalkRow[];
  truncated: boolean;
  durationMs: number;
}

/**
 * Operator-facing snmpwalk for the asset details SNMP Walk tab.
 *
 * Unlike the internal `snmpWalk()` above (which keys results by index suffix
 * and discards type info), this returns the full OID, the symbolic ASN.1 type
 * name (Counter32, OctetString, OID, ...), and a printable value. Hard-capped
 * at SNMP_WALK_HARD_MAX rows so an accidental walk of a huge subtree on a
 * busy device can't run away.
 */
const SNMP_WALK_HARD_MAX = 5000;

// Gate-wait budget for operator walks. The walk tab's client-side countdown
// aborts the request at 60s, so let the walk wait up to 50s for the per-host
// gate (vs. the collectors' 30s fail-fast default) — a walk queued behind a
// long telemetry/systemInfo scrape on the same device gets the whole
// countdown window to start instead of dying at 30s with a gate timeout.
const SNMP_WALK_GATE_WAIT_MS = 50_000;

function snmpTypeName(t: unknown): string {
  if (typeof t !== "number") return "Unknown";
  return (snmp.ObjectType as Record<number, string>)[t] || `Type(${t})`;
}

function snmpVarbindToPrintable(vb: { type: number; value: unknown }): string {
  const t = vb.type;
  const v = vb.value;
  if (v == null) return "";
  // OctetString: try utf8, fall back to hex when it isn't printable.
  if (Buffer.isBuffer(v)) {
    if (t === snmp.ObjectType.IpAddress && v.length === 4) {
      return `${v[0]}.${v[1]}.${v[2]}.${v[3]}`;
    }
    const text = v.toString("utf8");
    if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)) return trimTrailing(text, " ");
    return v.toString("hex").match(/.{1,2}/g)?.join(" ").toUpperCase() || "";
  }
  if (typeof v === "bigint") return v.toString();
  return String(v);
}

export async function snmpWalkRaw(
  host: string,
  config: Record<string, unknown>,
  baseOid: string,
  maxRows: number,
): Promise<SnmpWalkResult> {
  const cap = Math.max(1, Math.min(maxRows | 0, SNMP_WALK_HARD_MAX));
  const start = Date.now();
  return await withSnmpSession(host, config, (session) => {
    return new Promise<SnmpWalkResult>((resolve, reject) => {
      const rows: SnmpWalkRow[] = [];
      const guard = makeOidMonotonicGuard();
      let truncated = false;
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        if (err) reject(err);
        else resolve({ rows, truncated, durationMs: Date.now() - start });
      };
      try {
        session.subtree(
          baseOid,
          20, // maxRepetitions
          (varbinds: any[]) => {
            for (const vb of varbinds) {
              if (snmp.isVarbindError(vb)) continue;
              if (typeof vb.oid !== "string") continue;
              if (!guard.advance(vb.oid)) {
                finish(walkLoopError(baseOid, guard.last()!, vb.oid));
                return true; // stop the underlying net-snmp walk
              }
              rows.push({
                oid: vb.oid,
                type: snmpTypeName(vb.type),
                value: snmpVarbindToPrintable(vb),
              });
              if (rows.length >= cap) {
                truncated = true;
                finish();
                return true;
              }
            }
          },
          (err?: Error) => finish(err),
        );
      } catch (err: any) {
        finish(err);
      }
    });
  }, undefined, SNMP_WALK_GATE_WAIT_MS);
}

// Vendor-profile selection lives in profileResolver.ts (Phase 4 of uniform
// SNMP): `pickDbProfile` is imported above, and reads the operator's
// ManufacturerProfile rows ALONE — the hardcoded VENDOR_TELEMETRY_PROFILES
// constant is no longer consulted on this path.

/**
 * The identity `pickDbProfile` reads for one asset on one stream, with the
 * operator's per-stream MIB pin applied.
 *
 * When a MIB is pinned on this asset's stream (Asset / class-override /
 * integration tier), its own manufacturer + model override the asset's, and
 * its MODULE NAME is carried alongside them. That is how an operator
 * redirects a misclassified asset — a FortiSwitch whose discovery sources
 * stamped `manufacturer=Fortinet` with no model hint — into the right profile
 * without renaming the asset. `"std:<key>"` ids are display hints only and
 * never bias selection.
 *
 * The module name used to be stuffed into the `os` slot, because the only
 * matcher was a single haystack and that was the one place it would be seen.
 * `ProfileSubject.mibModule` is its own field now, so the asset's real OS
 * survives the redirect and the module name reaches BOTH the profile match
 * and the model match — a pinned FORTINET-FORTISWITCH-MIB now selects the
 * FortiSwitch rows as well as the Fortinet profile.
 */
async function profileSubjectFor(args: {
  manufacturer?: string | null;
  model?:        string | null;
  os?:           string | null;
  assetType?:    string | null;
  pinnedMibId?:  string | null;
}): Promise<ProfileSubject> {
  const subject: ProfileSubject = {
    manufacturer: args.manufacturer ?? null,
    os:           args.os ?? null,
    model:        args.model ?? null,
    assetType:    args.assetType ?? null,
    mibModule:    null,
  };
  if (!args.pinnedMibId || args.pinnedMibId.startsWith("std:")) return subject;

  const mib = await prisma.mibFile.findUnique({
    where:  { id: args.pinnedMibId },
    select: { moduleName: true, manufacturer: true, model: true },
  }).catch(() => null);
  if (!mib) return subject;

  return {
    ...subject,
    manufacturer: mib.manufacturer ?? subject.manufacturer,
    model:        mib.model        ?? subject.model,
    mibModule:    mib.moduleName ?? null,
  };
}

async function collectTelemetrySnmp(
  host: string,
  config: Record<string, unknown>,
  manufacturer?: string | null,
  model?: string | null,
  os?: string | null,
  timeoutMs?: number,
  telemetryMibId?: string | null,
  assetType?: string | null,
): Promise<TelemetrySample> {
  // Make sure the symbol table is populated before we try to resolve any
  // vendor symbols. ensureRegistryLoaded short-circuits after the first call.
  await ensureRegistryLoaded();

  // The operator's per-stream MIB pin can redirect this asset into a
  // different profile; see profileSubjectFor.
  const profile = pickDbProfile(
    await profileSubjectFor({ manufacturer, model, os, assetType, pinnedMibId: telemetryMibId }),
  );
  // Scope still uses the *asset's* manufacturer/model first so symbol
  // resolution through oidRegistry continues to pick up device-specific MIB
  // overrides for the actual asset, not the MIB pointed at by telemetryMibId.
  // The governing profile's manufacturer is the second scope (business rule
  // 131): a profile reached through `matchPattern` or a pin has its MIBs
  // uploaded under its own name, not the asset's.
  const scope: ResolveScope = { manufacturer, model, profileManufacturer: profile?.profileManufacturer };

  return await withSnmpSession(host, config, async (session) => {
    let cpuPct: number | null = null;
    let memUsedBytes: number | null = null;
    let memTotalBytes: number | null = null;
    let memPct: number | null = null;

    // ── CPU ──
    // Try the vendor profile first if one matches and its symbol resolves.
    // If the vendor query yields nothing (MIB not uploaded, or device doesn't
    // expose the OID), fall back to HOST-RESOURCES-MIB so a stock SNMP host
    // still gets coverage.
    if (profile?.cpu) {
      cpuPct = await collectCpuVendor(session, profile, profile.cpu, scope).catch(() => null);
    }
    if (cpuPct == null) {
      cpuPct = await collectCpuHostResources(session).catch(() => null);
    }

    // ── Memory ──
    if (profile?.memory) {
      const m = await collectMemoryVendor(session, profile, profile.memory, scope).catch(() => null);
      if (m) {
        memUsedBytes  = m.memUsedBytes  ?? memUsedBytes;
        memTotalBytes = m.memTotalBytes ?? memTotalBytes;
        memPct        = m.memPct        ?? memPct;
      }
    }
    if (memUsedBytes == null && memPct == null) {
      const hrm = await collectMemoryHostResources(session).catch(() => null);
      if (hrm) {
        memUsedBytes  = hrm.memUsedBytes;
        memTotalBytes = hrm.memTotalBytes;
        memPct        = hrm.memPct;
      }
    } else if (memUsedBytes != null && memTotalBytes != null && memTotalBytes > 0 && memPct == null) {
      memPct = clampPct((memUsedBytes / memTotalBytes) * 100);
    }

    // Hardware sensors are collected separately by `collectHardwareSensors`,
    // which dispatches on temperaturePolling instead of cpuMemoryPolling so an
    // operator can run CPU/memory over REST and hardware sensors over SNMP (the
    // common branch-class FortiGate workaround for an unreliable
    // /api/v2/monitor/system/sensor-info).
    return { cpuPct, memPct, memUsedBytes, memTotalBytes };
  }, timeoutMs);
}

// ─── Vendor + HOST-RESOURCES-MIB helpers ──────────────────────────────────

async function collectCpuHostResources(session: any): Promise<number | null> {
  const cpuRows = await snmpWalk(session, OID.hrProcessorLoad);
  const vals: number[] = [];
  for (const v of cpuRows.values()) {
    const n = snmpVbToNumber(v);
    if (n != null) vals.push(n);
  }
  if (vals.length === 0) return null;
  return clampPct(vals.reduce((a, b) => a + b, 0) / vals.length);
}

async function collectMemoryHostResources(
  session: any,
): Promise<{ memUsedBytes: number | null; memTotalBytes: number | null; memPct: number | null } | null> {
  const types = await snmpWalk(session, OID.hrStorageType);
  const ramIdx = [...types.entries()].find(([, v]) => snmpVbToString(v) === OID.hrStorageRam)?.[0];
  if (!ramIdx) return null;
  const [units, size, used] = await Promise.all([
    snmpWalk(session, OID.hrStorageAllocationUnits + "." + ramIdx).catch(() => new Map()),
    snmpWalk(session, OID.hrStorageSize             + "." + ramIdx).catch(() => new Map()),
    snmpWalk(session, OID.hrStorageUsed             + "." + ramIdx).catch(() => new Map()),
  ]);
  const u = snmpVbToNumber(units.get("")) ?? 1;
  const s = snmpVbToNumber(size.get(""));
  const ud = snmpVbToNumber(used.get(""));
  let memUsedBytes: number | null = null;
  let memTotalBytes: number | null = null;
  let memPct: number | null = null;
  if (s != null) memTotalBytes = s * u;
  if (ud != null) memUsedBytes = ud * u;
  if (memTotalBytes && memTotalBytes > 0 && memUsedBytes != null) {
    memPct = clampPct((memUsedBytes / memTotalBytes) * 100);
  }
  return { memUsedBytes, memTotalBytes, memPct };
}

// Resolve a vendor symbolic OID and emit a single GET on the `.0` instance,
// or a subtree walk + average / sum depending on the profile mode.
async function collectCpuVendor(
  session: any,
  profile: VendorTelemetryProfile,
  cpu: NonNullable<VendorTelemetryProfile["cpu"]>,
  scope: ResolveScope,
): Promise<number | null> {
  const oid = resolveOidSync(cpu.symbol, scope);
  if (!oid) {
    logger.debug({ vendor: profile.vendor, symbol: cpu.symbol, scope }, "vendor CPU symbol unresolved — upload its MIB to enable");
    return null;
  }
  if (cpu.mode === "scalar") {
    const v = await snmpGetScalar(session, oid);
    const n = snmpVbToNumber(v);
    return n != null ? clampPct(n) : null;
  }
  // walk-avg
  const rows = await snmpWalk(session, oid);
  const vals: number[] = [];
  for (const v of rows.values()) {
    const n = snmpVbToNumber(v);
    if (n != null) vals.push(n);
  }
  if (vals.length === 0) return null;
  return clampPct(vals.reduce((a, b) => a + b, 0) / vals.length);
}

async function collectMemoryVendor(
  session: any,
  profile: VendorTelemetryProfile,
  mem: NonNullable<VendorTelemetryProfile["memory"]>,
  scope: ResolveScope,
): Promise<{ memUsedBytes: number | null; memTotalBytes: number | null; memPct: number | null } | null> {
  // Prefer byte-form pairs (used + free or used + total). When both are
  // missing fall back to a single percent symbol.
  const usedOid  = mem.usedBytesSymbol  ? resolveOidSync(mem.usedBytesSymbol,  scope) : null;
  const freeOid  = mem.freeBytesSymbol  ? resolveOidSync(mem.freeBytesSymbol,  scope) : null;
  const totalOid = mem.totalBytesSymbol ? resolveOidSync(mem.totalBytesSymbol, scope) : null;
  const pctOid   = mem.pctSymbol        ? resolveOidSync(mem.pctSymbol,        scope) : null;

  const sumWalk = async (oid: string): Promise<number | null> => {
    if (mem.walkSubtree) {
      const rows = await snmpWalk(session, oid);
      let total = 0;
      let any = false;
      for (const v of rows.values()) {
        const n = snmpVbToNumber(v);
        if (n != null) { total += n; any = true; }
      }
      return any ? total : null;
    }
    const v = await snmpGetScalar(session, oid);
    return snmpVbToNumber(v);
  };

  let memUsedBytes: number | null = null;
  let memTotalBytes: number | null = null;
  let memPct: number | null = null;

  if (usedOid) memUsedBytes = await sumWalk(usedOid).catch(() => null);
  if (totalOid) {
    memTotalBytes = await sumWalk(totalOid).catch(() => null);
  } else if (freeOid && memUsedBytes != null) {
    const free = await sumWalk(freeOid).catch(() => null);
    if (free != null) memTotalBytes = memUsedBytes + free;
  }

  if (memUsedBytes != null && memTotalBytes && memTotalBytes > 0) {
    memPct = clampPct((memUsedBytes / memTotalBytes) * 100);
  } else if (pctOid) {
    const p = await sumWalk(pctOid).catch(() => null);
    if (p != null) {
      // Walked-then-summed percentages (e.g. Juniper jnxOperatingBuffer
      // averaged across operating entities) are technically a sum, but the
      // operator-meaningful value is the average. Re-divide by row count.
      if (mem.walkSubtree && pctOid) {
        const rows = await snmpWalk(session, pctOid).catch(() => new Map());
        const count = [...rows.values()].filter((v) => snmpVbToNumber(v) != null).length;
        memPct = count > 0 ? clampPct(p / count) : null;
      } else {
        memPct = clampPct(p);
      }
    }
  }

  if (memUsedBytes == null && memTotalBytes == null && memPct == null) return null;
  return { memUsedBytes, memTotalBytes, memPct };
}

// Single-OID GET (instance .0). Returns the varbind value or null.
function snmpGetScalar(session: any, oid: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const target = oid.endsWith(".0") ? oid : oid + ".0";
    try {
      session.get([target], (err: Error | null, varbinds: any[]) => {
        if (err) return reject(err);
        const vb = varbinds?.[0];
        if (!vb || snmp.isVarbindError(vb)) return resolve(null);
        resolve(vb.value);
      });
    } catch (err: any) {
      reject(err);
    }
  });
}

/**
 * Targeted multi-OID GET. Backs the wire-level filtered fast cadence: pulls
 * exactly the column values we need at known ifIndex / hrStorageIndex slots
 * instead of walking entire IF-MIB / hrStorage subtrees. Chunked to
 * SNMP_MULTI_GET_BATCH OIDs per request because most agents enforce a per-PDU
 * varbind limit (anywhere from ~50 to ~100 depending on vendor); 40 is safely
 * below the lowest commonly-seen cap.
 *
 * Returns a Map keyed by the input OID with the varbind value (or null on
 * varbindError / noSuchInstance — same as snmpGetScalar). Errors from the
 * SNMP layer (timeout, connection failure) reject the promise.
 */
const SNMP_MULTI_GET_BATCH = 40;
function snmpMultiGet(session: any, oids: string[]): Promise<Map<string, unknown>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, unknown>();
    if (oids.length === 0) return resolve(out);
    // Dedup + preserve order. Useful for callers that build OID lists across
    // many resolution steps and may accidentally repeat.
    const uniqueOids = Array.from(new Set(oids));
    const batches = chunkArray(uniqueOids, SNMP_MULTI_GET_BATCH);
    let remaining = batches.length;
    let aborted = false;
    const fail = (err: Error) => {
      if (aborted) return;
      aborted = true;
      reject(err);
    };
    for (const batch of batches) {
      try {
        session.get(batch, (err: Error | null, varbinds: any[]) => {
          if (aborted) return;
          if (err) return fail(err);
          for (let i = 0; i < batch.length; i++) {
            const vb = varbinds?.[i];
            if (!vb || snmp.isVarbindError(vb)) {
              out.set(batch[i] as string, null);
            } else {
              out.set(batch[i] as string, vb.value);
            }
          }
          remaining -= 1;
          if (remaining === 0) resolve(out);
        });
      } catch (err: any) {
        return fail(err);
      }
    }
  });
}

/**
 * Unit-level PoE from pethMainPseTable, as hardware-sensor rows.
 *
 * Emitted as sensors rather than given their own table because that is exactly
 * what they are - per-device readings with a name and a unit - and it means
 * charts, rollups, retention and BOTH automation metrics work with no new
 * code: `hwSensorValue` for "budget nearly exhausted" and `hwSensorAlarm` for
 * the PSE's own faulty bit.
 *
 * `pethMainPseUsageThreshold` is deliberately not collected: it is a
 * configured threshold, not a reading, and storing config as a time series
 * would just be a flat line.
 *
 * Rows are suffixed with the group index only when a device reports more than
 * one PSE, so a standalone switch gets stable, clean sensor names - the name
 * is the automation dimension and the rollup series key, so it must not churn.
 */
async function collectPoePseSnmp(session: any): Promise<HardwareSensorSample[]> {
  const [powers, consumptions, statuses] = await Promise.all([
    snmpWalk(session, OID.pethMainPsePower).catch(() => new Map()),
    snmpWalk(session, OID.pethMainPseConsumptionPower).catch(() => new Map()),
    snmpWalk(session, OID.pethMainPseOperStatus).catch(() => new Map()),
  ]);
  const indexes = new Set<string>([...powers.keys(), ...consumptions.keys(), ...statuses.keys()]);
  if (indexes.size === 0) return [];

  const multi = indexes.size > 1;
  const out: HardwareSensorSample[] = [];
  for (const idx of indexes) {
    const suffix = multi ? ` (PSE ${idx})` : "";
    const alarmStatus = pseOperStatusToAlarm(snmpVbToNumber(statuses.get(idx)));
    const budget = snmpVbToNumber(powers.get(idx));
    const used   = snmpVbToNumber(consumptions.get(idx));
    // The alarm rides the consumption row so a PSE fault surfaces on the
    // reading an operator actually watches, rather than on a static budget.
    if (used != null) {
      out.push({ sensorName: `PoE Power Consumption${suffix}`, sensorClass: "poe", value: used, unit: "W", alarmStatus });
    }
    if (budget != null) {
      out.push({ sensorName: `PoE Power Budget${suffix}`, sensorClass: "poe", value: budget, unit: "W", alarmStatus: null });
    }
  }
  return out;
}

/**
 * Hardware sensors, plus unit-level PoE appended for any device that has a PSE.
 *
 * The append lives in a wrapper because the core collector has three separate
 * return paths (profile sensor table / ENTITY-SENSOR / vendor scalar) and PoE
 * is orthogonal to which of them produced the sensor rows - a FortiSwitch takes
 * the ENTITY-SENSOR path and still has a PSE.
 */
async function collectHardwareSensorsSnmp(
  session: any,
  profile?: VendorTelemetryProfile | null,
  scope?: ResolveScope,
): Promise<HardwareSensorSample[]> {
  const [sensors, pse] = await Promise.all([
    collectHardwareSensorsSnmpCore(session, profile, scope),
    collectPoePseSnmp(session).catch(() => [] as HardwareSensorSample[]),
  ]);
  return pse.length > 0 ? [...sensors, ...pse] : sensors;
}

async function collectHardwareSensorsSnmpCore(
  session: any,
  profile?: VendorTelemetryProfile | null,
  scope?: ResolveScope,
): Promise<HardwareSensorSample[]> {
  // 1. The profile's sensor table, when its Hardware Sensors row is a `table`
  //    (business rule 132): the columns the row names, walked and joined. On a
  //    FortiGate that is fgHwSensorTable (temperature + fan + voltage + power +
  //    disk + alarm), the comprehensive source there. An empty walk — a
  //    FortiSwitch or FortiAP that inherited the Fortinet row, or a symbol
  //    whose MIB isn't uploaded — falls through to the standard paths below.
  if (profile?.temperature?.mode === "table") {
    const tableRows = await collectSensorTableSnmp(session, profile, profile.temperature, scope ?? {});
    if (tableRows.length > 0) return tableRows;
  }

  // 2. ENTITY-SENSOR-MIB (RFC 3433). Standard table on non-Fortinet gear (and
  //    FortiSwitch). Every class the table reports is surfaced — temperature,
  //    fan, voltage, transceiver bias current and optical power — plus the
  //    agent's own per-sensor oper status as the alarm bit.
  //
  //    This used to keep celsius rows only, drop any row whose descr mentioned
  //    sfp/fan/voltage/bias, and drop any row whose oper status was not ok.
  //    On a FortiSwitch those three filters discarded the entire transceiver
  //    picture — the DDM readings were already on the wire.
  const [types, values, scales, precisions, opers, descrs, unitsDisplays] = await Promise.all([
    snmpWalk(session, OID.entPhySensorType).catch(() => new Map()),
    snmpWalk(session, OID.entPhySensorValue).catch(() => new Map()),
    snmpWalk(session, OID.entPhySensorScale).catch(() => new Map()),
    snmpWalk(session, OID.entPhySensorPrecision).catch(() => new Map()),
    snmpWalk(session, OID.entPhySensorOperStatus).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalDescr).catch(() => new Map()),
    // The only reliable dBm signal — RFC 3433's type enum cannot express
    // optical power, so vendors declare the real unit here.
    snmpWalk(session, OID.entPhySensorUnitsDisplay).catch(() => new Map()),
  ]);
  const out: HardwareSensorSample[] = [];
  // Decided once per table, not per row: a device reporting a single type code
  // across every sensor (FortiSwitchOS stamps celsius on all of them) is
  // defaulting rather than describing, so names classify instead.
  const typeColumnTrusted = entityTypeColumnTrusted(
    [...types.values()]
      .map((v) => snmpVbToNumber(v))
      .filter((n): n is number => n != null),
  );
  // Transceiver readings published as anonymous groups of five get their port
  // (business rule 143). IF-MIB is walked only when the table holds a dBm row
  // at all, so a device with no optics pays nothing for this.
  const layoutRows: EntitySensorLayoutRow[] = [...types.entries()].map(([idx, typeRaw]) => ({
    index:        Number(idx),
    typeCode:     snmpVbToNumber(typeRaw),
    unitsDisplay: snmpVbToString(unitsDisplays.get(idx)) || null,
  })).filter((r) => Number.isInteger(r.index));
  let sfpByIndex = new Map<number, SfpAttribution>();
  if (layoutRows.some((r) => unitsDisplayLooksOptical(r.unitsDisplay))) {
    const ifNames = await snmpWalk(session, OID.ifName).catch(() => new Map());
    sfpByIndex = attributeSfpSensors(layoutRows, [...ifNames.values()].map((v) => snmpVbToString(v)));
  }
  for (const [idx, typeRaw] of types.entries()) {
    const t = snmpVbToNumber(typeRaw);
    const oper = snmpVbToNumber(opers.get(idx));
    const descr = snmpVbToString(descrs.get(idx));
    const unitsDisplay = snmpVbToString(unitsDisplays.get(idx));
    const { sensorClass, unit } = classifyEntitySensor({
      typeCode: t,
      unitsDisplay,
      descr,
      typeColumnTrusted,
    });
    const sfp = sfpByIndex.get(Number(idx));
    const raw = snmpVbToNumber(values.get(idx));
    const scale = snmpVbToNumber(scales.get(idx));   // SI prefix code
    const prec  = snmpVbToNumber(precisions.get(idx)); // decimal-point shift
    // A broken or unreadable sensor keeps its row with a null value: the row IS
    // the fault signal, and dropping it would also strip the alarm status that
    // makes the fault alertable. `value` is nullable for exactly this case.
    const scaled = raw != null && oper !== 2 && oper !== 3
      ? scaleEntitySensor(raw, scale, prec)
      : null;
    out.push({
      // An attributed transceiver reading is named for its port and role; the
      // agent's own descr for these rows is positional and unreliable.
      sensorName:  sfp ? sfpSensorName(sfp.ifName, sfp.role) : (descr || `sensor-${idx}`),
      sensorClass,
      // Six decimals, not two: bias current is stored in BASE amperes, and
      // rounding 8.98 mA to the hundredth of an amp stored 0.01.
      value:       scaled != null && Number.isFinite(scaled) ? Math.round(scaled * 1e6) / 1e6 : null,
      unit,
      alarmStatus: entityOperStatusToAlarm(oper),
      ...(sfp ? { ifName: sfp.ifName } : {}),
    });
  }
  if (out.length > 0) return out;

  // 3. Profile-driven scalar symbol. Used by vendors whose hardware publishes a
  //    single Celsius scalar rather than a sensor table — currently the FortiAP
  //    (fapTemperature @ 12356.120.3.44). The row's transform scales a raw
  //    integer into °C first (tenths_to_units for a DISPLAY-HINT "d-1"
  //    sensor); the resolver only ever passes one METRIC_ROW_TRANSFORMS allows.
  if (profile?.temperature?.mode === "scalar") {
    const tempOid = resolveOidSync(profile.temperature.symbol, scope ?? {});
    if (tempOid) {
      const v = await snmpGetScalar(session, tempOid).catch(() => null);
      const n = applyTransform(snmpVbToNumber(v), profile.temperature.transform);
      if (n != null && Number.isFinite(n)) {
        out.push({
          sensorName:  profile.temperature.sensorName ?? "System",
          sensorClass: "temperature",
          value:       Math.round(n * 10) / 10,
          unit:        "°C",
          alarmStatus: null,
        });
      }
    } else {
      logger.debug(
        { vendor: profile.vendor, symbol: profile.temperature.symbol, scope },
        "vendor hardware-sensor symbol unresolved — upload its MIB to enable",
      );
    }
  }
  return out;
}

// A profile's declarative sensor table (business rule 132). The row's symbol is
// the VALUE column; `columns` names the siblings — a name column, an alarm
// column with its mapping, an optional fixed class and scale. Each column is a
// symbol resolved at the asset's scope then the profile's (rule 131), walked
// once, stringified, and joined on the shared index by `sensorTableRows`. A
// value column that does not resolve walks nothing: the MIB is not uploaded,
// and the profile page says so. An optional column that does not resolve
// costs only its own facts (unnamed rows, no alarm status).
async function collectSensorTableSnmp(
  session: any,
  profile: VendorTelemetryProfile,
  query: NonNullable<VendorTelemetryProfile["temperature"]>,
  scope: ResolveScope,
): Promise<HardwareSensorSample[]> {
  const columns = query.columns ?? { nameSymbol: null, alarmSymbol: null, alarmMap: null, sensorClass: null, transform: null };
  const valueOid = resolveOidSync(query.symbol, scope);
  if (!valueOid) {
    logger.debug({ vendor: profile.vendor, symbol: query.symbol, scope }, "sensor table value column unresolved — upload its MIB to enable");
    return [];
  }
  const nameOid  = columns.nameSymbol  ? resolveOidSync(columns.nameSymbol,  scope) : null;
  const alarmOid = columns.alarmSymbol ? resolveOidSync(columns.alarmSymbol, scope) : null;
  const asStrings = (m: Map<string, unknown>): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [k, v] of m.entries()) out.set(k, snmpVbToString(v));
    return out;
  };
  const [values, names, alarms] = await Promise.all([
    snmpWalk(session, valueOid).catch(() => new Map()),
    nameOid  ? snmpWalk(session, nameOid).catch(() => new Map())  : Promise.resolve(null),
    alarmOid ? snmpWalk(session, alarmOid).catch(() => new Map()) : Promise.resolve(null),
  ]);
  return sensorTableRows({
    values:  asStrings(values),
    names:   names ? asStrings(names) : null,
    alarms:  alarms ? asStrings(alarms) : null,
    columns,
  });
}

// ─── PoE (POWER-ETHERNET-MIB) ──────────────────────────────────────────────
//
// Negative cache for devices with no PSE. Most of a fleet is not PoE-capable,
// and both the heavy AND the per-minute fast cadence would otherwise pay two
// empty column walks per tick per device forever. One empty result marks the
// target for the TTL; a PoE switch keeps paying two small walks a minute,
// which is what makes a PoE fault alertable at the fast cadence instead of the
// heavy one.
//
// Deliberately NOT cached positively: the readings are the whole point, and
// they change whenever a powered device is plugged, unplugged or faults.
const POE_ABSENT_TTL_MS = 30 * 60_000;
const POE_ABSENT_MAX    = 4000;
const poeAbsentCache    = new Map<string, number>();

/**
 * Walk pethPsePortTable and return per-ifName PoE state, or an empty map when
 * the device has no PSE. Correlation to interfaces is inference — see
 * utils/poePorts.ts — so an unresolvable row is dropped, never guessed.
 *
 * `ifNameByIndex` is supplied by the caller because both cadences have already
 * walked ifName/ifDescr for their own purposes; re-walking here would double
 * the cost of the thing this cache exists to keep cheap.
 */
async function collectPoePortsSnmp(
  session: any,
  cacheKey: string | null,
  ifNameByIndex: ReadonlyMap<string, string>,
): Promise<Map<string, { poeStatus: string | null; poeClass: string | null }>> {
  const out = new Map<string, { poeStatus: string | null; poeClass: string | null }>();
  if (ifNameByIndex.size === 0) return out;

  const now = Date.now();
  if (cacheKey) {
    const absentAt = poeAbsentCache.get(cacheKey);
    if (absentAt != null && now - absentAt < POE_ABSENT_TTL_MS) return out;
  }

  // A walk that ERRORED and a walk that answered with NO ROWS mean opposite
  // things. Collapsing both into an empty Map (the old `.catch(() => new Map())`
  // on the status column) is what let ONE timed-out walk write the absent-cache
  // and blank PoE on a healthy switch for the next POE_ABSENT_TTL_MS — half an
  // hour of `poeStatus: null` on every sample it writes, which is long enough
  // for a live PoE alert to be retired as a vanished dimension and re-raised as
  // a new one. Only an ANSWER with no rows is evidence the device has no PSE.
  const [statuses, classes] = await Promise.all([
    snmpWalk(session, OID.pethPsePortDetectionStatus).then((m) => m, () => null),
    snmpWalk(session, OID.pethPsePortPowerClassifications).catch(() => new Map()),
  ]);

  // Unreadable this tick: no rows, and deliberately NO cache write — the next
  // tick asks again rather than assuming the PSE went away. Written as a bare
  // null test rather than only through poeWalkOutcome so `statuses` narrows for
  // the `.get()` calls below.
  if (statuses === null) return out;
  if (poeWalkOutcome(statuses) === "no-pse") {
    if (cacheKey) {
      if (poeAbsentCache.size >= POE_ABSENT_MAX) poeAbsentCache.clear();
      poeAbsentCache.set(cacheKey, now);
    }
    return out;
  }
  if (cacheKey) poeAbsentCache.delete(cacheKey);

  const ifNameBySuffix = poeIfNameByIndex([...statuses.keys()], ifNameByIndex);
  for (const [suffix, ifName] of ifNameBySuffix.entries()) {
    out.set(ifName, {
      poeStatus: poeStatusLabel(snmpVbToNumber(statuses.get(suffix))),
      poeClass:  poeClassLabel(snmpVbToNumber(classes.get(suffix))),
    });
  }
  return out;
}

// Apply ENTITY-SENSOR-MIB scale + precision to a raw integer reading. Scale is
// the SI-prefix code (1=10^-24 ... 9=10^0 ... 17=10^24); precision is a signed
// shift of the decimal point. Both default to "no scaling" when omitted.
function scaleEntitySensor(raw: number, scale: number | null, precision: number | null): number {
  const sExp = scale != null ? (scale - 9) * 3 : 0;
  const pExp = precision != null ? -precision : 0;
  return raw * Math.pow(10, sExp) * Math.pow(10, pExp);
}

/**
 * Walk ENTITY-MIB entPhysicalTable for field-replaceable hardware — the
 * transceivers, PSUs and fan trays an operator can actually swap.
 *
 * Returns [] when the device publishes no entPhysicalTable at all; the caller
 * distinguishes that from "queried and found nothing" by whether it called at
 * all (undefined vs []). Nine columns, all on the heavy cadence only: a serial
 * number changes when someone pulls a module, not on a poll interval.
 *
 * No interface correlation is attempted: see the ifName note at the row
 * build below.
 */
const PHYSICAL_ENTITY_ROW_CAP = 500;

async function collectPhysicalEntitiesSnmp(
  session: any,
): Promise<PhysicalEntitySample[]> {
  const [classes, descrs, names, hwRevs, fwRevs, serials, mfgs, models, isFrus] = await Promise.all([
    snmpWalk(session, OID.entPhysicalClass).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalDescr).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalName).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalHardwareRev).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalFirmwareRev).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalSerialNum).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalMfgName).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalModelName).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalIsFRU).catch(() => new Map()),
  ]);
  if (classes.size === 0) return [];

  const out: PhysicalEntitySample[] = [];
  let dropped = 0;
  const str = (m: Map<string, unknown>, idx: string): string | null => {
    const v = snmpVbToString(m.get(idx)).trim();
    return v ? v : null;
  };

  for (const [idx, classRaw] of classes.entries()) {
    const entIndex = Number(idx);
    if (!Number.isFinite(entIndex)) continue;
    const entClass  = entityPhysicalClassLabel(snmpVbToNumber(classRaw));
    const serialNum = str(serials, idx);
    const modelName = str(models, idx);
    // RFC 4133 TruthValue: true(1) / false(2).
    const isFru     = snmpVbToNumber(isFrus.get(idx)) === 1;
    if (!entityPhysicalIsInventory({ entClass, isFru, serialNum, modelName })) continue;

    if (out.length >= PHYSICAL_ENTITY_ROW_CAP) { dropped++; continue; }
    out.push({
      entIndex,
      entClass,
      descr:       str(descrs, idx),
      name:        str(names, idx),
      hardwareRev: str(hwRevs, idx),
      firmwareRev: str(fwRevs, idx),
      serialNum,
      mfgName:     str(mfgs, idx),
      modelName,
      isFru,
      // Deliberately NOT populated. Correlating a module to an interface by
      // entPhysicalIndex == ifIndex is the same equivalence the FortiSwitch
      // sensor annotation was reverted for (97e54fd2): right often enough to
      // look correct, silently wrong the rest of the time, and an operator
      // reading "SFP (port5)" cannot tell a real correlation from a
      // coincidence. The honest chain is entPhysicalContainedIn ->
      // entAliasMappingIdentifier (RFC 4133), which needs a real switch to
      // validate against; the column stays nullable and waits for it.
      ifName: null,
    });
  }
  // Loudly, not silently: a truncated inventory that looks complete is worse
  // than one an operator knows is truncated.
  if (dropped > 0) {
    logger.warn({ dropped, cap: PHYSICAL_ENTITY_ROW_CAP }, "entPhysicalTable inventory truncated");
  }
  return out;
}

/**
 * Full-replace an asset's hardware inventory. Same delete-replace shape as
 * persistLldpNeighbors / persistMclagPeers: current state, no history.
 *
 * `firstSeen` is preserved across scrapes for a module that is still present,
 * so "this SFP has been in this port since March" survives; a swapped module
 * (same slot, new serial) correctly resets it.
 */
async function persistPhysicalEntities(assetId: string, rows: PhysicalEntitySample[]): Promise<void> {
  const existing = await prisma.assetPhysicalEntity.findMany({
    where: { assetId },
    select: { entIndex: true, serialNum: true, firstSeen: true },
  });
  const prior = new Map(existing.map((e) => [e.entIndex, e]));
  const now = new Date();

  await prisma.$transaction([
    prisma.assetPhysicalEntity.deleteMany({ where: { assetId } }),
    ...(rows.length > 0
      ? [prisma.assetPhysicalEntity.createMany({
          data: rows.map((r) => {
            const was = prior.get(r.entIndex);
            const sameModule = was && (was.serialNum ?? null) === (r.serialNum ?? null);
            return { assetId, ...r, firstSeen: sameModule ? was!.firstSeen : now, lastSeen: now };
          }),
        })]
      : []),
  ]);
}

/**
 * Cap per asset. A single 48-port access switch routinely holds a few thousand
 * FDB entries; a distribution switch can hold tens of thousands. The cap keeps
 * one device from dominating a scrape and the table, and truncation is WARNED
 * rather than silent because a partial table makes the per-port MAC counts --
 * and therefore any uplink inference drawn from them -- quietly wrong.
 */
const MAC_TABLE_ROW_CAP = 4000;

/**
 * Walk `dot1dBasePortIfIndex` and fold it into dot1dBasePort -> ifName.
 *
 * Both switch-class walks that follow report a dot1dBasePort rather than an
 * ifIndex -- the forwarding database and the Q-BRIDGE VLAN bitmaps -- and both
 * need this same join, so it is walked once per pass and handed to each. The
 * join is defined by the MIB (unlike the PoE correlation), so it is reliable;
 * what is not optional is performing it, since attributing a row to whatever
 * interface sits at that number is reliably wrong wherever the two numbering
 * schemes differ.
 */
async function collectBasePortIfNames(
  session: any,
  ifNameByIndex: ReadonlyMap<string, string>,
): Promise<Map<number, string>> {
  const basePortWalk = await snmpWalk(session, OID.dot1dBasePortIfIndex).catch(() => new Map());
  const basePortToIfIndex = new Map<string, number>();
  for (const [basePort, vb] of basePortWalk.entries()) {
    const idx = snmpVbToNumber(vb);
    if (idx != null) basePortToIfIndex.set(basePort, idx);
  }
  return basePortToIfName(basePortToIfIndex, ifNameByIndex);
}

/**
 * Walk the switch forwarding database.
 *
 * Prefers Q-BRIDGE-MIB `dot1qTpFdbTable`, which a VLAN-aware switch populates
 * and which carries the VLAN in its index; falls back to BRIDGE-MIB
 * `dot1dTpFdbTable` for switches that only answer the older table (those rows
 * have no VLAN dimension at all, hence a null vlanId rather than a guess).
 *
 * Returns undefined when the device answers neither table, so the caller can
 * distinguish "not a bridge" from "a bridge with an empty table" — the same
 * undefined-preserves / []-wipes contract LLDP uses.
 */
/**
 * The device's IP neighbour cache over SNMP (IP-MIB, bundled as `std:ip`).
 *
 * Modern table first, deprecated table as fallback -- the dot1qTpFdbTable ->
 * dot1dTpFdbTable shape. The modern one is preferred for two reasons beyond
 * being current: it carries IPv6 neighbour-discovery entries, which the FortiOS
 * REST `/monitor/network/arp` endpoint does not expose at all, and its
 * `LastUpdated` column is what makes a real per-entry age possible.
 *
 * Decoding is pure and lives in utils/arpNeighbors.ts. Returns `undefined`
 * when nothing decoded -- a router always has neighbours, so zero rows is
 * far more likely "this agent does not implement IP-MIB" than "the cache is
 * empty", and the writer accumulates rather than replacing, so preserving
 * costs nothing.
 */
async function collectArpNeighborsSnmp(
  session: any,
  ifNameByIndex: Map<number, string>,
): Promise<ArpNeighborEntry[] | undefined> {
  // sysUpTime is needed to turn ipNetToPhysicalLastUpdated (a stamp, not an
  // age) into seconds. Walked rather than GET so this uses the same helper as
  // everything else here; the scalar returns a single row keyed "0".
  const sysUpTimeTicks = await snmpWalk(session, "1.3.6.1.2.1.1.3")
    .then((m) => { for (const v of m.values()) return snmpVbToNumber(v); return null; })
    .catch(() => null);

  const physAddress = await snmpWalk(session, OID.ipNetToPhysicalPhysAddress).catch(() => new Map());
  if (physAddress.size > 0) {
    const [type, state, lastUpdated] = await Promise.all([
      snmpWalk(session, OID.ipNetToPhysicalType).catch(() => new Map()),
      snmpWalk(session, OID.ipNetToPhysicalState).catch(() => new Map()),
      snmpWalk(session, OID.ipNetToPhysicalLastUpdated).catch(() => new Map()),
    ]);
    const rows = buildArpNeighbors({
      physAddress, type, state, lastUpdated, sysUpTimeTicks,
      ifNameByIndex, variant: "physical", toNumber: snmpVbToNumber,
    });
    if (rows.length > 0) return rows;
    // The table answered and every row was dropped -- worth saying out loud,
    // the same way the FDB collector reports an undecodable walk, because the
    // silent version looks exactly like a gate with no neighbours.
    logger.warn(
      { phase: "arp.snmp.undecodable", table: "ipNetToPhysical", walked: physAddress.size },
      "IP-MIB neighbour walk answered but no row survived decoding",
    );
  }

  // Deprecated table. No state column and no LastUpdated, so no age.
  const mediaAddress = await snmpWalk(session, OID.ipNetToMediaPhysAddress).catch(() => new Map());
  if (mediaAddress.size === 0) return undefined;
  const mediaType = await snmpWalk(session, OID.ipNetToMediaType).catch(() => new Map());
  const rows = buildArpNeighbors({
    physAddress: mediaAddress, type: mediaType,
    ifNameByIndex, variant: "media", toNumber: snmpVbToNumber,
  });
  if (rows.length === 0) {
    logger.warn(
      { phase: "arp.snmp.undecodable", table: "ipNetToMedia", walked: mediaAddress.size },
      "IP-MIB neighbour walk answered but no row survived decoding",
    );
    return undefined;
  }
  return rows;
}

async function collectMacTableSnmp(
  session: any,
  ifNameByBasePort: ReadonlyMap<number, string>,
): Promise<FdbEntry[] | undefined> {
  // Each table is walked as a TRIPLE: port, status, and the address column.
  // The address column is not redundant with the index — see resolveFdbIdentity
  // in utils/macForwarding.ts for the agent that indexes by row number.
  let ports = await snmpWalk(session, OID.dot1qTpFdbPort, MAC_TABLE_ROW_CAP).catch(() => new Map());
  let statuses = await snmpWalk(session, OID.dot1qTpFdbStatus, MAC_TABLE_ROW_CAP).catch(() => new Map());
  let addresses = await snmpWalk(session, OID.dot1qTpFdbAddress, MAC_TABLE_ROW_CAP).catch(() => new Map());
  if (ports.size === 0) {
    ports = await snmpWalk(session, OID.dot1dTpFdbPort, MAC_TABLE_ROW_CAP).catch(() => new Map());
    statuses = await snmpWalk(session, OID.dot1dTpFdbStatus, MAC_TABLE_ROW_CAP).catch(() => new Map());
    addresses = await snmpWalk(session, OID.dot1dTpFdbAddress, MAC_TABLE_ROW_CAP).catch(() => new Map());
  }
  if (ports.size === 0) return undefined;

  const out: FdbEntry[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let undecodable = 0;
  let unusableStatus = 0;
  for (const [suffix, portVb] of ports.entries()) {
    const parsed = resolveFdbIdentity(suffix, addresses.get(suffix));
    if (!parsed) { undecodable++; continue; }
    const status = fdbStatusLabel(snmpVbToNumber(statuses.get(suffix)));
    if (!fdbStatusIsUsable(status)) { unusableStatus++; continue; }

    // The unique key is (asset, mac, vlan) and NULLs compare distinct in a
    // Postgres unique index, so de-duplicate here rather than relying on it.
    const key = `${parsed.macAddress}|${parsed.fdbId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (out.length >= MAC_TABLE_ROW_CAP) { dropped++; continue; }
    const basePort = snmpVbToNumber(portVb);
    out.push({
      macAddress: parsed.macAddress,
      vlanId:     parsed.fdbId,
      basePort:   basePort ?? null,
      // Null when the join failed; basePort is retained above so the entry is
      // still identifiable instead of appearing to belong to no port.
      ifName:     basePort != null ? (ifNameByBasePort.get(basePort) ?? null) : null,
      status,
    });
  }
  if (dropped > 0 || ports.size >= MAC_TABLE_ROW_CAP) {
    logger.warn({ dropped, rows: ports.size, cap: MAC_TABLE_ROW_CAP }, "MAC forwarding table truncated");
  }
  // A table that answered but decoded to NOTHING is a read failure, not an
  // empty forwarding database, so preserve the stored rows rather than
  // wiping them — and say so, loudly. Silence here is what made an
  // index-shape mismatch look like a switch with nothing plugged into it.
  if (out.length === 0) {
    logger.warn(
      { rows: ports.size, undecodable, unusableStatus },
      "MAC forwarding table answered but no entries decoded",
    );
    return undefined;
  }
  return out;
}

/**
 * Walk per-port VLAN membership out of Q-BRIDGE-MIB.
 *
 * The native VLAN comes from `dot1qPvid` (one value per port, stated directly).
 * The tagged set is derived from the per-VLAN member bitmaps, with the caveat
 * that the untagged column is often an unusable copy of the egress column --
 * `derivePortVlans` in utils/portVlans.ts holds that decision table.
 *
 * Returns keyed by ifName so the caller can join it onto the interface list
 * without knowing about dot1dBasePorts, and `undefined` -- not an empty map --
 * when the device answers `dot1qPvid` with nothing, which is how an agent that
 * omits the q-bridge subtree entirely reads. The caller leaves the interface
 * rows untouched in that case, so the controller-CMDB overlay that runs
 * afterwards is still the one deciding.
 */
async function collectPortVlansSnmp(
  session: any,
  ifNameByBasePort: ReadonlyMap<number, string>,
): Promise<Map<string, PortVlanConfig> | undefined> {
  // The PVID walk is the gate: it is one row per port and every VLAN-aware
  // agent answers it, so an empty result means the member bitmaps are not
  // worth two more walks.
  const pvidWalk = await snmpWalk(session, OID.dot1qPvid).catch(() => new Map());
  if (pvidWalk.size === 0) return undefined;

  const pvidByBasePort = new Map<number, number>();
  for (const [basePortRaw, vb] of pvidWalk.entries()) {
    const basePort = Number(basePortRaw);
    const pvid = snmpVbToNumber(vb);
    if (!Number.isInteger(basePort) || pvid == null) continue;
    pvidByBasePort.set(basePort, pvid);
  }

  let [egressWalk, untaggedWalk] = await Promise.all([
    snmpWalk(session, OID.dot1qVlanStaticEgressPorts).catch(() => new Map()),
    snmpWalk(session, OID.dot1qVlanStaticUntaggedPorts).catch(() => new Map()),
  ]);
  // An agent that keeps its VLANs out of the static table still publishes the
  // current one. Only reached when static answered nothing, so the common case
  // pays for no extra walk -- the same answered-nothing fallback the
  // forwarding-database walk makes from Q-BRIDGE to BRIDGE-MIB.
  if (egressWalk.size === 0) {
    [egressWalk, untaggedWalk] = await Promise.all([
      snmpWalk(session, OID.dot1qVlanCurrentEgressPorts).catch(() => new Map()),
      snmpWalk(session, OID.dot1qVlanCurrentUntaggedPorts).catch(() => new Map()),
    ]);
  }
  const memberships: VlanMembership[] = [];
  for (const [suffix, egressVb] of egressWalk.entries()) {
    // The static table's suffix IS the VLAN id; the current table's is
    // `<timeMark>.<vlanId>`. Taking the last component reads both.
    const vlanId = Number(String(suffix).split(".").pop());
    if (!isVlanId(vlanId)) continue;
    memberships.push({
      vlanId,
      egress:   decodePortList(egressVb),
      untagged: decodePortList(untaggedWalk.get(suffix)),
    });
  }

  const byPort = derivePortVlans(pvidByBasePort, memberships);
  const out = new Map<string, PortVlanConfig>();
  let unjoined = 0;
  for (const [basePort, cfg] of byPort.entries()) {
    const ifName = ifNameByBasePort.get(basePort);
    if (!ifName) { unjoined++; continue; }
    out.set(ifName, cfg);
  }
  if (out.size === 0) {
    logger.warn(
      { pvidRows: pvidWalk.size, vlans: memberships.length, unjoined },
      "Q-BRIDGE port VLANs answered but none joined to an interface",
    );
    return undefined;
  }
  return out;
}

/**
 * Full-replace an asset's forwarding database. Delete-replace, like
 * persistLldpNeighbors — an FDB entry ages out on the switch in minutes, so
 * there is no history worth keeping.
 *
 * `matchedAssetId` resolves through the SAME cached MAC index LLDP matching
 * uses: at a few thousand rows per switch a per-row lookup would dominate the
 * write.
 */
/**
 * Full-replace an asset's trunk membership. Delete-replace like its siblings.
 *
 * Peer resolution is a SUFFIX match against asset serials, uniqueness-guarded:
 * an ambiguous tail stores NULL rather than attaching the trunk to the wrong
 * device. `firstSeen` survives a re-scrape so "this trunk has been on port23
 * since..." holds across the replace.
 */
async function persistTrunkMembers(assetId: string, rows: TrunkPortEntry[]): Promise<void> {
  const now = new Date();
  const [existing, serialRows] = await Promise.all([
    prisma.assetTrunkMember.findMany({
      where: { assetId },
      select: { trunkName: true, localPort: true, firstSeen: true },
    }),
    // Only assets that HAVE a serial can be matched; the suffix test is over
    // this map, so keeping it tight keeps the scan small.
    prisma.asset.findMany({
      where: { serialNumber: { not: null } },
      select: { id: true, serialNumber: true },
    }),
  ]);
  const prior = new Map(existing.map((e) => [`${e.trunkName}|${e.localPort}`, e.firstSeen]));
  const serialToAssetId = new Map<string, string>();
  for (const a of serialRows) if (a.serialNumber) serialToAssetId.set(a.serialNumber, a.id);

  await prisma.$transaction([
    prisma.assetTrunkMember.deleteMany({ where: { assetId } }),
    ...(rows.length > 0
      ? [prisma.assetTrunkMember.createMany({
          data: rows.map((r) => ({
            assetId,
            trunkName:      r.trunkName,
            localPort:      r.localPort,
            peerSerialTail: r.peerSerialTail,
            matchedAssetId: matchTrunkPeer(r.peerSerialTail, serialToAssetId),
            firstSeen: prior.get(`${r.trunkName}|${r.localPort}`) ?? now,
            lastSeen:  now,
          })),
        })]
      : []),
  ]);
}

async function persistMacTable(assetId: string, rows: FdbEntry[]): Promise<void> {
  const index = await getLldpAssetMatchIndex();
  const now = new Date();
  const existing = await prisma.assetMacTableEntry.findMany({
    where: { assetId },
    select: { macAddress: true, vlanId: true, firstSeen: true },
  });
  const prior = new Map(existing.map((e) => [`${e.macAddress}|${e.vlanId ?? ""}`, e.firstSeen]));

  await prisma.$transaction([
    prisma.assetMacTableEntry.deleteMany({ where: { assetId } }),
    ...(rows.length > 0
      ? [prisma.assetMacTableEntry.createMany({
          data: rows.map((r) => ({
            assetId,
            macAddress: r.macAddress,
            vlanId:     r.vlanId,
            basePort:   r.basePort,
            ifName:     r.ifName,
            status:     r.status,
            matchedAssetId: index.byMac.get(r.macAddress) ?? null,
            // Preserved so "this device has been on this switch since..." holds
            // across the delete-replace.
            firstSeen: prior.get(`${r.macAddress}|${r.vlanId ?? ""}`) ?? now,
            lastSeen:  now,
          })),
        })]
      : []),
  ]);
}

/**
 * Vendor disk fallback — the storage half of a vendor telemetry profile.
 *
 * Runs when HOST-RESOURCES-MIB's hrStorageTable produced no disk rows, which
 * is every pass on a device whose agent doesn't implement HRM's storage view
 * (FortiSwitches, some access points). Reads whichever two of the used /
 * total / free scalars the profile names — the pair comes from the editable
 * Manufacturer Profile's Storage row when an operator set one, else from the
 * hardcoded profile — and completes the used/total pair via `deriveDiskBytes`.
 *
 * Returns null when the profile has no disk block, when neither OID resolves
 * (the MIB isn't uploaded), or when both readings came back empty. Both
 * callers treat null as "leave storage as it was", which is the same outcome
 * an HRM-empty device had before this path existed. Shared by
 * `collectSystemInfoSnmp` (the full heavy pass) and `collectStorageOnlySnmp`
 * (the dedicated storage cadence) so the two can't drift — they carried
 * byte-identical copies of this until 2026-08.
 */
async function collectVendorDiskFallback(
  session: any,
  vendorProfile: VendorTelemetryProfile | null,
  vendorScope: ResolveScope,
): Promise<StorageSample | null> {
  const disk = vendorProfile?.disk;
  if (!disk) return null;
  try {
    await ensureRegistryLoaded();
    // Only the symbols this profile actually names are dialed — a used+free
    // profile must not GET a total OID it never declared.
    const oids = {
      used:  disk.usedBytesSymbol  ? resolveOidSync(disk.usedBytesSymbol,  vendorScope) : null,
      total: disk.totalBytesSymbol ? resolveOidSync(disk.totalBytesSymbol, vendorScope) : null,
      free:  disk.freeBytesSymbol  ? resolveOidSync(disk.freeBytesSymbol,  vendorScope) : null,
    };
    // Two resolved OIDs are the floor: one reading alone can't fill a
    // used/total pair, and the Storage table's whole point is the ratio.
    const resolvedCount = [oids.used, oids.total, oids.free].filter(Boolean).length;
    if (resolvedCount < 2) return null;
    const [usedVb, totVb, freeVb] = await Promise.all([
      oids.used  ? snmpGetScalar(session, oids.used).catch(()  => null) : Promise.resolve(null),
      oids.total ? snmpGetScalar(session, oids.total).catch(() => null) : Promise.resolve(null),
      oids.free  ? snmpGetScalar(session, oids.free).catch(()  => null) : Promise.resolve(null),
    ]);
    const { usedBytes, totalBytes } = deriveDiskBytes({
      used:  snmpVbToNumber(usedVb),
      total: snmpVbToNumber(totVb),
      free:  snmpVbToNumber(freeVb),
    });
    if (usedBytes == null && totalBytes == null) return null;
    return { mountPath: disk.mountPath || "system", usedBytes, totalBytes };
  } catch {
    return null;
  }
}

/**
 * Per host: did IP-MIB's ipAddressTable answer the last time it was walked?
 * Lets the FAST cadence skip the empty walk on a device that only has the
 * legacy ipAddrTable — every tick, at fleet scale, that would be a wasted
 * round trip per pinned asset. The heavy pass always re-probes (`probe`), so a
 * device that gains the table, or answered empty once, is re-learned on its
 * next full pass.
 */
const ipAddressTableAnswered = new Map<string, boolean>();

/**
 * An interface's addresses over SNMP, both families (business rule 126):
 * `ifIndex → [address…]` in walk order. ipAddressTable (RFC 4293 — IPv4 and
 * IPv6, with ipAddressType so only unicast rows count) first; the legacy
 * IPv4-only ipAddrTable when the device has none. Cost on a device with the
 * current table: two small walks (one varbind per ADDRESS, not per interface)
 * where there was one; on a legacy device, after its first full pass, the
 * same single walk as before.
 */
async function walkInterfaceAddressesSnmp(session: any, host: string, probe: boolean): Promise<Map<string, string[]>> {
  const toNums = (m: Map<string, unknown>) => new Map([...m].map(([k, v]) => [k, snmpVbToNumber(v)] as [string, number | null]));
  if (probe || ipAddressTableAnswered.get(host) !== false) {
    const [ifIdx, types] = await Promise.all([
      snmpWalk(session, IP_ADDRESS_IF_INDEX_OID).catch(() => new Map<string, unknown>()),
      snmpWalk(session, IP_ADDRESS_TYPE_OID).catch(() => new Map<string, unknown>()),
    ]);
    if (ifIdx.size > 0) {
      ipAddressTableAnswered.set(host, true);
      return addressesByIfIndexFromIpAddressTable(toNums(ifIdx), toNums(types));
    }
    ipAddressTableAnswered.set(host, false);
  }
  const legacy = await snmpWalk(session, OID.ipAdEntIfIndex).catch(() => new Map<string, unknown>());
  return addressesByIfIndexFromIpAddrTable(toNums(legacy));
}

async function collectSystemInfoSnmp(
  host: string,
  config: Record<string, unknown>,
  opts: {
    includeLldp?:  boolean;
    timeoutMs?:    number;
    /** Asset manufacturer — used to pick the vendor disk fallback when HRM returns no disks. */
    manufacturer?: string | null;
    /** Asset model — same fallback path. */
    model?:        string | null;
    /** Asset OS — same fallback path. */
    os?:           string | null;
    /** Asset type — drives the fapStationTable walk for FortiAPs. */
    assetType?:    string | null;
  } = {},
): Promise<SystemInfoSample> {
  // Vendor profile is read once up-front so the disk fallback (below) can
  // consult it without re-deriving. Cheap — the profile rows are in this
  // process's warm cache; ensureRegistryLoaded is called by the disk fallback
  // when it runs. No MIB pin here: this is the systemInfo stream, whose pin
  // the caller has already applied to the interfaces/storage walks.
  const vendorProfile = pickDbProfile({
    manufacturer: opts.manufacturer ?? null,
    os:           opts.os ?? null,
    model:        opts.model ?? null,
    assetType:    opts.assetType ?? null,
  });
  const vendorScope: ResolveScope = { manufacturer: opts.manufacturer, model: opts.model, profileManufacturer: vendorProfile?.profileManufacturer };

  return await withSnmpSession(host, config, async (session) => {
    // Storage: walk hrStorage and pick rows tagged as fixed/removable disk.
    const storage: StorageSample[] = [];
    const endStorage = startPhase("systeminfo.snmp.storage_walk");
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
    } catch { /* fall through; storage stays empty */ }
    endStorage({ disks: storage.length });

    // Vendor disk fallback: when HRM returned no disk rows (typical on
    // devices whose SNMP agents don't implement hrStorageTable — FortiSwitches,
    // some access points, etc.), consult the matched vendor profile for
    // proprietary used/total byte scalars and synthesize one StorageSample.
    if (storage.length === 0) {
      const vendorRow = await collectVendorDiskFallback(session, vendorProfile, vendorScope);
      if (vendorRow) storage.push(vendorRow);
    }

    // Vendor model identity: one scalar GET when the matched profile knows
    // where the device publishes its real model (FortiSwitch fsSysVersion —
    // discovery has no model source for managed switches, so this scrape is
    // the only path to the real hardware model). Best-effort; a null parse
    // (firmware-only string, empty value) leaves detectedModel unset so the
    // persist layer doesn't touch Asset.model.
    //
    // sysDescr rides along in the SAME multi-GET. A Discovery reads it once,
    // at adoption, so a camera upgraded a year later still reported the
    // firmware it shipped with (utils/snmpDescrIdentity.ts) — re-reading it
    // here is what keeps model + firmware current. Batched rather than a
    // second scalar GET so a device WITH a model profile pays exactly the one
    // round trip it already paid, and every other SNMP device pays one: at
    // 2000 assets on the ~10-minute system-info cadence that is ~3 varbinds a
    // second across the fleet, inside the session and the per-host gate this
    // pass already holds.
    let detectedModel: string | null = null;
    let descrIdentity: SysDescrDetail | undefined;
    let sysDescrText: string | null = null;
    try {
      // Registry load stays behind the model profile that needs it — sysDescr
      // is a fixed OID and every device without a profile is the common case.
      let modelOid: string | null = null;
      if (vendorProfile?.model) {
        await ensureRegistryLoaded();
        modelOid = resolveOidSync(vendorProfile.model.symbol, vendorScope);
      }
      // The registry holds the symbol's DEFINITION oid: its `.0` instance
      // rides this batch, and pickScalar asks for the bare oid alone only if
      // that came back empty (utils/snmpIdentity.ts says why).
      const oids = [SYS_OIDS.sysDescr, ...(modelOid ? [scalarInstanceOid(modelOid)] : [])];
      const vbs = await snmpMultiGet(session, oids).catch(() => new Map<string, unknown>());

      sysDescrText = snmpVbToString(vbs.get(SYS_OIDS.sysDescr)) || null;
      descrIdentity = parseVendorSysDescr(sysDescrText ?? undefined);

      if (modelOid && vendorProfile?.model) {
        const raw = await pickScalar(
          vbs, modelOid,
          async (oid) => (await snmpMultiGet(session, [oid])).get(oid),
          snmpVbToString,
        );
        if (raw) detectedModel = vendorProfile.model.parse(raw);
      }
    } catch { /* best-effort — identity stays undetected */ }

    // Interfaces: build a map keyed by ifIndex from IF-MIB columns. Prefer
    // ifName / ifHC*Octets / ifHighSpeed when present; otherwise fall back
    // to the legacy 32-bit columns.
    const interfaces: InterfaceSample[] = [];
    let physicalEntities: PhysicalEntitySample[] | undefined;
    let macTable: FdbEntry[] | undefined;
    let arpNeighbors: ArpNeighborEntry[] | undefined;
    let trunkMembers: TrunkPortEntry[] | undefined;
    let trunkLinks = 0;
    const endIfaces = startPhase("systeminfo.snmp.interfaces_walk");
    try {
      const [
        names, descrs, admin, oper, speeds, hiSpeeds, mac,
        in32, out32, inHC, outHC, ipMap, inErr, outErr, ifTypes, aliases, duplexes,
      ] = await Promise.all([
        snmpWalk(session, OID.ifName).catch(() => new Map()),
        snmpWalk(session, OID.ifDescr).catch(() => new Map()),
        snmpWalk(session, OID.ifAdminStatus).catch(() => new Map()),
        snmpWalk(session, OID.ifOperStatus).catch(() => new Map()),
        snmpWalk(session, OID.ifSpeed).catch(() => new Map()),
        snmpWalk(session, OID.ifHighSpeed).catch(() => new Map()),
        snmpWalk(session, OID.ifPhysAddress).catch(() => new Map()),
        snmpWalk(session, OID.ifInOctets).catch(() => new Map()),
        snmpWalk(session, OID.ifOutOctets).catch(() => new Map()),
        snmpWalk(session, OID.ifHCInOctets).catch(() => new Map()),
        snmpWalk(session, OID.ifHCOutOctets).catch(() => new Map()),
        walkInterfaceAddressesSnmp(session, host, true),
        snmpWalk(session, OID.ifInErrors).catch(() => new Map()),
        snmpWalk(session, OID.ifOutErrors).catch(() => new Map()),
        snmpWalk(session, OID.ifType).catch(() => new Map()),
        snmpWalk(session, OID.ifAlias).catch(() => new Map()),
        // Ethernet-only table; a device without EtherLike-MIB answers an
        // empty walk and every interface's duplex stays null.
        snmpWalk(session, OID.dot3StatsDuplexStatus).catch(() => new Map()),
      ]);

      // ifIndex → [addresses], both families (walkInterfaceAddressesSnmp).
      const addrsByIfIndex = ipMap as Map<string, string[]>;

      const allIdx = new Set<string>([
        ...names.keys(), ...descrs.keys(), ...admin.keys(), ...oper.keys(),
      ]);
      for (const idx of allIdx) {
        // Drop rows where IF-MIB advertises neither ifName nor ifDescr — on
        // FortiAPs these are ephemeral per-station / per-VAP virtual interfaces
        // that can't be meaningfully pinned (ifIndex churns as clients
        // associate) and just pollute AssetInterfaceSample + the auto-monitor
        // aggregate.
        const name = snmpVbToString(names.get(idx)) || snmpVbToString(descrs.get(idx));
        if (!name) continue;
        const speedHi = snmpVbToNumber(hiSpeeds.get(idx));
        const speed32 = snmpVbToNumber(speeds.get(idx));
        const speedBps = speedHi && speedHi > 0
          ? speedHi * 1_000_000
          : (speed32 != null ? speed32 : null);
        const inHi = snmpVbToNumber(inHC.get(idx));
        const outHi = snmpVbToNumber(outHC.get(idx));
        const aliasRaw = snmpVbToString(aliases.get(idx));
        const alias = aliasRaw && aliasRaw.trim() ? aliasRaw.trim() : null;
        const operStatus = ifStatusLabel(snmpVbToNumber(oper.get(idx)));
        interfaces.push({
          ifName:      name,
          adminStatus: ifStatusLabel(snmpVbToNumber(admin.get(idx))),
          operStatus,
          speedBps,
          // Duplex only describes a link that is up; some agents keep
          // reporting the last negotiated value after the cable is pulled.
          duplex:      operStatus === "up" ? dot3DuplexLabel(snmpVbToNumber(duplexes.get(idx))) : null,
          // First reportable IPv4 and IPv6 on the ifIndex (business rule 126).
          ...pickInterfaceAddresses(addrsByIfIndex.get(idx) ?? []),
          macAddress:  snmpMacFromBuffer(mac.get(idx)),
          inOctets:    inHi != null  ? inHi  : snmpVbToNumber(in32.get(idx)),
          outOctets:   outHi != null ? outHi : snmpVbToNumber(out32.get(idx)),
          inErrors:    snmpVbToNumber(inErr.get(idx)),
          outErrors:   snmpVbToNumber(outErr.get(idx)),
          ifType:      snmpIfTypeLabel(snmpVbToNumber(ifTypes.get(idx))),
          alias,
        });
      }

      // PoE rides the same walk. Correlation needs ifIndex -> name, which
      // this loop has already resolved for every interface it kept, so it is
      // rebuilt here rather than re-walking IF-MIB.
      const poeIfNames = new Map<string, string>();
      for (const idx of allIdx) {
        const n = snmpVbToString(names.get(idx)) || snmpVbToString(descrs.get(idx));
        if (n) poeIfNames.set(idx, n);
      }
      const poeByIfName = await collectPoePortsSnmp(session, host, poeIfNames);
      if (poeByIfName.size > 0) {
        for (const iface of interfaces) {
          const poe = poeByIfName.get(iface.ifName);
          if (poe) { iface.poeStatus = poe.poeStatus; iface.poeClass = poe.poeClass; }
        }
      }

      // Hardware inventory rides the same walk — heavy cadence only, since a
      // module's serial changes on a swap, not on a poll.
      physicalEntities = await collectPhysicalEntitiesSnmp(session)
        .catch(() => undefined);

      // IP neighbour cache — firewall-class only, mirroring where the MAC
      // table is gated. A switch's neighbour table holds its own management
      // peers and nothing an operator asks about; the router's is the answer
      // to "what is at this address", which is why it earns the walk here.
      if (opts.assetType === "firewall") {
        const endArp = startPhase("systeminfo.snmp.arp_walk");
        const ifNameByIndex = new Map<number, string>();
        for (const [idx, name] of poeIfNames) {
          const n = Number(idx);
          if (Number.isInteger(n)) ifNameByIndex.set(n, name);
        }
        arpNeighbors = await collectArpNeighborsSnmp(session, ifNameByIndex).catch(() => undefined);
        endArp({ entries: arpNeighbors?.length ?? null });
      }

      // Forwarding database — switch-class only. Every bridge answers this
      // table, but a server or firewall would return nothing useful for a
      // walk that can run to thousands of rows, so the cost is not spent.
      if (opts.assetType === "switch") {
        // dot1dBasePortIfIndex is the join both walks below need; walk it once.
        const ifNameByBasePort = await collectBasePortIfNames(session, poeIfNames);
        macTable = await collectMacTableSnmp(session, ifNameByBasePort).catch(() => undefined);
        // Per-port VLAN membership. On a managed FortiSwitch the parent
        // FortiGate's CMDB is the better source (it is config truth, and the
        // only place `allowed-vlans all` exists as a concept) and overlays on
        // top of this afterwards -- but that overlay needs a resolvable
        // controller and the SNMP interfaces path, so it reaches only a subset
        // of switches. This is what every other switch gets.
        const endQbridge = startPhase("systeminfo.snmp.qbridge_vlan_walk");
        const portVlans = await collectPortVlansSnmp(session, ifNameByBasePort).catch(() => undefined);
        let vlanOverlaid = 0;
        if (portVlans) {
          for (const iface of interfaces) {
            const cfg = portVlans.get(iface.ifName);
            if (!cfg) continue;
            iface.nativeVlan  = cfg.nativeVlan;
            iface.taggedVlans = cfg.taggedVlans;
            vlanOverlaid++;
          }
        }
        endQbridge({ ports: portVlans?.size ?? null, overlaid: vlanOverlaid, total: interfaces.length });
        // Trunk map: one scalar GET, so it costs nothing next to the FDB walk.
        // Undefined (not []) when the device doesn't publish the object at all,
        // so a non-Fortinet switch preserves rather than wipes.
        let trunkRaw = await snmpGetScalar(session, OID.fsTrunkMember).catch(() => null);
        // A non-Fortinet switch answers neither OID; a FortiSwitch that answers
        // nothing at the MIB-stated one gets the second try (see the constants).
        if (trunkRaw == null) {
          trunkRaw = await snmpGetScalar(session, OID.fsTrunkMemberAlt).catch(() => null);
        }
        const trunkStr = snmpVbToString(trunkRaw);
        trunkMembers = trunkStr ? parseTrunkPortMap(trunkStr) : undefined;
        // The scalar is the ONLY source of the trunk/member relationship on a
        // directly-polled switch, so overlay it onto the interface list here as
        // well as persisting AssetTrunkMember rows: the ifTable publishes no
        // aggregation of its own, so without this the System tab lists a trunk
        // and its member ports as unrelated flat rows. Same overlay the
        // controller-CMDB path runs, so the two can't disagree about what a
        // member row looks like, and it back-fills only — a member whose parent
        // already came from CMDB or REST keeps that parent, and a member name
        // the walk didn't return is skipped rather than synthesized (see
        // `synthesizeMissing`).
        if (trunkMembers && trunkMembers.length > 0) {
          trunkLinks = overlayFortiswitchTrunkMembers(
            interfaces,
            trunkMemberMap(trunkMembers),
            { synthesizeMissing: false },
          );
        }
      }
    } catch { /* fall through */ }
    endIfaces({ interfaces: interfaces.length, trunkLinks });

    // LLDP-MIB neighbors. Best-effort — devices without LLDP-MIB return empty
    // walks (we treat that as "unsupported" so we don't wipe stored rows on
    // every scrape). A device with LLDP enabled but zero current neighbors
    // returns lldpLocPortTable rows but an empty lldpRemTable, and we
    // correctly persist that as "queried, no neighbors" → wipe. `includeLldp`
    // false lets the caller skip this when the operator routed LLDP to REST.
    let lldpNeighbors: LldpNeighborSample[] | undefined;
    if (opts.includeLldp !== false) {
      const endLldp = startPhase("systeminfo.snmp.lldp_walk");
      try {
        lldpNeighbors = await collectLldpNeighborsSnmp(session);
      } catch { /* leave undefined; persist layer leaves stored rows alone */ }
      endLldp({ neighbors: lldpNeighbors?.length ?? null });
    }

    // Wireless stations — only attempted on FortiAP assets. fapStationTable
    // is FORTINET-FORTIAP-MIB-specific; firing it on every SNMP system-info
    // pass would burn worker time on devices that can't respond. Same
    // undefined/[] semantics as lldpNeighbors: undefined leaves stored rows
    // alone, [] wipes them.
    let wirelessStations: WirelessStationSample[] | undefined;
    let apRadios: ApRadioSample[] | undefined;
    if (opts.assetType === "access_point") {
      const endWireless = startPhase("systeminfo.snmp.wireless_walk");
      try {
        wirelessStations = await collectWirelessStationsSnmp(session);
      } catch { /* leave undefined */ }
      endWireless({ stations: wirelessStations?.length ?? null });

      // The two levels ABOVE those stations. Same undefined/[] contract, and
      // the same gate — fapRadioTable is FORTINET-FORTIAP-MIB-specific and
      // firing it at every SNMP device would burn worker time on hardware
      // that cannot answer. Discovery writes the same tables from the
      // controller; the two sources carry complementary columns and the
      // persist layer merges them per column.
      const endRadios = startPhase("systeminfo.snmp.ap_radio_walk");
      try {
        apRadios = await collectApRadiosSnmp(session);
      } catch { /* leave undefined */ }
      endRadios({ radios: apRadios?.length ?? null });
    }

    return {
      interfaces,
      storage,
      physicalEntities,
      macTable,
      arpNeighbors,
      trunkMembers,
      lldpNeighbors,
      lldpSource: opts.includeLldp !== false ? "snmp" : undefined,
      wirelessStations,
      apRadios,
      detectedModel,
      descrIdentity,
      sysDescr: sysDescrText,
    };
  }, opts.timeoutMs);
}

/**
 * Wire-level filtered SNMP system-info scrape. Pulls only the columns/rows the
 * fast cadence actually needs — pinned interfaces and pinned storage — instead
 * of walking the full IF-MIB / hrStorage subtrees the way `collectSystemInfoSnmp`
 * does. The full pass at the heavy cadence still walks everything; this is
 * strictly an optimization for the per-minute scrape.
 *
 * Three phases:
 *
 *   1. Discovery — walk `ifName` + `ifDescr` (and `hrStorageDescr` when storage
 *      is pinned) to map the operator-supplied names back to their SNMP
 *      indexes. These walks are tiny (one varbind per port / disk) and finish
 *      in well under a second on most agents. We don't currently persist the
 *      name→index map; the heavy-cadence sample already records ifName but
 *      not ifIndex, and adding a column would mean a schema migration. The
 *      bounded walks here are the simpler path.
 *
 *   2. Multi-GET — pack every column-at-index OID we want into one `session.get`
 *      (chunked at SNMP_MULTI_GET_BATCH). On a 48-port switch with one pinned
 *      interface, that's 13 OIDs in a single PDU — vs. 16 full column walks
 *      under the legacy path (~770 OID-fetches). Latency is dominated by the
 *      network round-trip, so one PDU ≈ one round-trip ≈ ~50 ms regardless of
 *      varbind count.
 *
 *   3. Assembly — emit one `InterfaceSample` per matched name (skipping names
 *      that didn't resolve to an index, e.g. the operator pinned a port that
 *      no longer exists on the device). Speed/IP/MAC follow the same picker
 *      rules as the full walk: high-counter prefers `ifHC*Octets` over the
 *      legacy 32-bit columns, speed prefers `ifHighSpeed * 1e6` over
 *      `ifSpeed`, the addresses come from `walkInterfaceAddressesSnmp`.
 *
 * Address resolution is the one gotcha: the address tables are indexed by the
 * ADDRESS, not by ifIndex, so they have to be walked (one varbind per address
 * on the device, not per interface) — once here, so the pinned interfaces get
 * their IPv4 and IPv6 (business rule 126). ipAddressTable is two small walks
 * (ifIndex + type); a legacy-only device, once its first full pass has said
 * so, pays the single ipAddrTable walk it always did. On devices with many
 * addresses (large branches) this is the dominant cost; still tiny compared to
 * the full pass.
 *
 * Returns the same `SystemInfoSample` shape as `collectSystemInfoSnmp` so
 * `recordSystemInfoResult` downstream is unchanged. LLDP and wireless are
 * always skipped on the fast cadence (LLDP rides the heavy cadence, wireless
 * isn't a fast-pin target today).
 */
async function collectFastFilteredSnmp(
  host: string,
  config: Record<string, unknown>,
  opts: {
    wantedIfaces:   string[];
    wantedStorage:  string[];
    timeoutMs?:     number;
  },
): Promise<SystemInfoSample> {
  const wantedIfaceSet  = new Set(opts.wantedIfaces);
  const wantedStorageSet = new Set(opts.wantedStorage);

  return await withSnmpSession(host, config, async (session) => {
    // ── Phase 1: discover ifIndex for each pinned ifName ──────────────────
    // Walk ifName + ifDescr in parallel; one full pass on a 48-port switch
    // is ~50 varbinds per column ≈ <500ms total. Resolve every pinned name
    // to its index; pinned-but-missing names are dropped silently (same
    // behavior as the full walk: the stored sample just doesn't include
    // that ifName on this tick).
    const ifIndexByName = new Map<string, string>();
    // Full ifIndex -> name map (not just the pinned subset) — PoE correlation
    // may need to match a port by its trailing number against any interface.
    const indexToNameAll = new Map<string, string>();
    const endIfaceDiscovery = startPhase("fastfiltered.snmp.iface_discovery");
    try {
      const [names, descrs] = await Promise.all([
        snmpWalk(session, OID.ifName).catch(() => new Map()),
        snmpWalk(session, OID.ifDescr).catch(() => new Map()),
      ]);
      // ifName is preferred (modern devices); ifDescr fallback covers older
      // agents that don't populate ifName.
      const indexToName = new Map<string, string>();
      for (const [idx, vb] of names.entries()) {
        const n = snmpVbToString(vb);
        if (n) indexToName.set(idx, n);
      }
      for (const [idx, vb] of descrs.entries()) {
        if (indexToName.has(idx)) continue;
        const n = snmpVbToString(vb);
        if (n) indexToName.set(idx, n);
      }
      for (const [idx, name] of indexToName.entries()) {
        indexToNameAll.set(idx, name);
        if (wantedIfaceSet.has(name)) ifIndexByName.set(name, idx);
      }
    } catch { /* leave ifIndexByName empty; sample will skip iface rows */ }
    endIfaceDiscovery({ resolved: ifIndexByName.size, wanted: wantedIfaceSet.size });

    // ── Phase 1b: discover hrStorageIndex for each pinned mountPath ───────
    // Storage column rows are also small (one per disk/partition); only walk
    // when at least one mountPath is pinned to avoid burning a round-trip
    // on iface-only fast pins.
    const storageIndexByMount = new Map<string, string>();
    if (wantedStorageSet.size > 0) {
      const endStorageDiscovery = startPhase("fastfiltered.snmp.storage_discovery");
      try {
        const descrs = await snmpWalk(session, OID.hrStorageDescr);
        for (const [idx, vb] of descrs.entries()) {
          const m = snmpVbToString(vb);
          if (m && wantedStorageSet.has(m)) storageIndexByMount.set(m, idx);
        }
      } catch { /* leave empty */ }
      endStorageDiscovery({ resolved: storageIndexByMount.size, wanted: wantedStorageSet.size });
    }

    // ── Phase 2: build the targeted OID list ──────────────────────────────
    // 13 columns per pinned interface, 3 per pinned storage row. Names are
    // resolved in Phase 1; missing names contribute no OIDs.
    const IFACE_COLS = [
      OID.ifName,         // re-pull so the assembly step has the authoritative ifName
      OID.ifAdminStatus,
      OID.ifOperStatus,
      OID.ifSpeed,
      OID.ifHighSpeed,
      OID.ifPhysAddress,
      OID.ifInOctets,
      OID.ifOutOctets,
      OID.ifHCInOctets,
      OID.ifHCOutOctets,
      OID.ifInErrors,
      OID.ifOutErrors,
      OID.ifType,
      OID.ifAlias,
    ];
    const STORAGE_COLS = [
      OID.hrStorageAllocationUnits,
      OID.hrStorageSize,
      OID.hrStorageUsed,
    ];
    const oids: string[] = [];
    for (const idx of ifIndexByName.values()) {
      for (const col of IFACE_COLS) oids.push(`${col}.${idx}`);
    }
    for (const idx of storageIndexByMount.values()) {
      for (const col of STORAGE_COLS) oids.push(`${col}.${idx}`);
    }

    // Also need ifIndex by IP for the pinned interfaces' ipAddress field.
    // ipAdEntIfIndex is indexed by the IP itself, not by ifIndex, so we have
    // to walk it. Tiny on most devices (one varbind per IPv4 address). Skip
    // when no interfaces are pinned (storage-only fast cadence is rare but
    // technically possible).
    // Both families (business rule 126) — the same walk the full pass does,
    // minus the re-probe: a legacy-only device pays one walk, as before.
    let addrsByIfIndex = new Map<string, string[]>();
    if (ifIndexByName.size > 0) {
      const endIpWalk = startPhase("fastfiltered.snmp.ip_walk");
      addrsByIfIndex = await walkInterfaceAddressesSnmp(session, host, false).catch(() => new Map<string, string[]>());
      endIpWalk({ ipMappings: addrsByIfIndex.size });
    }

    // ── Phase 3: one batched multi-GET, then assembly ─────────────────────
    const endMultiGet = startPhase("fastfiltered.snmp.multi_get");
    const vbByOid = oids.length > 0
      ? await snmpMultiGet(session, oids).catch(() => new Map<string, unknown>())
      : new Map<string, unknown>();
    endMultiGet({ oids: oids.length });

    // PoE for the pinned ports. The peth index is not derivable from ifIndex
    // without walking, so this is two small column walks rather than extra
    // OIDs in the multi-GET above; the negative cache keeps non-PoE devices
    // from paying for it every tick.
    const poeByIfName = ifIndexByName.size > 0
      ? await collectPoePortsSnmp(session, host, indexToNameAll)
      : new Map<string, { poeStatus: string | null; poeClass: string | null }>();

    // Duplex for the pinned ports, in its OWN multi-GET rather than in the
    // one above: dot3StatsDuplexStatus exists only on Ethernet interfaces,
    // and an SNMPv1 agent answers a GET naming one missing instance with
    // noSuchName for the WHOLE PDU — which would cost the pass every
    // counter it just read. Here a failure only loses duplex.
    const duplexByIdx = ifIndexByName.size > 0
      ? await snmpMultiGet(session, [...ifIndexByName.values()].map((idx) => `${OID.dot3StatsDuplexStatus}.${idx}`))
          .catch(() => new Map<string, unknown>())
      : new Map<string, unknown>();

    const interfaces: InterfaceSample[] = [];
    for (const [pinnedName, idx] of ifIndexByName.entries()) {
      const name = snmpVbToString(vbByOid.get(`${OID.ifName}.${idx}`)) || pinnedName;
      const speedHi = snmpVbToNumber(vbByOid.get(`${OID.ifHighSpeed}.${idx}`));
      const speed32 = snmpVbToNumber(vbByOid.get(`${OID.ifSpeed}.${idx}`));
      const speedBps = speedHi && speedHi > 0
        ? speedHi * 1_000_000
        : (speed32 != null ? speed32 : null);
      const inHi = snmpVbToNumber(vbByOid.get(`${OID.ifHCInOctets}.${idx}`));
      const outHi = snmpVbToNumber(vbByOid.get(`${OID.ifHCOutOctets}.${idx}`));
      const aliasRaw = snmpVbToString(vbByOid.get(`${OID.ifAlias}.${idx}`));
      const alias = aliasRaw && aliasRaw.trim() ? aliasRaw.trim() : null;
      const operStatus = ifStatusLabel(snmpVbToNumber(vbByOid.get(`${OID.ifOperStatus}.${idx}`)));
      interfaces.push({
        ifName:      name,
        adminStatus: ifStatusLabel(snmpVbToNumber(vbByOid.get(`${OID.ifAdminStatus}.${idx}`))),
        operStatus,
        speedBps,
        duplex:      operStatus === "up" ? dot3DuplexLabel(snmpVbToNumber(duplexByIdx.get(`${OID.dot3StatsDuplexStatus}.${idx}`))) : null,
        ...pickInterfaceAddresses(addrsByIfIndex.get(idx) ?? []),
        macAddress:  snmpMacFromBuffer(vbByOid.get(`${OID.ifPhysAddress}.${idx}`)),
        inOctets:    inHi != null  ? inHi  : snmpVbToNumber(vbByOid.get(`${OID.ifInOctets}.${idx}`)),
        outOctets:   outHi != null ? outHi : snmpVbToNumber(vbByOid.get(`${OID.ifOutOctets}.${idx}`)),
        inErrors:    snmpVbToNumber(vbByOid.get(`${OID.ifInErrors}.${idx}`)),
        outErrors:   snmpVbToNumber(vbByOid.get(`${OID.ifOutErrors}.${idx}`)),
        ifType:      snmpIfTypeLabel(snmpVbToNumber(vbByOid.get(`${OID.ifType}.${idx}`))),
        alias,
        poeStatus:   poeByIfName.get(name)?.poeStatus ?? null,
        poeClass:    poeByIfName.get(name)?.poeClass ?? null,
      });
    }

    const storage: StorageSample[] = [];
    for (const [mountPath, idx] of storageIndexByMount.entries()) {
      const u = snmpVbToNumber(vbByOid.get(`${OID.hrStorageAllocationUnits}.${idx}`)) ?? 1;
      const s = snmpVbToNumber(vbByOid.get(`${OID.hrStorageSize}.${idx}`));
      const ud = snmpVbToNumber(vbByOid.get(`${OID.hrStorageUsed}.${idx}`));
      storage.push({
        mountPath,
        totalBytes: s != null  ? s * u  : null,
        usedBytes:  ud != null ? ud * u : null,
      });
    }

    return {
      interfaces,
      storage,
      // LLDP intentionally omitted on the fast cadence — undefined preserves
      // stored rows from the last heavy pass instead of wiping them. Same
      // contract as `collectSystemInfoSnmp` with `includeLldp: false`.
      lldpNeighbors: undefined,
      wirelessStations: undefined,
      // Inventory likewise omitted here: undefined preserves what the last
      // heavy pass stored. A module's serial does not change per minute, and
      // wiping it on every fast tick would cost a delete-replace for nothing.
      physicalEntities: undefined,
    };
  }, opts.timeoutMs);
}

/**
 * Standalone LLDP-MIB walk for the cross-transport case. Used when the caller
 * has already pulled interfaces+storage via FortiOS REST but the operator
 * routed LLDP to SNMP. Opens its own SNMP session — cheap enough; LLDP walks
 * are normally ~6 columns and finish in a few hundred ms.
 */
async function collectLldpOnlySnmp(
  host: string,
  config: Record<string, unknown>,
  timeoutMs?: number,
): Promise<LldpNeighborSample[] | undefined> {
  return await withSnmpSession(host, config, async (session) => {
    return await collectLldpNeighborsSnmp(session);
  }, timeoutMs);
}

/**
 * Walk LLDP-MIB and assemble one LldpNeighborSample per remote system seen.
 * Returns `undefined` when the local-port table is empty (suggesting LLDP-MIB
 * is unsupported); returns `[]` when the local table is populated but no
 * remote neighbors are present (so the caller wipes stored rows). Mapping
 * localPortNum → ifName comes from lldpLocPortTable: when the subtype is
 * interfaceName/interfaceAlias we trust lldpLocPortId; otherwise we fall back
 * to lldpLocPortDesc, which is always populated by spec-conformant agents.
 */
async function collectLldpNeighborsSnmp(session: any): Promise<LldpNeighborSample[] | undefined> {
  const [
    locSubtypes, locIds, locDescs,
    chSubtypes, chIds, ptSubtypes, ptIds, ptDescs,
    sysNames, sysDescs, capsEnabled, manAddrEnum,
    ifNames,
  ] = await Promise.all([
    snmpWalk(session, OID.lldpLocPortIdSubtype).catch(() => new Map()),
    snmpWalk(session, OID.lldpLocPortId).catch(() => new Map()),
    snmpWalk(session, OID.lldpLocPortDesc).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemChassisIdSubtype).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemChassisId).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemPortIdSubtype).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemPortId).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemPortDesc).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemSysName).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemSysDesc).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemSysCapEnabled).catch(() => new Map()),
    // Walking lldpRemManAddrIfSubtype just to enumerate the table indexes —
    // the actual address is encoded in the index suffix, not the column value.
    snmpWalk(session, OID.lldpRemManAddr + ".3").catch(() => new Map()),
    // IF-MIB ifName: fallback for the local port label when lldpLocPortTable
    // is empty. FortiOS uses ifIndex as lldpLocPortNum, so a "port-2" label
    // can be resolved to "internal1" / "wan2" / etc via the IF-MIB table that
    // every SNMP-monitored asset already exposes.
    snmpWalk(session, OID.ifName).catch(() => new Map()),
  ]);

  // No local LLDP ports AND no remote neighbors → device doesn't speak
  // LLDP-MIB. Signal "leave rows alone" so we don't wipe stored neighbors
  // on a transport that can't report. The previous guard returned here on
  // an empty local port table alone, but some FortiOS agents populate
  // lldpRemTable while leaving lldpLocPortTable empty — those reports are
  // authoritative for the remote side, and the per-row port label falls
  // back to "port-<num>" naturally below.
  if (locIds.size === 0 && locDescs.size === 0 && chIds.size === 0) return undefined;

  // localPortNum → friendly label. When the subtype is interfaceName(5) or
  // interfaceAlias(1), the id IS the ifName/alias and we want it. Otherwise
  // use the description — which is what most operators see in CLI output.
  const localPortLabel = new Map<string, string>();
  const allLocalKeys = new Set<string>([...locIds.keys(), ...locDescs.keys()]);
  for (const portNum of allLocalKeys) {
    const subtype = snmpVbToNumber(locSubtypes.get(portNum));
    const id      = parseLldpPortId(subtype, locIds.get(portNum));
    const desc    = snmpVbToString(locDescs.get(portNum)).trim();
    if ((subtype === 1 || subtype === 5) && id) {
      localPortLabel.set(portNum, id);
    } else if (desc) {
      localPortLabel.set(portNum, desc);
    } else if (id) {
      localPortLabel.set(portNum, id);
    } else {
      localPortLabel.set(portNum, `port-${portNum}`);
    }
  }
  // IF-MIB ifName fallback: rem-table-only agents (some FortiOS builds)
  // leave lldpLocPortTable empty but lldpRemLocalPortNum lines up with the
  // ifIndex of the physical port. Stamp any port number that the local-port
  // pass didn't cover so neighbors render as e.g. "internal1 → LAKESIDE-148F-1"
  // instead of "port-2 → LAKESIDE-148F-1".
  for (const [ifIndex, nameVb] of ifNames.entries()) {
    if (localPortLabel.has(ifIndex)) continue;
    const name = snmpVbToString(nameVb).trim();
    if (name) localPortLabel.set(ifIndex, name);
  }

  // (localPortNum, remIndex) → management IP. Decode the index suffix:
  // <timeMark>.<localPortNum>.<remIndex>.<addrSubtype>.<addrLen>.<addr-bytes…>
  // addrSubtype 1 = IPv4 (4 bytes), 2 = IPv6 (16 bytes); ignore others.
  const mgmtByKey = new Map<string, string>();
  for (const suffix of manAddrEnum.keys()) {
    const parts = String(suffix).split(".");
    if (parts.length < 6) continue;
    const localPortNum = parts[1]!;
    const remIndex     = parts[2]!;
    const addrSubtype  = parts[3]!;
    const addrLen      = parseInt(parts[4]!, 10);
    if (!Number.isFinite(addrLen)) continue;
    const addrBytes = parts.slice(5, 5 + addrLen);
    if (addrBytes.length !== addrLen) continue;
    let addr: string | null = null;
    if (addrSubtype === "1" && addrLen === 4) {
      addr = addrBytes.join(".");
    } else if (addrSubtype === "2" && addrLen === 16) {
      const groups: string[] = [];
      for (let i = 0; i < 16; i += 2) {
        const hi = parseInt(addrBytes[i]!, 10);
        const lo = parseInt(addrBytes[i + 1]!, 10);
        groups.push(((hi << 8) | lo).toString(16));
      }
      addr = groups.join(":");
    }
    if (!addr) continue;
    const key = `${localPortNum}|${remIndex}`;
    if (!mgmtByKey.has(key)) mgmtByKey.set(key, addr);
  }

  // Enumerate remote neighbors via lldpRemChassisId — always present. The
  // suffix here is `<timeMark>.<localPortNum>.<remIndex>`.
  const out: LldpNeighborSample[] = [];
  for (const [suffix, chRaw] of chIds.entries()) {
    const parts = String(suffix).split(".");
    if (parts.length < 3) continue;
    const localPortNum = parts[1]!;
    const remIndex     = parts[2]!;
    const localIfName  = localPortLabel.get(localPortNum) || `port-${localPortNum}`;
    const chSub  = snmpVbToNumber(chSubtypes.get(suffix));
    const ptSub  = snmpVbToNumber(ptSubtypes.get(suffix));
    out.push({
      localIfName,
      chassisIdSubtype:  lldpChassisSubtypeLabel(chSub),
      chassisId:         parseLldpChassisId(chSub, chRaw),
      portIdSubtype:     lldpPortSubtypeLabel(ptSub),
      portId:            parseLldpPortId(ptSub, ptIds.get(suffix)),
      portDescription:   snmpVbToString(ptDescs.get(suffix)).trim() || null,
      systemName:        snmpVbToString(sysNames.get(suffix)).trim() || null,
      systemDescription: snmpVbToString(sysDescs.get(suffix)).trim() || null,
      managementIp:      mgmtByKey.get(`${localPortNum}|${remIndex}`) ?? null,
      capabilities:      parseLldpCapabilities(capsEnabled.get(suffix)),
    });
  }
  return out;
}

function parseLldpChassisId(subtype: number | null, raw: unknown): string | null {
  if (raw == null) return null;
  // macAddress(4) → format as colon-separated MAC when length matches.
  if (subtype === 4) {
    const mac = snmpMacFromBuffer(raw);
    if (mac) return mac;
  }
  if (Buffer.isBuffer(raw)) {
    const printable = raw.toString("utf8");
    if (/^[\x20-\x7e]+$/.test(printable.trim())) return printable.trim();
    return Array.from(raw).map((b) => b.toString(16).padStart(2, "0")).join(":");
  }
  const s = String(raw).trim();
  return s || null;
}

/**
 * Walk FORTINET-FORTIAP-MIB::fapStationTable and return one
 * WirelessStationSample per connected wireless client. Returns `undefined`
 * when the table is absent (device doesn't implement FORTINET-FORTIAP-MIB
 * or no SSID column is populated) so the caller leaves stored rows alone;
 * returns `[]` when the device was queried but reported zero stations
 * (caller wipes stored rows).
 *
 * INDEX = { fapStaRadioId, fapStaWlanId, fapStaMacAddr (6|8 octets) }.
 * For 6-byte Ethernet MACs the SMIv2 default-encoded suffix has 9 parts:
 *   <radioId>.<wlanId>.6.<b0>.<b1>.<b2>.<b3>.<b4>.<b5>
 * Each parallel column walk lookup uses the same suffix string.
 */
async function collectWirelessStationsSnmp(session: any): Promise<WirelessStationSample[] | undefined> {
  const [ssids, bssids, vlans, ipAddrs, radioTypes, radioChannels] = await Promise.all([
    snmpWalk(session, OID.fapStaSSID).catch(() => new Map()),
    snmpWalk(session, OID.fapStaBSSID).catch(() => new Map()),
    snmpWalk(session, OID.fapStaVlanId).catch(() => new Map()),
    snmpWalk(session, OID.fapStaIpAddr).catch(() => new Map()),
    // fapRadioTable, indexed by fapRadioIndex — used to derive each station's
    // band. Best-effort: failures leave band null, stations still persist.
    snmpWalk(session, OID.fapRadioType).catch(() => new Map()),
    snmpWalk(session, OID.fapRadioChannelOper).catch(() => new Map()),
  ]);

  // radioIndex (string suffix) → derived band. fapRadioIndex is the single
  // index column, so the walk suffix is the bare radio index.
  const bandByRadio = new Map<string, string | null>();
  for (const suffix of new Set([...radioTypes.keys(), ...radioChannels.keys()])) {
    const type = radioTypes.has(suffix) ? snmpVbToString(radioTypes.get(suffix)).trim() : null;
    const channel = snmpVbToNumber(radioChannels.get(suffix));
    bandByRadio.set(String(suffix), deriveRadioBand(type, channel));
  }

  // Treat all-empty as "table unsupported" so we don't wipe stored rows on
  // a transport that can't report. A genuinely empty AP with the MIB in
  // place still returns at least one column with zero rows — the
  // collector sees an empty Map, suffix loop produces no rows, returns
  // []. The undefined return is reserved for "couldn't query at all."
  if (ssids.size === 0 && bssids.size === 0 && vlans.size === 0 && ipAddrs.size === 0) return undefined;

  // Decode the index suffix back into (radioId, wlanId, MAC). Skip rows
  // whose suffix doesn't match the expected 6-byte-MAC shape — 8-byte
  // forms (PhysAddress SIZE(6|8)) are valid per MIB but FortiAPs in the
  // field only emit 6-byte MACs; an 8-byte row would still decode but
  // wouldn't match anything in Polaris's endpoint inventory anyway. Drop
  // those silently rather than persist a malformed MAC.
  const out: WirelessStationSample[] = [];
  for (const suffix of ssids.keys()) {
    const parts = String(suffix).split(".");
    if (parts.length !== 9) continue;
    if (parts[2] !== "6") continue;
    const radioId = Number(parts[0]);
    const wlanId  = Number(parts[1]);
    const macBytes = parts.slice(3, 9).map((p) => Number(p));
    if (macBytes.some((b) => !Number.isFinite(b) || b < 0 || b > 255)) continue;
    const staMacAddr = macBytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");

    const ssid  = snmpVbToString(ssids.get(suffix)).trim() || null;
    const bssidRaw = bssids.get(suffix);
    const bssid = bssidRaw ? snmpMacFromBuffer(bssidRaw) : null;
    const vlanId = snmpVbToNumber(vlans.get(suffix));
    // fapStaIpAddr is IpAddress (4 bytes). snmpVbToString gives us dotted-quad on
    // most encodings; we fall through to null on the all-zero "unknown" case
    // so the row carries no IP rather than "0.0.0.0".
    let staIpAddr: string | null = null;
    const ipRaw = ipAddrs.get(suffix);
    if (ipRaw) {
      const s = snmpVbToString(ipRaw).trim();
      if (s && s !== "0.0.0.0") staIpAddr = s;
    }

    out.push({
      staMacAddr,
      staIpAddr,
      ssid,
      radioId: Number.isFinite(radioId) ? radioId : null,
      wlanId:  Number.isFinite(wlanId)  ? wlanId  : null,
      band:    Number.isFinite(radioId) ? (bandByRadio.get(String(radioId)) ?? null) : null,
      vlanId:  vlanId,
      bssid,
    });
  }
  return out;
}


/**
 * Walk FORTINET-FORTIAP-MIB's radio + VAP tables and return one sample per
 * radio, each carrying the SSIDs it broadcasts — the SNMP half of the same
 * inventory discovery writes from the controller's managed_ap row.
 *
 * `undefined` when the radio table could not be read at all (not a FortiAP, no
 * FORTINET-FORTIAP-MIB, SNMP refused): the persist layer then leaves stored
 * rows alone. An AP that answered with zero radios returns [], which wipes.
 *
 * The VAP half is separately optional and deliberately so. A radio whose VAP
 * rows could not be read carries `vaps: undefined`, which preserves the SSIDs
 * the controller already established rather than clearing them — the two
 * sources name a VAP differently (FortiOS by its object name, the MIB by its
 * SSID), so a failed VAP walk that wiped would take the controller's names
 * with it and the next discovery run would put them back. Churn, on the tree
 * an operator is reading.
 */
async function collectApRadiosSnmp(session: any): Promise<ApRadioSample[] | undefined> {
  const [modes, countries, stationInfos, types, txConfigs, txOpers, txMaxes, widths, channels] = await Promise.all([
    snmpWalk(session, FAP_RADIO_OID.mode).catch(() => undefined),
    snmpWalk(session, FAP_RADIO_OID.country).catch(() => new Map()),
    snmpWalk(session, FAP_RADIO_OID.stationInfo).catch(() => new Map()),
    snmpWalk(session, FAP_RADIO_OID.type).catch(() => new Map()),
    snmpWalk(session, FAP_RADIO_OID.txPowerConfig).catch(() => new Map()),
    snmpWalk(session, FAP_RADIO_OID.txPowerOper).catch(() => new Map()),
    snmpWalk(session, FAP_RADIO_OID.txPowerMax).catch(() => new Map()),
    snmpWalk(session, FAP_RADIO_OID.channelWidth).catch(() => new Map()),
    snmpWalk(session, FAP_RADIO_OID.channelOper).catch(() => new Map()),
  ]);
  // `mode` is the discriminator: every radio row has one, including a disabled
  // radio, so its absence means the table itself is unreadable rather than
  // "this AP has no radios". A radio that answers nothing else still appears.
  if (modes === undefined) return undefined;

  const vaps = await collectApVapsSnmp(session);

  const out: ApRadioSample[] = [];
  for (const suffix of Array.from(modes.keys()).sort((a, b) => Number(a) - Number(b))) {
    const radioIndex = Number(suffix);
    if (!Number.isInteger(radioIndex)) continue;
    const typeInfo = decodeRadioType(types.get(suffix));
    const channel = snmpVbToNumber(channels.get(suffix));
    out.push({
      radioIndex,
      radioType: typeInfo.label,
      // The type enum names the band outright for seven of its eight members,
      // which beats deriving it from the channel; plain 802.11n and anything
      // outside the enum fall through to the shared derivation.
      band: typeInfo.band ?? deriveRadioBand(typeInfo.label, channel ?? null),
      mode: decodeRadioMode(modes.get(suffix)),
      channel: channel ?? null,
      bandwidthMhz: decodeChannelWidth(widths.get(suffix)),
      // The controller's percentage is a different column; these three are the
      // MIB's own unit-less integers. See utils/fortiapRadioSnmp.ts.
      txPowerPct: null,
      txPowerConfig: snmpVbToNumber(txConfigs.get(suffix)) ?? null,
      txPowerOper: snmpVbToNumber(txOpers.get(suffix)) ?? null,
      txPowerMax: snmpVbToNumber(txMaxes.get(suffix)) ?? null,
      txPowerMode: null,
      // The radio's own BSSID is not published by this table — only per-VAP
      // BSSIDs are — so it stays with whatever the controller established.
      baseBssid: null,
      clientCount: parseStationInfoCount(snmpVbToString(stationInfos.get(suffix))),
      countryCode: snmpVbToString(countries.get(suffix)).trim() || null,
      ...(vaps ? { vaps: vaps.get(radioIndex) ?? [] } : {}),
    });
  }
  return out;
}

/**
 * Walk fapVapTable into radioIndex -> the VAPs on that radio. `undefined` when
 * the table could not be read; a radio with no rows in a readable table gets
 * an empty list from the caller, which correctly means "broadcasting nothing".
 *
 * The MIB publishes no VAP object NAME — only the SSID — so `vapName` is the
 * SSID here, while the controller uses the FortiOS object name. That mismatch
 * is resolved in the persist layer by matching on BSSID, which both sources do
 * publish; without it the two writers would each create their own row for the
 * same VAP and take turns deleting the other's.
 */
async function collectApVapsSnmp(session: any): Promise<Map<number, ApVapSample[]> | undefined> {
  const [ssids, bssids, statuses, vlans, staCounts] = await Promise.all([
    snmpWalk(session, FAP_VAP_OID.ssid).catch(() => undefined),
    snmpWalk(session, FAP_VAP_OID.bssid).catch(() => new Map()),
    snmpWalk(session, FAP_VAP_OID.status).catch(() => new Map()),
    snmpWalk(session, FAP_VAP_OID.vlanId).catch(() => new Map()),
    snmpWalk(session, FAP_VAP_OID.staCount).catch(() => new Map()),
  ]);
  if (ssids === undefined) return undefined;

  const byRadio = new Map<number, ApVapSample[]>();
  for (const suffix of ssids.keys()) {
    const idx = parseVapSuffix(String(suffix));
    if (!idx) continue;
    const ssid = snmpVbToString(ssids.get(suffix)).trim();
    // A VAP with no SSID has nothing to key on and nothing to show. The MIB
    // hands back an empty string for an unconfigured WLAN slot, which is what
    // this drops — a real hidden SSID still has a name, it just isn't beaconed.
    if (!ssid) continue;
    // An administratively-down VAP is still inventory, but a VAP the radio
    // reports as DOWN is not broadcasting; keep it out of the tree rather than
    // showing an SSID nobody can join.
    const status = snmpVbToNumber(statuses.get(suffix));
    if (status === 0) continue;
    const bssidRaw = bssids.get(suffix);
    const list = byRadio.get(idx.radioIndex) ?? [];
    list.push({
      vapName: ssid,
      ssid,
      bssid: bssidRaw ? snmpMacFromBuffer(bssidRaw) : null,
      vlanId: snmpVbToNumber(vlans.get(suffix)) ?? null,
      clientCount: snmpVbToNumber(staCounts.get(suffix)) ?? null,
    });
    byRadio.set(idx.radioIndex, list);
  }
  return byRadio;
}

function parseLldpPortId(subtype: number | null, raw: unknown): string | null {
  if (raw == null) return null;
  // macAddress(3) on lldpRemPortIdSubtype — same trick as chassis.
  if (subtype === 3) {
    const mac = snmpMacFromBuffer(raw);
    if (mac) return mac;
  }
  if (Buffer.isBuffer(raw)) {
    const printable = raw.toString("utf8");
    if (/^[\x20-\x7e]+$/.test(printable.trim())) return printable.trim();
    return Array.from(raw).map((b) => b.toString(16).padStart(2, "0")).join(":");
  }
  const s = String(raw).trim();
  return s || null;
}

function lldpChassisSubtypeLabel(n: number | null): string | null {
  switch (n) {
    case 1: return "chassisComponent";
    case 2: return "interfaceAlias";
    case 3: return "portComponent";
    case 4: return "macAddress";
    case 5: return "networkAddress";
    case 6: return "interfaceName";
    case 7: return "local";
    default: return null;
  }
}

function lldpPortSubtypeLabel(n: number | null): string | null {
  switch (n) {
    case 1: return "interfaceAlias";
    case 2: return "portComponent";
    case 3: return "macAddress";
    case 4: return "networkAddress";
    case 5: return "interfaceName";
    case 6: return "agentCircuitId";
    case 7: return "local";
    default: return null;
  }
}

// LldpSystemCapabilitiesMap is a 16-bit OctetString; bit 0 (MSB of byte 0)
// is `other`, bit 1 is `repeater`, etc. We only decode the eight defined
// IEEE 802.1AB-2009 capabilities; the rest are reserved.
function parseLldpCapabilities(raw: unknown): string[] {
  const labels = ["other", "repeater", "bridge", "wlan-access-point", "router", "telephone", "docsis-cable-device", "station-only"];
  const out: string[] = [];
  if (Buffer.isBuffer(raw) && raw.length >= 1) {
    const byte = raw[0]!;
    for (let i = 0; i < 8; i++) {
      if (byte & (1 << (7 - i))) out.push(labels[i]!);
    }
  }
  return out;
}


// ─── Persisting telemetry / system info ─────────────────────────────────────

/** Byte figure → BigInt, keeping null as null (a band nobody measured). */
function bytesOrNull(v: number | null | undefined): bigint | null {
  return v != null && Number.isFinite(v) ? BigInt(Math.max(0, Math.round(v))) : null;
}

// ─── Attempt vs success stamps (business rule 118) ──────────────────────────
//
// Each heavy stream keeps the last ATTEMPT (the scheduler's due anchor) apart
// from the last SUCCESS (what "updated X ago", the stale banner and the system
// info anchor read). One stamp used to do both jobs, and the two streams had
// settled the conflict in opposite directions: telemetry stamped every attempt,
// so a device whose REST pull failed forever read "updated 1m ago" over an
// empty chart; system info stamped only successes, so the UI was honest but a
// failing device was re-walked on every heavy tick.

/** Cap on a stored failure message — a collector error is one line, but a
 *  thrown HTML body or a stack must not land in an Asset column whole. */
export const POLL_ERROR_MAX_LEN = 500;

/** The message a failed collection leaves behind: its own error, or a plain
 *  statement that the device answered with nothing usable. */
export function pollFailureText(error: string | null | undefined, fallback: string): string {
  const text = (error ?? "").trim() || fallback;
  return text.length > POLL_ERROR_MAX_LEN ? text.slice(0, POLL_ERROR_MAX_LEN - 1) + "…" : text;
}

/** The columns a SUCCESSFUL poll of a stream writes: success and attempt
 *  together, and the failure run closed. Every success writer spreads this —
 *  the agent push routes included — because a success that left the attempt
 *  stamp behind would leave the stream due on every tick. */
export function telemetrySuccessStamps(at: Date) {
  return { lastTelemetryAt: at, lastTelemetryAttemptAt: at, telemetryFailingSince: null, telemetryLastError: null };
}
export function systemInfoSuccessStamps(at: Date) {
  return { lastSystemInfoAt: at, lastSystemInfoAttemptAt: at, systemInfoFailingSince: null, systemInfoLastError: null };
}

/** A FAILED poll: stamp the attempt, open the failure run if none is open
 *  (COALESCE — the run starts at its FIRST failure, which a read-then-write
 *  would race), record the message. The success stamp is untouched. One
 *  statement, and only on the failure path. */
async function recordStreamFailure(stream: "telemetry" | "systemInfo", assetId: string, at: Date, message: string): Promise<void> {
  if (stream === "telemetry") {
    await prisma.$executeRaw`UPDATE assets SET "lastTelemetryAttemptAt" = ${at}, "telemetryFailingSince" = COALESCE("telemetryFailingSince", ${at}), "telemetryLastError" = ${message} WHERE id = ${assetId}`;
  } else {
    await prisma.$executeRaw`UPDATE assets SET "lastSystemInfoAttemptAt" = ${at}, "systemInfoFailingSince" = COALESCE("systemInfoFailingSince", ${at}), "systemInfoLastError" = ${message} WHERE id = ${assetId}`;
  }
}

export async function recordTelemetryResult(assetId: string, result: CollectionResult<TelemetrySample>): Promise<void> {
  if (!result.supported) return;
  const now = new Date();
  if (!result.data) {
    await recordStreamFailure("telemetry", assetId, now, pollFailureText(result.error, "The device returned no CPU / memory data"));
    return;
  }
  const d = result.data;
  enqueueTelemetrySample({
    assetId,
    timestamp: now,
    cpuPct:        d.cpuPct ?? null,
    memPct:        d.memPct ?? null,
    memUsedBytes:  d.memUsedBytes  != null ? BigInt(Math.round(d.memUsedBytes))  : null,
    memTotalBytes: d.memTotalBytes != null ? BigInt(Math.round(d.memTotalBytes)) : null,
    // Per-core CPU reaches this function from the vCenter collector and the
    // Unraid / TrueNAS host snapshot (workloadMonitorService);
    // the agent's copy arrives on its own push path (routes/agents.ts),
    // which writes this buffer directly. FortiOS REST, SNMP, WinRM and SSH
    // expose no per-core figure at all and leave it null.
    cpuCorePcts:     d.cpuCorePcts ?? null,
    // The agent's band set (used + buffers + cached + free = total). One
    // server-side collector fills it — a TrueNAS host, whose ZFS ARC is the
    // `cached` band (workloadMonitorService) and which reconciles the sum
    // itself. Everything else leaves it null.
    memBuffersBytes: bytesOrNull(d.memBuffersBytes),
    memCachedBytes:  bytesOrNull(d.memCachedBytes),
    memFreeBytes:    bytesOrNull(d.memFreeBytes),
    swapUsedBytes:   null,
    swapTotalBytes:  null,
    // The vCenter band set, disjoint from the one above. Null everywhere
    // else, and the two are never populated on the same row.
    memPrivateBytes:    bytesOrNull(d.memPrivateBytes),
    memSharedBytes:     bytesOrNull(d.memSharedBytes),
    memBalloonedBytes:  bytesOrNull(d.memBalloonedBytes),
    memSwappedBytes:    bytesOrNull(d.memSwappedBytes),
    memCompressedBytes: bytesOrNull(d.memCompressedBytes),
    memConsumedBytes:   bytesOrNull(d.memConsumedBytes),
    sessionCount:  d.sessionCount ?? null,
  });
  await prisma.asset.update({ where: { id: assetId }, data: telemetrySuccessStamps(now) });
}

/**
 * Persist a hardware-sensor collection result. Unlike telemetry there is no
 * Asset.lastHardwareSensorAt column — the System tab derives the last-sample
 * timestamp from the latest AssetHardwareSensorSample row. If no samples were
 * written (device exposes no sensors, or the scrape failed), the System tab
 * keeps showing the prior timestamp and surfaces an amber "last successful
 * update X ago" badge once it falls behind the resolved cadence.
 */
export async function recordHardwareSensorResult(assetId: string, result: CollectionResult<HardwareSensorSample[]>): Promise<void> {
  if (!result.supported) return;
  if (Array.isArray(result.data) && result.data.length > 0) {
    // Sanity-filter ONLY temperature-class rows to a plausible operating range
    // — covers misinterpreted ENTITY-SENSOR-MIB scale/precision on some agents
    // (we've seen FortiSwitch sensors report 52000 / 34937). Other classes
    // (fan RPM, voltage, presence) have unbounded/different ranges and pass
    // through. Null value is preserved as the "couldn't read" signal.
    const filtered = result.data.filter(
      (s) =>
        s.sensorClass !== "temperature" ||
        s.value == null ||
        (Number.isFinite(s.value) && s.value >= -40 && s.value <= 200),
    );
    if (filtered.length === 0) return;
    const now = new Date();
    enqueueHardwareSensorSamples(
      filtered.map((s) => ({
        assetId,
        timestamp:   now,
        sensorName:  s.sensorName,
        sensorClass: s.sensorClass,
        value:       s.value,
        unit:        s.unit,
        alarmStatus: s.alarmStatus,
        ifName:      s.ifName ?? null,
      })),
    );
  }
}

// ─── recordSystemInfoResult stream persisters (split 2026-08 — the contract
// tests in tests/integration/recordSystemInfoContract.test.ts pin each
// stream's behavior: pin-aware cadence stamps, the MAC fold's source scoping,
// the assoc-IP full-replace, LLDP stickiness interplay, detected-model
// adoption, and the lastSystemInfoAt empty-interfaces guard). Each helper
// owns exactly one stream family; the orchestrator below reads as the list
// of streams a system-info scrape can carry.

/** The per-asset pins + identity bits the persisters need. One indexed PK read per scrape. */
type SystemInfoPins = {
  monitoredInterfaces: string[];
  monitoredStorage: string[];
  monitoredIpsecTunnels: string[];
  ipAddress: string | null;
  model: string | null;
  hostname: string | null;
  manufacturer: string | null;
  osVersion: string | null;
  os: string | null;
  /** For the OUI-override guard in adoptSysDescrIdentity. */
  macAddress: string | null;
  /** For the device-type inference gate — only `other` may be re-typed. */
  assetType: string;
  productType: string | null;
} | null;

/**
 * Interface samples (pin-aware cadence) + the Associated-MACs range fold.
 * Selection-aware cadence: the full scrape covers every entity, so stamp
 * each row "fast" when its entity is operator-pinned (kept at full retention
 * + rolled up) and "slow" otherwise (kept 24h, never rolled up).
 */
async function persistInterfaceSampleStream(
  assetId: string,
  interfaces: InterfaceSample[],
  pinned: SystemInfoPins,
  now: Date,
): Promise<void> {
  if (interfaces.length === 0) return;
  const pinnedIfaces = new Set(pinned?.monitoredInterfaces ?? []);
  // TIME-SERIES rows are written for PINNED interfaces only. Current state for
  // every interface (pinned or not) is persisted separately by
  // `persistInterfaces` into `asset_interfaces` — see the AssetInterface model.
  //
  // Unpinned interfaces used to be written here as cadence="slow" and deleted
  // 24h later. That was ~4-5x the pinned write volume for rows nothing read as
  // history: they were never compressed (deleted at 24h while the
  // selection-aware compression floor is 2 days, so they lived their whole life
  // in uncompressed heap), never rolled up, and removed by the row-level DELETE
  // behind the 2026-06-08 / 2026-06-17 compressed-chunk bloat incidents. Every
  // consumer that needed them wanted *current state*, which now has its own
  // table.
  //
  // The `cadence` column stays: storage and ipsec still use the fast/slow
  // split, the rollup + prune paths are shared, and legacy slow rows age out
  // through the existing 24h prune rather than needing a migration.
  const pinnedOnly = interfaces.filter((i) => pinnedIfaces.has(i.ifName));
  const pinnedRows: InterfaceSampleRow[] = pinnedOnly.map((i) => {
    // Business rule 126 — the same normalisation interfaceInventoryService
    // applies to the current-state row, so the two cannot disagree.
    const addr = splitInterfaceAddresses(i.ipAddress, i.ipv6Address, ipv6Enabled());
    return {
    assetId,
    timestamp: now,
    cadence:     "fast" as const,
    ifName:      i.ifName,
    adminStatus: i.adminStatus ?? null,
    operStatus:  i.operStatus ?? null,
    speedBps:    i.speedBps != null ? BigInt(Math.round(i.speedBps)) : null,
    duplex:      i.duplex ?? null,
    ipAddress:   addr.ipAddress,
    ipv6Address: addr.ipv6Address,
    macAddress:  i.macAddress ?? null,
    inOctets:    i.inOctets  != null ? BigInt(Math.round(i.inOctets))  : null,
    outOctets:   i.outOctets != null ? BigInt(Math.round(i.outOctets)) : null,
    inErrors:    i.inErrors  != null ? BigInt(Math.round(i.inErrors))  : null,
    outErrors:   i.outErrors != null ? BigInt(Math.round(i.outErrors)) : null,
    ifType:      i.ifType   ?? null,
    ifParent:    i.ifParent ?? null,
    vlanId:      i.vlanId   ?? null,
    nativeVlan:  i.nativeVlan ?? null,
    taggedVlans: i.taggedVlans ?? [],
    trunksAllVlans: i.trunksAllVlans === true,
    alias:       i.alias       ?? null,
    description: i.description ?? null,
    addressingMode: i.addressingMode ?? null,
    poeStatus:   i.poeStatus ?? null,
    poeClass:    i.poeClass  ?? null,
    };
  });
  if (pinnedRows.length > 0) {
    enqueueInterfaceSamples(pinnedRows);
    void recordInterfaceLinkEvents(pinnedRows);
  }
  // Fold EVERY scraped interface MAC (monitored or not) into the asset's
  // Associated MACs list (AssetMacAddress), coalescing contiguous MACs
  // into range rows so a 48-port switch costs one row instead of 48.
  // Source-scoped full-replace over source="monitor-interface" only —
  // rows owned by discovery/agent/manual writers are never touched.
  const ifaceMacs = interfaces
    .map((i) => i.macAddress)
    .filter((m): m is string => !!m);
  if (ifaceMacs.length > 0) {
    const stopMacWrite = startSampleWriteTimer("asset_mac_addresses");
    const endMac = startPhase("systeminfo.persist.iface_macs");
    await reconcileInterfaceMacs(assetId, ifaceMacs, now);
    endMac({ macs: ifaceMacs.length });
    stopMacWrite();
  }
}

function persistStorageSampleStream(
  assetId: string,
  storage: StorageSample[],
  pinned: SystemInfoPins,
  now: Date,
): void {
  if (storage.length === 0) return;
  const pinnedStorage = new Set(pinned?.monitoredStorage ?? []);
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

function persistIpsecTunnelSampleStream(
  assetId: string,
  tunnels: IpsecTunnelSample[] | undefined,
  pinned: SystemInfoPins,
  now: Date,
): void {
  if (!Array.isArray(tunnels) || tunnels.length === 0) return;
  const pinnedTunnels = new Set(pinned?.monitoredIpsecTunnels ?? []);
  enqueueIpsecTunnelSamples(
    tunnels.map((t) => ({
      assetId,
      timestamp: now,
      cadence:         pinnedTunnels.has(t.tunnelName) ? ("fast" as const) : ("slow" as const),
      tunnelName:      t.tunnelName,
      parentInterface: t.parentInterface,
      remoteGateway:   t.remoteGateway,
      status:          t.status,
      incomingBytes:   t.incomingBytes != null ? BigInt(Math.round(t.incomingBytes)) : null,
      outgoingBytes:   t.outgoingBytes != null ? BigInt(Math.round(t.outgoingBytes)) : null,
      proxyIdCount:    t.proxyIdCount,
    })),
  );
}

/**
 * SD-WAN SLA time-series (gated by Integration.config.pullSdwan, only present
 * when collectSdwanFortinet ran on this SD-WAN pass). No pinned-subset concept
 * — every row is stamped "fast" so the rollup (which filters cadence='fast')
 * includes it and prune treats them all uniformly.
 */
function persistPerfSlaSampleStream(
  assetId: string,
  perfSla: PerfSlaSample[] | undefined,
  now: Date,
): void {
  if (!Array.isArray(perfSla) || perfSla.length === 0) return;
  enqueuePerfSlaSamples(
    perfSla.map((p) => ({
      assetId,
      timestamp:   now,
      cadence:     "fast" as const,
      healthCheck: p.healthCheck,
      link:        p.link,
      zone:        p.zone,
      state:       p.state,
      latencyMs:   p.latencyMs,
      jitterMs:    p.jitterMs,
      packetLoss:  p.packetLoss,
      latencyThresholdMs:  p.latencyThresholdMs,
      jitterThresholdMs:   p.jitterThresholdMs,
      packetLossThreshold: p.packetLossThreshold,
    })),
  );
}

/**
 * Mirror per-interface IPs+MACs into the asset_associated_ips side table.
 * Replaces the legacy JSONB read-modify-write pattern. Discovery no longer
 * populates interface IPs, so the System tab is the single source for them
 * once monitoring is on. Manual entries (source = "manual") are preserved by
 * deleting only the non-manual rows before re-inserting the fresh monitor
 * set. Skipped entirely when the scrape returned no interface IPs (better to
 * keep the previous list than wipe it on a transient empty result). Also
 * folds the scraped IPs into IP History (fire-and-forget).
 */
async function persistAssocIpMirror(
  assetId: string,
  interfaces: InterfaceSample[],
  pinned: { ipAddress: string | null } | null,
  now: Date,
  source: InterfaceAddressSource = "monitor-system-info",
): Promise<void> {
  const monitorAssocEntries = buildMonitorAssocIpEntries(interfaces, now, source);
  if (monitorAssocEntries.length === 0) return;
  const stopWrite = startSampleWriteTimer("asset_associated_ips");
  const endAssoc = startPhase("systeminfo.persist.assoc_ips_txn");
  // One $transaction so the delete + insert pair is atomic — a concurrent
  // reader will either see the old set or the new set, never an empty
  // intermediate. retryOnDeadlock: a concurrent system-info / probe-patch
  // writer can win a deadlock against this delete+insert pair (40P01). The
  // op is idempotent (full-replace of the asset's non-manual IPs), so re-run
  // on deadlock instead of crashing the whole system-info scrape.
  // Discovery's rows (business rule 102, services/assetAddressService) are not
  // this scrape's to delete — they are current-state per gate and pruned by
  // their own writer. The scrape takes over an IP both report (the device's
  // own interface table names it better), and leaves the rest alone.
  const scrapedIps = monitorAssocEntries.map((e) => e.ip);
  await retryOnDeadlock(() =>
    prisma.$transaction([
      prisma.assetAssociatedIp.deleteMany({
        where: {
          assetId,
          OR: [
            { source: { notIn: ["manual", ...DISCOVERED_ADDRESS_SOURCES] } },
            { source: { in: [...DISCOVERED_ADDRESS_SOURCES] }, ip: { in: scrapedIps } },
          ],
        },
      }),
      prisma.assetAssociatedIp.createMany({
        data: monitorAssocEntries.map((e) => ({ ...e, assetId })),
        skipDuplicates: true,
      }),
    ]),
  );
  endAssoc({ rows: monitorAssocEntries.length });
  stopWrite();
  // Fold the asset's interface IPs into IP History so the timeline captures
  // every IP the device holds — including public WAN / secondary addresses,
  // which never become the primary `ipAddress` and so were previously absent
  // from the history. The primary IP is already recorded by the db.ts Prisma
  // extension; recordIpHistoryEntries skips it to avoid firstSeen churn on
  // the shared management address. Fire-and-forget — best-effort, never
  // blocks or fails the scrape.
  void recordIpHistoryEntries(
    assetId,
    monitorAssocEntries.map((e) => ({ ip: e.ip, source: e.source })),
    pinned?.ipAddress ?? null,
  );
}

/**
 * Who read an interface table's addresses. `agent-interface` is the asset's
 * own Polaris Agent: its bearer is bound to this asset, so the report cannot
 * have come from another device answering at the address (business rule
 * 103(e)); an SNMP / REST / WinRM scrape proves only that something answered.
 */
export type InterfaceAddressSource = "monitor-system-info" | "agent-interface";

/**
 * The agent's interface push, mirrored into the address list the same way
 * recordSystemInfoResult mirrors a scrape (one replace, manual and discovered
 * rows kept, empty push skipped). For an agent-monitored host this push IS
 * the interface table.
 */
export async function persistAgentAddressRows(
  assetId: string,
  interfaces: ReadonlyArray<Pick<InterfaceSample, "ifName" | "ipAddress" | "ipv6Address" | "macAddress">>,
  now: Date,
): Promise<void> {
  const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { ipAddress: true } });
  await persistAssocIpMirror(assetId, interfaces as InterfaceSample[], { ipAddress: asset?.ipAddress ?? null }, now, "agent-interface");
}

/**
 * Detected hardware model (FortiSwitch fsSysVersion parse). Adopt onto
 * Asset.model only while the stored model is empty or still generic —
 * discovery stamps the literal "FortiSwitch" (the managed-switch CMDB has
 * no model field) and the projection deliberately skips the fortiswitch
 * source's model, so this write can't be clobbered by the next discovery
 * cycle. A previously-detected "FortiSwitch <token>" stays overwritable
 * (self-heals on a hardware swap behind the same IP); anything else is
 * operator-typed and never touched. Edge-triggered: writes + logs only
 * when the value actually changes.
 */
async function adoptDetectedModel(
  assetId: string,
  detectedModel: string | null | undefined,
  pinned: SystemInfoPins,
): Promise<void> {
  if (typeof detectedModel !== "string" || !detectedModel || !pinned) return;
  const currentModel = (pinned.model ?? "").trim();
  const overwritable = !currentModel || /^fortiswitch\b/i.test(currentModel);
  if (!overwritable || currentModel === detectedModel) return;
  await prisma.asset.update({ where: { id: assetId }, data: { model: detectedModel } });
  logEvent({
    action: "asset.model_detected",
    resourceType: "asset",
    resourceId: assetId,
    resourceName: pinned.hostname || undefined,
    level: "info",
    message: `Model detected via SNMP: ${pinned.hostname || assetId} "${currentModel || "(none)"}" → "${detectedModel}"`,
    // Any profile's Model identity row lands here now, not only FortiSwitch's.
    details: { previousModel: currentModel || null, model: detectedModel, source: "snmp:model-profile" },
  });
}

/**
 * Adopt what the device's own sysDescr format stated (model / firmware /
 * manufacturer), for the vendors whose layout `utils/snmpDescrIdentity.ts`
 * can read. Which fields may move, and why each differs, is the pure
 * `decideDescrAdoption` — this is only the I/O around it.
 *
 * Two guards live here rather than in the decision, because both are facts
 * about the row rather than about the reading:
 *
 *  - **Only an asset no discovery source claims.** These three columns are
 *    PROJECTED from `AssetSource` rows for anything a controller, directory,
 *    vCenter or agent knows about (`utils/assetProjection.ts`), and `manual`
 *    appears in none of those ladders — so writing here is safe exactly while
 *    `manual` is all there is, and would otherwise be a write the next
 *    projection silently reverts. That population IS the one this exists for:
 *    equipment belonging to no controller and no directory (business rule 34).
 *  - **The Event comes from the existing builder.** `computeFirmwareChange`
 *    already rules that a first learn is not an upgrade, so a camera whose
 *    firmware Polaris never knew fills the field silently and only a real move
 *    writes `asset.firmware.changed` — the same event discovery emits, which
 *    is what the firmware_changed automation trigger watches.
 *
 * Edge-triggered by construction: `decideDescrAdoption` returns null when
 * nothing should move, so an unchanged device costs one comparison and no
 * query at all.
 */
async function adoptSysDescrIdentity(
  assetId: string,
  d: SystemInfoSample,
  pinned: SystemInfoPins,
): Promise<void> {
  if (!pinned || !d.descrIdentity) return;
  await applyDescrIdentity(assetId, d.descrIdentity, d.sysDescr ?? null, pinned);
}

/**
 * Reconcile one parsed sysDescr reading onto an asset.
 *
 * Shared by the two readers, which see the same device on different
 * schedules: the SNMP **system-info pass** (which reads sysDescr anyway, but
 * only runs when an interfaces / LLDP / storage stream is enabled AND the
 * asset reads `up`), and the SNMP **response-time probe** (which reaches
 * every SNMP-polled asset on its own 10-minute anchor, including one that is
 * flapping and therefore never gets a heavy pass). Whichever runs first
 * stamps `Asset.lastDescrAt` and satisfies the other.
 */
async function applyDescrIdentity(
  assetId: string,
  detail: SysDescrDetail,
  sysDescr: string | null,
  pinned: NonNullable<SystemInfoPins>,
): Promise<void> {

  // What the device said about itself, in the shape the projection reads.
  const observed = {
    manufacturer: detail.manufacturer ?? null,
    model: detail.model ?? null,
    osVersion: detail.osVersion ?? null,
    productType: detail.productType ?? null,
    // The whole reading, verbatim, as the record of what the device said —
    // read by the Sources tab and by nothing that decides anything. It is
    // deliberately NOT offered to the `os` projection: that column is
    // rendered as "OS / Firmware" beside osVersion, so contributing the raw
    // descr printed the entire semicolon-delimited string where "8.40.3"
    // belonged.
    sysDescr,
  };

  // Steady state costs ONE indexed read and nothing else. The gate is "did
  // the device's answer change since we last recorded it?" — deliberately
  // NOT "does it disagree with the Asset row", which never converges for a
  // device whose identity a higher-priority source legitimately owns: that
  // comparison differs on every pass forever, re-writing and re-projecting
  // to reach the same answer. Comparing against our own last recording is
  // stable whoever wins the projection.
  const existing = await prisma.assetSource.findUnique({
    where: { sourceKind_externalId: { sourceKind: "snmp-sysdescr", externalId: assetId } },
    select: { observed: true },
  });
  if (existing && sameDescrObserved(existing.observed as Record<string, unknown> | null, observed)) {
    return;
  }

  const now = new Date();
  await prisma.assetSource.upsert({
    where: { sourceKind_externalId: { sourceKind: "snmp-sysdescr", externalId: assetId } },
    // externalId is the assetId — the convention `manual` rows already use.
    // This source has no identifier of its own to key on, being the device's
    // own voice rather than a record in someone else's inventory.
    create: {
      assetId,
      sourceKind: "snmp-sysdescr",
      externalId: assetId,
      observed,
      syncedAt: now,
      lastSeen: now,
    },
    update: { assetId, observed, syncedAt: now, lastSeen: now },
  });

  // Whether the device's word WINS is the priority list's call, not this
  // function's — which is the whole reason this routes through an AssetSource
  // instead of writing the columns. A gate that fingerprinted the device as
  // "ip camera" loses to the device's own "M2036-LE"; an in-guest agent or
  // Arc reading real SMBIOS does not.
  const sources = await prisma.assetSource.findMany({
    where: { assetId },
    select: { sourceKind: true, inferred: true, observed: true, lastSeen: true },
  });
  const { projected } = projectAssetFromSources(
    sources.map((r) => ({
      sourceKind: r.sourceKind,
      inferred: r.inferred,
      observed: r.observed as Record<string, unknown> | null,
      lastSeen: r.lastSeen,
    })),
  );

  // ONLY the four identity fields this source can speak to. Applying the
  // whole projection here would make the monitor path a general projection
  // writer — rewriting hostname, IP and learnedLocation from other sources on
  // a cadence that has nothing to do with them.
  const diff: Record<string, string | null> = {};
  for (const f of ["manufacturer", "model", "os", "osVersion", "productType"] as const) {
    const next = projected[f];
    if (next !== null && next !== pinned[f]) diff[f] = next;
  }

  // One-way cleanup, provenance-bounded: earlier versions of this path (and
  // Discovery adoption) stamped the RAW sysDescr into `os`, which the asset
  // page prints beside osVersion as "OS / Firmware". Clear it where the stored
  // value IS the string this device is telling us right now — never a value
  // some other source contributed, and never a guess at what the OS is called.
  // Projection cannot do this: it only ever writes non-null, so a column
  // nobody states any more keeps its last value forever.
  if (sysDescr && (pinned.os ?? "").trim() === sysDescr.trim() && diff.os === undefined) {
    diff.os = null;
  }

  // An operator's OUI override is an explicit statement about the VENDOR, and
  // discovery Phase 9a writes it straight onto the Asset rather than through a
  // source row — so the projection cannot see it, and the two would trade
  // writes every cycle, each auditing an identity "change" that is really two
  // writers disagreeing. The operator's statement wins; the device still
  // supplies model, firmware and self-description. Costs an in-memory map
  // lookup, and only when there is a vendor diff to suppress.
  if (diff.manufacturer && pinned.macAddress) {
    const override = await lookupOuiOverride(pinned.macAddress);
    if (override) delete diff.manufacturer;
  }

  if (Object.keys(diff).length === 0) return;
  await prisma.asset.update({ where: { id: assetId }, data: diff });

  // A device that just told us what it is can be TYPED from that, through the
  // operator's own rules in the registry rather than a predicate in here.
  //
  // Three deliberate bounds. It runs in the **scan** context, not a context of
  // its own: an SNMP read on the monitor path is the same KIND of evidence a
  // Network Discovery collects — we asked the device directly — so a rule an
  // operator wrote for scans applies here without being written twice, and
  // this is the only reader that reaches a camera already in inventory (the
  // scan context otherwise fires once, at adoption). It is **`other`-only**,
  // the eligibility the registry's own retroactive Apply uses, so a type an
  // authoritative source or an operator set is never overwritten. And the
  // facts include the raw sysDescr as `os` even though the column no longer
  // stores it, because a rule written against the whole self-description has
  // to keep matching what it matched before productType existed.
  if (pinned.assetType === "other") {
    const nextType = resolveAssetTypeCached(
      {
        os: sysDescr,
        hostname: pinned.hostname,
        manufacturer: diff.manufacturer ?? pinned.manufacturer,
        model: diff.model ?? pinned.model,
        productType: diff.productType ?? pinned.productType,
      },
      "scan",
    );
    if (nextType && nextType !== "other") {
      // Re-assert `other` in the WHERE, not just in the read: discovery or an
      // operator may have typed this row in the time it took to get here.
      const typed = await prisma.asset.updateMany({
        where: { id: assetId, assetType: "other" },
        data: { assetType: nextType },
      });
      if (typed.count > 0) {
        logEvent({
          action: "asset.type_inferred",
          resourceType: "asset",
          resourceId: assetId,
          resourceName: pinned.hostname || undefined,
          level: "info",
          message:
            `Device type inferred as "${nextType}" from what the device reports` +
            `${detail.productType ? ` ("${detail.productType}")` : ""}`,
          details: {
            source: "snmp:sysDescr",
            assetType: nextType,
            productType: detail.productType ?? null,
            model: detail.model ?? null,
          },
        });
      }
    }
  }

  const ev = buildFirmwareChangedEvent(
    { assetId, assetName: pinned.hostname, actor: "system:monitor", source: "snmp-sysdescr" },
    { osVersion: pinned.osVersion },
    // Only osVersion is offered to the differ: `os` here is the whole
    // sysDescr, in which the firmware is one token, so reporting both would
    // state the same upgrade twice in one sentence.
    { osVersion: diff.osVersion ?? pinned.osVersion },
  );
  if (ev) logEvent(ev);

  // Hardware identity MOVING is its own finding, and a different one from
  // firmware: a model that changes behind a fixed address means the device was
  // replaced, and a manufacturer that changes usually means Polaris had it
  // wrong (every camera adopted before the enterprise-arc-368 fix says
  // "ServerTech"). Audited on a MOVE only — a first learn fills the column
  // silently, the same rule `computeFirmwareChange` applies to firmware, or
  // the first pass over a camera fleet would write one row per device saying
  // nothing changed. Reuses `asset.model_detected`, the action
  // `adoptDetectedModel` already writes, so no new event vocabulary appears.
  const moved: string[] = [];
  if (diff.model && (pinned.model ?? "").trim()) {
    moved.push(`model "${pinned.model}" → "${diff.model}"`);
  }
  if (diff.manufacturer && (pinned.manufacturer ?? "").trim()) {
    moved.push(`manufacturer "${pinned.manufacturer}" → "${diff.manufacturer}"`);
  }
  if (moved.length) {
    logEvent({
      action: "asset.model_detected",
      resourceType: "asset",
      resourceId: assetId,
      resourceName: pinned.hostname || undefined,
      level: "info",
      message: `Identity restated by the device: ${pinned.hostname || assetId} ${moved.join("; ")}`,
      details: {
        source: "snmp:sysDescr",
        previousModel: pinned.model || null,
        model: diff.model ?? pinned.model ?? null,
        previousManufacturer: pinned.manufacturer || null,
        manufacturer: diff.manufacturer ?? pinned.manufacturer ?? null,
      },
    });
  }
}

export async function recordSystemInfoResult(assetId: string, result: CollectionResult<SystemInfoSample>): Promise<void> {
  if (!result.supported) return;
  const now = new Date();
  if (!result.data) {
    await recordStreamFailure("systemInfo", assetId, now, pollFailureText(result.error, "The device returned no interface data"));
    return;
  }
  const d = result.data;
  // One indexed PK read per scrape on the slow (~10 min) cadence — the pins
  // drive the fast/slow cadence stamps, the identity bits feed the assoc-IP
  // history fold and the model adoption.
  const pinned: SystemInfoPins = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { monitoredInterfaces: true, monitoredStorage: true, monitoredIpsecTunnels: true, ipAddress: true, ipv6Address: true, model: true, hostname: true, manufacturer: true, osVersion: true, os: true, macAddress: true, assetType: true, productType: true },
  });

  // Reconcile the collected names against the identity of record BEFORE
  // anything keys on them. A scrape whose `ifName` walk failed names every
  // port by its `ifDescr` — the operator's DESCRIPTION on a FortiSwitch — and
  // that name would otherwise land in the inventory, the pin list and every
  // alert dimension as if it were a port (prod 2026-08-25; see
  // utils/interfaceIdentity.ts).
  if (d.interfaces.length > 0) {
    const identity = await loadInterfaceIdentity(assetId);
    const canon = canonicalizeInterfaceRows(d.interfaces, identity);
    if (canon.renamed.length > 0 || canon.dropped > 0) {
      logger.warn(
        { assetId, ports: canon.renamed.slice(0, 5).map((r) => r.to), renamedCount: canon.renamed.length, dropped: canon.dropped },
        "interface scrape named ports by their description — mapped back to the port name",
      );
      d.interfaces = canon.rows;
    }
  }

  await persistInterfaceSampleStream(assetId, d.interfaces, pinned, now);
  // CURRENT-STATE interface inventory. Written from the FULL pass only — never
  // from recordFastFilteredResult, which sees just the pinned subset and would
  // wipe every unpinned interface's row on each probe tick.
  //
  // Skipped on an empty array for the same reason lastSystemInfoAt is: an empty
  // interface list means "this pull returned nothing useful" at least as often
  // as it means "this device has no interfaces" (a FortiOS token without
  // monitor scope answers 200 OK with empty results), and blanking the System
  // tab while the device is online is the worse failure.
  if (d.interfaces.length > 0) {
    const stopIfWrite = startSampleWriteTimer("asset_interfaces");
    const endIfaces = startPhase("systeminfo.persist.interfaces");
    await persistInterfaces(assetId, d.interfaces, now);
    endIfaces({ interfaces: d.interfaces.length });
    stopIfWrite();
    // Pins are reconciled against the inventory just written, not the one the
    // canonicalization above read: a pin created while a scrape was naming
    // ports by description ("MORGAN-221E-1") names a port that does not
    // exist, and only the fresh rows can say which port it described. Cheap
    // and edge-triggered — no write unless a pin actually moves.
    await repairInterfacePins(
      assetId,
      buildInterfaceIdentity(d.interfaces),
      pinned?.monitoredInterfaces,
      pinned?.hostname,
    );
  }
  persistStorageSampleStream(assetId, d.storage, pinned, now);
  persistIpsecTunnelSampleStream(assetId, d.ipsecTunnels, pinned, now);
  // Who is connected through the gate's IPsec / SSL-VPN (the IPsec tab).
  // CURRENT-STATE, full pass only — recordFastFilteredResult never sees
  // these. Each half is replaced only when its own read answered (see
  // SystemInfoSample.ipsecConnections), so an SSL-VPN read the token can't
  // make does not wipe the IPsec peers or vice versa.
  if (Array.isArray(d.ipsecConnections) || Array.isArray(d.sslVpnSessions)) {
    const stopWrite = startSampleWriteTimer("asset_ipsec_connections");
    const endConn = startPhase("systeminfo.persist.ipsec_connections");
    const written = await persistIpsecConnections(assetId, { ipsec: d.ipsecConnections, sslVpn: d.sslVpnSessions }, now);
    endConn({ connections: written });
    stopWrite();
  }
  // SD-WAN SLA samples + rules are written by runSdwanFor on their own cadence.

  await persistAssocIpMirror(assetId, d.interfaces, pinned, now);

  // LLDP neighbors. `undefined` = the collector didn't run / unsupported
  // transport, so leave the existing rows alone. An array = queried
  // successfully → persistLldpNeighbors reconciles it (with the 48h sticky
  // window, so one empty scrape doesn't flap a live neighbor off).
  if (Array.isArray(d.lldpNeighbors)) {
    const stopWrite = startSampleWriteTimer("asset_lldp_neighbors");
    const endLldp = startPhase("systeminfo.persist.lldp");
    await persistLldpNeighbors(assetId, d.lldpNeighbors, now, d.lldpSource ?? "fortios");
    endLldp({ neighbors: d.lldpNeighbors.length });
    stopWrite();
  }
  // Hardware inventory. Same undefined/[] contract as LLDP: undefined means
  // the transport can't supply it (FortiOS REST, agent) and stored rows stay;
  // [] means the device was walked and has no FRUs to report, which wipes.
  if (Array.isArray(d.physicalEntities)) {
    const stopWrite = startSampleWriteTimer("asset_physical_entities");
    const endEnt = startPhase("systeminfo.persist.physical_entities");
    await persistPhysicalEntities(assetId, d.physicalEntities);
    endEnt({ entities: d.physicalEntities.length });
    stopWrite();
  }
  // Forwarding database. Same undefined/[] contract again.
  if (Array.isArray(d.macTable)) {
    const stopWrite = startSampleWriteTimer("asset_mac_table_entries");
    const endMac = startPhase("systeminfo.persist.mac_table");
    await persistMacTable(assetId, d.macTable);
    endMac({ entries: d.macTable.length });
    stopWrite();
  }
  // IP neighbour cache. NOT the undefined/[] contract the tables above use:
  // this one ACCUMULATES, so there is nothing to wipe and an empty array is
  // simply nothing to record. Matching is left to the discovery writer's warm
  // index -- resolving MACs here would mean a fleet-wide asset read on the
  // system-info hot path, and COALESCE in the upsert keeps a match already
  // resolved by discovery rather than clearing it.
  if (Array.isArray(d.arpNeighbors) && d.arpNeighbors.length > 0) {
    const stopWrite = startSampleWriteTimer("asset_arp_entries");
    const endArp = startPhase("systeminfo.persist.arp_neighbors");
    const { written } = await persistAssetArpNeighbors(assetId, d.arpNeighbors);
    endArp({ entries: written });
    stopWrite();
  }
  // Trunk membership. Same undefined/[] contract.
  if (Array.isArray(d.trunkMembers)) {
    const stopWrite = startSampleWriteTimer("asset_trunk_members");
    const endTrunk = startPhase("systeminfo.persist.trunk_members");
    await persistTrunkMembers(assetId, d.trunkMembers);
    endTrunk({ trunks: d.trunkMembers.length });
    stopWrite();
  }
  // Wireless stations (FortiAP only). Same undefined/[] semantics as LLDP —
  // undefined leaves rows alone, [] wipes them. Per-scrape full-replace
  // with NO 48h stickiness window: wireless clients are transient by
  // design and a missing station means the client roamed or disconnected.
  if (Array.isArray(d.wirelessStations)) {
    const stopWrite = startSampleWriteTimer("asset_wireless_stations");
    const endWireless = startPhase("systeminfo.persist.wireless");
    await persistWirelessStations(assetId, d.wirelessStations);
    endWireless({ stations: d.wirelessStations.length });
    stopWrite();
  }
  // Radio + broadcast-SSID inventory (FortiAP only), the two levels above
  // those stations. Same undefined/[] semantics again. The controller half
  // of this runs in discovery; persistApRadioInventory merges the two per
  // column, so whichever ran last does not erase what the other established.
  if (Array.isArray(d.apRadios)) {
    const stopWrite = startSampleWriteTimer("asset_ap_radios");
    const endRadios = startPhase("systeminfo.persist.ap_radios");
    const res = await persistApRadioInventory(assetId, d.apRadios, "snmp");
    endRadios({ radios: res.radios, vaps: res.vaps });
    stopWrite();
  }
  // MCLAG ICL peers (FortiSwitch only). Same undefined/[] semantics as LLDP:
  // undefined = not collected (switch not in CMDB / fetch failed) → leave rows
  // alone; an array (even empty) = full-replace this switch's ICL-peer rows.
  if (Array.isArray(d.mclagPeers)) {
    const stopWrite = startSampleWriteTimer("asset_mclag_peers");
    const endMclag = startPhase("systeminfo.persist.mclag_peers");
    await persistMclagPeers(assetId, d.mclagPeers);
    endMclag({ peers: d.mclagPeers.length });
    stopWrite();
  }

  await adoptDetectedModel(assetId, d.detectedModel, pinned);
  await adoptSysDescrIdentity(assetId, d, pinned);

  // Only bump lastSystemInfoAt when the scrape returned interfaces. The
  // /system-info GET endpoint anchors its interface query to this
  // timestamp, so bumping it on an empty interfaces[] silently empties the
  // System tab table — operators on REST API direct have seen FortiOS
  // return 200 OK with an empty results object (token without monitor
  // scope, VDOM weirdness, transient state) which used to slip past the
  // earlier "result.data is set" guard. Preserving the prior interface set
  // is strictly better than displaying nothing while the device is online.
  // The other streams (storage / ipsec / temperatures / lldp) read their
  // own latest-row timestamp and are written above unconditionally, so they
  // still refresh on every successful pull.
  //
  // An empty interface list is therefore a FAILED poll for the stream's own
  // accounting too (business rule 118): the attempt is stamped so the device
  // waits a cadence before the next walk, and the failure run says why.
  const endUpdate = startPhase("systeminfo.persist.update_asset");
  if (d.interfaces.length > 0) {
    await prisma.asset.update({
      where: { id: assetId },
      // This pass read sysDescr in its own multi-GET, so the identity read is
      // satisfied for another interval — folded into the update this path
      // already makes rather than costing a write of its own. It is what
      // keeps the response-time probe from carrying a redundant sysDescr
      // varbind for every asset that also has a heavy stream enabled.
      data: { ...systemInfoSuccessStamps(now), ...(d.sysDescr ? { lastDescrAt: now } : {}) },
    });
  } else {
    await recordStreamFailure("systemInfo", assetId, now, pollFailureText(result.error, "The device answered but returned no interfaces"));
  }
  endUpdate();
}

/**
 * Replace the asset's SD-WAN rule rows with the latest scrape. CURRENT-STATE,
 * not a time-series: SD-WAN rules carry no history (only the SLA-metrics stream
 * does). Mirrors the LLDP / wireless-station delete-replace pattern — wipe the
 * asset's rows and re-insert the fresh set in one atomic transaction so a
 * concurrent reader sees either the old set or the new set, never an empty
 * intermediate. `asset_sdwan_rules` is a PLAIN table (not a hypertable), so the
 * delete-replace is compression-safe.
 */
async function persistSdwanRules(
  assetId: string,
  rules: SdwanRuleSample[],
): Promise<void> {
  const data = rules.map((r) => ({
    id:               randomUUID(),
    assetId,
    ruleName:         r.ruleName,
    ruleId:           r.ruleId,
    seq:              r.seq,
    enabled:          r.enabled,
    mode:             r.mode,
    criteria:         r.criteria,
    healthChecks:     r.healthChecks,
    dst:              r.dst,
    status:           r.status,
    selectedMember:   r.selectedMember,
    availableMembers: r.availableMembers,
    priorityZones:    r.priorityZones,
  }));
  // Change detection (gated): capture prior selected-member per rule so we can
  // emit a failover event when it changes.
  const watchFailover = await isChangeActionSubscribed("change.sdwan.failover");
  const priorMembers = watchFailover
    ? new Map((await prisma.assetSdwanRule.findMany({ where: { assetId }, select: { ruleName: true, selectedMember: true } })).map((r) => [r.ruleName, r.selectedMember]))
    : null;

  await retryOnDeadlock(() =>
    prisma.$transaction([
      prisma.assetSdwanRule.deleteMany({ where: { assetId } }),
      ...(data.length > 0
        ? [prisma.assetSdwanRule.createMany({ data, skipDuplicates: true })]
        : []),
    ]),
  );

  if (priorMembers) {
    const failovers: ChangeItem[] = [];
    for (const r of rules) {
      if (priorMembers.has(r.ruleName)) {
        const before = priorMembers.get(r.ruleName) ?? null;
        if (before && r.selectedMember && before !== r.selectedMember) {
          failovers.push({ label: `${r.ruleName}: ${before} → ${r.selectedMember}`, details: { ruleName: r.ruleName, from: before, to: r.selectedMember } });
        }
      }
    }
    if (failovers.length) {
      const assetName = (await prisma.asset.findUnique({ where: { id: assetId }, select: { hostname: true } }))?.hostname ?? null;
      await maybeEmitChangeEvents("change.sdwan.failover", assetId, assetName, failovers);
    }
  }
}

/**
 * Replace the switch's MCLAG ICL-peer rows with the latest scrape. CURRENT-
 * STATE delete-replace, mirroring persistSdwanRules / persistLldpNeighbors:
 * wipe + re-insert in one atomic transaction so a reader sees either the old or
 * new set, never an empty intermediate. `asset_mclag_peers` is a PLAIN table
 * (not a hypertable). Each row's `peerSn` is resolved to the peer switch's
 * Asset id (`matchedAssetId`) via a single serial lookup so the topology
 * renderer can draw a clickable sibling edge; unresolved serials (peer not yet
 * discovered) leave matchedAssetId null and self-heal on a later scrape.
 */
async function persistMclagPeers(
  assetId: string,
  peers: FortiswitchMclagPeer[],
): Promise<void> {
  // Resolve peer serials → asset ids in one query. Serials are compared
  // case-insensitively (CMDB and stored serials are normally uppercase, but
  // don't assume). Usually 1-2 distinct serials, so the IN clause stays tiny.
  const serialToId = new Map<string, string>();
  const distinctSerials = [...new Set(peers.map((p) => p.peerSn))];
  if (distinctSerials.length > 0) {
    const matches = await prisma.asset.findMany({
      where: { serialNumber: { in: distinctSerials, mode: "insensitive" } },
      select: { id: true, serialNumber: true },
    });
    for (const m of matches) {
      if (m.serialNumber) serialToId.set(m.serialNumber.toUpperCase(), m.id);
    }
  }
  const data = peers.map((p) => ({
    id:             randomUUID(),
    assetId,
    localPort:      p.localPort,
    iclTrunk:       p.iclTrunk,
    peerSn:         p.peerSn,
    peerName:       p.peerName,
    peerPort:       p.peerPort,
    matchedAssetId: serialToId.get(p.peerSn.toUpperCase()) ?? null,
  }));
  // Change detection (gated): capture prior peer serials so we can emit a
  // peer-lost event when one disappears.
  const watchPeerLost = await isChangeActionSubscribed("change.mclag.peer_lost");
  const priorPeers = watchPeerLost
    ? await prisma.assetMclagPeer.findMany({ where: { assetId }, select: { peerSn: true, peerName: true, localPort: true } })
    : null;

  await retryOnDeadlock(() =>
    prisma.$transaction([
      prisma.assetMclagPeer.deleteMany({ where: { assetId } }),
      ...(data.length > 0
        ? [prisma.assetMclagPeer.createMany({ data, skipDuplicates: true })]
        : []),
    ]),
  );

  if (priorPeers) {
    const newSerials = new Set(peers.map((p) => p.peerSn.toUpperCase()));
    const lost: ChangeItem[] = priorPeers
      .filter((p) => !newSerials.has(p.peerSn.toUpperCase()))
      .map((p) => ({ label: `${p.peerName || p.peerSn} on ${p.localPort}`, details: { peerSn: p.peerSn, peerName: p.peerName, localPort: p.localPort } }));
    if (lost.length) {
      const assetName = (await prisma.asset.findUnique({ where: { id: assetId }, select: { hostname: true } }))?.hostname ?? null;
      await maybeEmitChangeEvents("change.mclag.peer_lost", assetId, assetName, lost);
    }
  }
}

/** One aggregated-by-name program row for the current-state process inventory. */
export interface AssetProcessInput {
  name:          string;
  instanceCount: number;
  cpuPct:        number | null;
  memRssBytes:   bigint | null;
  exePath:       string | null;
  username:      string | null;
  startedAt:     Date | null;
  serviceUnit:   string | null;
  controllable:  boolean;
}

/** The stored process columns a scrape can change. cpuPct / memRssBytes are
 *  compared through the dead band (sameInventoryRow); the rest exactly. */
const PROCESS_FIELDS = [
  "instanceCount", "cpuPct", "memRssBytes", "exePath", "username", "startedAt", "serviceUnit", "controllable",
] as const satisfies readonly (keyof AssetProcessInput)[];
const PROCESS_EXACT_FIELDS = PROCESS_FIELDS.filter((f) => f !== "cpuPct" && f !== "memRssBytes");

/**
 * Current-state process inventory for one asset, written as a DELTA
 * (utils/inventoryDelta) in one transaction: read the host's rows, create the
 * programs that appeared, delete the ones that vanished, update only the ones
 * that changed, and stamp the scrape time (AssetInventoryScrape). A reader sees
 * either the old set or the new set, never a mix. An empty `rows` is a valid
 * delete-only scrape. Same shape as serviceInventoryService.persistAssetServices;
 * CPU and memory are stored rounded and compared through a dead band.
 *
 * The delta IS the started/stopped change set, so change detection costs no
 * read of its own any more; only EMITTING is gated on a subscribed rule.
 */
export async function persistAssetProcesses(
  assetId: string,
  rows: AssetProcessInput[],
  now: Date = new Date(),
): Promise<{ created: number; updated: number; removed: number; unchanged: number }> {
  const incoming: AssetProcessInput[] = rows.map((r) => ({
    ...r,
    cpuPct: normalizeCpuPct(r.cpuPct),
    memRssBytes: normalizeBytes(r.memRssBytes),
  }));
  const pick = (r: AssetProcessInput) => ({
    instanceCount: r.instanceCount,
    cpuPct:        r.cpuPct,
    memRssBytes:   r.memRssBytes,
    exePath:       r.exePath,
    username:      r.username,
    startedAt:     r.startedAt,
    serviceUnit:   r.serviceUnit,
    controllable:  r.controllable,
  });
  const delta = await retryOnDeadlock(() =>
    prisma.$transaction(
      async (tx) => {
        const existing = await tx.assetProcess.findMany({
          where: { assetId },
          select: { id: true, name: true, ...Object.fromEntries(PROCESS_FIELDS.map((f) => [f, true])) },
        }) as unknown as Array<AssetProcessInput & { id: string }>;
        const d = diffInventory(existing, incoming, (r) => r.name, (e) => e.name,
          (e, n) => sameInventoryRow<AssetProcessInput>(e, n, PROCESS_EXACT_FIELDS, "cpuPct", "memRssBytes"));
        if (d.remove.length > 0) {
          await tx.assetProcess.deleteMany({ where: { id: { in: d.remove.map((e) => e.id) } } });
        }
        if (d.create.length > 0) {
          await tx.assetProcess.createMany({
            data: d.create.map((r) => ({ id: randomUUID(), assetId, name: r.name, ...pick(r) })),
            skipDuplicates: true,
          });
        }
        // updateMany: a concurrent push may have deleted the row since our read.
        for (const { existing: e, next } of d.update) {
          await tx.assetProcess.updateMany({ where: { id: e.id }, data: pick(next) });
        }
        await tx.assetInventoryScrape.upsert({
          where: { assetId_kind: { assetId, kind: "processes" } },
          create: { assetId, kind: "processes", scrapedAt: now },
          update: { scrapedAt: now },
        });
        return d;
      },
      // The first write after the upgrade re-rounds every stored figure once.
      { timeout: 30_000 },
    ),
  );

  const watchChanges =
    (await isChangeActionSubscribed("change.process.started")) ||
    (await isChangeActionSubscribed("change.process.stopped"));
  if (watchChanges) {
    const started: ChangeItem[] = delta.create.map((r) => ({ label: r.name, details: { name: r.name } }));
    const stopped: ChangeItem[] = delta.remove.map((e) => ({ label: e.name, details: { name: e.name } }));
    if (started.length || stopped.length) {
      const assetName = (await prisma.asset.findUnique({ where: { id: assetId }, select: { hostname: true } }))?.hostname ?? null;
      await maybeEmitChangeEvents("change.process.started", assetId, assetName, started);
      await maybeEmitChangeEvents("change.process.stopped", assetId, assetName, stopped);
    }
  }
  return { created: delta.create.length, updated: delta.update.length, removed: delta.remove.length, unchanged: delta.unchanged };
}

// ─── Application Map: process connection persistence ─────────────────────────

type ProcessConnectionKind = "listen" | "outbound" | "inbound";

export interface ProcessConnectionInput {
  /** AssetProcess.name key — same program-name space as the pin arrays. */
  processName: string;
  kind:  ProcessConnectionKind;
  proto: "tcp" | "udp";
  localAddr?:  string | null;
  localPort?:  number | null;
  remoteIp?:   string | null;
  remotePort?: number | null;
  /** Owning systemd unit / Windows service (Phase 3). Attribute-only — NOT in
   *  the business key; set on insert, never bumped on conflict. */
  unit?: string | null;
}

// Per-(processName, kind) row caps. Also enforced on-agent and in the agentless
// parsers before transmit — this copy is the defensive last line against
// old/hand-rolled agents pushing unbounded sets.
const PROCESS_CONN_CAPS: Record<ProcessConnectionKind, number> = {
  listen:   200,
  outbound: 500,
  inbound:  200,
};
// 12 params/row; 2000 rows/statement stays well under the 65535 param ceiling.
const PROCESS_CONN_CHUNK = 2000;
// lastSeen churn gate: a row seen every 60s only takes a real tuple update once
// per window — ~5× less dead-tuple churn, and with lastSeen unindexed those
// updates stay HOT. Reads can see lastSeen up to this much stale, irrelevant
// against the 30-day retention window.
const PROCESS_CONN_BUMP_MINUTES = 5;

function processConnSentinels(r: ProcessConnectionInput): {
  localAddr: string; localPort: number; remoteIp: string; remotePort: number;
} {
  return {
    localAddr:  r.localAddr ?? "",
    localPort:  Number.isInteger(r.localPort)  && (r.localPort  as number) >= 0 ? (r.localPort  as number) : 0,
    remoteIp:   r.remoteIp ?? "",
    remotePort: Number.isInteger(r.remotePort) && (r.remotePort as number) >= 0 ? (r.remotePort as number) : 0,
  };
}

/**
 * ACCUMULATE + AGE upsert of connection facts for one asset's MAPPED processes.
 * NOT delete-replace: each row is keyed on the business tuple; a re-observed
 * row bumps lastSeen (behind the churn gate) and keeps firstSeen, an absent row
 * is left alone to age out via pruneProcessConnections. An empty `rows` push is
 * therefore a no-op by design — short-lived connections must not flicker off
 * the Application Map between scrapes.
 *
 * Caller contract: `rows` should already be filtered to the asset's
 * mappedProcesses (the agent ingest arm and the agentless collectors both do);
 * this function only normalizes, dedups, and caps.
 */
export async function persistProcessConnections(
  assetId: string,
  rows: ProcessConnectionInput[],
): Promise<void> {
  if (rows.length === 0) return;

  interface NormalizedConnRow {
    processName: string; kind: ProcessConnectionKind; proto: "tcp" | "udp";
    localAddr: string; localPort: number; remoteIp: string; remotePort: number;
    unit: string;
  }
  // Normalize + validate + dedup by business key. Two identical tuples inside
  // one INSERT ... ON CONFLICT raise "cannot affect row a second time", so the
  // JS-side dedup is mandatory, not an optimization.
  const byKey = new Map<string, NormalizedConnRow>();
  for (const r of rows) {
    const kind  = String(r.kind).toLowerCase()  as ProcessConnectionKind;
    const proto = String(r.proto).toLowerCase() as "tcp" | "udp";
    if (kind !== "listen" && kind !== "outbound" && kind !== "inbound") continue;
    if (proto !== "tcp" && proto !== "udp") continue;
    const name = (r.processName ?? "").trim();
    if (!name) continue;
    const s = processConnSentinels(r);
    if (s.localPort > 65535 || s.remotePort > 65535) continue;
    const key = JSON.stringify([name, kind, proto, s.localAddr, s.localPort, s.remoteIp, s.remotePort]);
    // unit is attribute-only (not in the key) — first occurrence wins, matching
    // the agent's dedup + the insert-only ON CONFLICT below.
    if (!byKey.has(key)) byKey.set(key, { processName: name, kind, proto, ...s, unit: (r.unit ?? "").trim() });
  }

  // Per-(processName, kind) caps, deterministic order so truncation is stable
  // across scrapes (a capped set shouldn't churn membership between pushes).
  const grouped = new Map<string, { kind: ProcessConnectionKind; list: NormalizedConnRow[] }>();
  for (const row of byKey.values()) {
    // kind is a fixed token, so "kind:name" can't collide across groups.
    const gk = `${row.kind}:${row.processName}`;
    let g = grouped.get(gk);
    if (!g) { g = { kind: row.kind, list: [] }; grouped.set(gk, g); }
    g.list.push(row);
  }
  const capped: NormalizedConnRow[] = [];
  for (const g of grouped.values()) {
    g.list.sort((a, b) =>
      a.proto.localeCompare(b.proto) ||
      a.remoteIp.localeCompare(b.remoteIp) ||
      (a.remotePort - b.remotePort) ||
      a.localAddr.localeCompare(b.localAddr) ||
      (a.localPort - b.localPort));
    capped.push(...g.list.slice(0, PROCESS_CONN_CAPS[g.kind]));
  }
  if (capped.length === 0) return;

  const nowIso = new Date().toISOString();
  for (const chunk of chunkArray(capped, PROCESS_CONN_CHUNK)) {
    const params: unknown[] = [];
    const tuples: string[] = [];
    let p = 1;
    for (const r of chunk) {
      tuples.push(`($${p++}::uuid, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::int, $${p++}, $${p++}::int, $${p++}, $${p++}::timestamp, $${p++}::timestamp)`);
      params.push(
        randomUUID(), assetId, r.processName, r.kind, r.proto,
        r.localAddr, r.localPort, r.remoteIp, r.remotePort, r.unit,
        nowIso, nowIso,
      );
    }
    const sql =
      `INSERT INTO "asset_process_connections" (` +
      `"id", "assetId", "processName", "kind", "proto", ` +
      `"localAddr", "localPort", "remoteIp", "remotePort", "unit", "firstSeen", "lastSeen"` +
      `) VALUES ${tuples.join(", ")} ` +
      `ON CONFLICT ("assetId", "processName", "kind", "proto", "localAddr", "localPort", "remoteIp", "remotePort") ` +
      // unit is BACKFILL-ONLY: an empty stored unit adopts the incoming one, a
      // non-empty one is never overwritten. Backfill matters because unit is not
      // in the business key — a tuple first inserted before its unit was mapped
      // (program mapped as a process first, row predating the unit column, or an
      // agentless push that can't resolve units) would otherwise keep unit=''
      // forever, and applicationMapService.ownerNodeIds needs a non-empty unit to
      // attribute the row to its mapped service. Never overwriting keeps Windows
      // svchost first-service flapping and the agentless-vs-agent insert race from
      // churning the column.
      `DO UPDATE SET ` +
        `"lastSeen" = GREATEST("asset_process_connections"."lastSeen", EXCLUDED."lastSeen"), ` +
        `"unit" = CASE WHEN "asset_process_connections"."unit" = '' ` +
                     `THEN EXCLUDED."unit" ELSE "asset_process_connections"."unit" END ` +
      // The OR arm is what lets a backfill land INSIDE the churn gate. It can only
      // fire once per row (afterwards unit <> ''), so the dead-tuple budget the
      // gate protects is unaffected.
      `WHERE "asset_process_connections"."lastSeen" < EXCLUDED."lastSeen" - interval '${PROCESS_CONN_BUMP_MINUTES} minutes' ` +
        `OR ("asset_process_connections"."unit" = '' AND EXCLUDED."unit" <> '')`;
    await retryOnDeadlock(() => prisma.$executeRawUnsafe(sql, ...params));
  }
}

/**
 * Replace the asset's LLDP neighbor rows with the latest scrape. Idempotent:
 * existing rows that match (assetId, localIfName, chassisId, portId) are
 * upserted in place so `firstSeen` survives across scrapes; rows in the table
 * that aren't in this scrape are deleted.
 *
 * `matchedAssetId` is resolved here by joining each neighbor against the asset
 * inventory by management IP, chassis MAC, and system name. The Device Map
 * topology endpoint reads this back to draw real edges to non-Fortinet gear
 * (LLDP catches what fortinetTopology can't see).
 */
// LLDP stickiness window — one contract, two readers: persistLldpNeighbors
// keeps a vanished neighbor row this long before deleting it, and
// persistManagedApLldpNeighbors treats another writer's row younger than
// this as "fresh" when deciding ownership. They must agree.
const LLDP_STICKY_WINDOW_MS = 48 * 60 * 60 * 1000;

async function persistLldpNeighbors(
  assetId: string,
  neighbors: LldpNeighborSample[],
  now: Date,
  defaultSource: "fortios" | "snmp" | string,
): Promise<void> {
  // `localIfName` is a JOIN KEY, not a caption: the System tab's Neighbor
  // column, the alert email's LLDP block and auto-monitor's By-LLDP rule all
  // look up interfaces by it. LLDP-MIB hands us whatever `lldpLocPortId` /
  // `lldpLocPortDesc` say, which on a FortiSwitch is the operator's port
  // DESCRIPTION — so rows arrived keyed "MORGAN-221E-1" and "Tim Smith"
  // instead of port9 and port12, duplicating the same neighbour under two
  // names and teaching By-LLDP to pin a port that doesn't exist (prod
  // 2026-08-25). Map every label back onto the port that carries it.
  const identity = await loadInterfaceIdentity(assetId);
  let lldpRelabeled = 0;
  if (identity.labelToName.size > 0 && neighbors.length > 0) {
    const deduped: LldpNeighborSample[] = [];
    const byKey = new Set<string>();
    for (const n of neighbors) {
      const canon = canonicalInterfaceName(n.localIfName, identity);
      const row = canon && canon !== n.localIfName ? { ...n, localIfName: canon } : n;
      if (canon && canon !== n.localIfName) lldpRelabeled++;
      // Renaming can collide with the same neighbour already reported under
      // the real port name — the bulk upsert targets the business key, so a
      // duplicate would be two INSERTs for one row.
      const k = `${row.localIfName}${row.chassisId ?? ""}${row.portId ?? ""}`;
      if (byKey.has(k)) continue;
      byKey.add(k);
      deduped.push(row);
    }
    if (lldpRelabeled > 0) {
      logger.warn(
        { assetId, relabeled: lldpRelabeled, collapsed: neighbors.length - deduped.length },
        "LLDP local port labels were port descriptions — keyed to the ports they describe",
      );
    }
    neighbors = deduped;
  }
  const endMatch = startPhase("systeminfo.persist.lldp_match_index");
  const matchIndex = await getLldpAssetMatchIndex();
  endMatch();
  const matchedFor = (n: LldpNeighborSample): string | null => {
    if (n.managementIp) {
      const m = matchIndex.byIp.get(n.managementIp);
      if (m && m !== assetId) return m;
    }
    if (n.chassisIdSubtype === "macAddress" && n.chassisId) {
      const mac = n.chassisId.toUpperCase();
      const m = matchIndex.byMac.get(mac);
      if (m && m !== assetId) return m;
    }
    // Workstation LLDP agents (Windows native, FortiClient, etc.) commonly
    // put the Ethernet MAC in portId(macAddress) rather than chassisId, so
    // the MAC arm above misses them. Try portId against the MAC index too.
    if (n.portIdSubtype === "macAddress" && n.portId) {
      const mac = n.portId.toUpperCase();
      const m = matchIndex.byMac.get(mac);
      if (m && m !== assetId) return m;
    }
    // Hostname arms (business rule 91): a name several assets share — the
    // per-site switch-id of a FortiLink fleet — is matched only to the
    // candidate under the same gate as this asset, else to nothing. The
    // belt-and-suspenders FQDN → leftmost-label retry is kept: the index
    // builder already adds short forms when it sees FQDNs, but both
    // directions are defended.
    const byName = (lower: string): string | null => {
      let m = pickLldpHostnameMatch(matchIndex, assetId, lower);
      if (!m && lower.includes(".")) m = pickLldpHostnameMatch(matchIndex, assetId, lower.split(".")[0]);
      return m;
    };
    if (n.systemName) {
      const m = byName(n.systemName.toLowerCase());
      if (m) return m;
    }
    // Some LLDP implementations leave systemName empty and put the hostname
    // in chassisId with subtype local(7) or chassisComponent(1). Treat any
    // non-MAC chassisId as a possible hostname when it looks printable.
    if (n.chassisId && n.chassisIdSubtype !== "macAddress") {
      const raw = String(n.chassisId).trim();
      // Skip values that look like MACs or contain whitespace — those won't
      // match a hostname index entry anyway, and we don't want to pollute
      // logs with bogus lookups.
      if (raw && !/\s/.test(raw) && !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(raw)) {
        const m = byName(raw.toLowerCase());
        if (m) return m;
      }
    }
    return null;
  };

  // Existing rows for diffing. Keyed the same way the unique index is —
  // (localIfName, chassisId ?? "", portId ?? "") to handle Postgres-distinct nulls.
  const endFind = startPhase("systeminfo.persist.lldp_find_existing");
  const existing = await prisma.assetLldpNeighbor.findMany({ where: { assetId } });
  endFind({ rows: existing.length });
  const seen = new Set<string>();
  const keyOf = (li: string, ci: string | null | undefined, pi: string | null | undefined) =>
    `${li}\u0001${ci ?? ""}\u0001${pi ?? ""}`;
  const existingByKey = new Map<string, typeof existing[number]>();
  for (const e of existing) existingByKey.set(keyOf(e.localIfName, e.chassisId, e.portId), e);

  // Build a unified upsert list. Existing rows reuse their prior id (so the
  // ON CONFLICT (id) DO UPDATE branch fires and firstSeen survives); new rows
  // get a fresh randomUUID() so they don't collide and take the INSERT branch.
  // Both flow through one bulk statement — see bulkUpsertLldpNeighbors below
  // for why we target the PK instead of the (assetId, localIfName, chassisId,
  // portId) business key.
  const toUpsert: LldpUpsertRow[] = [];

  for (const n of neighbors) {
    const k = keyOf(n.localIfName, n.chassisId ?? null, n.portId ?? null);
    seen.add(k);
    const matched = matchedFor(n);
    const prior = existingByKey.get(k);
    toUpsert.push({
      id: prior?.id ?? randomUUID(),
      data: {
        localIfName:       n.localIfName,
        chassisIdSubtype:  n.chassisIdSubtype ?? null,
        chassisId:         n.chassisId ?? null,
        portIdSubtype:     n.portIdSubtype ?? null,
        portId:            n.portId ?? null,
        portDescription:   n.portDescription ?? null,
        systemName:        n.systemName ?? null,
        systemDescription: n.systemDescription ?? null,
        managementIp:      n.managementIp ?? null,
        capabilities:      n.capabilities ?? [],
        matchedAssetId:    matched,
        source:            defaultSource,
      },
    });
  }

  // Stickiness rule for stale rows. LLDP advertisements get missed
  // intermittently — a packet drops, a switch reboots, a peer briefly
  // unplugs — and a hard "delete on every scrape that doesn't see them"
  // rule made the operator-visible Neighbor column flap empty for those
  // gaps. Instead, keep the prior row for a 48-hour grace period UNLESS
  // a fresh scrape just learned a DIFFERENT neighbor on the same local
  // port (in which case the new value supersedes immediately — that's
  // a real topology change, not a missed advertisement).
  const STALE_AFTER_MS = LLDP_STICKY_WINDOW_MS;
  const portsWithFreshNeighbor = new Set<string>();
  for (const n of neighbors) portsWithFreshNeighbor.add(n.localIfName);
  const toDelete: string[] = [];
  for (const e of existing) {
    const k = keyOf(e.localIfName, e.chassisId, e.portId);
    if (seen.has(k)) continue; // refreshed by this scrape — keep
    // Same port saw a different neighbor → real change, drop the old.
    if (portsWithFreshNeighbor.has(e.localIfName)) {
      toDelete.push(e.id);
      continue;
    }
    // A row keyed by a port DESCRIPTION is the same port under a label (see
    // the canonicalization at the top) — it is a duplicate by construction,
    // not a missed advertisement, so the 48h grace period doesn't apply to
    // it. Without this, every mislabeled row lingers for two days and keeps
    // answering interface lookups under the wrong name.
    const canon = canonicalInterfaceName(e.localIfName, identity);
    if (canon && canon !== e.localIfName) {
      toDelete.push(e.id);
      continue;
    }
    // No fresh neighbor on this port; honor the 48h grace period before
    // declaring the row stale.
    const ageMs = now.getTime() - new Date(e.lastSeen).getTime();
    if (ageMs > STALE_AFTER_MS) {
      toDelete.push(e.id);
    }
  }
  // Single bulk upsert covers both creates and in-place updates — one SQL
  // round-trip instead of the legacy createMany + $transaction([per-row
  // updates]) pair (which held a connection for the duration of N pipelined
  // updates inside a BEGIN/COMMIT). On a switch with 40 LLDP neighbors that
  // collapses ~42 statements into 1.
  if (toUpsert.length > 0) {
    const endUpsert = startPhase("systeminfo.persist.lldp_upsert");
    await bulkUpsertLldpNeighbors(assetId, toUpsert, now);
    endUpsert({ rows: toUpsert.length });
  }
  if (toDelete.length > 0) {
    const endDelete = startPhase("systeminfo.persist.lldp_deleteMany");
    await retryOnDeadlock(() =>
      prisma.assetLldpNeighbor.deleteMany({ where: { id: { in: toDelete } } }),
    );
    endDelete({ rows: toDelete.length });
  }

  // Change detection → notification engine (gated; no-op when unsubscribed).
  // Added = neighbor keys not previously present; removed = rows just deleted.
  const added: ChangeItem[] = [];
  for (const n of neighbors) {
    if (!existingByKey.has(keyOf(n.localIfName, n.chassisId ?? null, n.portId ?? null))) {
      added.push({ label: `${n.systemName || n.chassisId || "neighbor"} on ${n.localIfName}`, details: { localIfName: n.localIfName, systemName: n.systemName, chassisId: n.chassisId } });
    }
  }
  const removed: ChangeItem[] = [];
  const deleteSet = new Set(toDelete);
  for (const e of existing) {
    if (deleteSet.has(e.id)) {
      removed.push({ label: `${e.systemName || e.chassisId || "neighbor"} on ${e.localIfName}`, details: { localIfName: e.localIfName, systemName: e.systemName, chassisId: e.chassisId } });
    }
  }
  if (added.length || removed.length) {
    const assetName = (await prisma.asset.findUnique({ where: { id: assetId }, select: { hostname: true } }))?.hostname ?? null;
    await maybeEmitChangeEvents("change.lldp.neighbor_added", assetId, assetName, added);
    await maybeEmitChangeEvents("change.lldp.neighbor_removed", assetId, assetName, removed);
  }
}

/**
 * Persist the LLDP neighbor table a managed FortiAP reported through its
 * parent FortiGate's /api/v2/monitor/wifi/managed_ap response (parsed by
 * utils/fortiapLldp.parseApLldpNeighbors, carried on
 * DiscoveredFortiAP.lldpNeighbors). Called from the FMG/FortiGate discovery
 * sync layer per online AP — this is how APs get REAL AssetLldpNeighbor rows
 * (source "managed-ap"), since the agentless LLDP streams can't reach them:
 * rest_api targets the asset's own IP with a FortiOS endpoint APs don't
 * serve, and SNMP LLDP-MIB on the AP itself is usually disabled.
 *
 * Ownership guard: skips (returns "skipped") when the asset is monitored,
 * its resolved lldpPolling is "snmp", AND that stream is actually delivering
 * — i.e. rows from another writer (source != "managed-ap") were refreshed
 * within the 48h stickiness window. A live SNMP LLDP stream owns the table
 * (two full-replace writers would alternate row sets), but a configured-yet-
 * dead one must not: FortiAPs usually don't expose LLDP-MIB, so an AP class
 * whose lldpPolling resolves to snmp (e.g. inherited from the interfaces
 * transport at some tier) would otherwise defer forever to a stream that
 * never writes, leaving the table empty. rest_api is deliberately NOT
 * treated as an owner either (it can never succeed against an AP).
 *
 * Local port names are normalized against the AP's most recent interface
 * samples (lan1 ↔ eth0, see utils/fortiapInterfaceAlias.ts) so rows line up
 * with the System-tab interface table and dedupe against the peer-inferred
 * synthesizer, which normalizes the same way.
 */
export async function persistManagedApLldpNeighbors(
  assetId: string,
  neighbors: ApLldpNeighborSample[],
  now: Date,
): Promise<"persisted" | "skipped"> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    omit: PROBE_ASSET_OMIT,
    include: { discoveredByIntegration: { select: { type: true } } },
  });
  if (!asset) return "skipped";
  if (asset.monitored) {
    const effective = await resolveMonitorSettings({
      ...asset,
      discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
    });
    if (effective.lldpPolling === "snmp") {
      const otherWriterFresh = await prisma.assetLldpNeighbor.findFirst({
        where: {
          assetId,
          source: { not: "managed-ap" },
          lastSeen: { gte: new Date(now.getTime() - LLDP_STICKY_WINDOW_MS) },
        },
        select: { id: true },
      });
      if (otherWriterFresh) return "skipped";
    }
  }
  // The AP's own interface names, from the CURRENT-STATE inventory. This needs
  // the FULL set (an unpinned eth0 is exactly the case being normalized), which
  // is why it can't read the pinned-only sample table. Also replaces a
  // timestamp-ordered `take: 64` scan with a scoped indexed read.
  const ifRows = await prisma.assetInterface.findMany({
    where: { assetId },
    select: { ifName: true },
  });
  const knownIfNames = new Set(ifRows.map((r) => r.ifName));
  const normalized: LldpNeighborSample[] = neighbors.map((n) => ({
    ...n,
    localIfName: normalizeFortiapInterfaceName(n.localIfName, knownIfNames),
  }));
  // Drop rows sitting on an ALIAS of a fresh row's port (lan1 vs eth0 name
  // the same NIC). The normalization outcome can flip between runs — a new
  // AP persists as "lan1" before its first SNMP interface samples exist,
  // then "eth0" after — and the stickiness grace in persistLldpNeighbors
  // would otherwise keep the old-named rows as duplicates for 48 hours.
  // Safe because this writer owns the AP's table (see the snmp guard above).
  const aliasPorts = new Set<string>();
  for (const n of normalized) {
    for (const a of fortiapInterfaceAliases(n.localIfName)) {
      if (a !== n.localIfName) aliasPorts.add(a);
    }
  }
  if (aliasPorts.size > 0) {
    await prisma.assetLldpNeighbor.deleteMany({
      where: { assetId, localIfName: { in: [...aliasPorts] } },
    });
  }
  await persistLldpNeighbors(assetId, normalized, now, "managed-ap");
  return "persisted";
}

type LldpUpsertRow = {
  id: string;
  data: {
    localIfName: string;
    chassisIdSubtype: string | null;
    chassisId: string | null;
    portIdSubtype: string | null;
    portId: string | null;
    portDescription: string | null;
    systemName: string | null;
    systemDescription: string | null;
    managementIp: string | null;
    capabilities: readonly string[];
    matchedAssetId: string | null;
    source: string;
  };
};

/**
 * Single-statement bulk upsert into asset_lldp_neighbors. Conflict target
 * is the primary key (id), NOT the (assetId, localIfName, chassisId, portId)
 * business-key unique constraint — Postgres treats NULL as distinct in
 * unique indexes, so a row with chassisId IS NULL would never match an
 * ON CONFLICT on the business key. The caller (persistLldpNeighbors) pre-
 * assigns ids by looking up prior rows in JS, so we know which inserts
 * should land as updates.
 *
 * `capabilities` (text[]) is encoded as an explicit ARRAY[$N,$N,$N]::text[]
 * expression per row rather than passing the JS array as a single bound
 * parameter — pg adapter behavior with array-typed parameters via
 * $executeRawUnsafe is undocumented in this codebase, so we stay on the
 * unambiguous path. For typical LLDP rows with 1-4 capability tokens this
 * adds a handful of extra parameter slots per row, well inside the 65535
 * parameter ceiling even for switches with hundreds of neighbors.
 */
async function bulkUpsertLldpNeighbors(
  assetId: string,
  rows: readonly LldpUpsertRow[],
  now: Date,
): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const tuples: string[] = [];
  let p = 1;
  const nowIso = now.toISOString();
  for (const r of rows) {
    const d = r.data;
    const capPlaceholders: string[] = [];
    for (const cap of d.capabilities) {
      params.push(cap);
      capPlaceholders.push(`$${p++}`);
    }
    const capExpr =
      capPlaceholders.length > 0
        ? `ARRAY[${capPlaceholders.join(",")}]::text[]`
        : `ARRAY[]::text[]`;
    const tupleParts = [
      `$${p++}::uuid`,            // id
      `$${p++}`,                  // assetId
      `$${p++}`,                  // localIfName
      `$${p++}`,                  // chassisIdSubtype
      `$${p++}`,                  // chassisId
      `$${p++}`,                  // portIdSubtype
      `$${p++}`,                  // portId
      `$${p++}`,                  // portDescription
      `$${p++}`,                  // systemName
      `$${p++}`,                  // systemDescription
      `$${p++}`,                  // managementIp
      capExpr,                    // capabilities
      `$${p++}`,                  // matchedAssetId
      `$${p++}`,                  // source
      `$${p++}::timestamp`,       // firstSeen
      `$${p++}::timestamp`,       // lastSeen
    ];
    tuples.push(`(${tupleParts.join(", ")})`);
    params.push(
      r.id,
      assetId,
      d.localIfName,
      d.chassisIdSubtype,
      d.chassisId,
      d.portIdSubtype,
      d.portId,
      d.portDescription,
      d.systemName,
      d.systemDescription,
      d.managementIp,
      d.matchedAssetId,
      d.source,
      nowIso,
      nowIso,
    );
  }
  const sql =
    `INSERT INTO "asset_lldp_neighbors" (` +
    `"id", "assetId", "localIfName", ` +
    `"chassisIdSubtype", "chassisId", "portIdSubtype", "portId", ` +
    `"portDescription", "systemName", "systemDescription", "managementIp", ` +
    `"capabilities", "matchedAssetId", "source", "firstSeen", "lastSeen"` +
    `) VALUES ${tuples.join(", ")} ` +
    `ON CONFLICT ("id") DO UPDATE SET ` +
    `"chassisIdSubtype"  = EXCLUDED."chassisIdSubtype", ` +
    `"chassisId"         = EXCLUDED."chassisId", ` +
    `"portIdSubtype"     = EXCLUDED."portIdSubtype", ` +
    `"portId"            = EXCLUDED."portId", ` +
    `"portDescription"   = EXCLUDED."portDescription", ` +
    `"systemName"        = EXCLUDED."systemName", ` +
    `"systemDescription" = EXCLUDED."systemDescription", ` +
    `"managementIp"      = EXCLUDED."managementIp", ` +
    `"capabilities"      = EXCLUDED."capabilities", ` +
    `"matchedAssetId"    = EXCLUDED."matchedAssetId", ` +
    `"source"            = EXCLUDED."source", ` +
    `"lastSeen"          = EXCLUDED."lastSeen"`;
  await retryOnDeadlock(() => prisma.$executeRawUnsafe(sql, ...params));
}

/**
 * Persist a fapStationTable scrape into `AssetWirelessStation`. Full-replace
 * semantics per (apAssetId, staMacAddr): every row that's in the fresh
 * scrape is upserted (timestamps + ssid/signal/etc bumped), every stored
 * row absent from the fresh scrape is deleted. **No 48h stickiness** —
 * wireless clients are transient by design; a station that roamed or
 * disconnected should drop from the table immediately.
 *
 * `matchedAssetId` is resolved by MAC lookup against the endpoint
 * inventory using the same cached index LLDP uses. When a match lands,
 * the endpoint's `Asset.lastSeenAp` is bumped to the AP's hostname so the
 * endpoint's asset details page shows which AP last saw it.
 */
async function persistWirelessStations(
  apAssetId: string,
  stations: WirelessStationSample[],
): Promise<void> {
  // Reuse the LLDP match index — same lookup shape (MAC → assetId) and the
  // 60 s TTL already covers the system-info cadence. Wireless rows only
  // match by MAC (the index also carries IP / hostname maps but those are
  // not relevant here — a station's MAC is the only stable identity in
  // the AP's view).
  const matchIndex = await getLldpAssetMatchIndex();

  // Look up the AP's hostname once so we can stamp every matched endpoint's
  // lastSeenAp without re-fetching per-station.
  const apRow = await prisma.asset.findUnique({
    where: { id: apAssetId },
    select: { hostname: true },
  });
  const apHostname = apRow?.hostname ?? null;

  // Existing rows for diffing. Keyed by MAC (the unique constraint half
  // that varies — apAssetId is fixed for this call).
  const existing = await prisma.assetWirelessStation.findMany({ where: { apAssetId } });
  const existingByMac = new Map<string, typeof existing[number]>();
  for (const e of existing) existingByMac.set(e.staMacAddr, e);

  const seen = new Set<string>();
  const toUpsert: WirelessUpsertRow[] = [];
  // Endpoint-side `lastSeenAp` stamps. One per matched station; deduplicated
  // by endpoint id so a single AP with N rooms-worth of clients still hits
  // each endpoint's row once.
  const endpointStamps = new Map<string, string>(); // assetId → apHostname

  for (const s of stations) {
    const mac = s.staMacAddr.toUpperCase();
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) continue; // malformed; skip
    seen.add(mac);
    const matchedAssetId = matchIndex.byMac.get(mac) ?? null;
    if (matchedAssetId && matchedAssetId !== apAssetId && apHostname) {
      endpointStamps.set(matchedAssetId, apHostname);
    }
    const ex = existingByMac.get(mac);
    toUpsert.push({
      id: ex?.id ?? randomUUID(),
      data: {
        staMacAddr:     mac,
        staIpAddr:      s.staIpAddr ?? null,
        ssid:           s.ssid ?? null,
        radioId:        s.radioId ?? null,
        wlanId:         s.wlanId ?? null,
        band:           s.band ?? null,
        vlanId:         s.vlanId ?? null,
        bssid:          s.bssid ?? null,
        signalStrength: s.signalStrength ?? null,
        noise:          s.noise ?? null,
        bandwidthTx:    s.bandwidthTx ?? null,
        bandwidthRx:    s.bandwidthRx ?? null,
        idleSeconds:    s.idleSeconds ?? null,
        matchedAssetId,
        // Station identity comes from SNMP fapStationTable; signal/noise are an
        // optional FortiOS-REST overlay from the controller (wifi/client).
        source:         (s.signalStrength != null || s.noise != null) ? "snmp+rest" : "snmp",
      },
    });
  }

  // Anything stored but not in the fresh scrape → drop. Same semantics as
  // associatedIp's monitor-source rows: per-scrape full-replace, no grace
  // period.
  const toDelete: string[] = [];
  for (const e of existing) {
    if (!seen.has(e.staMacAddr)) toDelete.push(e.id);
  }

  if (toUpsert.length > 0) {
    await bulkUpsertWirelessStations(apAssetId, toUpsert, new Date());
  }
  if (toDelete.length > 0) {
    await retryOnDeadlock(() =>
      prisma.assetWirelessStation.deleteMany({ where: { id: { in: toDelete } } }),
    );
  }

  // Stamp each matched endpoint's lastSeenAp. Don't block the persist on
  // these — they're operator-visible breadcrumbs, not load-bearing data —
  // but await so the System tab sees the change on the next refresh.
  //
  // Deterministic lock ordering: sort the updates by asset id so EVERY
  // concurrent endpoint-stamp transaction acquires its `assets` row locks in
  // the same order. The PG deadlock log showed a 3-way cycle where all three
  // participants were exactly this lastSeenAp UPDATE — two/three APs whose
  // stations match an overlapping endpoint set were locking those rows in
  // different (Map-insertion) order. Sorting by id makes the cycle
  // impossible. `$transaction([...])` executes the array sequentially, so the
  // sort order IS the lock-acquisition order.
  //
  // retryOnDeadlock stays as a backstop for any residual collision (e.g. this
  // txn vs the probe-patch bulk Asset UPDATE, which locks in its own order).
  // The op is idempotent (last-write-wins stamp) so re-run is safe.
  if (endpointStamps.size > 0) {
    // Read the endpoints' current AP first, then write only the ones that
    // actually moved. Two payoffs: a steady set of stations stops issuing an
    // UPDATE per scrape (less write volume + less lock contention on exactly
    // the rows the deadlock note above is about), and the prior value is what
    // makes the roam event below reportable.
    const prior = await prisma.asset.findMany({
      where: { id: { in: [...endpointStamps.keys()] } },
      select: { id: true, lastSeenAp: true, hostname: true, ipAddress: true },
    });
    const priorById = new Map(prior.map((r) => [r.id, r]));
    const orderedStamps = [...endpointStamps.entries()]
      // Filtering preserves the sort below it — the id ordering is the
      // deadlock fix and must survive any change to this block.
      .filter(([endpointId, ap]) => {
        const p = priorById.get(endpointId);
        if (!p) return false; // asset vanished between match and stamp
        return (p.lastSeenAp ?? "").trim().toLowerCase() !== ap.trim().toLowerCase();
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (orderedStamps.length > 0) {
      await retryOnDeadlock(() =>
        prisma.$transaction(
          orderedStamps.map(([endpointId, ap]) =>
            prisma.asset.update({ where: { id: endpointId }, data: { lastSeenAp: ap } }),
          ),
        ),
      );
      // Roam audit — AFTER the transaction commits, never inside it (an event
      // write must not extend the lock window these rows are contended on).
      // Written only while an automation uses the roam trigger: unconditional,
      // every client's every roam flooded the Events log (2026-11-09).
      const roamEvents = !(await wirelessRoamEventsWanted()) ? [] : orderedStamps.flatMap(([endpointId, ap]) => {
        const p = priorById.get(endpointId)!;
        const ev = buildConnectionChangedEvent(
          "ap",
          {
            assetId: endpointId,
            assetName: p.hostname || p.ipAddress || null,
            actor: "system:monitor",
            source: "wireless-scrape",
          },
          p.lastSeenAp,
          ap,
        );
        return ev ? [ev] : [];
      });
      if (roamEvents.length > 0) void logEventsBatch(roamEvents);
    }
  }
}

type WirelessUpsertRow = {
  id: string;
  data: {
    staMacAddr: string;
    staIpAddr: string | null;
    ssid: string | null;
    radioId: number | null;
    wlanId: number | null;
    band: string | null;
    vlanId: number | null;
    bssid: string | null;
    signalStrength: number | null;
    noise: number | null;
    bandwidthTx: number | null;
    bandwidthRx: number | null;
    idleSeconds: number | null;
    matchedAssetId: string | null;
    source: string;
  };
};

/**
 * Single-statement bulk upsert into asset_wireless_stations. Same shape as
 * `bulkUpsertLldpNeighbors` — conflict target is the PK so callers control
 * insert-vs-update by pre-assigning ids. Replaces the legacy createMany +
 * $transaction([per-row updates]) pair (which held a connection across N
 * pipelined updates inside BEGIN/COMMIT). No text[] field to worry about,
 * so the per-row tuple is a straight parameter list.
 */
async function bulkUpsertWirelessStations(
  apAssetId: string,
  rows: readonly WirelessUpsertRow[],
  now: Date,
): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const tuples: string[] = [];
  let p = 1;
  const nowIso = now.toISOString();
  for (const r of rows) {
    const d = r.data;
    const tupleParts = [
      `$${p++}::uuid`,            // id
      `$${p++}`,                  // apAssetId
      `$${p++}`,                  // staMacAddr
      `$${p++}`,                  // staIpAddr
      `$${p++}`,                  // ssid
      `$${p++}`,                  // radioId
      `$${p++}`,                  // wlanId
      `$${p++}`,                  // band
      `$${p++}`,                  // vlanId
      `$${p++}`,                  // bssid
      `$${p++}`,                  // signalStrength
      `$${p++}`,                  // noise
      `$${p++}`,                  // bandwidthTx
      `$${p++}`,                  // bandwidthRx
      `$${p++}`,                  // idleSeconds
      `$${p++}`,                  // matchedAssetId
      `$${p++}`,                  // source
      `$${p++}::timestamp`,       // firstSeen
      `$${p++}::timestamp`,       // lastSeen
    ];
    tuples.push(`(${tupleParts.join(", ")})`);
    params.push(
      r.id,
      apAssetId,
      d.staMacAddr,
      d.staIpAddr,
      d.ssid,
      d.radioId,
      d.wlanId,
      d.band,
      d.vlanId,
      d.bssid,
      d.signalStrength,
      d.noise,
      d.bandwidthTx,
      d.bandwidthRx,
      d.idleSeconds,
      d.matchedAssetId,
      d.source,
      nowIso,
      nowIso,
    );
  }
  const sql =
    `INSERT INTO "asset_wireless_stations" (` +
    `"id", "apAssetId", "staMacAddr", ` +
    `"staIpAddr", "ssid", "radioId", "wlanId", "band", "vlanId", ` +
    `"bssid", "signalStrength", "noise", "bandwidthTx", "bandwidthRx", ` +
    `"idleSeconds", "matchedAssetId", "source", "firstSeen", "lastSeen"` +
    `) VALUES ${tuples.join(", ")} ` +
    `ON CONFLICT ("id") DO UPDATE SET ` +
    `"staIpAddr"      = EXCLUDED."staIpAddr", ` +
    `"ssid"           = EXCLUDED."ssid", ` +
    `"radioId"        = EXCLUDED."radioId", ` +
    `"wlanId"         = EXCLUDED."wlanId", ` +
    `"band"           = EXCLUDED."band", ` +
    `"vlanId"         = EXCLUDED."vlanId", ` +
    `"bssid"          = EXCLUDED."bssid", ` +
    `"signalStrength" = EXCLUDED."signalStrength", ` +
    `"noise"          = EXCLUDED."noise", ` +
    `"bandwidthTx"    = EXCLUDED."bandwidthTx", ` +
    `"bandwidthRx"    = EXCLUDED."bandwidthRx", ` +
    `"idleSeconds"    = EXCLUDED."idleSeconds", ` +
    `"matchedAssetId" = EXCLUDED."matchedAssetId", ` +
    `"source"         = EXCLUDED."source", ` +
    `"lastSeen"       = EXCLUDED."lastSeen"`;
  await retryOnDeadlock(() => prisma.$executeRawUnsafe(sql, ...params));
}

/**
 * Build a lookup table for asset-matching neighbors. One pass over the asset
 * table at persist time is cheaper than per-neighbor queries; the table is
 * kept in scope only for the duration of a single recordSystemInfoResult call.
 *
 * - byIp: ipAddress + every row in asset_associated_ips (manual + monitor-discovered)
 * - byMac: macAddress (uppercased) + every entry in macAddresses
 * - byHostnameAll: hostname (lowercased) → EVERY asset carrying it (rule 91);
 *   `gateIdByAssetId` is what picks between them
 */
// ─── LLDP match-index cache ───────────────────────────────────────────────
//
// `persistLldpNeighbors` used to call `buildLldpAssetMatchIndex` on every
// system-info pass — for each monitored asset that returned an LLDP scrape
// we'd findMany over EVERY asset row (plus its associated IP and MAC side
// tables) just to build the IP/MAC/hostname lookup maps. At 1700 monitored
// assets that's the heaviest single read in the monitor hot loop.
//
// Cache the index for 60 s. Asset hostnames / IPs / MACs change slowly
// enough that the worst-case stale-cache effect is one cycle of "LLDP
// neighbor resolved to the wrong asset" which corrects itself on the next
// scrape. Single-process module-level cache; no inter-process invalidation
// needed because the workers are all in one node process.
//
// Discovery code that materially changes the lookup keys (asset rename,
// IP change, MAC add/remove) can call `invalidateLldpMatchCache()` to drop
// the cache before its next read — but the TTL is short enough that
// explicit invalidation is optional, and most discovery writes don't need
// it. Currently nobody calls it; the TTL is the source of truth.
const LLDP_MATCH_CACHE_TTL_MS = 60_000;
interface LldpMatchIndex extends LldpHostnameMatchIndex {
  byIp: Map<string, string>;
  byMac: Map<string, string>;
}
// createTtlCache (2026-08 audit) — the hand-rolled cache+inflight trio it
// replaces re-implemented exactly the promise-coalescing the shared util
// provides (many parallel systemInfo workers hitting the same TTL-miss
// window share ONE findMany).
const lldpMatchCache = createTtlCache<LldpMatchIndex>({ ttlMs: LLDP_MATCH_CACHE_TTL_MS, maxEntries: 1 });

function getLldpAssetMatchIndex(): Promise<LldpMatchIndex> {
  return lldpMatchCache.getOrCompute("", buildLldpAssetMatchIndex);
}

/** Drop the cached LLDP match index so the next `persistLldpNeighbors`
 *  call rebuilds from a fresh findMany. Currently unused — discovery code
 *  relies on the 60 s TTL for refresh. Exported for tests and for future
 *  callers that want explicit control after a bulk asset write. */
export function invalidateLldpMatchCache(): void {
  lldpMatchCache.invalidate();
}

async function buildLldpAssetMatchIndex(): Promise<LldpMatchIndex> {
  // Always-on logging around the full-fleet findMany: the rebuild fires at
  // most every 60 s on TTL miss, so log volume is bounded, and "the rebuild
  // wedged" is one of the leading hypotheses for systemInfo handler stalls
  // (every concurrent handler awaits the same inflight Promise — if it
  // never settles, every awaiter times out together). Pair of start +
  // complete lines gives the operator wall-clock for the rebuild itself.
  const startedAt = Date.now();
  logger.info({ phase: "lldp_match_index.rebuild_start" }, "LLDP match index rebuild started");
  // Two reads: the identity columns for every asset, and — for the Fortinet
  // infra rows only — the three `fortinetTopology` keys that say which gate
  // each sits under (rule 91's tie-break for a shared hostname). A JSON-path
  // projection rather than selecting the whole blob: a gate's topology stamp
  // carries its managed-member serial lists, far more than this index needs
  // every 60 s.
  type InfraKeyRow = {
    id: string; hostname: string | null; serialNumber: string | null; assetType: string;
    controllerSerial: string | null; controllerFortigate: string | null; deviceName: string | null;
  };
  const [rows, infraRows] = await Promise.all([
    prisma.asset.findMany({
      select: {
        id: true, ipAddress: true, macAddress: true, hostname: true, dnsName: true,
        associatedIpRows: { select: { ip: true } },
        macAddressRows:   { select: { mac: true, macEnd: true } },
      },
    }),
    prisma.$queryRaw<InfraKeyRow[]>`
      SELECT id, hostname, "serialNumber", "assetType"::text AS "assetType",
             "fortinetTopology"->>'controllerSerial'    AS "controllerSerial",
             "fortinetTopology"->>'controllerFortigate' AS "controllerFortigate",
             "fortinetTopology"->>'deviceName'          AS "deviceName"
      FROM assets
      WHERE "assetType"::text IN ('firewall', 'switch', 'access_point')
    `,
  ]);
  logger.info(
    { phase: "lldp_match_index.rebuild_complete", elapsedMs: Date.now() - startedAt, assets: rows.length },
    "LLDP match index rebuild complete",
  );
  const byIp = new Map<string, string>();
  const byMac = new Map<string, string>();
  const byHostnameAll = new Map<string, string[]>();
  // Index a hostname-shaped string under the asset id, including the leftmost
  // label when it's an FQDN. Symmetric coverage matters for LLDP matching: a
  // FortiGate's `Asset.hostname` is "HARBOR-61F-1" (short form, set by the
  // fortigate-firewall source) but the device advertises itself via LLDP as
  // "HARBOR-61F-1.example.com" (FQDN). The lookup side already lowercases; we
  // just need both forms in the index.
  const idxHostname = (raw: string | null, assetId: string) => indexLldpHostname(byHostnameAll, raw, assetId);
  // Which gate each infra asset sits under, through the shared resolver (a
  // controller stamp is serial-first, FMG device name second, hostname last).
  const gateIdByAssetId = new Map<string, string>();
  const infraCandidates: InfraParentCandidate[] = infraRows.map(r => ({
    id: r.id, hostname: r.hostname, serialNumber: r.serialNumber, assetType: r.assetType,
    fortinetTopology: {
      controllerSerial: r.controllerSerial, controllerFortigate: r.controllerFortigate, deviceName: r.deviceName,
    },
  }));
  const infraIndex = buildInfraParentIndex(infraCandidates);
  for (const c of infraCandidates) {
    const gate = c.assetType === "firewall" ? c.id : controllerGateIdOf(infraIndex, c);
    if (gate) gateIdByAssetId.set(c.id, gate);
  }
  for (const a of rows) {
    if (a.ipAddress && !byIp.has(a.ipAddress)) byIp.set(a.ipAddress, a.id);
    for (const row of a.associatedIpRows) {
      if (row.ip && !byIp.has(row.ip)) byIp.set(row.ip, a.id);
    }
    if (a.macAddress) {
      const mac = a.macAddress.toUpperCase();
      if (!byMac.has(mac)) byMac.set(mac, a.id);
    }
    for (const row of a.macAddressRows) {
      if (!row.mac) continue;
      // Range rows (interface-fold, macEnd set) expand so an LLDP neighbor
      // advertising ANY port MAC in the range still resolves to the asset.
      // Cap guards the index against a malformed row; real interface ranges
      // are bounded by physical port counts.
      for (const mac of expandMacRange(row.mac, row.macEnd, 512)) {
        if (!byMac.has(mac)) byMac.set(mac, a.id);
      }
    }
    idxHostname(a.hostname, a.id);
    // Also index dnsName when set — covers AD-discovered hosts where the
    // FQDN lives on dnsName separately, and LLDP advertises the hostname
    // form which might differ.
    idxHostname(a.dnsName, a.id);
  }
  return { byIp, byMac, byHostnameAll, gateIdByAssetId };
}

/**
 * Build the per-interface monitor-source rows for the asset_associated_ips
 * table from a fresh interface scrape. Pure: takes the interface samples,
 * returns rows ready for createMany. Caller (recordSystemInfoResult) does
 * the delete-and-replace transaction; manual entries are preserved by
 * filtering on source there.
 *
 * Empty result is meaningful — it tells the caller to skip the persist
 * entirely so a transient "scrape returned no interface IPs" doesn't wipe
 * an existing monitor-source set.
 */
export function buildMonitorAssocIpEntries(
  interfaces: InterfaceSample[],
  now: Date,
  source: InterfaceAddressSource = "monitor-system-info",
): Array<{
  ip: string;
  source: string;
  interfaceName: string | null;
  mac: string | null;
  interfaceRole: string | null;
  lastSeen: Date;
  firstSeen: Date;
}> {
  const out: Array<{
    ip: string; source: string; interfaceName: string | null;
    mac: string | null; interfaceRole: string | null; lastSeen: Date; firstSeen: Date;
  }> = [];
  const seenIps = new Set<string>();
  for (const i of interfaces) {
    // Business rule 126: one row per reportable address, both families, under
    // the same interface and MAC. Loopback and link-local never land — the
    // agent used to report `lo` as 127.0.0.1 and an IPv6-only NIC as fe80::,
    // and this list feeds IP history, path-check hop resolution and search.
    const addr = splitInterfaceAddresses(i.ipAddress, i.ipv6Address, ipv6Enabled());
    // A collector that names the interface's secondary addresses (FortiOS)
    // also tells us the IPv4 above is the primary; one that doesn't leaves
    // the role unknown. Secondaries are informational — they ride the
    // interface's MAC and nothing else (no network, DHCP or binding).
    const rolesKnown = Array.isArray(i.secondaryIps);
    const secondaries = rolesKnown
      ? (i.secondaryIps as string[]).filter((s) => !interfaceIpIsUnaddressed(s))
      : [];
    const candidates: Array<{ ip: string | null; role: string | null }> = [
      { ip: addr.ipAddress, role: rolesKnown ? "primary" : null },
      ...secondaries.map((s) => ({ ip: bareInterfaceIp(s), role: "secondary" })),
      { ip: addr.ipv6Address, role: null },
    ];
    for (const { ip, role } of candidates) {
      if (!ip || seenIps.has(ip)) continue; // dedupe within a single scrape
      seenIps.add(ip);
      out.push({
        ip,
        source,
        interfaceName: i.ifName,
        // Colon-uppercase like every other address/MAC row: the asset panel
        // groups addresses under the MAC list by exact string, and REST / agent
        // / WinRM collectors report lowercase or dashed MACs.
        mac:           normalizeMacOrNull(i.macAddress),
        interfaceRole: role,
        lastSeen:      now,
        firstSeen:     now,
      });
    }
  }
  return out;
}

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
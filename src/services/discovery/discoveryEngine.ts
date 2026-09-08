/**
 * src/services/discovery/discoveryEngine.ts — the discovery engine.
 *
 * Extracted verbatim from src/api/routes/integrations.ts (which retains the
 * CRUD / proxy-query / discovery-trigger routes). Owns the full discovery
 * pipeline: triggerDiscovery/runDiscovery, the per-integration sync passes
 * (syncDhcpSubnets, syncEntraDevices, syncActiveDirectoryDevices,
 * syncVcenterDevices), slow-run/auto-abort supervision, verbose-logging
 * expiry, and the preflight connection test.
 */

import { chunkArray } from "../../utils/chunk.js";
import { mapSettledWithConcurrency } from "../../utils/concurrency.js";
import { prisma } from "../../db.js";
import { AppError, throwIfAborted } from "../../utils/errors.js";
import { armDiscoveryCancelWatchdog } from "../discoveryCancelWatchdog.js";
import * as fortimanager from "../fortimanagerService.js";
import * as fortigate from "../fortigateService.js";
import * as windowsServer from "../windowsServerService.js";
import * as entraId from "../entraIdService.js";
import * as activeDirectory from "../activeDirectoryService.js";
import * as vcenter from "../vcenterService.js";
import * as azureArc from "../azureArcService.js";
import { ipInCidr, normalizeCidr, cidrContains, cidrOverlaps } from "../../utils/cidr.js";
import { normalizeMacsDistinct, macHexKeyOrNull } from "../../utils/mac.js";
import {
  isInfraSourceType,
  decideInfraDhcpBinding,
  reservationBelongsToInfraDevice,
} from "../../utils/infraDhcpBinding.js";
import { isFortinetIntegrationType } from "../../utils/pollingCompatibility.js";
import { ENTRA_ASSET_TAG_PREFIX, AD_ASSET_TAG_PREFIX, AD_GUID_TAG_PREFIX, SID_TAG_PREFIX } from "../../utils/assetSourceTags.js";
import type { DiscoveryResult, DiscoveryProgressCallback } from "../fortimanagerService.js";
import { projectAssetFromSources, ENRICHMENT_SOURCE_KINDS } from "../../utils/assetProjection.js";
import { scoreDhcpClaim, claimBeats, type DhcpClaimScore } from "../../utils/dhcpClaimFreshness.js";
import { bareFortinetDeviceName } from "../../utils/assetSourceLocation.js";
import { refreshProjectionPriority } from "../assetSourcePriorityService.js";
import { refreshCache as refreshAssetTypeCache } from "../assetTypeService.js";
import { normalizeManufacturer } from "../../utils/manufacturerNormalize.js";
import {
  logEvent,
  logEventsBatch,
  snapshotMaterialAssetFields,
  logDiscoveryAssetCreated,
  logDiscoveryAssetUpdated,
  buildFirmwareChangedEvent,
  buildConnectionChangedEvent,
  type LogEventInput,
} from "../eventLogService.js";
import { getConfiguredResolver } from "../dnsService.js";
import { lookupOui, lookupOuiOverride } from "../ouiService.js";
import { clampAcquiredToLastSeen, bumpLastSeen } from "../../utils/assetInvariants.js";
import { resolveAssetTypeCached, type AssetTypeFacts } from "../../utils/assetTypeMatch.js";
import { normalizeHardwareSerial, indexUniqueBy } from "../../utils/hardwareIdentity.js";
import { recordSample, getBaselines, type Baseline } from "../discoveryDurationService.js";
import { evaluateAutoAbort, clearAutoAbortState } from "../discoveryAutoAbortService.js";
import { publishDiscoveryJob } from "../queueService.js";
import { scopeLabel, scopeMatchesIntegrationType, vcenterScopeTarget, type DiscoveryScope } from "./discoveryScope.js";
import {
  upsertQueuedRun,
  markRunStarted,
  flushRunProgress,
  finishRun,
  isRunActive,
  anyRunActive,
  isCancelRequested,
  requestCancel,
  listActiveRuns,
  persistSlowFlags,
  touchWorkerHeartbeat,
  newRunAccumulator,
  type RunAccumulator,
} from "../discoveryRunState.js";
import { releaseDnsResolvedAt } from "../dnsResolvedReservationService.js";
import { createSubnetRowChecked } from "../subnetService.js";
import { snapshotSubnet, archiveSubnet } from "../subnetArchiveService.js";
import { raiseChassisReplacedConflict } from "../subnetChassisConflictService.js";
import { classifyChassis, verdictWritesSerial, classifyDeprecatedSupersede } from "../../utils/chassisIdentity.js";
import { findCoveringExclusion } from "../../utils/subnetExclusion.js";
import { isMergeableEndpointGhost, mergeEndpointGhostIntoAsset } from "../assetGhostMergeService.js";
import { recordDiscovery, observeDiscoveryPhase } from "../../metrics.js";
import { getAdMonitorProtocol, persistManagedApLldpNeighbors, invalidateLldpMatchCache } from "../monitoringService.js";
import { persistApRadioInventory } from "../apRadioService.js";
import { isFortiapStatusOnline } from "../../utils/fortiapMonitorRow.js";
import * as autoMonitor from "../autoMonitorInterfacesService.js";
import * as autoMonitorStorage from "../autoMonitorStorageService.js";
import * as agentAutoDeploy from "../agentAutoDeployService.js";
import * as presenceVerification from "../presenceVerificationService.js";
import * as directorySync from "../directorySyncService.js";
import { recomputeDependencyTree } from "../dependencyTreeService.js";
import { collectManagementAccess, type DeviceAccessGroup } from "../fortinetManagementAccessService.js";
import { runDescriptionSyncForIntegration } from "../descriptionSyncService.js";
import { reconcileMapRegions } from "../mapRegionService.js";
import { releaseAssetsForDecommission } from "../maintenanceScheduleService.js";
import { releaseInfraReservationsForAssets } from "../reservationService.js";
import { runInfraReservationPush } from "../infraReservationPushService.js";
import { persistFortigateArpTables } from "../arpTableService.js";
import {
  buildMacEvidenceIndex,
  createAdoptionBudget,
  runPlaceholderMacAdoption,
  type AdoptionBudget,
} from "../placeholderMacAdoptionService.js";
import { reconcileAllTags } from "../tagAssignmentService.js";
import * as sightings from "../assetSightingService.js";
import { quarantineAsset, verifyAssetQuarantine } from "../assetQuarantineService.js";
import { fetchFortigateSysLocation } from "../fortigateLocationService.js";
import { geocode } from "../geocoderService.js";
import { pushCoordsToFortigate } from "../fortigateCoordPushService.js";
import { isValidGeoCoord, coordsClose } from "../../utils/geo.js";
import {
  getAddAsMonitoredFromConfig,
  buildMonitoredSweep,
} from "../monitorOverrideService.js";
import {
  MAC_ROW_SELECT,
  shapeMacRows,
  buildMacRowsForCreate,
  selectPrimaryMac,
  isHardwareMacSource,
  type MacJsonEntry,
} from "../../utils/macAddresses.js";
import {
  buildArpMacDeviceIndex,
  inventorySightingIsLocal,
} from "../../utils/inventoryLocality.js";
import { reconcileMacAddresses } from "../macAddressService.js";
import { logger } from "../../utils/logger.js";

/** Auto-disable window for per-integration verbose debug logging (30 minutes). */
const VERBOSE_LOGGING_TTL_MS = 30 * 60 * 1000;

/**
 * Returns true when verbose logging is currently active for the given
 * integration config — i.e. the flag is on AND the 30-minute window hasn't
 * expired. Legacy rows that have `verboseLogging: true` but no timestamp
 * (set before this feature existed) are treated as active so existing
 * sessions aren't silently broken; the expiry job will clear them on the
 * next tick once 30 minutes pass.
 */
export function isVerboseLoggingActive(cfg: Record<string, unknown>): boolean {
  if (cfg.verboseLogging !== true) return false;
  const at = cfg.verboseLoggingEnabledAt;
  if (typeof at !== "string") return true; // legacy: no timestamp, treat as active
  return Date.now() - new Date(at).getTime() < VERBOSE_LOGGING_TTL_MS;
}

/**
 * Scan all integrations and clear `verboseLogging` for any that have had it
 * enabled for more than 30 minutes. Called every 30 s from discoverySlowCheck.
 * Integrations without a `verboseLoggingEnabledAt` timestamp (set before this
 * feature) are left alone — they need a manual toggle to pick up the timestamp.
 */
export async function expireVerboseLogging(): Promise<void> {
  const integrations = await prisma.integration.findMany({
    select: { id: true, name: true, config: true },
  });
  for (const integration of integrations) {
    const cfg = integration.config as Record<string, unknown>;
    if (cfg.verboseLogging !== true) continue;
    const at = cfg.verboseLoggingEnabledAt;
    if (typeof at !== "string") continue; // no timestamp: skip (legacy row)
    if (Date.now() - new Date(at).getTime() < VERBOSE_LOGGING_TTL_MS) continue;
    // Window expired — disable verbose logging
    const newCfg: Record<string, unknown> = { ...cfg, verboseLogging: false };
    delete newCfg.verboseLoggingEnabledAt;
    await prisma.integration.update({
      where: { id: integration.id },
      data: { config: newCfg as any },
    });
    logger.info(
      { integrationId: integration.id, integrationName: integration.name },
      "integration.verbose_logging.auto_expired",
    );
  }
}

// In-flight discovery state lives in the DiscoveryRun table (see
// src/services/discoveryRunState.ts), not an in-memory Map, so the web process
// can render progress + signal cancel while the discovery-role process executes
// the run. The discovery worker mutates a local RunAccumulator and flushes it to
// the row; abort is signaled via the row's cancelRequested flag.

/**
 * Directory-source type inference.
 *
 * The OS-string ladder this used to hardcode now lives on the AssetTypeDef
 * registry as operator-editable rules (`utils/assetTypeMatch.ts`), seeded to
 * reproduce it exactly — so an install that never opens the Device Types card
 * behaves as it always did, and one that does can teach Polaris about its own
 * fleet without a code change. The return type widened from the three literals
 * to `string` for the same reason: a custom type can now claim a device.
 *
 * `extra` carries whatever else the caller happens to know. The seeded rules
 * read `os` alone, so passing more facts is inert for them and reachable only
 * by a rule an operator wrote.
 */
function inferAssetTypeFromOs(
  os: string | null | undefined,
  extra?: Omit<AssetTypeFacts, "os">,
): string {
  return resolveAssetTypeCached({ os: os ?? null, ...(extra ?? {}) }, "directory") ?? "other";
}

// ─── Shared discovery trigger (used by route handler + scheduler) ─────────────

export async function isDiscoveryRunning(integrationId: string): Promise<boolean> {
  return isRunActive(integrationId);
}

/**
 * Iterate all in-flight discoveries; for each, compare elapsed time against
 * the rolling baseline from `discoveryDurationService`. If a run exceeds its
 * threshold and hasn't been flagged yet, emit a single
 * `integration.discover.slow` event (per run, per FortiGate). Deduplicated
 * via `slowAlerted` / `slowAlertedDevices` on the activeDiscovery entry —
 * those flags are cleared when the run completes (or the device finishes).
 *
 * Also enforces the auto-abort ceiling: a full (non-scoped) run that exceeds
 * its baseline's autoAbortMs (~2× the rolling average) gets cancelRequested
 * set — the same flag the operator's Cancel uses — and an
 * `integration.discover.auto_aborted` event naming the slow/active
 * FortiGates. The post-abort exemption lives in discoveryAutoAbortService.
 *
 * Called by the 30s background job and inline on the /discoveries poll, so
 * the UI flips to amber promptly without waiting on the slower timer.
 */
export async function checkForSlowRuns(): Promise<void> {
  const rows = await listActiveRuns();
  if (rows.length === 0) return;

  // Gather all (integration, device) unit keys we need baselines for. The
  // integration-level baseline is fetched even when the slow flag is already
  // set — the auto-abort check below needs it for the rest of the run's life.
  const unitKeys: string[] = [];
  for (const row of rows) {
    unitKeys.push(row.integrationId);
    if (row.type === "fortimanager") {
      for (const dev of row.activeDevices as { name: string; startedAt: number }[]) {
        if (!(row.slowAlertedDevices as string[]).includes(dev.name)) unitKeys.push(`${row.integrationId}:${dev.name}`);
      }
    }
  }
  if (unitKeys.length === 0) return;

  let baselines: Map<string, Baseline | null>;
  try {
    baselines = await getBaselines(unitKeys);
  } catch {
    return;
  }

  const now = Date.now();
  for (const row of rows) {
    const id = row.integrationId;
    // Slow detection compares actual run length against the baseline. A queued
    // row (worker hasn't picked it up yet) has no run length to compare, so
    // skip it — otherwise the row's createdAt stand-in would charge queue time
    // against the threshold and flag the run slow before it even started.
    if (!row.startedAt) continue;
    const startedMs = row.startedAt.getTime();
    let slowAlerted = row.slowAlerted;
    const slowAlertedDevices = new Set(row.slowAlertedDevices as string[]);
    let mutated = false;

    // Overall-run threshold — applies to every integration type.
    if (!slowAlerted) {
      const bl = baselines.get(id) ?? null;
      const elapsed = now - startedMs;
      if (bl && elapsed > bl.thresholdMs) {
        slowAlerted = true;
        mutated = true;
        logEvent({
          action: "integration.discover.slow",
          resourceType: "integration",
          resourceId: id,
          resourceName: row.integrationName,
          level: "warning",
          message: `Discovery for "${row.integrationName}" is running longer than normal — ${fmtSec(elapsed)} elapsed vs typical ${fmtSec(bl.avgMs)} (threshold ${fmtSec(bl.thresholdMs)}, ${bl.sampleCount} samples)`,
          details: {
            scope: "integration",
            integrationId: id,
            elapsedMs: elapsed,
            avgMs: bl.avgMs,
            stddevMs: bl.stddevMs,
            thresholdMs: bl.thresholdMs,
            sampleCount: bl.sampleCount,
          },
        });
      }
    }

    // Per-FortiGate threshold — FMG only.
    if (row.type === "fortimanager") {
      for (const dev of row.activeDevices as { name: string; startedAt: number }[]) {
        if (slowAlertedDevices.has(dev.name)) continue;
        const key = `${id}:${dev.name}`;
        const bl = baselines.get(key) ?? null;
        const elapsed = now - dev.startedAt;
        if (bl && elapsed > bl.thresholdMs) {
          slowAlertedDevices.add(dev.name);
          mutated = true;
          logEvent({
            action: "integration.discover.slow",
            resourceType: "integration",
            resourceId: id,
            resourceName: row.integrationName,
            level: "warning",
            message: `Discovery on FortiGate "${dev.name}" via "${row.integrationName}" is running longer than normal — ${fmtSec(elapsed)} elapsed vs typical ${fmtSec(bl.avgMs)} (threshold ${fmtSec(bl.thresholdMs)}, ${bl.sampleCount} samples)`,
            details: {
              scope: "fortigate",
              integrationId: id,
              device: dev.name,
              elapsedMs: elapsed,
              avgMs: bl.avgMs,
              stddevMs: bl.stddevMs,
              thresholdMs: bl.thresholdMs,
              sampleCount: bl.sampleCount,
            },
          });
        }
      }
    }

    // Persist the dedup flags so the next poll (this process or the 30s job)
    // doesn't re-emit. The worker's progress flushes preserve these because the
    // accumulator is the worker's source of truth for activeDevices, not these
    // flags — checkForSlowRuns only runs in the web/scheduler role.
    if (mutated) await persistSlowFlags(id, slowAlerted, [...slowAlertedDevices]);

    // ── Auto-abort: hard-cancel a run at ~2× its average duration ────────────
    // Reuses the operator-cancel plumbing end to end: requestCancel sets the
    // flag, the worker's 3s poll aborts, and the cancel watchdog force-exits
    // the discovery process if the abort can't unwind. Scoped single-device
    // runs are skipped (they have no baseline of their own — comparing them
    // to the full-run average is meaningless), as are runs already carrying a
    // cancel request (operator cancel in flight, or we already fired). The
    // loop-breaker in discoveryAutoAbortService exempts the run after an
    // auto-abort so a legitimately-grown fleet can complete once and refresh
    // the baseline — aborted runs never record duration samples.
    if (row.status === "running" && !row.cancelRequested && !row.scopeDeviceName) {
      const bl = baselines.get(id) ?? null;
      const elapsed = now - startedMs;
      if (bl && elapsed > bl.autoAbortMs) {
        const activeDevices = (row.activeDevices as { name: string; startedAt: number }[])
          .map((d) => ({ name: d.name, elapsedMs: now - d.startedAt }));
        const details = {
          integrationId: id,
          elapsedMs: elapsed,
          avgMs: bl.avgMs,
          thresholdMs: bl.thresholdMs,
          autoAbortMs: bl.autoAbortMs,
          sampleCount: bl.sampleCount,
          activeDevices,
          slowDevices: [...slowAlertedDevices],
        };
        const decision = await evaluateAutoAbort(id, row.startedAt.toISOString()).catch(() => null);
        if (decision?.action === "abort") {
          await requestCancel(id);
          const slowSuffix = slowAlertedDevices.size > 0
            ? ` Slow-flagged FortiGates: ${[...slowAlertedDevices].join(", ")}.`
            : "";
          const activeSuffix = activeDevices.length > 0
            ? ` Still running: ${activeDevices.map((d) => `${d.name} (${fmtSec(d.elapsedMs)})`).join(", ")}.`
            : "";
          logEvent({
            action: "integration.discover.auto_aborted",
            resourceType: "integration",
            resourceId: id,
            resourceName: row.integrationName,
            level: "warning",
            message: `Auto-aborting discovery for "${row.integrationName}" — ${fmtSec(elapsed)} elapsed vs typical ${fmtSec(bl.avgMs)} (auto-abort threshold ${fmtSec(bl.autoAbortMs)}).${slowSuffix}${activeSuffix}`,
            details,
          });
        } else if (decision?.action === "exempt" && decision.granted) {
          logEvent({
            action: "integration.discover.auto_abort_skipped",
            resourceType: "integration",
            resourceId: id,
            resourceName: row.integrationName,
            level: "warning",
            message: `Discovery for "${row.integrationName}" exceeded its auto-abort threshold (${fmtSec(elapsed)} elapsed vs ${fmtSec(bl.autoAbortMs)}) but the previous run was auto-aborted — letting this run finish so a successful completion can refresh the duration baseline.`,
            details,
          });
        }
      }
    }
  }
}

function fmtSec(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/**
 * Pull the warm-cache management IPs for an FMG integration's monitor-up
 * firewalls. Returns deviceName → mgmtIp. Empty in proxy mode (the cache
 * doesn't help when every per-device call funnels through FMG anyway), and
 * empty on first run before any firewall has been monitored. Errors are
 * swallowed: the cache is a speedup, not a correctness requirement, and
 * discovery falls back to the FMG-serial resolver path automatically when
 * the map is empty.
 */
async function buildFmgWarmCacheIps(
  integrationId: string,
  config: Record<string, unknown>,
): Promise<Map<string, string>> {
  const empty = new Map<string, string>();
  try {
    const useProxy = config.useProxy !== false;
    if (useProxy) return empty;
    const rows = await prisma.asset.findMany({
      where: {
        discoveredByIntegrationId: integrationId,
        assetType: "firewall",
        // "passive" alongside "up": a gate no down-detection automation covers
        // is never "up" by construction, and excluding it would silently drop
        // it from the warm cache so discovery falls back to the slower serial
        // resolver for it. Degradation rather than breakage, but invisible.
        monitorStatus: { in: ["up", "passive"] },
        ipAddress: { not: null },
        hostname: { not: null },
      },
      select: { hostname: true, ipAddress: true },
    });
    // Sort by hostname (case-insensitive, natural-numeric so FW-2 precedes
    // FW-10) before populating the Map. Map iteration order is insertion
    // order, and the downstream `cachedNames` Set inherits it, so the
    // warm-cache producer dispatches FortiGates alphabetically — predictable
    // for operators watching live discovery logs.
    const sorted = rows
      .filter((r): r is { hostname: string; ipAddress: string } => !!r.hostname && !!r.ipAddress)
      .sort((a, b) => a.hostname.localeCompare(b.hostname, undefined, { sensitivity: "base", numeric: true }));
    const map = new Map<string, string>();
    for (const r of sorted) map.set(r.hostname, r.ipAddress);
    return map;
  } catch {
    return empty;
  }
}

/**
 * Build the ARP presence-sweep target map for a Fortinet integration:
 * lowercased FortiGate device name (fmgNameKey convention) → active
 * dhcp_reservation IPs on that device's non-deprecated subnets. Empty when
 * the integration hasn't opted in (`config.arpPresenceSweep !== true`), so
 * callers can pass the result through unconditionally. Errors are swallowed:
 * the sweep is a presence-evidence enhancer, never a discovery blocker.
 *
 * Scale: one indexed query bounded by total dhcp_reservation count (low
 * thousands at most); the map is grouped per device so each FortiGate is
 * swept with only its own subnets' IPs right before its ARP-table read —
 * never a fleet-wide blast.
 */
async function buildArpSweepTargets(
  integrationId: string,
  config: Record<string, unknown>,
): Promise<Map<string, string[]>> {
  const empty = new Map<string, string[]>();
  try {
    if (config.arpPresenceSweep !== true) return empty;
    const rows = await prisma.reservation.findMany({
      where: {
        status: "active",
        sourceType: "dhcp_reservation",
        ipAddress: { not: null },
        subnet: {
          discoveredBy: integrationId,
          status: { not: "deprecated" },
          fortigateDevice: { not: null },
        },
      },
      select: { ipAddress: true, subnet: { select: { fortigateDevice: true } } },
    });
    const map = new Map<string, string[]>();
    for (const r of rows) {
      const dev = r.subnet.fortigateDevice;
      if (!dev || !r.ipAddress) continue;
      const key = dev.toLowerCase();
      const list = map.get(key);
      if (list) list.push(r.ipAddress);
      else map.set(key, [r.ipAddress]);
    }
    return map;
  } catch {
    return empty;
  }
}

export async function runPreflightTest(integration: { id: string; type: string; config: unknown }): Promise<{ ok: boolean; message: string }> {
  const config = integration.config as Record<string, unknown>;
  if (integration.type === "fortimanager") return fortimanager.testConnection(config as any, integration.id);
  if (integration.type === "fortigate") return fortigate.testConnection(config as any);
  if (integration.type === "windowsserver") return windowsServer.testConnection(config as any);
  if (integration.type === "entraid") return entraId.testConnection(config as any);
  if (integration.type === "activedirectory") return activeDirectory.testConnection(config as any);
  if (integration.type === "vcenter") return vcenter.testConnection(config as any);
  if (integration.type === "azurearc") return azureArc.testConnection(config as any);
  return { ok: false, message: `Unknown integration type: ${integration.type}` };
}

/**
 * Enqueue a discovery run. Validates the integration config (fast 400 for the
 * manual route), upserts a `queued` DiscoveryRun row, then either publishes a
 * pg-boss discovery job (consumed by the discovery-role process) or — when
 * pg-boss is off (cursor-mode single-process installs) — runs it in-process.
 * Coalesces: a re-trigger while a run is queued/running is a no-op (the
 * singleton queue would absorb it anyway), preserving the in-flight row.
 *
 * actor: the username triggering the run, or "auto-discovery" for scheduled runs.
 */
export async function triggerDiscovery(
  integrationId: string,
  actor: string,
  opts?: { scope?: DiscoveryScope; scopeLabel?: string | null },
): Promise<boolean> {
  const integration = await prisma.integration.findUnique({ where: { id: integrationId } });
  if (!integration) throw new AppError(404, "Integration not found");

  // Each scope kind identifies a device the way exactly ONE integration type
  // does (an FMG roster name, an Entra deviceId, an AD objectGUID), so a
  // mismatch is a caller bug, not a degradable condition.
  if (opts?.scope && !scopeMatchesIntegrationType(opts.scope, integration.type)) {
    throw new AppError(400, `A ${opts.scope.kind} scope cannot run against a ${integration.type} integration`);
  }

  const config = integration.config as Record<string, unknown>;
  // Hostless types (Entra ID, Azure Arc) authenticate against a fixed
  // Microsoft endpoint with an app registration — they carry no `host`, so
  // they must NOT fall into the else branch below, which demands one.
  if (integration.type === "entraid" || integration.type === "azurearc") {
    if (!config.tenantId) throw new AppError(400, "Integration has no tenant ID configured");
    if (!config.clientId) throw new AppError(400, "Integration has no client ID configured");
    if (!config.clientSecret) throw new AppError(400, "Integration has no client secret configured");
  } else {
    if (!config.host) throw new AppError(400, "Integration has no host configured");
    if (integration.type === "fortimanager" && !config.apiToken) throw new AppError(400, "Integration has no API token configured");
    if (integration.type === "fortigate" && !config.apiToken) throw new AppError(400, "Integration has no API token configured");
    if (integration.type === "windowsserver" && !config.username) throw new AppError(400, "Integration has no username configured");
    if (integration.type === "activedirectory") {
      if (!config.bindDn) throw new AppError(400, "Integration has no bind DN configured");
      if (!config.bindPassword) throw new AppError(400, "Integration has no bind password configured");
      if (!config.baseDn) throw new AppError(400, "Integration has no base DN configured");
    }
    if (integration.type === "vcenter") {
      if (!config.username) throw new AppError(400, "Integration has no username configured");
      if (!config.password) throw new AppError(400, "Integration has no password configured");
    }
  }

  // Coalesce concurrent triggers. The scheduler already gates on
  // isDiscoveryRunning, but the manual route doesn't — and a re-trigger
  // shouldn't reset the live progress of an in-flight run. Returns false so
  // callers that need to distinguish (the per-asset rediscover route 409s
  // instead of silently no-oping) can; the classic Discover route and the
  // scheduler ignore the return.
  if (await isRunActive(integrationId)) return false;

  // The run row keeps a flat DISPLAY label (the Integrations card renders it,
  // and the asset button compares against it); the structured scope travels
  // separately in the job payload.
  await upsertQueuedRun({
    integrationId,
    integrationName: integration.name,
    type: integration.type,
    actor,
    scopeDeviceName: scopeLabel(opts?.scope, opts?.scopeLabel),
  });

  // pg-boss live → hand off to the discovery-role worker. Off (cursor mode,
  // single-process) → run in-process detached, the historical behavior. The
  // credential preflight now runs inside runDiscovery (it may execute in a
  // different process), so the manual route returns 202 immediately and a
  // failed preflight surfaces via the DiscoveryRun row + an Event.
  const enqueued = await publishDiscoveryJob(integrationId, actor, opts?.scope);
  if (!enqueued) void runDiscovery(integrationId, actor, opts?.scope);
  return true;
}

/**
 * Execute a discovery run. Invoked by the pg-boss discovery worker (discovery
 * role) or in-process by triggerDiscovery's cursor-mode fallback. Owns the
 * credential preflight, the run-state transitions on DiscoveryRun, the
 * progress accumulator (flushed to the row), and cancellation (polls the row's
 * cancelRequested flag and aborts its local AbortController).
 */
export async function runDiscovery(integrationId: string, actor: string, scope?: DiscoveryScope): Promise<void> {
  const integration = await prisma.integration.findUnique({ where: { id: integrationId } });
  if (!integration) {
    await finishRun(integrationId, "error").catch(() => {});
    return;
  }

  // triggerDiscovery enforces the scope/type pairing for API callers; a stray
  // mismatched pg-boss payload (an old job replayed after a type change)
  // degrades to a full run rather than aiming a scope at a collector that
  // cannot honour it.
  if (scope && !scopeMatchesIntegrationType(scope, integration.type)) {
    logger.warn({ integrationId, scopeKind: scope.kind, type: integration.type }, "ignoring scope on mismatched discovery run");
    scope = undefined;
  }
  const scopeDeviceName = scopeLabel(scope);

  const config = integration.config as Record<string, unknown>;
  const integrationName = integration.name;
  const integrationType = integration.type;
  const label = actor === "auto-discovery" ? "Scheduled" : "Manual";
  const baseKindLabel = (integration.type === "entraid" || integration.type === "activedirectory"
    || integration.type === "vcenter" || integration.type === "azurearc") ? "device discovery" : "DHCP discovery";
  // Scoped runs label every start/complete/abort/error Event with the device.
  const kindLabel = scopeDeviceName ? `${baseKindLabel} (device "${scopeDeviceName}")` : baseKindLabel;

  // No inline preflight — `integrationConnectionTester` refreshes lastTestOk
  // every 10 min, and the discovery scheduler filters on `lastTestOk: true`,
  // so a broken integration won't reach this point under auto-discovery. A
  // manual trigger still proceeds: the operator chose to force a run, and the
  // discovery error surface is the right place for them to see it fail.

  // Pull the operator's Sources-column priority into this process before any
  // projection runs. Discovery is a SEPARATE process in the split-role layout,
  // so this per-run refresh is how a settings edit made in the web role reaches
  // the code that actually writes Asset.learnedLocation. Never throws.
  await refreshProjectionPriority();

  // Same story for the device-type inference rules: the operator edits them in
  // the web role, this process is the one that types devices, and a stale copy
  // would file a whole run under the previous rules with nothing saying so.
  // A failed read leaves the last-known (or shipped) rules in force rather
  // than failing the run — typing devices by yesterday's rules beats not
  // discovering them.
  try {
    await refreshAssetTypeCache();
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "asset type rule refresh failed; using cached matching rules");
  }

  const runStartedAt = Date.now();
  await markRunStarted(integrationId, new Date(runStartedAt));
  // Scoped runs deliberately do NOT stamp lastDiscoveryAt — the scheduler
  // gates the next full run on it, and a per-device refresh must not delay
  // the fleet-wide cycle by a whole pollInterval.
  if (!scope) {
    await prisma.integration.update({ where: { id: integrationId }, data: { lastDiscoveryAt: new Date() } });
  }
  logEvent({ action: "integration.discover.started", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, message: `${label} ${kindLabel} started for "${integrationName}"`, ...(scopeDeviceName ? { details: { scopeDeviceName } } : {}) });

  const acc: RunAccumulator = newRunAccumulator(integrationId, integrationName, integrationType, runStartedAt);
  const ac = new AbortController();

  // Cancel signaling across the process boundary: the web DELETE route sets
  // cancelRequested on the row; we poll it and abort the local controller.
  if (await isCancelRequested(integrationId)) ac.abort();
  const cancelTimer = setInterval(() => {
    isCancelRequested(integrationId)
      .then((c) => { if (c && !ac.signal.aborted) ac.abort(); })
      .catch(() => {});
  }, 3_000);

  // Liveness ping for the stale-run reaper. The progress flush already touches
  // workerHeartbeatAt when activity happens, but a quiet phase (long FMG roster
  // fetch, slow SNMP walk) can go minutes without one, which would look like a
  // dead worker. This independent 60s ping keeps the heartbeat current.
  const heartbeatTimer = setInterval(() => {
    void touchWorkerHeartbeat(integrationId);
  }, 60_000);

  // Force-exit backstop: if the abort fires but the run doesn't unwind within
  // the grace window (wedged on an await the signal can't reach — e.g. a DB
  // query blocked on a lock), the watchdog finalizes the row, logs which
  // devices were stuck, and exits so the service manager restarts the process.
  // Disarmed in the finally below — a run that aborts cleanly never trips it.
  const disarmCancelWatchdog = armDiscoveryCancelWatchdog({
    integrationId,
    integrationName,
    actor,
    signal: ac.signal,
    getActiveDevices: () =>
      [...acc.activeDevices.entries()].map(([name, startedAtMs]) => ({ name, startedAtMs })),
  });

  // Throttled progress flush so a chatty FMG run doesn't hammer the DB.
  let lastFlush = 0;
  const flush = (force = false) => {
    const now = Date.now();
    if (!force && now - lastFlush < 1_500) return;
    lastFlush = now;
    void flushRunProgress(acc);
  };

  const verboseLogging = isVerboseLoggingActive(
    (integration.config && typeof integration.config === "object")
      ? (integration.config as Record<string, unknown>)
      : {},
  );

  const onProgress: DiscoveryProgressCallback = (step, level, message, device) => {
    logEvent({ action: `integration.${step}`, resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level, message: `[${integrationName}] ${message}` });
    if (verboseLogging) {
      logger.info({ verbose: true, integrationId, integrationName, step, level, device }, message);
    }
    // Progress-counter tracking. Driven off step+level alone (NOT the device
    // param) because the offline skip at fortimanagerService:920 doesn't pass
    // a device — the device.start event hasn't fired yet for those devices.
    if (step === "discover.devices" && level === "info" && acc.totalDevices === null) {
      const m = /Found (\d+) managed device/.exec(message);
      if (m) acc.totalDevices = Number(m[1]);
    } else if (step === "discover.device.complete") {
      acc.completedCount++;
    } else if (step === "discover.device.skip" && level === "info") {
      acc.skippedOfflineCount++;
    } else if (step === "discover.device.skip" && level === "error") {
      acc.skippedErrorCount++;
    } else if (step === "discover.device" && level === "error") {
      acc.skippedErrorCount++;
    }
    if (device) {
      const isTerminal =
        step === "discover.device.complete" ||
        step === "discover.device.skip" ||
        step === "discover.device.abort" ||
        (step === "discover.device" && level === "error");
      if (isTerminal) {
        const start = acc.activeDevices.get(device);
        acc.activeDevices.delete(device);
        // Only record a timing sample for successful completions — skips and
        // failures shouldn't influence the slow-run baseline.
        if (step === "discover.device.complete" && start !== undefined) {
          recordSample(`${integrationId}:${device}`, Date.now() - start).catch(() => {});
        }
      } else if (step === "discover.device.start") {
        acc.activeDevices.set(device, Date.now());
      }
    }
    flush();
  };

  try {
    let discoveryResult: DiscoveryResult;

    // Accumulate per-device sync totals for the completion log
    const syncTotals = { created: [] as string[], updated: [] as string[], skipped: [] as string[], deprecated: [] as string[], decommissionedSwitches: [] as string[], decommissionedAps: [] as string[], decommissionedAssets: [] as string[] };

    // Phase 7.7's device-write budget for this ENTIRE run. In FMG mode the sync
    // below runs once per managed FortiGate, so a ceiling held inside the phase
    // would become ceiling × gate-count DHCP writes in a single cycle. One
    // mutable object, decremented by every gate, is what keeps the pass bounded
    // per run the way infraReservationPushService is bounded per integration.
    const adoptionBudget = createAdoptionBudget();

    // Per-device callback: sync each FortiGate's data as it arrives (phases 1, 3–9).
    // Phase 2 (stale deprecation) runs separately at the end once all devices are known.
    const onDeviceComplete = async (deviceResult: DiscoveryResult) => {
      const r = await syncDhcpSubnets(integrationId, integrationName, integration.type, deviceResult, actor, "skip-deprecation", ac.signal, adoptionBudget);
      syncTotals.created.push(...r.created);
      syncTotals.updated.push(...r.updated);
      syncTotals.skipped.push(...r.skipped);
    };

    if (integration.type === "entraid") {
      // Entra ID discovery produces assets only — no subnets, reservations, or VIPs.
      const result = await entraId.discoverDevices(config as any, ac.signal, onProgress, scope?.kind === "entra-device" ? { deviceId: scope.deviceId } : undefined);
      if (!ac.signal.aborted) {
        const r = await syncEntraDevices(integrationId, integrationName, config, result, actor);
        syncTotals.created.push(...r.created);
        syncTotals.updated.push(...r.updated);
        syncTotals.skipped.push(...r.skipped);
      }
    } else if (integration.type === "activedirectory") {
      // Active Directory discovery produces assets only — no subnets, reservations, or VIPs.
      const result = await activeDirectory.discoverDevices(config as any, ac.signal, onProgress, scope?.kind === "ad-object" ? { objectGuid: scope.objectGuid } : undefined);
      if (!ac.signal.aborted) {
        const r = await syncActiveDirectoryDevices(integrationId, integrationName, config, result, actor);
        syncTotals.created.push(...r.created);
        syncTotals.updated.push(...r.updated);
        syncTotals.skipped.push(...r.skipped);
      }
    } else if (integration.type === "vcenter") {
      // vCenter discovery produces assets only — VMs + ESXi hosts (plus the
      // current-state datastore table). No subnets, reservations, or VIPs.
      const vcTarget = vcenterScopeTarget(scope);
      const result = await vcenter.discoverInventory(config as any, ac.signal, onProgress, vcTarget);
      if (!ac.signal.aborted) {
        const r = await syncVcenterDevices(integrationId, integrationName, config, result, actor, vcTarget ? "scoped" : "full");
        syncTotals.created.push(...r.created);
        syncTotals.updated.push(...r.updated);
        syncTotals.skipped.push(...r.skipped);
        syncTotals.decommissionedAssets.push(...r.decommissioned);
      }
    } else if (integration.type === "azurearc") {
      // Azure Arc discovery produces assets only — Arc-enabled machines. No
      // subnets, reservations, or VIPs.
      // Arc's sync needs no scoped mode: it has NO fleet-absence passes — it
      // deliberately never writes `status` (a Disconnected agent is a
      // reachability fact, not a lifecycle one, so aging-out stays with
      // decommissionStaleAssets) and issues no bulk delete/update. Audited
      // 2026-09-08; re-check if you add a pass that reads absence.
      const result = await azureArc.discoverMachines(config as any, ac.signal, onProgress, scope?.kind === "arc-machine" ? { resourceId: scope.resourceId } : undefined);
      if (!ac.signal.aborted) {
        const r = await syncArcDevices(integrationId, integrationName, config, result, actor);
        syncTotals.created.push(...r.created);
        syncTotals.updated.push(...r.updated);
        syncTotals.skipped.push(...r.skipped);
        // Phase 4 — connected Kubernetes clusters become assets of their own.
        // Empty unless the operator enabled them.
        const rc = await syncArcClusters(integrationId, integrationName, config, result.clusters, actor);
        syncTotals.created.push(...rc.created);
        syncTotals.updated.push(...rc.updated);
        syncTotals.skipped.push(...rc.skipped);
      }
    } else if (integration.type === "windowsserver") {
      const subnets = await windowsServer.discoverDhcpScopes(config as any, ac.signal);
      const wsHost = (config as any).host as string;
      discoveryResult = { subnets, devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [], inventoryDevices: [], knownDeviceNames: wsHost ? [wsHost] : [], knownDeviceSerials: [], fortiSwitches: [], fortiAps: [], vips: [], switchMacTable: [], arpTable: [], arpQueriedDevices: [], cmdbSwitchSerials: [], cmdbApSerials: [], switchInventoriedDevices: [], apInventoriedDevices: [], vipInventoriedDevices: [], dhcpReservationsInventoriedDevices: [], dhcpLeasesInventoriedDevices: [] };
      // Windows Server is a single host — no per-device iteration, sync the full result normally
      const r = await syncDhcpSubnets(integrationId, integrationName, integration.type, discoveryResult, actor, "full", ac.signal);
      syncTotals.created.push(...r.created);
      syncTotals.updated.push(...r.updated);
      syncTotals.skipped.push(...r.skipped);
      syncTotals.deprecated.push(...r.deprecated);
    } else if (integration.type === "fortigate") {
      // Single FortiGate — no per-device iteration, sync the full result in one pass.
      // ARP presence sweep (opt-in): one device, so flatten the per-device
      // target map into a single list and ride it on the config object.
      const fgSweepIps = [...(await buildArpSweepTargets(integrationId, config)).values()].flat();
      discoveryResult = await fortigate.discoverDhcpSubnets(
        (fgSweepIps.length ? { ...(config as any), arpSweepIps: fgSweepIps } : config) as any,
        ac.signal,
        onProgress,
      );
      if (!ac.signal.aborted) {
        const r = await syncDhcpSubnets(integrationId, integrationName, integration.type, discoveryResult, actor, "full", ac.signal, adoptionBudget);
        syncTotals.created.push(...r.created);
        syncTotals.updated.push(...r.updated);
        syncTotals.skipped.push(...r.skipped);
        syncTotals.deprecated.push(...r.deprecated);
        syncTotals.decommissionedSwitches.push(...(r.decommissionedSwitches || []));
        syncTotals.decommissionedAps.push(...(r.decommissionedAps || []));
      }
    } else {
      // FortiManager: onDeviceComplete fires after each managed FortiGate is queried,
      // syncing subnets/assets/reservations incrementally.
      //
      // Detect ADOM central-management mode (AP Manager / FortiSwitch
      // Manager) up front — Phase 13.7 description sync branches on it:
      // centrally-managed classes mirror description pushes into FMG's ADOM
      // database so the next install from the central pane doesn't revert
      // the device-side write. Stamped onto
      // Integration.config.centralManagement (system-owned key; the PUT
      // handler's config merge preserves it across operator edits, and the
      // integrations page renders it after the FMG Proxy row). Best-effort:
      // a failed detection keeps the previous stamp.
      try {
        const detected = await fortimanager.detectCentralManagement(config as any, integrationId);
        if (detected) {
          const prev = (config as any).centralManagement as { wtp?: boolean; fsw?: boolean } | undefined;
          const changed = !prev || prev.wtp !== detected.wtp || prev.fsw !== detected.fsw;
          (config as any).centralManagement = detected;
          // Read-modify-write against the freshest row so a concurrent
          // operator edit isn't clobbered by this run's config snapshot.
          const fresh = await prisma.integration.findUnique({ where: { id: integrationId }, select: { config: true } });
          await prisma.integration.update({
            where: { id: integrationId },
            data: { config: { ...((fresh?.config ?? {}) as Record<string, unknown>), centralManagement: detected } as any },
          });
          if (changed) {
            logEvent({
              action: "integration.central_management",
              resourceType: "integration",
              resourceId: integrationId,
              resourceName: integrationName,
              actor,
              message: `[${integrationName}] FMG central management detected — APs: ${detected.wtp ? "central" : "per-device"}, FortiSwitches: ${detected.fsw ? "central" : "per-device"}`,
              details: detected as any,
            });
          }
        }
      } catch { /* best-effort — detection never blocks discovery */ }
      // Build the warm cache before dispatch — every firewall Asset row
      // discovered by THIS integration that the monitor loop most recently
      // saw as "up" gets its cached management IP fed to discovery so the
      // direct-mode worker pool fills from t=0 instead of dripping in
      // behind the FMG-serial mgmt-IP resolver. Cold-cache (first run, or
      // monitor unseeded) returns 0 rows and the resolver path runs as
      // before. Skipped in proxy mode.
      const warmCacheIps = await buildFmgWarmCacheIps(integrationId, config);
      // ARP presence sweep targets (opt-in): per-FortiGate reserved-IP lists,
      // swept by processDevice right before each device's ARP-table read.
      const arpSweepTargets = await buildArpSweepTargets(integrationId, config);
      discoveryResult = await fortimanager.discoverDhcpSubnets(config as any, ac.signal, onProgress, integration.pollInterval ?? 24, onDeviceComplete, integrationId, warmCacheIps, arpSweepTargets.size > 0 ? arpSweepTargets : undefined, scope?.kind === "fmg-device" ? scope.deviceName : undefined);
      // Skip Phase 2 (stale deprecation) if the run was aborted — an aborted
      // run shouldn't take destructive actions, even though the FMG device
      // roster used for deprecation is captured up front (not per-device).
      if (!ac.signal.aborted) {
        // Full run: "finalize" — deprecation + DNS/OUI + fleet-wide reconciles,
        // once all devices have been synced. Scoped run: "finalize-scoped" —
        // ONLY the per-controller FortiSwitch/FortiAP decommission (Phase 2b);
        // the roster-based sweeps would see a one-device fleet and mass-
        // deprecate/decommission everything else. When the scoped gate's
        // switch AND AP inventory queries both came back empty/failed, 2b is
        // a guaranteed no-op — skip the sync call (and its fleet-scale
        // preload queries) entirely.
        const finalizeMode: "finalize" | "finalize-scoped" = scope ? "finalize-scoped" : "finalize";
        const scopedFinalizeIsNoop = scope !== undefined
          && (discoveryResult.switchInventoriedDevices?.length ?? 0) === 0
          && (discoveryResult.apInventoriedDevices?.length ?? 0) === 0;
        if (!scopedFinalizeIsNoop) {
          const r = await syncDhcpSubnets(integrationId, integrationName, integration.type, discoveryResult, actor, finalizeMode, ac.signal);
          syncTotals.deprecated.push(...r.deprecated);
          syncTotals.decommissionedSwitches.push(...(r.decommissionedSwitches || []));
          syncTotals.decommissionedAps.push(...(r.decommissionedAps || []));
        }
      }
    }

    // This one line gates the four post-sync passes below — agent
    // auto-deploy, interface/storage auto-monitor, presence verification and
    // the address-book directory sync — i.e. the entire per-class Monitoring
    // tab for an asset-only type. (The fourth is narrower still: only the two
    // DIRECTORY types have a directory of people to sync.)
    const assetsOnly = integration.type === "entraid" || integration.type === "activedirectory"
      || integration.type === "vcenter" || integration.type === "azurearc";

    // ── AD/Entra post-sync passes (agent auto-deploy + interface/storage
    // auto-monitor) ──────────────────────────────────────────────────────────
    // Sibling to syncDhcpSubnets' Phase 2c (FMG/FortiGate interface auto-monitor),
    // which never runs for these assets-only integrations. Runs only when the
    // sync completed (not aborted). Each pass is wrapped so a failure logs and
    // continues — neither poisons the discovery run's success/abort accounting.
    if (assetOnlyPostSyncPassesEnabled({ assetsOnly, scoped: scope !== undefined, aborted: ac.signal.aborted })) {
      // 1) Agent auto-deploy FIRST so newly-discovered, agent-less devices get
      //    the Polaris Agent kicked off this cycle; their interface/storage
      //    samples (and thus the pins below) land on the NEXT discovery.
      await runWorkstationServerAgentAutoDeploy(integrationId, integrationName, integration.type, config, actor)
        .catch((err: any) => {
          logEvent({ action: "agent.autodeploy.error", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level: "error", message: `Agent auto-deploy failed for "${integrationName}": ${err?.message || "Unknown error"}` });
        });
      // 2) Interface + storage auto-monitor — pin whatever samples exist now
      //    (strictly additive, self-healing across cycles).
      await applyWorkstationServerAutoMonitor(integrationId, integrationName, config, actor);
      // 3) Network-presence verification — directory timestamps no longer
      //    write Asset.lastSeen, so this pass establishes presence from
      //    agent-heartbeat / monitor-probe signals with an ICMP fallback.
      //    Read-only against the targets; default on (config.verifyPresence).
      if ((config as Record<string, unknown>).verifyPresence !== false) {
        await presenceVerification
          .runPresenceVerification({
            integrationId,
            integrationName,
            pollIntervalHours: integration.pollInterval,
            actor,
            signal: ac.signal,
          })
          .catch((err: any) => {
            logEvent({ action: "integration.presence_verification.error", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level: "error", message: `Presence verification failed for "${integrationName}": ${err?.message || "Unknown error"}` });
          });
      }
      // 4) Address-book directory (GAL) sync — business rule 35. LAST, so a
      //    directory outage or a revoked Graph grant can never affect the
      //    asset passes above; and only for the two integration types that
      //    have a directory of PEOPLE (vCenter and Arc do not).
      //
      //    Opt-in (config.enableDirectorySync, default off) and deliberately
      //    NOT its own scheduler job: the run it belongs to already holds the
      //    credentials, already has an interval an operator chose, and already
      //    reports its progress — a second timer would be a second thing to
      //    reason about for no gain.
      if (
        (integration.type === "entraid" || integration.type === "activedirectory") &&
        (config as Record<string, unknown>).enableDirectorySync === true
      ) {
        const galStart = Date.now();
        await directorySync
          .runDirectorySync({
            integrationId,
            integrationName,
            integrationType: integration.type,
            config: config as Record<string, unknown>,
            actor,
            signal: ac.signal,
          })
          .then(() => observeDiscoveryPhase(integrationType, "gal-sync", (Date.now() - galStart) / 1000))
          .catch((err: any) => {
            // The message may carry a transport error but never a person: the
            // readers log integration ids, not directory content.
            logEvent({ action: "integration.directory_sync.error", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level: "error", message: `Address-book directory sync failed for "${integrationName}": ${err?.message || "Unknown error"}` });
          });
      }
    }

    // ── Fortinet post-sync pass: auto-reserve managed switch/AP addresses ────
    // Opt-in (config.pushReservations + config.autoReserveFortinetInfra), and
    // deliberately AFTER the sync: it acts on `dhcpBinding`, which the Phase 5
    // infra branch has just refreshed, so a device that stopped leasing is no
    // longer a candidate by the time this runs. Wrapped like the other post-sync
    // passes — a device-write failure must not poison the run's accounting.
    if (!assetsOnly && !ac.signal.aborted) {
      await runInfraReservationPush({
        integrationId,
        integrationName,
        actor,
        signal: ac.signal,
      }).catch((err: any) => {
        logEvent({ action: "reservation.infra.auto_push.error", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level: "error", message: `Auto-reserve of managed device addresses failed for "${integrationName}": ${err?.message || "Unknown error"}` });
      });
    }

    if (ac.signal.aborted) {
      const abortSuffix = assetsOnly ? "" : " (stale-subnet deprecation skipped)";
      logEvent({ action: "integration.discover.aborted", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level: "warning", message: `${label} ${kindLabel} aborted for "${integrationName}" — ${syncTotals.created.length} created, ${syncTotals.updated.length} updated, ${syncTotals.skipped.length} skipped${abortSuffix}` });
      recordDiscovery(integrationType, (Date.now() - runStartedAt) / 1000, "aborted");
      await finishRun(integrationId, "aborted");
    } else {
      const deprecatedSuffix = assetsOnly ? "" : `, ${syncTotals.deprecated.length} deprecated`;
      const decomSwSuffix = syncTotals.decommissionedSwitches.length > 0 ? `, ${syncTotals.decommissionedSwitches.length} FortiSwitch(es) decommissioned` : "";
      const decomApSuffix = syncTotals.decommissionedAps.length      > 0 ? `, ${syncTotals.decommissionedAps.length} FortiAP(s) decommissioned`      : "";
      const decomAssetSuffix = syncTotals.decommissionedAssets.length > 0 ? `, ${syncTotals.decommissionedAssets.length} asset(s) decommissioned` : "";
      logEvent({ action: "integration.discover.completed", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, message: `${label} ${kindLabel} completed for "${integrationName}" — ${syncTotals.created.length} created, ${syncTotals.updated.length} updated, ${syncTotals.skipped.length} skipped${deprecatedSuffix}${decomSwSuffix}${decomApSuffix}${decomAssetSuffix}` });
      // Record overall duration sample for slow-run detection. Aborts and
      // errors are intentionally not recorded — a failed run would poison
      // the rolling average used to compute the "slow" threshold. Scoped
      // single-device runs are skipped for the same reason in the other
      // direction: a seconds-long run would drag the full-run baseline down
      // and false-flag future full runs as slow. (The per-device sample in
      // onProgress still records — that baseline is per-device and valid.)
      if (!scope) {
        recordSample(integrationId, Date.now() - runStartedAt).catch(() => {});
        // A successful full run resets the auto-abort loop-breaker — the fresh
        // sample above is the re-baseline the exemption existed to obtain.
        clearAutoAbortState(integrationId).catch(() => {});
      }
      recordDiscovery(integrationType, (Date.now() - runStartedAt) / 1000, "success");
      // Refresh the precomputed "By name" checklist sources for the Auto-Monitor
      // cards so the edit modal loads them instantly (no fleet-wide DISTINCT ON on
      // open). Best-effort — a cache failure must never fail an otherwise-good run.
      const aggregateComputedAt = new Date().toISOString();
      await Promise.all([
        autoMonitor.computeAndCacheInterfaceAggregate(integrationId, integrationType, aggregateComputedAt)
          .catch((e: any) => logEvent({ action: "integration.aggregate_cache.error", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level: "warning", message: `Interface aggregate cache refresh failed for "${integrationName}": ${e?.message || "unknown error"}` })),
        autoMonitorStorage.computeAndCacheStorageAggregate(integrationId, integrationType, aggregateComputedAt)
          .catch((e: any) => logEvent({ action: "integration.aggregate_cache.error", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level: "warning", message: `Storage aggregate cache refresh failed for "${integrationName}": ${e?.message || "unknown error"}` })),
      ]);
      await finishRun(integrationId, "completed");
    }
  } catch (err: any) {
    if (err.name !== "AbortError") {
      logEvent({ action: "integration.discover.error", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level: "error", message: `${label} ${kindLabel} failed for "${integrationName}": ${err.message || "Unknown error"}` });
      recordDiscovery(integrationType, (Date.now() - runStartedAt) / 1000, "failure");
      await finishRun(integrationId, "error");
    } else {
      // AbortError caught here means the abort raced past the inner
      // ac.signal.aborted branch above. Count it the same way.
      recordDiscovery(integrationType, (Date.now() - runStartedAt) / 1000, "aborted");
      await finishRun(integrationId, "aborted");
    }
  } finally {
    disarmCancelWatchdog();
    clearInterval(cancelTimer);
    clearInterval(heartbeatTimer);
  }
}

// Post-sync interface + storage auto-monitor pass for AD/Entra workstation +
// server classes. Sibling to syncDhcpSubnets' Phase 2c (which is FMG/FortiGate-
// only). For each class block, resolve its autoMonitorInterfaces /
// autoMonitorStorage selection against the assets' latest samples and union the
// matches into Asset.monitoredInterfaces / monitoredStorage (strictly additive).
// Each apply is wrapped so one class/stream failing doesn't skip the others.
async function applyWorkstationServerAutoMonitor(
  integrationId: string,
  integrationName: string,
  config: Record<string, unknown>,
  actor: string,
): Promise<void> {
  const cfg = (config ?? {}) as Record<string, any>;
  for (const [klass, blockKey] of [
    ["workstation",     "workstationMonitor"],
    ["server",          "serverMonitor"],
    ["virtual_machine", "vmMonitor"], // vCenter VM class — klass name only, assets are typed "server" (ESXi hosts carry no auto-monitor)
  ] as const) {
    const block = cfg[blockKey];
    if (!block) continue;
    // Interfaces (reuse the FMG service — class-agnostic resolver).
    const ifSel = autoMonitor.coerceLegacySelection(block.autoMonitorInterfaces ?? null);
    if (ifSel) {
      try {
        const r = await autoMonitor.applyAutoMonitorForClass(integrationId, klass, ifSel, actor);
        if (r.interfacesAdded > 0) {
          logEvent({ action: "integration.auto_monitor_interfaces.applied", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, message: `Auto-monitor interfaces applied for "${integrationName}" (${klass}) — ${r.devices} device(s), ${r.interfacesAdded} interface(s) added`, details: { class: klass, devices: r.devices, interfacesAdded: r.interfacesAdded } });
        }
      } catch (err: any) {
        logEvent({ action: "integration.auto_monitor_interfaces.error", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level: "error", message: `Auto-monitor interfaces (${klass}) failed for "${integrationName}": ${err?.message || "Unknown error"}` });
      }
    }
    // Storage (new service).
    const stSel = (block.autoMonitorStorage ?? null) as autoMonitorStorage.AutoMonitorStorageSelection;
    if (stSel) {
      try {
        const r = await autoMonitorStorage.applyAutoMonitorStorageForClass(integrationId, klass, stSel, actor);
        if (r.mountsAdded > 0) {
          logEvent({ action: "integration.auto_monitor_storage.applied", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, message: `Auto-monitor storage applied for "${integrationName}" (${klass}) — ${r.devices} device(s), ${r.mountsAdded} mount(s) added`, details: { class: klass, devices: r.devices, mountsAdded: r.mountsAdded } });
        }
      } catch (err: any) {
        logEvent({ action: "integration.auto_monitor_storage.error", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level: "error", message: `Auto-monitor storage (${klass}) failed for "${integrationName}": ${err?.message || "Unknown error"}` });
      }
    }
  }
}

// Post-sync agent auto-deploy pass for AD/Entra workstation + server classes.
// Reads each class block's `agentDeploy` config; if neither class opts in, this
// is a no-op. Run-level preconditions (HTTPS cert + callback URL) are checked
// ONCE up front so a misconfigured server skips with a single warning rather
// than minting rows that all fail enrollment. Per-class deploy is delegated to
// agentAutoDeployService (eligibility / inference / bounded concurrency / audit).
async function runWorkstationServerAgentAutoDeploy(
  integrationId: string,
  integrationName: string,
  integrationType: string,
  config: Record<string, unknown>,
  actor: string,
): Promise<void> {
  const cfg = (config ?? {}) as Record<string, any>;
  const classes = [
    { klass: "workstation" as const,     assetType: "workstation",     deploy: cfg.workstationMonitor?.agentDeploy },
    { klass: "server" as const,          assetType: "server",          deploy: cfg.serverMonitor?.agentDeploy },
    // vCenter VMs are guest OSes — agent deploy applies. ESXi hosts never
    // get the agent (no hostMonitor.agentDeploy exists in the schema).
    // The klass keeps its vm name; the assets are typed "server" (scoped to
    // this integration by discoveredByIntegrationId in the deploy service).
    { klass: "virtual_machine" as const, assetType: "server", deploy: cfg.vmMonitor?.agentDeploy },
  ].filter((c) => c.deploy?.enabled === true);
  if (classes.length === 0) return;

  const pre = await agentAutoDeploy.checkAutoDeployPreconditions();
  if (!pre.ok) {
    logEvent({ action: "agent.autodeploy.skipped", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level: "warning", message: `Agent auto-deploy skipped for "${integrationName}" — ${pre.reason}` });
    return;
  }

  for (const c of classes) {
    await agentAutoDeploy.runAutoDeployForClass({
      integrationId,
      integrationName,
      integrationType,
      klass: c.klass,
      assetType: c.assetType,
      cfg: c.deploy,
      actor,
    });
  }
}

// ─── Conflict detection helper ────────────────────────────────────────────────

interface ProposedReservationData {
  hostname?: string | null;
  owner?: string | null;
  projectRef?: string | null;
  notes?: string | null;
  sourceType: string;
}

/**
 * Which of hostname / owner / projectRef a conflict should be raised on.
 *
 * Default ("differs") — any difference is operator-reviewable. This is the
 * manual-reservation case: discovery must never overwrite an operator-typed
 * row, so every divergence gets a card.
 *
 * "fill-only" — the existing row's own non-empty values WIN OUTRIGHT and are
 * never offered for review; only a blank field that the proposal could fill is
 * worth an operator's time. Used for the VIP ↔ DHCP collision, where the same
 * IP is both a FortiGate VIP and a DHCP lease/reservation: the VIP is
 * load-bearing firewall config, so its owner / projectRef take precedence over
 * whatever the DHCP side reports. Accepting a merge conflict has only ever
 * filled blanks (see conflictResolutionService's merge mode), so a card whose
 * fields are all populated offered the operator no decision — just noise on
 * every VIP that also holds a lease.
 *
 * Exported for unit tests; the conflict write itself needs a DB.
 */
export function computeConflictFields(
  proposed: { hostname?: string | null; owner?: string | null; projectRef?: string | null },
  existing: { hostname?: string | null; owner?: string | null; projectRef?: string | null },
  mode: "differs" | "fill-only" = "differs",
): string[] {
  const isBlank = (v?: string | null): boolean => v == null || v.trim() === "";
  const fields: Array<"hostname" | "owner" | "projectRef"> = ["hostname", "owner", "projectRef"];
  return fields.filter((f) => {
    const p = proposed[f] ?? null;
    const e = existing[f] ?? null;
    if (mode === "fill-only") return isBlank(e) && !isBlank(p);
    return p !== e;
  });
}

async function upsertConflict(
  reservationId: string,
  integrationId: string,
  proposed: ProposedReservationData,
  existing: { hostname?: string | null; owner?: string | null; projectRef?: string | null; notes?: string | null },
  mode: "differs" | "fill-only" = "differs",
): Promise<void> {
  const conflictFields = computeConflictFields(proposed, existing, mode);
  if (conflictFields.length === 0) {
    // Nothing left to review — auto-resolve any stale pending conflict on this
    // reservation that was raised by a previous run when they differed. Without
    // this, a conflict card lingers in the UI showing two identical-looking
    // values because conflictFields was frozen at upsert time. This is also the
    // cleanup path for VIP ↔ DHCP cards raised before "fill-only" existed: the
    // next discovery cycle re-evaluates them and closes them out.
    await prisma.conflict.updateMany({
      where: { reservationId, status: "pending" },
      data: { status: "rejected", resolvedBy: "auto", resolvedAt: new Date() },
    });
    return;
  }

  // Single round-trip that covers both lookups upsertConflict needs:
  //
  //   1. Existing pending conflict on this reservation (drives the
  //      update-vs-create branch below).
  //   2. Merge-type 30-day re-raise guard — once the operator has resolved
  //      a vip/dhcp_* conflict on this reservation within the last 30 days,
  //      we suppress re-raising on every subsequent discovery cycle.
  //      Without this guard, the existing-vs-proposed values stay different
  //      forever (the "fold in blanks only" merge intentionally leaves the
  //      existing values alone), so upsertConflict would otherwise re-create
  //      the same conflict every poll.
  //
  // Previously these were two sequential findFirst calls per invocation.
  // Phase 5 instrumentation showed upsertConflict firing 60-80 times per
  // cycle on big FortiGates whose subnets carry many operator-typed manual
  // reservations — 120-160 SELECTs per cycle just to find "no, nothing
  // pending, and yes the operator already resolved this within 30 days."
  // Collapsing to one findMany halves the round-trip count.
  const MERGE_TYPES = new Set(["vip", "dhcp_reservation", "dhcp_lease"]);
  const wantsMergeGuard = MERGE_TYPES.has(proposed.sourceType);
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const orClauses: Array<Record<string, unknown>> = [
    { status: "pending" },
  ];
  if (wantsMergeGuard) {
    orClauses.push({
      status: { in: ["accepted", "rejected"] },
      proposedSourceType: { in: ["vip", "dhcp_reservation", "dhcp_lease"] },
      resolvedAt: { gte: cutoff },
    });
  }
  const candidates = await prisma.conflict.findMany({
    where: { reservationId, OR: orClauses },
    // Bounded result set: at most one pending row (by upsert invariant) plus
    // any matching resolved rows within 30 days. We only need to know whether
    // each kind exists, so take a small cap rather than reading every
    // historical conflict for the reservation.
    take: 4,
    orderBy: { resolvedAt: "desc" },
  });
  const existingConflict = candidates.find((c) => c.status === "pending") ?? null;
  if (!existingConflict && wantsMergeGuard) {
    const recentResolved = candidates.some((c) => c.status !== "pending");
    if (recentResolved) return;
  }

  const conflictData = {
    integrationId,
    proposedHostname: proposed.hostname ?? null,
    proposedOwner: proposed.owner ?? null,
    proposedProjectRef: proposed.projectRef ?? null,
    proposedNotes: proposed.notes ?? null,
    proposedSourceType: proposed.sourceType,
    conflictFields,
  };

  if (existingConflict) {
    await prisma.conflict.update({ where: { id: existingConflict.id }, data: conflictData });
  } else {
    await prisma.conflict.create({ data: { reservationId, ...conflictData } });
  }
}

// ─── Batch helper ────────────────────────────────────────────────────────────
// Bounded fan-out so DB writes don't overwhelm the connection pool. Since the
// 2026-08 dedup this rides the shared utils/concurrency mapper: a rolling
// window of BATCH_SIZE in flight (strictly gentler than the old chunk
// barrier — same cap, no convoy behind a slow chunk), settled results in
// input order.
const BATCH_SIZE = 50;
async function batchSettled<T>(items: T[], fn: (item: T) => Promise<any>): Promise<PromiseSettledResult<any>[]> {
  return mapSettledWithConcurrency(items, BATCH_SIZE, fn);
}

// ─── FortiGate firewall AssetSource helpers (Phase 2 cutover) ──────────────

// Source-shaped observed blob written to the "fortigate-firewall" AssetSource
// row for each discovered FortiGate. Mirrors the per-source JSON shape
// sketched in polaris-monitoring-discovery -> discovery-fortinet.md ("Per-source observed shapes / sourceKind:
// fortigate-firewall"). The firewall's lookup mechanism stays serial-number
// based on Asset.serialNumber (in-memory `findBySerial` index) — this row
// captures the source perspective for the asset details modal without
// changing the discovery hot path.
function buildFortigateFirewallObservedBlob(
  device: {
    name?: string;
    hostname?: string;
    serial?: string;
    model?: string;
    mgmtIp?: string;
    mgmtMac?: string;
    interfaceMacs?: string[];
    osVersion?: string;
    latitude?: number;
    longitude?: number;
    // FMG per-device metavariables `Latitude` / `Longitude` (FMG only;
    // undefined on standalone-FortiGate-discovered firewalls). Operator-
    // managed coord convention; consumed by assetProjection's tier-2 rule.
    metavarLatitude?: number;
    metavarLongitude?: number;
    // Raw SNMP sysLocation pulled via REST during Phase 11.5 when
    // `fortigateMonitor.pullSnmpLocation` is on. Stamped here so the asset
    // details General tab can surface it via projection.
    snmpLocation?: string | null;
    // Nominatim-geocoded coords derived from `snmpLocation`. Stamped in
    // Phase 11.5 after geocode succeeds. assetProjection's tier-1 rule
    // picks these up as authoritative when the pair is valid.
    snmpGeocodedLatitude?: number | null;
    snmpGeocodedLongitude?: number | null;
    // FMG per-device address metavariable string (operator-named via
    // `fortigateMonitor.addressMetavar`; FMG-only). Projected to
    // Asset.learnedAddress and shown as "Address" on the General tab.
    metavarAddress?: string | null;
  },
  integrationType: "fortimanager" | "fortigate",
  syncedAt: Date,
  // HA member context. Omitted on standalone firewalls. When the discovered
  // device is an HA cluster, every member gets its own AssetSource row with
  // a per-member observed blob — the `serial`, `hostname`, `haRole`, and
  // `haPeerSerial` fields here are member-specific (the standby member's
  // blob has its own serial / its own hostname / haRole "secondary" /
  // haPeerSerial pointing at the current primary).
  ha?: {
    haMode: "a-p" | "a-a";
    haRole: "primary" | "secondary";
    haPeerSerial: string;
  },
): Record<string, unknown> {
  return {
    kind: "fortigate-firewall",
    syncedAt: syncedAt.toISOString(),
    serial: device.serial || null,
    hostname: device.hostname || device.name || null,
    model: device.model || null,
    osVersion: device.osVersion || null,
    mgmtIp: device.mgmtIp || null,
    // Recorded for fidelity (Sources tab). NOT consumed by projection —
    // macAddress is written directly onto the Asset, not projection-owned.
    mgmtMac: device.mgmtMac || null,
    interfaceMacs: device.interfaceMacs && device.interfaceMacs.length ? device.interfaceMacs : null,
    latitude: Number.isFinite(device.latitude) ? device.latitude : null,
    longitude: Number.isFinite(device.longitude) ? device.longitude : null,
    metavarLatitude: Number.isFinite(device.metavarLatitude) ? device.metavarLatitude : null,
    metavarLongitude: Number.isFinite(device.metavarLongitude) ? device.metavarLongitude : null,
    snmpLocation: typeof device.snmpLocation === "string" && device.snmpLocation ? device.snmpLocation : null,
    snmpGeocodedLatitude: Number.isFinite(device.snmpGeocodedLatitude) ? device.snmpGeocodedLatitude : null,
    snmpGeocodedLongitude: Number.isFinite(device.snmpGeocodedLongitude) ? device.snmpGeocodedLongitude : null,
    metavarAddress: typeof device.metavarAddress === "string" && device.metavarAddress ? device.metavarAddress : null,
    managedBy: integrationType,
    ...(ha
      ? {
          haMode: ha.haMode,
          haRole: ha.haRole,
          haPeerSerial: ha.haPeerSerial,
        }
      : {}),
  };
}

// Upsert the fortigate-firewall AssetSource row for a discovered firewall.
// Best-effort: failures are logged via syncLog but don't unwind the Asset
// write that already landed.
// `lastSeen` = null means the gate was OFFLINE in FMG this cycle (cached-CMDB
// pull): refresh observed/syncedAt but do NOT advance the row's lastSeen —
// per the schema comment it's "last time this source reported the device as
// active", and a cached read isn't that. On create the column is non-nullable,
// so a first-seen-offline gate stamps syncedAt once and freezes until a live
// cycle.
async function upsertFortigateFirewallAssetSource(
  assetId: string,
  integrationId: string,
  serial: string,
  observed: Record<string, unknown>,
  syncedAt: Date,
  lastSeen: Date | null,
): Promise<void> {
  await prisma.assetSource.upsert({
    where: { sourceKind_externalId: { sourceKind: "fortigate-firewall", externalId: serial } },
    create: {
      assetId,
      sourceKind: "fortigate-firewall",
      externalId: serial,
      integrationId,
      observed: observed as any,
      inferred: false,
      syncedAt,
      firstSeen: lastSeen ?? syncedAt,
      lastSeen: lastSeen ?? syncedAt,
    },
    update: {
      assetId,
      integrationId,
      observed: observed as any,
      inferred: false,
      syncedAt,
      ...(lastSeen ? { lastSeen } : {}),
    },
  });
  // Pre-`fgt:`-tag firewalls were classified as "manual" by the phase-1
  // backfill (they had no recognized assetTag prefix). Once we've written
  // the proper fortigate-firewall row, drop the phantom manual row keyed on
  // this asset's id so the source list reflects truth.
  //
  // This delete is NOT a spent migration cleanup and must stay per-device
  // (checked 2026-09-02, when an efficiency pass proposed hoisting it into a
  // one-shot job): `deriveSourcesFromAsset`'s manual fallback is LIVE, and
  // since the assetTag writes were retired it fires on the Asset.create of
  // every newly discovered firewall — so the row this clears is minted DURING
  // the same run, which no pre-run snapshot can predict. Dropping it would
  // leave a phantom `manual` source on each new gate, outranking nothing but
  // visibly wrong in the Sources column and in projection provenance. The
  // vCenter and Arc syncs avoid the row instead, by suppressing the fallback
  // on their own tags (see rules 3 / 3b there).
  await prisma.assetSource.deleteMany({
    where: { assetId, sourceKind: "manual", externalId: assetId },
  });
  // Phase 3b.1 cutover: drift detection no longer fires — the
  // syncDhcpSubnets caller projects from sources and uses the result as
  // the Asset write payload, so the Asset row matches the projection by
  // construction.
}

// Source-shaped observed blob for managed FortiSwitch assets. Mirrors the
// per-source JSON shape sketched in polaris-monitoring-discovery -> discovery-fortinet.md ("Per-source observed shapes
// / sourceKind: fortiswitch"). Companion to the firewall blob above.
function buildFortiswitchObservedBlob(
  sw: { device?: string; deviceSerial?: string; name?: string; serial?: string; ipAddress?: string; fgtInterface?: string; osVersion?: string; joinTime?: number; state?: string; connected?: boolean; baseMac?: string; description?: string | null },
  syncedAt: Date,
): Record<string, unknown> {
  return {
    kind: "fortiswitch",
    syncedAt: syncedAt.toISOString(),
    serial: sw.serial || null,
    switchId: sw.name || null,
    model: "FortiSwitch",
    osVersion: sw.osVersion || null,
    mgmtIp: sw.ipAddress || null,
    // Admin description from the managed-switch CMDB — carries a:/b:/f:/r:/jb:
    // location codes (utils/locationCodes.ts). Sources-tab truth; the
    // projected copy lives on fortinetTopology.deviceDescription.
    description: sw.description || null,
    // Management MAC of the switch (FortiLink-peer interface). Cross-joined
    // at discovery time from the detected-device MAC table. Cleared to null
    // when the switch wasn't represented in any is_fortilink_peer row.
    baseMac: sw.baseMac || null,
    controllerFortigate: sw.device || null,
    controllerSerial: sw.deviceSerial || null,
    uplinkInterface: sw.fgtInterface || null,
    state: sw.state || null,
    connected: typeof sw.connected === "boolean" ? sw.connected : null,
    joinTime: Number.isFinite(sw.joinTime) && sw.joinTime ? new Date(sw.joinTime * 1000).toISOString() : null,
  };
}

// Source-shaped observed blob for managed FortiAP assets.
function buildFortiapObservedBlob(
  ap: {
    device?: string;
    deviceSerial?: string;
    name?: string;
    serial?: string;
    model?: string;
    ipAddress?: string;
    baseMac?: string;
    status?: string;
    authorizationState?: string;
    profile?: string;
    osVersion?: string;
    peerSwitch?: string;
    peerPort?: string;
    peerVlan?: number;
    peerSource?: "lldp" | "detected-device";
    meshUplink?: "ethernet" | "mesh";
    parentApSerial?: string;
    apUplinkInterface?: string;
    cpuPct?: number;
    memFreeMb?: number;
    memTotalMb?: number;
    sensorTemperatures?: Array<{ name: string; celsius: number }>;
    description?: string | null;
  },
  syncedAt: Date,
): Record<string, unknown> {
  return {
    kind: "fortiap",
    syncedAt: syncedAt.toISOString(),
    serial: ap.serial || null,
    name: ap.name || null,
    model: ap.model || null,
    osVersion: ap.osVersion || null,
    mgmtIp: ap.ipAddress || null,
    baseMac: ap.baseMac || null,
    status: ap.status || null,
    // Admin description (wtp `comment`) — carries a:/b:/f:/r:/jb: location
    // codes. Mirrors the fortiswitch blob's `description` field.
    description: ap.description || null,
    // Controller admission state ("authorized" / "discovered" / ...) —
    // mirrors the fortiswitch blob's `state` field.
    state: ap.authorizationState || null,
    // AP profile the controller binds this WTP to — the object that decides
    // its radios, SSIDs and power.
    profile: ap.profile || null,
    controllerFortigate: ap.device || null,
    controllerSerial: ap.deviceSerial || null,
    parentSwitch: ap.peerSwitch || null,
    parentPort: ap.peerPort || null,
    parentVlan: typeof ap.peerVlan === "number" ? ap.peerVlan : null,
    // AP's own local port (lan1, lan2, wbh0 …) from wan_status.interface
    // or, when wan_status is empty, the LLDP entry's local_port. lan*
    // are physical Ethernet, wbh* are virtual wireless bridge.
    uplinkInterface: ap.apUplinkInterface ?? null,
    // Provenance for the parentSwitch/parentPort pair: "lldp" (authoritative,
    // from the AP's own LLDP table) or "detected-device" (FortiSwitch MAC
    // table fallback).
    peerSource: ap.peerSource ?? null,
    // Mesh topology — populated for wireless-mesh leaves.
    meshUplink: ap.meshUplink ?? null,
    parentApSerial: ap.parentApSerial ?? null,
    // Live telemetry snapshot at the moment of discovery. Not authoritative
    // for charts (the telemetry cadence re-queries the same endpoint), but
    // surfaced on the Sources tab so operators can see fresh values
    // immediately after a discovery run.
    cpuPct: typeof ap.cpuPct === "number" ? ap.cpuPct : null,
    memFreeMb: typeof ap.memFreeMb === "number" ? ap.memFreeMb : null,
    memTotalMb: typeof ap.memTotalMb === "number" ? ap.memTotalMb : null,
    sensorTemperatures: ap.sensorTemperatures ?? null,
  };
}

// Device admin description stamp for managed FortiSwitches/FortiAPs. The
// description carries a:/b:/f:/r:/jb: location codes (see
// utils/locationCodes.ts); it's stamped onto fortinetTopology.deviceDescription
// unconditionally every cycle for the Device Map's code resolution
// (Asset.description → deviceDescription). Asset.notes is operator-only:
// the former description→notes mirror (and its notesSyncedFrom provenance
// marker) was removed 2026-07 — discovery seeds notes with the
// auto-discovered boilerplate at CREATION only and never writes them again.
function buildDeviceDescriptionStamp(
  description: string | null | undefined,
): { deviceDescription: string | null } {
  const device = typeof description === "string" && description.trim() ? description.trim() : null;
  return { deviceDescription: device };
}

// Generic upsert for the fortiswitch/fortiap source kinds. Same shape as the
// firewall helper — best-effort, sweeps any phantom "manual" source row that
// the phase-1 backfill may have produced before this sourceKind was wired.
// Exported for tests: the `priorObserved` fast path must produce the same row
// as the DB-read path it replaces, and the field it guards (osVersion) is the
// one the 2026-07-14 fortiap incident blanked.
export async function upsertFortinetInfraAssetSource(
  sourceKind: "fortiswitch" | "fortiap",
  assetId: string,
  integrationId: string,
  serial: string,
  observed: Record<string, unknown>,
  syncedAt: Date,
  lastSeen: Date,
  integrationName?: string | null,
  /** The row's CURRENT observed blob, when the caller already has it from a
   *  preload — lets the absent-osVersion carry-forward below skip its read.
   *  `undefined` means "not supplied"; `null` means "no such row". */
  priorObserved?: Record<string, unknown> | null,
): Promise<void> {
  // Which FMG / FortiGate integration manages the controller. Only consumed by
  // the optional `<integration name>:<fortigate name>` rendering of the Sources
  // column — see buildFortigateEndpointObservedBlob's note.
  observed.integrationName = integrationName || null;
  // osVersion "absent ≠ wipe": a managed_ap/managed-switch row can arrive
  // without a usable firmware version (os_version missing mid-rejoin, or a
  // cached-format fallback rejected by isCanonicalFortiapVersion). Keep the
  // previous scrape's value instead of blanking it — same convention as the
  // AP LLDP persist. The read only fires on the empty-version case, so the
  // steady-state cost at fleet scale is zero extra queries.
  if (!observed.osVersion) {
    const prior = priorObserved !== undefined
      ? priorObserved
      : (await prisma.assetSource.findUnique({
          where: { sourceKind_externalId: { sourceKind, externalId: serial } },
          select: { observed: true },
        }))?.observed as Record<string, unknown> | null ?? null;
    const prevVersion = prior?.osVersion;
    if (typeof prevVersion === "string" && prevVersion) observed.osVersion = prevVersion;
  }
  await prisma.assetSource.upsert({
    where: { sourceKind_externalId: { sourceKind, externalId: serial } },
    create: { assetId, sourceKind, externalId: serial, integrationId, observed: observed as any, inferred: false, syncedAt, firstSeen: lastSeen, lastSeen },
    update: { assetId, integrationId, observed: observed as any, inferred: false, syncedAt, lastSeen },
  });
  // Clears the phantom `manual` row the shadow-write mints on a new switch/AP
  // — live, not a spent migration, and must stay per-device. See the fuller
  // note on the same delete in upsertFortigateFirewallAssetSource.
  await prisma.assetSource.deleteMany({
    where: { assetId, sourceKind: "manual", externalId: assetId },
  });
  // Phase 3b.1 cutover: drift detection no longer fires (see
  // upsertFortigateFirewallAssetSource for rationale).
}

// ─── Asset index — multi-key lookup for MAC, serial, hostname, IP ───────────
class AssetIndex {
  private byId = new Map<string, any>();
  private byMac = new Map<string, any>();       // normalized MAC → asset
  private bySerial = new Map<string, any>();
  private byHostname = new Map<string, any>();   // lowercase hostname → asset
  private byIp = new Map<string, any>();

  constructor(assets: any[]) {
    for (const a of assets) this.add(a);
  }

  add(a: any) {
    this.byId.set(a.id, a);
    if (a.macAddress) this.byMac.set(a.macAddress.toUpperCase(), a);
    if (Array.isArray(a.macAddresses)) {
      for (const m of a.macAddresses as any[]) {
        if (m.mac) this.byMac.set(m.mac.toUpperCase(), a);
      }
    }
    if (a.serialNumber) this.bySerial.set(a.serialNumber, a);
    if (a.hostname) this.byHostname.set(a.hostname.toLowerCase(), a);
    if (a.ipAddress) this.byIp.set(a.ipAddress, a);
  }

  /** Update indexes after modifying an asset in-place */
  reindex(a: any) { this.add(a); }

  /**
   * Drop a deleted asset from every index. Only removes entries still
   * pointing at this exact object — a key another asset has since claimed
   * (via reindex) is left alone.
   */
  remove(a: any) {
    this.byId.delete(a.id);
    const drop = (map: Map<string, any>, key: string | null | undefined) => {
      if (key && map.get(key) === a) map.delete(key);
    };
    drop(this.byMac, a.macAddress ? String(a.macAddress).toUpperCase() : null);
    if (Array.isArray(a.macAddresses)) {
      for (const m of a.macAddresses as any[]) {
        drop(this.byMac, m?.mac ? String(m.mac).toUpperCase() : null);
      }
    }
    drop(this.bySerial, a.serialNumber);
    drop(this.byHostname, a.hostname ? String(a.hostname).toLowerCase() : null);
    drop(this.byIp, a.ipAddress);
  }

  findBySerial(serial: string) { return this.bySerial.get(serial); }

  findByMac(mac: string) { return this.byMac.get(mac.toUpperCase()); }

  findById(id: string) { return this.byId.get(id); }

  /**
   * Broad match: MAC → hostname → IP.
   * Pass `{ allowIpFallback: false }` for ephemeral-identity sources (DHCP leases)
   * where IP recycling would otherwise staple a new MAC onto an unrelated asset.
   */
  findByEntry(mac?: string, hostname?: string, ip?: string, opts: { allowIpFallback?: boolean } = {}): any | undefined {
    const { allowIpFallback = true } = opts;
    if (mac) {
      const norm = mac.toUpperCase().replace(/-/g, ":");
      const hit = this.byMac.get(norm);
      if (hit) return hit;
    }
    if (hostname) {
      const hit = this.byHostname.get(hostname.toLowerCase());
      if (hit) return hit;
    }
    if (ip && allowIpFallback) {
      const hit = this.byIp.get(ip);
      if (hit) return hit;
    }
    return undefined;
  }

  all(): any[] { return [...this.byId.values()]; }
}

/**
 * Sync discovered DHCP subnets into the database.
 * Creates new subnets or updates existing ones with integration/device info.
 * Also creates FortiGate assets and interface IP reservations.
 *
 * Performance: pre-loads all data in 4 parallel queries and builds in-memory
 * indexes for O(1) lookups, avoiding N+1 query patterns. Writes are batched
 * in chunks of 50 via Promise.allSettled for throughput.
 */
// "full"               — run all 9 phases (original batch behaviour, kept for reference)
// "skip-deprecation"   — run phases 1, 3–7 only (used in per-device syncs; no deprecation or DNS/OUI)
// "deprecation-only"   — run only phase 2 (legacy; prefer "finalize")
// "finalize"           — run phase 2 + phases 8–9; called once after all per-device syncs complete
// "finalize-scoped"    — the finalize pass of a single-FortiGate scoped re-discovery: Phase 2b ONLY.
//                        NEVER 2/2a/2c — a scoped run's result carries one device, so the roster-
//                        based sweeps (knownFirewallSerials is built from result.devices, the
//                        PROCESSED chunks, not the raw ADOM roster) would see a one-device fleet
//                        and deprecate/decommission everything else. Phase 2b is inherently safe
//                        scoped: it only judges assets whose controllerFortigate had a SUCCESSFUL
//                        inventory query this run. Phases 8–9/12/13.x are fleet-wide reconciles
//                        owned by full runs (their gates only pass full|finalize).
export type SyncMode = "full" | "skip-deprecation" | "deprecation-only" | "finalize" | "finalize-scoped";

/**
 * vCenter sync mode. "scoped" = the run was narrowed to one VM or host by the
 * asset slide-in's Discover Now.
 */
export type VcenterSyncMode = "full" | "scoped";

/**
 * Pure gate for the three fleet-absence passes in `syncVcenterDevices`.
 * Exported and unit-tested for the same reason as `sweepPhaseEnabled`: each of
 * these reads "absent from the result" as "gone from vCenter", and on a
 * one-device result that is catastrophically wrong.
 *
 *   dependency-edges — delete-replaces `AssetDependencyParent(source="vcenter")`
 *     across EVERY VM asset this integration owns (`priorVmAssetIds`), so a
 *     scoped run would wipe VM→host suppression fleet-wide.
 *   datastores       — a delete-replace keyed on the integration; a scoped
 *     result carries no datastores, so it would empty the table.
 *   stale-sweep      — deletes vanished `vcenter-*` AssetSource rows and
 *     decommissions assets left with no source at all.
 *
 * The stale sweep has a SECOND, independent guard in
 * `vcenterService.vcenterSweepBlockedReason` (which refuses on both `scoped`
 * and `inventoryComplete: false`). Two guards on purpose: that pass
 * decommissions assets, and the failure is silent.
 */
export type VcenterSweepPass = "dependency-edges" | "datastores" | "stale-sweep";

/** Which modes each pass may run under. All three are full-only today; a pass
 *  that becomes safe on a one-device result changes here and nowhere else. */
const VCENTER_PASS_MODES: Record<VcenterSweepPass, VcenterSyncMode[]> = {
  "dependency-edges": ["full"],
  datastores: ["full"],
  "stale-sweep": ["full"],
};

export function vcenterPassEnabled(mode: VcenterSyncMode, pass: VcenterSweepPass): boolean {
  return VCENTER_PASS_MODES[pass].includes(mode);
}

/**
 * Pure gate for the four asset-only post-sync passes in `runDiscovery` — agent
 * auto-deploy, interface/storage auto-monitor, presence verification and the
 * GAL directory sync.
 *
 * Extracted and exported for the same reason as `sweepPhaseEnabled` below:
 * getting it wrong is expensive and invisible. All four read the DB fleet-wide
 * rather than this run's result, so on a SCOPED (single-device) run they would
 * do the entire fleet's work on behalf of one asset — and agent auto-deploy
 * would do worse than waste time: clicking "Discover Now" on one workstation
 * would start agent installs across every agent-less device in the fleet.
 *
 * Same reasoning that keeps Phases 8–9/12/13.x out of a scoped FMG run.
 */
export function assetOnlyPostSyncPassesEnabled(
  args: { assetsOnly: boolean; scoped: boolean; aborted: boolean },
): boolean {
  return args.assetsOnly && !args.scoped && !args.aborted;
}

/**
 * Pure gate for the destructive/apply sweep phases inside syncDhcpSubnets'
 * `mode !== "skip-deprecation"` block. Extracted (and exported) so the
 * mode-to-phase matrix is unit-testable — getting this wrong mass-deprecates
 * subnets or decommissions healthy firewalls on a scoped run.
 */
export function sweepPhaseEnabled(mode: SyncMode, phase: "2" | "2a" | "2b" | "2c"): boolean {
  if (mode === "skip-deprecation") return false;
  if (mode === "finalize-scoped") return phase === "2b";
  return true;
}

/**
 * Pure guard for the Phase 2a stale-firewall sweep: is this asset the standby
 * member of a cluster whose membership NOBODY read this run?
 *
 * A standby has no identity outside its cluster's HA roster — no top-level
 * device name, and (by design) no management IP of its own. So the sweep can
 * only judge it when that roster was actually published: `knownFirewallSerialsUc`
 * says the upstream still knows the peer chassis, and `haRosterPublishedUc`
 * says some device this run enumerated its members. Three outcomes:
 *
 *   - peer serial unknown to the upstream  → the WHOLE cluster is gone; judge
 *     this asset normally (both members are genuinely stale).
 *   - peer known AND its roster published  → membership was read and this
 *     member wasn't in it; it really did leave the cluster. Judge it.
 *   - peer known, roster NOT published     → protected. The cluster is still
 *     configured but nothing enumerated it — an unreachable gate, a skipped
 *     direct read, a FortiOS build whose `ha-peer` endpoint 404s, an FMG API
 *     user without the field. Absence of evidence is not evidence of absence.
 *
 * Both sets are UPPER-CASE serials; the topology serial is folded to match.
 */
export function haStandbyOfUnreadCluster(
  fortinetTopology: unknown,
  knownFirewallSerialsUc: Set<string>,
  haRosterPublishedUc: Set<string>,
): boolean {
  const topo = (fortinetTopology as Record<string, unknown> | null) || null;
  if (!topo || topo.haRole !== "secondary") return false;
  const peer = typeof topo.haPeerSerial === "string" ? topo.haPeerSerial.toUpperCase() : "";
  if (!peer) return false;
  if (!knownFirewallSerialsUc.has(peer)) return false;
  return !haRosterPublishedUc.has(peer);
}

/**
 * Pure matcher for the Phase 2a controller cascade: given a FortiSwitch/FortiAP
 * asset's `fortinetTopology` blob and the set of just-decommissioned FortiGate
 * hostnames (lowercased), return the matched controller name, or null when the
 * child isn't managed by any of them. Case-insensitive on the controller side,
 * mirroring Phase 2a's hostname fallback (FMG device names and FortiOS
 * hostnames can disagree in case for the same device). Extracted (and exported)
 * for the same reason as sweepPhaseEnabled — a wrong match here decommissions
 * healthy switches/APs.
 */
export function cascadeControllerOf(fortinetTopology: unknown, staleFwNamesLc: Set<string>): string | null {
  const topo = (fortinetTopology as Record<string, unknown> | null) || null;
  const controller = typeof topo?.controllerFortigate === "string" ? topo.controllerFortigate : "";
  if (!controller || !staleFwNamesLc.has(controller.toLowerCase())) return null;
  return controller;
}

/**
 * Sighting evidence for the Phase 2b stale FortiSwitch/FortiAP sweep, built
 * once per sync from the discovery result. Serials are fleet-wide (globally
 * unique); hostname and CMDB sightings are keyed by lowercased controller
 * device name so one gate's roster never vouches for another gate's devices.
 */
export interface ManagedDeviceSightings {
  seenSerials: Set<string>;
  seenHostnamesByController: Map<string, Set<string>>;
  cmdbSerialsByController: Map<string, Set<string>>;
}

/**
 * Pure Phase 2b decision: is this previously-discovered FortiSwitch/FortiAP
 * asset still vouched for this run? (Caller has already established that the
 * asset's controller was queried successfully.)
 *
 * Serial is AUTHORITATIVE when the asset has one on file: a same-hostname
 * sighting must never vouch for a different serial. An RMA'd/replaced unit
 * keeps the old unit's hostname, and the former `seenBySerial || seenByHostname`
 * OR let the replacement's name shield the dead serial's asset from
 * decommission forever (prod 2026-08: three RIVERBEND-112F-7 switch assets,
 * distinct serials, only one still on the gate — none ever decommissioned).
 * Hostname is consulted only for assets with no serial on file, and only
 * against sightings on the asset's OWN controller — same per-controller
 * scoping the CMDB protection already uses (a staged/offline gate's cloned
 * config must not vouch for another gate's fleet).
 */
export function isVouchedManagedDevice(
  asset: { serialNumber: string | null; hostname: string | null },
  controller: string,
  sightings: ManagedDeviceSightings,
): boolean {
  const ctlKey = controller.toLowerCase();
  if (asset.serialNumber) {
    if (sightings.seenSerials.has(asset.serialNumber)) return true;
    // CMDB decommission protection: configured-but-currently-offline.
    return !!sightings.cmdbSerialsByController.get(ctlKey)?.has(asset.serialNumber);
  }
  return !!(asset.hostname && sightings.seenHostnamesByController.get(ctlKey)?.has(asset.hostname));
}

// Exported for tests: Phase 7's device-inventory pass defers its asset writes
// to a flush at the end of the phase while keeping every in-memory effect
// inline, and the hazard that shape has to survive — two sightings of ONE
// asset in a single run — is only observable through the real function against
// a real database.
export async function syncDhcpSubnets(integrationId: string, integrationName: string, integrationType: string, result: DiscoveryResult, actor?: string, mode: SyncMode = "full", signal?: AbortSignal, adoptionBudget?: AdoptionBudget) {
  const syncLog = (level: "info" | "warning" | "error", message: string) => {
    logEvent({ action: "integration.sync", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level, message: `[${integrationName}] ${message}` });
  };
  // Per-integration verbose-debug detection — when on, each Phase wrapped by
  // `phaseTimer` emits one pino info-level line with elapsed ms. Reads the
  // current integration row up front (one query) so the phaseTimer hot path
  // doesn't repeat the lookup. When the integration was deleted mid-sync,
  // the flag falls through to `false` and verbose lines are skipped.
  let verboseLogging = false;
  try {
    const cfgRow = await prisma.integration.findUnique({
      where: { id: integrationId },
      select: { config: true },
    });
    const cfg = (cfgRow?.config ?? null) as Record<string, unknown> | null;
    verboseLogging = cfg != null && isVerboseLoggingActive(cfg);
  } catch {
    // best-effort; absence falls through to false
  }
  /**
   * Phase-boundary cursor for verbose logging. Each `phaseMark(name)` call
   * logs the elapsed time of the PREVIOUS phase (since the last mark) and
   * starts the new phase's stopwatch. The final `phaseMark("__end__")` at
   * the bottom of syncDhcpSubnets closes out the last phase.
   *
   * Off by default — `verboseLogging` is false for every install that
   * hasn't opted in. Cursor state is per-sync (closure-local), so
   * concurrent discoveries for different integrations don't interfere.
   */
  let lastPhaseAt = Date.now();
  let lastPhaseName: string | null = null;
  const phaseMark = (name: string): void => {
    const now = Date.now();
    if (lastPhaseName) {
      const elapsedMs = now - lastPhaseAt;
      // Always-on histogram observation — operators don't have to flip
      // verboseLogging to get the bucketed distribution across runs.
      observeDiscoveryPhase(integrationType, lastPhaseName, elapsedMs / 1000);
      if (verboseLogging) {
        logger.info(
          { verbose: true, integrationId, integrationName, phase: lastPhaseName, elapsedMs },
          "discovery.phase.complete",
        );
      }
    }
    lastPhaseName = name;
    lastPhaseAt = now;
    // Cooperative cancel: the HTTP transports observe the run's abort signal
    // natively, but the DB work between these marks doesn't — a cancel that
    // lands mid-sync used to run every remaining phase to completion (or hang
    // with it, prod incident 2026-07-20). Throwing here stops the sync at the
    // next phase boundary; DiscoveryAbortError carries name="AbortError" so
    // runDiscovery's terminal handler counts the run as aborted, not errored.
    // The __end__ mark is exempt — all work is already done at that point,
    // and throwing would discard a fully-committed sync's result.
    if (name !== "__end__") throwIfAborted(signal, `sync phase "${name}"`);
  };
  const integrationLabel =
    integrationType === "windowsserver" ? "Windows Server" :
    integrationType === "fortigate" ? "FortiGate" :
    "FortiManager";
  const projectRefLabel = `${integrationLabel} Integration`;
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const assetNames: string[] = [];
  const reservationNames: string[] = [];
  const vipNames: string[] = [];
  const dhcpLeases: string[] = [];
  const dhcpReservations: string[] = [];
  const inventoryAssets: string[] = [];
  const deprecated: string[] = [];
  const decommissionedSwitches: string[] = [];
  const decommissionedAps: string[] = [];
  let dnsResolved = 0;
  let ouiResolved = 0;
  let ouiOverridden = 0;
  const now = new Date().toISOString();

  // Per-class auto-monitor settings (FortiGate / FortiSwitch / FortiAP).
  // Read from the integration's config so the discovery sync knows whether
  // to stamp monitorType/monitorCredentialId/monitored on each freshly-
  // discovered asset. FMG and standalone FortiGate share the same config
  // keys; other integration types simply have no fortigateMonitor /
  // fortiswitchMonitor / fortiapMonitor entry, in which case the helpers
  // below resolve to "do nothing".
  //
  // Each class block now carries both `snmpCredentialId` and
  // `sshCredentialId`. The integration tier's resolved `responseTimePolling`
  // decides which one to stamp on a freshly-discovered asset: "ssh" picks
  // sshCredentialId; anything else (rest_api/snmp/icmp/disabled/null) falls
  // back to snmpCredentialId for back-compat with existing installs whose
  // credential is the SNMP one.
  type ClassMonCfg = {
    enabled: boolean;
    snmpCredentialId: string | null;
    sshCredentialId:  string | null;
    addAsMonitored:   boolean;
    // Pre-resolved credential ID to stamp; null = don't stamp.
    stampCredentialId: string | null;
  };
  const emptyClassCfg: ClassMonCfg = { enabled: false, snmpCredentialId: null, sshCredentialId: null, addAsMonitored: false, stampCredentialId: null };
  let switchMonitorCfg: ClassMonCfg = emptyClassCfg;
  let apMonitorCfg:     ClassMonCfg = emptyClassCfg;
  let fortigateAddAsMonitored = false;
  // FortiGate-only: SNMP sysLocation read, sysLocation→coords geocode, and
  // geocoded-coords write-back toggles. Stashed here so the Phase 3 firewall
  // fan-out can pull / push without re-reading the integration config per
  // device. All default to off.
  let pullSnmpLocation = false;
  let useSnmpLocationCoords = false;
  let pushGeocodedCoords = false;
  // FMG metavar names used by the coord read (extractMetavarCoordsFromFmgDevice,
  // upstream in discovery) + write-back (pushCoordsToFortigate). Lat/Long default
  // to the common convention; addressMetavar is blank-disabled by default and, when
  // set + populated, becomes the preferred geocode-source string (SNMP fallback).
  let latitudeMetavar = "Latitude";
  let longitudeMetavar = "Longitude";
  let addressMetavar = "";
  // Full integration config retained for handing to the location-pull + coord-
  // push services (which need the FMG/FortiGate credentials inside it).
  let integrationConfig: Record<string, unknown> | null = null;
  if (isFortinetIntegrationType(integrationType)) {
    const integ = await prisma.integration.findUnique({ where: { id: integrationId }, select: { config: true } });
    const cfg = (integ?.config as Record<string, unknown>) || {};
    integrationConfig = cfg;
    const sw = (cfg.fortiswitchMonitor as Record<string, unknown> | undefined) || {};
    const ap = (cfg.fortiapMonitor     as Record<string, unknown> | undefined) || {};
    const fg = (cfg.fortigateMonitor   as Record<string, unknown> | undefined) || {};
    const monSettings = (cfg.monitorSettings as Record<string, unknown> | undefined) || {};
    const polling     = (monSettings.polling as Record<string, unknown> | undefined) || {};
    const responseTimePolling = typeof polling.responseTime === "string" ? polling.responseTime : null;
    const pickStamp = (snmpId: string | null, sshId: string | null): string | null => {
      if (responseTimePolling === "ssh") return sshId ?? snmpId ?? null;
      return snmpId ?? sshId ?? null;
    };
    const swSnmp = typeof sw.snmpCredentialId === "string" ? sw.snmpCredentialId : null;
    const swSsh  = typeof sw.sshCredentialId  === "string" ? sw.sshCredentialId  : null;
    const apSnmp = typeof ap.snmpCredentialId === "string" ? ap.snmpCredentialId : null;
    const apSsh  = typeof ap.sshCredentialId  === "string" ? ap.sshCredentialId  : null;
    switchMonitorCfg = {
      enabled: sw.enabled === true,
      snmpCredentialId: swSnmp,
      sshCredentialId:  swSsh,
      addAsMonitored: sw.addAsMonitored === true,
      stampCredentialId: pickStamp(swSnmp, swSsh),
    };
    apMonitorCfg = {
      enabled: ap.enabled === true,
      snmpCredentialId: apSnmp,
      sshCredentialId:  apSsh,
      addAsMonitored: ap.addAsMonitored === true,
      stampCredentialId: pickStamp(apSnmp, apSsh),
    };
    fortigateAddAsMonitored = fg.addAsMonitored === true;
    pullSnmpLocation        = fg.pullSnmpLocation === true;
    useSnmpLocationCoords   = fg.useSnmpLocationCoords === true;
    pushGeocodedCoords      = fg.pushGeocodedCoords === true;
    latitudeMetavar         = (typeof fg.latitudeMetavar === "string" && fg.latitudeMetavar.trim()) || "Latitude";
    longitudeMetavar        = (typeof fg.longitudeMetavar === "string" && fg.longitudeMetavar.trim()) || "Longitude";
    addressMetavar          = (typeof fg.addressMetavar === "string" ? fg.addressMetavar.trim() : "");
  }

  // Sighting sets for the FortiSwitch / FortiAP decommission sweep below.
  // Populated unconditionally so the pass works in both per-device sync
  // mode (full / skip-deprecation) and the post-pass finalize mode, which
  // gets the *aggregated* discoveryResult and runs the deprecation step.
  // Hostname sightings are scoped per controller (lowercased device name),
  // mirroring the CMDB roster maps below — and they only vouch for assets
  // with NO serial on file (see isVouchedManagedDevice).
  const seenSwitchSerials = new Set<string>();
  const seenApSerials     = new Set<string>();
  const seenSwitchHostnamesByController = new Map<string, Set<string>>();
  const seenApHostnamesByController     = new Map<string, Set<string>>();
  const addControllerHostname = (map: Map<string, Set<string>>, device: string | undefined, name: string | undefined) => {
    const key = (device || "").toLowerCase();
    if (!key || !name) return;
    let set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); }
    set.add(name);
  };
  for (const sw of result.fortiSwitches || []) {
    if (sw.serial) seenSwitchSerials.add(sw.serial);
    addControllerHostname(seenSwitchHostnamesByController, sw.device, sw.name);
  }
  for (const ap of result.fortiAps || []) {
    if (ap.serial) seenApSerials.add(ap.serial);
    addControllerHostname(seenApHostnamesByController, ap.device, ap.name);
  }
  // Decommission protection: a serial that appears in FMG's CMDB roster
  // (managed-switch / wireless-controller wtp config) but is missing from
  // the live monitor query is "configured but currently offline" — likely
  // a brief post-config-push window or an offline device. Don't decommission
  // it. The CMDB rosters come from native FMG calls (no proxy throttle).
  // SCOPED PER-CONTROLLER (keyed on lowercased device name — FMG-cased vs
  // FortiOS-cased names can differ for the same device): a roster entry only
  // protects a switch/AP whose recorded controllerFortigate IS the gate the
  // roster was read from. An FMG-offline gate's roster is FMG's CACHED copy
  // (Step 3d.4 runs offline by design), and a staged replacement gate's
  // cloned config can list another gate's whole fleet — fleet-wide
  // protection let exactly that shield ghost APs from the sweep forever
  // (prod 2026-07: staged RIVERBEND-201G-1 vouched for a deleted AP owned
  // by the live RIVERBEND-101F-1).
  const cmdbSwitchSerialsByDevice = new Map<string, Set<string>>();
  const cmdbApSerialsByDevice     = new Map<string, Set<string>>();
  for (const e of result.cmdbSwitchSerials || []) {
    const key = (e.device || "").toLowerCase();
    if (!key || !e.serial) continue;
    let set = cmdbSwitchSerialsByDevice.get(key);
    if (!set) { set = new Set(); cmdbSwitchSerialsByDevice.set(key, set); }
    set.add(e.serial);
  }
  for (const e of result.cmdbApSerials || []) {
    const key = (e.device || "").toLowerCase();
    if (!key || !e.serial) continue;
    let set = cmdbApSerialsByDevice.get(key);
    if (!set) { set = new Set(); cmdbApSerialsByDevice.set(key, set); }
    set.add(e.serial);
  }
  const switchInventoriedDevices = new Set<string>(result.switchInventoriedDevices || []);
  const apInventoriedDevices     = new Set<string>(result.apInventoriedDevices     || []);

  // ── Managed-device membership (dependency graph only) ────────────────────
  // The controller's own CMDB answer to "which switches / APs are mine",
  // keyed by FMG device name. Persisted onto the gate's own fortinetTopology
  // below so `recomputeDependencyTree` can use it OUTSIDE a discovery run --
  // the boot backfill has no DiscoveryResult to read.
  //
  // Deliberately independent of the cmdb*SerialsByDevice maps above: those
  // vouch for assets against the decommission sweep, and membership must never
  // influence a sweep. A gate absent from the *Known sets has an UNKNOWN member
  // list, which is not the same as an empty one.
  const membershipSwitchByDevice = new Map<string, Set<string>>();
  const membershipApByDevice     = new Map<string, Set<string>>();
  for (const e of result.managedMembership?.switches || []) {
    const key = (e.device || "").toLowerCase();
    if (!key || !e.serial) continue;
    let set = membershipSwitchByDevice.get(key);
    if (!set) { set = new Set(); membershipSwitchByDevice.set(key, set); }
    set.add(e.serial.trim().toUpperCase());
  }
  for (const e of result.managedMembership?.aps || []) {
    const key = (e.device || "").toLowerCase();
    if (!key || !e.serial) continue;
    let set = membershipApByDevice.get(key);
    if (!set) { set = new Set(); membershipApByDevice.set(key, set); }
    set.add(e.serial.trim().toUpperCase());
  }
  const membershipSwitchKnown = new Set<string>(
    (result.managedMembership?.switchDevices || []).map((d) => d.toLowerCase()),
  );
  const membershipApKnown = new Set<string>(
    (result.managedMembership?.apDevices || []).map((d) => d.toLowerCase()),
  );

  // ── Pre-load all data in parallel (5 queries total) ──
  // Asset rows are hydrated with their macAddressRows so the in-memory MAC
  // pipeline (AssetIndex, MAC merges in DHCP / device-inventory / Intune
  // syncs) can keep working with the legacy `asset.macAddresses` JSON
  // shape. Each asset write site writes back through reconcileMacAddresses
  // at end of asset.update.
  //
  // The source rows come along for the same reason the Entra / AD / vCenter
  // syncs preload theirs: the firewall / FortiSwitch / FortiAP loops below
  // each upsert their own source row and then re-read EVERY source row on
  // that asset to project it, which was one round trip per device per run —
  // hundreds on a Fortinet estate. `infraSources` is that projection input,
  // kept in step with the loops' own writes by applyInfraSourceInMemory.
  // The exclusion list rides this same read: it is tiny, and Phase 1 needs it
  // per SUBNET, so loading it once per run is what keeps business rule 42 free
  // of a per-create round trip at 2000-asset fleet size.
  const [blocks, allSubnetsRaw, allReservationsRaw, allAssetsRawWithRows, allInfraSourceRows, subnetExclusions] = await Promise.all([
    prisma.ipBlock.findMany(),
    prisma.subnet.findMany(),
    prisma.reservation.findMany({ where: { status: "active" } }),
    prisma.asset.findMany({ include: { macAddressRows: { select: MAC_ROW_SELECT } } }),
    prisma.assetSource.findMany({
      select: { assetId: true, sourceKind: true, externalId: true, inferred: true, observed: true, lastSeen: true },
    }),
    prisma.subnetExclusion.findMany({ select: { cidr: true, name: true } }),
  ]);
  const infraSources = new Map<string, EntraSourceEntry[]>();
  for (const r of allInfraSourceRows) {
    const entry: EntraSourceEntry = {
      sourceKind: r.sourceKind, externalId: r.externalId, inferred: r.inferred,
      observed: (r.observed as Record<string, unknown> | null) || {}, lastSeen: r.lastSeen,
    };
    const list = infraSources.get(r.assetId);
    if (list) list.push(entry); else infraSources.set(r.assetId, [entry]);
  }
  /** The source rows for one asset, as the projection takes them. */
  const infraSourcesOf = (assetId: string): EntraSourceEntry[] => infraSources.get(assetId) ?? [];
  /** The prior `observed` blob for one (kind, externalId), for the
   *  absent-osVersion carry-forward in upsertFortinetInfraAssetSource — which
   *  read it back from the DB per device rather than from a preload. */
  const infraPriorObserved = (assetId: string, sourceKind: string, externalId: string): Record<string, unknown> | null =>
    infraSourcesOf(assetId).find((s) => s.sourceKind === sourceKind && s.externalId === externalId)?.observed ?? null;
  /**
   * Mirror of what the infra upsert helpers do to the DB, so the projection
   * below can read the map instead of re-querying: replace-or-insert the row
   * at (sourceKind, externalId), and drop the phantom `manual|<assetId>` row
   * the helpers clear (see the note on that delete — it is live, not a spent
   * migration).
   */
  const applyInfraSourceInMemory = (
    assetId: string,
    sourceKind: string,
    externalId: string,
    observed: Record<string, unknown>,
    /** null = "do not advance" (an offline HA member), matching the helpers'
     *  `...(lastSeen ? { lastSeen } : {})` on the UPDATE half. */
    lastSeen: Date | null,
    syncedAt: Date,
  ): void => {
    let list = infraSources.get(assetId);
    if (!list) { list = []; infraSources.set(assetId, list); }
    const row = list.find((s) => s.sourceKind === sourceKind && s.externalId === externalId);
    if (row) {
      row.observed = observed;
      row.inferred = false;
      if (lastSeen) row.lastSeen = lastSeen;
    } else {
      // On CREATE the helpers stamp both firstSeen and lastSeen from
      // `lastSeen ?? syncedAt`.
      list.push({ sourceKind, externalId, inferred: false, observed, lastSeen: lastSeen ?? syncedAt });
    }
    infraSources.set(assetId, list.filter((s) => !(s.sourceKind === "manual" && s.externalId === assetId)));
  };
  /** Mirror of the firewall loop's stale-endpoint sweep. */
  const dropInfraSourceKindInMemory = (assetId: string, sourceKind: string): void => {
    const list = infraSources.get(assetId);
    if (list) infraSources.set(assetId, list.filter((s) => s.sourceKind !== sourceKind));
  };
  // Hydrate asset.macAddresses from the side-table rows (sorted lastSeen
  // desc) so existing code paths can keep building macList in memory.
  const allAssetsRaw = allAssetsRawWithRows.map((a: any) => ({
    ...a,
    macAddresses: shapeMacRows(a.macAddressRows),
  }));

  // ── Build in-memory indexes ──

  // Subnets by CIDR (non-deprecated only) and by blockId
  const subnetByCidr = new Map<string, any>();
  const siblingsByBlockId = new Map<string, any[]>();
  // Dead rows, keyed `blockId|cidr` — the EXACT key `@@unique([blockId, cidr])`
  // enforces. They are excluded from both indexes above (invisible to the
  // update path) while still occupying that unique slot (blocking to the create
  // path), which is what made a replacement gate's identical subnet
  // unrecordable; Phase 1's create path consults this to retire one when a
  // DIFFERENT gate now serves the range. Business rule 41.
  //
  // Exact-CIDR only, deliberately. A deprecated /23 PARTIALLY overlapping a new
  // /24 is a different judgement — it is not the same address space coming
  // back — so it still falls through to createSubnetRowChecked and is reported
  // as the genuine overlap it is.
  const deprecatedByBlockCidr = new Map<string, any>();
  const allSubnets = [...allSubnetsRaw]; // mutable copy — we push newly created subnets here
  for (const s of allSubnets) {
    if (s.status !== "deprecated") {
      subnetByCidr.set(s.cidr, s);
      const siblings = siblingsByBlockId.get(s.blockId) || [];
      siblings.push(s);
      siblingsByBlockId.set(s.blockId, siblings);
    } else {
      deprecatedByBlockCidr.set(`${s.blockId}|${s.cidr}`, s);
    }
  }

  // Active reservations: key = "subnetId|ipAddress"
  // dns_resolved rows are intentionally EXCLUDED — they're fallback markers
  // for IPs the asset model knows about but discovery hasn't seen yet. When
  // a real authoritative source (dhcp_reservation / dhcp_lease / vip /
  // interface_ip / fortiswitch / ...) lands at the same IP it takes over;
  // the inline `releaseDnsResolvedAt` call below each create flips the
  // fallback row to released first so the unique-on-active constraint stays
  // happy. The periodic dns_resolved reconcile job re-creates the marker on
  // any IP that ends up bare again later.
  const reservationKey = (subnetId: string, ip: string) => `${subnetId}|${ip}`;
  const activeResMap = new Map<string, any>();
  for (const r of allReservationsRaw) {
    if (r.sourceType === "dns_resolved") continue;
    if (r.ipAddress) activeResMap.set(reservationKey(r.subnetId, r.ipAddress), r);
    else activeResMap.set(`${r.subnetId}|__full__`, r);
  }

  // Asset index with multi-key lookups
  const assetIdx = new AssetIndex(allAssetsRaw);

  // Phase-4 follow-up: track every endpoint asset this sync touched so we
  // can stamp a `fortigate-endpoint` AssetSource row on each at the end.
  // Populated from device-inventory creates/updates, switch-port + ARP
  // enrichment, and DHCP sightings. Excludes infrastructure assets
  // (firewall/switch/access_point) — those have dedicated source kinds.
  const fortigateEndpointAssetIds = new Set<string>();

  // ── Per-asset change events: run-scoped baseline ──
  //
  // Records each tracked field's value at its FIRST touch this run; the flush
  // after Phase 11 diffs that against the final in-memory value and emits one
  // batch of asset.firmware.changed / asset.switch_port.changed /
  // asset.wireless_ap.changed rows.
  //
  // Baseline-at-first-touch rather than event-at-each-write, because two write
  // sequences legitimately ping-pong WITHIN a single run and inline emission
  // would report both halves as changes, every run, forever:
  //   • osVersion — Phase 7 stages FortiOS's coarse cached client fingerprint
  //     ("10.0"), Phase 11's corrective projection puts the real MDM value
  //     back ("10.0.19045").
  //   • lastSeenSwitch — Phase 7 stages `${inv.switchName}/port${n}` while
  //     Phase 7.5 stages `${row.switchId}/${row.portName}` for the SAME port.
  // Diffing against the cycle boundary nets both to zero.
  //
  // INVARIANT: any new write of os / osVersion / lastSeenSwitch / lastSeenAp
  // inside syncDhcpSubnets must call noteChangeBaseline() before staging it,
  // or that change goes unaudited. (Fortinet infra os/osVersion is the one
  // exclusion — it flows through projection + logDiscoveryAssetUpdated, which
  // emits the firmware event itself; recording it here too would double-emit.)
  type ChangeBaselineFields = "os" | "osVersion" | "lastSeenSwitch" | "lastSeenAp";
  const changeBaseline = new Map<string, { name: string | null } & Partial<Record<ChangeBaselineFields, unknown>>>();
  const noteChangeBaseline = (asset: any, fields: ChangeBaselineFields[]): void => {
    if (!asset?.id) return;
    let entry = changeBaseline.get(asset.id);
    if (!entry) {
      entry = { name: asset.hostname || asset.ipAddress || null };
      changeBaseline.set(asset.id, entry);
    }
    // First touch wins — later phases overwrite the VALUE, never the baseline.
    for (const f of fields) if (!(f in entry)) (entry as any)[f] = asset[f] ?? null;
  };

  // Which FortiGate each of those assets was sighted ON, recorded at the touch
  // site from the pathway's OWN device name (DHCP entry.device, inventory
  // inv.device, switch-MAC / ARP row.fortigateDevice). This is the ONLY thing
  // the fortigate-endpoint blob's `learnedLocation` may be built from.
  //
  // It used to be read back off `Asset.learnedLocation` at flush time, which is
  // the PROJECTION's output — a merge of every source. On a domain-joined
  // laptop that field holds AD's OU path, so the flush laundered "OU=Computer
  // Workstation2" into the blob as if the FortiGate had said it, and an
  // operator who ranked fortigate-endpoint first then read an OU path in the
  // Sources column (prefixed with the FMG integration name, since the prefix
  // option only fires on this contributor). Same class of bug as the runaway
  // prefix that bareFortinetDeviceName exists for, and the same root cause:
  // a source blob must never be built from the projection it feeds.
  const fortigateEndpointDeviceByAsset = new Map<string, string>();
  const noteEndpointGate = (assetId: string, device: unknown): void => {
    if (typeof device !== "string") return;
    const name = device.trim();
    if (name) fortigateEndpointDeviceByAsset.set(assetId, name);
  };

  // Blocks sorted by prefix length descending (most specific first) for matching
  const blocksSorted = [...blocks].sort((a, b) => {
    const pa = parseInt(a.cidr.split("/")[1], 10);
    const pb = parseInt(b.cidr.split("/")[1], 10);
    return pb - pa;
  });

  // Helper: find the most specific block that contains a CIDR
  function findParentBlock(cidr: string) {
    return blocksSorted.find((b) => cidrContains(b.cidr, cidr));
  }

  // Helper: find which subnet contains an IP
  function findSubnetForIp(ip: string) {
    return allSubnets.find((s) => s.status !== "deprecated" && ipInCidr(ip, s.cidr));
  }

  // Roster of FortiGates currently configured in the upstream (FortiManager or
  // the standalone FortiGate itself), regardless of online status or include/
  // exclude filter. Phase 2 deprecates subnets whose owning device is NOT in
  // this set — meaning the device was deleted from the upstream. Offline
  // devices remain in the roster, so their subnets are left alone.
  const knownDeviceNames = new Set(result.knownDeviceNames);
  // HA-aware: every member of every HA cluster is a "still-known" identity,
  // not just whichever member is currently primary. Without this, the
  // Phase 2a decommission sweep would flip the standby member's Asset to
  // decommissioned every cycle (its hostname never appears at the top-level
  // device.name — only inside ha_slave[]). On failover, the previous
  // primary would suffer the same fate. Both member hostnames AND member
  // serials are tracked so the sweep can match either.
  //
  // The identities come from the ROSTER (`knownDeviceSerials`, captured
  // pre-filter and regardless of conn_status) first, and only then from the
  // devices that processed this run. Roster-first is the whole point: a gate
  // that failed its direct read, was skipped for an unresolved management IP,
  // or was dropped by the include/exclude filter contributes no processed
  // device at all — so its primary survived on the raw-roster name while its
  // standby, an identity only ha_slave[] carries, matched nothing and was
  // decommissioned. Serials fold to upper case here and are compared that way
  // below, mirroring the serial-mismatch guard in the firewall fan-out.
  const knownFirewallSerials = new Set<string>();
  for (const sn of result.knownDeviceSerials || []) knownFirewallSerials.add(sn.toUpperCase());
  // Cluster memberships actually PUBLISHED this run. A member missing from a
  // roster that WAS read has genuinely left its cluster; a member whose
  // cluster published no roster at all is unknowable, not gone — the same
  // "absence is not negative evidence" posture the switch/AP sweeps take.
  const haRosterPublished = new Set<string>();
  for (const dev of result.devices) {
    if (dev.serial) knownFirewallSerials.add(dev.serial.toUpperCase());
    if (Array.isArray(dev.haMembers)) {
      for (const m of dev.haMembers) {
        if (m.serial) {
          knownFirewallSerials.add(m.serial.toUpperCase());
          haRosterPublished.add(m.serial.toUpperCase());
        }
        if (m.name) knownDeviceNames.add(m.name);
      }
    }
  }
  // Per-device CHASSIS SET, for the Phase 1 subnet chassis-identity check
  // (business rule 41). One entry per processed device, keyed on its lowercased
  // name, holding its own serial plus every HA member's.
  //
  // Deliberately PER DEVICE rather than the fleet-wide `knownFirewallSerials`
  // above: an old chassis re-registered in FMG under a different device entry
  // (a gate repurposed to another site) is genuinely a replacement for THIS
  // subnet, and testing against the fleet set would call it unchanged. It is
  // built from `result.devices` — not at subnet-emission time — because the
  // standalone FortiGate path resolves the calling unit's serial in its status
  // chain but does not learn its HA members until the later `ha-peer` read.
  const clusterSerialsByDevice = new Map<string, Set<string>>();
  for (const dev of result.devices) {
    const key = (dev.name || dev.hostname || "").toLowerCase();
    if (!key) continue;
    const set = clusterSerialsByDevice.get(key) ?? new Set<string>();
    if (dev.serial) set.add(dev.serial.toUpperCase());
    for (const m of dev.haMembers ?? []) if (m.serial) set.add(m.serial.toUpperCase());
    clusterSerialsByDevice.set(key, set);
    // A FortiGate's FMG device name and its own hostname can differ; index
    // both so a subnet stamped with either resolves to the same chassis set.
    const hostKey = (dev.hostname || "").toLowerCase();
    if (hostKey && hostKey !== key) clusterSerialsByDevice.set(hostKey, set);
  }

  // Lowercased view of the roster. FMG-stored device names and FortiOS
  // system-status hostnames can disagree in case; the Phase 2 / 2a roster
  // checks compare lowercase-on-both-sides so an asset hostname written
  // from FortiOS truth (uppercase) still matches an FMG roster entry
  // written from FMG truth (lowercase) and vice versa.
  const knownDeviceNamesLc = new Set<string>();
  for (const n of knownDeviceNames) knownDeviceNamesLc.add(n.toLowerCase());

  if (mode === "full" || mode === "skip-deprecation") {
  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 1 — Sync subnets (in-memory lookups, individual creates)
  phaseMark("1");
  // ══════════════════════════════════════════════════════════════════════════════

  // Collect subnet updates to batch
  const subnetUpdates: Array<{ id: string; data: any }> = [];
  // First-claim audit trail: manual subnets (discoveredBy IS NULL) whose CIDR
  // discovery just matched. After the batch update we emit one
  // `subnet.claimed` Event per row so operators can see when an integration
  // took over a manually-created subnet.
  const claimedSubnets: Array<{
    id: string;
    cidr: string;
    previousName: string;
    newName: string;
    fortigateDevice: string;
  }> = [];
  // Subnets whose serving chassis changed this run (business rule 41).
  // Collected here and processed AFTER the batch update, because each one
  // archives a snapshot + raises a conflict and neither belongs inside the
  // tight per-subnet loop.
  const chassisReplacements: Array<{
    subnetId: string;
    cidr: string;
    blockId: string;
    from: string;
    to: string;
    oldDeviceName: string | null;
    newDeviceName: string | null;
  }> = [];

  for (const entry of result.subnets) {
    let cidr: string;
    try {
      cidr = normalizeCidr(entry.cidr);
    } catch {
      skipped.push(`${entry.cidr} (invalid CIDR)`);
      continue;
    }

    // ── Excluded address space (business rule 42) ────────────────────────────
    // The operator has declared this CIDR out of scope for the networks list,
    // which is how a subnet several sites serve identically stops being one
    // row every site fights over. The entry is skipped WHOLE — before the
    // existing-row branch, not just the create — because the conflict this
    // exists to stop is raised by the UPDATE side: each site's gate answers
    // with its own serial, so the chassis check on a shared row reads
    // `replaced` on every run. No create, no update, no chassis comparison,
    // and (Phase 2) no stale sweep either.
    const excludedBy = findCoveringExclusion(cidr, subnetExclusions);
    if (excludedBy) {
      skipped.push(`${cidr} (excluded as "${excludedBy.name}")`);
      continue;
    }

    // Check if a non-deprecated subnet with this CIDR already exists (in-memory)
    const existing = subnetByCidr.get(cidr);
    if (existing) {
      const isFirstClaim = existing.discoveredBy == null;

      // ── Chassis identity (business rule 41) ──────────────────────────────
      // Is this still the same physical FortiGate? The stored serial, the one
      // this run reports, and the reporting device's whole cluster set decide.
      // `unknown` (nothing readable this run) writes nothing and constrains
      // nothing; `learn` adopts; `same` re-stamps so the stored value tracks
      // the active cluster member; `replaced` archives the old chassis's state
      // and raises a conflict WITHOUT re-pointing the serial — the pending
      // conflict is the unresolved state, and accepting it is what moves it.
      const chassis = classifyChassis(
        existing.fortigateSerial,
        entry.fortigateSerial,
        clusterSerialsByDevice.get((entry.fortigateDevice || "").toLowerCase()),
      );
      const serialToWrite = verdictWritesSerial(chassis);
      if (chassis.kind === "replaced") {
        chassisReplacements.push({
          subnetId: existing.id,
          cidr,
          blockId: existing.blockId,
          from: chassis.from,
          to: chassis.to,
          oldDeviceName: existing.fortigateDevice ?? null,
          newDeviceName: entry.fortigateDevice ?? null,
        });
      }

      const baseData: any = {
        discoveredBy: integrationId,
        fortigateDevice: entry.fortigateDevice,
        lastDiscoveredAt: new Date(),
        ...(serialToWrite ? { fortigateSerial: serialToWrite } : {}),
        ...(entry.vlan != null ? { vlan: entry.vlan } : {}),
      };
      if (isFirstClaim) {
        // Bring the manually-created row into parity with a freshly-discovered
        // subnet so it stops looking like an orphan in tag/filter UI. Name +
        // status are intentionally overwritten on first claim (the manual
        // values were placeholders); operator-typed purpose is preserved.
        const existingTags: string[] = Array.isArray(existing.tags) ? existing.tags : [];
        baseData.name = `DHCP: ${entry.name} (${entry.fortigateDevice})`;
        baseData.status = "available";
        baseData.tags = Array.from(new Set([...existingTags, "dhcp-discovered", integrationType]));
        if (!existing.purpose) {
          baseData.purpose = `Discovered from ${integrationLabel} DHCP`;
        }
        claimedSubnets.push({
          id: existing.id,
          cidr,
          previousName: existing.name,
          newName: baseData.name,
          fortigateDevice: entry.fortigateDevice,
        });
      }
      subnetUpdates.push({ id: existing.id, data: baseData });
      updated.push(cidr);
      continue;
    }

    // Find the most specific parent block
    const matchingBlock = findParentBlock(cidr);
    if (!matchingBlock) {
      skipped.push(`${cidr} (no matching parent block)`);
      continue;
    }

    // ── A dead subnet must not squat on the CIDR (business rule 41) ─────────
    //
    // A subnet deprecated before the chassis column existed — or by Phase 2
    // when its gate left the roster — still holds `@@unique([blockId, cidr])`
    // while being INVISIBLE to `subnetByCidr` above. So a replacement gate
    // reporting the identical range matched nothing, fell through to the
    // create, and was refused by the committed-state overlap check on the dead
    // row: skipped every run, forever, with a self-overlap message. The chassis
    // check above cannot reach this case — it only runs when a LIVE row exists
    // to compare against.
    //
    // Retire the dead row here so the create can proceed, but ONLY when a
    // DIFFERENT gate is now serving that space (`classifyDeprecatedSupersede`).
    // An operator who deprecated a subnet its own gate still serves gets it
    // re-reported every cycle, and archiving there would silently undo their
    // decision and hand the range back as active.
    const deadKey = `${matchingBlock.id}|${cidr}`;
    const dead = deprecatedByBlockCidr.get(deadKey);
    if (dead) {
      const verdict = classifyDeprecatedSupersede({
        storedSerial: dead.fortigateSerial,
        storedDeviceName: dead.fortigateDevice,
        discoveredSerial: entry.fortigateSerial,
        discoveredDeviceName: entry.fortigateDevice,
        clusterSerials: clusterSerialsByDevice.get((entry.fortigateDevice || "").toLowerCase()),
      });
      if (verdict.kind === "supersede") {
        try {
          const snap = await archiveSubnet(dead.id, { actor, reason: "chassis-replaced" });
          // Drop it from every in-memory structure so Phase 2 and the later
          // phases cannot act on a row that no longer exists.
          deprecatedByBlockCidr.delete(deadKey);
          const at = allSubnets.findIndex((s: any) => s.id === dead.id);
          if (at >= 0) allSubnets.splice(at, 1);
          syncLog(
            "info",
            `Retired the dead subnet ${cidr} (was served by "${dead.fortigateDevice || "unknown"}", ` +
              `${snap.reservationCount} reservation(s) archived) so "${entry.fortigateDevice}" can serve it — ` +
              `superseded by ${verdict.via === "serial" ? "a different chassis serial" : "a different FortiGate"}`,
          );
        } catch (err: any) {
          skipped.push(`${cidr} (could not archive the deprecated subnet it replaces)`);
          syncLog("error", `Failed to archive deprecated subnet ${cidr}: ${err?.message || "Unknown error"}`);
          continue;
        }
      } else {
        // Deliberately actionable: the old message was a bare self-overlap and
        // told an operator nothing about what to do.
        skipped.push(`${cidr} (a deprecated network still holds this range — archive it to free the address space)`);
        syncLog(
          "warning",
          `Subnet ${cidr} is still held by a deprecated network on the same FortiGate ` +
            `("${dead.fortigateDevice || "unknown"}", ${verdict.reason}). Its address space stays reserved ` +
            `until that network is archived; discovery will not reactivate a network somebody retired.`,
        );
        continue;
      }
    }

    // Cheap in-memory pre-filter against the siblings this run already knows
    // about — avoids a pointless transaction for the common "obviously
    // overlapping" case and keeps the skip reason specific.
    const siblings = siblingsByBlockId.get(matchingBlock.id) || [];
    const overlap = siblings.find((s: any) => cidrOverlaps(s.cidr, cidr));
    if (overlap) {
      skipped.push(`${cidr} (overlaps ${overlap.cidr})`);
      continue;
    }

    // Create the subnet through the locked seam in subnetService. Discovery
    // runs in its own process, concurrently with operators creating subnets in
    // the web UI, so the in-memory sibling snapshot above is inherently stale:
    // it was read at the top of this phase. createSubnetRowChecked re-tests the
    // overlap against committed state under the per-block advisory lock, so a
    // subnet an operator added mid-run is seen and this create is skipped
    // instead of landing an overlapping row.
    try {
      const newSubnet = await createSubnetRowChecked({
        blockId: matchingBlock.id,
        cidr,
        name: `DHCP: ${entry.name} (${entry.fortigateDevice})`,
        purpose: `Discovered from ${integrationLabel} DHCP`,
        status: "available",
        discoveredBy: integrationId,
        fortigateDevice: entry.fortigateDevice,
        // Chassis identity from the first sighting. A fresh row has nothing to
        // compare against, so this is a learn, never a replacement.
        ...(entry.fortigateSerial ? { fortigateSerial: entry.fortigateSerial } : {}),
        lastDiscoveredAt: new Date(),
        tags: ["dhcp-discovered", integrationType],
        ...(entry.vlan != null ? { vlan: entry.vlan } : {}),
      // Hand the seam this run's already-loaded exclusion set so its business
      // rule 42 backstop costs no read per created subnet.
      }, { exclusions: subnetExclusions });
      // Update in-memory state so later phases can find this subnet
      allSubnets.push(newSubnet);
      subnetByCidr.set(cidr, newSubnet);
      const blockSiblings = siblingsByBlockId.get(matchingBlock.id) || [];
      blockSiblings.push(newSubnet);
      siblingsByBlockId.set(matchingBlock.id, blockSiblings);
      created.push(cidr);
    } catch (err: any) {
      // A 409 is the locked seam telling us a sibling landed between this run's
      // sibling snapshot and now (an operator created it mid-run). That is a
      // normal skip, not a failure, so it must not colour the run's log red.
      if (err instanceof AppError && err.httpStatus === 409) {
        skipped.push(`${cidr} (${err.message})`);
        syncLog("info", `Skipped subnet ${cidr}: ${err.message}`);
      } else {
        skipped.push(`${cidr} (create failed)`);
        syncLog("error", `Failed to create subnet ${cidr}: ${err.message || "Unknown error"}`);
      }
    }
  }

  // Batch-execute subnet updates (discoveredBy/fortigateDevice)
  if (subnetUpdates.length > 0) {
    await batchSettled(subnetUpdates, (u) =>
      prisma.subnet.update({ where: { id: u.id }, data: u.data })
    );
    // Mirror each write onto the in-memory row Phase 2 filters.
    //
    // Phase 2 decides staleness from `allSubnets` — the snapshot read at the
    // top of this function — and `subnetByCidr` hands out references INTO it.
    // So a subnet this phase just re-pointed at a renamed or replaced gate
    // still carried the OLD `fortigateDevice` in memory, was not found in the
    // roster, and was deprecated by Phase 2 in the SAME run that had just
    // re-pointed it. The DB then held a subnet pointing at a live gate with
    // status=deprecated, and because a deprecated row is invisible to
    // `subnetByCidr` (no update path) while still occupying
    // `@@unique([blockId, cidr])` (no create path), that CIDR could never be
    // recorded again — every later run skipped it with a self-overlap message.
    // A gate rename was enough to trigger it.
    const subnetById = new Map(allSubnets.map((s: any) => [s.id, s]));
    for (const u of subnetUpdates) {
      const row = subnetById.get(u.id);
      if (row) Object.assign(row, u.data);
    }
  }

  // ── Chassis replacements (business rule 41) ────────────────────────────────
  // Archive a COPY of what the old chassis served, then raise one conflict per
  // subnet. Additive on purpose: no live reservation is released, re-pushed or
  // deleted on the strength of an automatic detection, so a false positive
  // costs a card and an archive row rather than data. Migration is an explicit
  // operator action.
  for (const rep of chassisReplacements) {
    try {
      const snap = await snapshotSubnet(
        rep.subnetId,
        { reason: "chassis-replaced", actor },
      );
      const outcome = await raiseChassisReplacedConflict({
        subnetId: rep.subnetId,
        cidr: rep.cidr,
        blockId: rep.blockId,
        oldSerial: rep.from,
        newSerial: rep.to,
        oldDeviceName: rep.oldDeviceName,
        newDeviceName: rep.newDeviceName,
        archivedSubnetId: snap.archivedSubnetId,
        integrationId,
        integrationName,
        actor,
      });
      syncLog(
        "warning",
        `Subnet ${rep.cidr} is served by a different FortiGate chassis (${rep.from} → ${rep.to}) — ` +
          `${snap.reservationCount} reservation(s) archived, conflict ${outcome}`,
      );
    } catch (err: any) {
      // Never fail the run over this: the subnet itself synced fine, and the
      // next pass re-derives the verdict from the still-unchanged stored serial.
      syncLog("error", `Failed to record chassis replacement for ${rep.cidr}: ${err?.message || "Unknown error"}`);
    }
  }

  // Emit one `subnet.claimed` Event per first-claim row (manual → discovered
  // transition). Fires once per subnet; subsequent discovery passes see
  // discoveredBy already set and skip the claim branch entirely.
  for (const c of claimedSubnets) {
    logEvent({
      action: "subnet.claimed",
      resourceType: "subnet",
      resourceId: c.id,
      resourceName: c.newName,
      actor,
      message: `Subnet "${c.previousName}" (${c.cidr}) claimed by "${integrationName}" — now tracked as "${c.newName}"`,
      details: {
        reason: "first-claim",
        previousName: c.previousName,
        previousDiscoveredBy: null,
        integrationId,
        integrationName,
        fortigateDevice: c.fortigateDevice,
        cidr: c.cidr,
      },
    });
  }
  } // end Phases 1 (full | skip-deprecation)

  if (mode !== "skip-deprecation") {
  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 2 — Deprecate stale subnets (single updateMany)
  phaseMark("2");
  // ══════════════════════════════════════════════════════════════════════════════

  if (sweepPhaseEnabled(mode, "2") && knownDeviceNames.size > 0) {
    // Find stale subnets in-memory first (for the return value).
    // Roster check is case-insensitive: a subnet's fortigateDevice can carry
    // FortiOS-cased casing while the FMG roster carries FMG-cased casing
    // (same device, different source).
    // An excluded CIDR is out of discovery's hands in BOTH directions
    // (business rule 42): Phase 1 no longer re-stamps it, so its
    // `fortigateDevice` is frozen at whichever site claimed it first, and
    // deprecating the row the moment that one gate leaves the roster would be
    // discovery acting on a subnet the operator told it to leave alone.
    const staleSubnets = allSubnets.filter(
      (s) => s.discoveredBy === integrationId && s.status !== "deprecated" &&
             s.fortigateDevice && !knownDeviceNamesLc.has(s.fortigateDevice.toLowerCase()) &&
             !findCoveringExclusion(s.cidr, subnetExclusions)
    );
    if (staleSubnets.length > 0) {
      const staleIds = staleSubnets.map((s) => s.id);
      await prisma.subnet.updateMany({
        where: { id: { in: staleIds } },
        data: { status: "deprecated" },
      });
      for (const s of staleSubnets) {
        deprecated.push(s.cidr);
        s.status = "deprecated"; // update in-memory
        logEvent({
          action: "subnet.deprecated",
          resourceType: "subnet",
          resourceId: s.id,
          resourceName: s.name,
          actor,
          message: `Subnet "${s.name}" (${s.cidr}) deprecated — FortiGate "${s.fortigateDevice}" no longer configured in "${integrationName}"`,
          details: {
            reason: "device-removed",
            fortigateDevice: s.fortigateDevice,
            integrationId,
            integrationName,
            cidr: s.cidr,
          },
        });
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 2a — Decommission stale FortiGate firewalls
  phaseMark("2a");
  // ══════════════════════════════════════════════════════════════════════════════
  //
  // For every firewall Asset row discovered by this integration whose identity
  // is no longer in the FMG roster: flip it to status="decommissioned". The
  // FMG roster (`knownDeviceNames` / `knownFirewallSerials`) is captured up
  // front from /dvmdb/adom/<adom>/device with NO conn_status filter, so an
  // offline FortiGate stays in the set and isn't flagged. Devices filtered out
  // by deviceInclude/exclude also stay in the set for the same reason —
  // flipping a filter shouldn't decommission previously-discovered firewalls.
  //
  // Match order:
  //   1. Serial (case-insensitive) — chassis identity, never renamed. Also
  //      covers HA: every cluster member's serial is in `knownFirewallSerials`
  //      (roster ha_slave[] entries included), so a standby whose hostname
  //      never appears at top-level still matches by serial.
  //   2. Hostname (case-insensitive) — fallback for legacy/partial rows
  //      where Asset.serialNumber wasn't populated. FMG-stored names and
  //      FortiOS system-status hostnames can disagree in case for the same
  //      device, so the comparison is lowercase-on-both-sides.
  //   3. HA standby whose cluster never published its membership this run —
  //      see haStandbyOfUnreadCluster. Absence from a roster nobody read is
  //      not evidence the box left the cluster.
  //
  // A decommissioned firewall is reactivated by the Phase-3b firewall update
  // path above on a future discovery cycle when the device returns to FMG.
  //
  // NEVER runs in "finalize-scoped": knownFirewallSerials is built from
  // result.devices — the PROCESSED chunks (one device in a scoped run), not
  // the raw ADOM roster — so a scoped pass would decommission every fleet
  // firewall matched by serial only.
  if (sweepPhaseEnabled(mode, "2a") && knownDeviceNames.size > 0 && (isFortinetIntegrationType(integrationType))) {
    const candidateFws = await prisma.asset.findMany({
      where: {
        discoveredByIntegrationId: integrationId,
        assetType: "firewall",
        // Maintenance-window assets ARE judged here: roster absence is config
        // truth, not a reachability signal (an offline device stays in the
        // roster), so a device deleted at the source outranks its open window.
        // releaseAssetsForDecommission below force-closes those windows before
        // the status flip — see maintenanceScheduleService.
        status: { not: "decommissioned" },
      },
      select: { id: true, hostname: true, serialNumber: true, fortinetTopology: true },
    });
    const staleFwIds: string[] = [];
    const staleFwHostnames: string[] = [];
    for (const a of candidateFws) {
      // 1) Serial-first — canonical chassis identity.
      if (a.serialNumber && knownFirewallSerials.has(a.serialNumber.toUpperCase())) continue;
      // 2) Hostname fallback (case-insensitive).
      if (a.hostname && knownDeviceNamesLc.has(a.hostname.toLowerCase())) continue;
      // 3) Standby of a cluster whose membership went unread this run.
      if (haStandbyOfUnreadCluster(a.fortinetTopology, knownFirewallSerials, haRosterPublished)) continue;
      if (!a.hostname) continue;
      staleFwIds.push(a.id);
      staleFwHostnames.push(a.hostname);
      logEvent({
        action: "asset.fortigate.decommissioned",
        resourceType: "asset",
        resourceId: a.id,
        resourceName: a.hostname || a.serialNumber || a.id,
        actor,
        message: `FortiGate "${a.hostname || a.serialNumber}" decommissioned — no longer configured in "${integrationName}"`,
        details: { reason: "missing-from-roster", integrationId, integrationName },
      });
    }
    if (staleFwIds.length > 0) {
      // Any of these sitting in an open maintenance window: close the window +
      // decommission atomically first, so the 30s maintenance reconcile can't
      // self-heal-reflip the status back to "maintenance" (or, at window end,
      // restore a deleted device to "active"). No-op when none are in a window.
      await releaseAssetsForDecommission(staleFwIds, {
        at: new Date(now),
        actor,
        statusChangedBy: integrationLabel,
        reason: `no longer configured in "${integrationName}"`,
      });
      await prisma.asset.updateMany({
        where: { id: { in: staleFwIds } },
        data: { status: "decommissioned", statusChangedAt: new Date(now), statusChangedBy: integrationLabel },
      });
      // Keep the in-memory index in step with the DB. `assetIdx` is a snapshot
      // taken before this sweep, and in "full" mode (the standalone FortiGate
      // integration — one pass, Phase 2a ahead of the Phase 3 firewall fan-out)
      // that snapshot is what Phase 3 reads. A row this sweep just
      // decommissioned would still look "active" there, the resurrection clause
      // would not fire, and the DB row would stay decommissioned with nothing
      // able to flip it back on any later cycle.
      for (const id of staleFwIds) {
        const row = assetIdx.findById(id);
        if (row) row.status = "decommissioned";
      }
      // Cascade — a decommissioned FortiGate takes its managed FortiSwitches /
      // FortiAPs with it. Phase 2b can't cover this case: it only judges
      // children whose controller was successfully INVENTORIED this run, and a
      // roster-removed gate is never queried again — so without this cascade
      // its switches/APs would sit "active" forever (ghost infra). Linkage is
      // fortinetTopology.controllerFortigate (the FMG device name the Phase 3b
      // switch / Phase 6 AP paths stamp), matched case-insensitively against
      // the just-decommissioned gates' hostnames via cascadeControllerOf.
      // Children rehomed to another gate earlier this run already carry the
      // new controller name, so they never match here. If the gate returns to
      // FMG, Phase 3b resurrects it and the children resurrect through their
      // own update paths once the controller reports them connected again.
      const staleFwNamesLc = new Set(staleFwHostnames.map((h) => h.toLowerCase()));
      const cascadeCandidates = await prisma.asset.findMany({
        where: {
          discoveredByIntegrationId: integrationId,
          assetType: { in: ["switch", "access_point"] },
          status: { not: "decommissioned" },
        },
        select: { id: true, hostname: true, serialNumber: true, assetType: true, fortinetTopology: true },
      });
      const cascadeIds: string[] = [];
      for (const child of cascadeCandidates) {
        const controller = cascadeControllerOf(child.fortinetTopology, staleFwNamesLc);
        if (!controller) continue;
        cascadeIds.push(child.id);
        if (child.assetType === "switch") decommissionedSwitches.push(child.hostname || child.serialNumber || child.id);
        else                              decommissionedAps.push(child.hostname || child.serialNumber || child.id);
        logEvent({
          action: child.assetType === "switch" ? "asset.fortiswitch.decommissioned" : "asset.fortiap.decommissioned",
          resourceType: "asset",
          resourceId: child.id,
          resourceName: child.hostname || child.serialNumber || child.id,
          actor,
          message: `${child.assetType === "switch" ? "FortiSwitch" : "FortiAP"} "${child.hostname || child.serialNumber}" decommissioned — its controller FortiGate "${controller}" was decommissioned`,
          details: { reason: "controller-decommissioned", controllerFortigate: controller, integrationId, integrationName },
        });
      }
      if (cascadeIds.length > 0) {
        // Force-exit maintenance for any of these in an open window (see 2a
        // preamble) before the status flip.
        await releaseAssetsForDecommission(cascadeIds, {
          at: new Date(now),
          actor,
          statusChangedBy: integrationLabel,
          reason: "its controller FortiGate was decommissioned",
        });
        await prisma.asset.updateMany({
          where: { id: { in: cascadeIds } },
          data: { status: "decommissioned", statusChangedAt: new Date(now), statusChangedBy: integrationLabel },
        });
        // Same snapshot sync as the firewall flip above — the switch / AP
        // update paths resurrect off `existingAsset.status`, which comes from
        // the pre-sweep `assetIdx`.
        for (const id of cascadeIds) {
          const row = assetIdx.findById(id);
          if (row) row.status = "decommissioned";
        }
        // Give back the addresses. Runs BEFORE the status flip would matter but
        // AFTER it for ordering safety: the helper reads asset ipAddress only,
        // so a decommissioned row is still resolvable. Never throws.
        await releaseInfraReservationsForAssets(cascadeIds, {
          reason: "controller FortiGate decommissioned",
          actor,
        });
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 2b — Decommission stale FortiSwitches / FortiAPs
  phaseMark("2b");
  // ══════════════════════════════════════════════════════════════════════════════
  //
  // For every previously-discovered FortiSwitch / FortiAP whose controller
  // was queried successfully this run but whose serial (or hostname, when
  // there's no serial on file) no longer appears in the controller's
  // managed inventory: flip the asset to status="decommissioned".
  //
  // This is gated on the *successful* per-controller inventory queries,
  // which is exactly the signal we already use to short-circuit "controller
  // offline" (a controller that timed out doesn't take its switches/APs
  // down with it). A decommissioned switch/AP is automatically reactivated
  // by the Phase-3b update path above when its serial reappears.
  //
  // The per-controller gating is also why this is the ONE sweep that runs in
  // "finalize-scoped" (single-FortiGate re-discovery): only assets behind
  // the scoped, successfully-queried controller are ever judged.
  if (sweepPhaseEnabled(mode, "2b") && (switchInventoriedDevices.size > 0 || apInventoriedDevices.size > 0)) {
    const candidates = await prisma.asset.findMany({
      where: {
        discoveredByIntegrationId: integrationId,
        assetType: { in: ["switch", "access_point"] },
        // Maintenance-window assets are judged here too — same reasoning as
        // Phase 2a: a powered-off-for-maintenance switch/AP is still in its
        // controller's CMDB (cmdbProtected below), so only a real removal from
        // the managed inventory reaches the decommission path.
        status: { not: "decommissioned" },
      },
      select: { id: true, hostname: true, serialNumber: true, assetType: true, fortinetTopology: true, status: true },
    });
    const staleIds: string[] = [];
    for (const a of candidates) {
      const topo = (a.fortinetTopology as Record<string, unknown> | null) || null;
      const controller = (topo?.controllerFortigate as string | undefined) || "";
      const inventoriedSet = a.assetType === "switch" ? switchInventoriedDevices : apInventoriedDevices;
      // Skip when this asset's controller wasn't reachable this run — we
      // didn't get a fresh answer either way.
      if (!controller || !inventoriedSet.has(controller)) continue;
      // Serial-authoritative sighting check (pure, unit-tested): serial on
      // file must reappear (live monitor or this controller's CMDB roster);
      // hostname vouches only for serial-less assets, and only on the same
      // controller. See isVouchedManagedDevice for the replaced-unit rationale.
      const vouched = isVouchedManagedDevice(a, controller, a.assetType === "switch"
        ? { seenSerials: seenSwitchSerials, seenHostnamesByController: seenSwitchHostnamesByController, cmdbSerialsByController: cmdbSwitchSerialsByDevice }
        : { seenSerials: seenApSerials,     seenHostnamesByController: seenApHostnamesByController,     cmdbSerialsByController: cmdbApSerialsByDevice });
      if (vouched) continue;
      staleIds.push(a.id);
      if (a.assetType === "switch")        decommissionedSwitches.push(a.hostname || a.serialNumber || a.id);
      else if (a.assetType === "access_point") decommissionedAps.push(a.hostname || a.serialNumber || a.id);
      logEvent({
        action: a.assetType === "switch" ? "asset.fortiswitch.decommissioned" : "asset.fortiap.decommissioned",
        resourceType: "asset",
        resourceId: a.id,
        resourceName: a.hostname || a.serialNumber || a.id,
        actor,
        message: `${a.assetType === "switch" ? "FortiSwitch" : "FortiAP"} "${a.hostname || a.serialNumber}" decommissioned — controller "${controller}" no longer reports it`,
        details: { reason: "missing-from-controller", controllerFortigate: controller, integrationId, integrationName },
      });
    }
    if (staleIds.length > 0) {
      // Force-exit maintenance for any of these in an open window (see 2a).
      await releaseAssetsForDecommission(staleIds, {
        at: new Date(now),
        actor,
        statusChangedBy: integrationLabel,
        reason: "no longer reported by its controller",
      });
      await prisma.asset.updateMany({
        where: { id: { in: staleIds } },
        data: { status: "decommissioned", statusChangedAt: new Date(now), statusChangedBy: integrationLabel },
      });
      // The device is gone from its controller's inventory — deletion at source,
      // which business rule 16 already treats as config truth. Give the address
      // back rather than leaving it claimed (or, once auto-push exists, leaving a
      // real MAC→IP binding orphaned on the gate). Never throws.
      await releaseInfraReservationsForAssets(staleIds, {
        reason: "no longer reported by its controller",
        actor,
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 2c — Auto-Monitor Interfaces apply pass
  phaseMark("2c");
  //
  // For each per-class block (fortigate / fortiswitch / fortiap), if an
  // `autoMonitorInterfaces` selection has been configured on this integration,
  // resolve it against each discovered asset's latest AssetInterfaceSample rows
  // and union the result into Asset.monitoredInterfaces. Strictly additive.
  //
  // Only applies to fortimanager + fortigate integrations. windowsserver /
  // entraid / activeDirectory don't manage Fortinet hardware.
  if (sweepPhaseEnabled(mode, "2c") && (isFortinetIntegrationType(integrationType))) {
    const integ = await prisma.integration.findUnique({
      where: { id: integrationId },
      select: { config: true },
    });
    const cfg = (integ?.config ?? {}) as Record<string, any>;
    for (const [klass, blockKey] of [
      ["fortigate",   "fortigateMonitor"],
      ["fortiswitch", "fortiswitchMonitor"],
      ["fortiap",     "fortiapMonitor"],
    ] as const) {
      // Same legacy-shape coercion as the on-demand apply route, for the
      // window between deploy and the one-shot migration sweeping configs.
      const selection = autoMonitor.coerceLegacySelection(cfg[blockKey]?.autoMonitorInterfaces ?? null);
      if (!selection) continue;
      try {
        const r = await autoMonitor.applyAutoMonitorForClass(integrationId, klass, selection, actor);
        if (r.interfacesAdded > 0) {
          syncLog("info", `Auto-monitor (${klass}): pinned ${r.interfacesAdded} interface(s) on ${r.devices} device(s)`);
          await logEvent({
            action:       "integration.auto_monitor_interfaces.applied",
            resourceType: "integration",
            resourceId:   integrationId,
            resourceName: integrationName,
            actor,
            message:      `Auto-monitor interfaces applied for "${integrationName}" (${klass}) — ${r.devices} device(s), ${r.interfacesAdded} interface(s) added`,
            details:      { class: klass, devices: r.devices, interfacesAdded: r.interfacesAdded },
          });
        }
      } catch (err: any) {
        syncLog("error", `Auto-monitor (${klass}) failed: ${err?.message || "Unknown error"}`);
      }
    }
  }

  } // end mode !== "skip-deprecation" (Phase 2 + 2a + 2b + 2c; "finalize-scoped" runs 2b only — see sweepPhaseEnabled)

  if (mode === "full" || mode === "skip-deprecation") {
  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 3 — Create/update FortiGate device assets (in-memory serial lookup)
  phaseMark("3");
  // ══════════════════════════════════════════════════════════════════════════════

  for (const device of result.devices) {
    try {
      const fgHostname = device.hostname || device.name;
      // ─── Location → coords resolution (FortiGate-only, opt-in) ───────────
      // Resolved ONCE per device (not per HA member — cluster members are
      // physically co-located and share a location). Two opt-in sources feed
      // the geocoder; an address metavar (FMG-only) WINS when set + populated,
      // with SNMP sysLocation as the fallback. The geocoded coords feed the
      // observed blob for every member's AssetSource row and drive the
      // projection-tier-1 coord resolution; `snmpLocation` (when pulled) is
      // stored regardless for display on the asset General tab.
      const fgIsFortinet = isFortinetIntegrationType(integrationType);
      let devSnmpLocation: string | null = null;
      let devSnmpLocationFetchedAt: Date | null = null;
      let devGeocodedLat: number | null = null;
      let devGeocodedLng: number | null = null;
      // Address metavar string for this device (FMG-only; blank unless an
      // address metavar is configured AND populated on the device).
      const addressMetavarValue =
        addressMetavar && typeof device.metavarAddress === "string"
          ? device.metavarAddress.trim()
          : "";
      // Pull + store sysLocation whenever the toggle is on (independent of which
      // source ends up driving the coords).
      if (pullSnmpLocation && fgIsFortinet && integrationConfig) {
        devSnmpLocationFetchedAt = new Date();
        try {
          devSnmpLocation = await fetchFortigateSysLocation({
            integration: { id: integrationId, type: integrationType, config: integrationConfig },
            deviceName: device.name,
          });
        } catch (err: any) {
          syncLog("error", `${fgHostname}: SNMP location pull threw — ${err?.message || "Unknown error"}`);
        }
      }
      // Geocode source: address metavar wins; SNMP sysLocation is the
      // fallback ONLY when the operator opted into sysLocation-derived
      // coordinates (useSnmpLocationCoords) — the geocoded pair is
      // projection tier-1 and would otherwise silently override coords
      // learned from the device. With the toggle off, sysLocation is still
      // pulled + stored for display (Asset.snmpLocation) but never drives
      // the map pin.
      const snmpGeoCandidate = useSnmpLocationCoords ? (devSnmpLocation || "") : "";
      const geoString = addressMetavarValue || snmpGeoCandidate;
      const geoSource = addressMetavarValue ? "address-metavar" : (snmpGeoCandidate ? "snmp" : null);
      if (geoString) {
        try {
          const geo = await geocode(geoString);
          if (isValidGeoCoord(geo.latitude, geo.longitude)) {
            devGeocodedLat = geo.latitude;
            devGeocodedLng = geo.longitude;
            if (verboseLogging) {
              logger.info(
                { verbose: true, integrationId, deviceName: device.name, geoSource, location: geoString, lat: devGeocodedLat, lng: devGeocodedLng, cached: geo.cached },
                "discovery.location.geocoded",
              );
            }
          }
        } catch (err: any) {
          syncLog("error", `${fgHostname}: Geocode of ${geoSource} "${geoString}" failed — ${err?.message || "Unknown error"}`);
        }
      }
      // HA fan-out: when the cluster reports multiple members, write one
      // Asset row per physical member keyed on its own stable serial. Each
      // member's identity (serial + hostname) survives failover because we
      // never look up by `device.sn` (which flips on failover); we look up
      // by `member.serial`. The "current primary" is the member flagged
      // isPrimary=true — it holds the cluster IP and inherits the cluster's
      // top-level model/osVersion. Standby members get the same model/
      // osVersion (cluster members run identical builds) but ipAddress=null
      // since the cluster IP routes only to the active member.
      const haMembers = Array.isArray(device.haMembers) && device.haMembers.length > 0
        ? device.haMembers
        : null;
      const clusterMode: "standalone" | "a-p" | "a-a" = haMembers
        ? (device.haMode === "a-a" ? "a-a" : "a-p")
        : "standalone";
      // Build the per-iteration member list. For standalone, synthesize a
      // single primary-only entry so the loop body stays uniform.
      type MemberCtx = {
        serial: string;
        memberHostname: string;
        isPrimary: boolean;
        peerSerial: string | null;
        // Per-member health from the HA roster (FMG ha_slave[].status /
        // presence in FortiOS ha-peer). null = roster carried no signal.
        memberStatus: "up" | "down" | null;
      };
      const members: MemberCtx[] = haMembers
        ? haMembers.map((m) => {
            const others = haMembers.filter((x) => x.serial !== m.serial);
            return {
              serial: m.serial,
              memberHostname: m.name || (m.isPrimary ? fgHostname : ""),
              isPrimary: m.isPrimary,
              peerSerial: others[0]?.serial || null,
              memberStatus: m.status ?? null,
            };
          })
        : [{
            serial: device.serial || "",
            memberHostname: fgHostname,
            isPrimary: true,
            peerSerial: null,
            memberStatus: null,
          }];

      for (const member of members) {
        // Topology JSON is per-member. HA members carry haMode/haRole/
        // haPeerSerial so the asset edit modal + topology graph can show
        // the cluster relationship without re-querying FMG.
        // `deviceName` is the FMG/dvmdb device name (differs from the member
        // hostname on renamed devices and on HA members). Stamped so device-
        // targeted write paths (description sync, and any future push) can
        // build a transport without a dvmdb lookup; hostname stays the
        // display identity.
        // Managed-device membership, stamped on EVERY cluster member: an HA pair
        // is one logical controller and its switches/APs are cabled to both, so
        // both rows must carry the same member list (which is also what removes
        // any need for an HA carve-out in the dependency constraint).
        //
        // Only stamped when the roster ANSWERED. Absent means unknown, and the
        // whole-object replace below is what makes that self-correcting: a run
        // whose roster read failed simply omits the fields again.
        const membershipKey = (device.name || fgHostname || "").toLowerCase();
        const membershipStamp: Record<string, unknown> = {};
        if (membershipSwitchKnown.has(membershipKey)) {
          membershipStamp.managedSwitchSerials = [...(membershipSwitchByDevice.get(membershipKey) ?? [])];
        }
        if (membershipApKnown.has(membershipKey)) {
          membershipStamp.managedApSerials = [...(membershipApByDevice.get(membershipKey) ?? [])];
        }
        if (Object.keys(membershipStamp).length > 0) {
          membershipStamp.managedInventoryAt = new Date().toISOString();
        }
        const memberTopology: Record<string, unknown> = haMembers
          ? {
              role: "fortigate" as const,
              deviceName: device.name || fgHostname,
              haMode: clusterMode,
              haRole: member.isPrimary ? "primary" : "secondary",
              ...(member.peerSerial ? { haPeerSerial: member.peerSerial } : {}),
              // Roster-reported member health (see MemberCtx.memberStatus).
              // Drives the standby's "Standby" / "Standby Down" pill — the
              // only live health signal for a box the cluster IP never
              // routes to. Omitted (not nulled) when the roster carried no
              // signal so the UI can distinguish "healthy" from "unknown".
              ...(member.memberStatus ? { haMemberStatus: member.memberStatus } : {}),
              // Display-only cluster IP for the standby member. Deliberately
              // NOT Asset.ipAddress (which stays null on the standby): every
              // IP-keyed dedup/probe/reservation path assumes one asset per
              // IP, and any probe of this IP reaches the ACTIVE member.
              ...(!member.isPrimary && device.mgmtIp ? { haClusterIp: device.mgmtIp } : {}),
              ...membershipStamp,
            }
          : { role: "fortigate" as const, deviceName: device.name || fgHostname, ...membershipStamp };
        const memberHaCtx = haMembers && member.peerSerial
          ? {
              haMode: clusterMode as "a-p" | "a-a",
              haRole: (member.isPrimary ? "primary" : "secondary") as "primary" | "secondary",
              haPeerSerial: member.peerSerial,
            }
          : undefined;
        // Asset write payload's device-shape view — per-member fields. The
        // standby member gets ipAddress=null (cluster IP routes only to the
        // active member) but inherits the cluster's model/osVersion/geo
        // (members in an HA pair run identical hardware/firmware at the
        // same site).
        const memberDevice = {
          name: device.name,
          hostname: member.memberHostname || fgHostname,
          serial: member.serial,
          model: device.model,
          osVersion: device.osVersion,
          mgmtIp: member.isPrimary ? device.mgmtIp : "",
          // mgmt-interface MAC + all physical interface MACs, primary member
          // only — the resolved MACs belong to the box REST currently reaches
          // (the active member). Stamping them on the standby would be wrong.
          // Undefined for the standby + when the interface query surfaced none.
          mgmtMac: member.isPrimary ? device.mgmtMac : undefined,
          interfaceMacs: member.isPrimary ? device.interfaceMacs : undefined,
          latitude: device.latitude,
          longitude: device.longitude,
          // FMG-only metavars + per-device SNMP pull. Undefined when the
          // integration isn't FMG (standalone has no metavars) or the
          // toggles weren't enabled. The observed-blob helper coerces
          // missing/non-finite to null so the projection tier rules see a
          // consistent shape.
          metavarLatitude: device.metavarLatitude,
          metavarLongitude: device.metavarLongitude,
          snmpLocation: devSnmpLocation,
          snmpGeocodedLatitude: devGeocodedLat,
          snmpGeocodedLongitude: devGeocodedLng,
          metavarAddress: device.metavarAddress,
          // True when this gate was offline in FMG and its config came from
          // FMG's cached CMDB (see fortimanagerService DiscoveredDevice.offline).
          // Config-only: withhold presence + decommission-resurrection below.
          offline: (device as { offline?: boolean }).offline === true,
        };
      // Match by serial first; fall back to hostname/IP for assets that
      // pre-date a serial (e.g. the placeholder created by registerFortinetHost
      // on integration create, which has no serialNumber). Mirrors how the
      // FortiSwitch and FortiAP discovery paths dedupe.
      // Fallback only fires for the primary member: standby members must
      // be keyed by serial (no legacy hostname/IP path could have created
      // a separate Asset for them).
      let existingAsset: any = member.serial ? assetIdx.findBySerial(member.serial) : null;
      if (!existingAsset && member.isPrimary) {
        existingAsset = assetIdx.findByEntry(undefined, fgHostname, device.mgmtIp || undefined);
      }
      // Serial-mismatch guard — same rule as the FortiSwitch/FortiAP loops:
      // the hostname/IP fallback exists for serial-less placeholder rows;
      // it must never bind to an asset carrying a DIFFERENT non-empty
      // serial (an RMA'd chassis keeping the old hostname is new hardware —
      // Phase 2a retires the old asset by serial).
      if (existingAsset && member.serial && existingAsset.serialNumber
          && String(existingAsset.serialNumber).toUpperCase() !== member.serial.toUpperCase()) {
        existingAsset = null;
      }
      if (existingAsset) {
        // Snapshot material fields before the branch mutates existingAsset in
        // place (macAddresses / status below) so the per-asset audit diff is
        // computed against the true pre-write state.
        const fwBefore = snapshotMaterialAssetFields(existingAsset);
        // Phase 3b.1 cutover: discovery-owned fields come from projection.
        // Same shape as AD/Entra cutovers — upsert source first, fetch all
        // sources, project, single Asset.update.
        if (member.serial) {
          try {
            const syncedAt = new Date(now);
            const observed = buildFortigateFirewallObservedBlob(memberDevice, integrationType as "fortimanager" | "fortigate", syncedAt, memberHaCtx);
            await upsertFortigateFirewallAssetSource(existingAsset.id, integrationId, member.serial, observed, syncedAt, memberDevice.offline ? null : syncedAt);
            applyInfraSourceInMemory(existingAsset.id, "fortigate-firewall", member.serial, observed, memberDevice.offline ? null : syncedAt, syncedAt);
          } catch (err: any) {
            syncLog("error", `Failed to upsert fortigate-firewall AssetSource for ${memberDevice.hostname || device.name}: ${err?.message || "Unknown error"}`);
          }
        }
        const fwSourceRows = infraSourcesOf(existingAsset.id);
        // Sweep any stale fortigate-endpoint source — a newly-deployed
        // FortiGate is often first sighted as a DHCP client of an existing
        // gate (endpoint source with the leased IP) before being adopted
        // into FMG; once the fortigate-firewall source exists that sighting
        // is a stale placeholder that would otherwise linger forever (the
        // endpoint pathways skip infra-typed assets, so it never refreshes
        // or clears). Parity with the FortiSwitch/FortiAP adoption sweeps.
        // Also excluded from this cycle's projection input so the mgmt IP
        // wins immediately rather than on the next run.
        let fwSourcesForProjection = fwSourceRows;
        if (fwSourceRows.some((s) => s.sourceKind === "fortigate-endpoint")) {
          fwSourcesForProjection = fwSourceRows.filter((s) => s.sourceKind !== "fortigate-endpoint");
          try {
            await prisma.assetSource.deleteMany({
              where: { assetId: existingAsset.id, sourceKind: "fortigate-endpoint" },
            });
            dropInfraSourceKindInMemory(existingAsset.id, "fortigate-endpoint");
          } catch { /* best-effort */ }
        }
        const { projected: fwProjected } = projectAssetFromSources(fwSourcesForProjection);

        const updateData: Record<string, unknown> = {
          // learnedLocation for firewalls: always the firewall's own
          // hostname. Deterministic overwrite (not `existing || hostname`)
          // so any rows polluted by the earlier SNMP-into-learnedLocation
          // experiment get healed on the next discovery cycle. The SNMP
          // sysLocation string is captured separately on Asset.snmpLocation
          // and surfaced on the details General tab.
          learnedLocation: memberDevice.hostname || fgHostname || existingAsset.learnedLocation,
          fortinetTopology: memberTopology,
          discoveredByIntegrationId: integrationId,
          // Correct assetType when the asset was created via a different
          // pathway (DHCP-client sighting, device-inventory) before FMG
          // adoption typed it — a serial-matched member of the firewall
          // roster IS a firewall. Mirrors the FortiSwitch/FortiAP blocks.
          ...(existingAsset.assetType !== "firewall" ? { assetType: "firewall" } : {}),
          // Resurrection: only a live-verified read may flip a decommissioned
          // firewall back to active. An offline gate's cached CMDB is NOT
          // presence evidence (business rule #12) — leave a decommissioned
          // firewall decommissioned when its config came from FMG's cache.
          ...(existingAsset.status === "decommissioned" && !memberDevice.offline ? { status: "active", statusChangedAt: new Date(now), statusChangedBy: integrationLabel } : {}),
        };
        // A firewall reaching this branch answered the FMG/REST queries that
        // produced this payload — that response is the presence evidence.
        // Exception: an offline gate's config came from FMG's cached CMDB, not
        // the device itself, so it is NOT presence — do not advance lastSeen.
        if (!memberDevice.offline) bumpLastSeen(updateData, existingAsset, new Date(now), "discovery");
        // Discovery-owned fields from projection.
        if (fwProjected.hostname !== null) updateData.hostname = fwProjected.hostname;
        if (fwProjected.model !== null) updateData.model = fwProjected.model;
        if (fwProjected.osVersion !== null) updateData.osVersion = fwProjected.osVersion;
        if (fwProjected.manufacturer !== null) updateData.manufacturer = fwProjected.manufacturer;
        if (fwProjected.serialNumber !== null) updateData.serialNumber = fwProjected.serialNumber;
        // Failover-resilient IP handling: only the current primary holds the
        // cluster IP. For the standby, explicitly null the IP — this is
        // a normal role swap on failover, not a conflict, so we bypass the
        // standard ip-source path. The standby's `monitored` flag stays
        // whatever the operator chose; an operator monitoring the cluster
        // IP via the primary asset doesn't get cross-bled to the standby.
        if (haMembers && !member.isPrimary) {
          updateData.ipAddress = null;
          updateData.ipSource = null;
        } else if (fwProjected.ipAddress !== null) {
          updateData.ipAddress = fwProjected.ipAddress;
          updateData.ipSource = memberDevice.hostname || fgHostname || integrationType;
        }
        // Operator-typed coordinates (coordSource="manual", set via the asset
        // edit form) outrank the projected device-side coords — skip the
        // write so discovery never clobbers a manual pin. Clearing the manual
        // pair resets coordSource to null, which re-opens this path.
        if (existingAsset.coordSource !== "manual") {
          if (fwProjected.latitude !== null) updateData.latitude = fwProjected.latitude;
          if (fwProjected.longitude !== null) updateData.longitude = fwProjected.longitude;
        }
        // SNMP sysLocation is projection-owned for display, but the
        // fetched-at timestamp lives outside the projection (no source
        // would naturally own it) — stamp it directly on Asset when we
        // pulled this cycle. Empty sysLocation still bumps fetchedAt so
        // the UI can show "checked X minutes ago, no value reported".
        if (devSnmpLocationFetchedAt) {
          updateData.snmpLocation = fwProjected.snmpLocation;
          updateData.snmpLocationFetchedAt = devSnmpLocationFetchedAt;
        }
        // Learned street address from the FMG address metavar. Only (re)written
        // when an address metavar is configured this cycle — mirrors the
        // snmpLocation "only when we looked" rule so an integration without an
        // address metavar never clobbers an address learned earlier. When the
        // metavar is configured but empty on this device, projection yields null
        // and the field is cleared.
        if (addressMetavar) {
          updateData.learnedAddress = fwProjected.learnedAddress;
        }
        // Backfill macAddress + AssetMacAddress from EVERY physical interface
        // MAC (primary member only). Mirrors the FortiSwitch backfill above.
        // A peer FortiGate can sight this firewall on any interface, so indexing
        // all of them is the only reliable way to stop discovery's MAC-keyed
        // paths (Phase 7 device-inventory, Phase 7.5 MAC-table) from spawning a
        // phantom `fortigate-endpoint` ghost. Idempotent — MACs already in
        // macList only get their lastSeen + source bumped. Scalar macAddress is
        // the mgmt-interface MAC (stable identity) when not already set.
        const fwMacs = normalizeMacsDistinct([memberDevice.mgmtMac, ...(memberDevice.interfaceMacs ?? [])]);
        let fwMacListForReconcile: MacJsonEntry[] | null = null;
        if (fwMacs.length) {
          const macList: MacJsonEntry[] = Array.isArray(existingAsset.macAddresses) ? [...(existingAsset.macAddresses as any)] : [];
          for (const mac of fwMacs) {
            const existingMacEntry = macList.find((m) => m.mac === mac);
            if (existingMacEntry) {
              existingMacEntry.lastSeen = now;
              existingMacEntry.source = "fortigate-firewall";
            } else {
              macList.push({ mac, lastSeen: now, source: "fortigate-firewall" });
            }
          }
          macList.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
          if (!existingAsset.macAddress) updateData.macAddress = memberDevice.mgmtMac || fwMacs[0];
          existingAsset.macAddresses = macList;
          fwMacListForReconcile = macList;
        }
        clampAcquiredToLastSeen(updateData, existingAsset);
        // Auto-Monitor sweep: enforce monitored = fortigateAddAsMonitored on
        // every cycle unless the operator has set a divergent override.
        // Standby HA members are excluded.
        const isStandbyMember = haMembers != null && !member.isPrimary;
        Object.assign(updateData, buildFortigateMonitorStamp(existingAsset, isStandbyMember));
        await prisma.asset.update({ where: { id: existingAsset.id }, data: updateData });
        logDiscoveryAssetUpdated(fwBefore, updateData, existingAsset.id, memberDevice.hostname || device.name, {
          integrationName, integrationId, sourceKind: "fortigate-firewall", actor,
        });
        // HA standby health transition. The roster status stamped into
        // memberTopology above is the standby's only live health signal
        // (probes route to the active member), so an up/unknown→down flip
        // gets a warning Event — the hook for event-trigger notification
        // rules — and the recovery an info Event. Primary members are
        // excluded (probes + upstream conn status cover them), as are
        // offline-in-FMG clusters (cached-CMDB roster is stale, not
        // evidence — same posture as the lastSeen/resurrection guards).
        if (!member.isPrimary && !memberDevice.offline && member.memberStatus) {
          const prevMemberStatus = (existingAsset.fortinetTopology as Record<string, unknown> | null)?.haMemberStatus;
          const memberLabel = `${memberDevice.hostname || member.serial} (${member.serial})`;
          if (member.memberStatus === "down" && prevMemberStatus !== "down") {
            logEvent({
              action: "asset.ha.standby_down", resourceType: "asset", resourceId: existingAsset.id,
              resourceName: memberDevice.hostname || device.name, actor, level: "warning",
              message: `[${integrationName}] HA standby ${memberLabel} reported DOWN in cluster ${device.name || fgHostname}'s HA roster`,
            });
          } else if (member.memberStatus === "up" && prevMemberStatus === "down") {
            logEvent({
              action: "asset.ha.standby_restored", resourceType: "asset", resourceId: existingAsset.id,
              resourceName: memberDevice.hostname || device.name, actor, level: "info",
              message: `[${integrationName}] HA standby ${memberLabel} is back UP in cluster ${device.name || fgHostname}'s HA roster`,
            });
          }
        }
        if (fwMacListForReconcile) {
          await reconcileMacAddresses(existingAsset.id, fwMacListForReconcile);
        }
        // Update in-memory index. For the primary, mirror the cluster IP +
        // active hostname back; for the standby, clear IP and use member
        // hostname so future lookups find each Asset by its stable identity.
        if (member.isPrimary && device.mgmtIp) existingAsset.ipAddress = device.mgmtIp;
        else if (haMembers && !member.isPrimary) existingAsset.ipAddress = null;
        if (memberDevice.hostname) existingAsset.hostname = memberDevice.hostname;
        if (device.model) existingAsset.model = device.model;
        if (!existingAsset.learnedLocation) existingAsset.learnedLocation = memberDevice.hostname || fgHostname;
        if (existingAsset.status === "decommissioned") existingAsset.status = "active";
        // Mirror the backfilled MACs so the same-cycle Phase 7 lookup finds
        // this firewall byMac (reindex below reads existingAsset.macAddress +
        // .macAddresses — the latter already holds every interface MAC from the
        // merge above), preventing a ghost even on first discovery.
        if (updateData.macAddress) existingAsset.macAddress = updateData.macAddress as string;
        assetIdx.reindex(existingAsset);
        assetNames.push(`${memberDevice.hostname || device.name}${haMembers ? ` (HA ${member.isPrimary ? "primary" : "secondary"})` : ""} (updated)`);
        continue;
      }

      // New FortiGate — set the Device Map tag (fgt:<serial>) so the map endpoint
      // can find this device by a stable key even if hostname/model changes later.
      const fgTag = member.serial ? `fgt:${member.serial}` : null;
      // Phase 3b.1 cutover: project from a synthetic single-source array
      // built directly from this just-discovered firewall's observed blob.
      // Pure projection, no DB roundtrip — new asset has no other sources.
      const fwSyncedAt = new Date(now);
      const fwObserved = buildFortigateFirewallObservedBlob(memberDevice, integrationType as "fortimanager" | "fortigate", fwSyncedAt, memberHaCtx);
      const { projected: fwCreateProjected } = projectAssetFromSources([
        { sourceKind: "fortigate-firewall", inferred: false, observed: fwObserved },
      ]);
      const isStandbyCreate = haMembers != null && !member.isPrimary;
      // Distinct physical interface MACs to seed (mgmt MAC first as scalar
      // identity). Empty for the standby (memberDevice carries none) + when the
      // interface query surfaced nothing usable.
      const fwCreateMacs = normalizeMacsDistinct([memberDevice.mgmtMac, ...(memberDevice.interfaceMacs ?? [])]);
      const newAsset = await prisma.asset.create({
        data: {
          // Standby member: explicit null (cluster IP only routes to active).
          ipAddress: isStandbyCreate ? null : fwCreateProjected.ipAddress,
          ...(isStandbyCreate
            ? {}
            : (fwCreateProjected.ipAddress ? { ipSource: memberDevice.hostname || fgHostname || integrationType } : {})),
          hostname: fwCreateProjected.hostname || memberDevice.hostname || fgHostname,
          serialNumber: fwCreateProjected.serialNumber || member.serial || null,
          // Every physical interface MAC (primary member only — undefined for
          // the standby). Seeded on create so the next discovery cycle's
          // MAC-keyed dedup recognizes this firewall on whichever interface a
          // peer sighted it and never spawns a phantom `fortigate-endpoint`
          // asset. Scalar macAddress is the mgmt-interface MAC when present.
          ...(fwCreateMacs.length
            ? {
                macAddress: memberDevice.mgmtMac || fwCreateMacs[0],
                macAddressRows: { create: buildMacRowsForCreate(fwCreateMacs.map((mac) => ({ mac, lastSeen: now, source: "fortigate-firewall" }))) },
              }
            : {}),
          // Phase 4d: legacy `assetTag = fgt:<serial>` write retired —
          // AssetSource (sourceKind="fortigate-firewall", externalId=serial)
          // upserted just below is the canonical identity link.
          manufacturer: fwCreateProjected.manufacturer || "Fortinet",
          model: fwCreateProjected.model || "FortiGate",
          assetType: "firewall",
          status: "active",
          statusChangedAt: new Date(now),
          statusChangedBy: integrationLabel,
          department: "Network Security",
          // learnedLocation for firewalls: the firewall's own hostname.
          // Projection leaves this null for firewall sources by design —
          // set explicitly here. The SNMP sysLocation string is captured
          // separately on Asset.snmpLocation for the details General tab.
          learnedLocation: memberDevice.hostname || fgHostname,
          osVersion: fwCreateProjected.osVersion,
          // A first-seen offline gate's config came from FMG's cached CMDB, not
          // a live query — create it WITHOUT verified presence (lastSeen null),
          // like directory-only assets. A later live discovery cycle stamps it.
          ...(memberDevice.offline ? {} : { lastSeen: new Date(now), lastSeenSource: "discovery" }),
          // Stamp the discovering integration. The polling-method resolver
          // picks the source default (REST API for fortimanager / fortigate)
          // unless an operator overrides per-asset on the Monitoring tab.
          discoveredByIntegrationId: integrationId,
          // Auto-Monitored is opt-in via the integration's "Add Discovered
          // FortiGates as Monitored" checkbox. Standby HA members default
          // to monitored=false regardless — they aren't directly REST-
          // reachable through the cluster IP, so monitoring would just be
          // failed probes until failover. Operators can opt in per-asset.
          ...(fortigateAddAsMonitored && !isStandbyCreate ? { monitored: true } : {}),
          ...(fwCreateProjected.latitude !== null ? { latitude: fwCreateProjected.latitude } : {}),
          ...(fwCreateProjected.longitude !== null ? { longitude: fwCreateProjected.longitude } : {}),
          ...(fwCreateProjected.snmpLocation !== null ? { snmpLocation: fwCreateProjected.snmpLocation } : {}),
          ...(addressMetavar && fwCreateProjected.learnedAddress !== null ? { learnedAddress: fwCreateProjected.learnedAddress } : {}),
          ...(devSnmpLocationFetchedAt ? { snmpLocationFetchedAt: devSnmpLocationFetchedAt } : {}),
          fortinetTopology: memberTopology as any,
          notes: isStandbyCreate
            ? `Auto-discovered from ${integrationLabel} integration (HA standby member)`
            : `Auto-discovered from ${integrationLabel} integration`,
          tags: isStandbyCreate
            ? ["fortigate", "auto-discovered", "ha-standby"]
            : ["fortigate", "auto-discovered"],
        },
      });
      // Explicit fortigate-firewall AssetSource upsert with rich observed
      // blob. The Asset.create already triggered the shadow-write extension
      // which laid down a skeleton row from the assetTag — this overwrites
      // it with truth.
      if (member.serial) {
        try {
          const syncedAt = new Date(now);
          const observed = buildFortigateFirewallObservedBlob(memberDevice, integrationType as "fortimanager" | "fortigate", syncedAt, memberHaCtx);
          await upsertFortigateFirewallAssetSource(newAsset.id, integrationId, member.serial, observed, syncedAt, memberDevice.offline ? null : syncedAt);
          // Seed the mirror: a roster that lists the same device twice would
          // otherwise project the second visit from a map missing this row.
          applyInfraSourceInMemory(newAsset.id, "fortigate-firewall", member.serial, observed, memberDevice.offline ? null : syncedAt, syncedAt);
        } catch (err: any) {
          syncLog("error", `Created FortiGate asset ${memberDevice.hostname || device.name} but failed to upsert AssetSource row: ${err?.message || "Unknown error"}`);
        }
      }
      logDiscoveryAssetCreated(newAsset.id, memberDevice.hostname || device.name, {
        integrationName, integrationId, sourceKind: "fortigate-firewall", actor,
      });
      // First sighting of a standby that's ALREADY failed in the roster —
      // no prior topology stamp to diff against, so emit the warning
      // unconditionally (the update branch's transition guard takes over
      // from the next cycle).
      if (isStandbyCreate && !memberDevice.offline && member.memberStatus === "down") {
        logEvent({
          action: "asset.ha.standby_down", resourceType: "asset", resourceId: newAsset.id,
          resourceName: memberDevice.hostname || device.name, actor, level: "warning",
          message: `[${integrationName}] HA standby ${memberDevice.hostname || member.serial} (${member.serial}) reported DOWN in cluster ${device.name || fgHostname}'s HA roster`,
        });
      }
      assetIdx.add(newAsset);
      assetNames.push(`${memberDevice.hostname || device.name}${haMembers ? ` (HA ${member.isPrimary ? "primary" : "secondary"})` : ""}`);
      } // end inner for-member loop

      // ─── Geocoded-coords write-back (FortiGate-only, opt-in) ─────────────
      // Fires once per FortiGate (not per HA member — coord write is a
      // cluster-wide change). Only when the SNMP-geocode succeeded AND the
      // current FortiGate CMDB coords don't already match within tolerance.
      // Best-effort: failure is logged but doesn't unwind the Asset writes
      // that already landed.
      if (
        pushGeocodedCoords &&
        devGeocodedLat !== null &&
        devGeocodedLng !== null &&
        integrationConfig
      ) {
        const cmdbLat = device.latitude;
        const cmdbLng = device.longitude;
        const cmdbValid = isValidGeoCoord(cmdbLat, cmdbLng);
        const matches = cmdbValid && coordsClose(devGeocodedLat, devGeocodedLng, cmdbLat!, cmdbLng!);
        if (!matches) {
          try {
            const pushResult = await pushCoordsToFortigate(
              { id: integrationId, type: integrationType, config: integrationConfig },
              device.name,
              devGeocodedLat,
              devGeocodedLng,
              latitudeMetavar,
              longitudeMetavar,
            );
            if (pushResult.ok) {
              logEvent({
                action: "integration.coords.pushed",
                resourceType: "integration",
                resourceId: integrationId,
                resourceName: integrationName,
                actor,
                message: `[${integrationName}] Pushed geocoded coords ${devGeocodedLat.toFixed(6)},${devGeocodedLng.toFixed(6)} to ${fgHostname} (targets: ${pushResult.targets.join(", ")})`,
              });
            } else {
              logEvent({
                action: "integration.coords.push_failed",
                resourceType: "integration",
                resourceId: integrationId,
                resourceName: integrationName,
                actor,
                level: "warning",
                message: `[${integrationName}] Failed to push geocoded coords to ${fgHostname}: ${pushResult.error}`,
              });
            }
          } catch (err: any) {
            syncLog("error", `Coord write-back to ${fgHostname} threw — ${err?.message || "Unknown error"}`);
          }
        }
      }
    } catch (err: any) {
      syncLog("error", `Failed to create/update asset for device ${device.name}: ${err.message || "Unknown error"}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 3b — Create/update FortiSwitch and FortiAP assets + reservations
  phaseMark("3b");
  // ══════════════════════════════════════════════════════════════════════════════

  // Auto-stamping policy for managed FortiSwitch / FortiAP. `enabled` drives
  // credential stamping (direct polling SNMP/SSH); `addAsMonitored` drives
  // the bidirectional `monitored` sweep through the monitor-override model.
  //
  //   enabled=false, addAsMonitored=false  → ensure monitored=false (sweep off)
  //   enabled=false, addAsMonitored=true   → stamp monitored=true; resolver
  //                                          falls back to the source default
  //                                          (ICMP) since no credential is
  //                                          configured for this class
  //   enabled=true,  addAsMonitored=false  → stamp monitorCredentialId AND
  //                                          ensure monitored=false (sweep off)
  //   enabled=true,  addAsMonitored=true   → stamp credential AND flip
  //                                          monitored=true (sweep on)
  //
  // Monitor-override semantics: when the operator's current `monitored`
  // diverges from `addAsMonitored`, `Asset.monitorOverride` is true and
  // discovery leaves `monitored` alone (operator wins). When they match,
  // override is false and discovery enforces `monitored = addAsMonitored`
  // on every cycle. Credentials are still preserved when the operator
  // pointed at a different one (a soft override on credential identity).
  function buildClassMonitorStamp(
    cfg: ClassMonCfg,
    existing?: { monitorCredentialId?: string | null; monitored?: boolean | null; monitorOverride?: boolean | null },
  ): Record<string, unknown> {
    if (!cfg.enabled && !cfg.addAsMonitored && existing?.monitored !== true) {
      // No opt-in and the asset isn't currently monitored — nothing to do.
      // (Integration attribution is NOT this function's job: the switch/AP
      // create + update paths stamp `discoveredByIntegrationId`
      // unconditionally themselves, so the Inherit-from-integration option
      // and the decommission sweep work regardless of this toggle.)
      return {};
    }

    const stamp: Record<string, unknown> = {};
    // Stamp the integration's class credential only when the existing
    // asset has none (or has the same credential — the no-op idempotent
    // case). Anything else (operator-chosen credential of a different
    // type or pointing elsewhere) is preserved.
    //
    // The credential to stamp is pre-resolved into stampCredentialId based
    // on the integration's responseTimePolling: SSH polling stamps the SSH
    // credential, anything else stamps the SNMP credential.
    if (cfg.enabled && cfg.stampCredentialId) {
      const existingCred = existing?.monitorCredentialId ?? null;
      if (existingCred === null || existingCred === cfg.stampCredentialId) {
        stamp.monitorCredentialId = cfg.stampCredentialId;
      }
      // Operator-chosen credential pointing elsewhere stays in place; we
      // still continue to the monitored sweep below (credential identity
      // is a separate concern from the monitored bit).
    }
    // Monitored sweep: discovery enforces `monitored = addAsMonitored`
    // unless the operator has set an override. New assets land here with
    // `monitorOverride=false` (Prisma default) and `monitored=false`, so
    // the integration's flag still picks the initial state cleanly.
    if (existing?.monitorOverride !== true) {
      const desired = cfg.addAsMonitored === true;
      if (desired && existing?.monitored !== true) {
        stamp.monitored = true;
      } else if (!desired && existing?.monitored === true) {
        stamp.monitored = false;
      }
    }
    return stamp;
  }

  /**
   * FortiGate-class equivalent (no enabled/credential branch — the FortiGate
   * integration always uses its own API token, no per-class credential to
   * stamp). HA standby members are actively swept to monitored=false: they
   * aren't probe-reachable (their Asset IP is nulled; the cluster IP routes
   * to the active member), so polling one is guaranteed-failure waste — and
   * without the sweep, a failover leaves the ex-primary monitored=true
   * forever, burning probe slots and raising false down noise. The flip-off
   * respects monitorOverride so an operator who deliberately pinned
   * monitoring on a standby (e.g. probing a dedicated HA mgmt interface via
   * dnsName) keeps their choice; the role flips on failover are what make
   * this a per-cycle sweep rather than a create-time default.
   */
  function buildFortigateMonitorStamp(
    existing: { monitored?: boolean | null; monitorOverride?: boolean | null },
    isStandby: boolean,
  ): Record<string, unknown> {
    if (existing.monitorOverride === true) return {};
    if (isStandby) {
      // consecutiveFailures reset mirrors the db.ts decommission/disable
      // clamp — don't let pre-failover probe-failure streaks linger.
      return existing.monitored === true ? { monitored: false, consecutiveFailures: 0 } : {};
    }
    const desired = fortigateAddAsMonitored;
    if (desired && existing.monitored !== true) return { monitored: true };
    if (!desired && existing.monitored === true) return { monitored: false };
    return {};
  }

  /**
   * Sibling endpoint-ghost sweep for the FortiSwitch / FortiAP loops below.
   *
   * A managed device's mgmt interface pulls a DHCP lease from its FortiGate,
   * so the DHCP / device-inventory pathway learns the MAC independently and
   * creates a separate "fortigate-endpoint" asset — hostname = the device
   * serial (that's what device inventory reports for the mgmt MAC). Once the
   * real infrastructure asset exists, the serial match above resolves it
   * FIRST every cycle, so the MAC / hostname adoption fallbacks never run
   * against the ghost and it survives forever (the lease pathway keeps
   * freshening it, and the duplicate-hostname job can't group it — the two
   * rows have different hostnames).
   *
   * Candidates are the strong-identity lookups only (the device's base MAC,
   * an asset hostnamed exactly the device serial) — never bare IP, which
   * recycles. Each candidate is validated against its AssetSource rows
   * (fortigate-endpoint provenance, nothing authoritative) before the merge,
   * so a hand-created asset or a real discovered device can never be
   * absorbed. Best-effort: a sweep failure never fails the device sync.
   */
  async function sweepEndpointGhostsInto(
    canonical: any,
    candidates: Array<any | undefined>,
    deviceLabel: string,
  ): Promise<void> {
    const seen = new Set<string>();
    for (const ghost of candidates) {
      if (!ghost || ghost.id === canonical.id || seen.has(ghost.id)) continue;
      seen.add(ghost.id);
      try {
        if (!(await isMergeableEndpointGhost(ghost.id))) continue;
        const res = await mergeEndpointGhostIntoAsset(canonical.id, ghost.id);
        assetIdx.remove(ghost);
        if (res.adoptedMac && !canonical.macAddress) canonical.macAddress = res.adoptedMac;
        if (res.transferredMonitored) canonical.monitored = true;
        assetIdx.reindex(canonical);
        syncLog("info", `Merged duplicate endpoint asset ${ghost.hostname || ghost.id} into ${deviceLabel}`);
        logEvent({
          action: "asset.duplicate_merged",
          resourceType: "asset",
          resourceId: canonical.id,
          resourceName: canonical.hostname ?? deviceLabel,
          actor,
          level: "info",
          message: `Discovery merged duplicate endpoint asset ${ghost.hostname || ghost.id} into ${deviceLabel}`,
          details: {
            integrationId,
            integrationName,
            ghostId: ghost.id,
            ghostHostname: ghost.hostname ?? null,
            adoptedMac: res.adoptedMac,
            transferredMonitored: res.transferredMonitored,
          },
        });
      } catch (err: any) {
        syncLog("error", `Failed to merge duplicate endpoint asset ${ghost.hostname || ghost.id} into ${deviceLabel}: ${err?.message || "Unknown error"}`);
      }
    }
  }

  for (const sw of result.fortiSwitches || []) {
    const swStatus = sw.state === "Unauthorized" ? "storage" : "active";
    const swJoinDate = sw.joinTime && Number.isFinite(sw.joinTime) && sw.joinTime > 0
      ? new Date(sw.joinTime * 1000) : null;
    const swNotes = `Auto-discovered from FortiGate ${sw.device}${sw.fgtInterface ? ` via ${sw.fgtInterface}` : ""} via ${integrationLabel}`;
    // Management MAC cross-joined from the detected-device fortilink-peer
    // rows at discovery time. Used for the orphan-endpoint dedup lookup
    // below and to seed Asset.macAddress / macAddressRows on create.
    const normalizedSwMac = sw.baseMac ? sw.baseMac.toUpperCase().replace(/-/g, ":") : null;
    try {
      let existingAsset: any = sw.serial ? assetIdx.findBySerial(sw.serial) : null;
      // MAC fallback before name/IP fallback — adopts an orphan
      // "fortigate-endpoint" asset that was created by the DHCP/ARP/MAC-table
      // pathway at this switch's mgmt IP before FortiSwitch discovery linked
      // it up. The inline retype-and-sweep block below converts the
      // adopted asset to assetType="switch" and removes the stale
      // fortigate-endpoint source row.
      if (!existingAsset && normalizedSwMac) existingAsset = assetIdx.findByMac(normalizedSwMac);
      if (!existingAsset && sw.name) existingAsset = assetIdx.findByEntry(undefined, sw.name, sw.ipAddress || undefined);
      // Serial-mismatch guard — same rule as the FortiAP loop: a fallback
      // (MAC/name/IP) match must never bind to an asset carrying a
      // DIFFERENT non-empty serial (RMA'd replacement hardware inheriting
      // the old unit's address). Serial-less orphan adoption still binds.
      if (existingAsset && sw.serial && existingAsset.serialNumber
          && String(existingAsset.serialNumber).toUpperCase() !== sw.serial.toUpperCase()) {
        existingAsset = null;
      }

      const swTopology = {
        role: "fortiswitch" as const,
        controllerFortigate: sw.device || null,
        // Definitive controller identity — see resolveInfraParentAsset in
        // utils/fortinetParentKey.ts. `controllerFortigate` is FMG's device
        // NAME, which routinely differs from the gate's configured hostname
        // (and therefore from Asset.hostname); the serial does not.
        controllerSerial: sw.deviceSerial || null,
        uplinkInterface: sw.fgtInterface || null,
        // Controller admission state ("Authorized" | "Unauthorized"). Also
        // drives the create-path status→storage flip below; surfaced as the
        // Authorization row on the asset details General tab.
        state: sw.state || null,
        // Physical uplink port to the controller FortiGate (e.g. "port47"),
        // from the managed-switch CMDB. Distinct from uplinkInterface (the
        // FortiGate-side logical "fortilink"). Lets the Device Map label the
        // FG↔switch edge's switch side with the real port. Null for chained /
        // dual-homed switches (left to LLDP). See findFortiswitchUplinkPorts.
        uplinkPhysicalPort: sw.uplinkPhysicalPort ?? null,
        // Raw admin description from the managed-switch CMDB (a:/b:/f:/r:/jb:
        // location codes for the Device Map). Notes are operator-only.
        ...buildDeviceDescriptionStamp(sw.description),
      };
      if (existingAsset) {
        // Snapshot before the branch retypes assetType / mutates status below.
        const swBefore = snapshotMaterialAssetFields(existingAsset);
        const acquiredAtUpdate = swJoinDate && (!existingAsset.acquiredAt || swJoinDate < new Date(existingAsset.acquiredAt))
          ? swJoinDate : undefined;
        // Re-discovery resurrects a previously-decommissioned asset back to
        // its current FortiOS-reported state (active or storage). Mirrors
        // the FortiAP path right below.
        const reactivate = existingAsset.status === "decommissioned";

        // Phase 3b.1 cutover: projection-driven discovery fields.
        if (sw.serial) {
          try {
            const syncedAt = new Date(now);
            const observed = buildFortiswitchObservedBlob(sw, syncedAt);
            await upsertFortinetInfraAssetSource("fortiswitch", existingAsset.id, integrationId, sw.serial, observed, syncedAt, syncedAt, integrationName, infraPriorObserved(existingAsset.id, "fortiswitch", sw.serial));
            applyInfraSourceInMemory(existingAsset.id, "fortiswitch", sw.serial, observed, syncedAt, syncedAt);
          } catch (err: any) {
            syncLog("error", `Failed to upsert fortiswitch AssetSource for ${sw.name}: ${err?.message || "Unknown error"}`);
          }
        }
        const { projected: swProjected } = projectAssetFromSources(infraSourcesOf(existingAsset.id));

        const updateData: Record<string, unknown> = {
          // Resurrection of a decommissioned switch requires it to be
          // connected right now; ordinary active↔storage state sync is
          // unaffected. A maintenance-window asset is scheduler-owned —
          // never write status over it (the maintenanceScheduler restores
          // the right state when the window ends).
          ...(existingAsset.status !== "maintenance" &&
          (existingAsset.status !== "decommissioned" || sw.connected)
            ? {
                status: swStatus,
                ...(swStatus !== existingAsset.status ? { statusChangedAt: new Date(now), statusChangedBy: integrationLabel } : {}),
              }
            : {}),
          fortinetTopology: swTopology,
          ...(acquiredAtUpdate ? { acquiredAt: acquiredAtUpdate } : {}),
          ...buildClassMonitorStamp(switchMonitorCfg, existingAsset),
          // Attribution is unconditional for managed infrastructure — the
          // Monitoring tab's "Inherit from <integration>" option, the
          // monitor-settings tier-3 resolution, and the Phase 2b
          // decommission sweep all key off this column, so it must not
          // depend on the class-monitor toggle (buildClassMonitorStamp only
          // stamps it when that's enabled). Mirrors the FortiGate paths.
          ...(existingAsset.discoveredByIntegrationId !== integrationId
            ? { discoveredByIntegrationId: integrationId }
            : {}),
        };
        // Presence gate: the managed-switch table includes FortiLink-
        // configured switches that are currently offline (status !=
        // "Connected"). Only a connected switch is evidence it's on the wire.
        if (sw.connected) bumpLastSeen(updateData, existingAsset, new Date(now), "discovery");
        // Correct assetType when an existing asset was created via a different
        // pathway (device-inventory, DHCP) before FortiSwitch discovery linked
        // up. Without this, the asset stays "other" forever and the endpoint
        // pathway keeps stamping a stale fortigate-endpoint source on it.
        if (existingAsset.assetType !== "switch") {
          updateData.assetType = "switch";
          // Sweep the stale fortigate-endpoint source — it was a placeholder
          // created when this asset was misclassified. The fortiswitch source
          // upserted just above is now the canonical record.
          try {
            await prisma.assetSource.deleteMany({
              where: { assetId: existingAsset.id, sourceKind: "fortigate-endpoint" },
            });
          } catch { /* best-effort */ }
          existingAsset.assetType = "switch";
        }
        if (swProjected.hostname !== null) updateData.hostname = swProjected.hostname;
        if (swProjected.osVersion !== null) updateData.osVersion = swProjected.osVersion;
        if (swProjected.manufacturer !== null) updateData.manufacturer = swProjected.manufacturer;
        if (swProjected.serialNumber !== null) updateData.serialNumber = swProjected.serialNumber;
        if (swProjected.learnedLocation !== null) updateData.learnedLocation = swProjected.learnedLocation;
        if (swProjected.ipAddress !== null) {
          updateData.ipAddress = swProjected.ipAddress;
          updateData.ipSource = sw.device || integrationType;
        }
        // Backfill macAddress + AssetMacAddress when we know the switch's
        // management MAC from this discovery and the existing asset doesn't
        // carry it yet. Mirrors the merge pattern Phase 7 uses for endpoints
        // (lines 4626-4648 + 4660-4662) so the next discovery cycle's
        // MAC-keyed dedup finds this switch. Idempotent — when the MAC is
        // already in macList, only its lastSeen + source are bumped.
        let swMacListForReconcile: MacJsonEntry[] | null = null;
        if (normalizedSwMac) {
          const macList: MacJsonEntry[] = Array.isArray(existingAsset.macAddresses) ? [...(existingAsset.macAddresses as any)] : [];
          const existingMacEntry = macList.find((m) => m.mac === normalizedSwMac);
          if (existingMacEntry) {
            existingMacEntry.lastSeen = now;
            existingMacEntry.source = "fmg-discovery";
            if (sw.device) existingMacEntry.device = sw.device;
          } else {
            macList.push({ mac: normalizedSwMac, lastSeen: now, source: "fmg-discovery", ...(sw.device ? { device: sw.device } : {}) });
          }
          macList.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
          if (!existingAsset.macAddress) updateData.macAddress = macList[0].mac;
          existingAsset.macAddresses = macList;
          swMacListForReconcile = macList;
        }
        clampAcquiredToLastSeen(updateData, existingAsset);
        await prisma.asset.update({ where: { id: existingAsset.id }, data: updateData });
        logDiscoveryAssetUpdated(swBefore, updateData, existingAsset.id, sw.name || sw.serial, {
          integrationName, integrationId, sourceKind: "fortiswitch", actor,
        });
        if (swMacListForReconcile) {
          await reconcileMacAddresses(existingAsset.id, swMacListForReconcile);
        }
        if (sw.ipAddress) existingAsset.ipAddress = sw.ipAddress;
        if (reactivate && sw.connected) existingAsset.status = swStatus;
        if (existingAsset.discoveredByIntegrationId !== integrationId) existingAsset.discoveredByIntegrationId = integrationId;
        assetIdx.reindex(existingAsset);
        await sweepEndpointGhostsInto(existingAsset, [
          normalizedSwMac ? assetIdx.findByMac(normalizedSwMac) : undefined,
          sw.serial ? assetIdx.findByEntry(undefined, sw.serial) : undefined,
        ], sw.name || sw.serial);
        assetNames.push(`${sw.name} (updated${reactivate ? " — reactivated" : ""})`);
      } else {
        // Phase 3b.1 cutover: project from a synthetic single-source array.
        const swSyncedAt = new Date(now);
        const swObserved = buildFortiswitchObservedBlob(sw, swSyncedAt);
        const { projected: swCreateProjected } = projectAssetFromSources([
          { sourceKind: "fortiswitch", inferred: false, observed: swObserved },
        ]);
        const createData: Record<string, unknown> = {
          ipAddress: swCreateProjected.ipAddress,
          ...(swCreateProjected.ipAddress ? { ipSource: sw.device || integrationType } : {}),
          // Management MAC from the detected-device fortilink-peer cross-join.
          // Seeded here so the next discovery cycle's MAC-keyed dedup
          // (Phase 7 device-inventory, Phase 7.5 MAC-table enrichment, and
          // the new MAC-fallback lookup above) recognizes this switch and
          // doesn't spawn a phantom fortigate-endpoint asset alongside it.
          macAddress: normalizedSwMac,
          ...(normalizedSwMac
            ? { macAddressRows: { create: buildMacRowsForCreate([{ mac: normalizedSwMac, lastSeen: now, source: "fmg-discovery" }]) } }
            : {}),
          hostname: swCreateProjected.hostname,
          serialNumber: swCreateProjected.serialNumber,
          manufacturer: swCreateProjected.manufacturer || "Fortinet",
          // FortiSwitch's observed.model is always literally "FortiSwitch"
          // and the projection skips it as too generic. Keep the legacy
          // literal here so the create row gets a non-null model.
          model: "FortiSwitch",
          assetType: "switch",
          // Unconditional attribution — see the update-path comment above.
          discoveredByIntegrationId: integrationId,
          status: swStatus,
          statusChangedAt: new Date(now),
          statusChangedBy: integrationLabel,
          osVersion: swCreateProjected.osVersion,
          ...buildClassMonitorStamp(switchMonitorCfg),
          learnedLocation: swCreateProjected.learnedLocation,
          acquiredAt: swJoinDate,
          ...(sw.connected ? { lastSeen: new Date(now), lastSeenSource: "discovery" } : {}),
          fortinetTopology: swTopology,
          // Notes are operator-only — seed the auto-discovered boilerplate at
          // creation; discovery never writes notes again after this.
          notes: swNotes,
          tags: ["fortiswitch", "auto-discovered"],
        };
        clampAcquiredToLastSeen(createData);
        const newAsset = await prisma.asset.create({ data: createData as any });
        if (sw.serial) {
          try {
            await upsertFortinetInfraAssetSource("fortiswitch", newAsset.id, integrationId, sw.serial, swObserved, swSyncedAt, swSyncedAt, integrationName);
            applyInfraSourceInMemory(newAsset.id, "fortiswitch", sw.serial, swObserved, swSyncedAt, swSyncedAt);
          } catch (err: any) {
            syncLog("error", `Created FortiSwitch asset ${sw.name} but failed to upsert AssetSource row: ${err?.message || "Unknown error"}`);
          }
        }
        logDiscoveryAssetCreated(newAsset.id, sw.name || sw.serial, {
          integrationName, integrationId, sourceKind: "fortiswitch", actor,
        });
        assetIdx.add(newAsset);
        await sweepEndpointGhostsInto(newAsset, [
          normalizedSwMac ? assetIdx.findByMac(normalizedSwMac) : undefined,
          sw.serial ? assetIdx.findByEntry(undefined, sw.serial) : undefined,
        ], sw.name || sw.serial);
        assetNames.push(sw.name || sw.serial);
      }
    } catch (err: any) {
      syncLog("error", `Failed to create/update asset for FortiSwitch ${sw.name}: ${err.message || "Unknown error"}`);
    }

    if (sw.ipAddress) {
      const matchingSubnet = findSubnetForIp(sw.ipAddress);
      if (matchingSubnet) {
        const key = reservationKey(matchingSubnet.id, sw.ipAddress);
        const existingRes = activeResMap.get(key);
        if (existingRes) {
          // A manual row at this switch's own address is only a conflict when it
          // belongs to something ELSE. Once an operator reserves a managed
          // switch's lease-backed IP (which is the point of making those rows
          // takeover-able), this is exactly what the next cycle finds — so
          // without the identity check the first effect of that feature would be
          // a conflict card per reserved switch, re-raised as the 30-day
          // upsertConflict guard aged out.
          if (
            existingRes.sourceType === "manual" &&
            !reservationBelongsToInfraDevice(existingRes, { mac: normalizedSwMac, name: sw.name })
          ) {
            await upsertConflict(existingRes.id, integrationId, { hostname: sw.name || null, owner: "network-team", projectRef: projectRefLabel, notes: swNotes, sourceType: "fortiswitch" }, existingRes);
          }
        } else {
          try {
            await releaseDnsResolvedAt(matchingSubnet.id, sw.ipAddress);
            const newRes = await prisma.reservation.create({
              data: {
                subnetId: matchingSubnet.id,
                ipAddress: sw.ipAddress,
                hostname: sw.name || null,
                owner: "network-team",
                projectRef: projectRefLabel,
                notes: swNotes,
                status: "active",
                sourceType: "fortiswitch",
              },
            });
            activeResMap.set(key, newRes);
            reservationNames.push(`${sw.ipAddress} (${sw.name})`);
          } catch (err: any) {
            syncLog("error", `Failed to create reservation for FortiSwitch ${sw.name} at ${sw.ipAddress}: ${err.message || "Unknown error"}`);
          }
        }
      }
    }
  }

  // Build hostname → {ip, mac} from DHCP data so APs that get management IPs
  // via DHCP can be matched even when the managed_ap API returns no IP/MAC.
  const dhcpByHostname = new Map<string, { ip: string; mac: string }>();
  for (const e of result.dhcpEntries || []) {
    if (e.hostname && e.ipAddress) {
      const key = e.hostname.toLowerCase();
      if (!dhcpByHostname.has(key)) dhcpByHostname.set(key, { ip: e.ipAddress, mac: e.macAddress || "" });
    }
  }

  // The AP LLDP persist below resolves matchedAssetId through the module-
  // level match index in monitoringService, which caches for 60s. The
  // FortiSwitch loop above may have just created the very switches these
  // neighbors point at — drop the cache once so the first persist rebuilds
  // against this run's fresh asset set instead of ghosting brand-new switches
  // until the next cycle.
  if ((result.fortiAps || []).some((ap) => Array.isArray(ap.lldpNeighbors) && ap.lldpNeighbors.length > 0)) {
    invalidateLldpMatchCache();
  }
  for (const ap of result.fortiAps || []) {
    const dhcpFallback = dhcpByHostname.get(ap.name.toLowerCase()) ?? dhcpByHostname.get(ap.serial.toLowerCase()) ?? null;
    const resolvedIp = ap.ipAddress || dhcpFallback?.ip || null;
    const rawMac = ap.baseMac || dhcpFallback?.mac || "";
    const normalizedMac = rawMac ? rawMac.toUpperCase().replace(/-/g, ":") : null;
    try {
      let existingAsset: any = ap.serial ? assetIdx.findBySerial(ap.serial) : null;
      if (!existingAsset && normalizedMac) existingAsset = assetIdx.findByMac(normalizedMac);
      if (!existingAsset && ap.name) existingAsset = assetIdx.findByEntry(undefined, ap.name, resolvedIp || undefined);
      // Serial-mismatch guard on the fallback matches: serial is chassis
      // identity, so a MAC/name/IP match must never bind this row to an
      // asset that carries a DIFFERENT non-empty serial. Without it, an
      // RMA'd replacement AP inheriting the old unit's IP re-binds to the
      // old asset every cycle — resurrecting it out of decommissioned,
      // stamping the new unit's MAC onto it, and never getting an asset of
      // its own, while Phase 2b re-decommissions the old serial each
      // finalize (observed as a flap loop between an RMA'd AP's old and new
      // serial at one site, one decommission Event every run).
      // Serial-less matches (orphan fortigate-endpoint adoption) still bind.
      if (existingAsset && ap.serial && existingAsset.serialNumber
          && String(existingAsset.serialNumber).toUpperCase() !== ap.serial.toUpperCase()) {
        existingAsset = null;
      }

      const apTopology = {
        role: "fortiap" as const,
        controllerFortigate: ap.device || null,
        // Definitive controller identity — see the fortiswitch stamp above.
        controllerSerial: ap.deviceSerial || null,
        parentSwitch: ap.peerSwitch || null,
        parentPort: ap.peerPort || null,
        parentVlan: ap.peerVlan ?? null,
        // Controller admission state ("authorized" / "discovered" / ...) from
        // managed_ap's `state` field — distinct from `status` (connectivity).
        // Surfaced as the Authorization row on the asset details General tab.
        state: ap.authorizationState || null,
        // AP profile (`wtp_profile`) — the FortiOS object that decides this
        // AP's radios, SSIDs and power. Surfaced as the AP Profile row on the
        // asset details General tab.
        profile: ap.profile || null,
        // AP-local uplink port (lan1, lan2, wbh0 …) — preferred from
        // wan_status.interface, falls back to LLDP local_port. Mirrors
        // the FortiSwitch fortinetTopology.uplinkInterface convention.
        uplinkInterface: ap.apUplinkInterface ?? null,
        // peerSource records HOW the (parentSwitch, parentPort) pair was
        // resolved — "lldp" (the AP's own LLDP table; authoritative) or
        // "detected-device" (FortiSwitch MAC table fallback). Topology
        // graph can use this to flag uncertain edges if needed.
        peerSource: ap.peerSource ?? null,
        // Mesh role + parent. parentApSerial points at the parent AP's
        // serialNumber when this AP is a wireless-mesh leaf; the topology
        // graph renders a mesh edge from this AP to the parent instead of
        // (or in addition to) the wired uplink.
        meshUplink: ap.meshUplink ?? null,
        parentApSerial: ap.parentApSerial ?? null,
        // Raw admin description from the wtp CMDB `location` (comment
        // fallback) — a:/b:/f:/r:/jb: location codes for the Device Map.
        // Notes are operator-only.
        ...buildDeviceDescriptionStamp(ap.description),
      };
      // Presence gate: the managed-AP table includes configured-but-offline
      // WTPs. FortiOS reports "online" on most releases and "connected" on
      // some (same variance the controller-status probe accepts) — the
      // previous /^connected$/-only check evaluated every healthy AP on an
      // "online"-reporting fleet as offline, gating off lastSeen bumps,
      // decommission resurrection, and the LLDP persist below.
      const apOnline = isFortiapStatusOnline(ap.status);
      let apAssetId: string | null = null;
      if (existingAsset) {
        // Snapshot before the branch retypes assetType / mutates status below.
        const apBefore = snapshotMaterialAssetFields(existingAsset);
        // Phase 3b.1 cutover: projection-driven discovery fields.
        if (ap.serial) {
          try {
            const syncedAt = new Date(now);
            const observed = buildFortiapObservedBlob(ap, syncedAt);
            await upsertFortinetInfraAssetSource("fortiap", existingAsset.id, integrationId, ap.serial, observed, syncedAt, syncedAt, integrationName, infraPriorObserved(existingAsset.id, "fortiap", ap.serial));
            applyInfraSourceInMemory(existingAsset.id, "fortiap", ap.serial, observed, syncedAt, syncedAt);
          } catch (err: any) {
            syncLog("error", `Failed to upsert fortiap AssetSource for ${ap.name}: ${err?.message || "Unknown error"}`);
          }
        }
        const { projected: apProjected } = projectAssetFromSources(infraSourcesOf(existingAsset.id));

        const updateData: Record<string, unknown> = {
          fortinetTopology: apTopology,
          // Resurrection, like the lastSeen bump below, requires the AP to
          // be connected — an offline WTP entry must not undo a decommission.
          ...(existingAsset.status === "decommissioned" && apOnline ? { status: "active", statusChangedAt: new Date(now), statusChangedBy: integrationLabel } : {}),
          ...buildClassMonitorStamp(apMonitorCfg, existingAsset),
          // Unconditional attribution — see the FortiSwitch update-path comment.
          ...(existingAsset.discoveredByIntegrationId !== integrationId
            ? { discoveredByIntegrationId: integrationId }
            : {}),
        };
        if (apOnline) bumpLastSeen(updateData, existingAsset, new Date(now), "discovery");
        // Mirror the resolved wired-uplink switch/port (from LLDP first, then
        // the detected-device MAC table fallback) into `lastSeenSwitch` so the
        // asset details panel shows where the AP is plugged in. Same
        // "<switchId>/<portName>" format Phase 7.5 uses for endpoints. Phase
        // 7.5 itself rarely fires on APs because switches usually see the
        // AP's wired NIC MAC, not its baseMac which is what's indexed.
        if (ap.peerSwitch && ap.peerPort) {
          noteChangeBaseline(existingAsset, ["lastSeenSwitch"]);
          updateData.lastSeenSwitch = `${ap.peerSwitch}/${ap.peerPort}`;
        }
        // Same correction as the FortiSwitch path — fix assetType if a prior
        // pathway created this asset as "other" before FortiAP discovery linked
        // up, and sweep the stale fortigate-endpoint source row.
        if (existingAsset.assetType !== "access_point") {
          updateData.assetType = "access_point";
          try {
            await prisma.assetSource.deleteMany({
              where: { assetId: existingAsset.id, sourceKind: "fortigate-endpoint" },
            });
          } catch { /* best-effort */ }
          existingAsset.assetType = "access_point";
        }
        if (apProjected.hostname !== null) updateData.hostname = apProjected.hostname;
        if (apProjected.model !== null) updateData.model = apProjected.model;
        if (apProjected.osVersion !== null) updateData.osVersion = apProjected.osVersion;
        if (apProjected.manufacturer !== null) updateData.manufacturer = apProjected.manufacturer;
        if (apProjected.serialNumber !== null) updateData.serialNumber = apProjected.serialNumber;
        if (apProjected.learnedLocation !== null) updateData.learnedLocation = apProjected.learnedLocation;
        if (apProjected.ipAddress !== null) {
          updateData.ipAddress = apProjected.ipAddress;
          updateData.ipSource = ap.device || integrationType;
        }
        clampAcquiredToLastSeen(updateData, existingAsset);
        await prisma.asset.update({ where: { id: existingAsset.id }, data: updateData });
        logDiscoveryAssetUpdated(apBefore, updateData, existingAsset.id, ap.name || ap.serial, {
          integrationName, integrationId, sourceKind: "fortiap", actor,
        });
        if (resolvedIp) existingAsset.ipAddress = resolvedIp;
        // Mirror the wired-uplink stamp in memory: later phases (and the
        // end-of-run change-event flush) compare against this row, and without
        // it the flush would read the pre-update value and re-report the same
        // move every run.
        if (updateData.lastSeenSwitch) existingAsset.lastSeenSwitch = updateData.lastSeenSwitch;
        if (existingAsset.status === "decommissioned" && apOnline) existingAsset.status = "active";
        if (existingAsset.discoveredByIntegrationId !== integrationId) existingAsset.discoveredByIntegrationId = integrationId;
        assetIdx.reindex(existingAsset);
        await sweepEndpointGhostsInto(existingAsset, [
          normalizedMac ? assetIdx.findByMac(normalizedMac) : undefined,
          ap.serial ? assetIdx.findByEntry(undefined, ap.serial) : undefined,
        ], ap.name || ap.serial);
        assetNames.push(`${ap.name} (updated)`);
        apAssetId = existingAsset.id;
      } else {
        // Phase 3b.1 cutover: project from a synthetic single-source array.
        const apSyncedAt = new Date(now);
        const apObserved = buildFortiapObservedBlob(ap, apSyncedAt);
        const { projected: apCreateProjected } = projectAssetFromSources([
          { sourceKind: "fortiap", inferred: false, observed: apObserved },
        ]);
        const newAsset = await prisma.asset.create({
          data: {
            ipAddress: apCreateProjected.ipAddress,
            ...(apCreateProjected.ipAddress ? { ipSource: ap.device || integrationType } : {}),
            macAddress: normalizedMac,
            ...(normalizedMac
              ? { macAddressRows: { create: buildMacRowsForCreate([{ mac: normalizedMac, lastSeen: now, source: "fmg-discovery" }]) } }
              : {}),
            hostname: apCreateProjected.hostname,
            serialNumber: apCreateProjected.serialNumber,
            manufacturer: apCreateProjected.manufacturer || "Fortinet",
            model: apCreateProjected.model || "FortiAP",
            assetType: "access_point",
            // Unconditional attribution — see the FortiSwitch update-path comment.
            discoveredByIntegrationId: integrationId,
            status: "active",
            statusChangedAt: new Date(now),
            statusChangedBy: integrationLabel,
            osVersion: apCreateProjected.osVersion,
            learnedLocation: apCreateProjected.learnedLocation,
            ...(apOnline ? { lastSeen: new Date(now), lastSeenSource: "discovery" } : {}),
            fortinetTopology: apTopology,
            ...(ap.peerSwitch && ap.peerPort ? { lastSeenSwitch: `${ap.peerSwitch}/${ap.peerPort}` } : {}),
            ...buildClassMonitorStamp(apMonitorCfg),
            // Notes are operator-only — boilerplate at creation, never
            // written by discovery again.
            notes: `Auto-discovered from FortiGate ${ap.device} via ${integrationLabel}`,
            tags: ["fortiap", "auto-discovered"],
          },
        });
        if (ap.serial) {
          try {
            await upsertFortinetInfraAssetSource("fortiap", newAsset.id, integrationId, ap.serial, apObserved, apSyncedAt, apSyncedAt, integrationName);
            applyInfraSourceInMemory(newAsset.id, "fortiap", ap.serial, apObserved, apSyncedAt, apSyncedAt);
          } catch (err: any) {
            syncLog("error", `Created FortiAP asset ${ap.name} but failed to upsert AssetSource row: ${err?.message || "Unknown error"}`);
          }
        }
        logDiscoveryAssetCreated(newAsset.id, ap.name || ap.serial, {
          integrationName, integrationId, sourceKind: "fortiap", actor,
        });
        assetIdx.add(newAsset);
        await sweepEndpointGhostsInto(newAsset, [
          normalizedMac ? assetIdx.findByMac(normalizedMac) : undefined,
          ap.serial ? assetIdx.findByEntry(undefined, ap.serial) : undefined,
        ], ap.name || ap.serial);
        assetNames.push(ap.name || ap.serial);
        apAssetId = newAsset.id;
      }

      // Persist the AP's full LLDP table (managed_ap `lldp` array) as real
      // AssetLldpNeighbor rows so the asset-details LLDP section and Device
      // Map show the AP's exact neighbors instead of peer-inferred ones.
      // Gated on apOnline (offline WTP entries carry stale tables) and on
      // the field being present (absent = firmware didn't return `lldp` —
      // must not wipe existing rows). Best-effort: an LLDP persist failure
      // must not fail the asset sync itself.
      if (apAssetId && apOnline && Array.isArray(ap.lldpNeighbors)) {
        try {
          await persistManagedApLldpNeighbors(apAssetId, ap.lldpNeighbors, new Date(now));
        } catch (err: any) {
          syncLog("error", `Failed to persist LLDP neighbors for FortiAP ${ap.name}: ${err?.message || "Unknown error"}`);
        }
      }
      // Radio + broadcast-SSID inventory off the same managed_ap row. This is
      // the REST half of the Stations tab's radio → SSID → station tree, and
      // it is written from DISCOVERY rather than the monitor pass on purpose:
      // system-info only runs for an AP whose interfaces stream is on SNMP,
      // so hanging the tree off that path would leave it empty on exactly the
      // APs that have SNMP disabled — which is most of them. Same two gates
      // as the LLDP persist above: online (an offline WTP's row is stale) and
      // field-present (absent = firmware said nothing, must not wipe).
      if (apAssetId && apOnline && Array.isArray(ap.radios)) {
        try {
          await persistApRadioInventory(apAssetId, ap.radios, "fortios", new Date(now));
        } catch (err: any) {
          syncLog("error", `Failed to persist radios for FortiAP ${ap.name}: ${err?.message || "Unknown error"}`);
        }
      }
    } catch (err: any) {
      syncLog("error", `Failed to create/update asset for FortiAP ${ap.name}: ${err.message || "Unknown error"}`);
    }

    if (resolvedIp) {
      const matchingSubnet = findSubnetForIp(resolvedIp);
      if (matchingSubnet) {
        const key = reservationKey(matchingSubnet.id, resolvedIp);
        const existingRes = activeResMap.get(key);
        if (existingRes) {
          // Same identity check as the FortiSwitch path above — an operator's
          // reservation for THIS AP is not a conflict with this AP.
          if (
            existingRes.sourceType === "manual" &&
            !reservationBelongsToInfraDevice(existingRes, { mac: normalizedMac, name: ap.name })
          ) {
            await upsertConflict(existingRes.id, integrationId, { hostname: ap.name || null, owner: "network-team", projectRef: projectRefLabel, notes: `FortiAP managed by FortiGate ${ap.device}`, sourceType: "fortinap" }, existingRes);
          }
        } else {
          try {
            await releaseDnsResolvedAt(matchingSubnet.id, resolvedIp);
            const newRes = await prisma.reservation.create({
              data: {
                subnetId: matchingSubnet.id,
                ipAddress: resolvedIp,
                hostname: ap.name || null,
                owner: "network-team",
                projectRef: projectRefLabel,
                notes: `FortiAP managed by FortiGate ${ap.device}`,
                status: "active",
                sourceType: "fortinap",
              },
            });
            activeResMap.set(key, newRes);
            reservationNames.push(`${resolvedIp} (${ap.name})`);
          } catch (err: any) {
            syncLog("error", `Failed to create reservation for FortiAP ${ap.name} at ${resolvedIp}: ${err.message || "Unknown error"}`);
          }
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 3c — Sync firewall VIP reservations
  phaseMark("3c");
  // ══════════════════════════════════════════════════════════════════════════════

  // Built unconditionally so Phase 5 (in-place VIP→DHCP conversion) and Phase
  // 5b (stale VIP/DHCP-reservation sweep) have the data even when this cycle
  // returned zero VIPs from every gate. `vipQueriedDevices` is the set of
  // FortiGate names whose `firewall/vip` query succeeded this run — only
  // VIPs whose `vipInfo.device` is in this set are sweep-eligible, so a
  // transient query failure won't wipe operator-edited rows.
  const currentVipKeys = new Set<string>();
  const vipQueriedDevices = new Set<string>(result.vipInventoriedDevices ?? []);
  if (result.vips) {
    for (const vip of result.vips) {
      const matchExt = findSubnetForIp(vip.extip);
      if (matchExt) currentVipKeys.add(reservationKey(matchExt.id, vip.extip));
      for (const ip of [...vip.mappedips, ...vip.realservers]) {
        const matchMap = findSubnetForIp(ip);
        if (matchMap) currentVipKeys.add(reservationKey(matchMap.id, ip));
      }
    }
  }

  if (result.vips && result.vips.length > 0) {
    for (const vip of result.vips) {
      const ipsToReserve: Array<{ ip: string; role: "external" | "mapped" | "realserver" }> = [
        { ip: vip.extip, role: "external" },
        ...vip.mappedips.map((ip) => ({ ip, role: "mapped" as const })),
        ...vip.realservers.map((ip) => ({ ip, role: "realserver" as const })),
      ];
      // Load-balance Virtual Servers get their own canonical owner / notes /
      // projectRef so operators can tell a VS (and its realserver pool
      // members) apart from a plain DNAT VIP at a glance. Phase 5's
      // VIP-succession path treats both spellings as canonical placeholders.
      const kindLabel = vip.isVirtualServer ? "Virtual server" : "Firewall VIP";

      for (const { ip, role } of ipsToReserve) {
        const matchingSubnet = findSubnetForIp(ip);
        if (!matchingSubnet) continue;

        const key = reservationKey(matchingSubnet.id, ip);
        const proposedHostname = vip.name;
        const proposedOwner = vip.isVirtualServer ? "fortimanager-vs" : "fortimanager-vip";
        const proposedProjectRef = `${vip.isVirtualServer ? "VS" : "VIP"}: ${vip.device}`;
        const proposedNotes = `${kindLabel} "${vip.name}" (${role}) on ${vip.device} — ext: ${vip.extip}`;

        const existingRes = activeResMap.get(key);
        if (existingRes) {
          if (existingRes.sourceType === "manual") {
            await upsertConflict(existingRes.id, integrationId, { hostname: proposedHostname, owner: proposedOwner, projectRef: proposedProjectRef, notes: proposedNotes, sourceType: "vip" }, existingRes);
          } else if (existingRes.sourceType === "vip") {
            // VIP rename (or first vipInfo snapshot) — refresh canonical VIP
            // metadata only. hostname / owner / notes / projectRef are
            // operator-editable via the Reserve modal, so discovery must not
            // overwrite them; the VIP's current name stays visible via the
            // vip badge tooltip rendered from vipInfo.
            const newVipInfo = { name: vip.name, device: vip.device, extip: vip.extip, role, isVirtualServer: vip.isVirtualServer };
            const cur = existingRes.vipInfo as any;
            if (!cur || cur.name !== newVipInfo.name || cur.device !== newVipInfo.device || cur.role !== newVipInfo.role || !!cur.isVirtualServer !== newVipInfo.isVirtualServer) {
              await prisma.reservation.update({
                where: { id: existingRes.id },
                data: { vipInfo: newVipInfo },
              });
              existingRes.vipInfo = newVipInfo;
            }
          } else if (existingRes.sourceType === "dhcp_reservation" || existingRes.sourceType === "dhcp_lease") {
            // VIP + DHCP collision (VIP arriving second): same IP is both a
            // DHCP lease/reservation AND a VIP external on the FortiGate.
            // Update vipInfo so the operator sees the VIP badge immediately.
            //
            // VIP metadata takes precedence over the DHCP side's owner /
            // projectRef, so the canonical DHCP-discovery placeholders are
            // overwritten in place rather than offered as a conflict — the
            // mirror of the Phase 5 VIP-succession path, which overwrites
            // canonical VIP placeholders when the VIP goes away. Anything
            // outside that allowlist is operator-owned (or an asset's
            // assignedTo) and survives untouched. The remaining conflict is
            // fill-only: it raises a card solely for fields this row left
            // blank.
            const newVipInfo = { name: vip.name, device: vip.device, extip: vip.extip, role, isVirtualServer: vip.isVirtualServer };
            const cur = existingRes.vipInfo as any;
            const vipUpdate: Record<string, unknown> = {};
            if (!cur || cur.name !== newVipInfo.name || cur.device !== newVipInfo.device || cur.role !== newVipInfo.role || !!cur.isVirtualServer !== newVipInfo.isVirtualServer) {
              vipUpdate.vipInfo = newVipInfo;
            }
            const isCanonicalDhcpOwner =
              existingRes.owner === "dhcp-lease" || existingRes.owner === "dhcp-reservation";
            if (isCanonicalDhcpOwner && existingRes.owner !== proposedOwner) vipUpdate.owner = proposedOwner;
            if (existingRes.projectRef === projectRefLabel && existingRes.projectRef !== proposedProjectRef) {
              vipUpdate.projectRef = proposedProjectRef;
            }
            if (Object.keys(vipUpdate).length > 0) {
              await prisma.reservation.update({
                where: { id: existingRes.id },
                data: vipUpdate,
              });
              if (vipUpdate.vipInfo) existingRes.vipInfo = newVipInfo;
              if (vipUpdate.owner) existingRes.owner = proposedOwner;
              if (vipUpdate.projectRef) existingRes.projectRef = proposedProjectRef;
            }
            await upsertConflict(
              existingRes.id,
              integrationId,
              { hostname: proposedHostname, owner: proposedOwner, projectRef: proposedProjectRef, notes: proposedNotes, sourceType: "vip" },
              existingRes,
              "fill-only",
            );
          }
          continue;
        }

        try {
          await releaseDnsResolvedAt(matchingSubnet.id, ip);
          // vipInfo stamped at create (not just on the next cycle's refresh
          // branch) so the VIP/VS badge renders and the Phase 5b stale sweep
          // is armed from the row's first cycle.
          const newRes = await prisma.reservation.create({
            data: {
              subnetId: matchingSubnet.id,
              ipAddress: ip,
              hostname: proposedHostname,
              owner: proposedOwner,
              projectRef: proposedProjectRef,
              notes: proposedNotes,
              status: "active",
              sourceType: "vip",
              vipInfo: { name: vip.name, device: vip.device, extip: vip.extip, role, isVirtualServer: vip.isVirtualServer },
            },
          });
          activeResMap.set(key, newRes);
          vipNames.push(`${ip} (${vip.name}/${role})`);
        } catch (err: any) {
          syncLog("error", `Failed to create VIP reservation for ${ip} (${vip.name}): ${err.message || "Unknown error"}`);
        }
      }
    }
    if (vipNames.length > 0) {
      syncLog("info", `VIP sync: created ${vipNames.length} VIP reservation(s)`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 4 — Create reservations for interface IPs (in-memory reservation check)
  phaseMark("4");
  // ══════════════════════════════════════════════════════════════════════════════

  const interfaceRoleLabel = (role: string): string => {
    if (role === "management") return "Management interface";
    if (role === "secondary")  return "Secondary IP";
    return "Interface";
  };

  for (const ifaceIp of result.interfaceIps) {
    if (!ifaceIp.ipAddress) continue;

    const matchingSubnet = findSubnetForIp(ifaceIp.ipAddress);
    if (!matchingSubnet) continue;

    const key = reservationKey(matchingSubnet.id, ifaceIp.ipAddress);
    const noteText = `${interfaceRoleLabel(ifaceIp.role)} (${ifaceIp.interfaceName}) on ${ifaceIp.device}`;
    const existingRes = activeResMap.get(key);
    if (existingRes) {
      if (existingRes.sourceType === "manual") {
        const proposed = { hostname: ifaceIp.device, owner: "network-team", projectRef: projectRefLabel, notes: noteText, sourceType: "interface_ip" };
        await upsertConflict(existingRes.id, integrationId, proposed, existingRes);
      }
      continue;
    }

    try {
      await releaseDnsResolvedAt(matchingSubnet.id, ifaceIp.ipAddress);
      const newRes = await prisma.reservation.create({
        data: {
          subnetId: matchingSubnet.id,
          ipAddress: ifaceIp.ipAddress,
          hostname: ifaceIp.device,
          owner: "network-team",
          projectRef: projectRefLabel,
          notes: noteText,
          status: "active",
          sourceType: "interface_ip",
        },
      });
      activeResMap.set(key, newRes);
      reservationNames.push(`${ifaceIp.ipAddress} (${ifaceIp.device}/${ifaceIp.interfaceName})`);
    } catch (err: any) {
      syncLog("error", `Failed to create reservation for interface IP ${ifaceIp.ipAddress} on ${ifaceIp.device}/${ifaceIp.interfaceName}: ${err.message || "Unknown error"}`);
    }
  }

  // Phase 4b (removed): per-interface IPs/MACs for the FortiGate asset are now
  // populated by the System tab's interface scrape (monitoringService.collectSystemInfo
  // + recordSystemInfoResult) on the configured telemetry cadence. Discovery no
  // longer writes associatedIps here; manual entries survive the monitor pull.

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 5 — Create DHCP lease/reservation entries (in-memory lookups)
  phaseMark("5");
  // ══════════════════════════════════════════════════════════════════════════════

  // Phase 5 instrumentation — counts per-branch path frequency and per-type
  // write fire count so we can size the actual per-cycle DB pressure before
  // deciding whether to bulk-batch the create / update paths. Emitted as a
  // single info-level syncLog at the bottom of the phase; one Event row per
  // per-FortiGate sync. Cheap (just integer increments) and always-on so
  // operators can grep the Events page to characterize their fleet.
  const phase5Stats = {
    entriesTotal: 0,
    skippedNoIp: 0,
    skippedNoSubnet: 0,
    skippedCollision: 0,
    // Path counters (exactly one per processed entry).
    // dhcpFlipMixed = the row needed a sourceType change (and maybe also a
    // staleness bump) — written inline as one per-row update.
    // dhcpFlipBumpOnly = the row only needed lastSeenLeased=now (steady-state
    // confirmation that an existing dhcp_reservation's target is still online)
    // — deferred to one bulk updateMany at end of phase. On big FortiGates with
    // hundreds of leased reservations this is the dominant per-cycle write cost
    // and bulking it collapses N statements into 1 round-trip.
    pathExistingDhcpNoChange: 0,
    pathExistingDhcpFlipMixed: 0,
    pathExistingDhcpFlipBumpOnly: 0,
    pathExistingManualPolarisEcho: 0,
    pathExistingManualConflictOnly: 0,
    pathExistingVipSuccession: 0,
    pathExistingVipMacFill: 0,
    pathExistingPendingAdopt: 0,
    pathExistingPendingCollide: 0,
    // infraBinding* = an existing fortiswitch/fortinap row (Phase 3a/3b created
    // it for a managed switch/AP) that this DHCP entry tells us the binding
    // state of. Before these two existed the source types matched NO branch and
    // fell through with no counter at all, which is why the "path-* counters sum
    // to entriesTotal" property below was quietly false for every managed
    // switch/AP on the gate.
    pathExistingInfraBindingChange: 0,
    pathExistingInfraNoChange: 0,
    pathNewCreate: 0,
    pathNewCreateAfterRetry: 0,
    pathNewCreateFailed: 0,
    // Write counters (statement count, NOT row count).
    // writesReservationUpdateMany is the bulk path — 0 or 1 statement per
    // cycle, covering pathExistingDhcpFlipBumpOnly rows.
    writesReservationUpdate: 0,
    writesReservationUpdateMany: 0,
    writesReservationCreate: 0,
    writesReservationDelete: 0,
    writesConflictUpdateMany: 0,
    writesDnsRelease: 0,
    writesUpsertConflict: 0,
  };
  // Collected ids whose only Phase 5 write is the lastSeenLeased=now bump.
  // Flushed as one updateMany after the loop.
  const dhcpFlipBumpOnlyIds: string[] = [];

  if (result.dhcpEntries && result.dhcpEntries.length > 0) {
    for (const entry of result.dhcpEntries) {
      phase5Stats.entriesTotal++;
      if (!entry.ipAddress) { phase5Stats.skippedNoIp++; continue; }

      const matchingSubnet = findSubnetForIp(entry.ipAddress);
      if (!matchingSubnet) { phase5Stats.skippedNoSubnet++; continue; }

      const key = reservationKey(matchingSubnet.id, entry.ipAddress);
      const isDhcpReservation = entry.type === "dhcp-reservation";

      // Look up matching asset by MAC (in-memory)
      let matchedAsset: any = null;
      if (entry.macAddress) {
        matchedAsset = assetIdx.findByMac(entry.macAddress.toUpperCase().replace(/-/g, ":"));
      }

      const proposedHostname = (matchedAsset && matchedAsset.hostname) || entry.hostname || null;
      const proposedOwner = (matchedAsset && matchedAsset.assignedTo) || (isDhcpReservation ? "dhcp-reservation" : "dhcp-lease");
      const proposedNotes = [
        `${isDhcpReservation ? "DHCP reservation" : "DHCP lease"} on ${entry.device} (${entry.interfaceName})`,
        entry.macAddress ? `MAC: ${entry.macAddress}` : null,
        entry.vci ? `Model: ${entry.vci}` : null,
        entry.ssid ? `SSID: ${entry.ssid}` : null,
        entry.accessPoint ? `AP: ${entry.accessPoint}` : null,
      ].filter(Boolean).join(" — ");
      // Use vci to identify FortiSwitch/FortiAP entries not caught by managed device APIs
      const vciLower = (entry.vci || "").toLowerCase();
      const proposedSourceType = (
        vciLower.startsWith("fortiswitch-") ? "fortiswitch" :
        vciLower.startsWith("fortiap-") ? "fortinap" :
        isDhcpReservation ? "dhcp_reservation" : "dhcp_lease"
      ) as "fortiswitch" | "fortinap" | "dhcp_reservation" | "dhcp_lease";
      const proposedExpiresAt = !isDhcpReservation && entry.expireTime ? new Date(entry.expireTime * 1000) : undefined;

      const existingRes = activeResMap.get(key);
      if (existingRes) {
        // Queued push-row collision handling — runs BEFORE the manual /
        // Polaris-pushed branches because a pending row has sourceType
        // "manual" and a pushedToId stamp (we set both at queue time so the
        // queue view knows the intended target). Without this guard the
        // existing logic would silently flip the pending row to
        // dhcp_reservation as if it were our own echo — but nothing has
        // actually been written to the device yet.
        if (existingRes.sourceType === "manual" && existingRes.pushStatus === "pending") {
          const pendingMac = existingRes.macAddress
            ? existingRes.macAddress.toUpperCase().replace(/-/g, ":")
            : null;
          const freshMac = entry.macAddress
            ? entry.macAddress.toUpperCase().replace(/-/g, ":")
            : null;
          const macsMatch = !!pendingMac && !!freshMac && pendingMac === freshMac;
          if (
            isDhcpReservation &&
            macsMatch &&
            typeof entry.scopeId === "number" &&
            typeof entry.entryId === "number"
          ) {
            // Fast-path adopt — operator added the entry on the device
            // (or a previous retry succeeded but Polaris missed the reply)
            // while we were queued. Promote in place to synced.
            phase5Stats.pathExistingPendingAdopt++;
            await prisma.reservation.update({
              where: { id: existingRes.id },
              data: {
                sourceType: "dhcp_reservation",
                pushedToId: integrationId,
                pushedScopeId: entry.scopeId,
                pushedEntryId: entry.entryId,
                pushStatus: "synced",
                pushedAt: new Date(),
                pushError: null,
                pushQueuedAt: null,
                pushAttempts: 0,
                pushLastAttemptAt: null,
                ...(entry.seenLeased
                  ? { lastSeenLeased: new Date(), staleNotifiedAt: null, staleSnoozedUntil: null }
                  : {}),
              },
            });
            phase5Stats.writesReservationUpdate++;
            await prisma.conflict.updateMany({
              where: { reservationId: existingRes.id, status: "pending" },
              data: { status: "rejected", resolvedBy: "auto", resolvedAt: new Date() },
            });
            phase5Stats.writesConflictUpdateMany++;
            existingRes.sourceType = "dhcp_reservation";
            existingRes.pushStatus = "synced";
            logEvent({
              action: "reservation.push.queued.adopted",
              level: "info",
              resourceType: "reservation",
              resourceId: existingRes.id,
              resourceName: existingRes.hostname || entry.ipAddress,
              actor,
              message: `Queued reservation adopted by discovery — entry already on FortiGate "${entry.device}" (scope ${entry.scopeId}, entry ${entry.entryId})`,
              details: {
                integrationId,
                integrationName,
                deviceName: entry.device,
                scopeId: entry.scopeId,
                entryId: entry.entryId,
                ip: entry.ipAddress,
                mac: pendingMac,
              },
            });
            continue;
          }
          // Hard collision: pending row at this IP, but discovery sees a
          // different MAC or a dhcp_lease. Flip to failed_permanent so the
          // operator can see what won the IP, and skip the discovery create
          // on this IP — the unique-on-active constraint would block it
          // anyway.
          const errMsg = `IP collided during queue — discovered ${proposedSourceType}${freshMac ? ` by ${freshMac}` : ""}`;
          phase5Stats.pathExistingPendingCollide++;
          await prisma.reservation.update({
            where: { id: existingRes.id },
            data: {
              pushStatus: "failed_permanent",
              pushError: errMsg,
              pushLastAttemptAt: new Date(),
            },
          });
          phase5Stats.writesReservationUpdate++;
          existingRes.pushStatus = "failed_permanent";
          logEvent({
            action: "reservation.push.queued.collided",
            level: "warning",
            resourceType: "reservation",
            resourceId: existingRes.id,
            resourceName: existingRes.hostname || entry.ipAddress,
            actor,
            message: `Queued push for ${entry.ipAddress} aborted — ${errMsg}. Release the reservation or pick a different IP.`,
            details: {
              integrationId,
              integrationName,
              deviceName: entry.device,
              ip: entry.ipAddress,
              pendingMac,
              discoveredSourceType: proposedSourceType,
              discoveredMac: freshMac,
            },
          });
          continue;
        }
        if (existingRes.sourceType === "manual") {
          if (existingRes.pushedToId) {
            // Polaris-pushed manual reservation — discovery is just seeing
            // its own echo. Flip sourceType silently so the conflict isn't
            // raised and future discoveries treat this as a normal
            // dhcp_reservation. We do NOT overwrite the user-provided
            // hostname / owner / projectRef / notes — the device-side
            // description is intentionally distinct (Polaris/<user>:
            // <hostname>) and shouldn't become the Polaris-side hostname.
            // Also dismiss any pending conflicts already raised on this
            // row from prior discovery runs that didn't have this guard.
            phase5Stats.pathExistingManualPolarisEcho++;
            await prisma.reservation.update({
              where: { id: existingRes.id },
              data: {
                sourceType: "dhcp_reservation",
                ...(entry.seenLeased && isDhcpReservation
                  ? { lastSeenLeased: new Date(), staleNotifiedAt: null, staleSnoozedUntil: null }
                  : {}),
              },
            });
            phase5Stats.writesReservationUpdate++;
            await prisma.conflict.updateMany({
              where: { reservationId: existingRes.id, status: "pending" },
              data: { status: "rejected", resolvedBy: "auto", resolvedAt: new Date() },
            });
            phase5Stats.writesConflictUpdateMany++;
          } else {
            phase5Stats.pathExistingManualConflictOnly++;
            await upsertConflict(existingRes.id, integrationId, { hostname: proposedHostname, owner: proposedOwner, projectRef: projectRefLabel, notes: proposedNotes, sourceType: proposedSourceType }, existingRes);
            phase5Stats.writesUpsertConflict++;
          }
        } else if (existingRes.sourceType === "vip") {
          const vipStillExists = currentVipKeys.has(key);
          const macNormalized = entry.macAddress ? entry.macAddress.toUpperCase().replace(/-/g, ":") : null;

          if (!vipStillExists && vipQueriedDevices.has(((existingRes.vipInfo as any)?.device) || "")) {
            // VIP succession: the FortiGate no longer reports this VIP (we
            // queried successfully, the entry isn't there), and a DHCP
            // lease/reservation has landed at the same IP. Convert the row
            // in place — preserves the reservation id and any operator
            // edits while the sourceType honestly reflects the gate's
            // current state. Operator-typed owner / notes / hostname
            // survive; only the canonical VIP-discovery placeholders are
            // overwritten by the DHCP-discovery equivalents.
            const isCanonicalVipOwner = existingRes.owner === "fortimanager-vip" || existingRes.owner === "fortimanager-vs";
            const isCanonicalVipNotes =
              !existingRes.notes ||
              (typeof existingRes.notes === "string" &&
                (existingRes.notes.startsWith("Firewall VIP ") || existingRes.notes.startsWith("Virtual server ")));
            const updateData: Record<string, unknown> = {
              sourceType: proposedSourceType,
              vipInfo: null,
            };
            if (isCanonicalVipOwner) updateData.owner = proposedOwner;
            if (isCanonicalVipNotes) updateData.notes = proposedNotes;
            if (macNormalized && !existingRes.macAddress) updateData.macAddress = macNormalized;
            if (entry.seenLeased && isDhcpReservation) {
              updateData.lastSeenLeased = new Date();
              updateData.staleNotifiedAt = null;
              updateData.staleSnoozedUntil = null;
            }
            phase5Stats.pathExistingVipSuccession++;
            await prisma.reservation.update({ where: { id: existingRes.id }, data: updateData });
            phase5Stats.writesReservationUpdate++;
            // Auto-reject any pending VIP-merge conflicts on this row —
            // they were raised against the prior VIP state which is now
            // gone. The DHCP source is unambiguous; no operator review
            // needed.
            await prisma.conflict.updateMany({
              where: { reservationId: existingRes.id, status: "pending" },
              data: { status: "rejected", resolvedBy: "auto", resolvedAt: new Date() },
            });
            phase5Stats.writesConflictUpdateMany++;
            const priorVipInfo = existingRes.vipInfo as any;
            existingRes.sourceType = proposedSourceType;
            existingRes.vipInfo = null;
            if (isCanonicalVipOwner) existingRes.owner = proposedOwner;
            if (isCanonicalVipNotes) existingRes.notes = proposedNotes;
            if (macNormalized && !existingRes.macAddress) existingRes.macAddress = macNormalized;
            logEvent({
              action: "reservation.vip.replaced",
              resourceType: "reservation",
              resourceId: existingRes.id,
              resourceName: `${entry.ipAddress}`,
              actor,
              message: `VIP "${priorVipInfo?.name || "(unknown)"}" no longer on ${priorVipInfo?.device || "(unknown)"} — converted to ${proposedSourceType.replace("_", " ")} at ${entry.ipAddress}`,
              details: {
                integrationId,
                integrationName,
                reservationId: existingRes.id,
                ipAddress: entry.ipAddress,
                priorVipInfo,
                newSourceType: proposedSourceType,
                fortigateDevice: entry.device,
              },
            });
            continue;
          }

          // VIP + DHCP collision (DHCP arriving second): the FortiGate has a
          // VIP external IP that also shows up as a DHCP lease/reservation.
          // Silent fill of macAddress (technical observation; no operator
          // decision needed), then a FILL-ONLY merge conflict: the VIP row's
          // own owner / projectRef / hostname are authoritative (VIP is
          // load-bearing firewall config), so the DHCP side's values are never
          // offered for review — only a field the VIP row left blank raises a
          // card. upsertConflict's 30-day guard prevents re-raise once the
          // operator resolves.
          phase5Stats.pathExistingVipMacFill++;
          if (macNormalized && !existingRes.macAddress) {
            await prisma.reservation.update({
              where: { id: existingRes.id },
              data: { macAddress: macNormalized },
            });
            phase5Stats.writesReservationUpdate++;
            existingRes.macAddress = macNormalized;
          }
          await upsertConflict(
            existingRes.id,
            integrationId,
            { hostname: proposedHostname, owner: proposedOwner, projectRef: projectRefLabel, notes: proposedNotes, sourceType: proposedSourceType },
            existingRes,
            "fill-only",
          );
          phase5Stats.writesUpsertConflict++;
        } else if (
          existingRes.sourceType === "dhcp_lease" ||
          existingRes.sourceType === "dhcp_reservation"
        ) {
          // Existing dhcp_* row: keep sourceType honest as the device-side
          // state shifts (e.g. a lease IP gets promoted to a static
          // reservation, or a static reservation is removed and only a
          // lease remains). When sourceType flips, also flip the
          // conventional owner placeholder ("dhcp-lease" ↔
          // "dhcp-reservation") so the UI status pill and owner column
          // stay aligned. Operator-stamped owners (anything outside that
          // allowlist) survive untouched.
          const needsSourceFlip = existingRes.sourceType !== proposedSourceType;
          const needsStalenessBump = entry.seenLeased && isDhcpReservation;
          if (needsSourceFlip) {
            // Mixed update — the new sourceType differs per row, so we can't
            // bulk these (updateMany only supports one common data shape).
            // Issue inline as one per-row update; the staleness bump rides
            // along when both apply.
            const update: Record<string, unknown> = {
              sourceType: proposedSourceType,
            };
            if (
              existingRes.owner === "dhcp-lease" ||
              existingRes.owner === "dhcp-reservation"
            ) {
              update.owner =
                proposedSourceType === "dhcp_reservation"
                  ? "dhcp-reservation"
                  : "dhcp-lease";
            }
            if (needsStalenessBump) {
              update.lastSeenLeased = new Date();
              update.staleNotifiedAt = null;
              update.staleSnoozedUntil = null;
            }
            phase5Stats.pathExistingDhcpFlipMixed++;
            await prisma.reservation.update({
              where: { id: existingRes.id },
              data: update,
            });
            phase5Stats.writesReservationUpdate++;
          } else if (needsStalenessBump) {
            // Pure staleness bump — defer to one bulk updateMany at end of
            // phase. Every row in this set gets the same data shape
            // (lastSeenLeased=now, clear staleNotifiedAt + staleSnoozedUntil),
            // so a single statement covers them all. On a 200-row FortiGate
            // this is the difference between 100+ updates and 1.
            dhcpFlipBumpOnlyIds.push(existingRes.id);
            phase5Stats.pathExistingDhcpFlipBumpOnly++;
          } else {
            phase5Stats.pathExistingDhcpNoChange++;
          }
        } else if (isInfraSourceType(existingRes.sourceType)) {
          // Managed FortiSwitch/FortiAP row (Phase 3a/3b created it, and the IP
          // it claimed may have come from this very lease table via the hostname
          // fallback). Phase 5 is the ONLY pass that can see whether the gate
          // leases this address or genuinely reserves it, and before this branch
          // existed it dropped that fact on the floor every cycle — leaving a
          // row that reads authoritative in Polaris while the FortiGate's DHCP
          // page says "Not Reserved", with no Reserve action to fix it.
          //
          // sourceType is deliberately NOT flipped: it answers "who owns this
          // IP" and is still correct. Only the orthogonal binding fact is
          // recorded. See utils/infraDhcpBinding.ts for why expiresAt is never
          // stamped here and why the MAC comes from the lease entry only.
          const patch = decideInfraDhcpBinding(existingRes, entry);
          if (patch) {
            const update: Record<string, unknown> = {};
            if (patch.dhcpBinding) update.dhcpBinding = patch.dhcpBinding;
            if (patch.macAddress) update.macAddress = patch.macAddress;
            if (patch.lastSeenLeased) {
              update.lastSeenLeased = new Date();
              update.staleNotifiedAt = null;
              update.staleSnoozedUntil = null;
            }
            phase5Stats.pathExistingInfraBindingChange++;
            await prisma.reservation.update({
              where: { id: existingRes.id },
              data: update,
            });
            phase5Stats.writesReservationUpdate++;
            if (patch.dhcpBinding) existingRes.dhcpBinding = patch.dhcpBinding;
            if (patch.macAddress) existingRes.macAddress = patch.macAddress;
          } else {
            // Steady state — the overwhelmingly common case once a fleet has
            // been through one cycle. No write: this runs per DHCP entry per
            // cycle and at 2000 assets an unconditional update here would be
            // the same mistake the bulked staleness bump above exists to avoid.
            phase5Stats.pathExistingInfraNoChange++;
          }
        }
        continue;
      }

      // Persist the MAC at first discovery. The FortiOS CMDB reserved-address
      // payload already carries the MAC; without this the row is created with
      // macAddress=null and the IP panel edit modal can't render the existing
      // MAC for the operator to edit.
      const normalizedMacAtCreate = entry.macAddress
        ? entry.macAddress.toUpperCase().replace(/-/g, ":")
        : null;
      const createData = {
        subnetId: matchingSubnet.id,
        ipAddress: entry.ipAddress,
        hostname: proposedHostname,
        owner: proposedOwner,
        projectRef: projectRefLabel,
        notes: proposedNotes,
        macAddress: normalizedMacAtCreate,
        status: "active" as const,
        sourceType: proposedSourceType,
        expiresAt: proposedExpiresAt,
        // First-discovery stamp for newly-created dhcp_reservation rows
        // whose target is currently online — gives the stale job a
        // baseline so it doesn't immediately flag a brand-new reservation
        // we just learned about.
        lastSeenLeased: entry.seenLeased && isDhcpReservation ? new Date() : null,
      };
      try {
        await releaseDnsResolvedAt(matchingSubnet.id, entry.ipAddress);
        phase5Stats.writesDnsRelease++;
        let newRes;
        let createdAfterRetry = false;
        try {
          newRes = await prisma.reservation.create({ data: createData });
          phase5Stats.writesReservationCreate++;
        } catch (err: any) {
          // `fireDnsResolvedReconcile` (Prisma extension hook in src/db.ts) is
          // fire-and-forget on every asset write that touches ipAddress /
          // status / hostname / dnsName / macAddress. A queued reconcile from
          // Phase 3/4 or a parallel monitor pass can land between the
          // releaseDnsResolvedAt call above and this create, inserting a
          // dns_resolved row at (subnetId, ip, "active") that then collides
          // with our create on the @@unique([subnetId, ipAddress, status])
          // index. P2002 with a dns_resolved row on the colliding side →
          // release it again and retry once. Any other sourceType is a
          // genuine collision (concurrent integration writing to overlapping
          // subnets, manual reservation typed during sync, etc.) — log and
          // skip rather than thrashing.
          if (err?.code !== "P2002") throw err;
          const colliding = await prisma.reservation.findFirst({
            where: { subnetId: matchingSubnet.id, ipAddress: entry.ipAddress, status: "active" },
            select: { id: true, sourceType: true },
          });
          if (colliding?.sourceType !== "dns_resolved") {
            syncLog("error", `Failed to create DHCP ${isDhcpReservation ? "reservation" : "lease"} for ${entry.ipAddress}: collided with active ${colliding?.sourceType ?? "(missing)"} reservation`);
            phase5Stats.skippedCollision++;
            continue;
          }
          // Hard-delete the colliding dns_resolved row rather than flipping
          // to status="released" — the (sub, ip, "released") slot may
          // already be occupied by an older released dns_resolved row, and
          // the @@unique([subnetId, ipAddress, status]) constraint would
          // block the transition. dns_resolved is a system fallback with no
          // audit value, so the delete is the simpler + always-correct
          // semantic.
          await prisma.reservation.delete({ where: { id: colliding.id } });
          phase5Stats.writesReservationDelete++;
          newRes = await prisma.reservation.create({ data: createData });
          phase5Stats.writesReservationCreate++;
          createdAfterRetry = true;
        }
        if (createdAfterRetry) {
          phase5Stats.pathNewCreateAfterRetry++;
        } else {
          phase5Stats.pathNewCreate++;
        }
        activeResMap.set(key, newRes); // Track for MAC cross-update phase
        if (isDhcpReservation) {
          dhcpReservations.push(`${entry.ipAddress} (${entry.hostname || entry.macAddress})`);
        } else {
          dhcpLeases.push(`${entry.ipAddress} (${entry.hostname || entry.macAddress})`);
        }
      } catch (err: any) {
        phase5Stats.pathNewCreateFailed++;
        syncLog("error", `Failed to create DHCP ${isDhcpReservation ? "reservation" : "lease"} for ${entry.ipAddress}: ${err.message || "Unknown error"}`);
      }
    }
  }

  // Flush the deferred dhcp_reservation staleness bumps as one updateMany.
  // Every row in dhcpFlipBumpOnlyIds gets the same data shape, so this is
  // exactly the shape updateMany was designed for. One statement regardless
  // of row count — the dominant per-cycle write savings on big FortiGates.
  if (dhcpFlipBumpOnlyIds.length > 0) {
    const bumpAt = new Date();
    await prisma.reservation.updateMany({
      where: { id: { in: dhcpFlipBumpOnlyIds } },
      data: {
        lastSeenLeased: bumpAt,
        staleNotifiedAt: null,
        staleSnoozedUntil: null,
      },
    });
    phase5Stats.writesReservationUpdateMany++;
  }

  // Phase 5 summary — one info Event per per-FortiGate sync so operators can
  // characterize the actual per-cycle DB write distribution from the Events
  // page. The path-* counters sum to entriesTotal; the writes-* counters are
  // the actual prisma.reservation/conflict statements issued (NOT rows —
  // updateMany counts as one regardless of rows touched, which is the
  // connection-pressure number).
  if (phase5Stats.entriesTotal > 0) {
    const totalWrites =
      phase5Stats.writesReservationUpdate +
      phase5Stats.writesReservationUpdateMany +
      phase5Stats.writesReservationCreate +
      phase5Stats.writesReservationDelete +
      phase5Stats.writesConflictUpdateMany +
      phase5Stats.writesDnsRelease +
      phase5Stats.writesUpsertConflict;
    syncLog(
      "info",
      `Phase 5 DHCP entry processing: ${phase5Stats.entriesTotal} entries, ${totalWrites} DB writes ` +
      `(updates=${phase5Stats.writesReservationUpdate}, updateMany=${phase5Stats.writesReservationUpdateMany} covering ${dhcpFlipBumpOnlyIds.length} rows, ` +
      `creates=${phase5Stats.writesReservationCreate}, deletes=${phase5Stats.writesReservationDelete}, ` +
      `conflictUpdates=${phase5Stats.writesConflictUpdateMany}, dnsReleases=${phase5Stats.writesDnsRelease}, ` +
      `upsertConflicts=${phase5Stats.writesUpsertConflict}); ` +
      `paths: noChange=${phase5Stats.pathExistingDhcpNoChange}, ` +
      `dhcpFlipMixed=${phase5Stats.pathExistingDhcpFlipMixed}, dhcpFlipBumpOnly=${phase5Stats.pathExistingDhcpFlipBumpOnly}, ` +
      `polarisEcho=${phase5Stats.pathExistingManualPolarisEcho}, manualConflict=${phase5Stats.pathExistingManualConflictOnly}, ` +
      `vipSucc=${phase5Stats.pathExistingVipSuccession}, vipMacFill=${phase5Stats.pathExistingVipMacFill}, ` +
      `pendingAdopt=${phase5Stats.pathExistingPendingAdopt}, pendingCollide=${phase5Stats.pathExistingPendingCollide}, ` +
      `infraBinding=${phase5Stats.pathExistingInfraBindingChange}, infraNoChange=${phase5Stats.pathExistingInfraNoChange}, ` +
      `newCreate=${phase5Stats.pathNewCreate}, newCreateRetry=${phase5Stats.pathNewCreateAfterRetry}, ` +
      `newCreateFail=${phase5Stats.pathNewCreateFailed}, skipNoIp=${phase5Stats.skippedNoIp}, ` +
      `skipNoSubnet=${phase5Stats.skippedNoSubnet}, skipCollision=${phase5Stats.skippedCollision})`,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 5b — Release stale authoritative-source rows (VIPs + dhcp_reservations)
  phaseMark("5b");
  //
  // The FortiGate is the authoritative source for its own VIPs and CMDB DHCP
  // reservations. When a row that was previously discovered no longer appears
  // in the gate's response — and that gate's query succeeded this cycle —
  // an operator deleted it on the gate, so Polaris should reflect that.
  //
  // Two distinct sweeps share one walk over activeResMap:
  //   • VIP sweep — gated on vipQueriedDevices. Phase 5 already converted
  //     any VIP that was replaced by a fresh dhcp_* entry in this cycle
  //     (its sourceType is no longer "vip"), so anything still tagged vip
  //     here truly disappeared with no replacement.
  //   • dhcp_reservation sweep — gated on dhcpReservationsInventoriedDevices.
  //     Covers Polaris-pushed manual reservations that flipped to
  //     dhcp_reservation on first sight AND fresh-from-CMDB rows. Leases
  //     and fortiswitch/fortinap source types are intentionally NOT swept
  //     here — leases age out via expireReservations + the stale-reservation
  //     job, and fortiswitch/fortinap reservations are device-presence
  //     indicators (Phase 2b handles their decommission separately).
  //
  // dhcp_reservation membership test: an entry is "still on the gate" if any
  // entry in result.dhcpEntries is at this (subnetId, ip) AND the entry's
  // device is one whose CMDB query succeeded. dhcp_lease entries also satisfy
  // membership because a static reservation that's currently leased shows up
  // as either (the discovery merger keeps CMDB rows on overlap; the monitor
  // pass annotates them).
  // ══════════════════════════════════════════════════════════════════════════════
  const dhcpReservationDevices = new Set<string>(result.dhcpReservationsInventoriedDevices ?? []);
  const stillOnGateKeys = new Set<string>();
  if (Array.isArray(result.dhcpEntries)) {
    for (const e of result.dhcpEntries) {
      if (!e.ipAddress || !dhcpReservationDevices.has(e.device)) continue;
      const s = findSubnetForIp(e.ipAddress);
      if (s) stillOnGateKeys.add(reservationKey(s.id, e.ipAddress));
    }
  }
  // Subnet index by id — used to scope dhcp_reservation cleanup to subnets
  // this integration discovered (and to read fortigateDevice in O(1)).
  const subnetById = new Map<string, any>();
  for (const s of allSubnets) subnetById.set(s.id, s);

  let releasedStaleVips = 0;
  let releasedStaleDhcpReservations = 0;
  for (const [key, row] of activeResMap.entries()) {
    if (!row || row.status !== "active") continue;
    if (row.sourceType === "vip") {
      const dev = ((row.vipInfo as any)?.device) || "";
      if (!vipQueriedDevices.has(dev)) continue;
      if (currentVipKeys.has(key)) continue;
      const priorVipInfo = row.vipInfo as any;
      try {
        // `vipInfo: null` clears the JSON column. Routed through a
        // Record<string, unknown> bag so Prisma's narrow nullable-Json
        // input type doesn't reject — matches the in-place convert path
        // above.
        const vipReleaseData: Record<string, unknown> = { status: "released", vipInfo: null };
        await prisma.reservation.update({
          where: { id: row.id },
          data: vipReleaseData,
        });
        await prisma.conflict.updateMany({
          where: { reservationId: row.id, status: "pending" },
          data: { status: "rejected", resolvedBy: "auto", resolvedAt: new Date() },
        });
        activeResMap.delete(key);
        releasedStaleVips++;
        logEvent({
          action: "reservation.vip.released",
          resourceType: "reservation",
          resourceId: row.id,
          resourceName: row.ipAddress || "",
          actor,
          message: `VIP "${priorVipInfo?.name || "(unknown)"}" no longer on ${priorVipInfo?.device || "(unknown)"} — reservation released`,
          details: {
            integrationId,
            integrationName,
            reservationId: row.id,
            ipAddress: row.ipAddress,
            priorVipInfo,
            fortigateDevice: dev,
          },
        });
      } catch (err: any) {
        syncLog("error", `Failed to release stale VIP reservation ${row.ipAddress}: ${err.message || "Unknown error"}`);
      }
      continue;
    }
    if (row.sourceType === "dhcp_reservation") {
      // Scope: only this integration's own discovered rows. A subnet
      // discovered by a different integration is out of scope even if
      // the FortiGate name happens to coincide.
      if (!row.subnetId) continue;
      const subnet = subnetById.get(row.subnetId);
      if (!subnet || subnet.discoveredBy !== integrationId) continue;
      if (!subnet.fortigateDevice || !dhcpReservationDevices.has(subnet.fortigateDevice)) continue;
      if (stillOnGateKeys.has(key)) continue;
      try {
        await prisma.reservation.update({
          where: { id: row.id },
          data: {
            status: "released",
            // Clear push pointers — the device-side entry is gone (operator
            // deleted on the gate), and any future re-reservation at this
            // IP should make its own push from scratch.
            pushedToId: null,
            pushedScopeId: null,
            pushedEntryId: null,
            pushStatus: null,
          },
        });
        await prisma.conflict.updateMany({
          where: { reservationId: row.id, status: "pending" },
          data: { status: "rejected", resolvedBy: "auto", resolvedAt: new Date() },
        });
        activeResMap.delete(key);
        releasedStaleDhcpReservations++;
        logEvent({
          action: "reservation.dhcp_reservation.released",
          resourceType: "reservation",
          resourceId: row.id,
          resourceName: row.ipAddress || "",
          actor,
          message: `DHCP reservation for ${row.ipAddress} no longer on ${subnet.fortigateDevice} — reservation released`,
          details: {
            integrationId,
            integrationName,
            reservationId: row.id,
            ipAddress: row.ipAddress,
            fortigateDevice: subnet.fortigateDevice,
            wasPushedByPolaris: !!row.pushedToId,
          },
        });
      } catch (err: any) {
        syncLog("error", `Failed to release stale DHCP reservation ${row.ipAddress}: ${err.message || "Unknown error"}`);
      }
    }
  }
  if (releasedStaleVips > 0 || releasedStaleDhcpReservations > 0) {
    syncLog("info", `Stale-row sweep: released ${releasedStaleVips} VIP reservation(s), ${releasedStaleDhcpReservations} DHCP reservation(s)`);
  }

  // Per-run (MAC, gate) ARP index — the locality half of the device-inventory
  // trust decision shared by Phase 6's claim corroboration and Phase 7's
  // location writes. A FortiOS inventory entry is NOT proof the client is
  // behind that gate: a ZTNA access-proxy session creates one on the gate the
  // user connects THROUGH, MAC and all, with a fresh last_seen (prod 2026-08 —
  // a roaming user's dock MAC held a live entry three sites away and won the
  // asset's learned location every run). `inventorySightingIsLocal` admits an
  // entry only on positive local evidence: FortiSwitch/FortiAP attribution on
  // the row itself, or this ARP binding on the same gate.
  const arpMacDeviceIndex = buildArpMacDeviceIndex(result.arpTable);

  // Freshness (ms epoch) of the sighting that currently names each asset's
  // fortigate-endpoint gate this run — shared between the Phase 6 DHCP path
  // and the Phase 7 inventory path so the LATEST local sighting wins the gate
  // name regardless of which pathway carried it, instead of whichever pathway
  // (or gate) happened to iterate last. Only strictly-fresher evidence takes
  // over, so a remembered-but-offline (but still local-attributed) inventory
  // row can't out-name a currently-held lease.
  const bestGateClaimMsByAsset = new Map<string, number>();

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 6 — Associate DHCP MACs with assets & cross-update reservations
  phaseMark("6");
  //           (in-memory lookups, batched writes)
  // ══════════════════════════════════════════════════════════════════════════════

  if (result.dhcpEntries && result.dhcpEntries.length > 0) {
    // Collect all updates, then batch-execute
    // `macs` (when present) is reconciled to asset_mac_addresses after the
    // asset.update lands, so the in-memory MAC merge logic can stay
    // unchanged while the persist path uses the new side table.
    const assetUpdates: Array<{ id: string; data: any; macs?: MacJsonEntry[] }> = [];
    const resUpdates: Array<{ id: string; data: Record<string, string> }> = [];
    // Quarantine fan-out hook: every (asset, FortiGate) DHCP attribution
    // becomes a sighting. The flush at the end of the phase is fire-and-
    // forget — sighting recording must not fail the discovery sync.
    const sightingRows: sightings.SightingInput[] = [];

    // MACs the device-inventory pass (Phase 7) will stamp with the FortiGate's
    // real per-client last_seen / is_online. DHCP-lease presence defers to
    // these: a lease only proves an unexpired binding, so a device that leased
    // an IP and went home still shows a bound lease all week — stamping `now`
    // from it overstates Last Seen. When the MAC is covered by inventory this
    // cycle, Phase 7 supplies the authoritative timestamp instead. Lease-only
    // assets (inventory disabled / device not in the table) keep the lease bump.
    const inventoryMacSet = new Set<string>(
      (result.deviceInventory || [])
        .map((d) => (d.macAddress ? d.macAddress.toUpperCase().replace(/-/g, ":") : ""))
        .filter(Boolean),
    );

    // Per-(mac, gate) client freshness from device inventory — the FortiGate's
    // OWN per-client last_seen (an is_online client counts as now). Feeds the
    // multi-gate DHCP claim ranking below: two unexpired leases are both
    // "live" to the DHCP monitor, but only the gate the client is actually
    // behind keeps seeing it. LOCAL rows only: a ZTNA-relayed inventory entry
    // must not vouch for a stale lease on its own gate — and the corroborating
    // evidence here is deliberately switch/AP/ARP, never the lease itself,
    // because this map's whole job is to corroborate leases.
    const invSeenByMacDevice = new Map<string, number>();
    for (const d of result.deviceInventory || []) {
      if (!d.macAddress || !d.device) continue;
      if (!inventorySightingIsLocal(d, arpMacDeviceIndex)) continue;
      const mac = d.macAddress.toUpperCase().replace(/-/g, ":");
      const at = d.isOnline ? Date.parse(now) : Date.parse(d.lastSeen);
      if (Number.isNaN(at)) continue;
      const key = `${mac}|${d.device}`;
      const prev = invSeenByMacDevice.get(key);
      if (prev === undefined || at > prev) invSeenByMacDevice.set(key, at);
    }

    // Best standing DHCP claim per asset. An asset sighted by several gates
    // this run (unexpired lease on the site it left + fresh lease where it
    // moved, or a config-only static reservation beside a live lease) must
    // take ipAddress / ipSource / learnedLocation — and the fortigate-endpoint
    // source blob's gate — from the FRESHEST sighting, not from whichever
    // entry iterates last. See utils/dhcpClaimFreshness.ts for the ranking.
    const bestIpClaimByAsset = new Map<string, DhcpClaimScore>();

    for (const entry of result.dhcpEntries) {
      if (!entry.macAddress || !entry.ipAddress) continue;
      const normalized = entry.macAddress.toUpperCase().replace(/-/g, ":");

      // DHCP IPs recycle across devices, so IP-only matches would staple
      // a new device's MAC onto the previous lease-holder's asset.
      const asset = assetIdx.findByEntry(entry.macAddress, entry.hostname, entry.ipAddress, { allowIpFallback: false });
      if (!asset) continue;

      // Infrastructure assets (firewall/switch/AP) get their ipAddress,
      // ipSource, and learnedLocation from the dedicated FortiGate /
      // FortiSwitch / FortiAP pathways earlier in this sync. A DHCP lease
      // for one of these devices typically points at a non-management
      // interface (FortiLink, mirror VLAN, stack mgmt port) and would
      // clobber the authoritative connecting_from / mgmtIp value.
      const isInfraAsset = asset.assetType === "firewall" || asset.assetType === "switch" || asset.assetType === "access_point";
      // Fortinet-discovery-owned infra (carries the fortinetTopology stamp
      // from its own discovery loop). Presence for these is owned by that
      // loop — the firewall/switch/AP blocks bump lastSeen only when the
      // device answered live / reported connected — plus the monitor probe.
      // A client-side sighting (this box holding a DHCP lease on some gate,
      // or lingering in device inventory) must NOT freshen it: leases stay
      // bound past shutdown and FortiOS's cached is_online lags reality, so
      // an offline-in-FMG gate would otherwise show lastSeen advancing every
      // discovery run. Operator-typed non-Fortinet "firewall"/"switch" assets
      // (no topology stamp) keep the endpoint-style presence bumps — the
      // client sighting is their only evidence.
      const isFortinetOwnedInfra = isInfraAsset && asset.fortinetTopology != null;

      // Rank this entry's claim on the asset's address against the best claim
      // seen so far this run. Only the winner stages ipAddress / ipSource /
      // learnedLocation and names the fortigate-endpoint blob's gate — a
      // losing entry still contributes its sighting, MAC row, and presence.
      const claimScore = scoreDhcpClaim({
        type: entry.type,
        seenLeased: entry.seenLeased,
        expireTime: entry.expireTime,
        inventorySeenMs: entry.device
          ? invSeenByMacDevice.get(`${normalized}|${entry.device}`)
          : undefined,
      });
      const incumbentScore = bestIpClaimByAsset.get(asset.id);
      const winsIpClaim = !incumbentScore || claimBeats(claimScore, incumbentScore);
      if (winsIpClaim) bestIpClaimByAsset.set(asset.id, claimScore);

      if (entry.device) {
        sightingRows.push({
          assetId: asset.id,
          fortigateDevice: entry.device,
          source: entry.type === "dhcp-reservation" ? "dhcp_reservation" : "dhcp_lease",
          integrationId,
          ipAddress: entry.ipAddress,
          // Names the gateway-change audit row without a lookup — the asset is
          // already in hand here.
          assetHostname: asset.hostname || asset.ipAddress || null,
        });
        // Stamp this asset as a fortigate-endpoint source target — every
        // DHCP sighting counts even if the asset wasn't created via
        // device-inventory. End-of-sync flush below upserts the row.
        if (!isInfraAsset) {
          fortigateEndpointAssetIds.add(asset.id);
          if (winsIpClaim && entry.device) {
            noteEndpointGate(asset.id, entry.device);
            // Record how fresh this naming is so Phase 7's inventory pass only
            // takes the gate over with strictly newer local evidence: a
            // currently-held lease counts as now, otherwise the gate's own
            // per-client inventory last_seen when it corroborated the claim.
            const dhcpGateMs = entry.seenLeased
              ? Date.parse(now)
              : invSeenByMacDevice.get(`${normalized}|${entry.device}`) ?? 0;
            bestGateClaimMsByAsset.set(asset.id, dhcpGateMs);
          }
        }
      }

      // Resolve subnet up-front so we can stamp it on the MAC entry
      const matchingSubnet = findSubnetForIp(entry.ipAddress);

      // Update MAC list in-memory
      const macList: Array<{mac: string; lastSeen: string; source: string; subnetCidr?: string; subnetName?: string}> = Array.isArray(asset.macAddresses) ? [...(asset.macAddresses as any)] : [];
      const existingMac = macList.find((m: any) => m.mac === normalized);
      if (existingMac) {
        existingMac.lastSeen = now;
        // A sighting must not relabel a hardware-truth entry (intune-*/agent/
        // vcenter-vnic): the source is what keeps the entry eligible as the
        // PRIMARY MAC (selectPrimaryMac), and the device's real NIC showing up
        // in a lease table doesn't stop it being the real NIC.
        if (!isHardwareMacSource((existingMac as any).source)) existingMac.source = entry.type;
        if (matchingSubnet) {
          existingMac.subnetCidr = matchingSubnet.cidr;
          existingMac.subnetName = matchingSubnet.name;
        }
      } else {
        macList.push({
          mac: normalized,
          lastSeen: now,
          source: entry.type,
          ...(matchingSubnet ? { subnetCidr: matchingSubnet.cidr, subnetName: matchingSubnet.name } : {}),
        });
      }
      macList.sort((a: any, b: any) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());

      // Presence gate: dhcp-lease rows are currently-held leases and
      // seenLeased marks static reservations confirmed actively held. A
      // reservation whose target is offline is config, not presence. And
      // when device inventory covers this MAC, defer presence (lastSeen +
      // status) to Phase 7's authoritative real-last_seen / is_online signal
      // rather than stamping `now` off a possibly-idle lease binding.
      const leasePresence = entry.seenLeased && !inventoryMacSet.has(normalized);

      // Queue asset update. macAddresses go to the side table via the
      // reconcile call inside batchSettled, not as a JSON column write.
      // Primary MAC: hardware-truth entries (Intune/agent/vCenter NICs) win
      // over sightings — see selectPrimaryMac.
      const dhcpPrimaryMac = selectPrimaryMac(macList) ?? macList[0].mac;
      const updateData: Record<string, unknown> = {
        macAddress: dhcpPrimaryMac,
        // A live lease must not pull a maintenance-window asset back to
        // "active" — that status is scheduler-owned until the window ends.
        ...(leasePresence && asset.status !== "maintenance"
          ? {
              status: "active",
              ...(asset.status !== "active" ? { statusChangedAt: new Date(now), statusChangedBy: integrationLabel } : {}),
            }
          : {}),
      };
      if (leasePresence && !isFortinetOwnedInfra) bumpLastSeen(updateData, asset, new Date(now), "dhcp-lease");
      if (!isInfraAsset && winsIpClaim) {
        updateData.ipAddress = entry.ipAddress;
        updateData.ipSource = entry.device || integrationType;
        if (entry.device) updateData.learnedLocation = entry.device;
      }
      assetUpdates.push({
        id: asset.id,
        data: updateData,
        macs: macList,
      });

      // Update in-memory so device inventory phase sees current state
      asset.macAddress = dhcpPrimaryMac;
      asset.macAddresses = macList;
      if (!isInfraAsset && winsIpClaim) {
        asset.ipAddress = entry.ipAddress;
        if (entry.device) asset.learnedLocation = entry.device;
      }
      if (leasePresence) asset.status = "active";
      if (updateData.lastSeen) asset.lastSeen = updateData.lastSeen;
      assetIdx.reindex(asset);

      // Queue reservation cross-update (in-memory lookup, no DB query).
      // **Owner preservation rule:** owner is overwritten with asset.assignedTo
      // ONLY when the discovered MAC differs from the reservation's stored
      // MAC (or when the row had no stored MAC, e.g. legacy rows from before
      // the MAC ingest fix). This keeps a Polaris-set owner (stamped when an
      // operator edits the reservation) from being clobbered on every
      // discovery cycle for stable reservations; if the MAC genuinely changes
      // (a different physical device now uses this IP) the discovered owner
      // takes precedence again. Hostname follows the existing behaviour —
      // discovery is authoritative there.
      if (matchingSubnet) {
        const key = reservationKey(matchingSubnet.id, entry.ipAddress);
        const res = activeResMap.get(key);
        if (res) {
          const resMacNorm = res.macAddress
            ? res.macAddress.toUpperCase().replace(/-/g, ":")
            : null;
          const macChanged = resMacNorm !== normalized;
          const resUpdate: Record<string, string> = {};
          if (asset.hostname && res.hostname !== asset.hostname) {
            resUpdate.hostname = asset.hostname;
          }
          if (asset.assignedTo && res.owner !== asset.assignedTo && macChanged) {
            resUpdate.owner = asset.assignedTo;
          }
          // A row Polaris pushed to a gate is NOT ours to rewrite here: this is
          // a bare prisma.update with no device write behind it, so changing the
          // MAC would leave Polaris pointing at a MAC the FortiGate's
          // reserved-address entry doesn't have — a divergence nothing later
          // reconciles. Phase 7.7 owns the pushed case; it goes through
          // updatePushedReservation, which writes the device first and verifies
          // by read-back. Unpushed rows keep the historical behaviour.
          const isPushedRow = !!res.pushedToId || !!res.pushStatus;
          if (macChanged && !isPushedRow) {
            resUpdate.macAddress = normalized;
          }
          if (Object.keys(resUpdate).length > 0) {
            resUpdates.push({ id: res.id, data: resUpdate });
            // Update in-memory
            if (resUpdate.hostname) res.hostname = resUpdate.hostname;
            if (resUpdate.owner) res.owner = resUpdate.owner;
            if (resUpdate.macAddress) res.macAddress = resUpdate.macAddress;
          }
        }
      }
    }

    // Coalesce per asset before executing. Several DHCP entries for one asset
    // (multi-gate claims, multi-NIC) previously pushed one update row EACH,
    // and those raced inside batchSettled's concurrency window — the asset's
    // final ipAddress was whichever write landed last, defeating the claim
    // ranking above. Shallow-merge in iteration order (the ranked ip fields
    // are only staged by the winning entry, and a later winner overrides an
    // earlier best-so-far); the MAC list is cumulative in-memory, so the last
    // one is the most complete.
    const mergedAssetUpdates: Array<{ id: string; data: any; macs?: MacJsonEntry[] }> = [];
    {
      const byId = new Map<string, { id: string; data: any; macs?: MacJsonEntry[] }>();
      for (const u of assetUpdates) {
        const prev = byId.get(u.id);
        if (!prev) {
          const merged = { ...u };
          byId.set(u.id, merged);
          mergedAssetUpdates.push(merged);
          continue;
        }
        prev.data = { ...prev.data, ...u.data };
        if (u.macs) prev.macs = u.macs;
      }
    }

    // Batch-execute asset updates. After each successful update, reconcile
    // the MAC side table from the in-memory list the discovery sync built.
    // Keeping the reconcile inline (per-asset) instead of as a second
    // global pass means a failure on one asset's reconcile only affects
    // that asset's MAC table — the others stay consistent.
    if (mergedAssetUpdates.length > 0) {
      const results = await batchSettled(mergedAssetUpdates, async (u) => {
        const updated = await prisma.asset.update({ where: { id: u.id }, data: u.data });
        if (u.macs) await reconcileMacAddresses(u.id, u.macs);
        return updated;
      });
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "rejected") {
          const u = mergedAssetUpdates[i];
          syncLog("error", `Failed to update asset MAC/IP for asset ${u?.id} (${(u?.data as any)?.ipAddress ?? "no ip staged"}): ${(results[i] as PromiseRejectedResult).reason?.message || "Unknown error"}`);
        }
      }
    }

    // Batch-execute reservation cross-updates
    if (resUpdates.length > 0) {
      await batchSettled(resUpdates, (u) =>
        prisma.reservation.update({ where: { id: u.id }, data: u.data })
      );
    }

    // Flush quarantine-sighting rows. Failures are swallowed inside
    // recordSightings (Promise.allSettled) — a misbehaving row should not
    // fail the discovery sync.
    if (sightingRows.length > 0) {
      try {
        await sightings.recordSightings(sightingRows);
      } catch (err: any) {
        syncLog("error", `Failed to flush ${sightingRows.length} asset sighting(s): ${err.message || "Unknown error"}`);
      }

      // Auto-quarantine pass: for each unique (asset, FortiGate) sighting,
      // if the asset is currently quarantined:
      //   - Not yet a synced target on this FortiGate → extend quarantine.
      //   - Already a synced target → verify and flip drift if missing.
      // Best-effort: failures are logged but never block the discovery sync.
      const seenPairs = new Map<string, string>(); // assetId → Set of fortigateDevices (JSON-encoded unique pairs)
      const uniquePairs: Array<{ assetId: string; fortigateDevice: string }> = [];
      for (const row of sightingRows) {
        const key = `${row.assetId}|${row.fortigateDevice}`;
        if (!seenPairs.has(key)) {
          seenPairs.set(key, key);
          uniquePairs.push({ assetId: row.assetId, fortigateDevice: row.fortigateDevice });
        }
      }

      // One read screens the whole pass: almost every pair resolves to "not
      // quarantined", so the per-pair findUnique was ~one round trip per
      // sighting pair to learn nothing. Pairs that survive the screen still
      // re-read fresh per pair — a second gate's pair for the SAME asset must
      // see the targets the first pair's extend just wrote.
      const quarantinedIds = new Set<string>();
      try {
        const quarantined = await prisma.asset.findMany({
          where: { id: { in: [...new Set(uniquePairs.map((p) => p.assetId))] }, status: "quarantined" },
          select: { id: true },
        });
        for (const a of quarantined) quarantinedIds.add(a.id);
      } catch (err: any) {
        syncLog("error", `Auto-quarantine pre-read failed, skipping the pass: ${err.message || "Unknown error"}`);
      }

      for (const pair of uniquePairs) {
        if (!quarantinedIds.has(pair.assetId)) continue;
        try {
          const asset = await prisma.asset.findUnique({
            where: { id: pair.assetId },
            select: { id: true, status: true, quarantineTargets: true },
          });
          if (!asset || asset.status !== "quarantined") continue;

          const targets: Array<{ fortigateDevice: string; status: string }> =
            Array.isArray(asset.quarantineTargets) ? (asset.quarantineTargets as any[]) : [];
          const existingTarget = targets.find((t) => t.fortigateDevice === pair.fortigateDevice);

          if (!existingTarget || existingTarget.status !== "synced") {
            // Not covered — extend quarantine to this FortiGate.
            await quarantineAsset({ assetId: pair.assetId, actor: "system:auto-quarantine" });
          } else {
            // Already covered — verify and persist drift if detected.
            const verifyResult = await verifyAssetQuarantine(pair.assetId);
            if (verifyResult.driftDetected) {
              await prisma.asset.update({
                where: { id: pair.assetId },
                data: { quarantineTargets: verifyResult.targets as any },
              });
            }
          }
        } catch (err: any) {
          syncLog("error", `Auto-quarantine check failed for asset ${pair.assetId} on ${pair.fortigateDevice}: ${err.message || "Unknown error"}`);
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 7 — Device inventory (fills gaps not covered by DHCP)
  phaseMark("7");
  // ══════════════════════════════════════════════════════════════════════════════

  if (result.deviceInventory && result.deviceInventory.length > 0) {
    const dhcpMacs = new Set<string>();
    const dhcpMacToIp = new Map<string, string>();
    for (const e of result.dhcpEntries || []) {
      if (e.macAddress) {
        const m = e.macAddress.toUpperCase().replace(/-/g, ":");
        dhcpMacs.add(m);
        if (e.ipAddress && !dhcpMacToIp.has(m)) dhcpMacToIp.set(m, e.ipAddress);
      }
    }

    // Hostname → IP from existing reservations (fallback for inventory entries missing an IP)
    const resHostnameToIp = new Map<string, string>();
    for (const r of allReservationsRaw) {
      if (r.hostname && r.ipAddress) resHostnameToIp.set(r.hostname.toLowerCase(), r.ipAddress);
    }

    // Freshest inventory claim per asset for the ipAddress write below — the
    // Phase 6 rule applied to inventory-only MACs: several gates can report
    // the same client (the site it left keeps a remembered-but-offline row),
    // and without ranking the LAST row iterated wrote the IP. The gate whose
    // per-client last_seen is freshest speaks for the address.
    const bestInvIpSeenByAsset = new Map<string, number>();

    // Deferred I/O for the update path (see the note at the write site).
    // deviceInventory is every DHCP client across every gate — routinely the
    // largest row set in a run — and this loop paid an asset.update plus a
    // two-query MAC reconcile per sighting, serially. CREATES stay inline:
    // assetIdx.add needs the row's real id so a later sighting of the same
    // device updates it instead of minting a duplicate.
    // Keyed by asset, NOT a list: several gates routinely sight one client, and
    // the flush runs through batchSettled, which is CONCURRENT — two updates
    // for the same row would race and the older sighting could land last.
    // Merging in accumulation order is also exactly right, because each row's
    // updateData was computed from the in-memory object the previous row had
    // already assigned onto: later keys win, and the result is one write per
    // asset instead of one per sighting.
    const pendingInvUpdates = new Map<string, { data: Record<string, unknown>; label: string }>();
    const pendingInvMacs = new Map<string, MacJsonEntry[]>();

    for (const inv of result.deviceInventory) {
      if (!inv.macAddress && !inv.ipAddress) continue;
      const normalizedMac = inv.macAddress ? inv.macAddress.toUpperCase().replace(/-/g, ":") : "";

      const handledByDhcp = normalizedMac && dhcpMacs.has(normalizedMac);

      // In-memory asset lookup. Inventory IPs are the device's last-seen DHCP
      // IP, so they recycle just like lease IPs — skip the IP fallback.
      const existingAsset = normalizedMac
        ? assetIdx.findByEntry(inv.macAddress, inv.hostname, inv.ipAddress, { allowIpFallback: false })
        : assetIdx.findByEntry(undefined, inv.hostname, inv.ipAddress, { allowIpFallback: false });

      const switchConn = inv.switchName
        ? (inv.switchPort ? `${inv.switchName}/port${inv.switchPort}` : inv.switchName)
        : null;
      const apConn = inv.apName || null;

      // Presence evidence is the FortiGate's own per-client last_seen — NOT
      // the discovery-run time. FortiOS keeps remembered-but-offline clients
      // in this inventory (bounded by inventoryMaxAgeHours), so stamping
      // `now` would freshen devices that left the network days ago. An
      // is_online client is on the wire right now → evidence is `now`.
      const invSeenAt = inv.isOnline ? new Date(now) : new Date(inv.lastSeen);
      const invSeenValid = !Number.isNaN(invSeenAt.getTime());

      // May this row LOCATE the device? A ZTNA access-proxy session creates an
      // inventory entry (MAC, hostname, fresh last_seen and all) on a gate the
      // user merely connects THROUGH — so location-shaped writes below
      // (learnedLocation, the IP claim, the MAC entry's device stamp, the
      // endpoint-gate name) require positive local evidence: FortiSwitch/AP
      // attribution on the row, or an ARP binding on the same gate this run.
      // Non-local rows still contribute what they truly know: presence,
      // OS/vendor fingerprints, the user sighting.
      const invIsLocal = inventorySightingIsLocal(inv, arpMacDeviceIndex);

      if (existingAsset) {
        const invIsFortinetInfra = existingAsset.assetType === "firewall"
          || existingAsset.assetType === "switch"
          || existingAsset.assetType === "access_point";
        // Discovery-owned infra: presence comes from the device's own
        // discovery loop (bumps only when it answered live / reported
        // connected) + the monitor probe — never from this client-side
        // inventory sighting. FortiOS's cached is_online lags reality, so
        // without this an offline-in-FMG gate sighted as a DHCP client of
        // another gate keeps its lastSeen advancing every discovery run.
        // Mirrors the Phase 6 lease-path guard; operator-typed non-Fortinet
        // infra (no fortinetTopology stamp) keeps the bump.
        const invIsFortinetOwnedInfra = invIsFortinetInfra && existingAsset.fortinetTopology != null;
        const updateData: Record<string, unknown> = {};
        if (invSeenValid && !invIsFortinetOwnedInfra) bumpLastSeen(updateData, existingAsset, invSeenAt, "device-inventory");
        // Resurrection requires the device to be online right now — a
        // remembered-but-offline inventory row must not undo an operator's
        // (or the stale-sweep's) decommission.
        if (existingAsset.status === "decommissioned" && inv.isOnline) {
        updateData.status = "active";
        updateData.statusChangedAt = new Date(now);
        updateData.statusChangedBy = integrationLabel;
      }
        if (!handledByDhcp && inv.ipAddress && invIsLocal) {
          // Record the claim even when the value already matches — otherwise a
          // fresh row that agrees with the asset stakes no claim and a stale
          // gate's differing row iterated later would still take the address.
          // Local rows only: a ZTNA entry relays the client's IP from wherever
          // it really is, and must not write it as this gate's sighting.
          const invClaimMs = invSeenValid ? invSeenAt.getTime() : 0;
          const bestClaimMs = bestInvIpSeenByAsset.get(existingAsset.id);
          if (bestClaimMs === undefined || invClaimMs > bestClaimMs) {
            bestInvIpSeenByAsset.set(existingAsset.id, invClaimMs);
            if (inv.ipAddress !== existingAsset.ipAddress) {
              updateData.ipAddress = inv.ipAddress;
            }
          }
        }
        // Fortinet infrastructure (firewall/switch/AP) gets os/osVersion from
        // its own discovery loop via projection — canonical FortiOS strings
        // read live from the device. The device-inventory os_version for these
        // same boxes (they show up as DHCP clients of their gate) is FortiOS's
        // CACHED client fingerprint in display format ("7.4.5 Build 0734")
        // and lags upgrades. It must never overwrite the projection-owned
        // value: Phase 7 runs after the infra loops, so the set-always write
        // below re-staled AP firmware minutes after the AP loop healed it,
        // every cycle — and Phase 11's corrective projection pass excludes
        // infra assets, so nothing ever fixed it (prod 2026-07).
        // (`invIsFortinetInfra` is defined above the lastSeen bump — this
        // os-write skip deliberately keys on assetType alone, unlike the
        // topology-qualified presence guard.)
        if (inv.os && !existingAsset.os && !invIsFortinetInfra) updateData.os = inv.os;
        if (inv.os && (existingAsset as any).assetType === "other") {
          const inferred = inferAssetTypeFromOs(inv.os);
          if (inferred !== "other") updateData.assetType = inferred;
        }
        if (inv.osVersion && !invIsFortinetInfra) updateData.osVersion = inv.osVersion;
        if (inv.hardwareVendor && !existingAsset.manufacturer) updateData.manufacturer = inv.hardwareVendor;
        if (inv.device && !existingAsset.learnedLocation && invIsLocal) updateData.learnedLocation = inv.device;
        if (switchConn) updateData.lastSeenSwitch = switchConn;
        if (apConn) updateData.lastSeenAp = apConn;
        // Baseline BEFORE the Object.assign below mutates existingAsset. The
        // os/osVersion half is skipped for Fortinet infra — those never reach
        // this branch's staged writes (guarded above) and their firmware event
        // comes from the projection path's logDiscoveryAssetUpdated.
        {
          const touched: ChangeBaselineFields[] = [];
          if ("os" in updateData) touched.push("os");
          if ("osVersion" in updateData) touched.push("osVersion");
          if ("lastSeenSwitch" in updateData) touched.push("lastSeenSwitch");
          if ("lastSeenAp" in updateData) touched.push("lastSeenAp");
          if (touched.length) noteChangeBaseline(existingAsset, touched);
        }

        if (inv.user) {
          const userList: Array<{user: string; domain?: string; lastSeen: string; source: string}> = Array.isArray(existingAsset.associatedUsers) ? [...(existingAsset.associatedUsers as any)] : [];
          const parts = inv.user.includes("\\") ? inv.user.split("\\") : [null, inv.user];
          const domain = parts[0] || undefined;
          const username = parts[1] || inv.user;
          const existingUser = userList.find((u) => u.user === username && u.domain === domain);
          if (existingUser) {
            existingUser.lastSeen = now;
            existingUser.source = "device-inventory";
          } else {
            userList.push({ user: username, domain, lastSeen: now, source: "device-inventory" });
          }
          userList.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
          updateData.associatedUsers = userList;
        }

        let macListForReconcile: MacJsonEntry[] | null = null;
        if (normalizedMac && !handledByDhcp) {
          const macList: MacJsonEntry[] = Array.isArray(existingAsset.macAddresses) ? [...(existingAsset.macAddresses as any)] : [];
          // Evidence time, never run time: stamping `now` here made a
          // remembered-but-offline (or ZTNA-relayed) row re-freshen its MAC
          // entry every discovery run, which kept it winning the primary-MAC
          // sort over the device's real NICs (prod 2026-08). Only-advance, so
          // an old cached row can't move a fresher stamp backwards.
          const macSeenMs = invSeenValid ? invSeenAt.getTime() : 0;
          const existingMac = macList.find((m) => m.mac === normalizedMac);
          if (existingMac) {
            if (macSeenMs > (Date.parse(existingMac.lastSeen) || 0)) {
              existingMac.lastSeen = invSeenAt.toISOString();
            }
            // A sighting must not relabel a hardware-truth entry — the source
            // keeps the entry eligible as primary (selectPrimaryMac).
            if (!isHardwareMacSource(existingMac.source)) existingMac.source = "device-inventory";
            if (inv.device && invIsLocal) existingMac.device = inv.device;
          } else {
            macList.push({
              mac: normalizedMac,
              lastSeen: invSeenValid ? invSeenAt.toISOString() : now,
              source: "device-inventory",
              ...(inv.device && invIsLocal ? { device: inv.device } : {}),
            });
          }
          macList.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
          updateData.macAddress = selectPrimaryMac(macList) ?? macList[0].mac;
          // Update in-memory `existingAsset.macAddresses` for downstream sync
          // phases that read it before the next pre-load. Side-table reconcile
          // happens after the asset.update lands.
          existingAsset.macAddresses = macList;
          macListForReconcile = macList;
        }

        if (Object.keys(updateData).length > 0 || macListForReconcile) {
          try {
            clampAcquiredToLastSeen(updateData, existingAsset);
            if (Object.keys(updateData).length > 0) {
              // The WRITE is deferred to the flush below; every in-memory
              // effect stays right here, in order. That split is the whole
              // trick: identity resolution for later rows runs off assetIdx
              // and off this same object, so it must see the change now —
              // but the round trip does not have to happen now, and
              // deviceInventory is the largest row set in a run.
              //
              // Two rows can land on one asset (several gates sighting the
              // same client). The second's updateData is computed from this
              // object AFTER the first's Object.assign, so merging in order
              // gives the same final row the inline writes did.
              const priorPending = pendingInvUpdates.get(existingAsset.id);
              pendingInvUpdates.set(existingAsset.id, {
                data: { ...(priorPending?.data ?? {}), ...updateData },
                label: priorPending?.label ?? `${existingAsset.hostname || normalizedMac} (updated)`,
              });
              // Update in-memory
              Object.assign(existingAsset, updateData);
              assetIdx.reindex(existingAsset);
            } else if (macListForReconcile) {
              // MAC-only change still counts as a touch for the run summary.
              inventoryAssets.push(`${existingAsset.hostname || normalizedMac} (updated)`);
            }
            if (macListForReconcile) {
              // Last list per asset wins — reconcileMacAddresses is a
              // whole-list sync, so replaying an earlier row's list would
              // undo a later one. One reconcile per asset instead of one per
              // sighting (it is two queries each).
              pendingInvMacs.set(existingAsset.id, macListForReconcile);
            }
            if (existingAsset.assetType !== "firewall" && existingAsset.assetType !== "switch" && existingAsset.assetType !== "access_point") {
              fortigateEndpointAssetIds.add(existingAsset.id);
              // Name the endpoint gate only from a LOCAL sighting, and only
              // when it's strictly fresher than whatever named the gate so far
              // this run (the DHCP path's claim, or another gate's inventory
              // row) — a stale-but-local cached row must not out-name a
              // currently-held lease, and a ZTNA relay must never name it.
              if (invIsLocal && inv.device) {
                const prevMs = bestGateClaimMsByAsset.get(existingAsset.id);
                const gateMs = invSeenValid ? invSeenAt.getTime() : 0;
                if (prevMs === undefined || gateMs > prevMs) {
                  bestGateClaimMsByAsset.set(existingAsset.id, gateMs);
                  noteEndpointGate(existingAsset.id, inv.device);
                }
              }
            }
          } catch (err: any) {
            syncLog("error", `Failed to update inventory asset ${existingAsset.hostname || normalizedMac}: ${err.message || "Unknown error"}`);
          }
        }
      } else {
        // Only create new assets that have a MAC and a resolvable IP
        if (!normalizedMac) continue;
        let resolvedIp = inv.ipAddress || "";
        if (!resolvedIp) resolvedIp = dhcpMacToIp.get(normalizedMac) || "";
        if (!resolvedIp && inv.hostname) resolvedIp = resHostnameToIp.get(inv.hostname.toLowerCase()) || "";
        if (!resolvedIp) continue;

        try {
          const userList: Array<{user: string; domain?: string; lastSeen: string; source: string}> = [];
          if (inv.user) {
            const parts = inv.user.includes("\\") ? inv.user.split("\\") : [null, inv.user];
            userList.push({ user: parts[1] || inv.user, domain: parts[0] || undefined, lastSeen: now, source: "device-inventory" });
          }
          const newAsset = await prisma.asset.create({
            data: {
              ipAddress: resolvedIp,
              // Location-shaped fields only from a LOCAL sighting — a ZTNA
              // relay's entry still creates the asset (the device is real),
              // but must not claim it sits behind this gate.
              ipSource: (invIsLocal ? inv.device : null) || integrationType,
              macAddress: normalizedMac || null,
              ...(normalizedMac
                ? { macAddressRows: { create: buildMacRowsForCreate([{ mac: normalizedMac, lastSeen: invSeenValid ? invSeenAt.toISOString() : now, source: "device-inventory", ...(inv.device && invIsLocal ? { device: inv.device } : {}) }]) } }
                : {}),
              hostname: inv.hostname || null,
              manufacturer: inv.hardwareVendor || null,
              assetType: inferAssetTypeFromOs(inv.os),
              status: "active",
              statusChangedAt: new Date(now),
              statusChangedBy: integrationLabel,
              os: inv.os || null,
              osVersion: inv.osVersion || null,
              learnedLocation: invIsLocal ? inv.device || null : null,
              lastSeenSwitch: switchConn,
              lastSeenAp: apConn,
              associatedUsers: userList,
              // Honest timestamp on create too — the FortiGate's per-client
              // last_seen, or `now` only when the client is online right now.
              lastSeen: invSeenValid ? invSeenAt : null,
              ...(invSeenValid ? { lastSeenSource: "device-inventory" } : {}),
              notes: `Auto-discovered from FortiGate device inventory (${inv.device})`,
              tags: ["device-inventory", "auto-discovered"],
            },
          });
          assetIdx.add(newAsset);
          inventoryAssets.push(inv.hostname || normalizedMac || inv.ipAddress);
          logDiscoveryAssetCreated(newAsset.id, inv.hostname || normalizedMac || inv.ipAddress, {
            integrationName, integrationId, sourceKind: "fortigate-endpoint", actor,
          });
          if (newAsset.assetType !== "firewall" && newAsset.assetType !== "switch" && newAsset.assetType !== "access_point") {
            fortigateEndpointAssetIds.add(newAsset.id);
            if (invIsLocal && inv.device) {
              bestGateClaimMsByAsset.set(newAsset.id, invSeenValid ? invSeenAt.getTime() : 0);
              noteEndpointGate(newAsset.id, inv.device);
            }
          }
        } catch (err: any) {
          syncLog("error", `Failed to create inventory asset ${inv.hostname || normalizedMac || inv.ipAddress}: ${err.message || "Unknown error"}`);
        }
      }
    }

    // ── Flush Phase 7's deferred writes ──────────────────────────────────────
    // One write per asset (already merged in accumulation order), through
    // batchSettled rather than a transaction so one bad row costs its own
    // update and logs individually — the isolation the per-row try/catch gave.
    // Everything downstream (7.5 / 7.6 / 8 …) reads the DB after this point,
    // so it must land before the phase ends.
    if (pendingInvUpdates.size > 0) {
      const flush = [...pendingInvUpdates];
      const results = await batchSettled(flush, ([id, u]) =>
        prisma.asset.update({ where: { id }, data: u.data as any }),
      );
      for (let i = 0; i < results.length; i++) {
        const u = flush[i]![1];
        if (results[i].status === "rejected") {
          syncLog("error", `Failed to update inventory asset ${u.label.replace(" (updated)", "")}: ${(results[i] as PromiseRejectedResult).reason?.message || "Unknown error"}`);
        } else {
          inventoryAssets.push(u.label);
        }
      }
    }
    if (pendingInvMacs.size > 0) {
      await batchSettled([...pendingInvMacs], ([assetId, macs]) => reconcileMacAddresses(assetId, macs));
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 7b — Clear stale `device` stamps on MAC entries
  phaseMark("7b");
  //            For every FortiGate whose inventory succeeded this run, any MAC
  //            stamped with that FortiGate but not seen in the fresh inventory
  //            has a stale attribution — clear `device` on that entry.
  //            FortiGates whose inventory failed are left alone (we have no
  //            fresh answer to compare against).
  // ══════════════════════════════════════════════════════════════════════════════

  if (result.inventoryDevices && result.inventoryDevices.length > 0) {
    const refreshedDevices = new Set(result.inventoryDevices);
    // LOCAL rows only: a ZTNA-relayed inventory entry doesn't keep a device
    // stamp alive, so stamps written before the locality gate existed (a dock
    // MAC "on" a gate three sites away) heal here on the next cycle instead
    // of surviving as long as the ZTNA session keeps recurring.
    const seenMacOnDevice = new Set<string>();
    for (const inv of result.deviceInventory || []) {
      if (!inv.macAddress || !inv.device) continue;
      if (!inventorySightingIsLocal(inv, arpMacDeviceIndex)) continue;
      const mac = inv.macAddress.toUpperCase().replace(/-/g, ":");
      seenMacOnDevice.add(`${mac}|${inv.device}`);
    }

    // Stale-device sweep: when a FortiGate previously held a MAC but the
    // refreshed scrape no longer sees it on that device, clear the per-row
    // device stamp so the asset detail panel doesn't keep surfacing a
    // misleading "last seen on FortiGate-X" link. Reconciles directly to
    // the side table — no asset.update needed (only the relation rows
    // change, no scalar columns on Asset).
    const staleSweepReconciles: Array<{ id: string; macs: MacJsonEntry[] }> = [];
    for (const asset of assetIdx.all()) {
      const macs = Array.isArray(asset.macAddresses) ? (asset.macAddresses as any[]) : [];
      if (macs.length === 0) continue;
      let mutated = false;
      for (const m of macs) {
        if (!m.device || !refreshedDevices.has(m.device)) continue;
        const key = `${m.mac}|${m.device}`;
        if (!seenMacOnDevice.has(key)) {
          delete m.device;
          mutated = true;
        }
      }
      if (mutated) {
        staleSweepReconciles.push({ id: asset.id, macs });
        asset.macAddresses = macs;
      }
    }

    if (staleSweepReconciles.length > 0) {
      await batchSettled(staleSweepReconciles, (u) => reconcileMacAddresses(u.id, u.macs));
      syncLog("info", `Cleared stale MAC device stamps on ${staleSweepReconciles.length} asset(s) across ${refreshedDevices.size} refreshed FortiGate(s)`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 7.5 — Enrich existing assets from FortiSwitch MAC table + FortiGate ARP
  phaseMark("7.5");
  //              (full macmap + ARP path; non-asset-creating)
  //
  // For every (mac → switchId/portName) row from each managed FortiSwitch's
  // detected-device table, stamp the matched asset's `lastSeenSwitch` so the
  // operator can see where each endpoint is plugged in. For every (mac → ip)
  // entry from each FortiGate's ARP table, fill an asset's `ipAddress` when
  // it's empty (conservative: don't overwrite already-populated IPs to avoid
  // IP-recycling churn). FortiLink-peer rows are skipped — those are the
  // FortiGate's own MAC seen on managed-switch uplinks.
  // ══════════════════════════════════════════════════════════════════════════════

  if ((result.switchMacTable && result.switchMacTable.length > 0) ||
      (result.arpTable && result.arpTable.length > 0)) {
    const enrichmentUpdates = new Map<string, Record<string, unknown>>();

    const queueUpdate = (assetId: string, data: Record<string, unknown>) => {
      const existing = enrichmentUpdates.get(assetId);
      enrichmentUpdates.set(assetId, existing ? { ...existing, ...data } : data);
    };

    // Switch-port enrichment with port-rank attribution.
    //
    // The same MAC commonly appears on multiple switch ports because
    // FortiSwitches learn it on every port that observed traffic from the
    // device — typically the access port the device is plugged into AND
    // every upstream trunk between that switch and the FortiGate. Stamping
    // the LAST row seen would put endpoints on whichever upstream port
    // happened to come last in the iteration, which is wrong. Instead we
    // rank ports by their MAC count (cardinality of unique MACs learned
    // on the port across the whole site) and pick the LOWEST-rank port
    // for each asset — fewer MACs = closer to the leaf = real attachment
    // point. An access port with one device sees 1 MAC; an uplink trunk
    // with 50 devices behind it sees 50. `isFortilinkPeer` rows are
    // filtered out earlier as a separate "this is a FortiLink uplink"
    // signal, but the rank logic catches every other trunk-vs-access
    // ambiguity uniformly.
    const portMacCounts = new Map<string /* switchId/port */, Set<string /* mac */>>();
    for (const row of result.switchMacTable || []) {
      if (row.isFortilinkPeer) continue;
      if (!row.mac || !row.switchId || !row.portName) continue;
      const portKey = `${row.switchId}/${row.portName}`;
      let bucket = portMacCounts.get(portKey);
      if (!bucket) { bucket = new Set(); portMacCounts.set(portKey, bucket); }
      bucket.add(row.mac.toUpperCase());
    }
    // Walk again, picking the lowest-rank port per asset. lastSeen-style
    // tiebreaker isn't applied — when two ports tie, the first to win
    // sticks (deterministic from row order).
    const assetBestPort = new Map<string /* assetId */, { portLabel: string; rank: number; fortigateDevice: string }>();
    for (const row of result.switchMacTable || []) {
      if (row.isFortilinkPeer) continue;
      if (!row.mac || !row.switchId || !row.portName) continue;
      const asset = assetIdx.findByMac(row.mac);
      if (!asset) continue;
      // Skip Fortinet infrastructure assets — their topology already lives
      // on `fortinetTopology` (parentSwitch/parentPort for APs, FortiLink
      // uplinkInterface for switches). Stamping lastSeenSwitch on a
      // managed switch or FortiGate would conflate roles.
      if (asset.assetType === "switch" || asset.assetType === "firewall") continue;
      const portLabel = `${row.switchId}/${row.portName}`;
      const rank = portMacCounts.get(portLabel)?.size ?? 1;
      const best = assetBestPort.get(asset.id);
      if (!best || rank < best.rank) {
        assetBestPort.set(asset.id, { portLabel, rank, fortigateDevice: row.fortigateDevice || "" });
      }
    }
    for (const [assetId, pick] of assetBestPort) {
      const asset = assetIdx.findById(assetId);
      if (!asset) continue;
      if (asset.lastSeenSwitch !== pick.portLabel) {
        noteChangeBaseline(asset, ["lastSeenSwitch"]);
        queueUpdate(assetId, { lastSeenSwitch: pick.portLabel });
        asset.lastSeenSwitch = pick.portLabel;
      }
      // Switch-port attribution counts as a fortigate-endpoint touch
      // even when no DHCP sighting fired — the asset was seen on a
      // managed switch's port.
      if (asset.assetType !== "firewall" && asset.assetType !== "switch" && asset.assetType !== "access_point") {
        fortigateEndpointAssetIds.add(asset.id);
        // The switch's own controller gate — the MAC-table row carries it, so
        // a switch-port-only touch still names a real FortiGate rather than
        // leaving the flush to guess.
        noteEndpointGate(asset.id, pick.fortigateDevice);
      }
    }

    // ARP enrichment — fill empty ipAddress only.
    for (const row of result.arpTable || []) {
      if (!row.mac || !row.ip) continue;
      const asset = assetIdx.findByMac(row.mac);
      if (!asset) continue;
      if (asset.ipAddress) continue; // conservative: don't overwrite
      queueUpdate(asset.id, { ipAddress: row.ip, ipSource: `${row.fortigateDevice}:arp` });
      asset.ipAddress = row.ip;
      assetIdx.reindex(asset);
      if (asset.assetType !== "firewall" && asset.assetType !== "switch" && asset.assetType !== "access_point") {
        fortigateEndpointAssetIds.add(asset.id);
        noteEndpointGate(asset.id, row.fortigateDevice);
      }
    }

    if (enrichmentUpdates.size > 0) {
      const updates = Array.from(enrichmentUpdates, ([id, data]) => ({ id, data }));
      const results = await batchSettled(updates, (u) =>
        prisma.asset.update({ where: { id: u.id }, data: u.data })
      );
      let okCount = 0;
      for (const r of results) if (r.status === "fulfilled") okCount++;
      syncLog("info", `Enriched ${okCount} asset(s) from FortiSwitch macmap + FortiGate ARP (switch-port + IP)`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 7.5b — Persist each FortiGate's ARP table
  phaseMark("7.5b");
  //
  // The same rows Phase 7.5 just mined for empty-`ipAddress` enrichment, kept
  // this time. Before this they were read on every cycle and discarded three
  // times over (enrichment here, presence evidence in 7.6, MAC adoption in
  // 7.7), which left the gate's own answer to "what is at this address"
  // visible nowhere in the UI.
  //
  // Delete-replace is scoped to `arpQueriedDevices` — the gates whose live read
  // ANSWERED — so a proxied read to an offline gate, a missing monitor scope or
  // an aborted run preserves what was stored rather than blanking the tab. In
  // per-device (incremental) mode the result carries one gate, so the scope is
  // naturally that gate alone. Best-effort: a failure here must not poison a
  // run whose real work (subnets, reservations, assets) already landed.
  // ══════════════════════════════════════════════════════════════════════════════

  // No double-write on the finalize pass: the enclosing `mode === "full" ||
  // mode === "skip-deprecation"` block already excludes it, so FMG writes each
  // gate's table once as that gate lands and standalone writes once per run.
  if (isFortinetIntegrationType(integrationType) && (result.arpQueriedDevices?.length ?? 0) > 0) {
    try {
      // Device NAME → serial. The ARP row names its gate the way FortiManager
      // does, and the firewall asset is keyed by serial — resolving through the
      // hostname instead is the mismatch utils/fortinetParentKey.ts exists to
      // prevent.
      const deviceSerials = new Map<string, string>();
      for (const dev of result.devices || []) {
        if (dev?.name && dev?.serial) deviceSerials.set(dev.name, dev.serial);
      }
      const arpResult = await persistFortigateArpTables({
        integrationId,
        rows: result.arpTable || [],
        answeredDevices: result.arpQueriedDevices || [],
        deviceSerials,
        // MAC only — the run's own index, already built and warm.
        matchAssetByMac: (mac) => assetIdx.findByMac(mac)?.id ?? null,
        log: syncLog,
      });
      if (arpResult.unresolvedDevices.length > 0) {
        // Expected on the very first cycle for a gate whose firewall asset is
        // created later in the same run; persistent entries here mean the
        // fortigate-firewall AssetSource never landed.
        syncLog("info", `ARP tables: ${arpResult.unresolvedDevices.length} answering FortiGate(s) had no resolvable firewall asset — skipped`);
      }
    } catch (err: any) {
      syncLog("error", `ARP table persist failed: ${err?.message || "Unknown error"}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 7.6 — ARP presence evidence for DHCP reservations
  phaseMark("7.6");
  //
  // A FortiGate ARP entry is minutes-fresh L2 proof the device holding a MAC
  // was alive at that IP (FortiOS GCs unreferenced neighbor-cache entries
  // within ~1–5 min). When the table shows a dhcp_reservation's IP bound to
  // its reserved MAC on the owning device, stamp Reservation.lastSeenArp and
  // clear stale-alert state exactly like a live lease does — this is what
  // keeps statically-configured / ICMP-silent devices (which never lease)
  // out of the stale list. MAC match is REQUIRED: the reserved IP answering
  // from a different MAC is not presence of the reserved device. Runs on
  // whatever ARP data this cycle carries — the opt-in arpPresenceSweep
  // toggle only controls the active pre-read cache priming, not whether
  // passively-observed bindings count as evidence. Scoped per (device, ip)
  // so overlapping RFC1918 subnets behind different FortiGates on one FMG
  // can't cross-match.
  // ══════════════════════════════════════════════════════════════════════════════

  if (result.arpTable && result.arpTable.length > 0) {
    const arpMacByDevIp = new Map<string, string>();
    for (const row of result.arpTable) {
      if (!row.ip || !row.fortigateDevice) continue;
      const macKey = normalizeMacKey(row.mac);
      if (!macKey) continue;
      arpMacByDevIp.set(`${row.fortigateDevice.toLowerCase()}|${row.ip}`, macKey);
    }
    if (arpMacByDevIp.size > 0) {
      const arpDevices = [...new Set(result.arpTable.map((r) => r.fortigateDevice).filter(Boolean))];
      // One indexed query bounded by this device batch's dhcp_reservation
      // count; matching is O(1) map lookups. Safe at 2000+ reservations.
      const arpCandidateRows = await prisma.reservation.findMany({
        where: {
          status: "active",
          sourceType: "dhcp_reservation",
          ipAddress: { not: null },
          macAddress: { not: null },
          subnet: { discoveredBy: integrationId, fortigateDevice: { in: arpDevices } },
        },
        select: { id: true, ipAddress: true, macAddress: true, subnet: { select: { fortigateDevice: true } } },
      });
      const arpConfirmedIds: string[] = [];
      for (const r of arpCandidateRows) {
        const dev = r.subnet.fortigateDevice;
        if (!dev || !r.ipAddress) continue;
        const arpMac = arpMacByDevIp.get(`${dev.toLowerCase()}|${r.ipAddress}`);
        if (!arpMac) continue;
        const resMac = normalizeMacKey(r.macAddress);
        if (resMac && resMac === arpMac) arpConfirmedIds.push(r.id);
      }
      if (arpConfirmedIds.length > 0) {
        // Same re-arm semantics as a live lease: clearing staleNotifiedAt /
        // staleSnoozedUntil lets a row that later goes silent alert cleanly.
        await prisma.reservation.updateMany({
          where: { id: { in: arpConfirmedIds } },
          data: { lastSeenArp: new Date(), staleNotifiedAt: null, staleSnoozedUntil: null },
        });
        syncLog("info", `ARP presence: ${arpConfirmedIds.length} DHCP reservation(s) confirmed live by FortiGate ARP (IP+MAC match)`);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 7.7 — Adopt the real MAC onto placeholder-MAC reservations
  phaseMark("7.7");
  //
  // A reservation created for a not-yet-racked device carries a SYNTHETIC MAC
  // (see utils/mac.ts) so it could be written to the gate at all. That entry
  // matches nothing: when the device finally arrives it DHCPs with its real MAC,
  // misses the reservation and takes a pool address instead. Phase 7.6 above has
  // the correcting evidence in hand — it just drops a MAC mismatch on the floor,
  // because for PRESENCE a different MAC genuinely isn't proof the reserved
  // device is alive. Here that same mismatch is the signal: if the stored MAC is
  // a placeholder, whatever is actually answering at that IP is the device the
  // reservation was always meant for.
  //
  // Double opt-in (pushReservations + adoptDiscoveredMac), placeholder-only
  // overwrite, device-write-then-Polaris ordering and the per-RUN budget all
  // live in the service — see its header. Wrapped in a catch so an adoption
  // failure never poisons the run's accounting, matching the other
  // device-writing passes.
  // ══════════════════════════════════════════════════════════════════════════════

  if (adoptionBudget && adoptionBudget.remaining > 0 && !signal?.aborted) {
    // Inventory evidence is locality-filtered: with overlapping RFC1918
    // subnets, a ZTNA-relayed row can claim (this gate, <client's home IP>)
    // for an address this gate ALSO serves — exactly the key a placeholder
    // reservation here would adopt the wrong MAC from. ARP rows are local by
    // construction and pass through unfiltered.
    const evidence = buildMacEvidenceIndex(
      result.arpTable || [],
      (result.deviceInventory || []).filter((d) => inventorySightingIsLocal(d, arpMacDeviceIndex)),
    );
    if (evidence.size > 0) {
      await runPlaceholderMacAdoption({
        integrationId,
        integrationName,
        evidence,
        budget: adoptionBudget,
        actor,
        signal,
      })
        .then((r) => {
          if (r.attempted > 0) {
            syncLog(
              "info",
              `Placeholder MAC adoption: ${r.adopted} reservation(s) updated to the discovered device's MAC`
                + (r.failed > 0 ? `, ${r.failed} failed` : "")
                + (r.deferred > 0 ? `, ${r.deferred} deferred to the next cycle` : ""),
            );
          }
        })
        .catch((err: any) => {
          syncLog("error", `Placeholder MAC adoption failed: ${err?.message || "Unknown error"}`);
        });
    }
  }

  } // end Phases 3–7 (full | skip-deprecation)

  if (mode === "full" || mode === "finalize") {
  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 8 — DNS reverse lookup for assets missing dnsName
  phaseMark("8");
  // ══════════════════════════════════════════════════════════════════════════════

  const DEFAULT_PTR_TTL_S = 3600;
  const nowMs = Date.now();
  const assetsNeedingDns = assetIdx.all().filter((a: any) => {
    if (!a.ipAddress) return false;
    if (!a.dnsNameFetchedAt) return true;
    const fetchedMs = new Date(a.dnsNameFetchedAt).getTime();
    const ttlMs = ((a.dnsNameTtl ?? DEFAULT_PTR_TTL_S) * 1000);
    return (nowMs - fetchedMs) > ttlMs;
  });
  if (assetsNeedingDns.length > 0) {
    syncLog("info", `DNS lookup: resolving ${assetsNeedingDns.length} assets with expired/missing PTR`);
    const dnsResolver = await getConfiguredResolver();
    const dnsResults = await batchSettled(assetsNeedingDns, async (asset: any) => {
      const fetchedAt = new Date();
      const records = await dnsResolver.reverse(asset.ipAddress);
      if (records.length > 0) {
        await prisma.asset.update({ where: { id: asset.id }, data: { dnsName: records[0].name, dnsNameFetchedAt: fetchedAt, dnsNameTtl: records[0].ttl } });
        asset.dnsName = records[0].name;
        return records[0].name;
      }
      await prisma.asset.update({ where: { id: asset.id }, data: { dnsNameFetchedAt: fetchedAt, dnsNameTtl: null } });
      return null;
    });
    for (const r of dnsResults) {
      if (r.status === "fulfilled" && r.value) dnsResolved++;
    }
    if (dnsResolved > 0) {
      syncLog("info", `DNS lookup: resolved ${dnsResolved} of ${assetsNeedingDns.length} assets`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 9 — OUI manufacturer lookup & override application
  phaseMark("9");
  // ══════════════════════════════════════════════════════════════════════════════

  // 9a — Apply OUI overrides to assets that already have a manufacturer
  //       (e.g. "Fortinet" from FMG can be overridden to a custom name; an
  //       optional device field overrides the asset's model too)
  const assetsWithMacAndMfg = assetIdx.all().filter((a: any) => a.macAddress && a.manufacturer);
  if (assetsWithMacAndMfg.length > 0) {
    const overrideResults = await batchSettled(assetsWithMacAndMfg, async (asset: any) => {
      const override = await lookupOuiOverride(asset.macAddress);
      if (!override) return null;
      const data: { manufacturer?: string; model?: string } = {};
      if (override.manufacturer !== asset.manufacturer) data.manufacturer = override.manufacturer;
      if (override.device && override.device !== asset.model) data.model = override.device;
      if (Object.keys(data).length === 0) return null;
      await prisma.asset.update({ where: { id: asset.id }, data });
      if (data.manufacturer) asset.manufacturer = data.manufacturer;
      if (data.model) asset.model = data.model;
      return data;
    });
    for (const r of overrideResults) {
      if (r.status === "fulfilled" && r.value) ouiOverridden++;
    }
    if (ouiOverridden > 0) {
      syncLog("info", `OUI overrides: applied to ${ouiOverridden} assets`);
    }
  }

  // 9b — OUI lookup for assets still missing a manufacturer.
  //       Also pick up the override's device field when present (applies
  //       even if asset already has a model — override wins by design).
  const assetsNeedingOui = assetIdx.all().filter((a: any) => a.macAddress && !a.manufacturer);
  if (assetsNeedingOui.length > 0) {
    syncLog("info", `OUI lookup: resolving ${assetsNeedingOui.length} assets missing manufacturer`);
    const ouiResults = await batchSettled(assetsNeedingOui, async (asset: any) => {
      const vendor = await lookupOui(asset.macAddress);
      if (!vendor) return null;
      const override = await lookupOuiOverride(asset.macAddress);
      const data: { manufacturer: string; model?: string } = { manufacturer: vendor };
      if (override?.device && override.device !== asset.model) data.model = override.device;
      await prisma.asset.update({ where: { id: asset.id }, data });
      asset.manufacturer = vendor;
      if (data.model) asset.model = data.model;
      return vendor;
    });
    for (const r of ouiResults) {
      if (r.status === "fulfilled" && r.value) ouiResolved++;
    }
    if (ouiResolved > 0) {
      syncLog("info", `OUI lookup: resolved ${ouiResolved} of ${assetsNeedingOui.length} assets`);
    }
  }

  } // end Phases 8–9 (full | finalize)

  // Phase 10 — fortigate-endpoint AssetSource flush. Stamp every endpoint
  phaseMark("10");
  // asset this sync touched with a fortigate-endpoint source row so the
  // operator's asset-detail Sources tab reflects "this device was
  // discovered/seen by FortiManager X" alongside any entra/ad/intune
  // sources the device already has. Runs on every mode (full /
  // skip-deprecation / finalize) — touch-tracking captured the assets
  // each pathway hit. Best-effort per asset; failures are logged but
  // don't block the sync.
  let endpointSourcesStamped = 0;
  if (fortigateEndpointAssetIds.size > 0) {
    const flushedAt = new Date(now);
    // Gate name fallback for the rare touch that carried none (a device-
    // inventory row with no `device`): keep whatever this source last said
    // rather than nulling it. One bulk read, mirroring Phase 11's — and NOT
    // shared with it, because Phase 11 must see the rows this phase writes.
    const priorGateByAsset = new Map<string, string>();
    try {
      const priorRows = await prisma.assetSource.findMany({
        where: { sourceKind: "fortigate-endpoint", assetId: { in: [...fortigateEndpointAssetIds] } },
        select: { assetId: true, observed: true },
      });
      for (const row of priorRows) {
        const prior = (row.observed as Record<string, unknown> | null)?.learnedLocation;
        if (typeof prior !== "string" || !prior.trim()) continue;
        priorGateByAsset.set(row.assetId, bareFortinetDeviceName(prior.trim()));
      }
    } catch (err: any) {
      syncLog("error", `fortigate-endpoint AssetSource: prior-gate preload failed (${err?.message || "unknown"})`);
    }
    const results = await batchSettled(
      Array.from(fortigateEndpointAssetIds),
      async (assetId: string) => {
        const asset = assetIdx.findById(assetId);
        if (!asset || !asset.macAddress) return false;
        const gateName = fortigateEndpointDeviceByAsset.get(assetId)
          ?? priorGateByAsset.get(assetId)
          ?? null;
        await upsertFortigateEndpointSource(assetId, integrationId, asset, integrationType, asset.lastSeen ?? flushedAt, integrationName, gateName);
        return true;
      },
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value === true) endpointSourcesStamped++;
    }
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      syncLog("error", `fortigate-endpoint AssetSource: stamped ${endpointSourcesStamped}, ${failed} failed`);
    }
  }

  // Phase 11 — projection apply pass. The inline merge in syncDhcpSubnets
  phaseMark("11");
  // sets Asset fields opportunistically (set-when-empty for OS, set-always
  // for osVersion, etc.). After Phase 10 stamps the fortigate-endpoint
  // source row, a hybrid-managed device has all its sources on file:
  // entra + intune + ad + fortigate-endpoint, each with its own observed
  // blob. We re-project here and correct any field where projection
  // priority disagrees with the inline-written value.
  //
  // Concretely this fixes: Intune's `osVersion = "10.0.19045"` getting
  // overwritten by FortiOS's coarser `osVersion = "10.0"` on every
  // device-inventory pass, plus mirror cases where AD's verbose
  // `operatingSystem = "Windows 10 Pro"` should beat Intune's "Windows".
  // For assets WITHOUT MDM/AD sources the projection picks
  // fortigate-endpoint's values and writes them back unchanged, so
  // FortiGate-only fleets behave identically to before.
  //
  // Skips fields the projection deliberately doesn't own (lastSeenSwitch,
  // lastSeenAp, status, mac, operator-owned fields — see the priority
  // table in polaris-monitoring-discovery -> discovery-overview.md). Only writes when the projected value is non-null
  // AND differs from the current Asset value, so quiet syncs skip the
  // round-trip entirely.
  let projectionCorrected = 0;
  if (fortigateEndpointAssetIds.size > 0) {
    // Pre-load every touched asset's AssetSource rows in ONE query and
    // partition by assetId in JS. Was: N sequential `assetSource.findMany`
    // calls (one per touched endpoint) — for a 5K-endpoint sync that's 5K
    // round-trips before any update happens. The bulk fetch + Map dispatch
    // collapses that to one round-trip. Per-asset writes still go through
    // batchSettled so unchanged assets don't pay any DB cost.
    const allSourceRows = await prisma.assetSource.findMany({
      where: { assetId: { in: [...fortigateEndpointAssetIds] } },
      // lastSeen rides along so the projection can let the FRESHEST of
      // several same-kind rows speak for the kind — an asset that changed
      // NICs keeps one fortigate-endpoint row per MAC, and without the
      // freshness cue the stale NIC's blob could win the pick and revert
      // the ipAddress Phase 6 just corrected.
      select: { assetId: true, sourceKind: true, inferred: true, observed: true, lastSeen: true },
    });
    const sourcesByAsset = new Map<string, typeof allSourceRows>();
    for (const r of allSourceRows) {
      const existing = sourcesByAsset.get(r.assetId);
      if (existing) existing.push(r);
      else sourcesByAsset.set(r.assetId, [r]);
    }

    const projectionResults = await batchSettled(
      Array.from(fortigateEndpointAssetIds),
      async (assetId: string) => {
        const asset = assetIdx.findById(assetId);
        if (!asset) return false;
        const sourceRows = sourcesByAsset.get(assetId) ?? [];
        const { projected } = projectAssetFromSources(
          sourceRows.map((s) => ({
            sourceKind: s.sourceKind,
            inferred: s.inferred,
            observed: s.observed as Record<string, unknown> | null,
            lastSeen: s.lastSeen,
          })),
        );
        const corrections: Record<string, unknown> = {};
        const considerString = (key: "hostname" | "os" | "osVersion" | "manufacturer" | "model" | "learnedLocation" | "ipAddress" | "serialNumber") => {
          const next = projected[key];
          if (next !== null && next !== (asset as any)[key]) {
            corrections[key] = next;
          }
        };
        considerString("hostname");
        considerString("os");
        considerString("osVersion");
        considerString("manufacturer");
        considerString("model");
        considerString("learnedLocation");
        considerString("ipAddress");
        considerString("serialNumber");
        // lat/long: only meaningful for firewall-typed assets (excluded
        // from this set since infrastructure assets aren't tracked in
        // fortigateEndpointAssetIds), so we don't bother projecting.
        if (Object.keys(corrections).length === 0) return false;
        // ipAddress correction needs to clear ipSource if the inline path
        // wrote a stale tag. Mirror the existing inline pattern.
        if ("ipAddress" in corrections) {
          corrections.ipSource = `${integrationType}:fortigate-endpoint`;
        }
        clampAcquiredToLastSeen(corrections, asset);
        // Baseline before the in-memory assign: this pass is the one that
        // corrects Phase 7's coarse osVersion back to the projected value, so
        // for an asset Phase 7 already touched the baseline is ALREADY the
        // pre-run value (first touch wins) and the round trip nets out.
        {
          const touched: ChangeBaselineFields[] = [];
          if ("os" in corrections) touched.push("os");
          if ("osVersion" in corrections) touched.push("osVersion");
          if (touched.length) noteChangeBaseline(asset, touched);
        }
        await prisma.asset.update({ where: { id: assetId }, data: corrections });
        Object.assign(asset, corrections);
        return true;
      },
    );
    for (const r of projectionResults) {
      if (r.status === "fulfilled" && r.value === true) projectionCorrected++;
    }
    const projFailed = projectionResults.filter((r) => r.status === "rejected").length;
    if (projFailed > 0) {
      syncLog("error", `fortigate-endpoint projection apply: corrected ${projectionCorrected}, ${projFailed} failed`);
    } else if (projectionCorrected > 0) {
      syncLog("info", `fortigate-endpoint projection apply: corrected ${projectionCorrected} of ${fortigateEndpointAssetIds.size} touched assets`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 11.5 — Flush per-asset change events
  //
  // One batch per run, diffing each tracked field's first-touch baseline
  // against its final in-memory value. Runs AFTER Phase 11 so the intra-run
  // ping-pongs described at the changeBaseline declaration have settled — a
  // steady fleet produces an empty array and writes nothing.
  //
  // Events are optimistic with respect to Phase 7.5's batchSettled flush (a
  // write that failed there still reports here) — the same accepted caveat the
  // Arc path carries.
  if (changeBaseline.size > 0) {
    try {
      const changeEvents: LogEventInput[] = [];
      for (const [assetId, baseline] of changeBaseline) {
        const asset = assetIdx.findById(assetId);
        if (!asset) continue;
        const ctx = {
          assetId,
          assetName: baseline.name,
          actor: actor || "system:discovery",
          source: "fortigate-endpoint",
          integrationId,
          integrationName,
        };
        if ("os" in baseline || "osVersion" in baseline) {
          const before: Record<string, unknown> = {};
          const after: Record<string, unknown> = {};
          if ("os" in baseline) { before.os = baseline.os; after.os = asset.os ?? null; }
          if ("osVersion" in baseline) { before.osVersion = baseline.osVersion; after.osVersion = asset.osVersion ?? null; }
          const ev = buildFirmwareChangedEvent(ctx, before, after);
          if (ev) changeEvents.push(ev);
        }
        if ("lastSeenSwitch" in baseline) {
          const ev = buildConnectionChangedEvent("switch", ctx, baseline.lastSeenSwitch as string | null, asset.lastSeenSwitch ?? null);
          if (ev) changeEvents.push(ev);
        }
        if ("lastSeenAp" in baseline) {
          const ev = buildConnectionChangedEvent("ap", ctx, baseline.lastSeenAp as string | null, asset.lastSeenAp ?? null);
          if (ev) changeEvents.push(ev);
        }
      }
      if (changeEvents.length > 0) await logEventsBatch(changeEvents);
    } catch (err: any) {
      // Audit rows must never fail the sync.
      logger.warn({ integrationId, err: err?.message }, "discovery.change_events.flush_failed");
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 12 — Recompute dependency tree
  phaseMark("12");
  //
  // After every infra asset write (FortiGates, FortiSwitches, FortiAPs)
  // is on disk and the projection apply has reconciled multi-source
  // fields, rebuild this integration's parent→child DAG from the latest
  // fortinetTopology + interface-topology + LLDP signals. Drives the
  // dependency-suppression reconciler — see dependencyTreeService.
  //
  // Gated on mode in {full, finalize} — per-device skip-deprecation passes
  // see only a partial slice of the fleet, so a recompute run there would
  // race with sibling per-device passes and write churn. The finalize
  // pass owns the recompute.
  //
  // Best-effort. Failures are logged but never block the sync return.
  if (mode === "full" || mode === "finalize") {
    try {
      const dep = await recomputeDependencyTree(integrationId);
      if (dep.scoped > 0) {
        syncLog("info", `Dependency tree: ${dep.edgesWritten} edge(s) across ${dep.scoped} asset(s)${dep.unresolved > 0 ? `, ${dep.unresolved} unresolved` : ""}${dep.endpointEdges > 0 ? `; ${dep.endpointEdges} endpoint edge(s)` : ""}`);
      }
    } catch (err: any) {
      syncLog("error", `Dependency tree recompute failed: ${err?.message || "Unknown error"}`);
    }

    phaseMark("13");
    // Phase 13 — Re-evaluate map-region tags. Any firewall whose lat/lng now
    // falls inside an operator-drawn region (or any FortiSwitch / FortiAP whose
    // controllerFortigate matches one, or any subnet one of those firewalls
    // serves) gets its `region:<name>` tag stamped — and a target that has
    // MOVED out since we tagged it has the tag stripped, bounded by the
    // RegionTagAssignment provenance rows so hand-applied tags survive. Running
    // here is what makes a device re-pinned or re-parented by THIS discovery
    // run land in the right region without waiting for the 6-hour tick; the
    // cost is that a transiently-absent gate pin churns its subtree's tags for
    // one pass. Best-effort, gated to mode in {full, finalize} mirroring
    // Phase 12.
    try {
      const summary = await reconcileMapRegions();
      if (summary.assetsTouched > 0 || summary.subnetsTouched > 0) {
        syncLog(
          "info",
          `Map region tags: +${summary.added}/-${summary.removed} on ${summary.assetsTouched} asset(s), ` +
            `+${summary.subnetsAdded}/-${summary.subnetsRemoved} on ${summary.subnetsTouched} network(s)`,
        );
      }
    } catch (err: any) {
      syncLog("error", `Map region reconcile failed: ${err?.message || "Unknown error"}`);
    }

    phaseMark("13.65");
    // Phase 13.65 — Reconcile criteria-based auto-assigned tags. Newly
    // discovered / changed assets that now match (or no longer match) an
    // operator-defined tag criteria get the tag added / removed (managed sync,
    // engine-owned copies only). Best-effort. See src/services/tagAssignmentService.ts.
    try {
      const summary = await reconcileAllTags();
      if (summary.added > 0 || summary.removed > 0) {
        syncLog("info", `Criteria tags: +${summary.added} / -${summary.removed}`);
      }
    } catch (err: any) {
      syncLog("error", `Tag-assignment reconcile failed: ${err?.message || "Unknown error"}`);
    }

    phaseMark("13.6");
    // Phase 13.6 — Read management-access (`allowaccess`) config for Fortinet
    // devices and stamp Asset.managementAccess. Firewall: the operator-named
    // management interface's allowaccess. FortiAP: the AP's wtp-profile
    // allowaccess. FortiSwitch: the switch's internal/custom interface (best
    // effort — see fortinetManagementAccessService). Drives the slide-over's
    // Open HTTPS / Open SSH buttons + the FortiAP "SNMP not enabled" warning.
    // Read-only; never writes the device. FMG/FortiGate only. Best-effort —
    // failures are logged and never block the sync. Gated to {full, finalize}
    // so it runs once with the full fleet known (like Phases 12/13).
    if (isFortinetIntegrationType(integrationType)) {
      try {
        const integrationRow = await prisma.integration.findUnique({
          where: { id: integrationId },
          select: { id: true, type: true, config: true },
        });
        if (integrationRow) {
          const cfg = (integrationRow.config ?? {}) as Record<string, any>;
          const groupMap = new Map<string, DeviceAccessGroup>();
          const ensureGroup = (name: string): DeviceAccessGroup => {
            let g = groupMap.get(name);
            if (!g) { g = { deviceName: name, firewall: null, switches: [], aps: [] }; groupMap.set(name, g); }
            return g;
          };
          for (const dev of result.devices) {
            if (dev?.name && dev?.serial) ensureGroup(dev.name).firewall = { serial: dev.serial, mgmtIp: dev.mgmtIp || null };
          }
          for (const sw of result.fortiSwitches || []) {
            if (sw?.device && sw?.serial) ensureGroup(sw.device).switches.push({ serial: sw.serial, ipAddress: sw.ipAddress || null });
          }
          for (const ap of result.fortiAps || []) {
            if (ap?.device && ap?.serial) ensureGroup(ap.device).aps.push({ serial: ap.serial, ipAddress: ap.ipAddress || null });
          }

          if (groupMap.size > 0) {
            const summaries = await collectManagementAccess(integrationRow, [...groupMap.values()], {
              mgmtInterface: typeof cfg.mgmtInterface === "string" ? cfg.mgmtInterface : null,
              switchManagementInterface: typeof cfg.switchManagementInterface === "string" ? cfg.switchManagementInterface : null,
            });
            if (summaries.size > 0) {
              // Map device serial → assetId via the AssetSource rows discovery
              // just wrote (externalId === serial for these sourceKinds), then
              // batch the Asset.managementAccess writes in chunked transactions
              // (no per-row awaits — bounded at the 2000-asset end of the range).
              const sources = await prisma.assetSource.findMany({
                where: {
                  integrationId,
                  sourceKind: { in: ["fortigate-firewall", "fortiswitch", "fortiap"] },
                  externalId: { in: [...summaries.keys()] },
                },
                select: { assetId: true, externalId: true },
              });
              const seen = new Set<string>();
              const updates: Array<ReturnType<typeof prisma.asset.update>> = [];
              for (const src of sources) {
                const summary = summaries.get(src.externalId);
                if (!summary || seen.has(src.assetId)) continue;
                seen.add(src.assetId);
                updates.push(prisma.asset.update({ where: { id: src.assetId }, data: { managementAccess: summary as any } }));
              }
              for (const chunk of chunkArray(updates, 200)) {
                await prisma.$transaction(chunk);
              }
              if (updates.length > 0) syncLog("info", `Management-access: read allowaccess for ${updates.length} device(s)`);
            }
          }
        }
      } catch (err: any) {
        syncLog("error", `Management-access read failed: ${err?.message || "Unknown error"}`);
      }
    }

    phaseMark("13.7");
    // Phase 13.7 — Description sync reconcile (Polaris-primary; gated by the
    // integration's `syncDescriptions` toggle, default off = zero cost). Per
    // FortiGate: read the current device-side descriptions (system/interface,
    // system/global, managed-switch, wtp — through the shared push transport,
    // so both useProxy modes work), adopt device values where Polaris has
    // none, and re-push wherever the device drifted from a non-empty Polaris
    // value. Also the retry path for save-time pushes that failed
    // transiently. Best-effort — failures are logged and never block the sync.
    if (isFortinetIntegrationType(integrationType)) {
      try {
        const integrationRow = await prisma.integration.findUnique({
          where: { id: integrationId },
          select: { id: true, type: true, config: true, name: true },
        });
        if (integrationRow && (integrationRow.config as Record<string, any> | null)?.syncDescriptions === true) {
          const summary = await runDescriptionSyncForIntegration(integrationRow);
          if (summary.pushed || summary.adopted || summary.failed || summary.skippedDevices || summary.fmgMirrored || summary.fmgMirrorFailed) {
            syncLog("info", `Description sync: pushed ${summary.pushed}, adopted ${summary.adopted}, failed ${summary.failed}${summary.fmgMirrored || summary.fmgMirrorFailed ? `, FMG mirror ${summary.fmgMirrored} ok / ${summary.fmgMirrorFailed} failed` : ""}${summary.skippedDevices ? `, ${summary.skippedDevices} device(s) skipped` : ""}`);
          }
        }
      } catch (err: any) {
        syncLog("error", `Description sync failed: ${err?.message || "Unknown error"}`);
      }
    }
  }

  // Close out the final phase's elapsed-time log line before returning.
  phaseMark("__end__");
  return { created, updated, skipped, deprecated, assets: assetNames, reservations: reservationNames, vips: vipNames.length, dhcpLeases: dhcpLeases.length, dhcpReservations: dhcpReservations.length, inventoryDevices: inventoryAssets.length, dnsResolved, ouiResolved, ouiOverridden, decommissionedSwitches, decommissionedAps, endpointSourcesStamped, projectionCorrected };
}

// ─── Entra ID asset sync ─────────────────────────────────────────────────────

// Shared with conflict resolution, which parses these tags back — see
// src/utils/assetSourceTags.ts (imported at the top of this file).

// Strip every non-hex character and uppercase, so "00:1A:2B:3C:4D:5E",
// "001A2B-3C4D5E", "00-1A-2B-3C-4D-5E" all collapse to the same key. Used
// only for cross-asset MAC matching during discovery; storage convention
// elsewhere keeps colon-separated uppercase form. Delegates to the shared
// util, which also rejects the all-zero MAC so two unrelated devices
// reporting 00:00:00:00:00:00 can't collide into one match key.
function normalizeMacKey(mac: string | null | undefined): string {
  return macHexKeyOrNull(mac) ?? "";
}

// NetBIOS / pre-Windows-2000 computer-name limit. AD's `cn` is often the
// truncated form when the device's full name exceeds 15 chars, while Entra's
// displayName carries the full name. We index both forms so a hostname
// collision check finds the match regardless of which side was truncated.
const NETBIOS_LIMIT = 15;

// Index a hostname under its full lowercase form, plus its 15-char prefix
// when the full form is longer (so a future shorter lookup can still find it).
function indexHostname(map: Map<string, any>, hostname: string, asset: any): void {
  const lower = hostname.toLowerCase();
  if (!map.has(lower)) map.set(lower, asset);
  if (lower.length > NETBIOS_LIMIT) {
    const truncated = lower.slice(0, NETBIOS_LIMIT);
    if (!map.has(truncated)) map.set(truncated, asset);
  }
}

// Look up `hostname` in a map populated via indexHostname. Returns the matched
// asset and how the match was made: "exact" (full hostnames are equal) or
// "netbios" (matched only after truncating one side to 15 chars).
function lookupHostname(map: Map<string, any>, hostname: string): { asset: any; via: "exact" | "netbios" } | null {
  const lower = hostname.toLowerCase();
  const direct = map.get(lower);
  if (direct) {
    const storedLower = (direct.hostname || "").toLowerCase();
    return { asset: direct, via: storedLower === lower ? "exact" : "netbios" };
  }
  if (lower.length >= NETBIOS_LIMIT) {
    const truncated = map.get(lower.slice(0, NETBIOS_LIMIT));
    if (truncated) return { asset: truncated, via: "netbios" };
  }
  return null;
}

// Write (or update-to-accepted) a tombstone Conflict so upsertAssetConflict's
// "already resolved" guard fires on subsequent runs and never re-queues the pair.
async function tombstoneConflict(proposedDeviceId: string, assetId: string, integrationId: string): Promise<void> {
  const row = await prisma.conflict.findFirst({
    where: { entityType: "asset", proposedDeviceId, assetId },
  });
  if (row) {
    if (row.status === "pending") {
      await prisma.conflict.update({
        where: { id: row.id },
        data: { status: "accepted", resolvedBy: "system", resolvedAt: new Date() },
      });
    }
    // already accepted/rejected — leave as-is
  } else {
    await prisma.conflict.create({
      data: {
        entityType: "asset",
        assetId,
        integrationId,
        proposedDeviceId,
        proposedAssetFields: {} as any,
        conflictFields: ["hostname"],
        status: "accepted",
        resolvedBy: "system",
        resolvedAt: new Date(),
      },
    });
  }
}

// Snapshot of the existing collision-target asset's displayed fields, frozen
// onto the Conflict at raise time so the resolved card reflects conflict-time
// state instead of the post-merge live row. Mirrors the fields the conflict
// card renders for the existing column (see renderAssetConflictCard).
function snapshotExistingAsset(asset: any): Record<string, any> {
  return {
    hostname: asset.hostname ?? null,
    serialNumber: asset.serialNumber ?? null,
    macAddress: asset.macAddress ?? null,
    ipAddress: asset.ipAddress ?? null,
    manufacturer: asset.manufacturer ?? null,
    model: asset.model ?? null,
    os: asset.os ?? null,
    osVersion: asset.osVersion ?? null,
    assignedTo: asset.assignedTo ?? null,
  };
}

// Upsert a pending hostname-collision conflict, deduped on proposedDeviceId.
async function upsertAssetConflict(args: {
  collisionAssetId: string;
  integrationId: string;
  proposedDeviceId: string;
  proposedAssetFields: Record<string, any>;
  existingAsset: any;
}): Promise<void> {
  // Don't re-raise a conflict the admin already resolved for this exact
  // (proposedDeviceId, assetId) pair — the decision stands until the
  // operator manually reopens it.
  const resolved = await prisma.conflict.findFirst({
    where: {
      entityType: "asset",
      proposedDeviceId: args.proposedDeviceId,
      assetId: args.collisionAssetId,
      status: { in: ["accepted", "rejected"] },
    },
  });
  if (resolved) return;

  const existingSnapshot = snapshotExistingAsset(args.existingAsset);
  const existing = await prisma.conflict.findFirst({
    where: { entityType: "asset", status: "pending", proposedDeviceId: args.proposedDeviceId },
  });
  if (existing) {
    await prisma.conflict.update({
      where: { id: existing.id },
      data: {
        proposedAssetFields: args.proposedAssetFields as any,
        assetId: args.collisionAssetId,
        existingAssetSnapshot: existingSnapshot as any,
      },
    });
  } else {
    await prisma.conflict.create({
      data: {
        entityType: "asset",
        assetId: args.collisionAssetId,
        integrationId: args.integrationId,
        proposedDeviceId: args.proposedDeviceId,
        proposedAssetFields: args.proposedAssetFields as any,
        existingAssetSnapshot: existingSnapshot as any,
        conflictFields: ["hostname"],
        status: "pending",
      },
    });
  }
}

function sidTag(sid: string): string {
  return `${SID_TAG_PREFIX}${sid.toUpperCase()}`;
}

// Reject SIDs that aren't useful as a cross-integration identity key:
// empty, the null SID ("S-1-0-0"), or anything that doesn't look like a SID.
// The hybrid-join cross-link only works when the SID actually pins one
// device — placeholder SIDs would just collide every dead account.
function isMeaningfulSid(sid: string | undefined | null): boolean {
  if (!sid) return false;
  const s = sid.trim().toUpperCase();
  if (!s.startsWith("S-")) return false;
  if (s === "S-1-0-0") return false;
  return true;
}

// Tags the Entra discovery auto-assigns each run (so we strip them on update
// before re-adding the fresh set). Cross-integration identity tags (sid:*,
// ad-guid:*) are NOT in this list — they must be preserved.
function isEntraManagedTag(t: string): boolean {
  if (t.startsWith("prev-entra:")) return false; // breadcrumb — preserve forever
  if (t.startsWith("entra")) return true;
  if (t.startsWith("intune-")) return true;
  return ["auto-discovered", "compliant", "noncompliant", "azuread", "workplace", "serverad"].includes(t);
}

function inferAssetTypeFromChassis(
  chassisType: string | undefined,
  operatingSystem: string | undefined,
): string {
  const chassis = (chassisType || "").toLowerCase();
  if (["desktop", "laptop", "convertible", "detachable"].includes(chassis)) return "workstation";
  if (["tablet", "phone"].includes(chassis)) return "other";

  // Fall back to OS inference (Entra-only devices have no chassisType).
  // Intune doesn't report servers in practice, but a future change could.
  //
  // The chassis pre-checks and the workstation default stay hardcoded rather
  // than becoming rules: they state what Entra and Intune ENUMERATE (endpoint
  // management inventories, not server estates), which is not a guess an
  // operator would want to retune. Only the OS half is rule-driven — so a
  // custom type can claim one of these devices while the "unrecognized Entra
  // record is an endpoint" default still holds behind it.
  const inferred = inferAssetTypeFromOs(operatingSystem);
  return inferred !== "other" ? inferred : "workstation";
}

// Build the source-shaped observed blob for the "entra" AssetSource row.
// Only the entra-side fields land here — intune-overridden values stay in
// the separate "intune" source row so admins can see what each Graph
// endpoint independently said. `entraDisplayName` is the original entra
// displayName (vs the merged `displayName` which intune may have overridden).
function buildEntraObservedBlob(
  dev: entraId.DiscoveredEntraDevice,
  syncedAt: Date,
): Record<string, unknown> {
  return {
    kind: "entra",
    syncedAt: syncedAt.toISOString(),
    deviceId: dev.deviceId.toLowerCase(),
    displayName: dev.entraDisplayName ?? null,
    operatingSystem: dev.operatingSystem || null,
    operatingSystemVersion: dev.operatingSystemVersion || null,
    trustType: dev.trustType || null,
    accountEnabled: !!dev.accountEnabled,
    isCompliant: typeof dev.isCompliant === "boolean" ? dev.isCompliant : null,
    isManaged: typeof dev.isManaged === "boolean" ? dev.isManaged : null,
    registrationDateTime: dev.registrationDateTime || null,
    approximateLastSignInDateTime: dev.approximateLastSignInDateTime || null,
    onPremisesSecurityIdentifier: dev.onPremisesSecurityIdentifier || null,
  };
}

// Build the source-shaped observed blob for the "intune" AssetSource row.
// Hardware identity (serial / MACs / manufacturer / model), assigned user,
// chassis form factor, and compliance state — fields Entra alone doesn't
// expose. Lives separately from the "entra" row so a tenant where Intune
// permission was added later still sees the entra row with its own history.
function buildIntuneObservedBlob(
  dev: entraId.DiscoveredEntraDevice,
  syncedAt: Date,
): Record<string, unknown> {
  return {
    kind: "intune",
    syncedAt: syncedAt.toISOString(),
    azureADDeviceId: dev.deviceId.toLowerCase(),
    deviceName: dev.intuneDeviceName ?? null,
    operatingSystem: dev.operatingSystem || null,
    osVersion: dev.operatingSystemVersion || null,
    serialNumber: dev.serialNumber || null,
    manufacturer: dev.manufacturer || null,
    model: dev.model || null,
    ethernetMacAddress: dev.ethernetMacAddress || null,
    wiFiMacAddress: dev.wifiMacAddress || null,
    userPrincipalName: dev.userPrincipalName || null,
    chassisType: dev.chassisType || null,
    complianceState: dev.complianceState || null,
    lastSyncDateTime: dev.lastSyncDateTime || null,
  };
}

/** One AssetSource row as the Entra sync's in-memory mirror carries it — the
 *  projection input shape plus `externalId`, the row's global identity. */
interface EntraSourceEntry {
  sourceKind: string;
  externalId: string;
  inferred: boolean;
  observed: Record<string, unknown> | null;
  lastSeen: Date | null;
}

/** Which of upsertEntraIntuneSources' cleanup deletes can actually match a
 *  row, per the sync's preloaded source map. Every flag was an unconditional
 *  deleteMany — one to three no-op round trips per device per cycle on a
 *  fleet where deviceIds essentially never change. */
interface EntraSourceSweepHints {
  staleExternalId: boolean;
  entraAtCurrent: boolean;
  intuneAtCurrent: boolean;
}

// Upsert the entra and/or intune AssetSource rows for a discovered device.
// `dev.sources` drives which rows are written — both for the common hybrid
// case, just one for entra-only or intune-only devices. After upsert,
// removes any stale entra/intune source rows on the same Asset whose
// externalId differs from this device's deviceId (covers the
// "duplicate-Entra-registration: incoming wins" auto-resolve path, where
// the asset adopts a new deviceId and the old source rows would otherwise
// orphan-link the prior identity). `sweepHints` (when the caller's source map
// can prove a delete has nothing to match) skips the no-op deletes; absent
// hints preserve the unconditional behavior.
async function upsertEntraIntuneSources(
  assetId: string,
  integrationId: string,
  dev: entraId.DiscoveredEntraDevice,
  syncedAt: Date,
  lastSeen: Date,
  sweepHints?: EntraSourceSweepHints,
): Promise<void> {
  const externalId = dev.deviceId.toLowerCase();
  const wantsEntra = dev.sources?.includes("entra") ?? false;
  const wantsIntune = dev.sources?.includes("intune") ?? false;

  if (wantsEntra) {
    const observed = buildEntraObservedBlob(dev, syncedAt);
    await prisma.assetSource.upsert({
      where: { sourceKind_externalId: { sourceKind: "entra", externalId } },
      create: { assetId, sourceKind: "entra", externalId, integrationId, observed: observed as any, inferred: false, syncedAt, firstSeen: lastSeen, lastSeen },
      update: { assetId, integrationId, observed: observed as any, inferred: false, syncedAt, lastSeen },
    });
  }
  if (wantsIntune) {
    const observed = buildIntuneObservedBlob(dev, syncedAt);
    await prisma.assetSource.upsert({
      where: { sourceKind_externalId: { sourceKind: "intune", externalId } },
      create: { assetId, sourceKind: "intune", externalId, integrationId, observed: observed as any, inferred: false, syncedAt, firstSeen: lastSeen, lastSeen },
      update: { assetId, integrationId, observed: observed as any, inferred: false, syncedAt, lastSeen },
    });
  }

  // Sweep stale source rows for entra/intune kinds whose externalId no
  // longer matches this device's deviceId. Prevents orphan rows from a
  // prior deviceId silently re-linking a future discovery to the wrong
  // asset.
  if (sweepHints?.staleExternalId !== false) {
    await prisma.assetSource.deleteMany({
      where: {
        assetId,
        sourceKind: { in: ["entra", "intune"] },
        externalId: { not: externalId },
      },
    });
  }

  // Phase 3b.1 cutover: drift detection no longer fires on Entra/Intune
  // writes — the syncEntraDevices caller projects from sources and uses
  // the result as the Asset write payload, so the Asset row matches the
  // projection by construction.

  // Belt-and-suspenders: if Entra didn't actually contribute to this device
  // (Intune-only) but a phase-1-backfilled entra source row exists with the
  // current deviceId — created because the legacy assetTag namespace lumped
  // Intune-only devices under "entra:..." — drop it. sourceKind="entra"
  // should mean "registered in Entra ID," and an Intune-only device isn't.
  // Same rule in reverse for intune: if the device isn't intune-managed and
  // a stale intune source exists at the current deviceId, drop it.
  if (!wantsEntra && sweepHints?.entraAtCurrent !== false) {
    await prisma.assetSource.deleteMany({
      where: { assetId, sourceKind: "entra", externalId },
    });
  }
  if (!wantsIntune && sweepHints?.intuneAtCurrent !== false) {
    await prisma.assetSource.deleteMany({
      where: { assetId, sourceKind: "intune", externalId },
    });
  }
}

// Build the Entra sync's lookup index from AssetSource rows. Replaces the
// legacy in-memory scan over Asset.assetTag / Asset.tags for "entra:" /
// "sid:" markers. AD source rows are joined in so the SID hybrid-cross-link
// resolves both ways (entra.observed.onPremisesSecurityIdentifier and
// ad.observed.objectSid both populate assetIdBySid).
async function buildEntraSyncIndex(
  allAssets: { id: string; hostname: string | null }[],
): Promise<{
  assetByEntraDeviceId: Map<string, any>;
  assetIdBySid: Map<string, string>;
  assetIdsWithEntraSource: Set<string>;
  assetIdsWithAdSource: Set<string>;
  assetById: Map<string, any>;
  /**
   * Reverse map: asset id → its current entra/intune source's externalId.
   * Used by the duplicate-Entra-resolution path when it needs to name the
   * "loser" Entra deviceId in audit logs and tombstone-conflict
   * lookups, replacing the legacy `assetTag.slice(ENTRA_PREFIX.length)`
   * pattern after Phase 4d cut the assetTag write path.
   */
  entraDeviceIdByAssetId: Map<string, string>;
  /**
   * Asset id → freshest directory-activity timestamp (epoch ms) across the
   * asset's entra/intune source rows (AssetSource.lastSeen carries the
   * Graph-reported lastSyncDateTime/approximateLastSignInDateTime). The
   * duplicate-registration auto-resolve compares directory activity against
   * directory activity — Asset.lastSeen is verified network presence now
   * and no longer the right operand.
   */
  directoryActivityByAssetId: Map<string, number>;
  /**
   * Asset id → EVERY source row on it (all kinds, not just directory kinds) —
   * the projection input. The sync keeps this map in step with its own writes
   * (applyEntraSourcesInMemory) so projecting an asset costs no re-read; the
   * per-device `assetSource.findMany({ where: { assetId } })` it replaces was
   * one round trip per device (the syncArcDevices docblock names exactly this).
   */
  sourcesByAssetId: Map<string, EntraSourceEntry[]>;
  /** "kind|externalId" → owning asset id, for entra/intune rows only — the
   *  row's global identity, so the in-memory mirror can move a row between
   *  assets the way the DB upsert's `update.assetId` does. */
  sourceOwnerByKey: Map<string, string>;
}> {
  const assetById = new Map<string, any>();
  for (const a of allAssets) assetById.set(a.id, a);

  // ALL kinds, tight select: entra/intune/ad feed the identity indexes below,
  // and every kind feeds sourcesByAssetId (projection reads the full set —
  // a hybrid device projects from its ad + agent + fortigate rows too).
  const sources = await prisma.assetSource.findMany({
    select: { assetId: true, sourceKind: true, externalId: true, inferred: true, observed: true, lastSeen: true },
  });

  const assetByEntraDeviceId = new Map<string, any>();
  const assetIdBySid = new Map<string, string>();
  const assetIdsWithEntraSource = new Set<string>();
  const assetIdsWithAdSource = new Set<string>();
  const entraDeviceIdByAssetId = new Map<string, string>();
  const directoryActivityByAssetId = new Map<string, number>();
  const sourcesByAssetId = new Map<string, EntraSourceEntry[]>();
  const sourceOwnerByKey = new Map<string, string>();

  for (const src of sources) {
    const obs = (src.observed as Record<string, unknown> | null) || {};
    const entry: EntraSourceEntry = { sourceKind: src.sourceKind, externalId: src.externalId, inferred: src.inferred, observed: obs, lastSeen: src.lastSeen };
    const list = sourcesByAssetId.get(src.assetId);
    if (list) list.push(entry); else sourcesByAssetId.set(src.assetId, [entry]);
    if (src.sourceKind === "entra" || src.sourceKind === "intune") {
      sourceOwnerByKey.set(`${src.sourceKind}|${src.externalId.toLowerCase()}`, src.assetId);
      assetIdsWithEntraSource.add(src.assetId);
      const a = assetById.get(src.assetId);
      if (a) assetByEntraDeviceId.set(src.externalId.toLowerCase(), a);
      // First-seen wins on duplicates; entra and intune share the
      // externalId namespace so we don't double-stamp.
      if (!entraDeviceIdByAssetId.has(src.assetId)) {
        entraDeviceIdByAssetId.set(src.assetId, src.externalId.toLowerCase());
      }
      const seenMs = src.lastSeen?.getTime();
      if (seenMs && seenMs > (directoryActivityByAssetId.get(src.assetId) ?? 0)) {
        directoryActivityByAssetId.set(src.assetId, seenMs);
      }
      const sid =
        typeof obs.onPremisesSecurityIdentifier === "string"
          ? obs.onPremisesSecurityIdentifier.toUpperCase()
          : null;
      if (sid) assetIdBySid.set(sid, src.assetId);
    } else if (src.sourceKind === "ad") {
      assetIdsWithAdSource.add(src.assetId);
      const sid = typeof obs.objectSid === "string" ? obs.objectSid.toUpperCase() : null;
      if (sid) assetIdBySid.set(sid, src.assetId);
    }
  }

  return { assetByEntraDeviceId, assetIdBySid, assetIdsWithEntraSource, assetIdsWithAdSource, assetById, entraDeviceIdByAssetId, directoryActivityByAssetId, sourcesByAssetId, sourceOwnerByKey };
}

/**
 * Sync Arc-enabled Kubernetes clusters into assets (Phase 4).
 *
 * Clusters are the ONE Arc entity that isn't detail on a machine, so unlike
 * the VMware/SCVMM and SQL enrichment this creates real assets — typed
 * `kubernetes_cluster`, a built-in added by migration 20260807020000.
 *
 * Much simpler than syncArcDevices: a cluster has no SMBIOS UUID, no MAC and
 * no guest OS, so the cascade is just arc-k8s AssetSource by ARM id → hostname
 * collision → create. There is no Conflict path on hostname either — a cluster
 * name colliding with an existing asset is far more likely to be a genuine
 * distinct thing than the same device seen twice, so it takes over only when
 * the existing asset is already a cluster.
 */
async function syncArcClusters(
  integrationId: string,
  integrationName: string,
  integrationConfig: Record<string, unknown> | null,
  clusters: azureArc.DiscoveredArcCluster[],
  actor?: string,
): Promise<{ created: string[]; updated: string[]; skipped: string[] }> {
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  if (clusters.length === 0) return { created, updated, skipped };

  const addAs = getAddAsMonitoredFromConfig("azurearc", integrationConfig, "kubernetes_cluster");
  const syncLog = (level: "info" | "error" | "warning", message: string) => {
    logEvent({ action: "integration.sync", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level, message: `[${integrationName}] ${message}` });
  };
  const now = new Date();

  const sourceRows = await prisma.assetSource.findMany({
    where: { sourceKind: "arc-k8s" },
    select: { assetId: true, externalId: true },
  });
  const assetIdByArmId = new Map(sourceRows.map((r) => [r.externalId.toLowerCase(), r.assetId]));
  const knownClusterAssetIds = new Set(sourceRows.map((r) => r.assetId));

  const existingAssets = await prisma.asset.findMany({
    where: { id: { in: [...knownClusterAssetIds] } },
    select: {
      id: true, hostname: true, assetType: true, status: true, monitored: true,
      monitorOverride: true, tags: true, lastSeen: true, acquiredAt: true,
      discoveredByIntegrationId: true,
    },
  });
  const assetById = new Map(existingAssets.map((a: any) => [a.id, a]));

  for (const c of clusters) {
    const label = c.name || c.armId;
    const connected = (c.connectivityStatus || "").toLowerCase() === "connected";
    const tags = ["azurearc", "arc-kubernetes", "auto-discovered"];
    if (c.distribution) tags.push(`arc-k8s-${c.distribution.toLowerCase()}`);

    const observed = azureArc.buildArcClusterObservedBlob(c, now);
    const { projected } = projectAssetFromSources([
      { sourceKind: "arc-k8s", inferred: false, observed: observed as Record<string, unknown> },
    ]);

    const existingId = assetIdByArmId.get(c.armId);
    const existing = existingId ? assetById.get(existingId) : null;

    try {
      if (existing) {
        const before = snapshotMaterialAssetFields(existing);
        const updateData: Record<string, unknown> = {};
        if (projected.hostname !== null) updateData.hostname = projected.hostname;
        if (projected.os !== null) updateData.os = projected.os;
        if (projected.osVersion !== null) updateData.osVersion = projected.osVersion;
        if (projected.learnedLocation !== null) updateData.learnedLocation = projected.learnedLocation;
        // Same posture as the machine path: connectivityStatus is reachability,
        // never a lifecycle state, so status is left alone entirely.
        if (existing.assetType === "other") updateData.assetType = "kubernetes_cluster";

        const ownedElsewhere =
          existing.discoveredByIntegrationId && existing.discoveredByIntegrationId !== integrationId;
        if (!ownedElsewhere) updateData.discoveredByIntegrationId = integrationId;

        if (connected) bumpLastSeen(updateData, existing, now, "arc");
        Object.assign(updateData, buildMonitoredSweep(addAs, existing));

        const preserved = ((existing.tags as string[]) || [])
          .filter((t) => t !== "azurearc" && t !== "auto-discovered" && !t.startsWith("arc-"));
        updateData.tags = [...preserved, ...tags.filter((t) => !preserved.includes(t))];

        clampAcquiredToLastSeen(updateData, existing);
        await prisma.asset.update({ where: { id: existing.id }, data: updateData as any });
        await upsertArcClusterSource(existing.id, integrationId, c, observed, now);
        logDiscoveryAssetUpdated(before, updateData, existing.id, label, {
          integrationName, integrationId, sourceKind: "arc-k8s", actor,
        });
        updated.push(label);
        continue;
      }

      const createData: Record<string, unknown> = {
        hostname: projected.hostname,
        assetType: "kubernetes_cluster",
        status: "active",
        statusChangedAt: now,
        statusChangedBy: integrationName,
        os: projected.os,
        osVersion: projected.osVersion,
        learnedLocation: projected.learnedLocation,
        discoveredByIntegrationId: integrationId,
        notes: `Auto-discovered from Azure Arc integration "${integrationName}" (connected Kubernetes cluster in ${c.resourceGroup})`,
        tags,
      };
      if (connected) bumpLastSeen(createData, null, now, "arc");
      Object.assign(createData, buildMonitoredSweep(addAs, { monitored: false, monitorOverride: false }));
      clampAcquiredToLastSeen(createData);

      const newAsset = await prisma.asset.create({ data: createData as any });
      await upsertArcClusterSource(newAsset.id, integrationId, c, observed, now);
      logDiscoveryAssetCreated(newAsset.id, label, {
        integrationName, integrationId, sourceKind: "arc-k8s", actor,
      });
      assetIdByArmId.set(c.armId, newAsset.id);
      assetById.set(newAsset.id, newAsset);
      created.push(label);
    } catch (err: any) {
      syncLog("error", `Failed to sync Arc Kubernetes cluster ${label}: ${err.message || "Unknown error"}`);
      skipped.push(`${label} (sync failed)`);
    }
  }

  return { created, updated, skipped };
}

async function upsertArcClusterSource(
  assetId: string,
  integrationId: string,
  c: azureArc.DiscoveredArcCluster,
  observed: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await prisma.assetSource.upsert({
    where: { sourceKind_externalId: { sourceKind: "arc-k8s", externalId: c.armId } },
    create: {
      assetId, sourceKind: "arc-k8s", externalId: c.armId, integrationId,
      observed: observed as any, inferred: false, syncedAt: now, firstSeen: now, lastSeen: now,
    },
    update: { assetId, integrationId, observed: observed as any, inferred: false, syncedAt: now, lastSeen: now },
  });
}

// Tags the Azure Arc discovery auto-assigns each run, so we strip them on
// update before re-adding the fresh set. Operator tags and other
// integrations' tags pass through untouched.
function isArcManagedTag(t: string): boolean {
  if (t.startsWith("arc-")) return true;
  return ["azurearc", "auto-discovered"].includes(t);
}

/**
 * Sync Arc-enabled machines into assets.
 *
 * Mirrors syncEntraDevices' contract — AssetSource upsert FIRST, then
 * projectAssetFromSources, then exactly ONE Asset.update — but is
 * deliberately leaner in two ways that matter at 2000 machines:
 *
 *   • No macAddressRows hydration. Arc reports no MACs, so the match cascade
 *     never needs them and the whole-table load stays a tight `select`.
 *   • Source rows are preloaded ONCE into sourcesByAssetId instead of a
 *     per-device `assetSource.findMany({ where: { assetId } })` inside the
 *     loop (one round trip per machine — the Entra sync did this until
 *     2026-09, when it adopted the same preload via its in-memory mirror),
 *     and writes are flushed in chunked $transactions rather than one update
 *     per machine.
 *
 * Match cascade: arc AssetSource by ARM resource id → vmUuid (both endian
 * variants — see swapVmUuidEndianness) → hostname (FQDN then short, NetBIOS-
 * truncation tolerant) → Conflict → create.
 */
async function syncArcDevices(
  integrationId: string,
  integrationName: string,
  integrationConfig: Record<string, unknown> | null,
  result: { machines: azureArc.DiscoveredArcMachine[] },
  actor?: string,
): Promise<{ created: string[]; updated: string[]; skipped: string[] }> {
  const workstationAddAs = getAddAsMonitoredFromConfig("azurearc", integrationConfig, "workstation");
  const serverAddAs      = getAddAsMonitoredFromConfig("azurearc", integrationConfig, "server");
  const resolveAddAs = (assetType: string): boolean | null =>
    assetType === "workstation" ? workstationAddAs
    : assetType === "server"    ? serverAddAs
    : null;
  const syncLog = (level: "info" | "error" | "warning", message: string) => {
    logEvent({ action: "integration.sync", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level, message: `[${integrationName}] ${message}` });
  };
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const now = new Date();

  // ── Preload: two queries for the whole fleet ─────────────────────────────
  const allAssets = await prisma.asset.findMany({
    select: {
      id: true, hostname: true, hostnameOverride: true, assetType: true, status: true,
      monitored: true, monitorOverride: true, acquiredAt: true, lastSeen: true,
      tags: true, discoveredByIntegrationId: true, dnsName: true, ipAddress: true,
      os: true, osVersion: true, serialNumber: true, manufacturer: true, model: true,
      learnedLocation: true, notes: true, assignedTo: true, macAddress: true,
    },
  });
  const allSources = await prisma.assetSource.findMany({
    select: { assetId: true, sourceKind: true, externalId: true, inferred: true, observed: true, lastSeen: true },
  });

  const assetById = new Map<string, any>(allAssets.map((a: any) => [a.id, a]));
  const sourcesByAssetId = new Map<string, { sourceKind: string; inferred: boolean; observed: Record<string, unknown> | null; lastSeen: Date | null }[]>();
  const assetByArmId = new Map<string, any>();
  const assetIdsWithArcSource = new Set<string>();
  // vmUuid → asset. Populated from existing arc rows AND from vCenter VM rows
  // (instanceUuid / biosUuid), each under BOTH endian variants — that pair is
  // what merges an Arc machine onto its already-discovered vCenter VM instead
  // of minting a duplicate.
  const assetByVmUuid = new Map<string, any>();
  const indexVmUuid = (raw: unknown, asset: any) => {
    const u = azureArc.normalizeVmUuid(raw);
    if (!u) return;
    if (!assetByVmUuid.has(u)) assetByVmUuid.set(u, asset);
    const swapped = azureArc.swapVmUuidEndianness(u);
    if (swapped && !assetByVmUuid.has(swapped)) assetByVmUuid.set(swapped, asset);
  };

  // SMBIOS serials reported by the POLARIS AGENT — the bridge that lets an
  // Arc machine merge onto an asset some other integration discovered.
  //
  // AD carries no hardware identity whatsoever and Arc carries no MAC, so an
  // AD-discovered server and an Arc machine share nothing definitive. The
  // agent runs ON the host, reads the same SMBIOS serial Arc reports, and
  // stamps it on whatever asset it was installed on — so matching Arc's
  // serial against the agent's ties the two together.
  //
  // Only `polaris-agent` seeds this. Intune also reports a serial, but it's
  // an enrollment-time inventory value that can be stale or belong to a
  // replaced chassis; the agent's is read from the running host.
  const serialCandidates: { key: string | null; value: any; id: string }[] = [];

  for (const row of allSources) {
    const list = sourcesByAssetId.get(row.assetId);
    const entry = { sourceKind: row.sourceKind, inferred: row.inferred, observed: row.observed as Record<string, unknown> | null, lastSeen: row.lastSeen };
    if (list) list.push(entry); else sourcesByAssetId.set(row.assetId, [entry]);

    const asset = assetById.get(row.assetId);
    if (!asset) continue;
    const obs = (row.observed || {}) as Record<string, unknown>;
    if (row.sourceKind === "polaris-agent") {
      serialCandidates.push({
        key: normalizeHardwareSerial(obs.serialNumber),
        value: asset,
        id: asset.id,
      });
    }
    if (row.sourceKind === "arc") {
      assetIdsWithArcSource.add(row.assetId);
      assetByArmId.set(String(row.externalId).toLowerCase(), asset);
      indexVmUuid(obs.vmUuid, asset);
    } else if (row.sourceKind === "vcenter-vm") {
      indexVmUuid(obs.instanceUuid, asset);
      indexVmUuid(obs.biosUuid, asset);
    }
  }

  // Hostname collision maps, split the way the Entra sync splits them: assets
  // that already carry an arc source (a duplicate-registration signal) vs
  // everything else (an untagged collision worth a Conflict).
  const assetByHostnameNoArc = new Map<string, any>();
  const assetByHostnameArcTagged = new Map<string, any>();
  for (const a of allAssets as any[]) {
    if (!a.hostname) continue;
    if (assetIdsWithArcSource.has(a.id)) indexHostname(assetByHostnameArcTagged, a.hostname, a);
    else indexHostname(assetByHostnameNoArc, a.hostname, a);
  }

  // Uniqueness guard, not just normalization. `normalizeHardwareSerial`
  // rejects vendor placeholders, but it CANNOT reject our own agent's
  // Windows fallback: when SystemSerialNumber is empty the agent reports
  // `SystemSKU`, a MODEL sku shared by every machine of that model, and
  // that's a perfectly well-formed string. So any serial claimed by two
  // different assets is discarded — a key that's ambiguous in the data is
  // not an identity, whatever it looks like. Without this, one empty-serial
  // model line would collapse into a single asset.
  const { index: assetBySerial, ambiguous: ambiguousSerials } = indexUniqueBy(serialCandidates);
  if (ambiguousSerials.size > 0) {
    syncLog("info", `Serial match: ignoring ${ambiguousSerials.size} hardware serial(s) reported by more than one asset `
      + "(vendor placeholder or model SKU — not a usable identity)");
  }

  // ── Batched writes ───────────────────────────────────────────────────────
  // At 2000 machines a per-machine update is 2000 sequential round trips.
  // Chunked $transaction mirrors presenceVerificationService's WRITE_CHUNK.
  const WRITE_CHUNK = 200;
  const pendingSourceUpserts: any[] = [];
  const pendingAssetUpdates: { id: string; data: Record<string, unknown> }[] = [];
  const flush = async () => {
    if (pendingSourceUpserts.length > 0) {
      const batch = pendingSourceUpserts.splice(0, pendingSourceUpserts.length);
      for (let i = 0; i < batch.length; i += WRITE_CHUNK) {
        await prisma.$transaction(batch.slice(i, i + WRITE_CHUNK));
      }
    }
    if (pendingAssetUpdates.length > 0) {
      const batch = pendingAssetUpdates.splice(0, pendingAssetUpdates.length);
      for (let i = 0; i < batch.length; i += WRITE_CHUNK) {
        await prisma.$transaction(
          batch.slice(i, i + WRITE_CHUNK).map((u) => prisma.asset.update({ where: { id: u.id }, data: u.data as any })),
        );
      }
    }
  };

  const arcSourceUpsert = (assetId: string, m: azureArc.DiscoveredArcMachine, lastSeen: Date) => {
    const observed = azureArc.buildArcObservedBlob(m, now);
    return prisma.assetSource.upsert({
      where: { sourceKind_externalId: { sourceKind: "arc", externalId: m.armId } },
      create: {
        assetId, sourceKind: "arc", externalId: m.armId, integrationId,
        observed: observed as any, inferred: false, syncedAt: now, firstSeen: lastSeen, lastSeen,
      },
      update: { assetId, integrationId, observed: observed as any, inferred: false, syncedAt: now, lastSeen },
    });
  };

  for (const m of result.machines) {
    if (!m.armId) {
      skipped.push(`${m.displayName || "<unnamed>"} (missing ARM resource id)`);
      continue;
    }

    const assetType = azureArc.inferArcAssetType(m);
    const connected = azureArc.arcStatusIsConnected(m.status);
    const { fqdn, short } = azureArc.arcHostnameCandidates(m);
    const label = m.displayName || m.name || m.armId;

    // Discovery tags. Azure RESOURCE tags deliberately stay in the observed
    // blob (observed.azureTags) — mirroring an unbounded stream of cloud tags
    // into Asset.tags would fight tagAssignmentService's managed sync.
    const tags = ["azurearc", "auto-discovered"];
    if (m.status && !connected) tags.push(`arc-${m.status.toLowerCase()}`);
    if (m.cloudProvider) tags.push(`arc-${m.cloudProvider.toLowerCase()}`);
    // Phase 2/3 — only present when the operator enabled the enrichment.
    if (m.vmInstance) tags.push(`arc-${m.vmInstance.platform}`);
    if (m.sqlInstances.length > 0) tags.push("arc-sql");

    // ── Match cascade ──────────────────────────────────────────────────────
    let existing: any = assetByArmId.get(m.armId) ?? null;

    if (!existing) {
      // UUID candidates, most authoritative first. `vmInstance.instanceUuid`
      // (Phase 2) leads because it is EXACTLY the value
      // vcenterService.pickVmExternalId prefers as its externalId — an exact
      // key match rather than the SMBIOS inference the vmUuid pair relies on.
      // Each SMBIOS-derived value is tried under both endian variants.
      const uuidCandidates = [
        m.vmInstance?.instanceUuid ?? null,
        m.vmInstance?.biosGuid ?? null,
        m.vmInstance?.biosGuid ? azureArc.swapVmUuidEndianness(m.vmInstance.biosGuid) : null,
        m.vmUuid,
        m.vmUuidSwapped,
      ].filter((u): u is string => !!u);
      let byUuid: any = null;
      for (const u of uuidCandidates) {
        const hit = assetByVmUuid.get(u);
        if (hit) { byUuid = hit; break; }
      }
      if (byUuid) {
        existing = byUuid;
        // This is the join that merges an Arc machine onto its vCenter VM.
        // Always audited — a silent takeover here is indistinguishable from
        // a bug if it ever matches the wrong asset.
        syncLog("info", `vmUuid cross-link: Arc machine ${label} matched existing asset ${byUuid.hostname || byUuid.id} (taking over)`);
      }
    }

    let raisedConflict = false;
    // Serial match — the Polaris Agent bridge. Ranked BELOW vmUuid (an exact
    // key the hypervisor and Arc both mint) and ABOVE hostname (a heuristic
    // that collides and changes). A hit here is host-truth on both sides:
    // the agent read the serial off the running machine and Arc read the same
    // SMBIOS field, so this is a definitive identity, not a guess.
    if (!existing) {
      const serialKey = normalizeHardwareSerial(m.serialNumber);
      const serialHit = serialKey ? assetBySerial.get(serialKey) : null;
      // Refuse the match when the candidate ALREADY carries an Arc source: it
      // belongs to a different Arc machine (this one didn't match by ARM id,
      // or it would never have reached the serial step). Two Arc machines
      // sharing a serial means cloned hardware, not one device — attaching a
      // second arc source to the same asset would quietly fuse them. Fall
      // through to the hostname/Conflict path so a human decides.
      const bySerial = serialHit && !assetIdsWithArcSource.has(serialHit.id) ? serialHit : null;
      if (serialHit && !bySerial) {
        syncLog("warning", `Serial cross-link declined for Arc machine ${label}: asset `
          + `${serialHit.hostname || serialHit.id} already has a different Arc machine attached `
          + "(duplicate hardware serial — likely a cloned VM)");
      }
      if (bySerial) {
        existing = bySerial;
        syncLog("info", `Serial cross-link: Arc machine ${label} matched existing asset `
          + `${bySerial.hostname || bySerial.id} on hardware serial (taking over)`);
      }
    }

    if (!existing) {
      const candidates = [fqdn, short].filter((h): h is string => !!h);
      for (const cand of candidates) {
        const dupHit = lookupHostname(assetByHostnameArcTagged, cand);
        if (dupHit) {
          // Another Arc machine already owns this hostname. An ARM resource
          // id is stable for the resource's lifetime, so unlike Entra (where
          // a device genuinely re-registers under a new deviceId) this is a
          // real operator situation — raise it rather than auto-resolving.
          await upsertAssetConflict({
            collisionAssetId: dupHit.asset.id,
            integrationId,
            proposedDeviceId: m.armId,
            proposedAssetFields: buildArcProposedFields(m, assetType, "duplicate-registration", "hostname"),
            existingAsset: dupHit.asset,
          }).catch((err: any) => syncLog("warning", `Failed to raise Arc duplicate conflict for ${label}: ${err.message || "Unknown error"}`));
          skipped.push(`${label} (hostname already held by another Arc machine)`);
          raisedConflict = true;
          break;
        }
        const hit = lookupHostname(assetByHostnameNoArc, cand);
        if (hit) {
          await upsertAssetConflict({
            collisionAssetId: hit.asset.id,
            integrationId,
            proposedDeviceId: m.armId,
            proposedAssetFields: buildArcProposedFields(m, assetType, "untagged-collision", hit.via),
            existingAsset: hit.asset,
          }).catch((err: any) => syncLog("warning", `Failed to raise Arc hostname conflict for ${label}: ${err.message || "Unknown error"}`));
          skipped.push(`${label} (hostname collides with existing asset)`);
          raisedConflict = true;
          break;
        }
      }
    }
    // A conflict was raised → the operator decides; nothing more to do here.
    if (raisedConflict) continue;

    // ── Update ─────────────────────────────────────────────────────────────
    if (existing) {
      const before = snapshotMaterialAssetFields(existing);
      const updateData: Record<string, unknown> = {};

      // Source row first, then project over the (cached) full source list with
      // this run's arc blob spliced in — no re-read needed, we know exactly
      // what we just wrote.
      pendingSourceUpserts.push(arcSourceUpsert(existing.id, m, now));
      const cached = (sourcesByAssetId.get(existing.id) ?? []).filter((s) => s.sourceKind !== "arc");
      const sourceRows = [
        ...cached,
        { sourceKind: "arc", inferred: false, observed: azureArc.buildArcObservedBlob(m, now) as Record<string, unknown> },
      ];
      const { projected } = projectAssetFromSources(sourceRows);

      if (projected.hostname !== null) updateData.hostname = projected.hostname;
      if (projected.os !== null) updateData.os = projected.os;
      if (projected.osVersion !== null) updateData.osVersion = projected.osVersion;
      if (projected.serialNumber !== null) updateData.serialNumber = projected.serialNumber;
      if (projected.manufacturer !== null) updateData.manufacturer = projected.manufacturer;
      if (projected.model !== null) updateData.model = projected.model;
      if (projected.learnedLocation !== null) updateData.learnedLocation = projected.learnedLocation;
      if (projected.ipAddress !== null) updateData.ipAddress = projected.ipAddress;

      // NOTE: this sync deliberately never writes `status`. Unlike Entra's
      // accountEnabled (a lifecycle fact that maps to `decommissioned`), an
      // Arc Disconnected/Expired agent is a REACHABILITY fact — mapping it to
      // a lifecycle state would decommission a whole fleet during an
      // outbound-proxy outage. `decommissionStaleAssets` already owns
      // aging-out, and rule 16 keeps maintenance-window assets untouched.

      if (fqdn && !existing.dnsName) updateData.dnsName = fqdn;
      // Only overwrite assetType if the existing one is "other" — respect
      // manual recategorization.
      if (existing.assetType === "other" && assetType !== "other") updateData.assetType = assetType;

      // Ownership: stamp discoveredByIntegrationId unless another integration
      // already owns this asset. REQUIRED — agentAutoDeployService and both
      // auto-monitor services scope on it, so without the stamp every
      // Monitoring-tab class block silently no-ops.
      const alreadyOwnedByOtherIntegration =
        existing.discoveredByIntegrationId && existing.discoveredByIntegrationId !== integrationId;
      if (!alreadyOwnedByOtherIntegration) updateData.discoveredByIntegrationId = integrationId;

      // Presence: a Connected status read AT SCRAPE TIME is a live heartbeat.
      // The evidence timestamp is RUN TIME, never m.lastStatusChange — that
      // records when the status last CHANGED, so a machine Connected for 90
      // days carries a 90-day-old value. Deferred for monitored assets
      // (business rule 12) so the probe stays authoritative.
      if (connected) bumpLastSeen(updateData, existing, now, "arc");

      Object.assign(
        updateData,
        buildMonitoredSweep(resolveAddAs((updateData.assetType ?? existing.assetType) as string), existing),
      );

      const preserved = ((existing.tags as string[]) || []).filter((t) => !isArcManagedTag(t));
      updateData.tags = [...preserved, ...tags.filter((t) => !preserved.includes(t))];

      clampAcquiredToLastSeen(updateData, existing);
      pendingAssetUpdates.push({ id: existing.id, data: updateData });
      logDiscoveryAssetUpdated(before, updateData, existing.id, label, {
        integrationName, integrationId, sourceKind: "arc", actor,
      });
      // Keep the in-memory indexes coherent for later machines in this run.
      assetByArmId.set(m.armId, existing);
      assetIdsWithArcSource.add(existing.id);
      indexVmUuid(m.vmUuid, existing);
      indexVmUuid(m.vmInstance?.instanceUuid, existing);
      updated.push(label);

      if (pendingAssetUpdates.length >= WRITE_CHUNK) await flush();
      continue;
    }

    // ── Create ─────────────────────────────────────────────────────────────
    try {
      const synthSources = [{
        sourceKind: "arc",
        inferred: false,
        observed: azureArc.buildArcObservedBlob(m, now) as Record<string, unknown>,
      }];
      const { projected } = projectAssetFromSources(synthSources);

      const createData: Record<string, unknown> = {
        hostname: projected.hostname,
        dnsName: fqdn,
        serialNumber: projected.serialNumber,
        manufacturer: projected.manufacturer,
        model: projected.model,
        assetType: assetType === "other" ? "server" : assetType,
        status: "active",
        statusChangedAt: now,
        statusChangedBy: integrationName,
        os: projected.os,
        osVersion: projected.osVersion,
        learnedLocation: projected.learnedLocation,
        ipAddress: projected.ipAddress,
        discoveredByIntegrationId: integrationId,
        // The only discovery-authored notes content (rule 15) — stamped once,
        // at creation, and never rewritten on update.
        notes: `Auto-discovered from Azure Arc integration "${integrationName}"${m.resourceGroup ? ` (${m.resourceGroup})` : ""}`,
        tags,
      };
      if (connected) bumpLastSeen(createData, null, now, "arc");
      Object.assign(createData, buildMonitoredSweep(
        resolveAddAs(createData.assetType as string),
        { monitored: false, monitorOverride: false },
      ));
      clampAcquiredToLastSeen(createData);

      const newAsset = await prisma.asset.create({ data: createData as any });
      await arcSourceUpsert(newAsset.id, m, now);
      logDiscoveryAssetCreated(newAsset.id, label, {
        integrationName, integrationId, sourceKind: "arc", actor,
      });

      assetById.set(newAsset.id, newAsset);
      assetByArmId.set(m.armId, newAsset);
      assetIdsWithArcSource.add(newAsset.id);
      indexVmUuid(m.vmUuid, newAsset);
      indexVmUuid(m.vmInstance?.instanceUuid, newAsset);
      if (newAsset.hostname) indexHostname(assetByHostnameArcTagged, newAsset.hostname, newAsset);
      created.push(label);
    } catch (err: any) {
      syncLog("error", `Failed to create asset for Arc machine ${label}: ${err.message || "Unknown error"}`);
    }
  }

  await flush();
  return { created, updated, skipped };
}

// The proposedAssetFields blob an Arc-raised asset Conflict carries.
// `sourceType: "azurearc"` is what conflictSourceFor dispatches on, and
// `deviceId` (the ARM resource id) becomes the AssetSource externalId when
// the operator accepts or rejects.
function buildArcProposedFields(
  m: azureArc.DiscoveredArcMachine,
  assetType: string,
  collisionReason: string,
  matchedVia: string,
): Record<string, any> {
  const { fqdn, short } = azureArc.arcHostnameCandidates(m);
  return {
    sourceType: "azurearc",
    deviceId: m.armId,
    hostname: fqdn || short || m.name,
    dnsName: fqdn,
    os: m.osSku || m.osName,
    osVersion: m.osVersion,
    manufacturer: m.manufacturer,
    model: m.model,
    serialNumber: m.serialNumber,
    assetType: assetType === "other" ? "server" : assetType,
    learnedLocation: m.resourceGroup,
    resourceGroup: m.resourceGroup,
    subscriptionId: m.subscriptionId,
    vmUuid: m.vmUuid,
    arcStatus: m.status,
    collisionReason,
    matchedVia,
  };
}

// Exported for tests: the in-memory source mirror below must stay
// byte-faithful to upsertEntraIntuneSources' DB effects, and only a real
// Postgres round trip can prove that (tests/integration/entraSyncSourceMirror).
export async function syncEntraDevices(
  integrationId: string,
  integrationName: string,
  integrationConfig: Record<string, unknown> | null,
  result: { devices: entraId.DiscoveredEntraDevice[] },
  actor?: string,
): Promise<{ created: string[]; updated: string[]; skipped: string[] }> {
  // Per-class addAsMonitored snapshot for the auto-monitor sweep. null = the
  // class block isn't enabled / present, in which case buildMonitoredSweep
  // returns {} and discovery leaves monitored alone.
  const workstationAddAs = getAddAsMonitoredFromConfig("entraid", integrationConfig, "workstation");
  const serverAddAs      = getAddAsMonitoredFromConfig("entraid", integrationConfig, "server");
  const resolveAddAs = (assetType: string): boolean | null =>
    assetType === "workstation" ? workstationAddAs
    : assetType === "server"    ? serverAddAs
    : null;
  const syncLog = (level: "info" | "error" | "warning", message: string) => {
    logEvent({ action: "integration.sync", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level, message: `[${integrationName}] ${message}` });
  };
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const now = new Date();

  // Load the full asset table and the AssetSource lookup index. The Entra
  // device-id and SID indexes are now built from AssetSource (Phase 2
  // cutover); MAC and hostname maps still derive from in-memory asset
  // properties below. macAddressRows are hydrated to .macAddresses so the
  // Entra sync's MAC index builder + mergeIntuneMacs pipeline keep
  // working with the legacy JSON shape.
  const allAssetsWithRows = await prisma.asset.findMany({
    // Tight select (the AD/vCenter/Arc shape): every column this sync's loop,
    // the material-field snapshot, the conflict snapshot, buildMonitoredSweep
    // and clampAcquiredToLastSeen read. The unprojected load pulled every
    // column of every asset — the big JSON blobs included — for the fleet.
    select: {
      id: true, hostname: true, hostnameOverride: true, assetTag: true, assetType: true, status: true,
      monitored: true, monitorOverride: true, acquiredAt: true, lastSeen: true,
      tags: true, discoveredByIntegrationId: true, dnsName: true, ipAddress: true,
      os: true, osVersion: true, serialNumber: true, manufacturer: true, model: true,
      learnedLocation: true, learnedAddress: true, notes: true, assignedTo: true, macAddress: true,
      macAddressRows: { select: MAC_ROW_SELECT },
    },
  });
  const allAssets = allAssetsWithRows.map((a: any) => ({
    ...a,
    macAddresses: shapeMacRows(a.macAddressRows),
  }));
  const {
    assetByEntraDeviceId,
    assetIdBySid,
    assetIdsWithEntraSource,
    assetIdsWithAdSource,
    assetById,
    entraDeviceIdByAssetId,
    directoryActivityByAssetId,
    sourcesByAssetId,
    sourceOwnerByKey,
  } = await buildEntraSyncIndex(allAssets);

  // ── In-memory source mirror ────────────────────────────────────────────────
  // sourcesByAssetId IS the projection input now: the per-device
  // `assetSource.findMany({ where: { assetId } })` re-read it replaces was one
  // round trip per device per cycle (the syncArcDevices docblock names this
  // exact pattern). So every DB effect upsertEntraIntuneSources has must land
  // in the map too, in the same order — applyEntraSourcesInMemory mirrors it,
  // and entraSweepHints (computed from the map BEFORE it is mutated) lets the
  // helper skip the cleanup deletes that provably match nothing.
  const sourceListOf = (assetId: string): EntraSourceEntry[] => {
    let l = sourcesByAssetId.get(assetId);
    if (!l) { l = []; sourcesByAssetId.set(assetId, l); }
    return l;
  };
  const isDirSource = (s: EntraSourceEntry) => s.sourceKind === "entra" || s.sourceKind === "intune";
  const entraSweepHints = (assetId: string, dev: entraId.DiscoveredEntraDevice): EntraSourceSweepHints => {
    const externalId = dev.deviceId.toLowerCase();
    const list = sourcesByAssetId.get(assetId) ?? [];
    return {
      staleExternalId: list.some((s) => isDirSource(s) && s.externalId.toLowerCase() !== externalId),
      entraAtCurrent: list.some((s) => s.sourceKind === "entra" && s.externalId.toLowerCase() === externalId),
      intuneAtCurrent: list.some((s) => s.sourceKind === "intune" && s.externalId.toLowerCase() === externalId),
    };
  };
  const applyEntraSourcesInMemory = (assetId: string, dev: entraId.DiscoveredEntraDevice, lastSeenVal: Date): void => {
    const externalId = dev.deviceId.toLowerCase();
    const kinds: Array<["entra" | "intune", boolean, (d: entraId.DiscoveredEntraDevice, t: Date) => Record<string, unknown>]> = [
      ["entra", dev.sources?.includes("entra") ?? false, buildEntraObservedBlob],
      ["intune", dev.sources?.includes("intune") ?? false, buildIntuneObservedBlob],
    ];
    for (const [kind, wants, blob] of kinds) {
      const key = `${kind}|${externalId}`;
      const prevOwner = sourceOwnerByKey.get(key);
      if (wants) {
        // The DB upsert's `update.assetId` moves the row between assets; the
        // mirror does the same by dropping it from the previous owner's list.
        if (prevOwner && prevOwner !== assetId) {
          const prevList = sourcesByAssetId.get(prevOwner);
          if (prevList) sourcesByAssetId.set(prevOwner, prevList.filter((s) => !(s.sourceKind === kind && s.externalId.toLowerCase() === externalId)));
        }
        const list = sourceListOf(assetId);
        const row = list.find((s) => s.sourceKind === kind && s.externalId.toLowerCase() === externalId);
        const observed = blob(dev, now);
        if (row) { row.observed = observed; row.inferred = false; row.lastSeen = lastSeenVal; }
        else list.push({ sourceKind: kind, externalId, inferred: false, observed, lastSeen: lastSeenVal });
        sourceOwnerByKey.set(key, assetId);
      } else if (prevOwner === assetId) {
        // The belt-and-suspenders delete at the current externalId.
        sourcesByAssetId.set(assetId, sourceListOf(assetId).filter((s) => !(s.sourceKind === kind && s.externalId.toLowerCase() === externalId)));
        sourceOwnerByKey.delete(key);
      }
    }
    // The stale-externalId sweep on this asset.
    const list = sourceListOf(assetId);
    const keep = list.filter((s) => !(isDirSource(s) && s.externalId.toLowerCase() !== externalId));
    if (keep.length !== list.length) {
      for (const s of list) {
        if (isDirSource(s) && s.externalId.toLowerCase() !== externalId) {
          const k = `${s.sourceKind}|${s.externalId.toLowerCase()}`;
          if (sourceOwnerByKey.get(k) === assetId) sourceOwnerByKey.delete(k);
        }
      }
      sourcesByAssetId.set(assetId, keep);
    }
  };

  // Untagged-collision map: assets with neither an entra/intune nor an ad
  // source (e.g. FortiGate-discovered, manually created). Duplicate-Entra
  // map: assets that already carry an entra/intune source (different
  // deviceId — same deviceId would have matched the primary entra lookup
  // first and never reached the collision branch).
  const assetByHostnameNoTag = new Map<string, any>();
  const assetByHostnameEntraTagged = new Map<string, any>();
  const assetByMac = new Map<string, any>(); // normalized MAC → asset (any source; powers the MAC identity-match cascade)
  for (const a of allAssets) {
    if (a.hostname) {
      const hasEntra = assetIdsWithEntraSource.has(a.id);
      const hasAd = assetIdsWithAdSource.has(a.id);
      if (hasEntra) {
        indexHostname(assetByHostnameEntraTagged, a.hostname, a);
      } else if (!hasAd) {
        indexHostname(assetByHostnameNoTag, a.hostname, a);
      }
    }
    // Index every MAC ever seen on this asset — primary + history.
    const primaryKey = normalizeMacKey(a.macAddress);
    if (primaryKey && !assetByMac.has(primaryKey)) assetByMac.set(primaryKey, a);
    if (Array.isArray(a.macAddresses)) {
      for (const m of a.macAddresses as any[]) {
        const k = normalizeMacKey(m?.mac);
        if (k && !assetByMac.has(k)) assetByMac.set(k, a);
      }
    }
  }

  for (const dev of result.devices) {
    const deviceIdKey = dev.deviceId.toLowerCase();
    if (!deviceIdKey) {
      skipped.push(`${dev.displayName || "<unnamed>"} (missing deviceId)`);
      continue;
    }

    const assetType = inferAssetTypeFromChassis(dev.chassisType, dev.operatingSystem);
    const disabled = !dev.accountEnabled;
    // A directory-disabled account IS the asset's lifecycle state — it maps to
    // `decommissioned`, matching what conflictResolutionService already writes
    // on an accepted/rejected AD collision. (There is no separate "Disabled In"
    // detail row any more; the status pill carries the whole signal.)
    const status: "active" | "decommissioned" = disabled ? "decommissioned" : "active";

    // Both Intune MACs (when present), labeled by source so the Asset details
    // panel can show "Intune Wi-Fi" vs "Intune Ethernet" rows. Ethernet first
    // so it ends up as the asset's primary `macAddress` after the lastSeen-
    // based sort below — Ethernet is the more stable identifier (WiFi MAC
    // randomizes on modern Windows/iOS/Android).
    const intuneMacEntries: { mac: string; source: string }[] = [];
    if (dev.ethernetMacAddress) intuneMacEntries.push({ mac: dev.ethernetMacAddress, source: "intune-ethernet" });
    if (dev.wifiMacAddress) intuneMacEntries.push({ mac: dev.wifiMacAddress, source: "intune-wifi" });

    const nowIso = now.toISOString();
    const mergeIntuneMacs = (existing: any[]): { primary: string | null; merged: any[] } => {
      const merged = Array.isArray(existing) ? [...existing] : [];
      for (const e of intuneMacEntries) {
        const key = normalizeMacKey(e.mac);
        const hit = merged.find((m: any) => normalizeMacKey(m?.mac) === key);
        if (hit) {
          hit.lastSeen = nowIso;
          hit.source = e.source;
        } else {
          merged.push({ mac: e.mac, lastSeen: nowIso, source: e.source });
        }
      }
      merged.sort((a: any, b: any) => new Date(b.lastSeen || 0).getTime() - new Date(a.lastSeen || 0).getTime());
      // Hardware-truth entries (these Intune rows included) outrank sightings
      // for the primary slot — see selectPrimaryMac.
      const primary = selectPrimaryMac(merged) ?? merged[0]?.mac ?? null;
      return { primary, merged };
    };

    const tags: string[] = ["entraid", "auto-discovered"];
    if (disabled) tags.push("entra-disabled");
    if (dev.trustType) tags.push(dev.trustType.toLowerCase());
    if (dev.complianceState) tags.push(`intune-${dev.complianceState.toLowerCase()}`);
    else if (dev.isCompliant === true) tags.push("compliant");
    else if (dev.isCompliant === false) tags.push("noncompliant");
    // Phase 4b: SID is now stored as AssetSource.observed.onPremisesSecurityIdentifier
    // on the entra source row; the legacy `sid:<SID>` tag is no longer written.
    // The hybrid-cross-link lookup in `buildEntraSyncIndex` reads from
    // AssetSource directly. Existing tagged rows are scrubbed by the
    // `scrubLegacySidGuidTags` startup job.

    // Prefer Intune's lastSync (freshest hands-on-device signal) over Entra's sign-in time
    const lastSeenIso = dev.lastSyncDateTime || dev.approximateLastSignInDateTime;
    const lastSeen = lastSeenIso ? new Date(lastSeenIso) : null;
    const acquiredAt = dev.registrationDateTime ? new Date(dev.registrationDateTime) : null;

    // 1. Primary match: any entra-or-intune AssetSource with this deviceId
    let existing: any = assetByEntraDeviceId.get(deviceIdKey) ?? null;
    let takingOver = false;
    // 2. Secondary match (hybrid-joined): on-prem SID. Resolves through any
    //    source's observed payload (entra.onPremisesSecurityIdentifier or
    //    ad.objectSid). Lets Entra claim assets first discovered by AD.
    if (!existing && dev.onPremisesSecurityIdentifier) {
      const sidAssetId = assetIdBySid.get(dev.onPremisesSecurityIdentifier.toUpperCase());
      if (sidAssetId) {
        const sidMatch = assetById.get(sidAssetId) ?? null;
        if (sidMatch) {
          existing = sidMatch;
          // Take-over fires when the SID-matched asset has no entra/intune
          // source yet (i.e. AD discovered it first). assetIdsWithEntraSource
          // is the authoritative signal — assetTag is no longer the source
          // of truth for source-of-record under the multi-source model.
          takingOver = !assetIdsWithEntraSource.has(sidMatch.id);
          if (takingOver) {
            syncLog("info", `SID cross-link: Entra device "${dev.displayName}" (${dev.deviceId}) taking over existing asset ${sidMatch.id} (was ${sidMatch.assetTag || "<untagged>"}).`);
          }
        }
      }
    }
    // 3. Tertiary match: Ethernet MAC. Treats a MAC hit as positive identity
    //    confirmation (re-enroll, re-image, NIC swap into a known device)
    //    rather than the old mac-collision conflict pathway, which generated
    //    operator noise that was almost always "same physical box, new Entra
    //    deviceId". Only the Ethernet MAC qualifies — WiFi MAC randomizes
    //    per-network on modern Windows/iOS/Android. Logged at info on every
    //    silent take-over so the merge is auditable.
    if (!existing && dev.ethernetMacAddress) {
      const macKey = normalizeMacKey(dev.ethernetMacAddress);
      if (macKey) {
        const macMatch = assetByMac.get(macKey);
        if (macMatch) {
          existing = macMatch;
          takingOver = !assetIdsWithEntraSource.has(macMatch.id);
          const targetLabel = macMatch.hostname || macMatch.assetTag || macMatch.id;
          syncLog("info", `MAC cross-link: Entra device "${dev.displayName || dev.deviceId}" Ethernet MAC ${dev.ethernetMacAddress} matched existing asset ${targetLabel}${takingOver ? " (taking over)" : ""}.`);
        }
      }
    }

    // Build the proposed-fields snapshot once; used both in the existing-asset
    // sibling checks below AND in the no-existing-match collision checks further
    // down. Defined here so both branches share the same closure.
    const buildProposed = (
      collisionReason: "untagged-collision" | "duplicate-registration",
      matchedVia: "exact" | "netbios",
    ) => ({
      sourceType: "entraid",
      assetTagPrefix: ENTRA_ASSET_TAG_PREFIX,
      deviceId: dev.deviceId,
      hostname: dev.displayName,
      serialNumber: dev.serialNumber || null,
      macAddress: dev.macAddress || null,
      manufacturer: normalizeManufacturer(dev.manufacturer || null),
      model: dev.model || null,
      os: dev.operatingSystem || null,
      osVersion: dev.operatingSystemVersion || null,
      assignedTo: dev.userPrincipalName || null,
      chassisType: dev.chassisType || null,
      complianceState: dev.complianceState || null,
      trustType: dev.trustType || null,
      onPremisesSecurityIdentifier: dev.onPremisesSecurityIdentifier || null,
      assetType,
      lastSeen: dev.lastSyncDateTime || dev.approximateLastSignInDateTime || null,
      registrationDateTime: dev.registrationDateTime || null,
      collisionReason,
      matchedVia,
    });

    if (existing) {
      // Phase 3b.1 cutover: discovery-owned fields come from the projection
      // layer. Same shape as the AD cutover — upsert sources first, fetch
      // all sources for this asset (may include AD on hybrid devices),
      // compute projection, single Asset.update with projected + non-
      // projected fields.
      try {
        await upsertEntraIntuneSources(existing.id, integrationId, dev, now, lastSeen ?? now, entraSweepHints(existing.id, dev));
        // Mirror the write into the preloaded source map — the projection
        // below reads the map instead of re-fetching this asset's rows.
        applyEntraSourcesInMemory(existing.id, dev, lastSeen ?? now);
        // Keep the in-memory directory-activity map in step with the source
        // row we just upserted — later dup-resolve comparisons read it.
        const actMs = (lastSeen ?? now).getTime();
        if (actMs > (directoryActivityByAssetId.get(existing.id) ?? 0)) {
          directoryActivityByAssetId.set(existing.id, actMs);
        }
      } catch (err: any) {
        syncLog("warning", `Failed to upsert Entra/Intune AssetSource row(s) for ${dev.displayName || dev.deviceId}: ${err.message || "Unknown error"}`);
      }
      const { projected } = projectAssetFromSources(sourcesByAssetId.get(existing.id) ?? []);

      // Update the existing asset (either Entra-sourced, or SID-matched take-over)
      // Directory activity (lastSyncDateTime / approximateLastSignInDateTime)
      // is NOT network presence — an Intune sync can come from anywhere on
      // the internet. It lives on the entra/intune AssetSource rows (upserted
      // above) and is surfaced separately in the UI; Asset.lastSeen is only
      // written by presence evidence (FortiGate sightings, agent heartbeat,
      // monitor probes, the post-sync presence-verification pass).
      // Pre-write snapshot for the per-asset discovery audit diff.
      const entraBefore = snapshotMaterialAssetFields(existing);
      const updateData: Record<string, unknown> = {
        // Maintenance-window assets are scheduler-owned: don't let the
        // directory's enabled/disabled state clobber status mid-window (the
        // maintenanceScheduler's self-heal would fight it; the right state
        // is restored when the window ends).
        ...(existing.status !== "maintenance"
          ? {
              status,
              ...(status !== existing.status ? { statusChangedAt: now, statusChangedBy: integrationName } : {}),
            }
          : {}),
      };
      // Discovery-owned fields from the projection.
      if (projected.hostname !== null) updateData.hostname = projected.hostname;
      if (projected.os !== null) updateData.os = projected.os;
      if (projected.osVersion !== null) updateData.osVersion = projected.osVersion;
      if (projected.serialNumber !== null) updateData.serialNumber = projected.serialNumber;
      if (projected.manufacturer !== null) updateData.manufacturer = projected.manufacturer;
      if (projected.model !== null) updateData.model = projected.model;
      if (projected.learnedLocation !== null) updateData.learnedLocation = projected.learnedLocation;
      // Phase 4d: assetTag is no longer the cross-source identity link —
      // AssetSource is. The takeover is realized by the entra source row
      // upsert above (priority rule: Entra source wins on hybrid devices,
      // SID-cross-link finds the row that AD created first). Existing
      // assetTag values on the row are preserved for back-compat.
      // Operator-owned / non-projected fields.
      let entraMergedMacs: MacJsonEntry[] | null = null;
      if (intuneMacEntries.length > 0) {
        const { primary, merged } = mergeIntuneMacs(existing.macAddresses as any[]);
        entraMergedMacs = merged as MacJsonEntry[];
        if (primary) updateData.macAddress = primary;
      }
      if (dev.userPrincipalName) updateData.assignedTo = dev.userPrincipalName;
      if (acquiredAt && (!existing.acquiredAt || acquiredAt < new Date(existing.acquiredAt))) {
        updateData.acquiredAt = acquiredAt;
      }
      // Only overwrite assetType if the existing one is "other" (default) — respect manual recategorization
      if (existing.assetType === "other") updateData.assetType = assetType;
      // Auto-Monitor sweep: enforce monitored = addAsMonitored unless the
      // operator has set a divergent override. assetType here is either the
      // existing value or the freshly-inferred one (for "other" → typed),
      // so the resolver sees the post-update class.
      Object.assign(
        updateData,
        buildMonitoredSweep(resolveAddAs(updateData.assetType ?? existing.assetType), existing),
      );
      // Merge tags: strip Entra-managed auto-tags and re-add the fresh set.
      // Cross-integration identity tags (sid:*, ad-guid:*) and user-set tags
      // pass through untouched.
      const preserved = ((existing.tags as string[]) || []).filter((t) => !isEntraManagedTag(t));
      updateData.tags = [...preserved, ...tags.filter((t) => !preserved.includes(t))];

      try {
        clampAcquiredToLastSeen(updateData, existing);
        await prisma.asset.update({ where: { id: existing.id }, data: updateData });
        logDiscoveryAssetUpdated(entraBefore, updateData, existing.id, dev.displayName || dev.deviceId, {
          integrationName, integrationId, sourceKind: "entra", actor,
        });
        if (entraMergedMacs) await reconcileMacAddresses(existing.id, entraMergedMacs);
        // (AssetSource rows already upserted above the projection step.)
        updated.push(dev.displayName || dev.deviceId);
      } catch (err: any) {
        syncLog("error", `Failed to update asset for Entra device ${dev.displayName || dev.deviceId}: ${err.message || "Unknown error"}`);
      }

      // Even though this device has its own asset, scan for sibling assets
      // that share the same hostname but haven't been reconciled yet. This
      // catches cases where both assets were created before either was indexed
      // (same discovery run), or where a prior conflict was rejected and the
      // sibling remains. upsertAssetConflict skips pairs that were already
      // resolved so admin decisions are preserved across runs.
      if (dev.displayName) {
        const untaggedSibling = lookupHostname(assetByHostnameNoTag, dev.displayName);
        if (untaggedSibling && untaggedSibling.asset.id !== existing.id) {
          try {
            await upsertAssetConflict({
              collisionAssetId: untaggedSibling.asset.id,
              integrationId,
              proposedDeviceId: dev.deviceId,
              // bothAssetsExist: sibling flavour — the device already has its
              // own asset, so conflict-reject records the decision without
              // creating anything (see rejectAssetConflict's alreadyOwned
              // guard) and the UI explains accept as a two-asset merge.
              proposedAssetFields: { ...buildProposed("untagged-collision", untaggedSibling.via), bothAssetsExist: true },
              existingAsset: untaggedSibling.asset,
            });
            syncLog("warning", `Sibling hostname collision — Entra device "${dev.displayName}" (${dev.deviceId}) has a tagged asset but untagged asset ${untaggedSibling.asset.id} shares the same hostname${untaggedSibling.via === "netbios" ? " (NetBIOS-truncated match)" : ""}.`);
          } catch (err: any) {
            syncLog("error", `Failed to queue sibling hostname-collision conflict for "${dev.displayName}": ${err.message || "Unknown error"}`);
          }
        }
        const dupEntraSibling = lookupHostname(assetByHostnameEntraTagged, dev.displayName);
        if (dupEntraSibling && dupEntraSibling.asset.id !== existing.id) {
          // Auto-resolve by lastSeen: newer activity wins. Phase 4d/4e:
          // sibling's prior Entra deviceId now comes from the
          // entraDeviceIdByAssetId map (built from AssetSource) instead
          // of slicing the legacy assetTag, and the prev-entra: breadcrumb
          // tag is no longer written — the auto-resolve syncLog event
          // captures both deviceIds for audit, and the AssetSource
          // sweep removes the stale source row from the loser.
          const siblingId = entraDeviceIdByAssetId.get(dupEntraSibling.asset.id) || "<unknown>";
          // Compare directory activity against directory activity — the
          // sibling's Graph-reported timestamp lives on its entra/intune
          // AssetSource rows, not on Asset.lastSeen (which is now presence).
          const siblingActivityMs = directoryActivityByAssetId.get(dupEntraSibling.asset.id);
          const siblingLastSeen = siblingActivityMs ? new Date(siblingActivityMs) : null;
          const incomingWins = lastSeen != null && (siblingLastSeen == null || lastSeen > siblingLastSeen);
          try {
            if (incomingWins) {
              syncLog("info", `Auto-resolved sibling duplicate Entra registration "${dev.displayName}" — incoming ${dev.deviceId} (${lastSeen?.toISOString()}) newer than sibling ${siblingId} (${siblingLastSeen?.toISOString() ?? "never"}). Sibling ID retired.`);
            } else {
              syncLog("info", `Auto-resolved sibling duplicate Entra registration "${dev.displayName}" — sibling ${siblingId} (${siblingLastSeen?.toISOString() ?? "never"}) is same/newer than incoming ${dev.deviceId} (${lastSeen?.toISOString() ?? "never"}). Incoming ID retired.`);
            }
            await tombstoneConflict(dev.deviceId, dupEntraSibling.asset.id, integrationId);
            await tombstoneConflict(siblingId, existing.id, integrationId);
          } catch (err: any) {
            syncLog("error", `Failed to auto-resolve sibling duplicate Entra registration for "${dev.displayName}": ${err.message || "Unknown error"}`);
          }
        }
      }
      continue;
    }

    // No existing assetTag, SID, or MAC match — check for hostname collision.
    // Two flavours, in order of decreasing confidence:
    //   (a) hostname collision with an untagged asset
    //   (b) duplicate Entra registration where another entra-tagged asset shares
    //       the hostname (Entra returned two distinct deviceIds for the same
    //       display name — re-enrol, re-image, dual-boot, etc.)
    // Each flavour raises a pending Conflict so an admin can decide whether to
    // merge (accept) or keep separate (reject). Hostname matching tolerates
    // 15-char NetBIOS truncation so an AD `cn`-derived hostname can match the
    // full Entra displayName and vice versa.
    // (buildProposed is declared above the if(existing) block — shared closure)

    if (dev.displayName) {
      const untagged = lookupHostname(assetByHostnameNoTag, dev.displayName);
      if (untagged) {
        try {
          await upsertAssetConflict({
            collisionAssetId: untagged.asset.id,
            integrationId,
            proposedDeviceId: dev.deviceId,
            proposedAssetFields: buildProposed("untagged-collision", untagged.via),
            existingAsset: untagged.asset,
          });
          syncLog("warning", `Hostname collision queued for review — Entra device "${dev.displayName}" (${dev.deviceId}) matches untagged asset ${untagged.asset.id}${untagged.via === "netbios" ? " (NetBIOS-truncated match)" : ""}.`);
        } catch (err: any) {
          syncLog("error", `Failed to queue hostname-collision conflict for "${dev.displayName}": ${err.message || "Unknown error"}`);
        }
        skipped.push(`${dev.displayName} (hostname collision — pending review)`);
        continue;
      }

      const dupEntra = lookupHostname(assetByHostnameEntraTagged, dev.displayName);
      if (dupEntra) {
        // Auto-resolve by lastSeen: newer activity wins. Phase 4d/4e:
        // existing Entra deviceId now comes from entraDeviceIdByAssetId
        // (built from AssetSource.externalId) instead of slicing the
        // legacy assetTag, and the prev-entra: breadcrumb tag is no
        // longer written — the syncLog event captures both deviceIds
        // for audit and upsertEntraIntuneSources sweeps the stale source
        // row so the prior identity can't re-link a future discovery.
        // Tombstone conflict records in both directions prevent re-queuing.
        const existingEntraId = entraDeviceIdByAssetId.get(dupEntra.asset.id) || "<unknown>";
        // Directory-activity vs directory-activity comparison (see the
        // sibling-resolve note above) — Asset.lastSeen is presence now.
        const existingActivityMs = directoryActivityByAssetId.get(dupEntra.asset.id);
        const existingLastSeen = existingActivityMs ? new Date(existingActivityMs) : null;
        const incomingWins = lastSeen != null && (existingLastSeen == null || lastSeen > existingLastSeen);
        try {
          if (incomingWins) {
            // Phase 3b.1 cutover: same projection-driven write pattern as
            // the primary update path. Upsert sources first (the helper
            // also sweeps the old (entra,oldDeviceId)/(intune,oldDeviceId)
            // rows so the prior identity can't re-link), then project, then
            // single Asset.update.
            try {
              await upsertEntraIntuneSources(dupEntra.asset.id, integrationId, dev, now, lastSeen ?? now, entraSweepHints(dupEntra.asset.id, dev));
              applyEntraSourcesInMemory(dupEntra.asset.id, dev, lastSeen ?? now);
            } catch (err: any) {
              syncLog("warning", `Failed to upsert Entra/Intune AssetSource row(s) during duplicate-resolve for ${dev.displayName || dev.deviceId}: ${err.message || "Unknown error"}`);
            }
            const { projected: dupProjected } = projectAssetFromSources(sourcesByAssetId.get(dupEntra.asset.id) ?? []);

            const preserved = ((dupEntra.asset.tags as string[]) || []).filter((t) => !isEntraManagedTag(t));
            const newTags = [...preserved, ...tags.filter((t) => !preserved.includes(t))];
            const updateFields: Record<string, unknown> = {
              // Phase 4d: assetTag write retired — AssetSource.externalId on
              // the upserted entra source row above is the authoritative
              // identity link. Prior assetTag is preserved on the row.
              // (No lastSeen — directory activity stays on the AssetSource
              // rows; Asset.lastSeen is verified network presence.)
              // Maintenance-window assets keep their scheduler-owned status.
              ...(dupEntra.asset.status !== "maintenance"
                ? {
                    status,
                    ...(status !== dupEntra.asset.status ? { statusChangedAt: now, statusChangedBy: integrationName } : {}),
                  }
                : {}),
              tags: newTags,
            };
            // Discovery-owned fields from projection.
            if (dupProjected.hostname !== null) updateFields.hostname = dupProjected.hostname;
            if (dupProjected.os !== null) updateFields.os = dupProjected.os;
            if (dupProjected.osVersion !== null) updateFields.osVersion = dupProjected.osVersion;
            if (dupProjected.serialNumber !== null) updateFields.serialNumber = dupProjected.serialNumber;
            if (dupProjected.manufacturer !== null) updateFields.manufacturer = dupProjected.manufacturer;
            if (dupProjected.model !== null) updateFields.model = dupProjected.model;
            if (dupProjected.learnedLocation !== null) updateFields.learnedLocation = dupProjected.learnedLocation;
            // Operator-owned / non-projected fields.
            if (dev.userPrincipalName) updateFields.assignedTo = dev.userPrincipalName;
            let dupEntraMergedMacs: MacJsonEntry[] | null = null;
            if (intuneMacEntries.length > 0) {
              const { primary, merged } = mergeIntuneMacs(dupEntra.asset.macAddresses as any[]);
              dupEntraMergedMacs = merged as MacJsonEntry[];
              if (primary) updateFields.macAddress = primary;
            }
            if (acquiredAt && (!dupEntra.asset.acquiredAt || acquiredAt < new Date(dupEntra.asset.acquiredAt as any))) {
              updateFields.acquiredAt = acquiredAt;
            }
            if (dupEntra.asset.assetType === "other") updateFields.assetType = assetType;
            // Auto-Monitor sweep on the duplicate-takeover path.
            Object.assign(
              updateFields,
              buildMonitoredSweep(resolveAddAs(updateFields.assetType ?? dupEntra.asset.assetType), dupEntra.asset),
            );
            clampAcquiredToLastSeen(updateFields, dupEntra.asset);
            await prisma.asset.update({ where: { id: dupEntra.asset.id }, data: updateFields });
            if (dupEntraMergedMacs) await reconcileMacAddresses(dupEntra.asset.id, dupEntraMergedMacs);
            // (AssetSource rows were already upserted above the projection
            // step, including the stale-deviceId sweep that removes the
            // old (entra,oldDeviceId)/(intune,oldDeviceId) rows so the
            // prior identity can't re-link a future discovery.)
            // Update in-memory indexes so further iterations find the asset
            // by its new Entra ID. The prior key is removed; the new key
            // points at the same in-memory asset record (with no assetTag
            // mutation since 4d retired that field's role).
            assetByEntraDeviceId.delete(existingEntraId.toLowerCase());
            assetByEntraDeviceId.set(deviceIdKey, dupEntra.asset);
            entraDeviceIdByAssetId.set(dupEntra.asset.id, deviceIdKey);
            if (lastSeen) directoryActivityByAssetId.set(dupEntra.asset.id, lastSeen.getTime());
            updated.push(dev.displayName || dev.deviceId);
            syncLog("info", `Auto-resolved duplicate Entra registration "${dev.displayName}" — incoming ${dev.deviceId} (${lastSeen?.toISOString()}) newer than existing ${existingEntraId} (${existingLastSeen?.toISOString() ?? "never"}). Asset updated; prior identity retired.`);
          } else {
            // Existing wins. Phase 4e: prev-entra: breadcrumb tag write
            // retired — the syncLog event captures both deviceIds for
            // audit; AssetSource on the existing asset still pins
            // existingEntraId so the next sync re-finds it cleanly.
            skipped.push(`${dev.displayName} (duplicate Entra registration — auto-resolved, existing ${existingEntraId} is same/newer)`);
            syncLog("info", `Auto-resolved duplicate Entra registration "${dev.displayName}" — existing ${existingEntraId} (${existingLastSeen?.toISOString() ?? "never"}) same/newer than incoming ${dev.deviceId} (${lastSeen?.toISOString() ?? "never"}). Incoming ID retired.`);
          }
          await tombstoneConflict(dev.deviceId, dupEntra.asset.id, integrationId);
          await tombstoneConflict(existingEntraId, dupEntra.asset.id, integrationId);
        } catch (err: any) {
          syncLog("error", `Failed to auto-resolve duplicate Entra registration for "${dev.displayName}": ${err.message || "Unknown error"}`);
          skipped.push(`${dev.displayName} (duplicate Entra registration — error during auto-resolve)`);
        }
        continue;
      }
    }

    // (Ethernet MAC matches are no longer a conflict pathway — they're
    // resolved as a positive identity match in the cascade above the
    // if (existing) block.)

    // Create a new asset
    try {
      // Phase 3b.1 cutover: project from a synthetic source array built
      // from this just-discovered Entra device. dev.sources determines
      // which source kinds to seed (entra-only vs entra+intune vs
      // intune-only). Pure projection — no DB roundtrip — because the
      // new asset has no other sources yet.
      const synthSources: Array<{ sourceKind: string; inferred: boolean; observed: Record<string, unknown> }> = [];
      if (dev.sources?.includes("entra")) {
        synthSources.push({ sourceKind: "entra", inferred: false, observed: buildEntraObservedBlob(dev, now) });
      }
      if (dev.sources?.includes("intune")) {
        synthSources.push({ sourceKind: "intune", inferred: false, observed: buildIntuneObservedBlob(dev, now) });
      }
      const { projected } = projectAssetFromSources(synthSources);

      const seeded = mergeIntuneMacs([]);
      const createData: Record<string, unknown> = {
        // Phase 4d: legacy `assetTag = entra:<deviceId>` write retired —
        // upsertEntraIntuneSources below stamps the AssetSource entra
        // (and intune, if applicable) row that re-discovery uses as the
        // canonical identity link.
        hostname: projected.hostname,
        serialNumber: projected.serialNumber,
        macAddress: seeded.primary || dev.macAddress || null,
        ...(seeded.merged.length > 0
          ? { macAddressRows: { create: buildMacRowsForCreate(seeded.merged as MacJsonEntry[]) } }
          : {}),
        manufacturer: projected.manufacturer,
        model: projected.model,
        assetType,
        status,
        statusChangedAt: now,
        statusChangedBy: integrationName,
        os: projected.os,
        osVersion: projected.osVersion,
        learnedLocation: projected.learnedLocation,
        assignedTo: dev.userPrincipalName || null,
        // lastSeen stays null on create — directory activity lives on the
        // AssetSource rows; presence evidence (FortiGate sighting, agent,
        // probe, or the post-sync presence-verification ping) fills it in.
        acquiredAt,
        notes: `Auto-discovered from Entra ID integration "${integrationName}"${dev.trustType ? ` (trust: ${dev.trustType})` : ""}`,
        tags,
      };
      // Initial monitored state on create. With no prior asset row,
      // buildMonitoredSweep sees `existing.monitored !== true` and stamps
      // monitored=true when addAsMonitored is on. monitorOverride stays
      // false (Prisma default) — operator hasn't disagreed yet.
      Object.assign(createData, buildMonitoredSweep(resolveAddAs(assetType), { monitored: false, monitorOverride: false }));
      clampAcquiredToLastSeen(createData);
      const newAsset = await prisma.asset.create({ data: createData as any });
      // Persist the entra (and intune, when intune contributed) source
      // rows. The shadow-write extension already laid down a skeleton row
      // from the assetTag during Asset.create — this overwrites it with
      // the rich observed blobs the projection just used.
      try {
        // No sweep hints here on purpose: the shadow-write skeleton row this
        // comment describes was laid down AFTER the sync's source map was
        // loaded, so the map cannot prove the cleanup deletes are no-ops for
        // a just-created asset. Unconditional is correct and creates are rare.
        await upsertEntraIntuneSources(newAsset.id, integrationId, dev, now, lastSeen ?? now);
        applyEntraSourcesInMemory(newAsset.id, dev, lastSeen ?? now);
      } catch (err: any) {
        syncLog("warning", `Created asset for Entra device ${dev.displayName || dev.deviceId} but failed to upsert AssetSource row(s): ${err.message || "Unknown error"}`);
      }
      logDiscoveryAssetCreated(newAsset.id, dev.displayName || dev.deviceId, {
        integrationName, integrationId, sourceKind: "entra", actor,
      });
      // Refresh the in-memory indexes so later devices in this run see the
      // new asset (sibling-collision detection, SID matches, etc.).
      assetById.set(newAsset.id, newAsset);
      assetByEntraDeviceId.set(deviceIdKey, newAsset);
      assetIdsWithEntraSource.add(newAsset.id);
      if (dev.onPremisesSecurityIdentifier) {
        assetIdBySid.set(dev.onPremisesSecurityIdentifier.toUpperCase(), newAsset.id);
      }
      // Index the freshly-created asset by every MAC we just stored so a later
      // device in this same run reporting any of those MACs cross-links into
      // this asset via the MAC identity-match cascade instead of creating a
      // third duplicate row.
      for (const e of intuneMacEntries) {
        const k = normalizeMacKey(e.mac);
        if (k && !assetByMac.has(k)) assetByMac.set(k, newAsset);
      }
      created.push(dev.displayName || dev.deviceId);
    } catch (err: any) {
      syncLog("error", `Failed to create asset for Entra device ${dev.displayName || dev.deviceId}: ${err.message || "Unknown error"}`);
    }
  }

  syncLog("info", `Entra ID sync: ${created.length} created, ${updated.length} updated, ${skipped.length} skipped`);
  return { created, updated, skipped };
}

// ─── Active Directory asset sync ─────────────────────────────────────────────

function isAdManagedTag(t: string): boolean {
  if (t.startsWith("activedirectory")) return true;
  if (t.startsWith(AD_GUID_TAG_PREFIX)) return true; // replaced fresh each run
  return ["auto-discovered", "ad-disabled"].includes(t);
}

// Build the source-shaped observed blob written to AssetSource for an AD
// discovery. Mirrors the per-source JSON shape sketched in polaris-monitoring-discovery -> discovery-fortinet.md
// ("Per-source observed shapes / sourceKind: ad").
function buildAdObservedBlob(
  dev: activeDirectory.DiscoveredAdDevice,
  syncedAt: Date,
): Record<string, unknown> {
  return {
    kind: "ad",
    syncedAt: syncedAt.toISOString(),
    objectGuid: dev.objectGuid.toLowerCase(),
    objectSid: dev.objectSid || null,
    cn: dev.cn || null,
    dnsHostName: dev.dnsHostName || null,
    distinguishedName: dev.distinguishedName || null,
    ouPath: dev.ouPath || null,
    operatingSystem: dev.operatingSystem || null,
    operatingSystemVersion: dev.operatingSystemVersion || null,
    description: dev.description || null,
    whenCreated: dev.whenCreated || null,
    lastLogonTimestamp: dev.lastLogonTimestamp || null,
    accountDisabled: !!dev.disabled,
  };
}

// Upsert the AD AssetSource row tied to a freshly-discovered device. The
// shadow-write Prisma extension also fires when the Asset is created/updated
// — its UPDATE path intentionally leaves `observed` alone so this explicit
// write owns the rich source-shaped payload. Best-effort: failures are
// logged via the syncLog but never block the Asset write that already
// landed.
async function upsertAdAssetSource(
  assetId: string,
  integrationId: string,
  dev: activeDirectory.DiscoveredAdDevice,
  syncedAt: Date,
  lastSeen: Date,
): Promise<void> {
  const externalId = dev.objectGuid.toLowerCase();
  const observed = buildAdObservedBlob(dev, syncedAt);
  await prisma.assetSource.upsert({
    where: { sourceKind_externalId: { sourceKind: "ad", externalId } },
    create: {
      assetId,
      sourceKind: "ad",
      externalId,
      integrationId,
      observed: observed as any,
      inferred: false,
      syncedAt,
      firstSeen: lastSeen,
      lastSeen,
    },
    update: {
      assetId,
      integrationId,
      observed: observed as any,
      inferred: false,
      syncedAt,
      lastSeen,
    },
  });
  // Phase 3b.1 cutover: drift detection no longer fires on AD writes —
  // post-cutover the Asset row matches the projection by construction
  // (the syncActiveDirectoryDevices caller projects from sources and uses
  // the result as the Asset write payload). Drift detection still runs on
  // integrations that haven't cut over yet (Entra, FortiGate-firewall,
  // FortiSwitch, FortiAP) via their own upsert helpers.
}

/**
 * Build the observed blob for a `fortigate-endpoint` AssetSource row.
 *
 * Unified source kind covering every endpoint discovery pathway the
 * FortiManager / FortiGate sync uses — DHCP reservations, DHCP leases,
 * device-inventory (FortiOS `device/list` with hardware/OS/user
 * fingerprinting), switch-port MAC table, ARP enrichment. Whichever
 * pathways found the device contribute their fields; pathways that
 * didn't run for this device leave their fields null. The asset itself
 * is the authoritative merged view; this blob is what THIS source last
 * told us about it.
 *
 * externalId is the asset's primary MAC, normalized to colon-separated
 * uppercase. Without a MAC we can't dedupe across discovery cycles
 * (FortiGate doesn't supply a stable per-device ID), so the upsert
 * helper skips assets without one.
 */
function buildFortigateEndpointObservedBlob(
  asset: any,
  integrationType: "fortimanager" | "fortigate" | string,
  integrationName: string | null,
  gateName: string | null,
): Record<string, unknown> {
  return {
    mac: typeof asset.macAddress === "string" ? asset.macAddress.toUpperCase() : null,
    hostname: asset.hostname ?? null,
    ipAddress: asset.ipAddress ?? null,
    ipSource: asset.ipSource ?? null,
    os: asset.os ?? null,
    osVersion: asset.osVersion ?? null,
    hardwareVendor: asset.manufacturer ?? null,
    model: asset.model ?? null,
    // The FortiGate that sighted this device, supplied by the CALLER from the
    // pathway's own device name (see fortigateEndpointDeviceByAsset). Never
    // read `asset.learnedLocation` here: that's the projection's OUTPUT, a
    // merge of every source, so on a domain-joined laptop it holds AD's OU
    // path and stamping it back in makes this source claim the FortiGate said
    // it. It also fed the runaway "<integration>:" prefix growth (prod: 32
    // segments, 2026-08). Bare here anyway as a belt-and-braces read of a
    // caller-supplied value — see utils/assetSourceLocation.bareFortinetDeviceName.
    learnedLocation: gateName && gateName.trim()
      ? bareFortinetDeviceName(gateName.trim())
      : null,
    lastSeenSwitch: asset.lastSeenSwitch ?? null,
    lastSeenAp: asset.lastSeenAp ?? null,
    discoveredVia: integrationType, // "fortimanager" | "fortigate"
    // Which FMG / FortiGate integration sighted it. Only consumed by the
    // optional `<integration name>:<fortigate name>` rendering of the Sources
    // column (utils/assetSourceLocation.contributedLocation) — rows written
    // before this stamp existed simply fall back to the bare device name.
    integrationName: integrationName || null,
  };
}

/**
 * Upsert the `fortigate-endpoint` AssetSource row tying the given asset
 * to the FMG/FortiGate integration that just sighted it. Idempotent on
 * the (sourceKind, externalId=mac) unique key.
 *
 * After upserting, sweep any "manual" source row from the same asset —
 * those are Phase 1 backfill placeholders for assets that didn't match
 * a tag prefix at the time. With a real fortigate-endpoint source now
 * present, the placeholder is no longer correct.
 */
async function upsertFortigateEndpointSource(
  assetId: string,
  integrationId: string,
  asset: any,
  integrationType: string,
  lastSeen: Date,
  integrationName: string | null,
  /** The FortiGate that sighted it, from the touching pathway — see the blob builder. */
  gateName: string | null,
): Promise<void> {
  if (!asset?.macAddress) return;
  const externalId = String(asset.macAddress).trim().toUpperCase();
  if (!externalId) return;
  const observed = buildFortigateEndpointObservedBlob(asset, integrationType, integrationName, gateName);
  const now = new Date();
  await prisma.assetSource.upsert({
    where: { sourceKind_externalId: { sourceKind: "fortigate-endpoint", externalId } },
    create: {
      assetId,
      sourceKind: "fortigate-endpoint",
      externalId,
      integrationId,
      observed: observed as any,
      inferred: false,
      syncedAt: now,
      firstSeen: lastSeen,
      lastSeen,
    },
    update: {
      assetId,
      integrationId,
      observed: observed as any,
      syncedAt: now,
      lastSeen,
    },
  });
  // Manual-source sweep: the Phase 1 backfill placeholder for this
  // asset is now superseded by a real source. Best-effort.
  try {
    await prisma.assetSource.deleteMany({
      where: { assetId, sourceKind: "manual" },
    });
  } catch {
    // Sweep failure is non-fatal — the manual row just lingers; UI
    // shows both source cards, which is mildly redundant but harmless.
  }
}

// Build the AD sync's lookup index from AssetSource rows. Replaces the legacy
// in-memory scan over Asset.assetTag / Asset.tags for "ad:" / "ad-guid:" /
// "sid:" markers. Both representations are kept in sync during Phase 2 by
// the shadow-write Prisma extension + backfill job — Phase 4 retires the tag
// conventions entirely.
async function buildAdSyncIndex(
  allAssets: { id: string; hostname: string | null; assetTag: string | null }[],
): Promise<{
  adSourceByGuid: Map<string, { source: any; asset: any }>;
  assetIdBySid: Map<string, string>;
  assetIdsWithAdSource: Set<string>;
  assetIdsWithEntraSource: Set<string>;
  assetById: Map<string, any>;
  /** Asset id → EVERY source row on it (all kinds) — the projection input.
   *  The sync mirrors its own upserts into this map so projecting an asset
   *  costs no per-device re-read (the Entra sync's pattern, same rationale). */
  sourcesByAssetId: Map<string, EntraSourceEntry[]>;
}> {
  const assetById = new Map<string, any>();
  for (const a of allAssets) assetById.set(a.id, a);

  // ALL kinds, tight select: ad/entra feed the identity indexes below, and
  // every kind feeds sourcesByAssetId (a hybrid device projects from its
  // entra + agent + fortigate rows too).
  const sources = await prisma.assetSource.findMany({
    select: { assetId: true, sourceKind: true, externalId: true, inferred: true, observed: true, lastSeen: true },
  });

  const adSourceByGuid = new Map<string, { source: any; asset: any }>();
  const assetIdBySid = new Map<string, string>();
  const assetIdsWithAdSource = new Set<string>();
  const assetIdsWithEntraSource = new Set<string>();
  const sourcesByAssetId = new Map<string, EntraSourceEntry[]>();

  for (const src of sources) {
    const obs = (src.observed as Record<string, unknown> | null) || {};
    const entry: EntraSourceEntry = { sourceKind: src.sourceKind, externalId: src.externalId, inferred: src.inferred, observed: obs, lastSeen: src.lastSeen };
    const list = sourcesByAssetId.get(src.assetId);
    if (list) list.push(entry); else sourcesByAssetId.set(src.assetId, [entry]);
    if (src.sourceKind === "ad") {
      assetIdsWithAdSource.add(src.assetId);
      const a = assetById.get(src.assetId);
      if (a) adSourceByGuid.set(src.externalId.toLowerCase(), { source: src, asset: a });
      const sid = typeof obs.objectSid === "string" ? obs.objectSid.toUpperCase() : null;
      if (sid) assetIdBySid.set(sid, src.assetId);
    } else if (src.sourceKind === "entra") {
      assetIdsWithEntraSource.add(src.assetId);
      const sid =
        typeof obs.onPremisesSecurityIdentifier === "string"
          ? obs.onPremisesSecurityIdentifier.toUpperCase()
          : null;
      if (sid) assetIdBySid.set(sid, src.assetId);
    }
  }

  return { adSourceByGuid, assetIdBySid, assetIdsWithAdSource, assetIdsWithEntraSource, assetById, sourcesByAssetId };
}

// Exported for tests, like syncEntraDevices: the map-fed projection below must
// stay faithful to the DB rows, and only a real round trip proves it.
export async function syncActiveDirectoryDevices(
  integrationId: string,
  integrationName: string,
  integrationConfig: Record<string, unknown> | null,
  result: { devices: activeDirectory.DiscoveredAdDevice[] },
  actor?: string,
): Promise<{ created: string[]; updated: string[]; skipped: string[] }> {
  const syncLog = (level: "info" | "error" | "warning", message: string) => {
    logEvent({ action: "integration.sync", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level, message: `[${integrationName}] ${message}` });
  };
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  // Per-class addAsMonitored snapshot for the auto-monitor sweep.
  const workstationAddAs = getAddAsMonitoredFromConfig("activedirectory", integrationConfig, "workstation");
  const serverAddAs      = getAddAsMonitoredFromConfig("activedirectory", integrationConfig, "server");
  const resolveAddAs = (assetType: string | null | undefined): boolean | null =>
    assetType === "workstation" ? workstationAddAs
    : assetType === "server"    ? serverAddAs
    : null;

  // Load the asset table (tight select — every column the loop, the material-
  // field snapshot, the conflict snapshot and buildMonitoredSweep read; the
  // unprojected load pulled the big JSON blobs for the whole fleet) and the
  // AssetSource lookup index. The AD-source index is built from AssetSource
  // (Phase 2 cutover); hostname-collision maps still derive from in-memory
  // asset properties below.
  const allAssets = await prisma.asset.findMany({
    select: {
      id: true, hostname: true, hostnameOverride: true, assetTag: true, assetType: true, status: true,
      monitored: true, monitorOverride: true, acquiredAt: true, lastSeen: true,
      tags: true, discoveredByIntegrationId: true, dnsName: true, ipAddress: true,
      os: true, osVersion: true, serialNumber: true, manufacturer: true, model: true,
      learnedLocation: true, learnedAddress: true, notes: true, assignedTo: true, macAddress: true,
    },
  });
  const {
    adSourceByGuid,
    assetIdBySid,
    assetIdsWithAdSource,
    assetIdsWithEntraSource,
    assetById,
    sourcesByAssetId,
  } = await buildAdSyncIndex(allAssets);

  // Untagged-collision map: assets with neither an AD nor an Entra source
  // (e.g. FortiGate-discovered, manually created, or AD-source row not yet
  // backfilled). Duplicate-AD-registration map: assets that already carry an
  // AD source (different externalId — same externalId would have matched in
  // step 1 above and never reached the collision branch).
  const assetByHostnameNoTag = new Map<string, any>();
  const assetByHostnameAdTagged = new Map<string, any>();
  for (const a of allAssets) {
    if (!a.hostname) continue;
    const hasAd = assetIdsWithAdSource.has(a.id);
    const hasEntra = assetIdsWithEntraSource.has(a.id);
    if (hasAd) {
      indexHostname(assetByHostnameAdTagged, a.hostname, a);
    } else if (!hasEntra) {
      indexHostname(assetByHostnameNoTag, a.hostname, a);
    }
  }

  for (const dev of result.devices) {
    const guidKey = dev.objectGuid.toLowerCase();
    if (!guidKey) {
      skipped.push(`${dev.cn || "<unnamed>"} (missing objectGUID)`);
      continue;
    }

    const displayName = dev.dnsHostName || dev.cn;
    const hostLookupKey = (dev.dnsHostName || dev.cn || "").toLowerCase();
    const assetType = inferAssetTypeFromOs(dev.operatingSystem);
    // Disabled in AD → `decommissioned` (see the Entra sync above; same rule,
    // and the same one conflictResolutionService applies on collision accept).
    const status: "active" | "decommissioned" = dev.disabled ? "decommissioned" : "active";
    // Realm-monitorable hosts (Windows via WinRM, Linux via SSH) get locked to
    // this AD integration so the bind credentials double as the probe
    // credentials, mirroring how FMG owns its discovered firewalls.
    const adMonitorable = getAdMonitorProtocol(dev.operatingSystem) !== null;

    // Phase 4b: AD GUID lives on AssetSource.externalId (sourceKind="ad")
    // and SID lives on AssetSource.observed.objectSid. Neither needs a
    // mirroring tag any more — the legacy `ad-guid:<guid>` and `sid:<SID>`
    // tag writes are dropped here. Existing rows are scrubbed by the
    // `scrubLegacySidGuidTags` startup job.
    const tags: string[] = ["activedirectory", "auto-discovered"];
    if (dev.disabled) tags.push("ad-disabled");

    const lastLogon = dev.lastLogonTimestamp ? new Date(dev.lastLogonTimestamp) : null;
    const whenCreated = dev.whenCreated ? new Date(dev.whenCreated) : null;

    // Match order: (1) AD source by objectGUID (2) any source's SID (hybrid
    // — Entra likely owns the assetTag) (3) hostname collision → conflict
    // (4) create new.
    const adHit = adSourceByGuid.get(guidKey);
    let existing: any = adHit?.asset ?? null;
    if (!existing && dev.objectSid) {
      const sidAssetId = assetIdBySid.get(dev.objectSid.toUpperCase());
      if (sidAssetId) existing = assetById.get(sidAssetId) ?? null;
    }

    if (existing) {
      // Phase 3b.1 cutover: discovery-owned fields (hostname, os, osVersion,
      // learnedLocation, serialNumber, manufacturer, model) come from the
      // projection layer. Order:
      //   1. Upsert AD source first so projection sees fresh AD data
      //   2. Mirror the write into the preloaded source map (the per-device
      //      re-fetch this replaces was one round trip per computer)
      //   3. Compute projection from the map
      //   4. Apply projected fields + non-projected logic in a single
      //      Asset.update — no double-write.
      // The mirror is a plain replace-or-insert: unlike Entra, AD's cascade
      // can never MOVE a source row between assets (a guid already in the
      // fleet-wide index resolves to its own asset at step 1), and the
      // helper carries no cleanup sweeps.
      const now = new Date();
      try {
        await upsertAdAssetSource(existing.id, integrationId, dev, now, lastLogon ?? now);
        let list = sourcesByAssetId.get(existing.id);
        if (!list) { list = []; sourcesByAssetId.set(existing.id, list); }
        const row = list.find((s) => s.sourceKind === "ad" && s.externalId.toLowerCase() === guidKey);
        const adObserved = buildAdObservedBlob(dev, now);
        if (row) { row.observed = adObserved; row.inferred = false; row.lastSeen = lastLogon ?? now; }
        else list.push({ sourceKind: "ad", externalId: guidKey, inferred: false, observed: adObserved, lastSeen: lastLogon ?? now });
      } catch (err: any) {
        syncLog("warning", `Failed to upsert AD AssetSource row for ${displayName || dev.objectGuid}: ${err.message || "Unknown error"}`);
      }
      const { projected } = projectAssetFromSources(sourcesByAssetId.get(existing.id) ?? []);

      // Pre-write snapshot for the per-asset discovery audit diff.
      const adBefore = snapshotMaterialAssetFields(existing);
      const updateData: Record<string, unknown> = {
        // Maintenance-window assets keep their scheduler-owned status (same
        // guard as the Entra sync — see maintenanceScheduleService).
        ...(existing.status !== "maintenance"
          ? {
              status,
              ...(status !== existing.status ? { statusChangedAt: now, statusChangedBy: integrationName } : {}),
            }
          : {}),
      };
      // Discovery-owned fields from the projection. Only write when
      // projection has a value (null = "no source has an opinion" — leave
      // the existing Asset value alone).
      if (projected.hostname !== null) updateData.hostname = projected.hostname;
      if (projected.os !== null) updateData.os = projected.os;
      if (projected.osVersion !== null) updateData.osVersion = projected.osVersion;
      if (projected.learnedLocation !== null) updateData.learnedLocation = projected.learnedLocation;
      if (projected.serialNumber !== null) updateData.serialNumber = projected.serialNumber;
      if (projected.manufacturer !== null) updateData.manufacturer = projected.manufacturer;
      if (projected.model !== null) updateData.model = projected.model;
      // dnsName is AD-specific (not in projection — separate Asset column).
      if (dev.dnsHostName) updateData.dnsName = dev.dnsHostName;
      // lastSeen: NOT written from AD. lastLogonTimestamp is replication-lazy
      // (can trail real logons by up to ~14 days) and is directory activity,
      // not network presence — it lives on the AD AssetSource row (upserted
      // above) and is surfaced separately in the UI. Asset.lastSeen is only
      // advanced by presence evidence (FortiGate sightings, agent heartbeat,
      // monitor probes, the post-sync presence-verification pass).
      // acquiredAt: backfill with AD whenCreated only if older than current.
      if (whenCreated && (!existing.acquiredAt || whenCreated < new Date(existing.acquiredAt))) {
        updateData.acquiredAt = whenCreated;
      }
      // assetType: only set if still default "other" (respect manual recategorization).
      if (existing.assetType === "other" && assetType !== "other") updateData.assetType = assetType;
      // Notes: only write if the existing notes field is empty.
      if (!existing.notes && dev.description) updateData.notes = dev.description;

      // Tag merge: strip AD-managed tags + stale sid/ad-guid (we re-add the fresh ones),
      // preserve all other tags including those set by Entra (entraid, intune-*, trustType, etc.).
      const preserved = ((existing.tags as string[]) || []).filter(
        (t) => !isAdManagedTag(t) && !t.startsWith(SID_TAG_PREFIX),
      );
      updateData.tags = [...preserved, ...tags.filter((t) => !preserved.includes(t))];

      // Stamp the AD source link so the polling-method resolver picks AD's
      // source default (ICMP for response-time, null for the other streams)
      // and the asset edit modal shows the right tier badges. Skip when
      // another integration already owns the asset (defensive — an FMG-
      // discovered firewall shouldn't end up under AD).
      //
      // Polling-method redesign (step 3i): we no longer stamp
      // `monitorType="activedirectory"` here. The legacy stamp made probes
      // route to WinRM/SSH using the AD bind credentials; modern hardened
      // Windows hosts often refuse that, so the new default is ICMP. An
      // operator who wants the bind-creds probe sets
      // `responseTimePolling="winrm"` (or "ssh") on the asset and the
      // dispatcher's AD bind fallback handles it.
      const alreadyOwnedByOtherIntegration =
        existing.discoveredByIntegrationId &&
        existing.discoveredByIntegrationId !== integrationId;
      if (adMonitorable && !alreadyOwnedByOtherIntegration) {
        updateData.discoveredByIntegrationId = integrationId;
      }

      try {
        // Auto-Monitor sweep: enforce monitored = addAsMonitored for the
        // resolved class unless the operator has set a divergent override.
        // assetType here is the freshly-inferred value when one applies.
        const sweepAssetType = (updateData.assetType ?? existing.assetType) as string | null | undefined;
        Object.assign(updateData, buildMonitoredSweep(resolveAddAs(sweepAssetType), existing));
        clampAcquiredToLastSeen(updateData, existing);
        await prisma.asset.update({ where: { id: existing.id }, data: updateData });
        logDiscoveryAssetUpdated(adBefore, updateData, existing.id, displayName || dev.objectGuid, {
          integrationName, integrationId, sourceKind: "ad", actor,
        });
        // (AssetSource upsert already happened above the projection step
        //  so the projected fields reflect this run's AD data.)
        updated.push(displayName || dev.objectGuid);
      } catch (err: any) {
        syncLog("error", `Failed to update asset for AD computer ${displayName || dev.objectGuid}: ${err.message || "Unknown error"}`);
      }
      continue;
    }

    // No guid or SID match — check hostname collision. Two flavours:
    // (a) collision with an untagged asset, (b) duplicate AD registration
    // where another ad-tagged asset shares the hostname (rare — same computer
    // re-joined the domain with a different objectGUID — but worth catching).
    // Hostname matching tolerates 15-char NetBIOS truncation so AD's `cn`
    // form can match an Entra-sourced full displayName and vice versa.
    if (hostLookupKey && displayName) {
      const buildProposed = (collisionReason: "untagged-collision" | "duplicate-registration", matchedVia: "exact" | "netbios") => ({
        sourceType: "activedirectory",
        assetTagPrefix: AD_ASSET_TAG_PREFIX,
        deviceId: dev.objectGuid,
        hostname: displayName,
        dnsName: dev.dnsHostName || null,
        os: dev.operatingSystem || null,
        osVersion: dev.operatingSystemVersion || null,
        notes: dev.description || null,
        learnedLocation: dev.ouPath || null,
        objectSid: dev.objectSid || null,
        status,
        assetType,
        lastSeen: dev.lastLogonTimestamp || null,
        registrationDateTime: dev.whenCreated || null,
        disabled: dev.disabled,
        collisionReason,
        matchedVia,
      });

      const untagged = lookupHostname(assetByHostnameNoTag, displayName);
      if (untagged) {
        try {
          await upsertAssetConflict({
            collisionAssetId: untagged.asset.id,
            integrationId,
            proposedDeviceId: dev.objectGuid,
            proposedAssetFields: buildProposed("untagged-collision", untagged.via),
            existingAsset: untagged.asset,
          });
          syncLog("warning", `Hostname collision queued for review — AD computer "${displayName}" (${dev.objectGuid}) matches untagged asset ${untagged.asset.id}${untagged.via === "netbios" ? " (NetBIOS-truncated match)" : ""}.`);
        } catch (err: any) {
          syncLog("error", `Failed to queue hostname-collision conflict for "${displayName}": ${err.message || "Unknown error"}`);
        }
        skipped.push(`${displayName} (hostname collision — pending review)`);
        continue;
      }

      const dupAd = lookupHostname(assetByHostnameAdTagged, displayName);
      if (dupAd) {
        try {
          await upsertAssetConflict({
            collisionAssetId: dupAd.asset.id,
            integrationId,
            proposedDeviceId: dev.objectGuid,
            proposedAssetFields: buildProposed("duplicate-registration", dupAd.via),
            existingAsset: dupAd.asset,
          });
          const existingTag = (dupAd.asset.assetTag || "").slice(AD_ASSET_TAG_PREFIX.length) || "<unknown>";
          syncLog("warning", `Duplicate AD registration queued for review — "${displayName}" (${dev.objectGuid}) shares hostname with existing AD computer ${existingTag}${dupAd.via === "netbios" ? " (NetBIOS-truncated match)" : ""}.`);
        } catch (err: any) {
          syncLog("error", `Failed to queue duplicate-AD-registration conflict for "${displayName}": ${err.message || "Unknown error"}`);
        }
        skipped.push(`${displayName} (duplicate AD registration — pending review)`);
        continue;
      }
    }

    // Create a new asset
    try {
      // Phase 3b.1 cutover: discovery-owned fields come from the projection
      // layer. On create the asset has only its own AD source, so we build
      // the AD observed blob synthetically (same as upsertAdAssetSource will
      // persist a few lines below) and project from a single-source array —
      // no DB roundtrip, projection is pure.
      const now = new Date();
      const adObserved = buildAdObservedBlob(dev, now);
      const { projected } = projectAssetFromSources([
        { sourceKind: "ad", inferred: false, observed: adObserved },
      ]);

      const createData: Record<string, unknown> = {
        // Phase 4d: legacy `assetTag = ad:<objectGuid>` write retired —
        // upsertAdAssetSource below stamps the AssetSource ad row that
        // re-discovery uses as the canonical identity link.
        hostname: projected.hostname,
        dnsName: dev.dnsHostName || null,
        assetType,
        status,
        statusChangedAt: now,
        statusChangedBy: integrationName,
        os: projected.os,
        osVersion: projected.osVersion,
        learnedLocation: projected.learnedLocation,
        notes: dev.description || `Auto-discovered from Active Directory integration "${integrationName}"`,
        // lastSeen stays null on create — lastLogonTimestamp is directory
        // activity (on the AD AssetSource row), not network presence.
        acquiredAt: whenCreated,
        tags,
        // Stamp the AD source link on realm-monitorable hosts so the
        // polling-method resolver picks AD's source default (ICMP) when the
        // operator later enables monitoring on this asset. We no longer
        // stamp `monitorType="activedirectory"` here — see the matching
        // comment on the update path above for the rationale.
        ...(adMonitorable ? { discoveredByIntegrationId: integrationId } : {}),
      };
      // Initial monitored state on create. Only sweep when the AD-source link
      // is being stamped (adMonitorable hosts) — otherwise the asset isn't
      // associated with this integration and the per-class flag shouldn't
      // apply. monitorOverride defaults to false on create.
      if (adMonitorable) {
        Object.assign(createData, buildMonitoredSweep(resolveAddAs(assetType), { monitored: false, monitorOverride: false }));
      }
      clampAcquiredToLastSeen(createData);
      const newAsset = await prisma.asset.create({ data: createData as any });
      // Persist the AD source row. The shadow-write extension already laid
      // down a skeleton row from the assetTag during Asset.create — this
      // overwrites it with the rich observed blob the projection just used.
      try {
        await upsertAdAssetSource(newAsset.id, integrationId, dev, now, lastLogon ?? now);
        // Mirror the new row so a later device in this run that resolves to
        // this asset (SID match) projects with the AD data present. (The
        // shadow-write's manual skeleton row is deliberately not mirrored —
        // it snapshots the same create payload the ad row already carries.)
        sourcesByAssetId.set(newAsset.id, [{ sourceKind: "ad", externalId: guidKey, inferred: false, observed: adObserved, lastSeen: lastLogon ?? now }]);
      } catch (err: any) {
        syncLog("warning", `Created asset for AD computer ${displayName || dev.objectGuid} but failed to upsert AssetSource row: ${err.message || "Unknown error"}`);
      }
      logDiscoveryAssetCreated(newAsset.id, displayName || dev.objectGuid, {
        integrationName, integrationId, sourceKind: "ad", actor,
      });
      // Refresh the in-memory indexes so subsequent devices in this run see
      // the new asset (e.g. duplicate-registration detection, SID match).
      assetById.set(newAsset.id, newAsset);
      adSourceByGuid.set(guidKey, { source: null, asset: newAsset });
      assetIdsWithAdSource.add(newAsset.id);
      if (dev.objectSid) assetIdBySid.set(dev.objectSid.toUpperCase(), newAsset.id);
      created.push(displayName || dev.objectGuid);
    } catch (err: any) {
      syncLog("error", `Failed to create asset for AD computer ${displayName || dev.objectGuid}: ${err.message || "Unknown error"}`);
    }
  }

  syncLog("info", `Active Directory sync: ${created.length} created, ${updated.length} updated, ${skipped.length} skipped`);
  return { created, updated, skipped };
}

// ─── vCenter asset sync ──────────────────────────────────────────────────────

// Tags the vCenter discovery auto-assigns each run (stripped and re-added on
// update). Cross-integration identity lives on AssetSource, never in tags.
function isVcenterManagedTag(t: string): boolean {
  if (t.startsWith("vcenter")) return true;
  return t === "auto-discovered";
}

function buildVcenterHostObservedBlob(
  host: vcenter.DiscoveredVcenterHost,
  syncedAt: Date,
): Record<string, unknown> {
  return {
    kind: "vcenter-host",
    syncedAt: syncedAt.toISOString(),
    moref: host.moref,
    name: host.name || null,
    connectionState: host.connectionState || null,
    powerState: host.powerState || null,
    clusterMoref: host.clusterMoref,
    clusterName: host.clusterName,
    resolvedIp: host.resolvedIp,
  };
}

function buildVcenterVmObservedBlob(
  vm: vcenter.DiscoveredVcenterVm,
  syncedAt: Date,
): Record<string, unknown> {
  return {
    kind: "vcenter-vm",
    syncedAt: syncedAt.toISOString(),
    moref: vm.moref,
    instanceUuid: vm.instanceUuid,
    biosUuid: vm.biosUuid,
    name: vm.name || null,
    guestHostname: vm.guestHostname,
    guestIp: vm.guestIp,
    guestOsFullName: vm.guestOsFullName,
    powerState: vm.powerState || null,
    toolsRunState: vm.toolsRunState,
    toolsVersionStatus: vm.toolsVersionStatus,
    cpuCount: vm.cpuCount,
    memoryMiB: vm.memoryMiB,
  };
}

// Upsert one vcenter-vm / vcenter-host AssetSource row, then sweep stale rows
// of the same kind on the same asset whose externalId changed (a VM
// re-registered under a new instanceUuid must not leave the prior identity
// linked — the Entra deviceId-sweep pattern).
/**
 * Upsert a vcenter-vm / vcenter-host source row.
 *
 * `hasStaleExternalId` (from the caller's preloaded source map) gates the
 * cleanup delete: a VM's externalId only changes when its instanceUuid first
 * becomes readable (pickVmExternalId prefers it over the moref fallback), so
 * on a steady inventory the delete was one no-op round trip per VM per run.
 * Undefined keeps the unconditional behavior.
 */
async function upsertVcenterAssetSource(
  assetId: string,
  integrationId: string,
  sourceKind: "vcenter-vm" | "vcenter-host",
  externalId: string,
  observed: Record<string, unknown>,
  syncedAt: Date,
  lastSeen: Date,
  hasStaleExternalId?: boolean,
): Promise<void> {
  await prisma.assetSource.upsert({
    where: { sourceKind_externalId: { sourceKind, externalId } },
    create: { assetId, sourceKind, externalId, integrationId, observed: observed as any, inferred: false, syncedAt, firstSeen: lastSeen, lastSeen },
    update: { assetId, integrationId, observed: observed as any, inferred: false, syncedAt, lastSeen },
  });
  if (hasStaleExternalId !== false) {
    await prisma.assetSource.deleteMany({
      where: { assetId, sourceKind, externalId: { not: externalId } },
    });
  }
}

// Exported for tests, like the Entra/AD syncs: the map-fed projection must
// stay faithful to the DB rows, and only a real round trip proves it.
export async function syncVcenterDevices(
  integrationId: string,
  integrationName: string,
  integrationConfig: Record<string, unknown> | null,
  result: vcenter.VcenterDiscoveryResult,
  actor?: string,
  /** "scoped" disables every fleet-absence pass — see `vcenterPassEnabled`. */
  mode: VcenterSyncMode = "full",
): Promise<{ created: string[]; updated: string[]; skipped: string[]; decommissioned: string[] }> {
  const syncLog = (level: "info" | "error" | "warning", message: string) => {
    logEvent({ action: "integration.sync", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level, message: `[${integrationName}] ${message}` });
  };
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const now = new Date();

  // Per-class addAsMonitored snapshot for the auto-monitor sweep. VMs are
  // typed "server" (the virtual_machine built-in was retired 2026-07), which
  // under a vcenter integration resolves to the vmMonitor block.
  const vmAddAs   = getAddAsMonitoredFromConfig("vcenter", integrationConfig, "server");
  const hostAddAs = getAddAsMonitoredFromConfig("vcenter", integrationConfig, "hypervisor");

  // Load the asset table (tight select — every column this sync's loops, the
  // material-field snapshot, the conflict snapshot, buildMonitoredSweep and
  // bumpLastSeen read; the unprojected load pulled every column of every
  // asset, JSON blobs included) with MAC rows hydrated for the vNIC identity
  // join, plus the AssetSource index.
  const allAssetsWithRows = await prisma.asset.findMany({
    select: {
      id: true, hostname: true, hostnameOverride: true, assetType: true, status: true,
      monitored: true, monitorOverride: true, acquiredAt: true, lastSeen: true,
      tags: true, discoveredByIntegrationId: true, dnsName: true, ipAddress: true,
      os: true, osVersion: true, serialNumber: true, manufacturer: true, model: true,
      learnedLocation: true, learnedAddress: true, notes: true, assignedTo: true,
      macAddress: true, dependencyLayer: true,
      macAddressRows: { select: MAC_ROW_SELECT },
    },
  });
  const allAssets = allAssetsWithRows.map((a: any) => ({
    ...a,
    macAddresses: shapeMacRows(a.macAddressRows),
  }));
  const assetById = new Map<string, any>();
  for (const a of allAssets) assetById.set(a.id, a);

  // ALL kinds, tight select: the vcenter kinds feed the identity indexes
  // below, and every kind feeds sourcesByAssetId — the projection input, which
  // this sync mirrors its own upserts into rather than re-reading per device
  // (the Entra/AD pattern; a VM merged onto a directory asset projects from
  // its ad/entra/agent rows too).
  const vcenterSources = await prisma.assetSource.findMany({
    select: { assetId: true, sourceKind: true, externalId: true, integrationId: true, inferred: true, observed: true, lastSeen: true },
  });
  const assetByVmExternalId = new Map<string, any>();
  const assetByHostExternalId = new Map<string, any>();
  const assetIdsWithVcenterSource = new Set<string>();
  const sourcesByAssetId = new Map<string, EntraSourceEntry[]>();
  // Asset ids that carried a vcenter-vm source from THIS integration before
  // this run — captured pre-sweep so the dependency-edge delete-replace can
  // clear edges off VMs that vanished from the inventory.
  const priorVmAssetIds = new Set<string>();
  for (const src of vcenterSources) {
    const list = sourcesByAssetId.get(src.assetId);
    const entry: EntraSourceEntry = { sourceKind: src.sourceKind, externalId: src.externalId, inferred: src.inferred, observed: (src.observed as Record<string, unknown> | null) || {}, lastSeen: src.lastSeen };
    if (list) list.push(entry); else sourcesByAssetId.set(src.assetId, [entry]);
    if (src.sourceKind !== "vcenter-vm" && src.sourceKind !== "vcenter-host") continue;
    assetIdsWithVcenterSource.add(src.assetId);
    const a = assetById.get(src.assetId);
    if (src.sourceKind === "vcenter-vm") {
      if (a) assetByVmExternalId.set(src.externalId, a);
      if (src.integrationId === integrationId) priorVmAssetIds.add(src.assetId);
    } else if (a) {
      assetByHostExternalId.set(src.externalId, a);
    }
  }

  // Mirror of upsertVcenterAssetSource's DB effects into the preloaded map,
  // plus the hint that tells it whether its cleanup delete can match anything.
  // Unlike Entra this cannot move a row between assets: a vcenter externalId
  // already in the fleet-wide index resolves to its own asset in the cascade.
  const vcenterStaleHint = (assetId: string, kind: "vcenter-vm" | "vcenter-host", externalId: string): boolean =>
    (sourcesByAssetId.get(assetId) ?? []).some((s) => s.sourceKind === kind && s.externalId !== externalId);
  const applyVcenterSourceInMemory = (
    assetId: string,
    kind: "vcenter-vm" | "vcenter-host",
    externalId: string,
    observed: Record<string, unknown>,
    lastSeenVal: Date,
  ): void => {
    let list = sourcesByAssetId.get(assetId);
    if (!list) { list = []; sourcesByAssetId.set(assetId, list); }
    const row = list.find((s) => s.sourceKind === kind && s.externalId === externalId);
    if (row) { row.observed = observed; row.inferred = false; row.lastSeen = lastSeenVal; }
    else list.push({ sourceKind: kind, externalId, inferred: false, observed, lastSeen: lastSeenVal });
    // The helper's cleanup delete: same kind on this asset at any other id.
    sourcesByAssetId.set(assetId, list.filter((s) => !(s.sourceKind === kind && s.externalId !== externalId)));
  };

  // Hostname-collision map (assets with no vcenter source — directory /
  // Fortinet / manual) and the all-assets MAC index for the vNIC join.
  const assetByHostnameNoVcenter = new Map<string, any>();
  const assetByMac = new Map<string, any>();
  for (const a of allAssets) {
    if (a.hostname && !assetIdsWithVcenterSource.has(a.id)) {
      indexHostname(assetByHostnameNoVcenter, a.hostname, a);
    }
    const primaryKey = normalizeMacKey(a.macAddress);
    if (primaryKey && !assetByMac.has(primaryKey)) assetByMac.set(primaryKey, a);
    if (Array.isArray(a.macAddresses)) {
      for (const m of a.macAddresses as any[]) {
        const k = normalizeMacKey(m?.mac);
        if (k && !assetByMac.has(k)) assetByMac.set(k, a);
      }
    }
  }

  // Cluster context (drives the vMotion-safe multi-parent dependency edges).
  const clusterMorefByHostMoref = new Map<string, string>();
  const clusterHostMorefs = new Map<string, string[]>();
  const hostByMoref = new Map<string, vcenter.DiscoveredVcenterHost>();
  for (const host of result.hosts) {
    hostByMoref.set(host.moref, host);
    if (host.clusterMoref) {
      clusterMorefByHostMoref.set(host.moref, host.clusterMoref);
      const members = clusterHostMorefs.get(host.clusterMoref) ?? [];
      members.push(host.moref);
      clusterHostMorefs.set(host.clusterMoref, members);
    }
  }
  const datastoreByMoref = new Map(result.datastores.map((d) => [d.moref, d]));

  // ── Pass A — ESXi hosts (first, so VM rows can link hostAssetId) ──────────
  const hostAssetIdByMoref = new Map<string, string>();
  const currentHostExternalIds: string[] = [];

  for (const host of result.hosts) {
    const externalId = vcenter.hostExternalId(host.moref, integrationId);
    currentHostExternalIds.push(externalId);
    const observed = buildVcenterHostObservedBlob(host, now);
    const existing: any = assetByHostExternalId.get(externalId) ?? null;
    // Virtual networking comes from the SOAP host fetch, which can fail on its
    // own while the REST host list (everything else in this blob) succeeded —
    // so `null` here means "not read this run", not "this host has no
    // vSwitches". Carry the last known lists forward rather than blanking the
    // General-tab section until the next 12h cycle.
    const priorVirt = (existing?.virtualization ?? null) as Record<string, unknown> | null;
    const virtualization = {
      role: "host",
      vcenterIntegrationId: integrationId,
      hostMoref: host.moref,
      clusterMoref: host.clusterMoref,
      clusterName: host.clusterName,
      standalone: host.clusterMoref === null,
      connectionState: host.connectionState || null,
      powerState: host.powerState || null,
      datastoreMorefs: host.datastoreMorefs,
      vswitches:  host.vswitches  ?? priorVirt?.vswitches  ?? null,
      portgroups: host.portgroups ?? priorVirt?.portgroups ?? null,
    };
    const connected = host.connectionState === "CONNECTED";

    if (!existing) {
      // Hostname collision with a non-vcenter asset → pending Conflict for
      // the operator (an ESXi host may already exist as a manually-created
      // or directory-discovered server).
      if (host.name) {
        const collision = lookupHostname(assetByHostnameNoVcenter, host.name);
        if (collision) {
          try {
            await upsertAssetConflict({
              collisionAssetId: collision.asset.id,
              integrationId,
              proposedDeviceId: externalId,
              proposedAssetFields: {
                sourceType: "vcenter",
                deviceId: externalId,
                hostname: host.name,
                os: "VMware ESXi",
                assetType: "hypervisor",
                clusterName: host.clusterName,
                ipAddress: host.resolvedIp,
                collisionReason: "untagged-collision",
                matchedVia: collision.via,
              },
              existingAsset: collision.asset,
            });
            syncLog("warning", `Hostname collision queued for review — ESXi host "${host.name}" matches existing asset ${collision.asset.id}${collision.via === "netbios" ? " (NetBIOS-truncated match)" : ""}.`);
          } catch (err: any) {
            syncLog("error", `Failed to queue hostname-collision conflict for ESXi host "${host.name}": ${err.message || "Unknown error"}`);
          }
          skipped.push(`${host.name} (hostname collision — pending review)`);
          continue;
        }
      }

      // Create the hypervisor asset.
      try {
        const { projected } = projectAssetFromSources([
          { sourceKind: "vcenter-host", inferred: false, observed },
        ]);
        const createData: Record<string, unknown> = {
          hostname: projected.hostname ?? host.name ?? host.moref,
          ipAddress: projected.ipAddress,
          os: projected.os,
          assetType: "hypervisor",
          status: "active",
          statusChangedAt: now,
          statusChangedBy: integrationName,
          manufacturer: projected.manufacturer,
          model: projected.model,
          notes: `Auto-discovered from vCenter integration "${integrationName}"${host.clusterName ? ` (cluster: ${host.clusterName})` : ""}`,
          tags: ["vcenter", "auto-discovered"],
          virtualization: virtualization as any,
          dependencyLayer: 1,
          discoveredByIntegrationId: integrationId,
        };
        if (connected) bumpLastSeen(createData, null, now, "vcenter");
        Object.assign(createData, buildMonitoredSweep(hostAddAs, { monitored: false, monitorOverride: false }));
        clampAcquiredToLastSeen(createData);
        const newAsset = await prisma.asset.create({ data: createData as any });
        try {
          await upsertVcenterAssetSource(newAsset.id, integrationId, "vcenter-host", externalId, observed, now, connected ? now : now);
          applyVcenterSourceInMemory(newAsset.id, "vcenter-host", externalId, observed, now);
        } catch (err: any) {
          syncLog("warning", `Created asset for ESXi host ${host.name} but failed to upsert AssetSource row: ${err.message || "Unknown error"}`);
        }
        logDiscoveryAssetCreated(newAsset.id, host.name || host.moref, {
          integrationName, integrationId, sourceKind: "vcenter-host", actor,
        });
        assetById.set(newAsset.id, newAsset);
        assetByHostExternalId.set(externalId, newAsset);
        assetIdsWithVcenterSource.add(newAsset.id);
        hostAssetIdByMoref.set(host.moref, newAsset.id);
        created.push(host.name || host.moref);
      } catch (err: any) {
        syncLog("error", `Failed to create asset for ESXi host ${host.name || host.moref}: ${err.message || "Unknown error"}`);
      }
      continue;
    }

    // Update the existing host asset (source-first, then projection, single write).
    const hostSeen = connected ? now : (existing.lastSeen ?? now);
    try {
      await upsertVcenterAssetSource(existing.id, integrationId, "vcenter-host", externalId, observed, now, hostSeen, vcenterStaleHint(existing.id, "vcenter-host", externalId));
      applyVcenterSourceInMemory(existing.id, "vcenter-host", externalId, observed, hostSeen);
    } catch (err: any) {
      syncLog("warning", `Failed to upsert vcenter-host AssetSource row for ${host.name || host.moref}: ${err.message || "Unknown error"}`);
    }
    try {
      const { projected } = projectAssetFromSources(sourcesByAssetId.get(existing.id) ?? []);
      const hostBefore = snapshotMaterialAssetFields(existing);
      const updateData: Record<string, unknown> = {
        virtualization: virtualization as any,
      };
      if (projected.hostname !== null) updateData.hostname = projected.hostname;
      if (projected.os !== null) updateData.os = projected.os;
      if (projected.ipAddress !== null) updateData.ipAddress = projected.ipAddress;
      // Layer stamp only on vcenter-typed assets — never clobber a Fortinet-
      // computed layer on some exotic merge target.
      if (existing.assetType === "hypervisor") updateData.dependencyLayer = 1;
      if (existing.assetType === "other") updateData.assetType = "hypervisor";
      if (connected) bumpLastSeen(updateData, existing, now, "vcenter");
      Object.assign(updateData, buildMonitoredSweep(
        ((updateData.assetType as string) ?? existing.assetType) === "hypervisor" ? hostAddAs : null,
        existing,
      ));
      const preserved = ((existing.tags as string[]) || []).filter((t) => !isVcenterManagedTag(t));
      const freshTags = ["vcenter", "auto-discovered"];
      updateData.tags = [...preserved, ...freshTags.filter((t) => !preserved.includes(t))];
      clampAcquiredToLastSeen(updateData, existing);
      await prisma.asset.update({ where: { id: existing.id }, data: updateData });
      logDiscoveryAssetUpdated(hostBefore, updateData, existing.id, host.name || host.moref, {
        integrationName, integrationId, sourceKind: "vcenter-host", actor,
      });
      hostAssetIdByMoref.set(host.moref, existing.id);
      updated.push(host.name || host.moref);
    } catch (err: any) {
      syncLog("error", `Failed to update asset for ESXi host ${host.name || host.moref}: ${err.message || "Unknown error"}`);
    }
    // Sibling hostname collision — same both-assets-exist detection as the
    // VM pass below (an ESXi host may also live on as a manually-created or
    // directory-discovered server asset). See the VM-pass comment.
    {
      const sibling = host.name ? lookupHostname(assetByHostnameNoVcenter, host.name) : null;
      if (sibling && sibling.asset.id !== existing.id && !assetIdsWithVcenterSource.has(sibling.asset.id)) {
        try {
          await upsertAssetConflict({
            collisionAssetId: sibling.asset.id,
            integrationId,
            proposedDeviceId: externalId,
            proposedAssetFields: {
              sourceType: "vcenter",
              deviceId: externalId,
              hostname: host.name,
              os: "VMware ESXi",
              assetType: "hypervisor",
              clusterName: host.clusterName,
              ipAddress: host.resolvedIp,
              collisionReason: "untagged-collision",
              matchedVia: sibling.via,
              bothAssetsExist: true,
            },
            existingAsset: sibling.asset,
          });
          syncLog("warning", `Sibling hostname collision queued for review — ESXi host "${host.name}" has its own asset but asset ${sibling.asset.hostname || sibling.asset.id} shares the same hostname${sibling.via === "netbios" ? " (NetBIOS-truncated match)" : ""}. Accept in Conflicts to merge them.`);
        } catch (err: any) {
          syncLog("error", `Failed to queue sibling hostname-collision conflict for ESXi host "${host.name}": ${err.message || "Unknown error"}`);
        }
      }
    }
  }

  // ── Pass B — virtual machines ──────────────────────────────────────────────
  const currentVmExternalIds: string[] = [];
  const placements: Array<{ vmAssetId: string; hostMoref: string }> = [];

  for (const vm of result.vms) {
    const externalId = vcenter.pickVmExternalId(vm, integrationId);
    currentVmExternalIds.push(externalId);
    const displayName = vm.guestHostname || vm.name || vm.moref;
    const observed = buildVcenterVmObservedBlob(vm, now);
    const hostRow = hostByMoref.get(vm.hostMoref) ?? null;
    // Placement, mirrored onto the source blob so the Sources column can read
    // "where does this VM live" without loading Asset.virtualization. The
    // authoritative copy stays on `virtualization` below.
    observed.hostName = hostRow?.name ?? null;
    observed.clusterName = hostRow?.clusterName ?? null;
    const poweredOn = vm.powerState === "POWERED_ON";
    const virtualization = {
      role: "vm",
      vcenterIntegrationId: integrationId,
      vmMoref: vm.moref,
      instanceUuid: vm.instanceUuid,
      biosUuid: vm.biosUuid,
      hostMoref: vm.hostMoref,
      hostAssetId: hostAssetIdByMoref.get(vm.hostMoref) ?? null,
      hostName: hostRow?.name ?? null,
      clusterMoref: hostRow?.clusterMoref ?? null,
      clusterName: hostRow?.clusterName ?? null,
      standaloneHost: (hostRow?.clusterMoref ?? null) === null,
      powerState: vm.powerState || null,
      toolsRunState: vm.toolsRunState,
      toolsVersionStatus: vm.toolsVersionStatus,
      guestOsFullName: vm.guestOsFullName,
      cpuCount: vm.cpuCount,
      memoryMiB: vm.memoryMiB,
      cpuUsageMhz: vm.cpuUsageMhz,
      cpuMaxMhz: vm.cpuMaxMhz,
      memUsedBytes: vm.memUsedBytes,
      disks: vm.disks.map((d) => ({
        key: d.key,
        label: d.label,
        capacityBytes: d.capacityBytes,
        datastoreMoref: d.datastoreMoref,
        datastoreName: d.datastoreName ?? (d.datastoreMoref ? datastoreByMoref.get(d.datastoreMoref)?.name ?? null : null),
      })),
    };

    // vNIC MAC entries, connected-first so the primary MAC is stable.
    const nowIso = now.toISOString();
    const vmMacEntries = [...vm.nicMacs]
      .sort((a, b) => Number(b.connected) - Number(a.connected))
      .map((n) => ({ mac: n.mac, source: "vcenter-vnic" }));
    const mergeVmMacs = (existingMacs: any[]): { primary: string | null; merged: any[] } => {
      const merged = Array.isArray(existingMacs) ? [...existingMacs] : [];
      for (const e of vmMacEntries) {
        const key = normalizeMacKey(e.mac);
        if (!key) continue;
        const hit = merged.find((m: any) => normalizeMacKey(m?.mac) === key);
        if (hit) {
          hit.lastSeen = nowIso;
          hit.source = e.source;
        } else {
          merged.push({ mac: e.mac, lastSeen: nowIso, source: e.source });
        }
      }
      merged.sort((a: any, b: any) => new Date(b.lastSeen || 0).getTime() - new Date(a.lastSeen || 0).getTime());
      // vcenter-vnic rows are hardware truth — see selectPrimaryMac.
      return { primary: selectPrimaryMac(merged) ?? merged[0]?.mac ?? null, merged };
    };

    // Match cascade: (1) vcenter-vm source by externalId → (2) vNIC MAC
    // (positive identity — the VM already exists via AD/Entra/FortiGate) →
    // (3) hostname collision → Conflict → (4) create.
    let existing: any = assetByVmExternalId.get(externalId) ?? null;
    if (!existing) {
      for (const nic of vmMacEntries) {
        const key = normalizeMacKey(nic.mac);
        if (!key) continue;
        const macMatch = assetByMac.get(key);
        if (macMatch) {
          existing = macMatch;
          syncLog("info", `MAC cross-link: vCenter VM "${displayName}" vNIC MAC ${nic.mac} matched existing asset ${macMatch.hostname || macMatch.id}${assetIdsWithVcenterSource.has(macMatch.id) ? "" : " (taking over)"}.`);
          break;
        }
      }
    }

    if (existing) {
      const vmSeen = poweredOn ? now : (existing.lastSeen ?? now);
      try {
        await upsertVcenterAssetSource(existing.id, integrationId, "vcenter-vm", externalId, observed, now, vmSeen, vcenterStaleHint(existing.id, "vcenter-vm", externalId));
        applyVcenterSourceInMemory(existing.id, "vcenter-vm", externalId, observed, vmSeen);
      } catch (err: any) {
        syncLog("warning", `Failed to upsert vcenter-vm AssetSource row for ${displayName}: ${err.message || "Unknown error"}`);
      }
      try {
        const { projected } = projectAssetFromSources(sourcesByAssetId.get(existing.id) ?? []);
        const vmBefore = snapshotMaterialAssetFields(existing);
        const updateData: Record<string, unknown> = {
          virtualization: virtualization as any,
        };
        if (projected.hostname !== null) updateData.hostname = projected.hostname;
        if (projected.os !== null) updateData.os = projected.os;
        if (projected.osVersion !== null) updateData.osVersion = projected.osVersion;
        if (projected.manufacturer !== null) updateData.manufacturer = projected.manufacturer;
        if (projected.model !== null) updateData.model = projected.model;
        if (projected.ipAddress !== null) updateData.ipAddress = projected.ipAddress;
        // Type flip only from the "other" default — a directory-typed
        // workstation/server keeps its class (and thus its monitoring
        // class-block); the Virtualization section marks it as a VM anyway.
        if (existing.assetType === "other") updateData.assetType = "server";
        // "vCenter-classed" = a server-typed asset this integration owns (or
        // just took over via the other→server flip). Since VMs share the
        // "server" type with directory-discovered machines, ownership — not
        // the type — is what gates the vm-class layer stamp and monitored
        // sweep, so vCenter never fights a directory integration over a
        // MAC-matched server it merely enriches.
        const vmClassed =
          ((updateData.assetType as string) ?? existing.assetType) === "server" &&
          (existing.discoveredByIntegrationId === integrationId || updateData.assetType === "server");
        if (vmClassed) updateData.dependencyLayer = 2;
        let vmMergedMacs: MacJsonEntry[] | null = null;
        if (vmMacEntries.length > 0) {
          const { primary, merged } = mergeVmMacs(existing.macAddresses as any[]);
          vmMergedMacs = merged as MacJsonEntry[];
          if (primary) updateData.macAddress = primary;
        }
        if (poweredOn) bumpLastSeen(updateData, existing, now, "vcenter");
        Object.assign(updateData, buildMonitoredSweep(vmClassed ? vmAddAs : null, existing));
        const preserved = ((existing.tags as string[]) || []).filter((t) => !isVcenterManagedTag(t));
        const freshTags = ["vcenter", "auto-discovered"];
        updateData.tags = [...preserved, ...freshTags.filter((t) => !preserved.includes(t))];
        clampAcquiredToLastSeen(updateData, existing);
        await prisma.asset.update({ where: { id: existing.id }, data: updateData });
        logDiscoveryAssetUpdated(vmBefore, updateData, existing.id, displayName, {
          integrationName, integrationId, sourceKind: "vcenter-vm", actor,
        });
        if (vmMergedMacs) await reconcileMacAddresses(existing.id, vmMergedMacs);
        assetByVmExternalId.set(externalId, existing);
        assetIdsWithVcenterSource.add(existing.id);
        placements.push({ vmAssetId: existing.id, hostMoref: vm.hostMoref });
        updated.push(displayName);
      } catch (err: any) {
        syncLog("error", `Failed to update asset for vCenter VM ${displayName}: ${err.message || "Unknown error"}`);
      }
      // Sibling hostname collision — this VM already has its own Polaris
      // asset, but a second asset with no vCenter link shares the hostname
      // (the directory discovered the guest separately and no vNIC MAC tied
      // them together, or both predate the vCenter integration). Mirrors the
      // Entra sibling check: raise a review conflict so the operator merges
      // from the Conflicts queue — accept absorbs this VM's asset into the
      // sibling — instead of hunting through Sources → Merge asset.
      // upsertAssetConflict skips pairs the operator already resolved;
      // `bothAssetsExist` tells resolution not to create anything on reject.
      {
        const siblingName = vm.guestHostname || vm.name;
        const sibling = siblingName ? lookupHostname(assetByHostnameNoVcenter, siblingName) : null;
        if (sibling && sibling.asset.id !== existing.id && !assetIdsWithVcenterSource.has(sibling.asset.id)) {
          try {
            await upsertAssetConflict({
              collisionAssetId: sibling.asset.id,
              integrationId,
              proposedDeviceId: externalId,
              proposedAssetFields: {
                sourceType: "vcenter",
                deviceId: externalId,
                hostname: siblingName,
                macAddress: vmMacEntries[0]?.mac ?? null,
                os: vm.guestOsFullName,
                assetType: "server",
                ipAddress: vm.guestIp,
                powerState: vm.powerState || null,
                hostName: hostRow?.name ?? null,
                clusterName: hostRow?.clusterName ?? null,
                collisionReason: "untagged-collision",
                matchedVia: sibling.via,
                bothAssetsExist: true,
              },
              existingAsset: sibling.asset,
            });
            syncLog("warning", `Sibling hostname collision queued for review — vCenter VM "${displayName}" has its own asset but asset ${sibling.asset.hostname || sibling.asset.id} shares the same hostname${sibling.via === "netbios" ? " (NetBIOS-truncated match)" : ""}. Accept in Conflicts to merge them.`);
          } catch (err: any) {
            syncLog("error", `Failed to queue sibling hostname-collision conflict for VM "${displayName}": ${err.message || "Unknown error"}`);
          }
        }
      }
      continue;
    }

    // Hostname collision with a non-vcenter asset → pending Conflict.
    const collisionName = vm.guestHostname || vm.name;
    if (collisionName) {
      const collision = lookupHostname(assetByHostnameNoVcenter, collisionName);
      if (collision) {
        try {
          await upsertAssetConflict({
            collisionAssetId: collision.asset.id,
            integrationId,
            proposedDeviceId: externalId,
            proposedAssetFields: {
              sourceType: "vcenter",
              deviceId: externalId,
              hostname: collisionName,
              macAddress: vmMacEntries[0]?.mac ?? null,
              os: vm.guestOsFullName,
              assetType: "server",
              ipAddress: vm.guestIp,
              powerState: vm.powerState || null,
              hostName: hostRow?.name ?? null,
              clusterName: hostRow?.clusterName ?? null,
              collisionReason: "untagged-collision",
              matchedVia: collision.via,
            },
            existingAsset: collision.asset,
          });
          syncLog("warning", `Hostname collision queued for review — vCenter VM "${displayName}" (${externalId}) matches existing asset ${collision.asset.id}${collision.via === "netbios" ? " (NetBIOS-truncated match)" : ""}.`);
        } catch (err: any) {
          syncLog("error", `Failed to queue hostname-collision conflict for VM "${displayName}": ${err.message || "Unknown error"}`);
        }
        skipped.push(`${displayName} (hostname collision — pending review)`);
        continue;
      }
    }

    // Create the VM asset.
    try {
      const { projected } = projectAssetFromSources([
        { sourceKind: "vcenter-vm", inferred: false, observed },
      ]);
      const seeded = mergeVmMacs([]);
      const createData: Record<string, unknown> = {
        hostname: projected.hostname ?? vm.name,
        macAddress: seeded.primary,
        ...(seeded.merged.length > 0
          ? { macAddressRows: { create: buildMacRowsForCreate(seeded.merged as MacJsonEntry[]) } }
          : {}),
        ipAddress: projected.ipAddress,
        os: projected.os,
        osVersion: projected.osVersion,
        manufacturer: projected.manufacturer,
        model: projected.model,
        assetType: "server",
        status: "active",
        statusChangedAt: now,
        statusChangedBy: integrationName,
        notes: `Auto-discovered from vCenter integration "${integrationName}"${hostRow?.clusterName ? ` (cluster: ${hostRow.clusterName})` : ""}`,
        tags: ["vcenter", "auto-discovered"],
        virtualization: virtualization as any,
        dependencyLayer: 2,
        discoveredByIntegrationId: integrationId,
      };
      if (poweredOn) bumpLastSeen(createData, null, now, "vcenter");
      Object.assign(createData, buildMonitoredSweep(vmAddAs, { monitored: false, monitorOverride: false }));
      clampAcquiredToLastSeen(createData);
      const newAsset = await prisma.asset.create({ data: createData as any });
      try {
        await upsertVcenterAssetSource(newAsset.id, integrationId, "vcenter-vm", externalId, observed, now, poweredOn ? now : now);
        applyVcenterSourceInMemory(newAsset.id, "vcenter-vm", externalId, observed, now);
      } catch (err: any) {
        syncLog("warning", `Created asset for vCenter VM ${displayName} but failed to upsert AssetSource row: ${err.message || "Unknown error"}`);
      }
      logDiscoveryAssetCreated(newAsset.id, displayName, {
        integrationName, integrationId, sourceKind: "vcenter-vm", actor,
      });
      assetById.set(newAsset.id, newAsset);
      assetByVmExternalId.set(externalId, newAsset);
      assetIdsWithVcenterSource.add(newAsset.id);
      // Index the fresh MACs so a later VM in this run can't duplicate.
      for (const e of vmMacEntries) {
        const k = normalizeMacKey(e.mac);
        if (k && !assetByMac.has(k)) assetByMac.set(k, newAsset);
      }
      placements.push({ vmAssetId: newAsset.id, hostMoref: vm.hostMoref });
      created.push(displayName);
    } catch (err: any) {
      syncLog("error", `Failed to create asset for vCenter VM ${displayName}: ${err.message || "Unknown error"}`);
    }
  }

  // ── Pass C — dependency edges (vMotion-safe multi-parent) ─────────────────
  // Clustered VM → one edge per cluster-member host, so the all-down
  // multi-parent semantics suppress it only when the whole cluster is dark.
  // Delete-replace scoped strictly to source="vcenter" rows on this
  // integration's VM assets (prior + current) — never touches the Fortinet
  // "computed" rows or operator "override" rows.
  //
  // SKIPPED on a scoped run. `priorVmAssetIds` is every VM asset this
  // integration owns, so a one-VM run would delete the vcenter dependency edges
  // off the WHOLE fleet and recreate only the scoped VM's — silently disabling
  // VM→host dependency suppression everywhere until the next full run.
  if (vcenterPassEnabled(mode, "dependency-edges")) try {
    const edges = vcenter.buildVcenterDependencyEdges(
      placements,
      hostAssetIdByMoref,
      clusterMorefByHostMoref,
      clusterHostMorefs,
    );
    const scopeIds = [...new Set([...priorVmAssetIds, ...placements.map((p) => p.vmAssetId)])];
    await prisma.$transaction([
      ...(scopeIds.length > 0
        ? [prisma.assetDependencyParent.deleteMany({ where: { source: "vcenter", assetId: { in: scopeIds } } })]
        : []),
      ...(edges.length > 0
        ? [prisma.assetDependencyParent.createMany({
            data: edges.map((e) => ({ assetId: e.assetId, parentAssetId: e.parentAssetId, source: "vcenter", detectedVia: "hypervisor" })),
            skipDuplicates: true,
          })]
        : []),
    ]);
    if (edges.length > 0) {
      syncLog("info", `Dependency edges refreshed — ${edges.length} VM→host edge(s) across ${hostAssetIdByMoref.size} host(s).`);
    }
  } catch (err: any) {
    syncLog("error", `Failed to refresh VM→host dependency edges: ${err.message || "Unknown error"}`);
  }

  // ── Pass D — datastores (current-state delete-replace) + stale sweep ──────
  //
  // SKIPPED on a scoped run for the bluntest possible reason: it is a
  // delete-replace keyed on the INTEGRATION, and a scoped result carries no
  // datastore reads to replace them with, so it would empty the table.
  if (vcenterPassEnabled(mode, "datastores")) try {
    const toBigInt = (n: number | null): bigint | null =>
      n === null || !Number.isFinite(n) ? null : BigInt(Math.round(n));
    await prisma.$transaction([
      prisma.vcenterDatastore.deleteMany({ where: { integrationId } }),
      ...(result.datastores.length > 0
        ? [prisma.vcenterDatastore.createMany({
            data: result.datastores.map((d) => ({
              integrationId,
              moref: d.moref,
              name: d.name,
              dsType: d.dsType,
              capacityBytes: toBigInt(d.capacityBytes),
              freeBytes: toBigInt(d.freeBytes),
              provisionedBytes: toBigInt(d.provisionedBytes),
              accessible: d.accessible,
              hostMorefs: d.hostMorefs,
              backing: (d.backing ?? undefined) as any,
              backingLabel: d.backingLabel,
            })),
          })]
        : []),
    ]);
  } catch (err: any) {
    syncLog("error", `Failed to persist datastores: ${err.message || "Unknown error"}`);
  }

  // ── Pass E — stale AssetSource sweep + the assets that lose their last one ─
  //
  // Rows from THIS integration whose externalId no longer appears in the
  // inventory (VM deleted, host removed from vCenter). An asset that keeps ANY
  // other source row — a directory record, an Arc row, a reporting Polaris
  // Agent, the `manual` row of an operator-created asset — is still claimed by
  // something and is left exactly as it is; only an asset whose LAST source was
  // the vanished vCenter identity is decommissioned. Aging out on inactivity
  // (months) stays with decommissionStaleAssets; this is the evidence-based
  // path, and it is deliberately narrow because absence from a discovery read
  // has three innocent causes:
  //
  //   1. A partial run. Each per-host VM list failure is caught and logged so
  //      one unreachable ESXi host can't fail the whole run — which means an
  //      incomplete inventory looks exactly like a deleted fleet.
  //      `result.inventoryComplete` is false in that case and BOTH the sweep
  //      and the decommission are skipped: deleting the sources alone would
  //      leave the next (complete) run with nothing left to notice.
  //   2. An empty read. Zero hosts AND zero VMs against a fleet that had
  //      vcenter sources is a credential/permission answer far more often than
  //      a genuinely emptied vCenter (business rule 35's shrunken-read guard,
  //      same reasoning).
  //   3. A filter change. `config.vmInclude`/`vmExclude` drops VMs before the
  //      detail fan-out, so a filtered-out VM is absent from `result.vms` while
  //      still very much existing — the FortiGate roster sweep makes the same
  //      call (flipping a filter must not decommission). `presentVmMorefs` is
  //      the raw pre-filter listing, so those rows are RETAINED rather than
  //      swept, which also means re-widening the filter re-matches the same
  //      asset instead of orphaning its identity.
  const decommissioned: string[] = [];
  try {
    // Two independent guards, deliberately. `vcenterPassEnabled` is the mode
    // the caller asked for; `vcenterSweepBlockedReason` re-derives the answer
    // from the RESULT itself (it refuses on both `scoped` and an incomplete
    // inventory). Either alone would do — but this pass deletes source rows and
    // decommissions assets, and it fails silently, so it gets two.
    const blockedReason = !vcenterPassEnabled(mode, "stale-sweep")
      ? "the run was scoped to a single device"
      : vcenter.vcenterSweepBlockedReason(result);
    if (blockedReason) {
      const priorCount = vcenterSources.filter((src: any) => src.integrationId === integrationId).length;
      if (priorCount > 0) {
        syncLog(
          "warning",
          `Stale-source sweep skipped — ${blockedReason}. ${priorCount} existing vcenter source row(s) left untouched rather than reading a partial answer as deleted devices.`,
        );
      }
    } else {
      const staleRows = await prisma.assetSource.findMany({
        where: {
          integrationId,
          OR: [
            { sourceKind: "vcenter-vm",   externalId: { notIn: currentVmExternalIds } },
            { sourceKind: "vcenter-host", externalId: { notIn: currentHostExternalIds } },
          ],
        },
        select: { id: true, assetId: true, sourceKind: true, externalId: true, observed: true },
      });

      // Cause 3 — the VM is still in vCenter, just filtered out (or its detail
      // call failed this cycle). Keep the row; that is not a disappearance.
      const { retained, gone } = vcenter.partitionStaleVcenterSources(staleRows, result.presentVmMorefs);

      if (gone.length > 0) {
        await prisma.assetSource.deleteMany({ where: { id: { in: gone.map((r) => r.id) } } });
        syncLog("info", `Swept ${gone.length} stale vcenter AssetSource row(s) no longer present in the inventory.`);
      }
      if (retained.length > 0) {
        syncLog("info", `Retained ${retained.length} vcenter source row(s) for VM(s) still in vCenter but excluded by the name filter (or whose detail read failed this cycle).`);
      }

      // Which of those assets are now unclaimed? Read AFTER the delete, so
      // "remaining" is literally what still points at the asset.
      //
      // ENRICHMENT rows don't count. A `snmp-sysdescr` row says what the
      // device answered about itself the last time Polaris polled it, which
      // is not evidence that anything still holds it in an inventory — count
      // one as a claim and a VM deleted from vCenter stays active forever,
      // vouched for by its own SNMP reply. Only ownership-bearing kinds
      // answer "does something still claim this device exists?".
      const orphanCandidateIds = [...new Set(gone.map((r) => r.assetId))];
      if (orphanCandidateIds.length > 0) {
        const remaining = await prisma.assetSource.findMany({
          where: {
            assetId: { in: orphanCandidateIds },
            sourceKind: { notIn: [...ENRICHMENT_SOURCE_KINDS] },
          },
          select: { assetId: true },
        });
        const stillClaimed = new Set(remaining.map((r) => r.assetId));
        const orphanIds = orphanCandidateIds.filter((id) => !stillClaimed.has(id));
        const keptCount = orphanCandidateIds.length - orphanIds.length;
        if (keptCount > 0) {
          syncLog("info", `${keptCount} asset(s) left vCenter but are still claimed by another discovery source — left active.`);
        }

        if (orphanIds.length > 0) {
          const orphans = await prisma.asset.findMany({
            // Maintenance-window assets ARE judged here, on the FortiGate
            // roster sweep's reasoning: absence from the inventory is
            // configuration truth, not a reachability signal — and
            // releaseAssetsForDecommission force-closes the window first so the
            // 30s maintenance reconcile can't re-flip the status back.
            where: { id: { in: orphanIds }, status: { not: "decommissioned" } },
            select: { id: true, hostname: true, ipAddress: true, assetType: true },
          });
          if (orphans.length > 0) {
            const ids = orphans.map((a: any) => a.id);
            await releaseAssetsForDecommission(ids, {
              at: now,
              actor,
              statusChangedBy: integrationName,
              reason: `no longer present in "${integrationName}"`,
            });
            await prisma.asset.updateMany({
              where: { id: { in: ids } },
              data: { status: "decommissioned", statusChangedAt: now, statusChangedBy: integrationName },
            });
            for (const a of orphans) {
              const name = a.hostname || a.ipAddress || a.id;
              decommissioned.push(name);
              logEvent({
                action: "asset.vcenter.decommissioned",
                resourceType: "asset",
                resourceId: a.id,
                resourceName: name,
                actor,
                message: `${a.assetType === "hypervisor" ? "ESXi host" : "VM"} "${name}" decommissioned — no longer present in "${integrationName}", and no other discovery source claims it`,
                details: { reason: "missing-from-vcenter-inventory", integrationId, integrationName },
              });
            }
            syncLog("info", `Decommissioned ${orphans.length} asset(s) that vanished from vCenter with no other source claiming them.`);
          }
        }
      }
    }
  } catch (err: any) {
    syncLog("error", `Failed to sweep stale vcenter AssetSource rows: ${err.message || "Unknown error"}`);
  }

  syncLog("info", `vCenter sync: ${created.length} created, ${updated.length} updated, ${skipped.length} skipped, ${decommissioned.length} decommissioned (${result.hosts.length} host(s), ${result.vms.length} VM(s), ${result.datastores.length} datastore(s))`);
  return { created, updated, skipped, decommissioned };
}

export async function hasActiveDiscoveries(): Promise<boolean> {
  return anyRunActive();
}

/**
 * src/services/discovery/workloadSync.ts
 *
 * The asset sync shared by the two workload integrations — Unraid and
 * TrueNAS SCALE. Each integration's service reads its own API (Unraid GraphQL,
 * TrueNAS JSON-RPC) and normalizes it to one `WorkloadDiscoveryResult`; this
 * file turns that into assets, exactly once, so identity, placement, the
 * disappearance sweep and their guards cannot drift between the two.
 *
 * It is `syncVcenterDevices` with three classes instead of two:
 *
 *   role       asset type    layer  identity (AssetSource.externalId)
 *   host       hypervisor    1      `${integrationId}:host`   (one host per integration)
 *   vm         server        2      the VM's UUID when the platform reports one,
 *                                   else `${integrationId}:vm:${name}`
 *   container  container     2      `${integrationId}:ctr:${name}` — never the
 *                                   container ID, which changes on every
 *                                   recreate / image update
 *
 * Passes: A host → B VMs → C containers → D placement edges → E stale sweep.
 * Storage pools are not a pass of their own: a pool belongs to exactly one
 * host (unlike a vCenter datastore, shared across a cluster), so the current
 * pool list rides the host's `Asset.virtualization` blob and its history is
 * the storage stream (`AssetStorageSample`, `mountPath = pool name`).
 *
 * Matching (rule 91 — a hostname is not an identity): source row by
 * externalId → (VMs only) vNIC MAC → hostname collision → pending Conflict →
 * create. Containers are NEVER MAC-matched: Docker's generated `02:42:…`
 * bridge MACs repeat across hosts and across recreates.
 */

import { prisma } from "../../db.js";
import { logEvent, logDiscoveryAssetCreated, logDiscoveryAssetUpdated, snapshotMaterialAssetFields } from "../eventLogService.js";
import { projectAssetFromSources, ENRICHMENT_SOURCE_KINDS } from "../../utils/assetProjection.js";
import { bumpLastSeen, clampAcquiredToLastSeen } from "../../utils/assetInvariants.js";
import { buildMonitoredSweep, getAddAsMonitoredFromConfig } from "../monitorOverrideService.js";
import { releaseAssetsForDecommission } from "../maintenanceScheduleService.js";
import { reconcileMacAddresses } from "../macAddressService.js";
import {
  MAC_ROW_SELECT,
  buildMacRowsForCreate,
  selectPrimaryMac,
  shapeMacRows,
  type MacJsonEntry,
} from "../../utils/macAddresses.js";
import { matchesWildcard } from "../../utils/integrationFilter.js";
import { isValidIpAddress } from "../../utils/cidr.js";
import { getConfiguredResolver } from "../dnsService.js";
import { absenceExceedsGuard } from "../../utils/directoryAbsence.js";
import {
  assetTypeForWorkloadRole,
  workloadContainerExternalId,
  workloadHostExternalId,
  workloadPlatformLabel,
  workloadSourceKind,
  workloadSourceKindsFor,
  workloadVmExternalId,
  type WorkloadPlatform,
  type WorkloadRole,
  type WorkloadState,
} from "../../utils/workloadSources.js";
import { indexHostname, lookupHostname, normalizeMacKey, upsertAssetConflict } from "./discoveryEngine.js";

// ─── The normalized shape both services return ────────────────────────────────

export type { WorkloadState } from "../../utils/workloadSources.js";

export interface WorkloadPool {
  name: string;
  /** "array" / "cache" / "pool" (Unraid) or "zfs" (TrueNAS). */
  kind: string;
  totalBytes: number | null;
  usedBytes: number | null;
  /** The platform's own word ("ONLINE", "DEGRADED", "STARTED", …), or null. */
  health: string | null;
}

export interface WorkloadDisk {
  name: string;
  /** Serial / identifier, for the Hardware Sensors label. */
  serial: string | null;
  temperatureC: number | null;
  /** The pool it belongs to, when known. */
  pool: string | null;
}

export interface WorkloadHost {
  /** The host's configured hostname. */
  hostname: string | null;
  /** "Unraid" / "TrueNAS SCALE". */
  os: string;
  osVersion: string | null;
  /** The host's management address — normally the integration's own `host`. */
  ip: string | null;
  serial: string | null;
  manufacturer: string | null;
  model: string | null;
  cpuCount: number | null;
  memTotalBytes: number | null;
  uptimeSeconds: number | null;
  pools: WorkloadPool[];
  disks: WorkloadDisk[];
}

export interface WorkloadVm {
  /** The platform's handle for actions (Unraid libvirt id / domain name; TrueNAS numeric id). */
  platformId: string;
  name: string;
  /** SMBIOS / libvirt UUID when the platform reports one. */
  uuid: string | null;
  state: WorkloadState;
  /** The platform's raw state word, kept for the Sources tab. */
  rawState: string | null;
  cpuCount: number | null;
  memoryBytes: number | null;
  ip: string | null;
  macs: string[];
  autostart: boolean | null;
}

export interface WorkloadContainer {
  /** The platform's handle for actions (Unraid container id; TrueNAS app name). */
  platformId: string;
  name: string;
  image: string | null;
  state: WorkloadState;
  rawState: string | null;
  /** Its own address (macvlan / ipvlan / br0) — null when it shares the host's. */
  ip: string | null;
  /** true / false when the platform answered, null when it could not say. */
  updateAvailable: boolean | null;
  /** App / image version and the one an update would bring (TrueNAS). */
  version: string | null;
  latestVersion: string | null;
  /** Containers in a TrueNAS App (1 on Unraid). */
  memberCount: number | null;
  ports: string[];
  autostart: boolean | null;
}

export interface WorkloadDiscoveryResult {
  platform: WorkloadPlatform;
  host: WorkloadHost;
  vms: WorkloadVm[];
  containers: WorkloadContainer[];
  /**
   * False when any part of the read failed (the VM list, the container list):
   * the disappearance sweep refuses to read a partial answer as deletions.
   */
  inventoryComplete: boolean;
  /** Pre-filter names — a VM / container dropped by a name filter still exists. */
  presentVmNames: string[];
  presentContainerNames: string[];
}

/** Live usage for one workload (or the host), as one monitor tick reads it. */
export interface WorkloadUsage {
  cpuPct: number | null;
  /** Per-core load, host only. */
  perCorePct?: number[] | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
}

export interface WorkloadInterfaceReading {
  name: string;
  operUp: boolean | null;
  rxBytes: number | null;
  txBytes: number | null;
  rxErrors: number | null;
  txErrors: number | null;
  rxDrops: number | null;
  txDrops: number | null;
  speedMbps: number | null;
}

/**
 * Everything one monitor tick needs about one integration, from ONE read of
 * the host's API: the inventory (states, pools, disk temperatures) plus live
 * usage. Warm-cached per integration in monitoringService, the vCenter
 * quickStats pattern — never fetched per asset.
 */
export interface WorkloadSnapshot {
  fetchedAt: number;
  /** The round trip, reported as the response time of every asset it answers. */
  durationMs: number;
  inventory: WorkloadDiscoveryResult;
  host: WorkloadUsage & { interfaces: WorkloadInterfaceReading[] };
  /** Keyed by WorkloadVm.platformId. Absent = the platform reports no VM usage. */
  vmUsage: Map<string, WorkloadUsage>;
  /** Keyed by WorkloadContainer.platformId. */
  containerUsage: Map<string, WorkloadUsage>;
}

// Identity + state live in utils/workloadSources.ts (no imports) so the
// services and collectors can share them without importing this file, which
// pulls discoveryEngine. Re-exported here for the sync's own callers.
export {
  normalizeWorkloadState,
  workloadContainerExternalId,
  workloadHostExternalId,
  workloadVmExternalId,
} from "../../utils/workloadSources.js";

// ─── Filters (the post-hoc twin is utils/integrationFilter.ts) ───────────────

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}

/** Include wins over exclude; empty lists keep everything. */
export function passesNameFilter(name: string, include: string[], exclude: string[]): boolean {
  if (include.length > 0) return include.some((p) => matchesWildcard(p, name));
  if (exclude.length > 0) return !exclude.some((p) => matchesWildcard(p, name));
  return true;
}

/**
 * Apply the integration's name filters. Returns a copy; the `present*Names`
 * lists stay the raw pre-filter inventory, which is what lets the sweep keep a
 * filtered-out workload's identity instead of reading it as deleted.
 */
export function applyWorkloadFilters(
  result: WorkloadDiscoveryResult,
  config: Record<string, unknown> | null,
): WorkloadDiscoveryResult {
  const cfg = config ?? {};
  const vmInc = asStringArray(cfg.vmInclude);
  const vmExc = asStringArray(cfg.vmExclude);
  const ctrInc = asStringArray(cfg.containerInclude);
  const ctrExc = asStringArray(cfg.containerExclude);
  return {
    ...result,
    vms: result.vms.filter((v) => passesNameFilter(v.name, vmInc, vmExc)),
    containers: result.containers.filter((c) => passesNameFilter(c.name, ctrInc, ctrExc)),
  };
}

/**
 * Why the disappearance sweep must not run on this result, or null when it may.
 * Scoped runs, incomplete reads and an empty read (zero VMs AND zero containers
 * against a fleet that had some — a permissions answer far more often than an
 * emptied host; rule 35(c)) all refuse.
 */
export function workloadSweepBlockedReason(
  result: WorkloadDiscoveryResult,
  mode: WorkloadSyncMode,
  priorWorkloadCount: number,
): string | null {
  if (mode === "scoped") return "the run was scoped to a single device";
  if (!result.inventoryComplete) return "part of the inventory could not be read this run";
  if (result.presentVmNames.length === 0 && result.presentContainerNames.length === 0 && priorWorkloadCount > 0) {
    return "the host reported no VMs and no containers at all";
  }
  return null;
}

/** Placement edges: every VM and container → its host. */
export function buildWorkloadDependencyEdges(
  childAssetIds: readonly string[],
  hostAssetId: string | null,
): Array<{ assetId: string; parentAssetId: string }> {
  if (!hostAssetId) return [];
  return [...new Set(childAssetIds)]
    .filter((id) => id !== hostAssetId)
    .map((assetId) => ({ assetId, parentAssetId: hostAssetId }));
}

// ─── Observed blobs (one shape, read by assetProjection's workloadRule) ───────

function hostObserved(platform: WorkloadPlatform, h: WorkloadHost, syncedAt: Date): Record<string, unknown> {
  return {
    kind: workloadSourceKind(platform, "host"),
    role: "host",
    syncedAt: syncedAt.toISOString(),
    name: h.hostname,
    hostname: h.hostname,
    os: h.os,
    osVersion: h.osVersion,
    ip: h.ip,
    serial: h.serial,
    manufacturer: h.manufacturer,
    model: h.model,
    cpuCount: h.cpuCount,
    memTotalBytes: h.memTotalBytes,
  };
}

function vmObserved(platform: WorkloadPlatform, vm: WorkloadVm, hostName: string | null, syncedAt: Date): Record<string, unknown> {
  return {
    kind: workloadSourceKind(platform, "vm"),
    role: "vm",
    syncedAt: syncedAt.toISOString(),
    platformId: vm.platformId,
    name: vm.name,
    uuid: vm.uuid,
    state: vm.state,
    rawState: vm.rawState,
    ip: vm.ip,
    cpuCount: vm.cpuCount,
    memoryBytes: vm.memoryBytes,
    autostart: vm.autostart,
    hostName,
  };
}

function containerObserved(
  platform: WorkloadPlatform,
  c: WorkloadContainer,
  hostName: string | null,
  syncedAt: Date,
): Record<string, unknown> {
  return {
    kind: workloadSourceKind(platform, "container"),
    role: "container",
    syncedAt: syncedAt.toISOString(),
    platformId: c.platformId,
    name: c.name,
    image: c.image,
    state: c.state,
    rawState: c.rawState,
    ip: c.ip,
    updateAvailable: c.updateAvailable,
    version: c.version,
    latestVersion: c.latestVersion,
    memberCount: c.memberCount,
    ports: c.ports,
    autostart: c.autostart,
    hostName,
  };
}

// ─── The sync ─────────────────────────────────────────────────────────────────

export type WorkloadSyncMode = "full" | "scoped";

interface SourceEntry {
  sourceKind: string;
  externalId: string;
  inferred: boolean;
  observed: Record<string, unknown> | null;
  lastSeen: Date | null;
}

export interface WorkloadSyncSummary {
  created: string[];
  updated: string[];
  skipped: string[];
  decommissioned: string[];
}

/** Tags this sync owns on an asset (stripped and re-added each run). */
function isWorkloadManagedTag(platform: WorkloadPlatform, t: string): boolean {
  return t === platform || t === "auto-discovered";
}

export async function syncWorkloadDevices(
  integrationId: string,
  integrationName: string,
  integrationConfig: Record<string, unknown> | null,
  rawResult: WorkloadDiscoveryResult,
  actor?: string,
  mode: WorkloadSyncMode = "full",
): Promise<WorkloadSyncSummary> {
  const platform = rawResult.platform;
  const label = workloadPlatformLabel(platform);
  const syncLog = (level: "info" | "error" | "warning", message: string) => {
    logEvent({ action: "integration.sync", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level, message: `[${integrationName}] ${message}` });
  };
  const result = applyWorkloadFilters(rawResult, integrationConfig);
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const now = new Date();

  const kinds = {
    host: workloadSourceKind(platform, "host"),
    vm: workloadSourceKind(platform, "vm"),
    container: workloadSourceKind(platform, "container"),
  } as const;
  const addAs: Record<WorkloadRole, boolean | null> = {
    host: getAddAsMonitoredFromConfig(platform, integrationConfig, "hypervisor"),
    vm: getAddAsMonitoredFromConfig(platform, integrationConfig, "server"),
    container: getAddAsMonitoredFromConfig(platform, integrationConfig, "container"),
  };

  // Preload — tight selects, once (2000-asset scale: no per-device reads).
  const allAssetsWithRows = await prisma.asset.findMany({
    select: {
      id: true, hostname: true, hostnameOverride: true, assetType: true, status: true,
      monitored: true, monitorOverride: true, acquiredAt: true, lastSeen: true,
      tags: true, discoveredByIntegrationId: true, dnsName: true, ipAddress: true,
      os: true, osVersion: true, serialNumber: true, manufacturer: true, model: true,
      learnedLocation: true, learnedAddress: true, notes: true, assignedTo: true,
      macAddress: true, dependencyLayer: true, virtualization: true,
      macAddressRows: { select: MAC_ROW_SELECT },
    },
  });
  const allAssets = allAssetsWithRows.map((a: any) => ({ ...a, macAddresses: shapeMacRows(a.macAddressRows) }));
  const assetById = new Map<string, any>(allAssets.map((a: any) => [a.id, a]));

  const allSources = await prisma.assetSource.findMany({
    select: { assetId: true, sourceKind: true, externalId: true, integrationId: true, inferred: true, observed: true, lastSeen: true },
  });
  const platformKinds = new Set(workloadSourceKindsFor(platform));
  const assetByExternalId = new Map<string, any>(); // key: `${kind}|${externalId}`
  const assetIdsWithPlatformSource = new Set<string>();
  const sourcesByAssetId = new Map<string, SourceEntry[]>();
  const priorChildAssetIds = new Set<string>();
  let priorWorkloadCount = 0;
  for (const src of allSources) {
    const entry: SourceEntry = {
      sourceKind: src.sourceKind, externalId: src.externalId, inferred: src.inferred,
      observed: (src.observed as Record<string, unknown> | null) || {}, lastSeen: src.lastSeen,
    };
    const list = sourcesByAssetId.get(src.assetId);
    if (list) list.push(entry); else sourcesByAssetId.set(src.assetId, [entry]);
    if (!platformKinds.has(src.sourceKind)) continue;
    assetIdsWithPlatformSource.add(src.assetId);
    const a = assetById.get(src.assetId);
    if (a) assetByExternalId.set(`${src.sourceKind}|${src.externalId}`, a);
    if (src.integrationId === integrationId && src.sourceKind !== kinds.host) {
      priorChildAssetIds.add(src.assetId);
      priorWorkloadCount++;
    }
  }

  const assetByHostnameUnclaimed = new Map<string, any>();
  const assetByMac = new Map<string, any>();
  for (const a of allAssets) {
    if (a.hostname && !assetIdsWithPlatformSource.has(a.id)) indexHostname(assetByHostnameUnclaimed, a.hostname, a);
    const keys = [normalizeMacKey(a.macAddress), ...((a.macAddresses as any[]) ?? []).map((m) => normalizeMacKey(m?.mac))];
    for (const k of keys) if (k && !assetByMac.has(k)) assetByMac.set(k, a);
  }

  const staleHint = (assetId: string, kind: string, externalId: string): boolean =>
    (sourcesByAssetId.get(assetId) ?? []).some((s) => s.sourceKind === kind && s.externalId !== externalId);

  const upsertSource = async (
    assetId: string, kind: string, externalId: string, observed: Record<string, unknown>, seen: Date,
  ): Promise<void> => {
    const hasStale = staleHint(assetId, kind, externalId);
    await prisma.assetSource.upsert({
      where: { sourceKind_externalId: { sourceKind: kind, externalId } },
      create: { assetId, sourceKind: kind, externalId, integrationId, observed: observed as any, inferred: false, syncedAt: now, firstSeen: seen, lastSeen: seen },
      update: { assetId, integrationId, observed: observed as any, inferred: false, syncedAt: now, lastSeen: seen },
    });
    if (hasStale) {
      await prisma.assetSource.deleteMany({ where: { assetId, sourceKind: kind, externalId: { not: externalId } } });
    }
    // Mirror into the preloaded map (the projection input).
    const list = (sourcesByAssetId.get(assetId) ?? []).filter((s) => !(s.sourceKind === kind));
    list.push({ sourceKind: kind, externalId, inferred: false, observed, lastSeen: seen });
    sourcesByAssetId.set(assetId, list);
  };

  const freshTags = [platform, "auto-discovered"];
  const mergeTags = (existing: any): string[] => {
    const preserved = ((existing?.tags as string[]) || []).filter((t) => !isWorkloadManagedTag(platform, t));
    return [...preserved, ...freshTags.filter((t) => !preserved.includes(t))];
  };

  /**
   * One workload through the cascade. Shared by all three roles; `macs` is
   * only ever non-empty for VMs.
   */
  const syncOne = async (args: {
    role: WorkloadRole;
    externalId: string;
    displayName: string;
    observed: Record<string, unknown>;
    virtualization: Record<string, unknown>;
    present: boolean;
    macs: string[];
    collisionFields: Record<string, unknown>;
  }): Promise<string | null> => {
    const { role, externalId, displayName, observed, virtualization, present, macs } = args;
    const kind = kinds[role];
    const assetType = assetTypeForWorkloadRole(role);
    const layer = role === "host" ? 1 : 2;
    const nowIso = now.toISOString();
    const macEntries = macs.map((mac) => ({ mac, source: `${platform}-vnic` }));
    const mergeMacs = (existingMacs: any[]): { primary: string | null; merged: any[] } => {
      const merged = Array.isArray(existingMacs) ? [...existingMacs] : [];
      for (const e of macEntries) {
        const key = normalizeMacKey(e.mac);
        if (!key) continue;
        const hit = merged.find((m: any) => normalizeMacKey(m?.mac) === key);
        if (hit) { hit.lastSeen = nowIso; hit.source = e.source; }
        else merged.push({ mac: e.mac, lastSeen: nowIso, source: e.source });
      }
      merged.sort((a: any, b: any) => new Date(b.lastSeen || 0).getTime() - new Date(a.lastSeen || 0).getTime());
      return { primary: selectPrimaryMac(merged) ?? merged[0]?.mac ?? null, merged };
    };

    let existing: any = assetByExternalId.get(`${kind}|${externalId}`) ?? null;
    if (!existing && role === "vm") {
      for (const e of macEntries) {
        const hit = assetByMac.get(normalizeMacKey(e.mac));
        if (hit) {
          existing = hit;
          syncLog("info", `MAC cross-link: ${label} VM "${displayName}" vNIC MAC ${e.mac} matched existing asset ${hit.hostname || hit.id}${assetIdsWithPlatformSource.has(hit.id) ? "" : " (taking over)"}.`);
          break;
        }
      }
    }

    const conflictFields = {
      sourceType: platform,
      workloadRole: role,
      deviceId: externalId,
      hostname: displayName,
      assetType,
      workloadObserved: observed,
      collisionReason: "untagged-collision",
      ...args.collisionFields,
    };

    if (existing) {
      const seen = present ? now : (existing.lastSeen ?? now);
      try {
        await upsertSource(existing.id, kind, externalId, observed, seen);
      } catch (err: any) {
        syncLog("warning", `Failed to upsert ${kind} AssetSource row for ${displayName}: ${err.message || "Unknown error"}`);
      }
      try {
        const { projected } = projectAssetFromSources(sourcesByAssetId.get(existing.id) ?? []);
        const before = snapshotMaterialAssetFields(existing);
        // A Polaris stop paused this asset's monitoring until a Polaris start
        // (rule 94) — the flag lives on the blob this pass rewrites, so carry it.
        const priorBlob = (existing.virtualization ?? null) as Record<string, unknown> | null;
        if (priorBlob?.monitoringPausedByStop === true) virtualization.monitoringPausedByStop = true;
        const updateData: Record<string, unknown> = { virtualization: virtualization as any };
        if (projected.hostname !== null) updateData.hostname = projected.hostname;
        if (projected.os !== null) updateData.os = projected.os;
        if (projected.osVersion !== null) updateData.osVersion = projected.osVersion;
        if (projected.manufacturer !== null) updateData.manufacturer = projected.manufacturer;
        if (projected.model !== null) updateData.model = projected.model;
        if (projected.serialNumber !== null && projected.serialNumber !== undefined && !existing.serialNumber) {
          updateData.serialNumber = projected.serialNumber;
        }
        if (projected.ipAddress !== null) updateData.ipAddress = projected.ipAddress;
        // Retype only from the unclassified default; a directory-typed asset
        // keeps its class (the vCenter rule).
        if (existing.assetType === "other") updateData.assetType = assetType;
        const classed =
          ((updateData.assetType as string) ?? existing.assetType) === assetType &&
          (existing.discoveredByIntegrationId === integrationId || updateData.assetType === assetType);
        if (classed) updateData.dependencyLayer = layer;
        let mergedMacs: MacJsonEntry[] | null = null;
        if (macEntries.length > 0) {
          const { primary, merged } = mergeMacs(existing.macAddresses as any[]);
          mergedMacs = merged as MacJsonEntry[];
          if (primary) updateData.macAddress = primary;
        }
        if (present) bumpLastSeen(updateData, existing, now, platform);
        Object.assign(updateData, buildMonitoredSweep(classed ? addAs[role] : null, existing));
        updateData.tags = mergeTags(existing);
        clampAcquiredToLastSeen(updateData, existing);
        await prisma.asset.update({ where: { id: existing.id }, data: updateData });
        logDiscoveryAssetUpdated(before, updateData, existing.id, displayName, { integrationName, integrationId, sourceKind: kind, actor });
        if (mergedMacs) await reconcileMacAddresses(existing.id, mergedMacs);
        assetByExternalId.set(`${kind}|${externalId}`, existing);
        assetIdsWithPlatformSource.add(existing.id);
        updated.push(displayName);
      } catch (err: any) {
        syncLog("error", `Failed to update asset for ${label} ${role} ${displayName}: ${err.message || "Unknown error"}`);
        return null;
      }
      // Sibling collision: this workload has its own asset, and a second,
      // unlinked asset shares its name — offer the merge (bothAssetsExist).
      const sibling = lookupHostname(assetByHostnameUnclaimed, displayName);
      if (sibling && sibling.asset.id !== existing.id && !assetIdsWithPlatformSource.has(sibling.asset.id)) {
        try {
          await upsertAssetConflict({
            collisionAssetId: sibling.asset.id,
            integrationId,
            proposedDeviceId: externalId,
            proposedAssetFields: { ...conflictFields, matchedVia: sibling.via, bothAssetsExist: true },
            existingAsset: sibling.asset,
          });
          syncLog("warning", `Sibling hostname collision queued for review — ${label} ${role} "${displayName}" has its own asset but asset ${sibling.asset.hostname || sibling.asset.id} shares the name. Accept in Conflicts to merge them.`);
        } catch (err: any) {
          syncLog("error", `Failed to queue sibling hostname-collision conflict for "${displayName}": ${err.message || "Unknown error"}`);
        }
      }
      return existing.id;
    }

    // Unlinked asset with the same name → pending Conflict, never an auto-merge.
    const collision = lookupHostname(assetByHostnameUnclaimed, displayName);
    if (collision) {
      try {
        await upsertAssetConflict({
          collisionAssetId: collision.asset.id,
          integrationId,
          proposedDeviceId: externalId,
          proposedAssetFields: { ...conflictFields, matchedVia: collision.via },
          existingAsset: collision.asset,
        });
        syncLog("warning", `Hostname collision queued for review — ${label} ${role} "${displayName}" matches existing asset ${collision.asset.id}${collision.via === "netbios" ? " (NetBIOS-truncated match)" : ""}.`);
      } catch (err: any) {
        syncLog("error", `Failed to queue hostname-collision conflict for "${displayName}": ${err.message || "Unknown error"}`);
      }
      skipped.push(`${displayName} (hostname collision — pending review)`);
      return null;
    }

    try {
      const { projected } = projectAssetFromSources([{ sourceKind: kind, inferred: false, observed }]);
      const seeded = mergeMacs([]);
      const createData: Record<string, unknown> = {
        hostname: projected.hostname ?? displayName,
        macAddress: seeded.primary,
        ...(seeded.merged.length > 0 ? { macAddressRows: { create: buildMacRowsForCreate(seeded.merged as MacJsonEntry[]) } } : {}),
        ipAddress: projected.ipAddress,
        os: projected.os,
        osVersion: projected.osVersion,
        serialNumber: projected.serialNumber ?? null,
        manufacturer: projected.manufacturer,
        model: projected.model,
        assetType,
        status: "active",
        statusChangedAt: now,
        statusChangedBy: integrationName,
        notes: `Auto-discovered from ${label} integration "${integrationName}"`,
        tags: freshTags,
        virtualization: virtualization as any,
        dependencyLayer: layer,
        discoveredByIntegrationId: integrationId,
      };
      if (present) bumpLastSeen(createData, null, now, platform);
      Object.assign(createData, buildMonitoredSweep(addAs[role], { monitored: false, monitorOverride: false }));
      clampAcquiredToLastSeen(createData);
      const newAsset = await prisma.asset.create({ data: createData as any });
      try {
        await upsertSource(newAsset.id, kind, externalId, observed, now);
      } catch (err: any) {
        syncLog("warning", `Created asset for ${displayName} but failed to upsert AssetSource row: ${err.message || "Unknown error"}`);
      }
      logDiscoveryAssetCreated(newAsset.id, displayName, { integrationName, integrationId, sourceKind: kind, actor });
      assetById.set(newAsset.id, newAsset);
      assetByExternalId.set(`${kind}|${externalId}`, newAsset);
      assetIdsWithPlatformSource.add(newAsset.id);
      for (const e of macEntries) {
        const k = normalizeMacKey(e.mac);
        if (k && !assetByMac.has(k)) assetByMac.set(k, newAsset);
      }
      created.push(displayName);
      return newAsset.id;
    } catch (err: any) {
      syncLog("error", `Failed to create asset for ${label} ${role} ${displayName}: ${err.message || "Unknown error"}`);
      return null;
    }
  };

  // ── Pass A — the host ──────────────────────────────────────────────────────
  // The integration's Host field may be a NAME. Asset.ipAddress must hold an
  // address (it is what ICMP pings and what IPAM matches), so resolve a name
  // the way vCenter resolves an ESXi host's — through the configured resolver
  // — and leave it empty when it does not resolve.
  if (result.host.ip && !isValidIpAddress(result.host.ip)) {
    let resolved: string | null = null;
    try {
      const resolver = await getConfiguredResolver();
      resolved = (await resolver.lookup(result.host.ip))[0]?.address ?? null;
    } catch { /* unresolvable — leave it empty */ }
    result.host = { ...result.host, ip: resolved };
  }
  const h = result.host;
  const hostName = h.hostname;
  const hostExternalId = workloadHostExternalId(integrationId);
  const hostAssetId = await syncOne({
    role: "host",
    externalId: hostExternalId,
    displayName: hostName || h.ip || label,
    observed: hostObserved(platform, h, now),
    virtualization: {
      role: "host",
      platform,
      integrationId,
      os: h.os,
      osVersion: h.osVersion,
      cpuCount: h.cpuCount,
      memTotalBytes: h.memTotalBytes,
      uptimeSeconds: h.uptimeSeconds,
      pools: h.pools,
      vmCount: result.vms.length,
      containerCount: result.containers.length,
      syncedAt: now.toISOString(),
    },
    // The host answered its own API — that IS presence.
    present: true,
    macs: [],
    collisionFields: { os: h.os, osVersion: h.osVersion, ipAddress: h.ip, serialNumber: h.serial },
  });

  // ── Pass B — VMs ──────────────────────────────────────────────────────────
  const childAssetIds: string[] = [];
  const currentVmIds: string[] = [];
  for (const vm of result.vms) {
    const externalId = workloadVmExternalId(integrationId, vm);
    currentVmIds.push(externalId);
    const id = await syncOne({
      role: "vm",
      externalId,
      displayName: vm.name,
      observed: vmObserved(platform, vm, hostName, now),
      virtualization: {
        role: "vm",
        platform,
        integrationId,
        hostAssetId,
        hostName,
        platformId: vm.platformId,
        uuid: vm.uuid,
        state: vm.state,
        rawState: vm.rawState,
        cpuCount: vm.cpuCount,
        memoryBytes: vm.memoryBytes,
        autostart: vm.autostart,
      },
      present: vm.state === "running",
      macs: vm.macs,
      collisionFields: { ipAddress: vm.ip, macAddress: vm.macs[0] ?? null },
    });
    if (id) childAssetIds.push(id);
  }

  // ── Pass C — containers / Apps ─────────────────────────────────────────────
  const currentContainerIds: string[] = [];
  for (const c of result.containers) {
    const externalId = workloadContainerExternalId(integrationId, c.name);
    currentContainerIds.push(externalId);
    const prior = assetByExternalId.get(`${kinds.container}|${externalId}`);
    const priorVirt = (prior?.virtualization ?? null) as Record<string, unknown> | null;
    // An update check the platform could not answer this run keeps the last
    // answer rather than flapping the badge off.
    const updateAvailable = c.updateAvailable ?? (priorVirt?.updateAvailable as boolean | null | undefined) ?? null;
    const id = await syncOne({
      role: "container",
      externalId,
      displayName: c.name,
      observed: containerObserved(platform, { ...c, updateAvailable }, hostName, now),
      virtualization: {
        role: "container",
        platform,
        integrationId,
        hostAssetId,
        hostName,
        platformId: c.platformId,
        image: c.image,
        state: c.state,
        rawState: c.rawState,
        updateAvailable,
        updateCheckedAt: c.updateAvailable === null ? (priorVirt?.updateCheckedAt ?? null) : now.toISOString(),
        version: c.version,
        latestVersion: c.latestVersion,
        memberCount: c.memberCount,
        ports: c.ports,
        autostart: c.autostart,
      },
      present: c.state === "running",
      macs: [],
      collisionFields: { ipAddress: c.ip, os: c.image },
    });
    if (id) childAssetIds.push(id);
  }

  // ── Pass D — placement edges (VM / container → host) ──────────────────────
  // Delete-replace scoped to this integration's workloads (prior + current)
  // and this platform's edge source. Skipped on a scoped run, for vCenter's
  // reason: the prior set is the whole fleet, the current set one device.
  if (mode === "full") try {
    const edges = buildWorkloadDependencyEdges(childAssetIds, hostAssetId);
    const scopeIds = [...new Set([...priorChildAssetIds, ...childAssetIds])];
    await prisma.$transaction([
      ...(scopeIds.length > 0
        ? [prisma.assetDependencyParent.deleteMany({ where: { source: platform, assetId: { in: scopeIds } } })]
        : []),
      ...(edges.length > 0
        ? [prisma.assetDependencyParent.createMany({
            data: edges.map((e) => ({ assetId: e.assetId, parentAssetId: e.parentAssetId, source: platform, detectedVia: "hypervisor" })),
            skipDuplicates: true,
          })]
        : []),
    ]);
  } catch (err: any) {
    syncLog("error", `Failed to refresh workload→host dependency edges: ${err.message || "Unknown error"}`);
  }

  // ── Pass E — stale sources + the assets that lose their last one ───────────
  // vCenter's Pass E plus rule 70's shrink guard: containers churn, and a
  // read that suddenly lost most of the fleet is an API answer, not a purge.
  const decommissioned: string[] = [];
  try {
    const blocked = workloadSweepBlockedReason(rawResult, mode, priorWorkloadCount);
    if (blocked) {
      if (priorWorkloadCount > 0) {
        syncLog("warning", `Stale-source sweep skipped — ${blocked}. ${priorWorkloadCount} existing ${label} source row(s) left untouched.`);
      }
    } else {
      const staleRows = await prisma.assetSource.findMany({
        where: {
          integrationId,
          OR: [
            { sourceKind: kinds.vm, externalId: { notIn: currentVmIds } },
            { sourceKind: kinds.container, externalId: { notIn: currentContainerIds } },
          ],
        },
        select: { id: true, assetId: true, sourceKind: true, observed: true },
      });
      // A filtered-out workload still exists: keep its identity.
      const presentVm = new Set(rawResult.presentVmNames);
      const presentCtr = new Set(rawResult.presentContainerNames);
      const gone = staleRows.filter((r) => {
        const name = String(((r.observed as Record<string, unknown> | null) ?? {}).name ?? "");
        return r.sourceKind === kinds.vm ? !presentVm.has(name) : !presentCtr.has(name);
      });
      if (gone.length > 0 && absenceExceedsGuard(gone.length, priorWorkloadCount)) {
        syncLog("warning", `Stale-source sweep refused — ${gone.length} of ${priorWorkloadCount} workload(s) vanished in one read, which is more than the guard allows. Nothing was removed; if this is real, the next runs will keep reporting it.`);
      } else if (gone.length > 0) {
        await prisma.assetSource.deleteMany({ where: { id: { in: gone.map((r) => r.id) } } });
        syncLog("info", `Swept ${gone.length} stale ${label} source row(s) no longer present on the host.`);
        const candidateIds = [...new Set(gone.map((r) => r.assetId))];
        const remaining = await prisma.assetSource.findMany({
          where: { assetId: { in: candidateIds }, sourceKind: { notIn: [...ENRICHMENT_SOURCE_KINDS] } },
          select: { assetId: true },
        });
        const stillClaimed = new Set(remaining.map((r) => r.assetId));
        const orphanIds = candidateIds.filter((id) => !stillClaimed.has(id));
        if (orphanIds.length > 0) {
          const orphans = await prisma.asset.findMany({
            where: { id: { in: orphanIds }, status: { not: "decommissioned" } },
            select: { id: true, hostname: true, ipAddress: true, assetType: true },
          });
          if (orphans.length > 0) {
            const ids = orphans.map((a) => a.id);
            await releaseAssetsForDecommission(ids, {
              at: now, actor, statusChangedBy: integrationName, reason: `no longer present in "${integrationName}"`,
            });
            await prisma.asset.updateMany({
              where: { id: { in: ids } },
              data: { status: "decommissioned", statusChangedAt: now, statusChangedBy: integrationName },
            });
            for (const a of orphans) {
              const name = a.hostname || a.ipAddress || a.id;
              decommissioned.push(name);
              logEvent({
                action: `asset.${platform}.decommissioned`,
                resourceType: "asset",
                resourceId: a.id,
                resourceName: name,
                actor,
                message: `${a.assetType === "container" ? (platform === "truenas" ? "App" : "Container") : "VM"} "${name}" decommissioned — no longer present in "${integrationName}", and no other discovery source claims it`,
                details: { reason: `missing-from-${platform}-inventory`, integrationId, integrationName },
              });
            }
          }
        }
      }
    }
  } catch (err: any) {
    syncLog("error", `Failed to sweep stale ${label} source rows: ${err.message || "Unknown error"}`);
  }

  syncLog("info", `${label} sync: ${created.length} created, ${updated.length} updated, ${skipped.length} skipped, ${decommissioned.length} decommissioned (${result.vms.length} VM(s), ${result.containers.length} container(s), ${result.host.pools.length} pool(s))`);
  return { created, updated, skipped, decommissioned };
}

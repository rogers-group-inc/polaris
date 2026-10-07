/**
 * src/services/workloadMonitorService.ts
 *
 * The `unraid` / `truenas` polling methods: response time, CPU/memory,
 * interfaces, storage and hardware sensors for the host, its VMs and its
 * containers / Apps — all answered from ONE warm-cached snapshot per
 * integration per tick (the vCenter quickStats pattern). The asset itself is
 * never contacted, so no credential, no SNMP and no reachable guest address
 * are needed. monitoringService dispatches here before its IP guard.
 *
 * Response time is ICMP by default for any asset with an address
 * (defaultPollingForSource); this probe answers for the rest — a bridged
 * container, a VM with no published guest IP — and for an operator who picks
 * the method on purpose. It reports up/down only: its responseTimeMs is 0,
 * because the only latency it could report is the host-API round trip, which
 * says nothing about the workload and charted as a misleadingly high number.
 *
 * The reading model is vCenter's, and for vCenter's reason:
 *
 *   host / vm / container — the platform answered ABOUT this asset; its own
 *                           state decides up/down.
 *   absent      — the platform answered and this asset was not in it (deleted
 *                 at source, or the method set on an asset with no workload
 *                 source). A real finding: the probe FAILS.
 *   unreachable — Polaris could not ask (host API down, key revoked,
 *                 integration disabled). A fact about the host, not the
 *                 workload: the probe is SKIPPED, so one NAS reboot does not
 *                 declare sixty containers down. The HOST asset is the
 *                 exception — its own API being unreachable IS the finding
 *                 about it, so the host probe fails instead (and its children
 *                 are then dependency-suppressed by the placement edges).
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { createTtlCache } from "../utils/ttlCache.js";
import {
  ALL_WORKLOAD_SOURCE_KINDS,
  parseWorkloadSourceKind,
  workloadContainerExternalId,
  workloadHostExternalId,
  workloadPlatformLabel,
  workloadVmExternalId,
  type WorkloadPlatform,
} from "../utils/workloadSources.js";
import * as unraid from "./unraidService.js";
import * as truenas from "./truenasService.js";
import type {
  WorkloadContainer,
  WorkloadSnapshot,
  WorkloadUsage,
  WorkloadVm,
} from "./discovery/workloadSync.js";
import type {
  CollectionResult,
  HardwareSensorSample,
  InterfaceSample,
  ProbeResult,
  StorageSample,
  SystemInfoSample,
  TelemetrySample,
} from "./monitoringService.js";

/** Same TTL as the vCenter caches: every asset on one integration shares a read per tick. */
export const WORKLOAD_SNAPSHOT_TTL_MS = 30_000;

interface CacheEntry {
  snap: WorkloadSnapshot;
  vmsById: Map<string, WorkloadVm>;
  containersById: Map<string, WorkloadContainer>;
}

// Promise-aware: concurrent callers share ONE in-flight fetch; a rejection is
// never cached, so the next tick retries.
const snapshotCache = createTtlCache<CacheEntry>({ ttlMs: WORKLOAD_SNAPSHOT_TTL_MS, maxEntries: 512 });

/** Drop an integration's cached snapshot — after an action, so the next probe sees the new state. */
export function invalidateWorkloadSnapshot(integrationId?: string): void {
  snapshotCache.invalidate(integrationId);
}

export async function fetchWorkloadSnapshotCached(integration: {
  id: string;
  type: WorkloadPlatform;
  config: Record<string, unknown>;
}): Promise<CacheEntry> {
  return snapshotCache.getOrCompute(integration.id, async () => {
    const snap = integration.type === "unraid"
      ? await unraid.fetchUnraidSnapshot(integration.config as unknown as unraid.UnraidConfig)
      : await truenas.fetchTrueNasSnapshot(integration.config as unknown as truenas.TrueNasConfig);
    const vmsById = new Map<string, WorkloadVm>();
    for (const vm of snap.inventory.vms) vmsById.set(workloadVmExternalId(integration.id, vm), vm);
    const containersById = new Map<string, WorkloadContainer>();
    for (const c of snap.inventory.containers) containersById.set(workloadContainerExternalId(integration.id, c.name), c);
    return { snap, vmsById, containersById };
  });
}

export type WorkloadReading =
  | { kind: "host"; platform: WorkloadPlatform; snap: WorkloadSnapshot }
  | { kind: "vm"; platform: WorkloadPlatform; vm: WorkloadVm; usage: WorkloadUsage | null; snap: WorkloadSnapshot }
  | { kind: "container"; platform: WorkloadPlatform; container: WorkloadContainer; usage: WorkloadUsage | null; snap: WorkloadSnapshot }
  | { kind: "absent"; error: string }
  | { kind: "unreachable"; error: string; role: "host" | "vm" | "container" | null };

/**
 * One asset's current reading, resolved through its workload AssetSource row —
 * NOT discoveredByIntegration, which keeps pointing at a directory integration
 * when an AD-found VM was later merged by an Unraid / TrueNAS sync.
 */
export async function readWorkloadAsset(assetId: string): Promise<WorkloadReading> {
  const source = await prisma.assetSource.findFirst({
    where: { assetId, sourceKind: { in: [...ALL_WORKLOAD_SOURCE_KINDS] } },
    select: {
      externalId: true,
      sourceKind: true,
      integration: { select: { id: true, type: true, config: true, enabled: true } },
    },
  });
  const parsed = parseWorkloadSourceKind(source?.sourceKind);
  if (!source || !parsed) {
    return { kind: "absent", error: "Unraid / TrueNAS polling requires an asset discovered by one of those integrations (no workload source on file)" };
  }
  const label = workloadPlatformLabel(parsed.platform);
  if (!source.integration || source.integration.type !== parsed.platform) {
    return { kind: "absent", error: `The asset's ${label} source is not linked to a ${label} integration` };
  }
  if (source.integration.enabled === false) {
    return { kind: "unreachable", error: `The linked ${label} integration is disabled`, role: parsed.role };
  }
  let entry: CacheEntry;
  try {
    entry = await fetchWorkloadSnapshotCached({
      id: source.integration.id,
      type: parsed.platform,
      config: (source.integration.config ?? {}) as Record<string, unknown>,
    });
  } catch (err: any) {
    return { kind: "unreachable", error: err?.message || `${label} API read failed`, role: parsed.role };
  }
  const { snap } = entry;
  if (parsed.role === "host") {
    if (source.externalId !== workloadHostExternalId(source.integration.id)) {
      return { kind: "absent", error: `This host is not the one the ${label} integration reads` };
    }
    return { kind: "host", platform: parsed.platform, snap };
  }
  if (parsed.role === "vm") {
    const vm = entry.vmsById.get(source.externalId);
    if (!vm) {
      // A VM list that failed to read this tick is not evidence of absence.
      if (!snap.inventory.inventoryComplete && snap.inventory.vms.length === 0) {
        return { kind: "unreachable", error: `${label} returned no VM list this tick`, role: "vm" };
      }
      return { kind: "absent", error: `VM not present on the ${label} host (removed or renamed?)` };
    }
    return { kind: "vm", platform: parsed.platform, vm, usage: snap.vmUsage.get(vm.platformId) ?? null, snap };
  }
  const container = entry.containersById.get(source.externalId);
  if (!container) {
    if (!snap.inventory.inventoryComplete && snap.inventory.containers.length === 0) {
      return { kind: "unreachable", error: `${label} returned no container list this tick (Docker / Apps service stopped?)`, role: "container" };
    }
    return { kind: "absent", error: `${parsed.platform === "truenas" ? "App" : "Container"} not present on the ${label} host (removed or renamed?)` };
  }
  return { kind: "container", platform: parsed.platform, container, usage: snap.containerUsage.get(container.platformId) ?? null, snap };
}

// ─── Probe ────────────────────────────────────────────────────────────────────

/**
 * Up/down = the platform's own state. Response time is always 0 ms: a state
 * read carries no latency of the workload (operator decision 2026-10-07 —
 * the API round trip used to be charted here and read as a slow device).
 */
export async function probeWorkload(assetId: string, _start: number): Promise<ProbeResult> {
  const reading = await readWorkloadAsset(assetId);
  if (reading.kind === "unreachable") {
    if (reading.role === "host") {
      // The host's own API not answering is the finding about the host.
      return { success: false, responseTimeMs: 0, error: reading.error };
    }
    logger.debug({ assetId, reason: reading.error }, "workload probe skipped — could not read the host");
    return { success: false, responseTimeMs: 0, skipped: true, error: reading.error };
  }
  if (reading.kind === "absent") return { success: false, responseTimeMs: 0, error: reading.error };
  const rtt = 0;
  if (reading.kind === "host") {
    const ok: ProbeResult = { success: true, responseTimeMs: rtt };
    if (reading.snap.inventory.host.uptimeSeconds !== null) ok.uptimeSec = reading.snap.inventory.host.uptimeSeconds;
    return ok;
  }
  const state = reading.kind === "vm" ? reading.vm.state : reading.container.state;
  const raw = reading.kind === "vm" ? reading.vm.rawState : reading.container.rawState;
  if (state === "running") return { success: true, responseTimeMs: rtt };
  // "other" is a transition (DEPLOYING, STOPPING, NOSTATE): no verdict either way.
  if (state === "other") {
    return { success: false, responseTimeMs: 0, skipped: true, error: `In transition (${raw ?? "unknown state"})` };
  }
  const what = reading.kind === "vm" ? "VM" : reading.platform === "truenas" ? "App" : "Container";
  return { success: false, responseTimeMs: rtt, error: `${what} is ${raw ?? state}` };
}

// ─── CPU / memory ─────────────────────────────────────────────────────────────

export async function collectTelemetryWorkload(assetId: string): Promise<CollectionResult<TelemetrySample>> {
  const reading = await readWorkloadAsset(assetId);
  if (reading.kind === "absent" || reading.kind === "unreachable") return { supported: true, error: reading.error };
  if (reading.kind === "host") {
    const h = reading.snap.host;
    if (h.cpuPct === null && h.memUsedBytes === null) return { supported: true, error: "The host reported no CPU / memory usage this tick" };
    return {
      supported: true,
      data: {
        cpuPct: clampPct(h.cpuPct),
        memUsedBytes: h.memUsedBytes,
        memTotalBytes: h.memTotalBytes ?? reading.snap.inventory.host.memTotalBytes,
        cpuCorePcts: h.perCorePct && h.perCorePct.length > 0 ? h.perCorePct.map((p) => clampPct(p) ?? 0) : null,
      },
    };
  }
  const state = reading.kind === "vm" ? reading.vm.state : reading.container.state;
  if (state !== "running") return { supported: true, error: `Not running (${state})` };
  const usage = reading.usage;
  if (!usage) {
    // Unraid publishes no VM usage at all; a container that has not reported
    // inside the stats window this tick just carries no reading.
    return reading.kind === "vm" && reading.platform === "unraid"
      ? { supported: false }
      : { supported: true, error: "No usage reported for this workload this tick" };
  }
  const total = usage.memTotalBytes ?? (reading.kind === "vm" ? reading.vm.memoryBytes : null);
  return {
    supported: true,
    data: { cpuPct: clampPct(usage.cpuPct), memUsedBytes: usage.memUsedBytes, memTotalBytes: total },
  };
}

function clampPct(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  // docker stats reports a multi-core container above 100 %; the chart is a
  // share of the box, so normalize to one machine's worth.
  return Math.min(100, Math.max(0, v));
}

// ─── Interfaces + storage ─────────────────────────────────────────────────────

export function buildWorkloadSystemInfo(reading: WorkloadReading): SystemInfoSample {
  const interfaces: InterfaceSample[] = [];
  const storage: StorageSample[] = [];
  if (reading.kind !== "host") return { interfaces, storage };
  for (const i of reading.snap.host.interfaces) {
    interfaces.push({
      ifName: i.name,
      operStatus: i.operUp === null ? null : i.operUp ? "up" : "down",
      speedBps: i.speedMbps !== null ? i.speedMbps * 1_000_000 : null,
      inOctets: i.rxBytes,
      outOctets: i.txBytes,
      inErrors: i.rxErrors,
      outErrors: i.txErrors,
    });
  }
  // A host's storage is its pools: the Unraid array + cache pools, the TrueNAS
  // ZFS pools. One row per pool, keyed by pool name.
  for (const p of reading.snap.inventory.host.pools) {
    storage.push({ mountPath: p.name, totalBytes: p.totalBytes, usedBytes: p.usedBytes });
  }
  return { interfaces, storage };
}

export async function collectSystemInfoWorkload(
  assetId: string,
  effective: { interfacesPolling: string | null; storagePolling: string | null },
  pinned?: { interfaces: string[]; storage: string[] },
): Promise<CollectionResult<SystemInfoSample>> {
  const reading = await readWorkloadAsset(assetId);
  if (reading.kind === "absent" || reading.kind === "unreachable") return { supported: true, error: reading.error };
  // VMs and containers publish no interfaces or storage of their own here.
  if (reading.kind !== "host") return { supported: false };
  const data = buildWorkloadSystemInfo(reading);
  const method = reading.platform;
  if (effective.interfacesPolling !== method) data.interfaces = [];
  if (effective.storagePolling !== method) data.storage = [];
  if (pinned) {
    const wantIf = new Set(pinned.interfaces);
    const wantSt = new Set(pinned.storage);
    data.interfaces = data.interfaces.filter((i) => wantIf.has(i.ifName));
    data.storage = data.storage.filter((s) => wantSt.has(s.mountPath));
  }
  return { supported: true, data };
}

// ─── Hardware sensors (disk temperatures) ─────────────────────────────────────

export async function collectHardwareSensorsWorkload(assetId: string): Promise<CollectionResult<HardwareSensorSample[]>> {
  const reading = await readWorkloadAsset(assetId);
  if (reading.kind === "absent" || reading.kind === "unreachable") return { supported: true, error: reading.error };
  if (reading.kind !== "host") return { supported: false };
  const data: HardwareSensorSample[] = reading.snap.inventory.host.disks
    .filter((d) => d.temperatureC !== null)
    .map((d) => ({
      sensorName: d.pool ? `${d.name} (${d.pool})` : d.name,
      sensorClass: "disk",
      value: d.temperatureC,
      unit: "°C",
      alarmStatus: null,
    }));
  return { supported: true, data };
}

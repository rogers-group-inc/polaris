/**
 * src/services/monitoring/vcenterFmgCollectors.ts — vCenter and FortiManager monitoring (CQ-B061, moved verbatim from
 * monitoringService.ts): the warm caches, the native probes and the vCenter
 * telemetry / system-info collectors.
 */

import { performance } from "node:perf_hooks";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { fetchVcenterQuickStats, fetchVcenterHostSnapshot } from "../vcenterService.js";
import { fetchRosterConnectivity, type FortiManagerConfig, type RosterDeviceStatus } from "../fortimanagerService.js";
import { logger } from "../../utils/logger.js";
import { type ProbeResult, type TelemetrySample, type InterfaceSample, type StorageSample, type SystemInfoSample, type CollectionResult } from "./types.js";
import { finish } from "./common.js";

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
  stats: Map<string, import("../vcenterService.js").VcenterVmQuickStats>;
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
export async function probeFortimanagerNative(
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
  hosts: Map<string, import("../vcenterService.js").VcenterHostStats>;
  /** Datastores mounted by each host moref — the host's storage stream. */
  datastoresByHostMoref: Map<string, import("../vcenterService.js").DiscoveredVcenterDatastore[]>;
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
        integration.config as unknown as import("../vcenterService.js").VcenterConfig,
        undefined,
        // The monitoring cache is the one caller that wants per-core CPU;
        // discovery reads none of those columns and must not pay for a
        // QueryPerf over the whole vCenter to fill them.
        { withPerCoreCpu: true },
      );
      const stats = new Map<string, import("../vcenterService.js").VcenterVmQuickStats>();
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
        integration.config as unknown as import("../vcenterService.js").VcenterConfig,
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
      const hosts = new Map<string, import("../vcenterService.js").VcenterHostStats>();
      for (const h of snap.hosts) hosts.set(`${integration.id}:${h.moref}`, h);
      const datastoresByHostMoref = new Map<string, import("../vcenterService.js").DiscoveredVcenterDatastore[]>();
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
  | { kind: "vm"; row: import("../vcenterService.js").VcenterVmQuickStats; fetchDurationMs: number }
  | {
      kind: "host";
      row: import("../vcenterService.js").VcenterHostStats;
      datastores: import("../vcenterService.js").DiscoveredVcenterDatastore[];
      fetchDurationMs: number;
    }
  | { kind: "absent"; error: string }
  | { kind: "unreachable"; error: string };

/**
 * Resolve an asset's vCenter reading through its AssetSource row — NOT through
 * discoveredByIntegration, because a VM that AD/Entra discovered first keeps
 * the directory integration there even after a vCenter sync merges into it.
 */
export async function readVcenterAsset(assetId: string): Promise<VcenterReading> {
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
export async function probeVcenter(assetId: string, start: number): Promise<ProbeResult> {
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
export async function collectTelemetryVcenter(assetId: string): Promise<CollectionResult<TelemetrySample>> {
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
    const pgByName = new Map<string, import("../vcenterService.js").VcenterHostPortgroup>();
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
export async function collectSystemInfoVcenter(
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

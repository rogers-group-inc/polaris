/**
 * src/services/assetDetailReadService.ts — read-only projections of what the
 * asset details slide-in shows, for callers that are not the slide-in.
 *
 * - getEffectiveMonitorSettings: the System tab's stream-source badges and
 *   "who decides this device is down" (GET /assets/:id/effective-monitor-settings
 *   calls it; it was that route's inline body).
 * - readAssetSections: the AI assistant's asset_details tool (business rule 95).
 *   One section per slide-in area, each read from the service the tab's own
 *   route calls where one exists, otherwise a tight select over the same
 *   table. Never a write, never a live probe: the tab buttons that reach a
 *   device (Poll now, SNMP walk, DNS / OUI lookup, workload live state,
 *   quarantine verify) have no section here.
 *
 * Every section is gated on the caller's role inside readAssetSections, with
 * the same second keys the routes add on top of `assets:read`: reservations
 * for VIPs, contacts for contacts, assetsQuarantine for gate sightings,
 * subnets for the IPAM half of the upstream firewall, automationManagement
 * for the full automations matching the device.
 */

import type { Request } from "express";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { hasPermission } from "../api/middleware/permissions.js";
import { isWorkloadPlatform } from "../utils/workloadSources.js";
import { resolveMonitorSettingsWithProvenance } from "./monitoringService.js";
import { snmpPollingCredentialId } from "./assetCredentialScopeService.js";
import { describeDownDetectionFor, recoveryPollsFor } from "./downDetectionService.js";
import { deviceUptime } from "../utils/uptime.js";

// ─── Effective monitor settings ──────────────────────────────────────────────

export async function getEffectiveMonitorSettings(id: string) {
  const asset = await prisma.asset.findUnique({
    where: { id },
    select: {
      id:                         true,
      assetType:                  true,
      // The workload sources' response-time default depends on it (ICMP
      // when there is an address, the platform's state check when not) —
      // without it this endpoint reported the state check for every
      // workload asset while the monitor pinged.
      ipAddress:                  true,
      discoveredByIntegrationId:  true,
      // config only for the SNMP Walk default's integration fallback below —
      // never echoed: `integrationInfo` picks its fields by name.
      discoveredByIntegration:    { select: { name: true, type: true, pollInterval: true, config: true } },
      monitorIntervalSec:         true,
      cpuMemoryIntervalSec:       true,
      temperatureIntervalSec:     true,
      systemInfoIntervalSec:      true,
      probeTimeoutMs:             true,
      cpuMemoryTimeoutMs:         true,
      temperatureTimeoutMs:       true,
      systemInfoTimeoutMs:        true,
      responseTimePolling:        true,
      cpuMemoryPolling:           true,
      temperaturePolling:         true,
      interfacesPolling:          true,
      lldpPolling:                true,
      storagePolling:             true,
      responseTimeMibId:          true,
      cpuMemoryMibId:             true,
      temperatureMibId:           true,
      interfacesMibId:            true,
      lldpMibId:                  true,
      responseTimeCredentialId:   true,
      cpuMemoryCredentialId:      true,
      temperatureCredentialId:    true,
      interfacesCredentialId:     true,
      lldpCredentialId:           true,
      // The remaining slots the SNMP Walk default reads (snmpCredentialId).
      monitorCredentialId:        true,
      processesCredentialId:      true,
      eventLogCredentialId:       true,
      customWidgetPolling:        true,
      customWidgetCredentialId:   true,
    },
  });
  if (!asset) throw new AppError(404, "Asset not found");
  const result = await resolveMonitorSettingsWithProvenance({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  // mibLookup: every non-null MIB UUID across the five streams, mapped to
  // its moduleName so the frontend's monitoring chips can append a "MIB:
  // <module>" segment without a second round-trip. Standard MIB ids (the
  // `std:<key>` namespace, owned entirely by the frontend) are skipped —
  // those resolve through `_SNMP_STANDARD_MIBS` in assets.js.
  const mibIds = new Set<string>();
  for (const mibId of [
    result.resolved.responseTimeMibId,
    result.resolved.cpuMemoryMibId,
    result.resolved.temperatureMibId,
    result.resolved.interfacesMibId,
    result.resolved.lldpMibId,
  ]) {
    if (typeof mibId === "string" && mibId && !mibId.startsWith("std:")) mibIds.add(mibId);
  }
  const mibLookup: Record<string, { moduleName: string }> = {};
  if (mibIds.size > 0) {
    const rows = await prisma.mibFile.findMany({
      where:  { id: { in: [...mibIds] } },
      select: { id: true, moduleName: true },
    });
    for (const r of rows) mibLookup[r.id] = { moduleName: r.moduleName };
  }
  // Surface the integration's name + pollInterval alongside the resolved
  // settings so the frontend can render the "integrationPollInterval"
  // provenance badge as `Inherit: 14400s (4h, from <integration> discovery
  // cycle)` without a second /integrations/:id round-trip.
  const integrationInfo = asset.discoveredByIntegration
    ? {
        id:           asset.discoveredByIntegrationId,
        name:         asset.discoveredByIntegration.name,
        type:         asset.discoveredByIntegration.type,
        pollInterval: asset.discoveredByIntegration.pollInterval,
      }
    : null;
  // WHICH AUTOMATION DECIDES THIS DEVICE IS DOWN. The missed-poll count is no
  // longer a settings value (business rule 36), so the modal that used to
  // point operators at "the tier where it lives" has to point at the
  // automation instead — and for a device no automation covers, say that
  // plainly rather than rendering a threshold nobody applies. `passive: true`
  // is that case. Derived, never stored; the resolver reads its cached
  // snapshot so this costs no query in the steady state.
  const downCoverage = await describeDownDetectionFor(id);
  const downDetection = downCoverage
    ? {
        passive:      downCoverage.passive,
        missedPolls:  downCoverage.winner?.threshold ?? null,
        // The counterpart count: how many probes must ANSWER before the asset
        // reads `up` again. Resolved here rather than left to the client to
        // divide seconds by a cadence, so the intermittency strip's replay of
        // the state machine reads the same number the probe loop applied.
        recoveryPolls: downCoverage.winner
          ? recoveryPollsFor(downCoverage.winner, result.resolved.intervalSeconds)
          : null,
        automationId: downCoverage.winner?.ruleId ?? null,
        automationName: downCoverage.winner?.ruleName ?? null,
        // The colour every surface paints `down` in (business rule 36). Down
        // is not inherently red — red is what `critical` looks like, and it
        // is merely the default severity of a seeded down automation. Sent as
        // the severity NAME, not a colour: the palette belongs to the client
        // that is drawing (browser tokens vs the email's flat hex).
        severity: downCoverage.winner?.severity ?? null,
        // A tie is two equally-specific automations asking for different
        // counts on this device — surfaced so the modal can say which one
        // won rather than leaving the operator to guess.
        conflict:     downCoverage.conflict
          ? { ruleIds: downCoverage.conflict.ruleIds, counts: downCoverage.conflict.counts, chosen: downCoverage.conflict.chosen }
          : null,
      }
    : null;
  // The credential this asset's SNMP polling authenticates with — the SNMP
  // Walk tab's credential picker starts on it. null when nothing polls over
  // SNMP or no credential chain ends on an SNMP one.
  const snmpCredentialId = await snmpPollingCredentialId({
    asset: {
      monitorCredentialId:      asset.monitorCredentialId,
      responseTimeCredentialId: asset.responseTimeCredentialId,
      cpuMemoryCredentialId:    asset.cpuMemoryCredentialId,
      temperatureCredentialId:  asset.temperatureCredentialId,
      interfacesCredentialId:   asset.interfacesCredentialId,
      lldpCredentialId:         asset.lldpCredentialId,
      processesCredentialId:    asset.processesCredentialId,
      eventLogCredentialId:     asset.eventLogCredentialId,
      customWidgetCredentialId: asset.customWidgetCredentialId,
      customWidgetPolling:      asset.customWidgetPolling,
    },
    resolved:    result.resolved as unknown as Record<string, unknown>,
    integration: asset.discoveredByIntegration
      ? { type: asset.discoveredByIntegration.type, config: asset.discoveredByIntegration.config }
      : null,
  });
  return { ...result, mibLookup, integration: integrationInfo, downDetection, snmpCredentialId };
}

// ─── Assistant sections ──────────────────────────────────────────────────────

export const ASSET_SECTIONS = [
  "identity", "connections", "monitoring", "hardware", "neighbors", "wireless", "sdwan", "ipsec",
  "mac_table", "arp_table", "processes", "software", "virtualization", "lifecycle", "sources", "alerts",
] as const;
export type AssetSection = (typeof ASSET_SECTIONS)[number];

/**
 * What a section holds, for the ones whose name does not say — the tool
 * description is built from this and rides in every round, so it stays terse.
 */
export const ASSET_SECTION_HELP: Partial<Record<AssetSection, string>> = {
  identity: "all IPs/MACs, notes, HA, users",
  connections: "upstream switch/AP/firewall, MCLAG, VIPs, contacts",
  monitoring: "uptime, polling per stream, down rule, maintenance, poll errors",
  hardware: "modules, disks, temperatures, fans, PSUs",
  lifecycle: "agent, firmware, reboots",
  sources: "integrations reporting it, gate sightings",
};

/** Drop null / empty fields so a section costs the model less; Dates to ISO, BigInts to numbers. */
function compact(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(compact);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (x == null || x === "" || (Array.isArray(x) && x.length === 0)) continue;
      out[k] = compact(x);
    }
    return out;
  }
  return v;
}

/** A capped list says how much was left out, so the model never presents a slice as the whole. */
function capped<T>(rows: T[], cap: number): { rows: T[]; total: number; truncated?: true } {
  return rows.length > cap ? { rows: rows.slice(0, cap), total: rows.length, truncated: true } : { rows, total: rows.length };
}

/** A raw integration payload, cut to a size a small model can afford. */
function trimJson(v: unknown, max = 1500): unknown {
  if (v == null) return null;
  const s = JSON.stringify(v);
  return s.length <= max ? v : s.slice(0, max) + "…(cut)";
}

const notPermitted = (what: string) => ({ error: `Not permitted: your role cannot read ${what}.` });

type SectionReader = (assetId: string, req: Request, cap: number) => Promise<unknown>;

const READERS: Record<AssetSection, SectionReader> = {
  async identity(id) {
    const a = await prisma.asset.findUnique({
      where: { id },
      select: {
        hostnameOverride: true, dnsName: true, dnsNameFetchedAt: true, ipSource: true, ipOverride: true,
        primaryAddressMac: true, primaryAddressIp: true, primaryAddressPinnedAt: true, primaryAddressPinnedBy: true,
        productType: true, fortinetTopology: true, managementAccess: true,
        snmpLocation: true, latitude: true, longitude: true, coordSource: true,
        associatedUsers: true, notes: true, description: true, statusChangedAt: true, statusChangedBy: true,
        lastSeenSource: true, createdBy: true,
        quarantineReason: true, quarantinedAt: true, quarantinedBy: true,
        associatedIpRows: { select: { ip: true, source: true, interfaceName: true, lastSeen: true }, take: 100 },
        macAddressRows: { select: { mac: true, source: true, device: true, lastSeen: true }, take: 100 },
      },
    });
    if (!a) return null;
    const { fortinetTopology, ...rest } = a;
    return compact({ ...rest, fortinetTopology: trimJson(fortinetTopology) });
  },

  async connections(id, req) {
    const { resolveAssetUpstream } = await import("./assetUpstreamService.js");
    const out: Record<string, unknown> = {};
    const tasks: Promise<void>[] = [
      (async () => {
        out.upstream = await resolveAssetUpstream(id, {
          includeFirewall: hasPermission(req, "assetsQuarantine", "read"),
          includeSubnetGate: hasPermission(req, "subnets", "read"),
        });
      })(),
      (async () => {
        out.mclagPeers = await prisma.assetMclagPeer.findMany({
          where: { assetId: id },
          orderBy: [{ localPort: "asc" }],
          select: {
            localPort: true, iclTrunk: true, peerSn: true, peerName: true, peerPort: true,
            matchedAsset: { select: { id: true, hostname: true } },
          },
        });
      })(),
    ];
    if (hasPermission(req, "reservations", "read")) {
      tasks.push((async () => {
        const { resolveAssetVips } = await import("./assetVipService.js");
        out.vips = await resolveAssetVips(id);
      })());
    } else out.vips = notPermitted("reservations (VIPs)");
    if (hasPermission(req, "contacts", "read")) {
      tasks.push((async () => {
        const { resolveContactsForAsset } = await import("./contactService.js");
        out.contacts = await resolveContactsForAsset(id);
      })());
    } else out.contacts = notPermitted("contacts");
    await Promise.all(tasks);
    return compact(out);
  },

  async monitoring(id) {
    const { getAssetMaintenanceInfo } = await import("./maintenanceScheduleService.js");
    const [settings, maintenance, a, telemetry] = await Promise.all([
      getEffectiveMonitorSettings(id),
      getAssetMaintenanceInfo(id),
      prisma.asset.findUnique({
        where: { id },
        select: {
          monitored: true, monitorStatus: true, monitorStatusChangedAt: true, lastMonitorAt: true,
          lastResponseTimeMs: true, consecutiveFailures: true, consecutiveSuccesses: true,
          dependencySuppressed: true, dependencySuppressedAt: true,
          lastTelemetryAt: true, telemetryFailingSince: true, telemetryLastError: true,
          lastSystemInfoAt: true, systemInfoFailingSince: true, systemInfoLastError: true,
          lastLldpAt: true, lastStorageAt: true, lastProcessesAt: true, lastSdwanAt: true, lastCustomWidgetAt: true,
          fortilinkStatus: true, fortilinkCheckedAt: true, fortilinkChangedAt: true,
          monitoredInterfaces: true, monitoredStorage: true, monitoredIpsecTunnels: true,
          monitoredProcesses: true, monitoredServices: true,
          lastUptimeSec: true, lastRebootAt: true,
        },
      }),
      prisma.assetTelemetrySample.findFirst({
        where: { assetId: id }, orderBy: { timestamp: "desc" },
        select: { timestamp: true, cpuPct: true, memPct: true, memUsedBytes: true, memTotalBytes: true },
      }),
    ]);
    // Uptime as the System tab shows it, carried forward from the last
    // reading; the raw reading alone is the uptime at lastMonitorAt. Its
    // absence is said in words: compact() drops nulls, and a missing key is
    // what let the model conclude Polaris collects no uptime at all.
    const { lastUptimeSec: _u, lastRebootAt: _r, ...state } = a ?? {};
    const up = a ? deviceUptime(a) : null;
    return compact({
      state: a ? state : null,
      uptime: up ?? "not reported: no probe on this device reads uptime (ICMP / SSH / WinRM only)",
      latestCpuMemory: telemetry,
      streams: settings.resolved,
      settingSources: settings.provenance,
      discoveredBy: settings.integration,
      downDetection: settings.downDetection,
      maintenance,
    });
  },

  async hardware(id, _req, cap) {
    const [entities, storageMeta, hwMeta] = await Promise.all([
      prisma.assetPhysicalEntity.findMany({
        where: { assetId: id },
        orderBy: [{ entClass: "asc" }, { entIndex: "asc" }],
        select: { entClass: true, name: true, descr: true, modelName: true, serialNum: true, hardwareRev: true, firmwareRev: true, mfgName: true, isFru: true, ifName: true },
      }),
      prisma.assetStorageSample.findFirst({ where: { assetId: id }, orderBy: { timestamp: "desc" }, select: { timestamp: true } }),
      prisma.assetHardwareSensorSample.findFirst({ where: { assetId: id }, orderBy: { timestamp: "desc" }, select: { timestamp: true } }),
    ]);
    // Storage and sensors are sample tables: the latest scrape is the rows at
    // its timestamp, as the System tab reads them.
    const [storage, sensors] = await Promise.all([
      storageMeta
        ? prisma.assetStorageSample.findMany({ where: { assetId: id, timestamp: storageMeta.timestamp }, orderBy: { mountPath: "asc" }, select: { mountPath: true, totalBytes: true, usedBytes: true } })
        : [],
      hwMeta
        ? prisma.assetHardwareSensorSample.findMany({ where: { assetId: id, timestamp: hwMeta.timestamp }, orderBy: [{ sensorClass: "asc" }, { sensorName: "asc" }], select: { sensorName: true, sensorClass: true, value: true, unit: true, alarmStatus: true } })
        : [],
    ]);
    return compact({
      inventory: capped(entities, cap),
      storageAt: storageMeta?.timestamp,
      storage: storage.map((s) => ({
        ...s,
        usedPercent: s.totalBytes && s.usedBytes != null && s.totalBytes > 0n
          ? Math.round((Number(s.usedBytes) / Number(s.totalBytes)) * 1000) / 10 : null,
      })),
      sensorsAt: hwMeta?.timestamp,
      sensors: capped(sensors, cap),
    });
  },

  async neighbors(id, _req, cap) {
    const { buildInferredNeighborsForAsset, dedupeInferredNeighbors, aggregateMembershipMap } = await import("./peerInferredLldpService.js");
    const [lldp, inferred, interfaces] = await Promise.all([
      prisma.assetLldpNeighbor.findMany({
        where: { assetId: id },
        orderBy: [{ localIfName: "asc" }, { systemName: "asc" }],
        include: { matchedAsset: { select: { id: true, hostname: true, ipAddress: true, assetType: true } } },
      }),
      buildInferredNeighborsForAsset(id),
      prisma.assetInterface.findMany({ where: { assetId: id }, select: { ifName: true, ifType: true, ifParent: true } }),
    ]);
    // Real LLDP wins on collision, the same merge the System tab applies.
    const merged = [...lldp, ...dedupeInferredNeighbors(lldp, inferred, aggregateMembershipMap(interfaces))];
    return compact(capped(merged.map((n) => ({
      localPort: n.localIfName, systemName: n.systemName, portId: n.portId, portDescription: n.portDescription,
      managementIp: n.managementIp, capabilities: n.capabilities, source: n.source, lastSeen: n.lastSeen,
      matchedAsset: n.matchedAsset ? { id: n.matchedAsset.id, hostname: n.matchedAsset.hostname } : null,
    })), cap));
  },

  async wireless(id, _req, cap) {
    const { getApRadioInventory } = await import("./apRadioService.js");
    const [radios, stations] = await Promise.all([
      getApRadioInventory(id),
      prisma.assetWirelessStation.findMany({
        where: { apAssetId: id },
        orderBy: [{ ssid: "asc" }, { staMacAddr: "asc" }],
        select: {
          staMacAddr: true, staIpAddr: true, ssid: true, radioId: true, band: true, vlanId: true,
          signalStrength: true, noise: true, bandwidthTx: true, bandwidthRx: true, idleSeconds: true, lastSeen: true,
          matchedAsset: { select: { id: true, hostname: true } },
        },
      }),
    ]);
    return compact({ radios, stations: capped(stations, cap) });
  },

  async sdwan(id, _req, cap) {
    const { readSdwanMembers } = await import("./sampleHistoryService.js");
    const [rules, members] = await Promise.all([
      prisma.assetSdwanRule.findMany({
        where: { assetId: id },
        orderBy: [{ seq: "asc" }, { ruleName: "asc" }],
        select: {
          ruleName: true, seq: true, enabled: true, mode: true, criteria: true, healthChecks: true, dst: true,
          status: true, selectedMember: true, availableMembers: true, priorityZones: true, updatedAt: true,
        },
      }),
      readSdwanMembers(id),
    ]);
    return compact({ rules: capped(rules, cap), members: members.members, membersAt: members.collectedAt });
  },

  async ipsec(id, _req, cap) {
    const { readAssetIpsec } = await import("./ipsecConnectionService.js");
    const r = await readAssetIpsec(id);
    return compact({ collectedAt: r.collectedAt, tunnels: capped(r.tunnels, cap), connections: capped(r.connections, cap) });
  },

  async mac_table(id, _req, cap) {
    const where = { assetId: id };
    const [rows, total] = await Promise.all([
      prisma.assetMacTableEntry.findMany({
        where, take: cap, orderBy: [{ ifName: "asc" }, { vlanId: "asc" }, { macAddress: "asc" }],
        select: { macAddress: true, vlanId: true, ifName: true, status: true, lastSeen: true, matchedAsset: { select: { id: true, hostname: true } } },
      }),
      prisma.assetMacTableEntry.count({ where }),
    ]);
    return compact({ total, truncated: total > rows.length || undefined, rows });
  },

  async arp_table(id, _req, cap) {
    const where = { assetId: id };
    const [rows, total] = await Promise.all([
      prisma.assetArpEntry.findMany({
        where, take: cap, orderBy: [{ lastSeen: "desc" }],
        select: { ipAddress: true, macAddress: true, ifName: true, ageSec: true, lastSeen: true, matchedAsset: { select: { id: true, hostname: true } } },
      }),
      prisma.assetArpEntry.count({ where }),
    ]);
    return compact({ total, truncated: total > rows.length || undefined, rows });
  },

  async processes(id, _req, cap) {
    const { getAssetProcessConnections } = await import("./applicationMapService.js");
    const [procs, connections] = await Promise.all([
      prisma.assetProcess.findMany({
        where: { assetId: id },
        orderBy: [{ cpuPct: { sort: "desc", nulls: "last" } }, { name: "asc" }],
        select: { name: true, instanceCount: true, cpuPct: true, memRssBytes: true, username: true, serviceUnit: true, startedAt: true, updatedAt: true },
      }),
      getAssetProcessConnections(id),
    ]);
    return compact({ processes: capped(procs, cap), connections: trimJson(connections, 6000) });
  },

  async software(id, _req, cap) {
    const { getAssetSoftware } = await import("./softwareInventoryService.js");
    const v = await getAssetSoftware(id) as unknown as Record<string, unknown>;
    const rows = Array.isArray(v.rows) ? (v.rows as unknown[]) : [];
    return compact({ ...v, rows: capped(rows, cap) });
  },

  async virtualization(id, _req, cap) {
    const a = await prisma.asset.findUnique({ where: { id }, select: { virtualization: true } });
    const v = a?.virtualization as Record<string, any> | null;
    if (!v) return { virtualization: null };
    const out: Record<string, unknown> = { virtualization: trimJson(v, 4000) };
    if (typeof v.hostAssetId === "string" && v.hostAssetId) {
      out.host = await prisma.asset.findUnique({ where: { id: v.hostAssetId }, select: { id: true, hostname: true, monitorStatus: true } });
    }
    if (v.role === "host" && isWorkloadPlatform(v.platform)) {
      const children = await prisma.asset.findMany({
        where: { virtualization: { path: ["hostAssetId"], equals: id }, status: { not: "decommissioned" } },
        select: { id: true, hostname: true, assetType: true, monitorStatus: true, virtualization: true },
        orderBy: { hostname: "asc" },
        take: cap,
      });
      out.workloads = children.map((c) => {
        const cv = (c.virtualization as Record<string, any> | null) ?? {};
        return { id: c.id, hostname: c.hostname, role: cv.role, state: cv.state, image: cv.image, updateAvailable: cv.updateAvailable, monitorStatus: c.monitorStatus };
      });
    }
    return compact(out);
  },

  async lifecycle(id) {
    const [{ getUpgradeAvailability, listRunsForAsset }, { getRebootAvailability, listRebootRunsForAsset }] = await Promise.all([
      import("./firmwareUpgradeService.js"),
      import("./rebootService.js"),
    ]);
    const settle = <T>(p: Promise<T>) => p.catch((err: any) => ({ error: err?.message ?? "unavailable" }));
    const [agent, fw, fwRuns, reboot, rebootRuns] = await Promise.all([
      // The agent card, without the enrollment / bearer secrets the route strips.
      prisma.managedAgent.findUnique({
        where: { assetId: id },
        select: {
          osPlatform: true, arch: true, agentVersion: true, privilegeTier: true, installStatus: true, installError: true,
          installedAt: true, installedBy: true, installTransport: true, rebootEnabled: true, rebootCapable: true, bootTime: true,
          lastSeenAt: true, lastSeenIp: true, wsConnectedAt: true, wsDisconnectedAt: true, bearerIssuedAt: true, bearerRevokedAt: true,
        },
      }),
      settle(getUpgradeAvailability(id)),
      settle(listRunsForAsset(id, 5)),
      settle(getRebootAvailability(id)),
      settle(listRebootRunsForAsset(id, 5)),
    ]);
    // The firmware card names the device-login binding it would use; the
    // assistant gets whether one exists, never the binding itself.
    const firmware = fw && "state" in fw
      ? {
          state: fw.state, available: fw.available, reason: fw.reason, platform: fw.platform, current: fw.current,
          target: (fw.image as { version?: string } | null)?.version ?? null,
          vsPrimary: fw.vsPrimary, primaryVersion: fw.primaryVersion, blockers: fw.blockers,
          loginBound: !!fw.credential, activeRun: fw.activeRun, lastRun: fw.lastRun,
          cluster: fw.cluster ?? null, clusterPrimary: fw.clusterPrimary ?? null,
        }
      : fw;
    return compact({ agent, firmware, firmwareRuns: fwRuns, reboot, rebootRuns });
  },

  async sources(id, req, cap) {
    const { hostPinsForAsset } = await import("./agentHostPinService.js");
    const [sources, pins] = await Promise.all([
      prisma.assetSource.findMany({
        where: { assetId: id },
        orderBy: { lastSeen: "desc" },
        select: {
          sourceKind: true, externalId: true, inferred: true, firstSeen: true, lastSeen: true, syncedAt: true, observed: true,
          integration: { select: { name: true, type: true } },
        },
      }),
      hostPinsForAsset(id).catch(() => null),
    ]);
    const out: Record<string, unknown> = {
      sources: capped(sources.map((s) => ({ ...s, observed: trimJson(s.observed) })), cap),
      hostKeyPins: pins,
    };
    if (hasPermission(req, "assetsQuarantine", "read")) {
      const { getSightingsForAsset } = await import("./assetSightingService.js");
      out.gateSightings = capped(await getSightingsForAsset(id), cap);
    } else out.gateSightings = notPermitted("gate sightings");
    return compact(out);
  },

  async alerts(id, _req, cap) {
    // The Alerts tab's own read (gated assets:read, as its route is). Always
    // the automation SUMMARY: a full row can carry api_call headers, and
    // get_automation is the masked way to read one.
    const { getAssetNotifications } = await import("./notificationService.js");
    const r = await getAssetNotifications(id, { fullRules: false });
    const active = (r.active as Array<Record<string, any>>).map((n) => ({
      severity: n.severity, message: n.message, triggeredAt: n.triggeredAt, acknowledged: n.acknowledged,
      acknowledgedBy: n.acknowledgedBy, automation: n.ruleName, alertGroup: n.groupName,
      maintenanceHold: n.maintenanceHold ? true : null,
    }));
    return compact({ active: capped(active, cap), automationsApplying: capped(r.matchingRules as unknown[], cap) });
  },
};

/**
 * Read the named sections of one asset for the caller. The caller has
 * already passed `assets:read` (the tool checks it before resolving the
 * asset); each section applies its own second keys. A section that fails
 * says so in its own slot — the others still answer.
 */
export async function readAssetSections(
  assetId: string,
  sections: AssetSection[],
  req: Request,
  cap: number,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  await Promise.all([...new Set(sections)].map(async (s) => {
    try {
      out[s] = await READERS[s](assetId, req, cap);
    } catch (err: any) {
      out[s] = { error: err?.message ?? "lookup failed" };
    }
  }));
  return out;
}

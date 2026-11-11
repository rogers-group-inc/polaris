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
import { resolveMonitorSettingsWithProvenance, resolveMonitorSettings } from "./monitoringService.js";
import { snmpPollingCredentialId } from "./assetCredentialScopeService.js";
import { describeDownDetectionFor, recoveryPollsFor } from "./downDetectionService.js";
import { deviceUptime } from "../utils/uptime.js";
import { getIpHistory } from "./assetIpHistoryService.js";
import { descriptionSyncEnabledForRole } from "../utils/descriptionSyncFlags.js";
import { buildIpContexts, networksForAddresses } from "./subnetService.js";
import { getDiscoveredHostname } from "./discoveredHostnameService.js";
import { shapeMacRows, MAC_ROW_SELECT } from "../utils/macAddresses.js";
import { pickSampleTierForAsset } from "./sampleQueryRouter.js";
import { extendSinceForLookback } from "../utils/chartRange.js";
import { readMonitorHistory, readLastMonitorSuccessAt } from "./sampleHistoryService.js";
import { isFortinetIntegrationType } from "../utils/pollingCompatibility.js";
import { logger } from "../utils/logger.js";
import { reconcileAddressesWithIpam, shapeAssociatedIps, ASSOCIATED_IP_SELECT } from "./assetAddressService.js";
import { buildAddressConfidence, confidenceToJson } from "./addressConfidenceService.js";

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

/**
 * 404 unless the asset exists — the guard the assets routes run before a read
 * whose own service would answer an unknown id with an empty result rather
 * than a 404 (CQ-B062 slice 2).
 */
export async function assertAssetExists(id: string): Promise<void> {
  const asset = await prisma.asset.findUnique({ where: { id }, select: { id: true } });
  if (!asset) throw new AppError(404, "Asset not found");
}

/**
 * GET /assets/:id/tls-pins — the TLS endpoints this asset's discovering
 * integration dials with a token and the certificate pinned for each (rule
 * 113(e)). 404 for an unknown asset. tlsCertPinService is loaded on demand, as
 * the route did. Moved out of routes/assets/addresses.ts (CQ-B062 slice 2).
 */
export async function assetTlsPins(id: string) {
  const asset = await prisma.asset.findUnique({
    where: { id },
    select: { assetType: true, ipAddress: true, discoveredByIntegration: { select: { type: true, name: true, config: true } } },
  });
  if (!asset) throw new AppError(404, "Asset not found");
  const { assetTlsEndpoints } = await import("./tlsCertPinService.js");
  const integration = asset.discoveredByIntegration
    ? { ...asset.discoveredByIntegration, config: (asset.discoveredByIntegration.config ?? {}) as Record<string, unknown> }
    : null;
  return assetTlsEndpoints({ assetType: asset.assetType, ipAddress: asset.ipAddress }, integration);
}

/**
 * GET /assets/:id — the asset details payload: re-checks the DHCP addresses
 * against IPAM first (rule 102(a), never fails the read), then the asset with
 * its credentials, IP context, address confidence (rule 103), associated IPs
 * with their networks, MACs, the discovered hostname when pinned, and the
 * discovering integration with its secret-bearing config stripped. The route
 * adds the caller's per-row write-scope flags (rule 141(e)). 404 when absent.
 */
export async function getAssetDetail(id: string, actor: string | undefined) {
  // Opening the details re-checks the asset's DHCP addresses against IPAM
  // (business rule 102(a)) so an IPAM release or re-assignment shows here
  // without waiting for the next gate read. A read grant is enough: it only
  // drops or re-labels rows discovery itself wrote. Never fails the read.
  try {
    await reconcileAddressesWithIpam(id, actor);
  } catch (err) {
    logger.warn({ err, assetId: id }, "IPAM address cross-check failed; serving stored addresses");
  }
  const asset = await prisma.asset.findUnique({
    where: { id: id },
    include: {
      discoveredByIntegration:  { select: { id: true, name: true, type: true, config: true } },
      monitorCredential:        { select: { id: true, name: true, type: true } },
      responseTimeCredential:   { select: { id: true, name: true, type: true } },
      cpuMemoryCredential:      { select: { id: true, name: true, type: true } },
      temperatureCredential:    { select: { id: true, name: true, type: true } },
      interfacesCredential:     { select: { id: true, name: true, type: true } },
      lldpCredential:           { select: { id: true, name: true, type: true } },
      associatedIpRows:         { select: ASSOCIATED_IP_SELECT },
      macAddressRows:           { select: MAC_ROW_SELECT },
    },
  });
  if (!asset) throw new AppError(404, "Asset not found");
  const ipCtx = asset.ipAddress
    ? (await buildIpContexts([asset.ipAddress])).get(asset.ipAddress) || null
    : null;

  // Resolve the integration's response-time probe override so the details
  // panel can label the chart with the actual probe method (SNMP via the
  // override credential, vs. the default FortiOS REST API path). The
  // integration's full `config` is not safe to leak to the client (it
  // contains API tokens), so strip it after extracting the credential id
  // and the FMG `useProxy` toggle (the System tab badges need to know
  // whether REST API traffic rides FMG's `/sys/proxy/json` or hits the
  // FortiGate directly).
  let integrationMonitorCredential: { id: string; name: string; type: string } | null = null;
  let integrationUseProxy: boolean | null = null;
  let integrationSyncDescriptions: boolean | null = null;
  // The FMG ADOM — not a secret — so the Device Query tab's API Query can
  // address the gate through FortiManager's /sys/proxy/json.
  let integrationAdom: string | null = null;
  if (asset.discoveredByIntegration) {
    const cfg = (asset.discoveredByIntegration.config as Record<string, unknown> | null) || {};
    const credId = typeof cfg.monitorCredentialId === "string" ? cfg.monitorCredentialId : null;
    if (credId) {
      const cred = await prisma.credential.findUnique({
        where: { id: credId },
        select: { id: true, name: true, type: true },
      });
      if (cred) integrationMonitorCredential = cred;
    }
    // Only meaningful for FortiManager; standalone FortiGate is always direct.
    if (asset.discoveredByIntegration.type === "fortimanager") {
      integrationUseProxy = cfg.useProxy !== false;
      integrationAdom = typeof cfg.adom === "string" && cfg.adom ? cfg.adom : "root";
    }
    // Description Sync is a FortiManager + standalone FortiGate toggle. Expose
    // a derived boolean (the raw config is stripped below — it holds API
    // tokens) so the asset edit form can cap the FortiAP Description at the
    // 35-char device `location` limit, but only when this AP's integration
    // actually syncs descriptions to the device. The toggle is per device
    // class, so this is resolved for THIS asset's Fortinet role.
    if (isFortinetIntegrationType(asset.discoveredByIntegration.type)) {
      const role = ((asset.fortinetTopology ?? {}) as { role?: string }).role;
      integrationSyncDescriptions = descriptionSyncEnabledForRole(cfg, role);
    }
  }
  const { config: _omit, ...integrationLite } = (asset.discoveredByIntegration as { config?: unknown } | null) || {};
  const { associatedIpRows, macAddressRows, ...assetRest } = asset;
  // Same second line as the list's hostname cell: what discovery says, for a
  // row whose hostname is currently pinned. Only queried when pinned.
  const hostnameDiscovered = asset.hostnameOverride
    ? await getDiscoveredHostname(asset.id)
    : null;
  // Business rule 103 — every address's confidence with its breakdown.
  const addressConfidence = confidenceToJson((await buildAddressConfidence([asset.id])).get(asset.id));
  // The IPAM network each address sits in, for the address hover — the
  // narrowest containing network, on the row's own gate where ranges repeat.
  const shapedIps = shapeAssociatedIps(associatedIpRows);
  const networks = await networksForAddresses(
    shapedIps.map((r) => ({ ip: r.ip, gate: r.device ?? null })),
    asset.learnedLocation,
  );
  const safeAsset = {
    ...assetRest,
    addressConfidence,
    associatedIps: shapedIps.map((r) => ({ ...r, network: networks.get(`${r.ip}|${r.device ?? ""}`) ?? null })),
    macAddresses:  shapeMacRows(macAddressRows),
    hostnameDiscovered,
    discoveredByIntegration: asset.discoveredByIntegration
      ? { ...integrationLite, useProxy: integrationUseProxy, adom: integrationAdom, syncDescriptions: integrationSyncDescriptions }
      : null,
    integrationMonitorCredential,
  };
  return { safeAsset, ipCtx, scopeRec: { createdBy: (asset as { createdBy?: string | null }).createdBy ?? null, tags: (asset as { tags?: string[] }).tags ?? [] } };
}

/**
 * GET /assets/:id/ip-history — the IP history with each row's network (the
 * VLAN column): a "<gate>" / "<gate>:arp" source names the gate that settles a
 * repeated range, then the asset's own gate. 404 when absent.
 */
export async function getAssetIpHistory(id: string) {
  const asset = await prisma.asset.findUnique({ where: { id: id }, select: { id: true, learnedLocation: true } });
  if (!asset) throw new AppError(404, "Asset not found");
  const history = await getIpHistory(id);
  // Each row's network (the IP History table's VLAN column): a source of
  // "<gate>" or "<gate>:arp" names the gate that settles a repeated range,
  // then the asset's own gate.
  const gateOf = (source: string | null) => (source ? source.split(":")[0].trim() || null : null);
  const networks = await networksForAddresses(
    history.map((h) => ({ ip: h.ip, gate: gateOf(h.source) })),
    asset.learnedLocation,
  );
  return history.map((h) => {
    const network = networks.get(`${h.ip}|${gateOf(h.source) ?? ""}`) ?? null;
    return { ...h, vlan: network?.vlan ?? null, network };
  });
}

/** The owner + tags the write-scope judgement reads (rule 141(e)) for one asset. 404 when absent. */
export async function loadAssetScopeRecord(id: string) {
  const asset = await findAssetScopeRecord(id);
  if (!asset) throw new AppError(404, "Asset not found");
  return asset;
}

/** The same record, or null when the asset is gone (a caller for whom absence is an answer). */
export async function findAssetScopeRecord(id: string) {
  return prisma.asset.findUnique({ where: { id }, select: { id: true, createdBy: true, tags: true } });
}

/**
 * GET /assets/:id/monitor-history — the response-time series for a preset
 * range (1h / 12h / 24h / 7d / 30d, default 24h) or a custom from / to (400
 * when invalid, reversed or over a year), on the tier the window needs, with
 * the loss overlay, the last real success on a rollup tier, and the covering
 * automation's missed / recovery polls and severity (rules 30, 36).
 */
export async function readAssetMonitorHistory(id: string, fromQ: string | null, toQ: string | null, rangeQ: string): Promise<Record<string, unknown>> {
  let since: Date;
  let until: Date;
  let rangeLabel: string;
  if (fromQ && toQ) {
    const f = new Date(fromQ), t = new Date(toQ);
    if (isNaN(+f) || isNaN(+t)) throw new AppError(400, "Invalid from/to date");
    if (+f >= +t) throw new AppError(400, "from must be before to");
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    if (+t - +f > oneYearMs) throw new AppError(400, "Custom range cannot exceed 1 year");
    since = f;
    until = t;
    rangeLabel = "custom";
  } else {
    const range = rangeQ;
    const windowMs =
      range === "1h"  ?  1 * 60 * 60 * 1000 :
      range === "12h" ? 12 * 60 * 60 * 1000 :
      range === "7d"  ?  7 * 24 * 60 * 60 * 1000 :
      range === "30d" ? 30 * 24 * 60 * 60 * 1000 :
                          24 * 60 * 60 * 1000;
    until = new Date();
    since = new Date(+until - windowMs);
    rangeLabel = range;
  }
  const pick = await pickSampleTierForAsset(id, "assets", since);
  const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
  const result = await readMonitorHistory(id, since, until, pick.tier, fetchSince);
  // On a rollup tier every sample timestamp is a bucketStart, so the client
  // can't measure probe freshness from the series (a daily bucket is up to
  // 24h "old" the moment it's written). Hand it the real last-success
  // timestamp from the detail table instead — the stale banner reads this
  // when present. Detail tier needs no extra query: its own newest
  // successful sample already is the answer.
  const lastSuccessAt = pick.tier === "detail" ? null : await readLastMonitorSuccessAt(id, since);
  // WHICH MISSES ARE ALREADY A VERDICT. The chart replays the leaky bucket to
  // colour its dive (business rule 30 + 36): amber while the count is short
  // of the covering automation's `missedPolls`, red once it reaches it — the
  // same split the Last-30-min strip draws directly above it. It rides this
  // payload rather than a second request because the chart renders the moment
  // this resolves, and a threshold arriving later would repaint the outage
  // under the operator. `passive: true` means no automation covers the device,
  // so nothing may go red. Reads the resolver's cached index — no query in the
  // steady state — and degrades to null rather than failing the history.
  const downCoverage = await describeDownDetectionFor(id).catch(() => null);
  // The counterpart count: how many probes must ANSWER before the device
  // reads Up again (business rule 36). The chart needs it for the same reason
  // the strip does — the climb out of an outage stays purple until the run is
  // served, which is LONGER than the bucket's drain whenever the automation's
  // reset asks for more. Resolving it costs an asset read only when the
  // automation actually sets a reset hold; without one the answer is the
  // missed-poll count itself and no cadence is involved.
  let recoveryPolls: number | null = null;
  const downWinner = downCoverage?.winner ?? null;
  if (downWinner) {
    if (!downWinner.recoverySustainSec) {
      recoveryPolls = downWinner.threshold;
    } else {
      const ctx = await prisma.asset.findUnique({
        where: { id },
        select: {
          assetType: true, discoveredByIntegrationId: true, monitorIntervalSec: true,
          cpuMemoryIntervalSec: true, temperatureIntervalSec: true, systemInfoIntervalSec: true,
          probeTimeoutMs: true,
          discoveredByIntegration: { select: { type: true } },
        },
      });
      if (ctx) {
        const resolved = await resolveMonitorSettings({
          ...ctx,
          discoveredByIntegrationType: ctx.discoveredByIntegration?.type ?? null,
        });
        recoveryPolls = recoveryPollsFor(downWinner, resolved.intervalSeconds);
      }
    }
  }
  return {
    range: rangeLabel,
    since,
    until,
    tier: pick.tier,
    bucketSeconds: pick.bucketSeconds,
    lastSuccessAt,
    downDetection: downCoverage
      ? {
          passive: downCoverage.passive,
          missedPolls: downWinner?.threshold ?? null,
          recoveryPolls,
          // What the covering automation rated this outage — the colour the
          // response-time chart draws a `down` probe in. See business rule 36.
          severity: downWinner?.severity ?? null,
        }
      : null,
    samples: result.samples,
    // The packet-loss line the chart overlays on its right axis — every
    // probe kind, the ICMP sweep's packets included (see MonitorLossSeries).
    loss: result.loss,
    stats: result.stats,
  };
}

/**
 * src/services/assetSystemTabService.ts — The asset details System-tab family's reads: the System tab itself (telemetry,
 * interfaces, storage, sensors, LLDP, wireless, physical entities, IPsec, radios,
 * outages), the process list, the MAC and ARP tables with their freshness, and
 * the service inventory. Moved out of routes/assets/system.ts (CQ-B062 slice 2);
 * the route keeps the gates and the query parsing.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { splitOpticsSamples } from "../utils/sfpOptics.js";
import { readLatestIpsecTunnels } from "./ipsecConnectionService.js";
import { getApRadioInventory } from "./apRadioService.js";
import { getArpEntryRetentionDays } from "./sampleRetentionService.js";
import { fillMacTableVlans, getVlanNamesForAsset, portVlansFor, readPortVlans } from "./vlanNameService.js";
import { listInterfaceTags } from "./interfaceTagService.js";
import { getFcByInterface } from "./fibreChannelService.js";
import { activeAlertSummaryByAsset } from "./notificationService.js";
import { buildInferredNeighborsForAsset, dedupeInferredNeighbors, aggregateMembershipMap } from "./peerInferredLldpService.js";
import { resolveCurrentStateIntervalSec } from "./monitoring/monitorSettings.js";

// ─── System tab endpoints ──────────────────────────────────────────────────
//
// Telemetry, interface, and storage histories live on /assets/:id/... and
// share the same range/from-to query semantics as /monitor-history. BigInt
// columns are coerced to Number on the way out — interface octets up to
// 2^53-1 (≈9 PB) fit safely.

// resolveRange / extendSinceForLookback live in utils/chartRange.ts (shared
// with the path-checks route's Polaris-server history).

function bigIntToNumber(v: bigint | null | undefined): number | null {
  if (v == null) return null;
  return Number(v);
}

/**
 * GET /assets/:id/system-info — the System tab: the latest telemetry, interfaces (with tags,
 * optics and alerts), storage, hardware sensors, LLDP neighbours (reported and inferred),
 * wireless stations, physical entities, IPsec tunnels, AP radios and probe outages. 404 when absent.
 */
export async function getAssetSystemInfo(id: string) {
  const asset = await prisma.asset.findUnique({
    where: { id },
    select: {
      id: true, monitored: true,
      lastTelemetryAt: true, lastSystemInfoAt: true,
      // Business rule 118 — the open failure run, so the section headers
      // can say a poll failed and why instead of only how old the data is.
      lastTelemetryAttemptAt: true, telemetryFailingSince: true, telemetryLastError: true,
      lastSystemInfoAttemptAt: true, systemInfoFailingSince: true, systemInfoLastError: true,
      monitoredInterfaces: true,
      monitoredStorage: true,
      monitoredIpsecTunnels: true,
    },
  });
  if (!asset) throw new AppError(404, "Asset not found");

  const [latestTelemetry, interfaces, latestStorageMeta, latestHwMeta, ipsecTunnels, lldpNeighbors, wirelessStations, apRadios, inferredNeighbors] = await Promise.all([
    prisma.assetTelemetrySample.findFirst({
      where: { assetId: id },
      orderBy: { timestamp: "desc" },
    }),
    // Current-state interface inventory — one row per ifName, delete-replaced
    // per full scrape, so it needs no timestamp gate the way the sample
    // tables do (same shape as the physicalEntities read below).
    prisma.assetInterface.findMany({
      where: { assetId: id },
      orderBy: { ifName: "asc" },
    }),
    prisma.assetStorageSample.findFirst({
      where: { assetId: id },
      orderBy: { timestamp: "desc" },
      select: { timestamp: true },
    }),
    prisma.assetHardwareSensorSample.findFirst({
      where: { assetId: id },
      orderBy: { timestamp: "desc" },
      select: { timestamp: true },
    }),
    // The last full pass's tunnel set (see readLatestIpsecTunnels for why
    // it anchors to lastSystemInfoAt rather than the newest row).
    readLatestIpsecTunnels(id, asset.lastSystemInfoAt),
    // LLDP neighbors are current-state (one row per neighbor) rather than
    // a time-series, so we just return the entire set on every call. The
    // matched-asset relation lets the UI link from a neighbor row directly
    // to that asset's details modal.
    prisma.assetLldpNeighbor.findMany({
      where: { assetId: id },
      orderBy: [{ localIfName: "asc" }, { systemName: "asc" }],
      include: {
        matchedAsset: {
          select: { id: true, hostname: true, ipAddress: true, assetType: true },
        },
      },
    }),
    // Wireless stations connected to this AP (current-state, like LLDP).
    // Empty for non-AP assets — the table only carries rows when the
    // SNMP fapStationTable scrape ran on an `assetType="access_point"`
    // asset. matchedAsset cross-links to the connected endpoint when the
    // station's MAC resolved against the inventory.
    prisma.assetWirelessStation.findMany({
      where: { apAssetId: id },
      orderBy: [{ ssid: "asc" }, { staMacAddr: "asc" }],
      include: {
        matchedAsset: {
          select: { id: true, hostname: true, ipAddress: true, assetType: true },
        },
      },
    }),
    // The AP's radios with the SSIDs each one broadcasts nested inside —
    // the two levels above the wireless stations below, so the Stations tab
    // can render radio -> SSID -> station. Empty for every non-AP asset and
    // for any AP a discovery cycle has not reached yet.
    getApRadioInventory(id),
    // Peer-inferred neighbors synthesized from Asset.fortinetTopology
    // (managed FortiAPs reported via FortiGate, FortiSwitch FortiLink
    // uplinks, etc.). Real LLDP rows take precedence on collision —
    // dedupe by (localIfName, matchedAssetId) below.
    buildInferredNeighborsForAsset(id),
  ]);

  // `interfaces` now comes straight from the current-state table above. The
  // former lastSystemInfoAt anchor (and its clamp for the agent's
  // independent interface/storage pushes, which could leave the anchor at a
  // time with no interface rows and empty this table) existed only because a
  // hypertable has no notion of "current" — both are gone with it.

  // Merge inferred neighbors after the interface rows are loaded so an
  // inferred row on an aggregate (e.g. FortiLink) dedupes against a real
  // LLDP row learned on one of its member ports — same physical link.
  const mergedNeighbors = [
    ...lldpNeighbors,
    ...dedupeInferredNeighbors(lldpNeighbors, inferredNeighbors, aggregateMembershipMap(interfaces)),
  ];
  // Hardware inventory is current-state (delete-replaced per scrape), so it
  // needs no timestamp gate the way the sample tables do.
  const physicalEntities = await prisma.assetPhysicalEntity.findMany({
    where: { assetId: id },
    orderBy: [{ entClass: "asc" }, { entIndex: "asc" }],
  });
  const storage = latestStorageMeta
    ? await prisma.assetStorageSample.findMany({
        where: { assetId: id, timestamp: latestStorageMeta.timestamp },
        orderBy: { mountPath: "asc" },
      })
    : [];
  const latestHardwareSensors = latestHwMeta
    ? await prisma.assetHardwareSensorSample.findMany({
        where: { assetId: id, timestamp: latestHwMeta.timestamp },
        orderBy: [{ sensorClass: "asc" }, { sensorName: "asc" }],
      })
    : [];
  // Transceiver readings attributed to a port (business rule 143) leave the
  // Hardware Sensors list and ride on their interface row instead.
  const { sensors: hardwareSensors, optics: opticsByIf } = splitOpticsSamples(
    latestHardwareSensors,
    new Set(interfaces.map((i) => i.ifName)),
  );
  // VLAN id -> name for the Native / Tagged VLAN pills (vlanNameService),
  // and the active-alert summary of every neighbor that resolved to an
  // asset — the Interfaces table's Neighbor cell draws the same strobing
  // dot the Assets list does, so a port facing an alarmed device says so.
  // One query for the whole neighbor set, never one per row.
  const neighborAssetIds = [...new Set(
    mergedNeighbors.map((n) => n.matchedAsset?.id).filter((v): v is string => !!v),
  )];
  const [vlanNames, neighborAlerts, interfaceTags, fcByIf] = await Promise.all([
    getVlanNamesForAsset(id),
    activeAlertSummaryByAsset(neighborAssetIds),
    listInterfaceTags(id),
    // An FC switch port's counters and logged-in devices (rule 159a).
    getFcByInterface(id),
  ]);

  return {
    monitored: asset.monitored,
    lastTelemetryAt: asset.lastTelemetryAt,
    lastTelemetryAttemptAt: asset.lastTelemetryAttemptAt,
    telemetryFailingSince: asset.telemetryFailingSince,
    telemetryLastError: asset.telemetryLastError,
    lastTemperatureAt: latestHwMeta?.timestamp ?? null,
    lastSystemInfoAt: asset.lastSystemInfoAt,
    lastSystemInfoAttemptAt: asset.lastSystemInfoAttemptAt,
    systemInfoFailingSince: asset.systemInfoFailingSince,
    systemInfoLastError: asset.systemInfoLastError,
    telemetry: latestTelemetry ? {
      timestamp:     latestTelemetry.timestamp,
      cpuPct:        latestTelemetry.cpuPct,
      memPct:        latestTelemetry.memPct,
      memUsedBytes:  bigIntToNumber(latestTelemetry.memUsedBytes),
      memTotalBytes: bigIntToNumber(latestTelemetry.memTotalBytes),
    } : null,
    interfaces: interfaces.map((i) => ({
      // Response shape is unchanged for the frontend: `timestamp` is now the
      // current-state row's lastSeen (the full-pass time it was observed),
      // which is exactly what the old per-sample timestamp carried.
      timestamp:   i.lastSeen,
      ifName:      i.ifName,
      adminStatus: i.adminStatus,
      operStatus:  i.operStatus,
      speedBps:    bigIntToNumber(i.speedBps),
      duplex:      i.duplex ?? null,
      ipAddress:   i.ipAddress,
      ipv6Address: i.ipv6Address ?? null,
      macAddress:  i.macAddress,
      // A fibre-channel port's own WWN, its counters and what is logged into
      // it (business rule 159a); null on every other port.
      wwn:         i.wwn ?? null,
      fc:          fcByIf.get(i.ifName) ?? null,
      inOctets:    bigIntToNumber(i.inOctets),
      outOctets:   bigIntToNumber(i.outOctets),
      inErrors:    bigIntToNumber(i.inErrors),
      outErrors:   bigIntToNumber(i.outErrors),
      ifType:      i.ifType   ?? null,
      ifSubtype:   i.ifSubtype ?? null,
      ifParent:    i.ifParent ?? null,
      vlanId:      i.vlanId   ?? null,
      nativeVlan:     i.nativeVlan  ?? null,
      taggedVlans:    i.taggedVlans ?? [],
      trunksAllVlans: i.trunksAllVlans === true,
      alias:       i.alias       ?? null,
      description: i.description ?? null,
      addressingMode: i.addressingMode ?? null,
      poeStatus:   i.poeStatus ?? null,
      poeClass:    i.poeClass  ?? null,
      // Transceiver DDM readings for an SFP port (business rule 143), from
      // the latest hardware-sensor pass; null on every other port.
      optics:      opticsByIf.get(i.ifName) ?? null,
      // Hand-applied and filter-applied tags (business rule 133).
      tags:        interfaceTags.get(i.ifName) ?? [],
    })),
    vlanNames,
    physicalEntities: physicalEntities.map((e) => ({
      entIndex:    e.entIndex,
      entClass:    e.entClass,
      descr:       e.descr,
      name:        e.name,
      hardwareRev: e.hardwareRev,
      firmwareRev: e.firmwareRev,
      serialNum:   e.serialNum,
      mfgName:     e.mfgName,
      modelName:   e.modelName,
      isFru:       e.isFru,
      ifName:      e.ifName,
      firstSeen:   e.firstSeen,
    })),
    storage: storage.map((s) => ({
      timestamp:  s.timestamp,
      mountPath:  s.mountPath,
      totalBytes: bigIntToNumber(s.totalBytes),
      usedBytes:  bigIntToNumber(s.usedBytes),
    })),
    hardwareSensors: hardwareSensors.map((s) => ({
      timestamp:   s.timestamp,
      sensorName:  s.sensorName,
      sensorClass: s.sensorClass,
      value:       s.value,
      unit:        s.unit,
      alarmStatus: s.alarmStatus,
    })),
    ipsecTunnels,
    lldpNeighbors: mergedNeighbors.map((n) => ({
      localIfName:        n.localIfName,
      chassisIdSubtype:   n.chassisIdSubtype,
      chassisId:          n.chassisId,
      portIdSubtype:      n.portIdSubtype,
      portId:             n.portId,
      portDescription:    n.portDescription,
      systemName:         n.systemName,
      systemDescription:  n.systemDescription,
      managementIp:       n.managementIp,
      capabilities:       n.capabilities,
      source:             n.source,
      firstSeen:          n.firstSeen,
      lastSeen:           n.lastSeen,
      matchedAsset:       n.matchedAsset
        ? {
            id:        n.matchedAsset.id,
            hostname:  n.matchedAsset.hostname,
            ipAddress: n.matchedAsset.ipAddress,
            assetType: n.matchedAsset.assetType,
            alert:     neighborAlerts.get(n.matchedAsset.id) ?? null,
          }
        : null,
    })),
    apRadios,
    wirelessStations: wirelessStations.map((w) => ({
      staMacAddr:     w.staMacAddr,
      staIpAddr:      w.staIpAddr,
      ssid:           w.ssid,
      radioId:        w.radioId,
      wlanId:         w.wlanId,
      band:           w.band,
      vlanId:         w.vlanId,
      bssid:          w.bssid,
      signalStrength: w.signalStrength,
      noise:          w.noise,
      bandwidthTx:    w.bandwidthTx,
      bandwidthRx:    w.bandwidthRx,
      idleSeconds:    w.idleSeconds,
      source:         w.source,
      firstSeen:      w.firstSeen,
      lastSeen:       w.lastSeen,
      matchedAsset:   w.matchedAsset
        ? {
            id:        w.matchedAsset.id,
            hostname:  w.matchedAsset.hostname,
            ipAddress: w.matchedAsset.ipAddress,
            assetType: w.matchedAsset.assetType,
          }
        : null,
    })),
    monitoredInterfaces:   (asset.monitoredInterfaces   ?? []) as string[],
    monitoredStorage:      (asset.monitoredStorage      ?? []) as string[],
    monitoredIpsecTunnels: (asset.monitoredIpsecTunnels ?? []) as string[],
  };
}

/** GET /assets/:id/processes — the latest process snapshot and the asset's process monitors. 404 when absent. */
export async function getAssetProcesses(id: string) {
  const asset = await prisma.asset.findUnique({
    where: { id },
    select: {
      monitoredProcesses: true, alertWatchedProcesses: true, mappedProcesses: true,
    },
  });
  if (!asset) throw new AppError(404, "Asset not found");
  const [rows, configs] = await Promise.all([
    prisma.assetProcess.findMany({
      where: { assetId: id },
      orderBy: [{ cpuPct: "desc" }, { name: "asc" }],
    }),
    prisma.assetProcessConfig.findMany({ where: { assetId: id } }),
  ]);
  // Per-program log config keyed by name, so the detail slide-in can pre-fill
  // the log-path field without a second call.
  const configsByName: Record<string, { logSource: string | null; logPathGlob: string | null; detectedUnit: string | null; notes: string | null }> = {};
  for (const c of configs) {
    configsByName[c.name] = { logSource: c.logSource, logPathGlob: c.logPathGlob, detectedUnit: c.detectedUnit, notes: c.notes };
  }
  return {
    processes: rows.map((p) => ({
      name:          p.name,
      instanceCount: p.instanceCount,
      cpuPct:        p.cpuPct,
      memRssBytes:   p.memRssBytes != null ? p.memRssBytes.toString() : null,
      exePath:       p.exePath,
      username:      p.username,
      startedAt:     p.startedAt,
      serviceUnit:   p.serviceUnit,
      controllable:  p.controllable,
    })),
    configs: configsByName,
    monitoredProcesses:    (asset.monitoredProcesses    ?? []) as string[],
    alertWatchedProcesses: (asset.alertWatchedProcesses ?? []) as string[],
    mappedProcesses:       (asset.mappedProcesses       ?? []) as string[],
  };
}

/**
 * GET /assets/:id/mac-table — the switch's forwarding database with the VLAN fill, VLAN names,
 * per-port configured VLANs, and the freshness pair (collectedAt, the system-info cadence).
 */
export async function getAssetMacTable(id: string) {
  const rows = await prisma.assetMacTableEntry.findMany({
    where: { assetId: id },
    orderBy: [{ ifName: "asc" }, { macAddress: "asc" }],
    include: {
      matchedAsset: { select: { id: true, hostname: true, ipAddress: true, assetType: true } },
    },
  });
  const portCounts: Record<string, number> = {};
  let collectedAt: Date | null = null;
  for (const r of rows) {
    if (!collectedAt || r.lastSeen > collectedAt) collectedAt = r.lastSeen;
    if (r.status !== "learned" || !r.ifName) continue;
    portCounts[r.ifName] = (portCounts[r.ifName] ?? 0) + 1;
  }
  const pollIntervalSec = await resolveCurrentStateIntervalSec(id, { discoveryFallback: false });
  // `collectedAt` is null on a wiped table, where "collected and empty" and
  // "never collected" look identical from the rows alone. The asset's own
  // pass stamp separates them: a switch polled over REST via its parent
  // FortiGate has a recent one and no FDB, and the tab must not call that
  // "never collected".
  const passAsset = await prisma.asset.findUnique({
    where: { id },
    select: { lastSystemInfoAt: true },
  });
  // A FortiSwitch answers only the VLAN-less BRIDGE-MIB table, so its rows
  // arrive with no VLAN; an access port's native VLAN fills them in
  // (`vlanInferred` marks those). vlanNames labels the pills.
  // Every port's VLAN config, read once: it fills the VLAN-less rows AND is
  // the per-port native / tagged line (`portVlans`) the tab prints beside
  // the VLAN each entry was learned in.
  const ports = (await readPortVlans([id])).get(id);
  const [entries, vlanNames] = await Promise.all([
    fillMacTableVlans(id, rows.map((r) => ({
      macAddress: r.macAddress,
      vlanId:     r.vlanId,
      basePort:   r.basePort,
      ifName:     r.ifName,
      status:     r.status,
      firstSeen:  r.firstSeen,
      lastSeen:   r.lastSeen,
      matchedAsset: r.matchedAsset,
    })), ports),
    getVlanNamesForAsset(id),
  ]);
  return {
    entries,
    vlanNames,
    portVlans: portVlansFor(ports, rows.map((r) => r.ifName)),
    portCounts,
    collectedAt,
    lastSystemInfoAt: passAsset?.lastSystemInfoAt ?? null,
    pollIntervalSec,
    total: rows.length,
  };
}

/**
 * GET /assets/:id/arp-table — the gate's neighbour cache for a range (`current` = the newest
 * read only, within ARP_CURRENT_TOLERANCE_MS), with retention, interface counts and the
 * per-device refresh figure.
 */
export async function getAssetArpTable(id: string, range: keyof typeof ARP_RANGE_SECONDS) {

  // Retention bounds what any range can actually reach, so it is reported
  // rather than assumed: offering "last 30 days" on an install that keeps 7
  // promises history that was pruned days ago.
  const retentionDays = await getArpEntryRetentionDays();
  const windowSec = ARP_RANGE_SECONDS[range];
  let since: Date | null = null;
  if (windowSec != null) {
    since = new Date(Date.now() - windowSec * 1000);
  } else {
    // Current: only what the newest read touched. Without this the view is
    // every row still inside retention — stale neighbours included.
    const newest = await prisma.assetArpEntry.aggregate({
      where: { assetId: id },
      _max: { lastSeen: true },
    });
    const latest = newest._max.lastSeen;
    if (latest) since = new Date(latest.getTime() - ARP_CURRENT_TOLERANCE_MS);
  }

  const rows = await prisma.assetArpEntry.findMany({
    where: { assetId: id, ...(since ? { lastSeen: { gte: since } } : {}) },
    // Final ordering is the browser's (numeric IP within interface); this
    // just keeps the payload stable.
    orderBy: [{ ifName: "asc" }, { ipAddress: "asc" }],
    include: {
      matchedAsset: { select: { id: true, hostname: true, ipAddress: true, assetType: true } },
    },
  });

  const interfaceCounts: Record<string, number> = {};
  let collectedAt: Date | null = null;
  for (const r of rows) {
    if (r.ifName) interfaceCounts[r.ifName] = (interfaceCounts[r.ifName] ?? 0) + 1;
    if (!collectedAt || r.lastSeen > collectedAt) collectedAt = r.lastSeen;
  }

  // How often this device's neighbour cache is actually refreshed. The tab
  // states it verbatim, because the poll interval is the whole reason a
  // short-lived entry can be missing and an operator has no other way to
  // know which cadence THIS device is on.
  const pollIntervalSec = await resolveCurrentStateIntervalSec(id, { discoveryFallback: true });

  return {
    entries: rows.map((r) => ({
      ipAddress:  r.ipAddress,
      macAddress: r.macAddress,
      // "" is the storage sentinel for "the device attributed this to no
      // interface" (see the model comment); it never leaves the API as "".
      ifName:     r.ifName === "" ? null : r.ifName,
      ageSec:     r.ageSec,
      firstSeen:  r.firstSeen,
      lastSeen:   r.lastSeen,
      matchedAsset: r.matchedAsset,
    })),
    interfaceCounts,
    collectedAt,
    total: rows.length,
    range,
    retentionDays,
    pollIntervalSec,
  };
}

/** GET /assets/:id/services — the host's service inventory. 404 when absent. */
export async function getAssetServices(id: string) {
  const asset = await prisma.asset.findUnique({
    where: { id },
    select: {
      monitoredServices: true, mappedServices: true,
      // Presence of a ManagedAgent row is what makes per-unit socket
      // attribution possible — see `unitAttribution` below.
      managedAgent: { select: { id: true } },
    },
  });
  if (!asset) throw new AppError(404, "Asset not found");
  const rows = await prisma.assetService.findMany({
    where: { assetId: id },
    orderBy: [{ unit: "asc" }],
  });
  return {
    services: rows.map((s) => ({
      unit:         s.unit,
      platform:     s.platform,
      displayName:  s.displayName,
      description:  s.description,
      loadState:    s.loadState,
      activeState:  s.activeState,
      subState:     s.subState,
      enabledState: s.enabledState,
      mainPid:      s.mainPid,
      mainProcess:  s.mainProcess,
      memBytes:     s.memBytes != null ? s.memBytes.toString() : null,
      cpuPct:       s.cpuPct,
      controllable: s.controllable,
    })),
    monitoredServices: (asset.monitoredServices ?? []) as string[],
    mappedServices:    (asset.mappedServices    ?? []) as string[],
    // Can a socket be attributed to a UNIT on this host? Only the Polaris
    // Agent resolves a PID's owning unit (cgroup on Linux, tasklist /svc on
    // Windows); the agentless SSH/WinRM processes cadence collects mapped
    // program names only and never stamps AssetProcessConnection.unit. Without
    // an agent, ticking Map on a service would silently collect nothing, so the
    // Services tab disables that checkbox and says why.
    unitAttribution: asset.managedAgent != null,
  };
}

/**
 * GET /assets/:id/arp-table — the FortiGate's layer-3 neighbour cache.
 *
 * Rows accumulate (upsert bumps lastSeen per read) and age out by retention,
 * so the range picks a window. Returns the entries plus per-interface counts
 * and the newest read's timestamp — the tab leads with that, because an ARP
 * cache is only meaningful next to its age.
 */
/**
 * The ARP Table tab's range selector. `current` is not a time window — it
 * means "whatever the last read found": the rows whose lastSeen is the
 * newest read's stamp (within ARP_CURRENT_TOLERANCE_MS), resolved here.
 */
const ARP_RANGE_SECONDS: Record<string, number | null> = {
  current: null,
  "1h":    60 * 60,
  "12h":   12 * 60 * 60,
  "24h":   24 * 60 * 60,
  "7d":    7 * 24 * 60 * 60,
  "30d":   30 * 24 * 60 * 60,
};

/**
 * Slack around the newest lastSeen when resolving `current`. A read is stamped
 * once (upsertArpNeighbors), but rows written before that stamped each
 * 1000-row chunk separately, milliseconds apart. Kept far below any poll
 * cadence so the PREVIOUS read never falls inside it.
 */
const ARP_CURRENT_TOLERANCE_MS = 5_000;

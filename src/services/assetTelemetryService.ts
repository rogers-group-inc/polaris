/**
 * src/services/assetTelemetryService.ts — The asset details telemetry family: the Custom MIB widgets, interface history
 * and the operator's interface comment (with Description Sync), the port tags'
 * manual read, the SD-WAN Performance SLA links and rules, path-check
 * traceroutes, MCLAG peers, virtualization, process / service logs and the
 * pinned-process log config (rule 107). Moved out of routes/assets/telemetry.ts
 * (CQ-B062 slice 2); the route keeps the gates, the query / body parsing and
 * the request-bound inputs (the actor, the caller's Agent Deploy grant).
 */

import { tryCompileSafeRegex } from "../utils/safeRegex.js";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logPathGlobProblem } from "../utils/logPathGlob.js";
import { logEvent } from "./eventLogService.js";
import { syncDescriptionsOnSave } from "./descriptionSyncService.js";
import { descriptionSyncEnabledForRole } from "../utils/descriptionSyncFlags.js";
import { resolveSdwanPollIntervalForAsset } from "./monitoringService.js";
import { pickSampleTierForAsset } from "./sampleQueryRouter.js";
import { extendSinceForLookback } from "../utils/chartRange.js";
import { readInterfaceHistory } from "./sampleHistoryService.js";
import { evaluateLogFlags } from "./logFlagRuleService.js";
import { readProbeOutages, serializeOutages } from "./probeOutageService.js";
import { isFortinetIntegrationType } from "../utils/pollingCompatibility.js";
import { isWorkloadPlatform } from "../utils/workloadSources.js";
import { buildInferredNeighborsForAsset, dedupeInferredNeighbors, aggregateMembershipMap } from "./peerInferredLldpService.js";

/** The PUT /assets/:id/processes/:name/config body after its Zod parse. */
export interface ProcessLogConfigInput {
  logSource?: "auto" | "journald-unit" | "file-glob";
  logPathGlob?: string | null;
  notes?: string | null;
}

/** GET /assets/:id/custom-widgets — the Custom MIB tab: the profile's widgets for this model with their latest samples. */
export async function getAssetCustomWidgets(id: string) {
  const asset = await prisma.asset.findUnique({
    where:  { id },
    select: {
      id: true, monitored: true, manufacturer: true, os: true, model: true, assetType: true,
      customWidgetPolling: true, lastCustomWidgetAt: true,
    },
  });
  if (!asset) throw new AppError(404, "Asset not found");

  // The governing profile — keyed by canonical manufacturer, else its "also
  // applies when" (business rule 131) — the same answer the collector and
  // the enable switch use.
  const { widgetProfileForAsset } = await import("./customWidgetEnablementService.js");
  const profile = widgetProfileForAsset(asset);

  // Apply per-model gating. Empty modelPattern = applies to every asset
  // under the manufacturer; non-empty regex must match Asset.model.
  const modelStr = asset.model ?? "";
  const profileWidgets = (profile?.widgets ?? []).filter((w) => {
    if (!w.modelPattern) return true;
    // RE2 (business rule 116); a pattern RE2 cannot compile matches nothing.
    return tryCompileSafeRegex(w.modelPattern, { ignoreCase: true })?.test(modelStr) ?? false;
  });
  // Widgets the asset's Generic API integrations define for it (rule
  // 100(i)) ride the same tab, after the manufacturer's, each carrying a
  // `source` so the card can say where its value comes from.
  const { genericApiWidgetDefsForAsset } = await import("./genericApiMonitorService.js");
  const genericWidgets = await genericApiWidgetDefsForAsset(id);
  const applicableWidgets: Array<(typeof profileWidgets)[number] | (typeof genericWidgets)[number]> = [...profileWidgets, ...genericWidgets];

  if (applicableWidgets.length === 0) {
    return {
      assetId:         asset.id,
      manufacturer:    asset.manufacturer,
      profileId:       profile?.id ?? null,
      polling:         asset.customWidgetPolling ?? null,
      lastCustomWidgetAt: asset.lastCustomWidgetAt,
      widgets:         [],
    };
  }

  // Bulk-fetch the last 60 samples per widget — line charts need a window;
  // gauges + tables grab the freshest. One query covering every applicable
  // widget id, then partition client-side.
  const ids = applicableWidgets.map((w) => w.id);
  const { enabledWidgetIdsForAsset } = await import("./customWidgetEnablementService.js");
  const enabledIds = await enabledWidgetIdsForAsset(id);
  const samples = await prisma.assetCustomWidgetSample.findMany({
    where: { assetId: id, widgetId: { in: ids } },
    orderBy: { timestamp: "desc" },
    take:    60 * ids.length,
    select:  { id: true, widgetId: true, timestamp: true, kind: true, value: true },
  });
  const byWidget = new Map<string, typeof samples>();
  for (const s of samples) {
    const arr = byWidget.get(s.widgetId) ?? [];
    if (arr.length < 60) arr.push(s);
    byWidget.set(s.widgetId, arr);
  }

  // State probes keep their 0/1 readings in asset_state_samples, one row per
  // probe row. The tab wants the CURRENT state of each row, so take the recent
  // rows newest-first and keep the first sighting of each (probeId, rowKey) —
  // one scrape writes a probe's whole row set at one timestamp, so the take cap
  // below covers several full snapshots even for a probe at the row cap.
  const stateProbeIds = applicableWidgets.filter((w) => w.widgetType === "state").map((w) => w.id);
  const latestState = new Map<string, Array<{ rowKey: string; rowLabel: string; value: number; rawValue: string | null; timestamp: Date }>>();
  if (stateProbeIds.length > 0) {
    const rows = await prisma.assetStateSample.findMany({
      where:   { assetId: id, probeId: { in: stateProbeIds } },
      orderBy: { timestamp: "desc" },
      take:    2000,
      select:  { probeId: true, rowKey: true, rowLabel: true, value: true, rawValue: true, timestamp: true },
    });
    const seen = new Set<string>();
    for (const r of rows) {
      const key = `${r.probeId}|${r.rowKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const arr = latestState.get(r.probeId) ?? [];
      arr.push({ rowKey: r.rowKey, rowLabel: r.rowLabel, value: r.value, rawValue: r.rawValue, timestamp: r.timestamp });
      latestState.set(r.probeId, arr);
    }
    // Problem rows first, then by name — an operator opening the tab is looking
    // for what's wrong, and a 60-row sensor table shouldn't need scanning.
    for (const [probeId, arr] of latestState) {
      const probe = applicableWidgets.find((w) => w.id === probeId);
      const trueIsProblem = probe?.stateMap?.trueIsProblem !== false;
      arr.sort((a, b) => {
        const pa = (a.value === 1) === trueIsProblem ? 0 : 1;
        const pb = (b.value === 1) === trueIsProblem ? 0 : 1;
        return pa - pb || a.rowLabel.localeCompare(b.rowLabel);
      });
    }
  }

  return {
    assetId:         asset.id,
    manufacturer:    asset.manufacturer,
    profileId:       profile?.id ?? null,
    widgetLayout:    profile?.widgetLayout ?? null,
    polling:         asset.customWidgetPolling ?? null,
    lastCustomWidgetAt: asset.lastCustomWidgetAt,
    widgets: applicableWidgets.map((w) => {
      const window = byWidget.get(w.id) ?? [];
      // Reverse so caller gets oldest-first for charts.
      window.reverse();
      return {
        id:             w.id,
        name:           w.name,
        symbol:         w.symbol,
        mibId:          w.mibId,
        type:           w.type,
        widgetType:     w.widgetType,
        transform:      w.transform,
        displayOptions: w.displayOptions,
        order:          w.order,
        modelPattern:   w.modelPattern,
        samples:        window,
        latest:         window.length ? window[window.length - 1] : null,
        // State probes only: the mapping (for labels/colour) + current rows.
        stateMap:       w.stateMap,
        labelSymbol:    w.labelSymbol,
        stateRows:      w.widgetType === "state" ? (latestState.get(w.id) ?? []) : undefined,
        source:         "source" in w ? w.source : { kind: "manufacturer" },
        // Business rule 130: a manufacturer widget polls this asset only when
        // switched on here. Generic API widgets carry no switch (null).
        enabled:        "source" in w ? null : enabledIds.has(w.id),
      };
    }),
  };
}

/** GET /assets/:id/interface-history — one interface's counters on the tier the window needs, with its comment override, neighbours and aggregate membership. */
export async function getInterfaceHistory(id: string, ifName: string, since: Date, until: Date, rangeLabel: string) {
  const pick = await pickSampleTierForAsset(id, "interfaces", since);
  const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
  // Full system-info pass timestamp → the complete interface snapshot for
  // the aggregate-membership map (the fast cadence only writes pinned rows).
  const assetMeta = await prisma.asset.findUnique({
    where: { id },
    select: {
      lastSystemInfoAt: true,
      // Description-sync context: whether the originating integration syncs
      // interface comments to the device (drives the editor's badge copy).
      fortinetTopology: true,
      discoveredByIntegration: { select: { type: true, config: true } },
    },
  });

  // Samples come from the tier-aware reader. LLDP neighbors and the
  // operator-typed comment override are stream-independent — both fetch
  // in parallel against the asset directly, not against the rollup
  // tables. The reader's meta carries the discovered alias/description
  // from the latest sample inside the requested window so the slide-over
  // header reflects what was configured during that window; the
  // operator-typed override (Polaris-local) takes precedence for the
  // resolved `description` field shown in the UI.
  const [history, override, allNeighbors, inferredAll, interfaceMeta, outages] = await Promise.all([
    readInterfaceHistory(id, since, until, pick.tier, ifName, fetchSince),
    prisma.assetInterfaceOverride.findUnique({
      where: { assetId_ifName: { assetId: id, ifName } },
    }),
    // All real LLDP neighbors for the asset. We display only the rows on the
    // requested interface (filtered below), but the full set is needed for
    // dedupe: a row learned on an aggregate's member port must suppress an
    // inferred row emitted on the aggregate itself (FortiLink). Returned with
    // the matched-asset cross-link so the slide-over can surface a "Go to
    // <hostname>" button. Usually a handful of rows at branch-class sizes.
    prisma.assetLldpNeighbor.findMany({
      where: { assetId: id },
      orderBy: [{ localIfName: "asc" }, { systemName: "asc" }],
      include: {
        matchedAsset: {
          select: { id: true, hostname: true, ipAddress: true, assetType: true },
        },
      },
    }),
    // Peer-inferred neighbors for the whole asset, filtered to this
    // interface below. Cheap enough at branch-class fleet sizes that
    // a per-interface query isn't worth the extra surface area on the
    // service.
    buildInferredNeighborsForAsset(id),
    // Interface metadata (ifType/ifParent) → aggregate membership map for the
    // inferred-on-aggregate dedupe. Current-state, so this is a plain indexed
    // read with no snapshot-timestamp gate. It is also strictly MORE correct
    // than the sample-table version: the fast pinned re-walk writes
    // ifType/ifParent as NULL, so on a pinned aggregate the newest sample row
    // carried nulls and the membership map silently lost that aggregate.
    prisma.assetInterface.findMany({
      where: { assetId: id },
      select: { ifName: true, ifType: true, ifParent: true },
    }),
    // Response-time failures over the same window — the interface counters
    // carry no success flag of their own and the cadence doesn't run while
    // the asset is down, so this is what tells the chart where to dive. See
    // the note on telemetry-history.
    readProbeOutages(id, since, until),
  ]);
  const neighbors = allNeighbors.filter((n) => n.localIfName === ifName);
  const inferredForIf = inferredAll.filter((n) => n.localIfName === ifName);
  const mergedNeighbors = [
    ...neighbors,
    ...dedupeInferredNeighbors(allNeighbors, inferredForIf, aggregateMembershipMap(interfaceMeta)),
  ];
  const overrideDescription = override?.description ?? null;
  // Interface comments sync to the device only when the originating
  // integration's toggle for this device class is on AND the asset is a
  // synced Fortinet role (FortiGate interface / FortiSwitch port — FortiAPs
  // have no per-interface description).
  const dsIntegration = assetMeta?.discoveredByIntegration ?? null;
  const dsRole = ((assetMeta?.fortinetTopology ?? {}) as { role?: string }).role;
  const descriptionSyncEnabled =
    (isFortinetIntegrationType(dsIntegration?.type)) &&
    (dsRole === "fortigate" || dsRole === "fortiswitch") &&
    descriptionSyncEnabledForRole(dsIntegration?.config, dsRole);
  return {
    range: rangeLabel,
    ifName,
    alias:       history.meta.alias,
    description: overrideDescription ?? history.meta.discoveredDescription,
    discoveredDescription: history.meta.discoveredDescription,
    overrideDescription,
    descriptionSync: {
      enabled: descriptionSyncEnabled,
      status: override?.syncStatus ?? null,
      lastSyncAt: override?.lastSyncAt ?? null,
      error: override?.syncError ?? null,
    },
    since,
    until,
    tier: pick.tier,
    bucketSeconds: pick.bucketSeconds,
    samples: history.samples,
    outages: serializeOutages(outages),
    lldpNeighbors: mergedNeighbors.map((n) => ({
      chassisIdSubtype:  n.chassisIdSubtype,
      chassisId:         n.chassisId,
      portIdSubtype:     n.portIdSubtype,
      portId:            n.portId,
      portDescription:   n.portDescription,
      systemName:        n.systemName,
      systemDescription: n.systemDescription,
      managementIp:      n.managementIp,
      capabilities:      n.capabilities,
      source:            n.source,
      firstSeen:         n.firstSeen,
      lastSeen:          n.lastSeen,
      matchedAsset:      n.matchedAsset
        ? {
            id:        n.matchedAsset.id,
            hostname:  n.matchedAsset.hostname,
            ipAddress: n.matchedAsset.ipAddress,
            assetType: n.matchedAsset.assetType,
          }
        : null,
    })),
  };
}

/** PUT /assets/:id/interfaces/:ifName/comment — set (or clear, when empty) the operator's interface description, log it, and sync it to the device when Description Sync is on. */
export async function setInterfaceComment(id: string, ifName: string, trimmed: string, actor: string | undefined) {
  const asset = await prisma.asset.findUnique({
    where: { id },
    select: { id: true, hostname: true, ipAddress: true },
  });
  if (!asset) throw new AppError(404, "Asset not found");

  if (trimmed.length === 0) {
    // Clear override — fall back to discovered description
    await prisma.assetInterfaceOverride.deleteMany({ where: { assetId: id, ifName } });
  } else {
    await prisma.assetInterfaceOverride.upsert({
      where: { assetId_ifName: { assetId: id, ifName } },
      create: { assetId: id, ifName, description: trimmed, updatedBy: actor },
      update: { description: trimmed, updatedBy: actor },
    });
  }

  logEvent({
    action: "asset.interface.comment_updated",
    resourceType: "asset",
    resourceId: id,
    resourceName: asset.hostname || asset.ipAddress || undefined,
    actor,
    level: "info",
    message: trimmed.length === 0
      ? `Cleared interface comment override on ${asset.hostname || asset.ipAddress || id} / ${ifName}`
      : `Updated interface comment override on ${asset.hostname || asset.ipAddress || id} / ${ifName}`,
    details: { ifName, length: trimmed.length },
  });

  // Description sync (Polaris-primary): mirror the saved comment to the
  // device when the originating integration opted in. No-op (attempted:
  // false) when the toggle is off / asset isn't a synced Fortinet role /
  // the override was cleared. Best-effort — the override row above is
  // already persisted either way; a failed push surfaces via `sync`.
  const sync = trimmed.length > 0
    ? await syncDescriptionsOnSave({ assetId: id, scope: "interface", ifName, actor })
    : { attempted: false as const };

  return { ok: true, ifName, description: trimmed.length === 0 ? null : trimmed, sync };
}

/** GET /assets/:id/perf-sla-links — every (health check, member) pair with a retained detail sample, newest thresholds per pair. */
export async function getPerfSlaLinks(id: string) {
  // Latest sample per (healthCheck, link) so the SLA thresholds reflect the
  // current health-check config. DISTINCT ON keeps the newest row per pair.
  const rows = await prisma.$queryRawUnsafe<Array<{
    healthCheck: string; link: string;
    latencyThresholdMs: number | null; jitterThresholdMs: number | null; packetLossThreshold: number | null;
  }>>(
    `SELECT DISTINCT ON ("healthCheck", "link")
            "healthCheck", "link",
            "latencyThresholdMs", "jitterThresholdMs", "packetLossThreshold"
     FROM "asset_perf_sla_samples"
     WHERE "assetId" = $1
     ORDER BY "healthCheck" ASC, "link" ASC, "timestamp" DESC`,
    id,
  );
  return { links: rows };
}

/** GET /assets/:id/path-check-traceroutes — a path check's recent traceroutes, newest first. */
export async function getPathCheckTraceroutes(id: string, checkId: string, limit: number) {
  const traceroutes = await prisma.assetPathCheckTraceroute.findMany({
    where: { assetId: id, checkId },
    orderBy: { timestamp: "desc" },
    take: limit,
  });
  return { checkId, traceroutes };
}

/** GET /assets/:id/sdwan-rules — the gate's SD-WAN rules with their member state. */
export async function getSdwanRules(id: string) {
  const rowsP = prisma.assetSdwanRule.findMany({
    where: { assetId: id },
    orderBy: [{ seq: "asc" }, { ruleName: "asc" }],
    select: {
      ruleName: true, ruleId: true, seq: true, enabled: true, mode: true,
      criteria: true, healthChecks: true, dst: true, status: true,
      selectedMember: true, availableMembers: true, priorityZones: true,
      updatedAt: true,
    },
  });
  const [rows, pollIntervalSec] = await Promise.all([
    rowsP,
    // The SD-WAN stream's own cadence, not the system-info one.
    resolveSdwanPollIntervalForAsset(id),
  ]);
  // One stamp for the whole table: persistSdwanRules delete-replaces every
  // rule in one transaction, so the newest updatedAt IS the scrape time.
  // Null on an empty table — never scraped and scraped-with-no-rules are
  // indistinguishable from the rows, and the tab says "never collected"
  // rather than inventing an age.
  let collectedAt: Date | null = null;
  for (const r of rows) {
    if (!collectedAt || r.updatedAt > collectedAt) collectedAt = r.updatedAt;
  }
  return { rules: rows, collectedAt, pollIntervalSec };
}

/** GET /assets/:id/mclag-peers — the switch's MCLAG peers. */
export async function getMclagPeers(id: string) {
  const rows = await prisma.assetMclagPeer.findMany({
    where: { assetId: id },
    orderBy: [{ localPort: "asc" }],
    select: {
      localPort: true, iclTrunk: true, peerSn: true, peerName: true, peerPort: true,
      matchedAsset: { select: { id: true, hostname: true } },
    },
  });
  return { peers: rows };
}

/** GET /assets/:id/virtualization — a VM's host and datastores, or a host's VMs / containers and datastores. 404 when absent. */
export async function getAssetVirtualization(id: string) {
  const asset = await prisma.asset.findUnique({
    where: { id },
    select: { id: true, virtualization: true },
  });
  if (!asset) throw new AppError(404, "Asset not found");
  const v = asset.virtualization as Record<string, any> | null;
  // Unraid / TrueNAS / Proxmox blobs (`platform` set) have their own shape: a
  // VM or container links to its host; the host lists the workloads placed on
  // it (VMs and containers alike) and carries its pools inline.
  if (v && isWorkloadPlatform(v.platform)) {
    if (v.role === "vm" || v.role === "container") {
      const hostAsset = typeof v.hostAssetId === "string" && v.hostAssetId
        ? await prisma.asset.findUnique({
            where: { id: v.hostAssetId },
            select: { id: true, hostname: true, monitorStatus: true, monitored: true },
          })
        : null;
      return { virtualization: v, hostAsset };
    }
    if (v.role === "host") {
      const children = await prisma.asset.findMany({
        where: { virtualization: { path: ["hostAssetId"], equals: id }, status: { not: "decommissioned" } },
        select: { id: true, hostname: true, assetType: true, monitorStatus: true, monitored: true, virtualization: true },
        orderBy: { hostname: "asc" },
        take: 1000,
      });
      return {
        virtualization: v,
        workloads: children.map((c) => {
          const cv = (c.virtualization as Record<string, any> | null) ?? {};
          return {
            id: c.id,
            hostname: c.hostname,
            role: cv.role ?? null,
            state: cv.state ?? null,
            image: cv.image ?? null,
            networkMode: cv.networkMode ?? null,
            updateAvailable: cv.updateAvailable ?? null,
            monitorStatus: c.monitorStatus,
            monitored: c.monitored,
          };
        }),
      };
    }
  }
  if (!v || (v.role !== "vm" && v.role !== "host")) {
    return { virtualization: null };
  }
  const integrationId = typeof v.vcenterIntegrationId === "string" ? v.vcenterIntegrationId : null;
  const bigintToString = (x: bigint | null): string | null => (x === null ? null : x.toString());

  if (v.role === "vm") {
    // Running host link (hostAssetId is re-resolved every discovery cycle).
    const hostAsset = typeof v.hostAssetId === "string" && v.hostAssetId
      ? await prisma.asset.findUnique({
          where: { id: v.hostAssetId },
          select: { id: true, hostname: true, monitorStatus: true, monitored: true },
        })
      : null;
    // Datastore names + backing labels for the disks table.
    const dsMorefs = [...new Set(
      (Array.isArray(v.disks) ? v.disks : [])
        .map((d: any) => (typeof d?.datastoreMoref === "string" ? d.datastoreMoref : null))
        .filter((m: string | null): m is string => !!m),
    )];
    const datastores = integrationId && dsMorefs.length > 0
      ? await prisma.vcenterDatastore.findMany({
          where: { integrationId, moref: { in: dsMorefs } },
          select: { moref: true, name: true, dsType: true, backingLabel: true },
        })
      : [];
    return {
      virtualization: v,
      hostAsset,
      diskDatastores: datastores,
    };
  }

  // role === "host"
  const hostMoref = typeof v.hostMoref === "string" ? v.hostMoref : null;
  const datastores = integrationId && hostMoref
    ? await prisma.vcenterDatastore.findMany({
        where: { integrationId, hostMorefs: { has: hostMoref } },
        orderBy: { name: "asc" },
      })
    : [];
  // VMs currently placed on this host — their virtualization blobs carry
  // hostAssetId (re-stamped every cycle), which indexes cheaper than a
  // JSON-path filter on hostMoref.
  const vms = await prisma.asset.findMany({
    where: {
      virtualization: { path: ["hostAssetId"], equals: id },
    },
    select: { id: true, hostname: true, monitorStatus: true, monitored: true, virtualization: true },
    take: 500,
  });
  return {
    virtualization: v,
    datastores: datastores.map((d) => ({
      moref: d.moref,
      name: d.name,
      dsType: d.dsType,
      capacityBytes: bigintToString(d.capacityBytes),
      freeBytes: bigintToString(d.freeBytes),
      provisionedBytes: bigintToString(d.provisionedBytes),
      accessible: d.accessible,
      backingLabel: d.backingLabel,
      backing: d.backing,
    })),
    vms: vms.map((vm) => ({
      id: vm.id,
      hostname: vm.hostname,
      monitorStatus: vm.monitorStatus,
      monitored: vm.monitored,
      powerState: (vm.virtualization as Record<string, any> | null)?.powerState ?? null,
    })),
  };
}

/** GET /assets/:id/process-logs — a pinned process's log lines (optionally flagged only / since a time). */
export async function getProcessLogs(id: string, name: string, limit: number, since: Date | null, onlyFlagged: boolean) {
  const rows = await prisma.assetProcessLogSample.findMany({
    where: { assetId: id, name, ...(since && !isNaN(since.getTime()) ? { timestamp: { gte: since } } : {}) },
    orderBy: { timestamp: "desc" },
    take: limit,
  });
  // Annotate each line with the operator-defined flag rules it matches
  // (read-time eval — see logFlagRuleService). ?flagged=1 returns only matches.
  const logs = await evaluateLogFlags(
    id,
    name,
    rows.map((r) => ({ timestamp: r.timestamp, level: r.level, message: r.message, source: r.source })),
    onlyFlagged,
  );
  return { name, logs };
}

/** GET /assets/:id/service-logs — a service unit's log lines (optionally flagged only / since a time). */
export async function getServiceLogs(id: string, unit: string, limit: number, since: Date | null, onlyFlagged: boolean) {
  const rows = await prisma.assetServiceLogSample.findMany({
    where: { assetId: id, unit, ...(since && !isNaN(since.getTime()) ? { timestamp: { gte: since } } : {}) },
    orderBy: { timestamp: "desc" },
    take: limit,
  });
  const logs = await evaluateLogFlags(
    id,
    unit,
    rows.map((r) => ({ timestamp: r.timestamp, level: r.level, message: r.message, source: r.source })),
    onlyFlagged,
  );
  return { unit, logs };
}

/**
 * PUT /assets/:id/processes/:name/config — a pinned process's log source / glob / notes. A
 * CHANGED glob is shape-checked and needs Agent Deploy (the agent reads it as a privileged
 * user, rule 107); resaving the current one does not.
 */
export async function setProcessLogConfig(id: string, name: string, body: ProcessLogConfigInput, canDeployAgents: boolean, actor: string | undefined) {
  const newGlob = body.logPathGlob ?? null;
  if (newGlob !== null) {
    const existing = await prisma.assetProcessConfig.findUnique({
      where: { assetId_name: { assetId: id, name } },
      select: { logPathGlob: true },
    });
    // Only a CHANGE is judged: resaving the log source with the glob as it
    // already stands must keep working (a legacy value is withheld from
    // agents anyway — see GET /agents/config).
    if ((existing?.logPathGlob ?? null) !== newGlob) {
      const problem = logPathGlobProblem(newGlob);
      if (problem) throw new AppError(400, problem);
      if (!canDeployAgents) {
        throw new AppError(
          403,
          "Setting a log path needs Agent Deploy: the agent reads that path as a privileged user.",
        );
      }
    }
  }

  const updated = await prisma.assetProcessConfig.upsert({
    where:  { assetId_name: { assetId: id, name } },
    update: { logSource: body.logSource, logPathGlob: body.logPathGlob ?? null, notes: body.notes ?? null, updatedBy: actor ?? null },
    create: { assetId: id, name, logSource: body.logSource ?? "auto", logPathGlob: body.logPathGlob ?? null, notes: body.notes ?? null, updatedBy: actor ?? null },
  });
  logEvent({
    action: "asset.process.log_config_set",
    resourceType: "asset",
    resourceId: id,
    actor: actor,
    message: `Log config set for process "${name}"`,
    details: { name, logSource: updated.logSource, logPathGlob: updated.logPathGlob },
  });
  return { config: { name: updated.name, logSource: updated.logSource, logPathGlob: updated.logPathGlob, detectedUnit: updated.detectedUnit, notes: updated.notes } };
}

/** The operator's own (source "manual") tags on one port — what a tag save is judged against. */
export async function listManualInterfaceTags(id: string, ifName: string) {
  return prisma.assetInterfaceTag.findMany({ where: { assetId: id, ifName, source: "manual" }, select: { tag: true } });
}

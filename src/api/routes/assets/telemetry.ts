/**
 * src/api/routes/assets/telemetry.ts — Per-asset telemetry reads behind the slide-over tabs: custom widgets, interface
 * history and interface comments / tags, hardware, IPsec, SD-WAN and Perf SLA, path
 * checks, MCLAG, upstream, VIPs, virtualization, storage and process history, process /
 * service logs, process config. Split out of routes/assets.ts (CQ-B062) and mounted
 * there in order.
 */

import { Router } from "express";
import { intQuery, boolQuery } from "../../../utils/queryParams.js";
import { tryCompileSafeRegex } from "../../../utils/safeRegex.js";
import { z } from "zod";
import { prisma } from "../../../db.js";
import { AppError } from "../../../utils/errors.js";
import { requirePermission, hasPermission, assertTagChangeAllowed } from "../../middleware/permissions.js";
import { scopeAssetParam } from "../../middleware/writeScope.js";
import { logPathGlobProblem } from "../../../utils/logPathGlob.js";
import { requestActor } from "../../middleware/auth.js";
import { logEvent } from "../events.js";
import { readAssetIpsec } from "../../../services/ipsecConnectionService.js";
import { syncDescriptionsOnSave } from "../../../services/descriptionSyncService.js";
import { descriptionSyncEnabledForRole } from "../../../utils/descriptionSyncFlags.js";
import { resolveSdwanPollIntervalForAsset } from "../../../services/monitoringService.js";
import { resolveAssetUpstream } from "../../../services/assetUpstreamService.js";
import { resolveAssetVips } from "../../../services/assetVipService.js";
import { setInterfaceTags } from "../../../services/interfaceTagService.js";
import { pickSampleTierForAsset } from "../../../services/sampleQueryRouter.js";
import { resolveRange, extendSinceForLookback } from "../../../utils/chartRange.js";
import { readHardwareSensorHistory, readInterfaceHistory, readStorageHistory, readProcessHistory } from "../../../services/sampleHistoryService.js";
import { evaluateLogFlags } from "../../../services/logFlagRuleService.js";
import { getMetricSeverityTierResolver } from "../../../services/notificationRuleService.js";
import { getAssetChecks as getAssetPathChecks } from "../../../services/pathCheckService.js";
import { readIpsecHistory, readPerfSlaHistory, readPathCheckHistory, readSdwanMembers } from "../../../services/sampleHistoryService.js";
import { readProbeOutages, serializeOutages } from "../../../services/probeOutageService.js";
import { isFortinetIntegrationType } from "../../../utils/pollingCompatibility.js";
import { isWorkloadPlatform } from "../../../utils/workloadSources.js";
import { buildInferredNeighborsForAsset, dedupeInferredNeighbors, aggregateMembershipMap } from "../../../services/peerInferredLldpService.js";
import { resolveCurrentStateIntervalSec } from "../../../services/monitoring/monitorSettings.js";

const router = Router();

// PUT /assets/:id/primary-address — one (MAC, IP) pair from the asset's
// address list (business rule 102).
// PUT /assets/:id/custom-widgets/:widgetId/enabled (business rule 130).
const CustomWidgetEnabledSchema = z.object({ enabled: z.boolean() });

// Per-pinned-process log config (PUT /assets/:id/processes/:name/config).
const ProcessConfigSchema = z.object({
  logSource:   z.enum(["auto", "journald-unit", "file-glob"]).optional(),
  logPathGlob: z.string().max(1024).nullable().optional(),
  notes:       z.string().max(255).nullable().optional(),
});

// GET /assets/:id/custom-widgets — Custom MIB tab data (Slice 7). Resolves
// the asset's manufacturer profile, filters widgets by optional modelPattern,
// and returns each widget's definition plus its latest sample (kind = "scalar"
// returns the most recent point; kind = "line" / "table" returns a window of
// recent samples that the gauge / chart / table renderer consumes directly).
// Empty array when the manufacturer has no widgets or the polling stream is
// resolved to "disabled" — the frontend hides the tab in that case.
router.get("/:id/custom-widgets", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
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
    const { widgetProfileForAsset } = await import("../../../services/customWidgetEnablementService.js");
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
    const { genericApiWidgetDefsForAsset } = await import("../../../services/genericApiMonitorService.js");
    const genericWidgets = await genericApiWidgetDefsForAsset(id);
    const applicableWidgets: Array<(typeof profileWidgets)[number] | (typeof genericWidgets)[number]> = [...profileWidgets, ...genericWidgets];

    if (applicableWidgets.length === 0) {
      return res.json({
        assetId:         asset.id,
        manufacturer:    asset.manufacturer,
        profileId:       profile?.id ?? null,
        polling:         asset.customWidgetPolling ?? null,
        lastCustomWidgetAt: asset.lastCustomWidgetAt,
        widgets:         [],
      });
    }

    // Bulk-fetch the last 60 samples per widget — line charts need a window;
    // gauges + tables grab the freshest. One query covering every applicable
    // widget id, then partition client-side.
    const ids = applicableWidgets.map((w) => w.id);
    const { enabledWidgetIdsForAsset } = await import("../../../services/customWidgetEnablementService.js");
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

    return res.json({
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
    });
  } catch (err) { next(err); }
});

// PUT /assets/:id/custom-widgets/:widgetId/enabled — the per-card switch on the
// Custom MIB tab (business rule 130). Writes an asset.custom_widget.* Event.
router.put("/:id/custom-widgets/:widgetId/enabled", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    const parsed = CustomWidgetEnabledSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, parsed.error.issues.map((e) => e.message).join("; "));
    const { setWidgetEnabledForAsset } = await import("../../../services/customWidgetEnablementService.js");
    await setWidgetEnabledForAsset(
      req.params.id as string,
      req.params.widgetId as string,
      parsed.data.enabled,
      (req as any).session?.username,
    );
    res.json({ enabled: parsed.data.enabled });
  } catch (err) { next(err); }
});

// GET /assets/:id/interface-history?ifName=...&range=... — per-interface counters
router.get("/:id/interface-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const ifName = req.query.ifName ? String(req.query.ifName) : null;
    if (!ifName) throw new AppError(400, "ifName query parameter is required");
    const { since, until, rangeLabel } = resolveRange(req);
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
    res.json({
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
    });
  } catch (err) { next(err); }
});

// PUT /assets/:id/interfaces/:ifName/comment — operator-typed override for the
// interface's "Interface Comments" text box. Polaris-local by default; when
// the originating integration's FortiGate / FortiSwitch description-sync toggle is on, a saved
// comment is also pushed to the device (Polaris-primary — see
// descriptionSyncService). Empty string or null clears the override locally
// only (the device keeps its description; the discovered FortiOS CMDB
// description shows through again).
const InterfaceCommentSchema = z.object({
  description: z.string().max(255, "Interface Comments may be at most 255 characters").nullable().optional(),
});

router.put("/:id/interfaces/:ifName/comment", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const ifName = String(req.params.ifName || "");
    if (!ifName) throw new AppError(400, "ifName path parameter is required");

    const parsed = InterfaceCommentSchema.parse(req.body || {});
    const raw = parsed.description == null ? "" : String(parsed.description);
    const trimmed = raw.trim();
    const actor = requestActor(req);

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

    res.json({ ok: true, ifName, description: trimmed.length === 0 ? null : trimmed, sync });
  } catch (err) { next(err); }
});

// PUT /assets/:id/interfaces/:ifName/tags — replace the HAND-APPLIED tags on
// one interface (business rule 133). Tags a tag's auto-assign filter put on the
// port are left alone (and come back in the response flagged `auto`); naming
// one here converts it to a hand-applied tag. Same gate as the comment above.
const InterfaceTagsSchema = z.object({
  tags: z.array(z.string().max(200)).max(200),
});

router.put("/:id/interfaces/:ifName/tags", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const ifName = String(req.params.ifName || "");
    if (!ifName) throw new AppError(400, "ifName path parameter is required");
    const { tags } = InterfaceTagsSchema.parse(req.body || {});
    // A port's tags are tags: the same administrator's grant as a device's,
    // judged on the change against what the port carries today.
    // Manual rows only: the auto / network rows are the engines' and the form
    // never posts them, so counting them would make every save look like a change.
    const current = await prisma.assetInterfaceTag.findMany({ where: { assetId: id, ifName, source: "manual" }, select: { tag: true } });
    assertTagChangeAllowed(req, current.map((t) => t.tag), tags);
    const result = await setInterfaceTags(id, ifName, tags, requestActor(req));
    res.json({ ok: true, ifName, tags: result });
  } catch (err) { next(err); }
});

// GET /assets/:id/hardware-history?range=... [&sensorName=...] — per-sensor hardware readings
router.get("/:id/hardware-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const sensorName = req.query.sensorName ? String(req.query.sensorName) : null;
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "hardware", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    const result = await readHardwareSensorHistory(id, since, until, pick.tier, sensorName, fetchSince);
    res.json({
      range: rangeLabel,
      sensorName,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
      stats: result.stats,
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/ipsec-history?tunnelName=...&range=... — per-tunnel state + bytes
router.get("/:id/ipsec-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const tunnelName = req.query.tunnelName ? String(req.query.tunnelName) : null;
    if (!tunnelName) throw new AppError(400, "tunnelName query parameter is required");
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "ipsec", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    const result = await readIpsecHistory(id, since, until, pick.tier, tunnelName, fetchSince);
    res.json({
      range: rangeLabel,
      tunnelName,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/perf-sla-links — distinct (healthCheck, link) pairs seen in
// the perf-SLA detail window. Doubles as the "does SD-WAN data exist?" gate for
// the asset modal's SD-WAN tab and the source for its health-check/link selector.
router.get("/:id/perf-sla-links", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
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
    res.json({ links: rows });
  } catch (err) { next(err); }
});

// GET /assets/:id/sdwan-members — per-WAN-member health summary (status, per
// health-check latency/jitter/loss, recent status strip, + IP/link/bytes from
// the latest interface sample). Drives the "SD-WAN Members" table.
//
// Carries the same freshness pair the ARP/MAC tabs do — `collectedAt` (the
// newest perf-SLA sample, i.e. the scrape stamp) and `pollIntervalSec` — so the
// table can state its own age and turn amber past its own cadence. The cadence
// is the SD-WAN stream's own (integration sdwanIntervalSeconds, default 60s) —
// not the system-info one it rode until 2026-09. Only that cadence writes
// perf-SLA samples, so an unpolled gate reports null rather than borrowing its
// integration's 12h discovery sweep.
router.get("/:id/sdwan-members", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    // The strip shades an in-SLA scrape by the severity tier an SD-WAN
    // automation would fire at on it — the same lookup the asset charts shade
    // with, loaded once for every (metric, health check, member) the table asks.
    const tierFor = await getMetricSeverityTierResolver(id);
    const [result, pollIntervalSec] = await Promise.all([
      readSdwanMembers(id, (metric, healthCheck, link) => tierFor(metric, { healthCheck, link })),
      resolveSdwanPollIntervalForAsset(id),
    ]);
    res.json({ ...result, pollIntervalSec });
  } catch (err) { next(err); }
});

// GET /assets/:id/perf-sla-history?healthCheck=...&link=...&range=... — per-member
// latency/jitter/packet-loss gauges over time.
router.get("/:id/perf-sla-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const healthCheck = req.query.healthCheck ? String(req.query.healthCheck) : null;
    const link = req.query.link ? String(req.query.link) : null;
    if (!healthCheck) throw new AppError(400, "healthCheck query parameter is required");
    if (!link) throw new AppError(400, "link query parameter is required");
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "perfSla", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    const result = await readPerfSlaHistory(id, since, until, pick.tier, healthCheck, link, fetchSince);
    res.json({
      range: rangeLabel,
      healthCheck,
      link,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/path-checks — the agent-run path checks this
// host runs, each with its latest result (from path_check_sources, never
// the hypertable). Drives the slide-over's Paths tab AND its visibility:
// an empty list means no tab. assets:read — the results describe this asset.
router.get("/:id/path-checks", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    res.json(await getAssetPathChecks(req.params.id as string));
  } catch (err) { next(err); }
});

// GET /assets/:id/path-check-history?checkId=...&range=... — one check's
// latency / phases / verdict series from this host, tier-picked like every
// other history endpoint.
router.get("/:id/path-check-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const checkId = req.query.checkId ? String(req.query.checkId) : null;
    if (!checkId) throw new AppError(400, "checkId query parameter is required");
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "pathCheck", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    const result = await readPathCheckHistory(id, since, until, pick.tier, checkId, fetchSince);
    res.json({
      range: rangeLabel,
      checkId,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/path-check-traceroutes?checkId=...&limit=10 — the newest
// traceroutes this host ran for one check, hops already resolved to assets and
// subnets at write time. Newest first; limit ≤ 50.
router.get("/:id/path-check-traceroutes", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const checkId = req.query.checkId ? String(req.query.checkId) : null;
    if (!checkId) throw new AppError(400, "checkId query parameter is required");
    const limit = intQuery(req.query.limit, { fallback: 10, min: 1, max: 50 })!;
    const traceroutes = await prisma.assetPathCheckTraceroute.findMany({
      where: { assetId: id, checkId },
      orderBy: { timestamp: "desc" },
      take: limit,
    });
    res.json({ checkId, traceroutes });
  } catch (err) { next(err); }
});

// GET /assets/:id/sdwan-rules — current-state SD-WAN service rules (one row per
// rule, replaced per scrape by persistSdwanRules). The SD-WAN tab table + the
// "data exists?" gate. Ordered by the rule's FortiOS sequence (priority) so the
// table matches the device GUI ordering. No history — SD-WAN rules are
// current-state (only the SLA-metrics stream is a time-series).
router.get("/:id/sdwan-rules", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
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
    res.json({ rules: rows, collectedAt, pollIntervalSec });
  } catch (err) { next(err); }
});

// GET /assets/:id/ipsec — the IPsec tab: the gate's phase-1 tunnels (last
// full pass) and who is connected through them — ADVPN spokes on a hub,
// ADVPN shortcuts on a spoke, dial-up peers, FortiClient users on IPsec and
// SSL-VPN — each matched to an asset by address where one is known. Carries
// the ARP tab's freshness pair (`collectedAt` + the system-info cadence that
// rewrites it). Current-state only: a peer that connected and left between
// two passes was never seen.
router.get("/:id/ipsec", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const [result, pollIntervalSec] = await Promise.all([
      readAssetIpsec(id),
      resolveCurrentStateIntervalSec(id, { discoveryFallback: false }),
    ]);
    res.json({ ...result, pollIntervalSec });
  } catch (err) { next(err); }
});

// GET /assets/:id/mclag-peers — current-state MCLAG ICL peers (one row per
// local ICL port, replaced per scrape by persistMclagPeers). FortiSwitch only;
// empty for switches not in an MCLAG pair. `matchedAsset` resolves the peer
// switch (by serial) for a clickable link in the asset detail / topology.
router.get("/:id/mclag-peers", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const rows = await prisma.assetMclagPeer.findMany({
      where: { assetId: id },
      orderBy: [{ localPort: "asc" }],
      select: {
        localPort: true, iclTrunk: true, peerSn: true, peerName: true, peerPort: true,
        matchedAsset: { select: { id: true, hostname: true } },
      },
    });
    res.json({ peers: rows });
  } catch (err) { next(err); }
});

// GET /assets/:id/upstream — the three upstream devices the General tab names
// (Last Seen Switch / AP / Firewall) resolved from display strings to the Asset
// rows behind them, so those rows can carry verbs (open the device, open its
// HTTPS UI, SSH to it) instead of being text an operator re-finds by hand.
//
// Resolution rides utils/fortinetParentKey.ts — never a hostname match (see
// assetUpstreamService). An unresolved name comes back with `asset: null` and
// is NOT an error: an unadopted switch and a gate another integration hasn't
// discovered yet both land there legitimately.
//
// The firewall half reads AssetFortigateSighting, which its own endpoint gates
// `assetsQuarantine:read` — so it is gated a second time here and the answer
// says which halves were consulted (`visibility`), the /ip-context precedent.
// Its IPAM fallback (no gate ever sighted the device → the gate that owns the
// network its address is in) reads Subnet instead, so it rides `subnets:read`
// and reports separately: a caller with one grant and not the other must be
// able to tell an empty answer from an unshown one.
router.get("/:id/upstream", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const result = await resolveAssetUpstream(id, {
      includeFirewall: hasPermission(req, "assetsQuarantine", "read"),
      includeSubnetGate: hasPermission(req, "subnets", "read"),
    });
    if (!result) throw new AppError(404, "Asset not found");
    res.json(result);
  } catch (err) { next(err); }
});

// GET /assets/:id/vips — the firewall VIPs / virtual servers that publish this
// device, for the General tab's VIP rows: the external address, and the gate
// the VIP is configured on (resolved to an Asset when Polaris holds one).
//
// The facts live on the Reservations discovery stamps for every address a VIP
// touches (`Reservation.vipInfo`, discoveryEngine Phase 3c), so reading this
// exposes IPAM content — chained gate, the `/assets/:id/contacts` precedent.
// Nothing in the UI renders a "no VIP" row, so there is no "not shown" vs
// "none found" ambiguity for a `visibility` flag to resolve.
router.get(
  "/:id/vips",
  requirePermission("assets", "read"),
  requirePermission("reservations", "read"),
  async (req, res, next) => {
    try {
      const result = await resolveAssetVips(req.params.id as string);
      if (!result) throw new AppError(404, "Asset not found");
      res.json(result);
    } catch (err) { next(err); }
  },
);

// GET /assets/:id/virtualization — current-state vCenter facts for the
// asset-details Virtualization section. Assembled per role from the
// Asset.virtualization blob (single writer: syncVcenterDevices):
//   - VM:   the blob + the running host's asset link (clickable) + cluster
//           sibling hosts + per-disk datastore/backing labels.
//   - Host: the blob + mounted datastores (from the current-state
//           VcenterDatastore table) + the VMs currently placed on it.
// 404s stay reserved for a missing asset; an asset with no virtualization
// data returns { virtualization: null } so the UI can skip the section.
router.get("/:id/virtualization", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
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
        res.json({ virtualization: v, hostAsset });
        return;
      }
      if (v.role === "host") {
        const children = await prisma.asset.findMany({
          where: { virtualization: { path: ["hostAssetId"], equals: id }, status: { not: "decommissioned" } },
          select: { id: true, hostname: true, assetType: true, monitorStatus: true, monitored: true, virtualization: true },
          orderBy: { hostname: "asc" },
          take: 1000,
        });
        res.json({
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
        });
        return;
      }
    }
    if (!v || (v.role !== "vm" && v.role !== "host")) {
      res.json({ virtualization: null });
      return;
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
      res.json({
        virtualization: v,
        hostAsset,
        diskDatastores: datastores,
      });
      return;
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
    res.json({
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
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/storage-history?mountPath=...&range=... — per-mountpoint usage
router.get("/:id/storage-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const mountPath = req.query.mountPath ? String(req.query.mountPath) : null;
    if (!mountPath) throw new AppError(400, "mountPath query parameter is required");
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "storage", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    // See the note on telemetry-history: the storage cadence is skipped while
    // the asset is down, so the probe stream is what knows an outage happened.
    // This is also what lets storage be treated like every other stream — a
    // mount that is simply unmounted on a HEALTHY device sits inside no outage
    // window and draws no dive, which is the distinction the old gap heuristic
    // could not make.
    const [result, outages] = await Promise.all([
      readStorageHistory(id, since, until, pick.tier, mountPath, fetchSince),
      readProbeOutages(id, since, until),
    ]);
    res.json({
      range: rangeLabel,
      mountPath,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
      outages: serializeOutages(outages),
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/process-history?name=...&range=... — per-pinned-program
// CPU/RAM history, tier-routed (detail → hourly → daily) by the requested range.
router.get("/:id/process-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const name = req.query.name ? String(req.query.name) : null;
    if (!name) throw new AppError(400, "name query parameter is required");
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "process", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    const result = await readProcessHistory(id, since, until, pick.tier, name, fetchSince);
    res.json({
      range: rangeLabel,
      name,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/process-logs?name=...&since=...&limit=... — recent log lines
// for a pinned program (detail-only table, newest-first, capped).
router.get("/:id/process-logs", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const name = req.query.name ? String(req.query.name) : null;
    if (!name) throw new AppError(400, "name query parameter is required");
    const limit = intQuery(req.query.limit, { fallback: 500, min: 1, max: 2000 })!;
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    const onlyFlagged = boolQuery(req.query.flagged);
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
    res.json({ name, logs });
  } catch (err) { next(err); }
});

// GET /assets/:id/service-logs?unit=...&since=...&limit=...&flagged=1 — recent
// journalctl lines for a pinned unit (standalone table, newest-first, capped).
// Global/asset-scoped LogFlagRules apply (the unit is passed as the eval's
// process key, so a process-scoped rule named after the unit also matches).
router.get("/:id/service-logs", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const unit = req.query.unit ? String(req.query.unit) : null;
    if (!unit) throw new AppError(400, "unit query parameter is required");
    const limit = intQuery(req.query.limit, { fallback: 500, min: 1, max: 2000 })!;
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    const onlyFlagged = boolQuery(req.query.flagged);
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
    res.json({ unit, logs });
  } catch (err) { next(err); }
});

// PUT /assets/:id/processes/:name/config — operator log-path config for a
// pinned program (log source + wildcard glob). Upserts AssetProcessConfig.
router.put("/:id/processes/:name/config", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const name = String(req.params.name);
    const body = ProcessConfigSchema.parse(req.body);

    // The glob is "read this file on the agent's host" (the agent runs as
    // LocalSystem / root), so it is checked twice. SHAPE: an absolute local
    // path, never a UNC / device path or a `..` walk. AUTHORITY: setting or
    // changing one needs assets=fullwrite — the grant that already means "may
    // deploy and drive agents" (rule 43) — while an `assets:write` caller can
    // still edit the log source and notes, or clear the glob. Rule 107.
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
        if (!hasPermission(req, "agentDeploy", "write")) {
          throw new AppError(
            403,
            "Setting a log path needs Agent Deploy: the agent reads that path as a privileged user.",
          );
        }
      }
    }

    const updated = await prisma.assetProcessConfig.upsert({
      where:  { assetId_name: { assetId: id, name } },
      update: { logSource: body.logSource, logPathGlob: body.logPathGlob ?? null, notes: body.notes ?? null, updatedBy: requestActor(req) ?? null },
      create: { assetId: id, name, logSource: body.logSource ?? "auto", logPathGlob: body.logPathGlob ?? null, notes: body.notes ?? null, updatedBy: requestActor(req) ?? null },
    });
    logEvent({
      action: "asset.process.log_config_set",
      resourceType: "asset",
      resourceId: id,
      actor: requestActor(req),
      message: `Log config set for process "${name}"`,
      details: { name, logSource: updated.logSource, logPathGlob: updated.logPathGlob },
    });
    res.json({ config: { name: updated.name, logSource: updated.logSource, logPathGlob: updated.logPathGlob, detectedUnit: updated.detectedUnit, notes: updated.notes } });
  } catch (err) { next(err); }
});

export default router;

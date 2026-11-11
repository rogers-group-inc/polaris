/**
 * src/api/routes/assets/detail.ts — One asset: GET /:id, its effective monitor settings, IP history, alerts, metric
 * thresholds, monitor history, and the on-demand verbs (probe now, refresh system
 * info, rediscover, SNMP walk). Split out of routes/assets.ts (CQ-B062) and mounted
 * there in order — after the collection routes, so a literal path such as
 * /ip-check is never read as an :id.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../../db.js";
import { AppError } from "../../../utils/errors.js";
import { assetDialAddress } from "../../../utils/assetDialAddress.js";
import { ipv6Dialable } from "../../../services/ipv6GateService.js";
import { requirePermission, hasPermission, credentialUseActor } from "../../middleware/permissions.js";
import { resolveWriteScope, inWriteScope } from "../../../services/writeScopeService.js";
import { scopeAssetParam } from "../../middleware/writeScope.js";
import { maskActionHeaders } from "../../../utils/actionHeaderMask.js";
import { recordCredentialUse } from "../../../services/credentialUseAuditService.js";
import { requestActor } from "../../middleware/auth.js";
import { logEvent } from "../events.js";
import { assetMatchesIntegrationFilter } from "../../../utils/integrationFilter.js";
import { getIpHistory } from "../../../services/assetIpHistoryService.js";
import { descriptionSyncEnabledForRole } from "../../../utils/descriptionSyncFlags.js";
import { buildIpContexts, networksForAddresses } from "../../../services/subnetService.js";
import { getDiscoveredHostname } from "../../../services/discoveredHostnameService.js";
import { shapeMacRows, MAC_ROW_SELECT } from "../../../utils/macAddresses.js";
import { probeAsset, recordProbeResult, collectTelemetry, recordTelemetryResult, collectHardwareSensors, recordHardwareSensorResult, collectSystemInfo, recordSystemInfoResult, runSdwanFor, snmpWalkRaw, resolveMonitorSettings } from "../../../services/monitoringService.js";
import { getEffectiveMonitorSettings } from "../../../services/assetDetailReadService.js";
import { describeDownDetectionFor, recoveryPollsFor } from "../../../services/downDetectionService.js";
import { getCredential } from "../../../services/credentialService.js";
import { pickSampleTierForAsset } from "../../../services/sampleQueryRouter.js";
import { extendSinceForLookback } from "../../../utils/chartRange.js";
import { readMonitorHistory, readLastMonitorSuccessAt } from "../../../services/sampleHistoryService.js";
import { getAssetNotifications } from "../../../services/notificationService.js";
import { getMetricSeverityTiers } from "../../../services/notificationRuleService.js";
import { isFortinetIntegrationType } from "../../../utils/pollingCompatibility.js";
import { isWorkloadPlatform, workloadSourceKindsFor } from "../../../utils/workloadSources.js";
import { logger } from "../../../utils/logger.js";
import { triggerDiscovery } from "../../../services/discovery/discoveryEngine.js";
import { resolveDiscoveryScopeForAsset } from "../../../services/discovery/assetDiscoveryScope.js";
import { isRunActive } from "../../../services/discoveryRunState.js";
import { reconcileAddressesWithIpam } from "../../../services/assetAddressService.js";
import { buildAddressConfidence, confidenceToJson } from "../../../services/addressConfidenceService.js";
import { assertCredentialInAssetScope } from "../../../services/assetCredentialScopeService.js";
import { shapeAssociatedIps, ASSOCIATED_IP_SELECT } from "../../../services/assetAddressService.js";

const router = Router();

router.get("/:id", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    // Opening the details re-checks the asset's DHCP addresses against IPAM
    // (business rule 102(a)) so an IPAM release or re-assignment shows here
    // without waiting for the next gate read. A read grant is enough: it only
    // drops or re-labels rows discovery itself wrote. Never fails the read.
    try {
      await reconcileAddressesWithIpam(req.params.id as string, requestActor(req));
    } catch (err) {
      logger.warn({ err, assetId: req.params.id }, "IPAM address cross-check failed; serving stored addresses");
    }
    const asset = await prisma.asset.findUnique({
      where: { id: req.params.id as string },
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

    const [editScope, quarantineScope, maintScope] = await Promise.all([resolveWriteScope(req, "assets"), resolveWriteScope(req, "assetsQuarantine"), resolveWriteScope(req, "maintenanceManagement")]);
    const scopeRec = { createdBy: (asset as { createdBy?: string | null }).createdBy ?? null, tags: (asset as { tags?: string[] }).tags ?? [] };
    res.json({ ...safeAsset, ipContext: ipCtx, canEdit: inWriteScope(editScope, scopeRec), canQuarantine: inWriteScope(quarantineScope, scopeRec), canMaintain: inWriteScope(maintScope, scopeRec) });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/effective-monitor-settings — fully-resolved monitor
// settings for one asset PLUS per-field tier provenance, so the asset edit
// modal can render "Asset / Class / Integration / Manual" badges next to
// each field. Read-open to any authenticated caller.
router.get("/:id/effective-monitor-settings", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    res.json(await getEffectiveMonitorSettings(req.params.id as string));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/ip-history — IP address history for an asset (all authenticated users)
router.get("/:id/ip-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({ where: { id: req.params.id as string }, select: { id: true, learnedLocation: true } });
    if (!asset) throw new AppError(404, "Asset not found");
    const history = await getIpHistory(req.params.id as string);
    // Each row's network (the IP History table's VLAN column): a source of
    // "<gate>" or "<gate>:arp" names the gate that settles a repeated range,
    // then the asset's own gate.
    const gateOf = (source: string | null) => (source ? source.split(":")[0].trim() || null : null);
    const networks = await networksForAddresses(
      history.map((h) => ({ ip: h.ip, gate: gateOf(h.source) })),
      asset.learnedLocation,
    );
    res.json(history.map((h) => {
      const network = networks.get(`${h.ip}|${gateOf(h.source) ?? ""}`) ?? null;
      return { ...h, vlan: network?.vlan ?? null, network };
    }));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/alerts — active alerts for this asset + the enabled
// automations whose scope matches it (asset-details Alerts tab). The
// pre-rename /:id/notifications path stays as a deprecated alias.
router.get(["/:id/alerts", "/:id/notifications"], requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({ where: { id: req.params.id as string }, select: { id: true, createdBy: true, tags: true } });
    if (!asset) throw new AppError(404, "Asset not found");
    // Rule 141 (e): the tab's verbs for THIS caller — every alert here is on
    // this device, so one judgement covers the list.
    const ackReach = inWriteScope(await resolveWriteScope(req, "alerts"), asset);
    const clearReach = ackReach && hasPermission(req, "alertClear", "write");
    const payload = maskActionHeaders(await getAssetNotifications(req.params.id as string, { fullRules: hasPermission(req, "automationManagement", "read") })) as { active?: Array<Record<string, unknown>> } & Record<string, unknown>;
    if (Array.isArray(payload.active)) payload.active = payload.active.map((n) => ({ ...n, canAcknowledge: ackReach, canClear: clearReach }));
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/metric-thresholds?metric=hwSensorValue&sensorName=&sensorClass=
// The severity thresholds that would fire on this asset's charted metric, so a
// detail chart can shade its line with the engine's own numbers (severity bands
// included) instead of the client re-deriving them. Gated assets:read like
// every other per-asset chart feed.
router.get("/:id/metric-thresholds", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const metric = String(req.query.metric || "");
    if (!metric) throw new AppError(400, "metric is required");
    const asset = await prisma.asset.findUnique({ where: { id }, select: { id: true } });
    if (!asset) throw new AppError(404, "Asset not found");
    const sensorName = req.query.sensorName ? String(req.query.sensorName) : undefined;
    const sensorClass = req.query.sensorClass ? String(req.query.sensorClass) : undefined;
    // Path charts are one check's series (path* metrics).
    const checkId = req.query.checkId ? String(req.query.checkId) : undefined;
    const dimension = sensorName || sensorClass || checkId ? { sensorName, sensorClass, checkId } : undefined;
    res.json({ metric, tiers: await getMetricSeverityTiers(id, metric, dimension) });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/monitor-history?range=1h|12h|24h|7d|30d OR ?from=ISO&to=ISO
router.get("/:id/monitor-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const fromQ = req.query.from ? String(req.query.from) : null;
    const toQ   = req.query.to   ? String(req.query.to)   : null;
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
      const range = String(req.query.range || "24h");
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
    res.json({
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
    });
  } catch (err) { next(err); }
});

/**
 * Is this asset still inside its originating integration's device filter?
 *
 * Honors deviceInclude/deviceExclude (ouInclude/ouExclude for AD, vmInclude/
 * vmExclude for vCenter). Every operator-initiated pull shares this gate: a
 * refresh must not fetch from a device the next discovery sweep would skip —
 * operators tighten these filters precisely to keep Polaris off certain hosts.
 * Evaluated BEFORE any traffic leaves the box.
 *
 * Returns the loaded asset plus the blocking reason (`null` when in scope);
 * `notFound` distinguishes a missing asset so the caller 404s rather than
 * reporting a filter it never evaluated.
 */
async function resolveIntegrationFilterBlock(id: string): Promise<{
  notFound?: true;
  asset?: {
    hostname: string | null;
    ipAddress: string | null;
    discoveredByIntegration: { id: string; type: string; name: string } | null;
  };
  reason: string | null;
}> {
  const filterAsset = await prisma.asset.findUnique({
    where: { id },
    select: {
      hostname: true,
      ipAddress: true,
      learnedLocation: true,
      assetType: true,
      discoveredByIntegration: { select: { id: true, type: true, config: true, name: true } },
    },
  });
  if (!filterAsset) return { notFound: true, reason: null };
  if (!filterAsset.discoveredByIntegration) return { asset: filterAsset, reason: null };

  // For AD, prefer the source's own observed.ouPath over the merged
  // learnedLocation field (which other integrations can overwrite). The
  // lookup is cheap — one row, indexed by (sourceKind, externalId)'s
  // assetId index — and only runs on AD-discovered assets.
  let adOuPath: string | null = null;
  if (filterAsset.discoveredByIntegration.type === "activedirectory") {
    const adSource = await prisma.assetSource.findFirst({
      where: { assetId: id, sourceKind: "ad" },
      select: { observed: true },
    });
    const obs = (adSource?.observed as Record<string, unknown> | null) || null;
    if (obs && typeof obs.ouPath === "string") adOuPath = obs.ouPath;
  }
  // For vCenter, the vmInclude/vmExclude filters match the vCenter-side
  // VM name, which can differ from the merged hostname (guest hostname
  // wins projection) — same source-preferred pattern as AD's ouPath.
  let vmName: string | null = null;
  if (filterAsset.discoveredByIntegration.type === "vcenter") {
    const vmSource = await prisma.assetSource.findFirst({
      where: { assetId: id, sourceKind: "vcenter-vm" },
      select: { observed: true },
    });
    const obs = (vmSource?.observed as Record<string, unknown> | null) || null;
    if (obs && typeof obs.name === "string") vmName = obs.name;
  } else if (isWorkloadPlatform(filterAsset.discoveredByIntegration.type)) {
    // Unraid / TrueNAS: same idea — the platform's own VM / container name.
    const wlSource = await prisma.assetSource.findFirst({
      where: { assetId: id, sourceKind: { in: workloadSourceKindsFor(filterAsset.discoveredByIntegration.type) } },
      select: { observed: true },
    });
    const obs = (wlSource?.observed as Record<string, unknown> | null) || null;
    if (obs && typeof obs.name === "string") vmName = obs.name;
  }
  const filt = assetMatchesIntegrationFilter({ ...filterAsset, adOuPath, vmName }, filterAsset.discoveredByIntegration);
  return {
    asset: filterAsset,
    reason: filt.included ? null : (filt.reason || "Excluded by integration filter"),
  };
}

// POST /api/v1/assets/:id/probe-now — run a one-off probe immediately.
// Gated `assetsProbe=read`: probing dials the device and writes no Polaris
// state, so read IS the grant on that key (its ladder stops there).
// Triggers all three cadences (response-time, telemetry, system info) so the
// asset details panel refreshes everything at once instead of waiting for the
// scheduler to come around. Returns a per-stream status so the UI can tell
// the operator which streams refreshed and which failed (and why) — silent
// failures used to leave the System tab stale with no explanation.
router.post("/:id/probe-now", requirePermission("assetsProbe", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;

    // Out of the originating integration's scope → short-circuit before any
    // probe traffic goes out. See resolveIntegrationFilterBlock.
    const gate = await resolveIntegrationFilterBlock(id);
    if (gate.notFound) throw new AppError(404, "Asset not found");
    if (gate.reason) {
      const reason = gate.reason;
      const filterAsset = gate.asset!;
      const label = filterAsset.hostname || filterAsset.ipAddress || id;
      logEvent({
        action: "asset.refresh",
        resourceType: "asset",
        resourceId: id,
        resourceName: filterAsset.hostname || filterAsset.ipAddress || undefined,
        actor: requestActor(req),
        level: "warning",
        message: `Poll blocked: ${label} — ${reason}`,
        details: {
          integrationId: filterAsset.discoveredByIntegration?.id,
          integrationType: filterAsset.discoveredByIntegration?.type,
          reason,
        },
      });
      res.status(409).json({
        success: false,
        responseTimeMs: 0,
        error: reason,
        telemetry:   { supported: true, collected: false, error: reason },
        temperature: { supported: true, collected: false, error: reason },
        systemInfo:  { supported: true, collected: false, error: reason },
      });
      return;
    }

    // Keep flat response-time fields at the root for back-compat with anything
    // that still reads `success` / `responseTimeMs` directly.
    const probe = await probeAsset(id);
    await recordProbeResult(id, probe);

    // Telemetry (CPU/mem) and temperature dispatch independently — different
    // polling methods, credentials, MIBs, timeouts — so run them in parallel.
    // System-info is its own collector but also kicked off concurrently
    // because none of the three depend on each other's results. Each catch
    // returns a properly-typed CollectionResult so the union below has `data`
    // on every branch (TS narrowing was complaining otherwise).
    type TelResult  = Awaited<ReturnType<typeof collectTelemetry>>;
    type HwResult   = Awaited<ReturnType<typeof collectHardwareSensors>>;
    type SysResult  = Awaited<ReturnType<typeof collectSystemInfo>>;
    const tr_p:    Promise<TelResult>  = collectTelemetry(id).catch((err: any): TelResult  => ({ supported: true, error: err?.message || "Telemetry collection failed" }));
    const hwR_p:   Promise<HwResult>   = collectHardwareSensors(id).catch((err: any): HwResult => ({ supported: true, error: err?.message || "Hardware sensor collection failed" }));
    const sr_p:    Promise<SysResult>  = collectSystemInfo(id).catch((err: any): SysResult  => ({ supported: true, error: err?.message || "System info collection failed" }));
    // SD-WAN left the system-info pass for its own cadence (2026-09), so a Poll
    // Now that should still refresh the SD-WAN tab asks for it explicitly. The
    // runner applies its own eligibility (integration pulls SD-WAN, REST gate)
    // and is a silent no-op everywhere else, so it stays out of the summary.
    const sdwan_p = runSdwanFor(id, { transport: "rest_api", assetType: "unknown" }).catch(() => "crash" as const);
    const [tr, hwR, sr] = [await tr_p, await hwR_p, await sr_p];
    await sdwan_p;
    await Promise.all([
      recordTelemetryResult(id, tr),
      recordHardwareSensorResult(id, hwR),
      recordSystemInfoResult(id, sr),
    ]);
    const telemetry   = { supported: tr.supported,    collected: !!tr.data,                                       error: tr.error };
    // Hardware sensors are "collected" when the device actually returned sensor
    // rows. An empty array (sensor-less device) is supported-but-empty —
    // surfaced as n/a rather than failure so the toast doesn't nag on devices
    // that simply don't publish hardware sensors.
    const hwData      = Array.isArray(hwR.data) ? hwR.data : null;
    const hardware    = { supported: hwR.supported, collected: !!hwData && hwData.length > 0,                    error: hwR.error };
    const hwNoData    = !!(hwR.supported && hwData && hwData.length === 0);
    const systemInfo  = { supported: sr.supported,    collected: !!sr.data,                                       error: sr.error };

    // Audit the manual poll. The periodic monitorAssets job only writes
    // events on up/down transitions; this endpoint is operator-initiated, so
    // each click should leave a trace regardless of status change.
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: { hostname: true, ipAddress: true },
    });
    const label = asset?.hostname || asset?.ipAddress || id;
    const ok = probe.success;
    // A SKIPPED probe is not a failed one — nothing was measured. Two sources:
    // the response-time stream is set to Disabled (the operator's own choice),
    // and vCenter itself being unreachable. Rendering either as
    // "failed: unknown" and stamping a warning Event told the operator their
    // device was broken when Polaris had simply not asked.
    const probeSkipped = probe.skipped === true;
    const streamSummary: string[] = [];
    streamSummary.push(
      `probe ${ok
        ? probe.responseTimeMs + " ms"
        : probeSkipped
          ? "n/a" + (probe.error ? ` (${probe.error})` : " (not polled)")
          : "failed: " + (probe.error || "unknown")}`,
    );
    streamSummary.push(`telemetry ${telemetry.collected ? "ok" : (telemetry.supported ? "failed: " + (telemetry.error || "no data") : "n/a")}`);
    streamSummary.push(`hardware ${hardware.collected ? "ok" : (hwNoData ? "n/a (no sensors)" : (hardware.supported ? "failed: " + (hardware.error || "no data") : "n/a"))}`);
    streamSummary.push(`interfaces ${systemInfo.collected ? "ok" : (systemInfo.supported ? "failed: " + (systemInfo.error || "no data") : "n/a")}`);
    const anyFail = (!ok && !probeSkipped) ||
      (telemetry.supported && !telemetry.collected) ||
      (hardware.supported  && !hardware.collected && !hwNoData) ||
      (systemInfo.supported && !systemInfo.collected);
    logEvent({
      action: "asset.refresh",
      resourceType: "asset",
      resourceId: id,
      resourceName: asset?.hostname || asset?.ipAddress || undefined,
      actor: requestActor(req),
      level: anyFail ? "warning" : "info",
      message: `Poll: ${label} — ${streamSummary.join("; ")}`,
      details: { probe, telemetry, hardware, systemInfo },
    });

    res.json({ ...probe, telemetry, hardware, systemInfo });
  } catch (err) { next(err); }
});

// POST /api/v1/assets/:id/refresh-system-info — re-read ONE device's
// current-state inventory on demand.
//
// probe-now narrowed to a single collector. It backs the Refresh button on the
// three tabs whose whole content is a SNAPSHOT of what the device last
// answered — Wireless (radios / SSIDs / clients), MAC Table (the switch's
// forwarding database) and ARP Table (the gate's neighbour cache). All three
// are written by the same system-info pass, so one collector refreshes each of
// them; an operator looking at an empty client list wants THAT re-asked, not
// an ICMP probe and a CPU sample as well.
//
// Same `assetsProbe=read` gate as probe-now, and the same integration-filter
// short-circuit: it dials the device and writes only the current-state tables
// the scheduled pass would have written anyway. It touches NO monitor state —
// recordSystemInfoResult writes no probe result, so a manual refresh can
// neither mark an asset down nor clear a missed poll.
//
// `supported: false` is the honest answer, not an error: monitoring off, the
// interfaces stream set to Disabled, or an agent-managed host that pushes on
// its own schedule. The tab says so rather than spinning.
router.post("/:id/refresh-system-info", requirePermission("assetsProbe", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;

    const gate = await resolveIntegrationFilterBlock(id);
    if (gate.notFound) throw new AppError(404, "Asset not found");
    const gateAsset = gate.asset!;
    const label = gateAsset.hostname || gateAsset.ipAddress || id;
    if (gate.reason) {
      logEvent({
        action: "asset.refresh",
        resourceType: "asset",
        resourceId: id,
        resourceName: gateAsset.hostname || gateAsset.ipAddress || undefined,
        actor: requestActor(req),
        level: "warning",
        message: `System-info refresh blocked: ${label} — ${gate.reason}`,
        details: {
          integrationId: gateAsset.discoveredByIntegration?.id,
          integrationType: gateAsset.discoveredByIntegration?.type,
          reason: gate.reason,
        },
      });
      res.status(409).json({ supported: true, collected: false, error: gate.reason });
      return;
    }

    const result = await collectSystemInfo(id).catch((err: any) => ({
      supported: true as const,
      error: err?.message || "System info collection failed",
    }));
    await recordSystemInfoResult(id, result);
    const collected = !!(result as { data?: unknown }).data;

    // Operator-initiated, so it leaves a trace regardless of outcome — the
    // scheduled pass only logs on failure.
    logEvent({
      action: "asset.refresh",
      resourceType: "asset",
      resourceId: id,
      resourceName: gateAsset.hostname || gateAsset.ipAddress || undefined,
      actor: requestActor(req),
      level: result.supported && !collected ? "warning" : "info",
      message: `System-info refresh: ${label} — ${
        collected ? "ok" : result.supported ? "failed: " + (result.error || "no data") : "n/a (stream not delivered)"
      }`,
      details: { supported: result.supported, collected, error: result.error },
    });

    // The freshness stamp the tabs render comes from the row, not from this
    // response's timing — re-read it so a successful refresh cannot show an
    // age the collector did not actually achieve.
    const after = await prisma.asset.findUnique({
      where: { id },
      select: { lastSystemInfoAt: true },
    });

    res.json({
      supported: result.supported,
      collected,
      error: result.error ?? null,
      lastSystemInfoAt: after?.lastSystemInfoAt ?? null,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/assets/:id/rediscover — run discovery scoped to ONE asset.
// Backs the asset details slide-in's "Discover Now" button.
//
// `resolveDiscoveryScopeForAsset` decides which integration runs and how the
// run is narrowed (see that module). For an FMG-owned FortiGate this queues a
// SCOPED run (triggerDiscovery { scopeDeviceName }): the full run machinery —
// DiscoveryRun row, progress, abort, pg-boss handoff — narrowed to the one
// roster device, with the finalize pass in "finalize-scoped" mode
// (per-controller switch/AP decommission only; no fleet sweeps). For a
// standalone-FortiGate asset the integration IS the single gate, so a plain
// full run is the exact equivalent.
//
// A FortiSwitch/FortiAP resolves to its CONTROLLER gate and scopes the run to
// that: a switch is only ever discovered as a by-product of its controller's
// pass, and "finalize-scoped" is precisely the per-gate ghost-switch/AP
// cleanup such an asset needs. The response says which device was targeted so
// the caller can tell the operator when it wasn't the asset they clicked.
//
// No request body. Gated assets:write (above Poll Now's read-only assetsProbe
// grant) because a discovery mutates inventory — creates/updates assets +
// reservations, decommissions vanished switches/APs, releases stale VIP /
// dhcp_reservation rows.
// HA note: fortinetTopology.deviceName resolves to the FMG cluster device, so
// re-discovering a standby member's asset re-discovers the whole cluster.
router.post("/:id/rediscover", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const resolution = await resolveDiscoveryScopeForAsset(id);
    if (!resolution.ok) {
      // A missing asset is the only 404; every other reason is a legitimate
      // "this asset has no re-runnable discovery" → 400 with the reason as the
      // message, so the operator is told why.
      throw new AppError(resolution.notFound ? 404 : 400, resolution.reason);
    }
    const { integration, scope, deviceName, filterAsset, viaController } = resolution.resolved;

    // Honor deviceInclude/deviceExclude, same as probe-now: a discovery must
    // not pull a device the next full sweep would skip. Checked against the
    // hostname (assetMatchesIntegrationFilter's match field) and the resolved
    // FMG device name — the filter patterns can target either. For a
    // switch/AP, filterAsset is already the controller gate.
    const filtHost = assetMatchesIntegrationFilter(filterAsset, integration);
    const filtDevice = deviceName
      ? assetMatchesIntegrationFilter({ ...filterAsset, hostname: deviceName }, integration)
      : filtHost;
    if (!filtHost.included && !filtDevice.included) {
      const reason = filtHost.reason || "Excluded by integration filter";
      logEvent({
        action: "asset.rediscover",
        resourceType: "asset",
        resourceId: id,
        resourceName: filterAsset.hostname || filterAsset.ipAddress || undefined,
        actor: requestActor(req),
        level: "warning",
        message: `Discovery blocked: ${filterAsset.hostname || deviceName} — ${reason}`,
        details: { integrationId: integration.id, integrationType: integration.type, deviceName, reason },
      });
      res.status(409).json({ error: reason });
      return;
    }

    // Pre-check for a friendly message; triggerDiscovery's coalescing return
    // is the authoritative guard (closes the TOCTOU window).
    if (await isRunActive(integration.id)) {
      res.status(409).json({ error: `A discovery is already running for "${integration.name}" — try again when it finishes` });
      return;
    }
    // requestActor covers bearer-token callers ("api:<token name>") as well
    // as sessions — the actor string labels the run's start/complete Events.
    const actor = requestActor(req) ?? "";
    // `scopeLabel` gives the run row a name an operator recognises: the gate
    // name for FMG, the asset's hostname for a directory device (whose scope
    // identifier is an opaque GUID).
    const started = scope
      ? await triggerDiscovery(integration.id, actor, { scope, scopeLabel: deviceName })
      : await triggerDiscovery(integration.id, actor);
    if (!started) {
      res.status(409).json({ error: `A discovery is already running for "${integration.name}" — try again when it finishes` });
      return;
    }

    const target = deviceName || integration.name;
    logEvent({
      action: "asset.rediscover",
      resourceType: "asset",
      resourceId: id,
      resourceName: filterAsset.hostname || filterAsset.ipAddress || undefined,
      actor: requestActor(req),
      message: viaController
        ? `Discovery requested via controller FortiGate "${target}" using "${integration.name}"`
        : `Discovery requested for FortiGate "${filterAsset.hostname || target}" via "${integration.name}"`,
      details: { integrationId: integration.id, integrationType: integration.type, deviceName, viaController },
    });
    res.status(202).json({
      message: viaController ? `Discovery started on controller ${target}` : "Discovery started",
      integrationId: integration.id,
      integrationName: integration.name,
      deviceName,
      viaController,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/assets/:id/snmp-walk — operator-driven SNMP walk used by the
// asset details "SNMP Walk" tab. Admin-only because the response includes raw
// device data that the integration filter doesn't touch (e.g. tunnel names,
// configured users) — read-only but high-fidelity. Walks `oid` against the
// asset's `ipAddress` using the supplied credentialId (any stored SNMP
// credential, not necessarily the asset's monitor credential), capped at
// `maxRows` (1..5000, default 500).
const SnmpWalkSchema = z.object({
  credentialId: z.string().uuid("credentialId must be a UUID"),
  oid:          z.string().regex(/^\d+(\.\d+)*$/, "OID must be numeric (e.g. 1.3.6.1.2.1.1)").optional().default("1.3.6.1.2.1.1"),
  maxRows:      z.number().int().min(1).max(5000).optional().default(500),
});

router.post("/:id/snmp-walk", requirePermission("assetsProbe", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const parsed = SnmpWalkSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues.map(e => e.message).join("; "));
    }
    const { credentialId, oid, maxRows } = parsed.data;

    const asset = await prisma.asset.findUnique({
      where: { id },
      select: { id: true, hostname: true, ipAddress: true, ipv6Address: true },
    });
    if (!asset) throw new AppError(404, "Asset not found");
    // IPv4, else (IPv6 on) the primary IPv6 — business rule 128.
    const walkHost = assetDialAddress(asset, ipv6Dialable());
    if (!walkHost) throw new AppError(400, "Asset has no IP address to walk");

    // Rule 112(e): this route is read-level, so only a credential the asset
    // already uses — anything else needs assets:write (re-scan F62).
    await assertCredentialInAssetScope(asset.id, credentialId, hasPermission(req, "assets", "write"));
    const cred = await getCredential(credentialId, { revealSecrets: true });
    if (cred.type !== "snmp") {
      throw new AppError(400, `Credential "${cred.name}" is type "${cred.type}", expected "snmp"`);
    }
    // Rule 112: the walk sends this credential's community / keys to the asset.
    await recordCredentialUse(credentialUseActor(req), "asset.snmp-walk", [
      { credentialId: cred.id, destination: walkHost, assetId: asset.id, assetName: asset.hostname ?? walkHost },
    ]);

    const label = asset.hostname || asset.ipAddress;
    try {
      const result = await snmpWalkRaw(walkHost, cred.config as Record<string, unknown>, oid, maxRows);
      logEvent({
        action: "asset.snmp_walk",
        resourceType: "asset",
        resourceId: id,
        resourceName: asset.hostname || asset.ipAddress || undefined,
        actor: requestActor(req),
        level: "info",
        message: `SNMP walk: ${label} — ${oid} → ${result.rows.length} row(s)${result.truncated ? " (truncated)" : ""}`,
        details: { oid, credentialName: cred.name, rows: result.rows.length, truncated: result.truncated, durationMs: result.durationMs },
      });
      res.json({ ...result, oid, host: walkHost });
    } catch (err: any) {
      const message = err?.message || "SNMP walk failed";
      logEvent({
        action: "asset.snmp_walk",
        resourceType: "asset",
        resourceId: id,
        resourceName: asset.hostname || asset.ipAddress || undefined,
        actor: requestActor(req),
        level: "warning",
        message: `SNMP walk failed: ${label} — ${oid} — ${message}`,
        details: { oid, credentialName: cred.name, error: message },
      });
      throw new AppError(502, message);
    }
  } catch (err) { next(err); }
});

export default router;

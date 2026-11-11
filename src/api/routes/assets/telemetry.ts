/**
 * src/api/routes/assets/telemetry.ts — Per-asset telemetry reads behind the slide-over tabs: custom widgets, interface
 * history and interface comments / tags, hardware, IPsec, SD-WAN and Perf SLA, path
 * checks, MCLAG, upstream, VIPs, virtualization, storage and process history, process /
 * service logs, process config. Split out of routes/assets.ts (CQ-B062) and mounted
 * there in order.
 */

import { Router } from "express";
import { intQuery, boolQuery } from "../../../utils/queryParams.js";
import { z } from "zod";
import { AppError } from "../../../utils/errors.js";
import { requirePermission, hasPermission, assertTagChangeAllowed } from "../../middleware/permissions.js";
import { scopeAssetParam } from "../../middleware/writeScope.js";
import { requestActor } from "../../middleware/auth.js";
import { readAssetIpsec } from "../../../services/ipsecConnectionService.js";
import { resolveSdwanPollIntervalForAsset } from "../../../services/monitoringService.js";
import { resolveAssetUpstream } from "../../../services/assetUpstreamService.js";
import { resolveAssetVips } from "../../../services/assetVipService.js";
import { setInterfaceTags } from "../../../services/interfaceTagService.js";
import { pickSampleTierForAsset } from "../../../services/sampleQueryRouter.js";
import { resolveRange, extendSinceForLookback } from "../../../utils/chartRange.js";
import { readHardwareSensorHistory, readStorageHistory, readProcessHistory } from "../../../services/sampleHistoryService.js";
import { getMetricSeverityTierResolver } from "../../../services/notificationRuleService.js";
import { getAssetChecks as getAssetPathChecks } from "../../../services/pathCheckService.js";
import { readIpsecHistory, readPerfSlaHistory, readPathCheckHistory, readSdwanMembers } from "../../../services/sampleHistoryService.js";
import { readProbeOutages, serializeOutages } from "../../../services/probeOutageService.js";
import { resolveCurrentStateIntervalSec } from "../../../services/monitoring/monitorSettings.js";

import { getAssetCustomWidgets, getInterfaceHistory, setInterfaceComment, getPerfSlaLinks, getPathCheckTraceroutes, getSdwanRules, getMclagPeers, getAssetVirtualization, getProcessLogs, getServiceLogs, setProcessLogConfig, listManualInterfaceTags } from "../../../services/assetTelemetryService.js";


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
    res.json(await getAssetCustomWidgets(id));
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
    res.json(await getInterfaceHistory(id, ifName, since, until, rangeLabel));
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

    res.json(await setInterfaceComment(id, ifName, trimmed, actor));
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
    const current = await listManualInterfaceTags(id, ifName);
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
    res.json(await getPerfSlaLinks(id));
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
    res.json(await getPathCheckTraceroutes(id, checkId, limit));
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
    res.json(await getSdwanRules(id));
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
    res.json(await getMclagPeers(id));
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
    res.json(await getAssetVirtualization(id));
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
    res.json(await getProcessLogs(id, name, limit, since, onlyFlagged));
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
    res.json(await getServiceLogs(id, unit, limit, since, onlyFlagged));
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
    res.json(await setProcessLogConfig(id, name, body, hasPermission(req, "agentDeploy", "write"), requestActor(req)));
  } catch (err) { next(err); }
});

export default router;

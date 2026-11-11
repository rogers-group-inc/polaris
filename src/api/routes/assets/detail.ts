/**
 * src/api/routes/assets/detail.ts — One asset: GET /:id, its effective monitor settings, IP history, alerts, metric
 * thresholds, monitor history, and the on-demand verbs (probe now, refresh system
 * info, rediscover, SNMP walk). Split out of routes/assets.ts (CQ-B062) and mounted
 * there in order — after the collection routes, so a literal path such as
 * /ip-check is never read as an :id.
 */

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../../utils/errors.js";
import { requirePermission, hasPermission, credentialUseActor } from "../../middleware/permissions.js";
import { resolveWriteScope, inWriteScope } from "../../../services/writeScopeService.js";
import { scopeAssetParam } from "../../middleware/writeScope.js";
import { maskActionHeaders } from "../../../utils/actionHeaderMask.js";
import { requestActor } from "../../middleware/auth.js";
import { pollAssetNow, refreshAssetSystemInfo, rediscoverAsset, snmpWalkAsset } from "../../../services/assetLiveActionService.js";
import { getEffectiveMonitorSettings, assertAssetExists, getAssetDetail, getAssetIpHistory, loadAssetScopeRecord, readAssetMonitorHistory } from "../../../services/assetDetailReadService.js";
import { getAssetNotifications } from "../../../services/notificationService.js";
import { getMetricSeverityTiers } from "../../../services/notificationRuleService.js";

const router = Router();

router.get("/:id", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const { safeAsset, ipCtx, scopeRec } = await getAssetDetail(req.params.id as string, requestActor(req));
    const [editScope, quarantineScope, maintScope] = await Promise.all([resolveWriteScope(req, "assets"), resolveWriteScope(req, "assetsQuarantine"), resolveWriteScope(req, "maintenanceManagement")]);
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
    res.json(await getAssetIpHistory(req.params.id as string));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/alerts — active alerts for this asset + the enabled
// automations whose scope matches it (asset-details Alerts tab). The
// pre-rename /:id/notifications path stays as a deprecated alias.
router.get(["/:id/alerts", "/:id/notifications"], requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const asset = await loadAssetScopeRecord(req.params.id as string);
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
    await assertAssetExists(id);
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
    res.json(await readAssetMonitorHistory(id, fromQ, toQ, String(req.query.range || "24h")));
  } catch (err) { next(err); }
});


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
    const r = await pollAssetNow(id, requestActor(req));
    res.status(r.status).json(r.body);
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
    const r = await refreshAssetSystemInfo(id, requestActor(req));
    res.status(r.status).json(r.body);
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
    const r = await rediscoverAsset(id, requestActor(req));
    res.status(r.status).json(r.body);
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
    res.json(await snmpWalkAsset(id, { credentialId, oid, maxRows }, hasPermission(req, "assets", "write"), credentialUseActor(req), requestActor(req)));
  } catch (err) { next(err); }
});

export default router;

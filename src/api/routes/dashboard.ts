/**
 * src/api/routes/dashboard.ts
 *
 * Feeds behind the Dashboard home page. Both endpoints accept a subset param
 * (?sections= on /summary, ?feeds= on /noc-summary) so each widget fetches
 * only the data it renders — a widget appears as soon as ITS query finishes
 * instead of gating on the slowest feed in a monolithic payload. Omitting the
 * param returns the full legacy shape. Every section/feed is served through a
 * short server-side TTL cache (see nocDashboardService.NOC_FEED_CACHE_TTL_MS)
 * so concurrent widgets, tabs, and kiosk walls share one computation.
 *
 * /summary sections:
 *   - blockUtilization:  per-block address allocation (reused from utilizationService)
 *   - recentReservations: most recent N (default 10) reservations by source type
 *   - assetTypeCounts:   counts per AssetType excluding decommissioned/disabled
 *   - monitorAlerts:     monitored assets currently in warning/down state,
 *                         newest transition first, capped at 50
 */

import { Router } from "express";
import * as utilizationService from "../../services/utilizationService.js";
import * as nocDashboardService from "../../services/nocDashboardService.js";
import { createTtlCache } from "../../utils/ttlCache.js";
import { csvParam } from "../../utils/text.js";
import { ensureRoleSnapshot, hasPermission } from "../middleware/permissions.js";

const router = Router();

const MONITOR_ALERT_CAP = 50;

// Short response cache for the /summary sections (the noc-summary feeds have
// their own per-feed cache inside nocDashboardService). Keys carry the
// section's parameters; permission-denied sections never enter the cache.
const summaryCache = createTtlCache<unknown>({
  ttlMs: nocDashboardService.NOC_FEED_CACHE_TTL_MS,
  maxEntries: 64,
});

// The /summary section names ?sections= may request. Unknown names are
// dropped silently (same convention as recentSourceTypes).
const SUMMARY_SECTIONS = new Set(["blocks", "recent", "assetTypes", "monitorAlerts"]);

// Recognized reservation source types — the same enum the Reservation
// model carries. Anything in the query that isn't one of these is dropped
// silently so a typo doesn't error out the whole summary.
const RESERVATION_SOURCE_TYPES = new Set([
  "manual",
  "dhcp_reservation",
  "dhcp_lease",
  "interface_ip",
  "vip",
  "fortiswitch",
  "fortinap",
  "fortimanager",
  "fortigate",
  "dns_resolved",
]);

function parseSourceTypesParam(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const validated = parts.filter((s) => RESERVATION_SOURCE_TYPES.has(s));
  // Caller asked for a filter but every value was unrecognized — match the
  // server-side empty-array convention (= no filter) so the widget still
  // gets data rather than 0 rows.
  return validated.length === 0 ? [] : validated;
}

router.get("/summary", async (req, res, next) => {
  try {
    // Filter, don't 403: the dashboard is the redirect target for users
    // bounced off gated pages, so it must render for every role. Each widget
    // section is gated on the read access of the function that owns its data;
    // denied sections come back as empty arrays with the response shape
    // unchanged. Bearer tokens resolve their bound role's snapshot, so a
    // token sees exactly the sections its role can read.
    await ensureRoleSnapshot(req);
    const canBlocks       = hasPermission(req, "ipBlocks", "read");
    const canReservations = hasPermission(req, "reservations", "read");
    const canAssets       = hasPermission(req, "assets", "read");

    // ?sections= narrows to the named subset so a widget fetches only what it
    // renders; absent = every section (legacy shape).
    const sectionsRaw = parseCsvParam(req.query.sections);
    const sections = sectionsRaw === null
      ? SUMMARY_SECTIONS
      : new Set(sectionsRaw.filter((s) => SUMMARY_SECTIONS.has(s)));
    const wants = (s: string) => sections.has(s);

    const sourceTypes = parseSourceTypesParam(req.query.recentSourceTypes);
    // recentReservations row cap: absent → default 10; "0" → null (No Limit,
    // server sends everything); any other positive int → that cap.
    const recentLimit = parseRecentLimitParam(req.query.recentLimit);
    const emptyAssetRows: never[] = [];
    const [global, recentReservations, assetTypeCountsRaw, monitorAlertsRaw] = await Promise.all([
      wants("blocks") && canBlocks
        ? summaryCache.getOrCompute("blocks", () => utilizationService.getGlobalUtilization())
        : Promise.resolve({ blockUtilization: [] }),
      wants("recent") && canReservations
        ? summaryCache.getOrCompute(
            `recent|${recentLimit ?? ""}|${(sourceTypes ?? ["_default"]).join(",")}`,
            () => utilizationService.getRecentManualReservations(recentLimit, sourceTypes),
          )
        : Promise.resolve([]),
      wants("assetTypes") && canAssets
        ? summaryCache.getOrCompute("assetTypes", () => nocDashboardService.getAssetTypeCountRows())
        : Promise.resolve(emptyAssetRows),
      // The alert list SHARES nocDashboardService.ALERT_WHERE with the NOC
      // active-alert tile count, so the list and the tile can never disagree.
      wants("monitorAlerts") && canAssets
        ? summaryCache.getOrCompute("monitorAlerts", () => nocDashboardService.getMonitorAlertRows(MONITOR_ALERT_CAP))
        : Promise.resolve(emptyAssetRows),
    ]) as [
      Awaited<ReturnType<typeof utilizationService.getGlobalUtilization>> | { blockUtilization: never[] },
      Awaited<ReturnType<typeof utilizationService.getRecentManualReservations>>,
      Array<{ assetType: string; _count: { _all: number } }>,
      Array<Record<string, unknown>>,
    ];

    const overflow = monitorAlertsRaw.length > MONITOR_ALERT_CAP;
    const monitorAlerts = overflow ? monitorAlertsRaw.slice(0, MONITOR_ALERT_CAP) : monitorAlertsRaw;

    // Only requested sections appear in the response; the no-param call keeps
    // the full legacy shape.
    const body: Record<string, unknown> = {};
    if (wants("blocks"))     body.blockUtilization = global.blockUtilization;
    if (wants("recent"))     body.recentReservations = recentReservations;
    if (wants("assetTypes")) body.assetTypeCounts = assetTypeCountsRaw.map((row) => ({
      assetType: row.assetType,
      count:     row._count._all,
    }));
    if (wants("monitorAlerts")) {
      body.monitorAlerts = monitorAlerts;
      body.monitorAlertsOverflow = overflow;
    }
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /noc-summary — the feed endpoint for the SolarWinds-style NOC widgets.
 * ?feeds=topCpu,downNodes narrows to the named subset (each widget fetches its
 * own feed so it renders as soon as its data exists); absent = every feed in
 * one round-trip (legacy shape, still used by external kiosk consumers).
 * Same filter-don't-403 contract as /summary: asset-sourced sections gate on
 * assets:read, the Event-sourced section (recent reboots) on events:read, and
 * the Notification-sourced one (active alerts) on alerts:read;
 * denied sections return empty/zero with the shape unchanged.
 * Feed computation + caching live in nocDashboardService.getNocSummaryPayload.
 */
function parseCsvParam(raw: unknown): string[] | null {
  return csvParam(raw) ?? null;
}

// Query-string boolean: "1" / "true" / "yes" are true, everything else false.
function boolParam(raw: unknown): boolean {
  return typeof raw === "string" && (raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes");
}

// Row cap for the summary's recentReservations feed. Absent/invalid → default
// 10; otherwise the requested count clamped to the 1000-row ceiling.
function parseRecentLimitParam(raw: unknown): number {
  if (typeof raw !== "string" || raw.length === 0) return 10;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) return 10;
  return Math.min(n, 1000);
}

router.get("/noc-summary", async (req, res, next) => {
  try {
    await ensureRoleSnapshot(req);
    // The no-login NOC kiosk authenticates with a bearer token bound to a role
    // granting assets+events read (the seeded api-noc role for pre-cutover
    // tokens). ensureRoleSnapshot resolved that role above, so tokens and
    // sessions gate identically here. Same filter-don't-403 contract: no read
    // access → empty sections with the shape unchanged.
    const canAssets = hasPermission(req, "assets", "read");
    const canEvents = hasPermission(req, "events", "read");
    // The activeAlerts feed reads Notification rows, so it gates on `alerts`.
    // Every role was seeded that key at read (see the gate note in
    // getNocSummaryPayload), so no existing kiosk token loses the feed.
    const canAlerts = hasPermission(req, "alerts", "read");

    // Per-widget filters (optional): ?hideAssetTypes=printer,network_camera
    // (the types the widget's gear grid has switched OFF — the form the grid
    // writes today, and the only one that can hide an operator-added CUSTOM
    // type, since it names the hidden set outright), ?assetTypes=server,switch
    // (the LEGACY form: the ENABLED built-in types, still arriving from configs
    // saved before the grid learned the registry — the two union),
    // ?regionTags=East,West (the caller's "My regions"
    // names), and ?fortigates=SITE-FG1,SITE-FG2 (the "Selected FortiGates"
    // per-site narrowing — assets behind any named gate via learnedLocation /
    // sighting rows). The service resolves them to an asset-id set (cached) —
    // null when nothing narrows, the default unfiltered path. The frontend
    // memoizes per (feeds, assetTypes, hideAssetTypes, regionTags, fortigates)
    // so each distinct request fetches once.
    const assetTypes = parseCsvParam(req.query.assetTypes);
    const hideAssetTypes = parseCsvParam(req.query.hideAssetTypes);
    const regionNames = parseCsvParam(req.query.regionTags);
    const fortigateNames = parseCsvParam(req.query.fortigates);

    // A widget wanting more than the default payload (the 1000-row option) sends
    // ?limit=N; that caps every REQUESTED feed at N, clamped to a 1000 ceiling.
    // Absent → each feed keeps its own default and widgets clip client-side.
    const reqLimit = parseInt(String(req.query.limit ?? ""), 10);
    const capLimit = Number.isFinite(reqLimit) && reqLimit > 0 ? Math.min(reqLimit, 1000) : null;

    // ?samples=N — per-asset averaging count for the sample-averaged top-N
    // feeds (topCpu/topMemory "Average over" gear control). Absent/invalid →
    // the service default (10); clamped to the service ceiling.
    const reqSamples = parseInt(String(req.query.samples ?? ""), 10);
    const sampleCount = Number.isFinite(reqSamples) && reqSamples > 0
      ? Math.min(reqSamples, nocDashboardService.MAX_TOPN_SAMPLE_COUNT)
      : null;

    // ?includeDependencyDown=1 -- the Down Assets widget's gear toggle. Absent
    // (the default) keeps dependency-suppressed assets out, so one dead gate
    // reads as one outage rather than one per device behind it.
    const includeDependencyDown = boolParam(req.query.includeDependencyDown);

    res.json(await nocDashboardService.getNocSummaryPayload({
      feeds: parseCsvParam(req.query.feeds),
      canAssets,
      canEvents,
      canAlerts,
      assetTypes,
      hideAssetTypes,
      regionNames,
      fortigateNames,
      capLimit,
      sampleCount,
      includeDependencyDown,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /filter-options — available asset types + region tags + FortiGate
 * device names for the NOC dashboard's widget filter pickers. Same
 * assets-read gate as /noc-summary (session role or token-bound role);
 * callers without access get empty lists (not 403).
 */
router.get("/filter-options", async (req, res, next) => {
  try {
    await ensureRoleSnapshot(req);
    const canAssets = hasPermission(req, "assets", "read");
    if (!canAssets) {
      res.json({ assetTypes: [], regions: [], fortigates: [] });
      return;
    }
    res.json(await nocDashboardService.getFilterOptions());
  } catch (err) {
    next(err);
  }
});

export default router;

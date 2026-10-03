/**
 * src/api/routes/map.ts — Device Map endpoints
 *
 * Read endpoints — requireAuth + a blanket deviceMap=read floor, both applied
 * at the mount in router.ts (the floor was added 2026-08; these reads were
 * previously auth-only despite the function key existing):
 *   GET /map/sites              — every firewall asset with lat/lng coords
 *   GET /map/search?q=<query>   — autocomplete over firewall hostnames
 *   GET /map/sites/:id/topology — FortiGate + its FortiSwitches + FortiAPs + edges
 *                                 (+ savedLayouts: shared per-view node positions)
 *   GET /map/region-overlay     — read-only region polygons + the derived
 *                                 containment tree, for the "Show regions"
 *                                 button. Note the DELIBERATE permission
 *                                 widening documented at the route itself.
 *
 * Write endpoints (escalate to deviceMap=write per-route):
 *   PUT    /map/sites/:id/topology/layout — full-replace one (site, view) layout
 *   POST   /map/sites/:id/topology/layout/checkpoint — stamp the restore point
 *   DELETE /map/sites/:id/topology/layout?view=<key> — reset one view's layout
 *
 * Coordinates and topology metadata are populated by the FortiManager / FortiGate
 * discovery pipelines (see fortimanagerService.ts step 3d.5/3d.6 and
 * fortigateService.ts step 3e.5/3e.6). The topology GET's graph construction
 * (edges from the `fortinetTopology` JSON field, LLDP/interface/MCLAG
 * inference) lives in services/topologyGraphService.ts — nothing here queries
 * a live device.
 */

import { EXCLUDED_LIFECYCLE_STATUSES } from "../../utils/assetInvariants.js";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { controllerStampWhereOr, readFirewallDeviceName } from "../../utils/fortinetParentKey.js";
import {
  attributeEndpointToSiteSwitch,
  buildSiteEndpointAttribution,
  buildSiteTopology,
  monitorStatusToHealth,
  fetchRecentSampleStats,
  portOfLastSeenSwitch,
} from "../../services/topologyGraphService.js";
import { getRegionHierarchy } from "../../services/mapRegionService.js";
import { downAlertAcknowledgedByAsset } from "../../services/nocDashboardService.js";
import {
  saveLayout,
  saveCheckpoint,
  resetLayout,
  sanitizePositions,
  isValidViewKey,
  MAX_LAYOUT_NODES,
  MAX_VIEW_KEY_LEN,
} from "../../services/topologyLayoutService.js";
import { logEvent } from "./events.js";
import { requirePermission } from "../middleware/permissions.js";

const router = Router();

// Shared topology-layout write bodies. View keys are "flat" or the
// computeFloorViews building/floor keys ("b|…" / "f|…"); positions is the
// { nodeId: {x,y} } blob map.js saves — re-validated in depth by
// sanitizePositions (finite coords, node cap) at the service seam.
const ViewKeySchema = z
  .string()
  .max(MAX_VIEW_KEY_LEN)
  .refine(isValidViewKey, 'view must be "flat" or a "b|…" / "f|…" floor-view key');

const SaveLayoutSchema = z.object({
  view: ViewKeySchema,
  positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).refine(
    (p) => Object.keys(p).length <= MAX_LAYOUT_NODES,
    `positions exceeds the ${MAX_LAYOUT_NODES}-node cap`,
  ),
});

// ─── GET /map/sites ────────────────────────────────────────────────────────────
// Every firewall asset with non-null lat/lng — one pin per managed FortiGate.
/**
 * GET /map/region-overlay — read-only region geometry + the containment tree,
 * for the map's "Show regions" button and its hover tree.
 *
 * SECURITY, DELIBERATE: this WIDENS who can read region polygons. The CRUD
 * router at /map/regions is gated `mapRegions:read`, which a viewer holding
 * only `deviceMap:read` need not have. This route lives here instead so it
 * inherits the /map mount's `deviceMap:read` floor, because the button is meant
 * to be available to anyone who can look at the map. The same viewer already
 * gets every firewall's hostname and coordinates from GET /map/sites, so the
 * incremental exposure is the polygons and their names.
 *
 * It is NOT in the dash listener's API_PATH_ALLOWLIST (src/dash/dashServer.ts)
 * and must not be added: the unauthenticated wallboard cannot run the Device
 * Map at all, so reaching this there would be a pure attack-surface increase.
 * `tests/integration/dashServer.test.ts` pins the 404.
 *
 * Deliberately named with no shared prefix with the /map/regions mount, so the
 * routing is obvious to the next reader rather than merely correct.
 */
router.get("/region-overlay", async (_req, res, next) => {
  try {
    const { regions, hierarchy } = await getRegionHierarchy();
    res.json({
      regions: regions.map((r) => {
        const node = hierarchy.byId[r.id];
        return {
          id: r.id,
          name: r.name,
          color: r.color,
          polygon: r.polygon,
          level: node?.level ?? 1,
          depth: node?.depth ?? 0,
          parentId: node?.parentId ?? null,
          childIds: node?.childIds ?? [],
          ancestorIds: node?.ancestorIds ?? [],
        };
      }),
      roots: hierarchy.rootIds,
      maxLevel: hierarchy.maxLevel,
      warnings: hierarchy.warnings,
      truncated: hierarchy.truncated,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/sites", async (req, res, next) => {
  try {
    // Optional "My regions" filter: ?regionTags=East,West restricts to firewalls
    // carrying the matching region:<name> tag. Empty/absent = all regions.
    const regionRaw = req.query.regionTags;
    const regionNames = typeof regionRaw === "string" && regionRaw.length
      ? regionRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const regionWhere = regionNames.length
      ? { tags: { hasSome: regionNames.map((n) => "region:" + n) } }
      : {};
    const sites = await prisma.asset.findMany({
      where: {
        assetType: "firewall",
        latitude: { not: null },
        longitude: { not: null },
        status: { notIn: EXCLUDED_LIFECYCLE_STATUSES },
        ...regionWhere,
      },
      select: {
        id: true,
        hostname: true,
        serialNumber: true,
        model: true,
        ipAddress: true,
        latitude: true,
        longitude: true,
        status: true,
        monitorStatus: true,
        lastSeen: true,
        learnedLocation: true,
        monitored: true,
        dependencyLayer: true,
        dependencySuppressed: true,
      },
      orderBy: { hostname: "asc" },
    });

    const monitorStats = await fetchRecentSampleStats(
      sites.filter((s) => s.monitored).map((s) => s.id),
    );

    // Acknowledged-ness of each DOWN site's down alert, so the map widgets can
    // fade an outage someone already owns. Bounded to the down sites only.
    const downAck = await downAlertAcknowledgedByAsset(
      sites.filter((s) => s.monitored && s.monitorStatus === "down").map((s) => s.id),
    );

    // Subnet counts per FortiGate — the `fortigateDevice` column on Subnet
    // stores the FMG-side device name, which (for auto-discovered FortiGates)
    // matches the Asset's hostname or learnedLocation. One query, grouped.
    const hostnames = sites.map((s) => s.hostname).filter((h): h is string => !!h);
    const subnetCounts = hostnames.length
      ? await prisma.subnet.groupBy({
          by: ["fortigateDevice"],
          where: { fortigateDevice: { in: hostnames } },
          _count: { _all: true },
        })
      : [];
    const countByName = new Map<string, number>();
    for (const row of subnetCounts) {
      if (row.fortigateDevice) countByName.set(row.fortigateDevice, row._count._all);
    }

    res.json(
      sites.map((s) => {
        const stats = s.monitored ? monitorStats.get(s.id) : null;
        return {
          ...s,
          subnetCount: s.hostname ? countByName.get(s.hostname) ?? 0 : 0,
          // Derive the dot's health from Asset.monitorStatus (the five-state
          // machine), NOT the raw 10-sample window — so the Status Map's red
          // "down" dots agree with the Down Assets / Status Summary widgets,
          // which key off monitorStatus. The recent sample counts still ride
          // along for the tooltip's "X/Y samples failed" detail.
          monitorHealth: s.monitored ? monitorStatusToHealth(s.monitorStatus) : null,
          monitorRecentSamples: stats?.samples ?? 0,
          monitorRecentFailures: stats?.failures ?? 0,
          // true = the down alert is acknowledged; false = unacknowledged;
          // absent = no active down alert (or the site isn't down).
          ...(downAck.has(s.id) ? { alertAcknowledged: downAck.get(s.id) } : {}),
        };
      }),
    );
  } catch (err) {
    next(err);
  }
});

// ─── GET /map/sites/:id/topology ───────────────────────────────────────────────
// Graph payload for the click-through modal. Thin route — the full graph
// construction (nodes, edge inference, payload-shape docs) lives in
// services/topologyGraphService.ts (buildSiteTopology, extracted verbatim
// from this handler in the 2026-08 audit). The service throws
// AppError(404, "FortiGate not found") when the id isn't a live firewall
// asset, so error responses are unchanged. Auth-only, like the other reads.
router.get("/sites/:id/topology", async (req, res, next) => {
  try {
    res.json(await buildSiteTopology(req.params.id));
  } catch (err) {
    next(err);
  }
});

// ─── GET /map/sites/:id/topology/search?q=<query> ──────────────────────────────
// Site-scoped endpoint search for the topology modal. Matches the query as a
// case-insensitive substring of hostname / IP / MAC / assignedTo, scoped to
// endpoints whose `lastSeenSwitch` references one of THIS site's switches
// (or LLDP-confirmed neighbors of those switches via the existing matched
// asset cross-link). Returns the matching endpoint + which switch it's on
// so the frontend can pulse-highlight that switch on the graph and pivot
// to asset details on click.
router.get("/sites/:id/topology/search", async (req, res, next) => {
  try {
    const id = req.params.id;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) return res.json({ q: "", results: [] });

    const fg = await prisma.asset.findFirst({
      where: { id, status: { notIn: EXCLUDED_LIFECYCLE_STATUSES } },
      select: { id: true, hostname: true, serialNumber: true, assetType: true, fortinetTopology: true },
    });
    if (!fg || fg.assetType !== "firewall") throw new AppError(404, "FortiGate not found");

    // Match children by serial / FMG device name / hostname — hostname alone
    // misses every install whose FMG device name differs from the gate's
    // configured hostname. See utils/fortinetParentKey.ts.
    const controllerKeyOr = controllerStampWhereOr({
      hostname: fg.hostname,
      serialNumber: fg.serialNumber,
      deviceName: readFirewallDeviceName(fg.fortinetTopology),
    });
    const siblingSwitches = controllerKeyOr.length > 0
      ? await prisma.asset.findMany({
          where: {
            assetType: "switch",
            AND: [{ OR: controllerKeyOr }],
            status: { notIn: EXCLUDED_LIFECYCLE_STATUSES },
          },
          select: { id: true, hostname: true },
        })
      : [];
    // Which switch an endpoint sits on is its `switch-port` dependency edge,
    // or a hostname prefix only when the name is unique fleet-wide (business
    // rule 91 — the per-site "IDF-1" of a FortiLink fleet). Same rule as the
    // topology payload's `endpointCount` / `endpoints[]`.
    const attribution = await buildSiteEndpointAttribution(siblingSwitches);
    if (attribution.whereOr.length === 0) return res.json({ q, results: [] });

    // Site attribution AND substring match across common identity fields.
    // Capped at 25 results — search is for finding a specific endpoint, not
    // for browsing.
    const matches = await prisma.asset.findMany({
      where: {
        assetType: { notIn: ["firewall", "switch", "access_point"] },
        status: { notIn: EXCLUDED_LIFECYCLE_STATUSES },
        OR: attribution.whereOr,
        AND: [
          {
            OR: [
              { hostname:    { contains: q, mode: "insensitive" } },
              { ipAddress:   { contains: q, mode: "insensitive" } },
              { macAddress:  { contains: q, mode: "insensitive" } },
              { assignedTo:  { contains: q, mode: "insensitive" } },
              { dnsName:     { contains: q, mode: "insensitive" } },
            ],
          },
        ],
      },
      select: {
        id: true, hostname: true, ipAddress: true, macAddress: true,
        assetType: true, assignedTo: true, lastSeenSwitch: true, lastSeen: true,
        dependencyParents: attribution.edgeSelect,
      },
      orderBy: { lastSeen: "desc" },
      take: 25,
    });

    const switchHostById = new Map<string, string | null>();
    for (const s of siblingSwitches) switchHostById.set(s.id, s.hostname);
    const results = matches.map((m) => {
      const switchId = attributeEndpointToSiteSwitch(m, attribution);
      return {
        id:         m.id,
        hostname:   m.hostname,
        ipAddress:  m.ipAddress,
        macAddress: m.macAddress,
        assetType:  String(m.assetType),
        assignedTo: m.assignedTo,
        switchId,
        // The RESOLVED switch's name — the same string as the stamp except
        // when two sites share it, where this is the one the device sits on.
        switchHostname: switchId ? (switchHostById.get(switchId) ?? null) : null,
        port: portOfLastSeenSwitch(m.lastSeenSwitch),
        lastSeen:   m.lastSeen,
      };
    });
    res.json({ q, results });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /map/sites/:id/topology/layout ─────────────────────────────────────────
// Full-replace save of one (site, view) shared topology layout. Debounced by
// the client per drag session, so volume is low; every save is audited. Gated
// deviceMap=write — reads stay open (the layout rides the topology GET above)
// so readonly viewers see the shared map without being able to move it.
router.put("/sites/:id/topology/layout", requirePermission("deviceMap", "write"), async (req, res, next) => {
  try {
    const siteId = req.params.id as string;
    const input = SaveLayoutSchema.parse(req.body);
    const positions = sanitizePositions(input.positions);
    const actor = req.session?.username ?? null;
    const saved = await saveLayout(siteId, input.view, positions, actor);
    logEvent({
      action: "map.topology.layout_saved",
      resourceType: "asset",
      resourceId: siteId,
      actor: req.session?.username,
      message: `Topology layout saved (view "${input.view}", ${Object.keys(positions).length} node${Object.keys(positions).length === 1 ? "" : "s"})`,
      details: { view: input.view, nodeCount: Object.keys(positions).length },
    });
    res.json(saved);
  } catch (err) {
    next(err);
  }
});

// ─── POST /map/sites/:id/topology/layout/checkpoint ────────────────────────────
// Stamp the operator's restore point for one (site, view) — the explicit Save
// behind "Reset to last save". Same body as the PUT above; it writes the live
// layout AND `savedPositions` in one statement, so the checkpoint can never be
// of a layout the server has not stored. Declared before the DELETE for
// readability only — no path capture is in play.
router.post("/sites/:id/topology/layout/checkpoint", requirePermission("deviceMap", "write"), async (req, res, next) => {
  try {
    const siteId = req.params.id as string;
    const input = SaveLayoutSchema.parse(req.body);
    const positions = sanitizePositions(input.positions);
    const actor = req.session?.username ?? null;
    const saved = await saveCheckpoint(siteId, input.view, positions, actor);
    const nodeCount = Object.keys(positions).length;
    logEvent({
      action: "map.topology.layout_checkpointed",
      resourceType: "asset",
      resourceId: siteId,
      actor: req.session?.username,
      message: `Topology layout saved as a restore point (view "${input.view}", ${nodeCount} node${nodeCount === 1 ? "" : "s"})`,
      details: { view: input.view, nodeCount },
    });
    res.json(saved);
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /map/sites/:id/topology/layout?view=<key> ───────────────────────────
// Reset one (site, view) layout back to the column solver's baseline — the
// server half of "Reset to baseline". A row carrying a restore point is
// emptied rather than deleted so the operator can still go back to their last
// save; one without is removed. Idempotent 204 so the client's reset flow is
// unconditional.
router.delete("/sites/:id/topology/layout", requirePermission("deviceMap", "write"), async (req, res, next) => {
  try {
    const siteId = req.params.id as string;
    const view = String(req.query.view ?? "");
    if (!isValidViewKey(view)) throw new AppError(400, "Invalid or missing view key");
    const result = await resetLayout(siteId, view);
    if (result.changed) {
      logEvent({
        action: "map.topology.layout_reset",
        resourceType: "asset",
        resourceId: siteId,
        actor: req.session?.username,
        message: `Topology layout reset to baseline (view "${view}")`
          + (result.checkpointKept ? " — the saved restore point was kept" : ""),
        details: { view, checkpointKept: result.checkpointKept },
      });
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;

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
 *   GET /map/sites/:id/topology/views — the site's saved views (rule 147)
 *   GET /map/sites/:id/topology/views/:viewId/mode-change — what a mode change would remove
 *   GET /map/sites/:id/topology/background/:imageId — an uploaded view background
 *   GET /map/satellite          — whether the operator configured satellite imagery
 *   GET /map/satellite/:z/:x/:y — one satellite tile, proxied (satelliteTileService)
 *
 * Write endpoints (escalate to deviceMap=write per-route):
 *   PUT    /map/sites/:id/topology/layout — full-replace one (site, view) layout
 *   POST   /map/sites/:id/topology/layout/checkpoint — stamp the restore point
 *   DELETE /map/sites/:id/topology/layout?view=<key> — reset one view's layout
 *   POST   /map/sites/:id/topology/views — create a view
 *   PUT    /map/sites/:id/topology/views/:viewId — update a view (a mode change resets it, rule 149)
 *   DELETE /map/sites/:id/topology/views/:viewId — delete a view
 *   POST   /map/sites/:id/topology/views/:viewId/background — upload a background image
 *   POST   /map/sites/:id/topology/location-codes — rewrite descriptions from
 *          polygon placements (rule 148; assets=write + the assets write scope, not deviceMap)
 *
 * Cable runs (rule 184) ride their OWN key, never deviceMap — a run is written
 * one way to an ArcGIS layer:
 *   GET /map/sites/:id/cable-runs — the site's runs (cableRuns=read) + canEditRuns
 *   PUT /map/sites/:id/cable-runs — one edit session's upserts + deletes
 *          (cableRuns=write + the cableRuns write scope on the site)
 *
 * Coordinates and topology metadata are populated by the FortiManager / FortiGate
 * discovery pipelines (see fortimanagerService.ts step 3d.5/3d.6 and
 * fortigateService.ts step 3e.5/3e.6). The topology GET's graph construction
 * (edges from the `fortinetTopology` JSON field, LLDP/interface/MCLAG
 * inference) lives in services/topologyGraphService.ts — nothing here queries
 * a live device.
 */

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import { buildSiteTopology } from "../../services/topologyGraphService.js";
import { listMapSites, getSiteLayoutOwner, searchSiteEndpoints } from "../../services/mapSitesService.js";
import { listRuns, applyRunEdits, CABLE_MEDIA, CABLE_PLACEMENTS } from "../../services/cableRunService.js";
import { getRegionHierarchy } from "../../services/mapRegionService.js";
import {
  saveLayout,
  saveCheckpoint,
  resetLayout,
  sanitizePositions,
  isValidViewKey,
  MAX_LAYOUT_NODES,
  MAX_VIEW_KEY_LEN,
} from "../../services/topologyLayoutService.js";
import {
  listViews,
  createView,
  updateView,
  deleteView,
  describeModeChangeLoss,
  saveBackgroundImage,
  getBackgroundImage,
  sanitizeLocationCodeChanges,
  applyLocationCodeChanges,
  regionViewsForSite,
  MAX_BACKGROUND_IMAGE_BYTES,
} from "../../services/topologyViewService.js";
import multer from "multer";
import {
  listRegionNodes,
  createRegionNode,
  buildFromDescriptions,
  updateRegionNode,
  mergeRegionNodes,
  deleteRegionNode,
  loadRegionIndex,
  resolveLocation,
  siteForAsset,
} from "../../services/regionTreeService.js";
import { hasLocationCodes, parseLocationCodes, type LocationCodes } from "../../utils/locationCodes.js";
import type { PlaceableDevice } from "../../utils/regionAutoPlace.js";
import { getSatelliteStatus, getSatelliteTile } from "../../services/satelliteTileService.js";
import { logEvent } from "./events.js";
import { requirePermission } from "../middleware/permissions.js";
import { resolveWriteScope, inWriteScope } from "../../services/writeScopeService.js";
import { scopeAssetParam } from "../middleware/writeScope.js";

const router = Router();

// Shared topology-layout write bodies. View keys are "flat" or the
// computeFloorViews building/floor keys ("b|…" / "f|…"); positions is the
// { nodeId: {x,y} } blob map.js saves — re-validated in depth by
// sanitizePositions (finite coords, node cap) at the service seam.
const ViewKeySchema = z
  .string()
  .max(MAX_VIEW_KEY_LEN)
  .refine(isValidViewKey, 'view must be "flat" or a location-view key (a| / b| / f| / r| / jb|)');

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
          containerIds: node?.containerIds ?? [],
          // True when an operator chose this parent (drag-to-nest) rather than
          // automatic nesting picking the smallest container.
          nestChosen: !!r.nestUnderId && node?.parentId === r.nestUnderId,
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
    const sites = await listMapSites(regionNames);
    // Rule 141 (e): may THIS caller save the site's topology layout?
    const layoutScope = await resolveWriteScope(req, "deviceMap");
    res.json(sites.map((s) => ({
      canEditLayout: inWriteScope(layoutScope, { createdBy: s.createdBy, tags: s.tags }),
      ...s,
    })));
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
    // Rule 141 (e): whether THIS caller may save the site's layout rides with
    // the topology, so the page need not cross-reference the sites list.
    const [topo, site] = await Promise.all([
      buildSiteTopology(req.params.id),
      getSiteLayoutOwner(req.params.id as string),
    ]);
    const canEditLayout = site ? inWriteScope(await resolveWriteScope(req, "deviceMap"), site) : false;
    // Rule 147: the site's saved views ride along (buildSiteTopology has
    // already 404ed a non-firewall id, so the default view is never
    // materialised for one).
    const views = await listViews(req.params.id as string);
    res.json({ ...(topo as object), canEditLayout, views });
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

    res.json(await searchSiteEndpoints(id, q));
  } catch (err) {
    next(err);
  }
});

// ─── PUT /map/sites/:id/topology/layout ─────────────────────────────────────────
// Full-replace save of one (site, view) shared topology layout. Debounced by
// the client per drag session, so volume is low; every save is audited. Gated
// deviceMap=write — reads stay open (the layout rides the topology GET above)
// so readonly viewers see the shared map without being able to move it.
router.put("/sites/:id/topology/layout", requirePermission("deviceMap", "write"), scopeAssetParam("deviceMap", "save topology layouts for sites"), async (req, res, next) => {
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
router.post("/sites/:id/topology/layout/checkpoint", requirePermission("deviceMap", "write"), scopeAssetParam("deviceMap", "save topology layouts for sites"), async (req, res, next) => {
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
router.delete("/sites/:id/topology/layout", requirePermission("deviceMap", "write"), scopeAssetParam("deviceMap", "save topology layouts for sites"), async (req, res, next) => {
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

// ─── Saved topology views (business rules 147-149) ──────────────────────────────
// A view is name + ONE mode + shown device types + mode-specific content.
// The service validates every field in depth (sanitize*); the Zod schemas
// here only check the outer shape so a malformed body fails fast.
const CreateViewSchema = z.object({
  name: z.string().min(1).max(200),
  mode: z.enum(["layer2", "topology", "room"]),
  shownTypes: z.array(z.string()).max(100).optional(),
  // Room only (rules 150, 156): the room the view stands for.
  region: z.unknown().optional(),
  // Room: an opening junction box's size in inches and / or an opening rack's size in U.
  wallWidth: z.number().int().optional(),
  wallHeight: z.number().int().optional(),
  rackUnits: z.number().int().optional(),
  // Room with a region: false skips the fill from existing codes (rule 150(a)).
  fill: z.boolean().optional(),
});

const UpdateViewSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  mode: z.enum(["layer2", "topology", "room"]).optional(),
  shownTypes: z.array(z.string()).max(100).optional(),
  background: z.unknown().optional(),
  polygons: z.array(z.unknown()).optional(),
  racks: z.array(z.unknown()).optional(),
  rackPlacements: z.array(z.unknown()).optional(),
  region: z.unknown().optional(),
  walls: z.array(z.unknown()).optional(),
  wallPlacements: z.array(z.unknown()).optional(),
  layers: z.array(z.unknown()).optional(),
  // Rule 179: a Room view's hand-routed cables.
  cableRoutes: z.record(z.string(), z.unknown()).optional(),
}).refine((b) => Object.keys(b).length > 0, "Nothing to update");

const LocationCodesSchema = z.object({ changes: z.array(z.unknown()).min(1).max(500) });

const viewWriteGate = [
  requirePermission("deviceMap", "write"),
  scopeAssetParam("deviceMap", "edit topology views for sites"),
];

router.get("/sites/:id/topology/views", async (req, res, next) => {
  try {
    res.json(await listViews(req.params.id as string));
  } catch (err) {
    next(err);
  }
});

router.post("/sites/:id/topology/views", ...viewWriteGate, async (req, res, next) => {
  try {
    const siteId = req.params.id as string;
    const input = CreateViewSchema.parse(req.body);
    // Rule 150(a): a view made for a region is filled with the devices already in it.
    const devices = input.region ? await siteDevicesPlaceable(siteId) : [];
    const { view, autoPlaced } = await createView(siteId, input, req.session?.username ?? null, devices);
    logEvent({
      action: "map.topology.view_created",
      resourceType: "asset",
      resourceId: siteId,
      actor: req.session?.username,
      message: `Topology view "${view.name}" created (${view.mode})` +
        (autoPlaced.placed.length ? `, ${autoPlaced.placed.length} device${autoPlaced.placed.length === 1 ? "" : "s"} placed from its region` : ""),
      details: { viewId: view.id, name: view.name, mode: view.mode, autoPlaced },
    });
    res.status(201).json({ ...view, autoPlaced });
  } catch (err) {
    next(err);
  }
});

router.get("/sites/:id/topology/views/:viewId/mode-change", async (req, res, next) => {
  try {
    res.json(await describeModeChangeLoss(req.params.id as string, req.params.viewId as string));
  } catch (err) {
    next(err);
  }
});

router.put("/sites/:id/topology/views/:viewId", ...viewWriteGate, async (req, res, next) => {
  try {
    const siteId = req.params.id as string;
    const input = UpdateViewSchema.parse(req.body);
    // Only a patch that links a region (or resets a view that keeps one) can fill it (rule 150(a)).
    const devices = input.region || input.mode !== undefined ? await siteDevicesPlaceable(siteId) : [];
    const { view, modeChange, autoPlaced } = await updateView(siteId, req.params.viewId as string, input, req.session?.username ?? null, devices);
    if (modeChange) {
      logEvent({
        action: "map.topology.view_mode_changed",
        resourceType: "asset",
        resourceId: siteId,
        actor: req.session?.username,
        level: "warning",
        message: `Topology view "${view.name}" changed from ${modeChange.from} to ${modeChange.to} and reset`,
        details: { viewId: view.id, ...modeChange, autoPlaced },
      });
    } else {
      logEvent({
        action: "map.topology.view_updated",
        resourceType: "asset",
        resourceId: siteId,
        actor: req.session?.username,
        message: `Topology view "${view.name}" saved`,
        details: { viewId: view.id, fields: Object.keys(input), ...(autoPlaced.placed.length || autoPlaced.unplaced.length ? { autoPlaced } : {}) },
      });
    }
    res.json({ view, modeChange, autoPlaced });
  } catch (err) {
    next(err);
  }
});

router.delete("/sites/:id/topology/views/:viewId", ...viewWriteGate, async (req, res, next) => {
  try {
    const siteId = req.params.id as string;
    const view = await deleteView(siteId, req.params.viewId as string);
    logEvent({
      action: "map.topology.view_deleted",
      resourceType: "asset",
      resourceId: siteId,
      actor: req.session?.username,
      message: `Topology view "${view.name}" deleted`,
      details: { viewId: view.id, name: view.name, mode: view.mode },
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ─── The site's region tree (rule 153) ──────────────────────────────────────
// Read on the map router's deviceMap floor; every write is a view edit
// (deviceMap write + the site's write scope). None of them writes a
// description: a rename / move RETURNS the descriptions it would change,
// committed (or not) through POST …/topology/location-codes.

/** Every device of a site with the codes its description WRITES (for build / rewrite). */
async function siteDevicesWritten(siteId: string): Promise<Array<{ assetId: string; name: string; written: LocationCodes | null }>> {
  const t = await buildSiteTopology(siteId);
  const rows = [t.fortigate as unknown].concat(t.switches as unknown[], t.aps as unknown[], t.endpoints as unknown[]) as Array<{
    id: string; hostname?: string | null; ipAddress?: string | null; locationWritten?: LocationCodes | null;
  }>;
  return rows.filter((r) => r && r.id).map((r) => ({ assetId: r.id, name: r.hostname || r.ipAddress || r.id, written: r.locationWritten ?? null }));
}

/** Every device of a site with its location resolved through the tree (rule 150(a) fills). */
async function siteDevicesPlaceable(siteId: string): Promise<PlaceableDevice[]> {
  const t = await buildSiteTopology(siteId);
  const rows = [t.fortigate as unknown].concat(t.switches as unknown[], t.aps as unknown[], t.endpoints as unknown[]) as Array<{
    id: string; hostname?: string | null; ipAddress?: string | null; location?: LocationCodes | null;
  }>;
  return rows.filter((r) => r && r.id).map((r) => ({ assetId: r.id, name: r.hostname || r.ipAddress || r.id, location: r.location ?? null }));
}

const RegionCreateSchema = z.object({
  kind: z.enum(["area", "building", "floor", "room", "rack", "junctionBox"]),
  // A floor's name is optional (its number when blank, rule 168); every other kind needs one.
  name: z.string().max(64).optional(),
  parentId: z.string().guid().nullable().optional(),
  level: z.number().int().nullable().optional(),
});
const RegionUpdateSchema = z.object({
  name: z.string().max(64).optional(),
  parentId: z.string().guid().nullable().optional(),
  level: z.number().int().nullable().optional(),
}).refine((b) => Object.keys(b).length > 0, "Nothing to update");
const RegionMergeSchema = z.object({ into: z.string().guid() });

router.get("/sites/:id/regions", async (req, res, next) => {
  try {
    res.json({ nodes: await listRegionNodes(req.params.id as string) });
  } catch (err) {
    next(err);
  }
});

router.post("/sites/:id/regions/build", ...viewWriteGate, async (req, res, next) => {
  try {
    const siteId = req.params.id as string;
    const devices = await siteDevicesWritten(siteId);
    const result = await buildFromDescriptions(siteId, devices.map((d) => d.written), req.session?.username ?? null);
    logEvent({
      action: "map.region.tree_built",
      resourceType: "asset",
      resourceId: siteId,
      actor: req.session?.username,
      message: `Region tree built from descriptions: ${result.added} region${result.added === 1 ? "" : "s"} added`,
      details: result,
    });
    res.json({ ...result, nodes: await listRegionNodes(siteId) });
  } catch (err) {
    next(err);
  }
});

router.post("/sites/:id/regions", ...viewWriteGate, async (req, res, next) => {
  try {
    const siteId = req.params.id as string;
    const node = await createRegionNode(siteId, RegionCreateSchema.parse(req.body), req.session?.username ?? null);
    logEvent({ action: "map.region.created", resourceType: "asset", resourceId: siteId, actor: req.session?.username,
      message: `Region ${node.kind} "${node.name}" created`, details: { ...node } });
    res.status(201).json({ node });
  } catch (err) {
    next(err);
  }
});

router.put("/sites/:id/regions/:nodeId", ...viewWriteGate, async (req, res, next) => {
  try {
    const siteId = req.params.id as string;
    const patch = RegionUpdateSchema.parse(req.body);
    const devices = await siteDevicesWritten(siteId);
    const result = await updateRegionNode(siteId, req.params.nodeId as string, patch, devices);
    logEvent({ action: "map.region.updated", resourceType: "asset", resourceId: siteId, actor: req.session?.username,
      message: `Region ${result.node.kind} "${result.node.name}" updated (${result.rewrites.length} description${result.rewrites.length === 1 ? "" : "s"} name it)`,
      details: { node: result.node, patch, rewrites: result.rewrites.length, carried: result.carried } });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/sites/:id/regions/:nodeId/merge", ...viewWriteGate, async (req, res, next) => {
  try {
    const siteId = req.params.id as string;
    const { into } = RegionMergeSchema.parse(req.body);
    const devices = await siteDevicesWritten(siteId);
    const result = await mergeRegionNodes(siteId, req.params.nodeId as string, into, devices);
    logEvent({ action: "map.region.merged", resourceType: "asset", resourceId: siteId, actor: req.session?.username,
      message: `Region merged into ${result.node.kind} "${result.node.name}" (${result.rewrites.length} description${result.rewrites.length === 1 ? "" : "s"} name it)`,
      details: { from: req.params.nodeId, into: result.node, rewrites: result.rewrites.length, carried: result.carried } });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Read: resolve descriptions through the site's tree — what the region
// prompt (rule 150) compares, so it asks about the region a short code names.
const RegionResolveSchema = z.object({ descriptions: z.array(z.string().max(1024).nullable()).min(1).max(50) });
router.post("/sites/:id/regions/resolve", async (req, res, next) => {
  try {
    const { descriptions } = RegionResolveSchema.parse(req.body);
    const index = await loadRegionIndex(req.params.id as string);
    res.json({
      results: descriptions.map((d) => {
        const written = parseLocationCodes(d);
        return resolveLocation(index, hasLocationCodes(written) ? written : null);
      }),
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/sites/:id/regions/:nodeId", ...viewWriteGate, async (req, res, next) => {
  try {
    const siteId = req.params.id as string;
    const node = await deleteRegionNode(siteId, req.params.nodeId as string);
    logEvent({ action: "map.region.deleted", resourceType: "asset", resourceId: siteId, actor: req.session?.username,
      message: `Region ${node.kind} "${node.name}" deleted`, details: { ...node } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

const backgroundUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BACKGROUND_IMAGE_BYTES, files: 1 } });

router.post("/sites/:id/topology/views/:viewId/background", ...viewWriteGate, (req, res, next) => {
  backgroundUpload.single("file")(req, res, (err: unknown) => {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === "LIMIT_FILE_SIZE") return next(new AppError(413, `Background images are limited to ${MAX_BACKGROUND_IMAGE_BYTES / (1024 * 1024)} MB`));
    if (err) return next(err);
    next();
  });
}, async (req, res, next) => {
  try {
    const siteId = req.params.id as string;
    if (!req.file) throw new AppError(400, "No image uploaded (form field \"file\")");
    const img = await saveBackgroundImage(siteId, req.params.viewId as string, req.file.buffer, req.session?.username ?? null);
    logEvent({
      action: "map.topology.background_uploaded",
      resourceType: "asset",
      resourceId: siteId,
      actor: req.session?.username,
      message: `Background image uploaded to a topology view (${img.width} × ${img.height})`,
      details: { viewId: img.viewId, imageId: img.id, width: img.width, height: img.height, size: img.size },
    });
    res.status(201).json(img);
  } catch (err) {
    next(err);
  }
});

// Authenticated only (the /map mount's deviceMap=read floor) — never the
// unauthenticated /uploads static mount. An image id is immutable, so the
// browser may cache it privately.
router.get("/sites/:id/topology/background/:imageId", async (req, res, next) => {
  try {
    const img = await getBackgroundImage(req.params.id as string, req.params.imageId as string);
    res.setHeader("Content-Type", img.mimeType);
    res.setHeader("Content-Length", String(img.data.length));
    res.setHeader("Cache-Control", "private, max-age=86400, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(img.data);
  } catch (err) {
    next(err);
  }
});

// Rule 150: the description-save prompt asks which site an asset belongs to
// and which of that site's Rack / Wall views already stand for which region.
// Read-only (the map router's deviceMap read floor); creating or mapping a
// view goes through the usual write-gated view routes.
router.get("/assets/:id/region-views", async (req, res, next) => {
  try {
    const siteId = await siteForAsset(req.params.id as string);
    res.json({ siteId, views: siteId ? await regionViewsForSite(siteId) : [] });
  } catch (err) {
    next(err);
  }
});

// The optional satellite basemap — an ArcGIS integration's when its basemap is
// on, else Server Settings → Customization (rule 183). Status is all a viewer
// learns — never the provider URL or key; the tiles come back through Polaris
// so the CSP keeps its one tile host.
router.get("/satellite", async (_req, res, next) => {
  try {
    res.json(await getSatelliteStatus());
  } catch (err) {
    next(err);
  }
});

const SatelliteTileParams = z.object({
  z: z.coerce.number().int(),
  x: z.coerce.number().int(),
  y: z.coerce.number().int(),
});

router.get("/satellite/:z/:x/:y", async (req, res, next) => {
  try {
    const p = SatelliteTileParams.safeParse(req.params);
    if (!p.success) throw new AppError(400, "Invalid satellite tile request");
    const tile = await getSatelliteTile(p.data.z, p.data.x, p.data.y);
    res.setHeader("Content-Type", tile.contentType);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(tile.body);
  } catch (err) {
    next(err);
  }
});

// Rule 148: the asset half of saving a Topology view. Gated assets=write (a
// description is an asset field), and each asset is checked against the
// caller's assets write scope inside the service — a refusal is reported per
// asset, the rest still land.
router.post("/sites/:id/topology/location-codes", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const input = LocationCodesSchema.parse(req.body);
    const changes = sanitizeLocationCodeChanges(input.changes);
    const scope = await resolveWriteScope(req, "assets");
    const results = await applyLocationCodeChanges(changes, {
      actor: req.session?.username ?? null,
      inScope: (rec) => inWriteScope(scope, rec),
    });
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// ─── Cable runs (rule 184) ───────────────────────────────────────────────
// Their own key: a run is written one way to an ArcGIS layer, so drawing one
// is a grant an admin gives, never a rung of deviceMap. Schemas are shapes
// only; cableRunService validates the points and the trench rule.
const CableRunInputSchema = z.object({
  id:        z.string().uuid().optional(),
  name:      z.string().max(120).optional(),
  medium:    z.enum(CABLE_MEDIA),
  placement: z.enum(CABLE_PLACEMENTS),
  points:    z.array(z.array(z.number()).max(3)).max(5000),
  notes:     z.string().max(2000).optional(),
});
const CableRunEditsSchema = z.object({
  upserts: z.array(CableRunInputSchema).max(500).optional(),
  deletes: z.array(z.string().uuid()).max(500).optional(),
});

router.get("/sites/:id/cable-runs", requirePermission("cableRuns", "read"), async (req, res, next) => {
  try {
    const siteId = req.params.id as string;
    const [runs, site] = await Promise.all([listRuns(siteId), getSiteLayoutOwner(siteId)]);
    // Whether THIS caller may edit the site's runs rides along (rule 141 (e)).
    const canEditRuns = site ? inWriteScope(await resolveWriteScope(req, "cableRuns"), site) : false;
    res.json({ runs, canEditRuns });
  } catch (err) {
    next(err);
  }
});

router.put(
  "/sites/:id/cable-runs",
  requirePermission("cableRuns", "write"),
  scopeAssetParam("cableRuns", "edit cable runs for sites"),
  async (req, res, next) => {
    try {
      const body = CableRunEditsSchema.parse(req.body);
      const runs = await applyRunEdits(req.params.id as string, body, req.session?.username ?? "unknown");
      res.json({ runs });
    } catch (err) {
      next(err);
    }
  },
);

export default router;

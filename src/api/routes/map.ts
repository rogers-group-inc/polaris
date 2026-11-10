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
  MAX_BACKGROUND_IMAGE_BYTES,
} from "../../services/topologyViewService.js";
import multer from "multer";
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
  mode: z.enum(["layer2", "topology", "rack"]),
  shownTypes: z.array(z.string()).max(100).optional(),
});

const UpdateViewSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  mode: z.enum(["layer2", "topology", "rack"]).optional(),
  shownTypes: z.array(z.string()).max(100).optional(),
  background: z.unknown().optional(),
  polygons: z.array(z.unknown()).optional(),
  racks: z.array(z.unknown()).optional(),
  rackPlacements: z.array(z.unknown()).optional(),
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
    const view = await createView(siteId, input, req.session?.username ?? null);
    logEvent({
      action: "map.topology.view_created",
      resourceType: "asset",
      resourceId: siteId,
      actor: req.session?.username,
      message: `Topology view "${view.name}" created (${view.mode})`,
      details: { viewId: view.id, name: view.name, mode: view.mode },
    });
    res.status(201).json(view);
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
    const { view, modeChange } = await updateView(siteId, req.params.viewId as string, input, req.session?.username ?? null);
    if (modeChange) {
      logEvent({
        action: "map.topology.view_mode_changed",
        resourceType: "asset",
        resourceId: siteId,
        actor: req.session?.username,
        level: "warning",
        message: `Topology view "${view.name}" changed from ${modeChange.from} to ${modeChange.to} and reset`,
        details: { viewId: view.id, ...modeChange },
      });
    } else {
      logEvent({
        action: "map.topology.view_updated",
        resourceType: "asset",
        resourceId: siteId,
        actor: req.session?.username,
        message: `Topology view "${view.name}" saved`,
        details: { viewId: view.id, fields: Object.keys(input) },
      });
    }
    res.json({ view, modeChange });
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

export default router;

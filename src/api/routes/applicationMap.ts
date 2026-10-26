/**
 * src/api/routes/applicationMap.ts
 *
 * The Application Map page's API: the connectivity graph built from mapped-
 * process connection facts (AssetProcessConnection), the shared drag layout
 * (ApplicationMapLayout — the appmap counterpart of TopologyLayout), and the
 * Discovery surface (named MAP RULES: an asset scope plus the process/service
 * items to pin on the assets it selects, now and as they're discovered).
 *
 * Gates: `applicationMap=read` to view the graph, `applicationMap=write`
 * to save/reset the shared layout. The Discovery WRITES additionally require
 * `assets=write`, because what they change is per-asset pin arrays
 * (Asset.mappedProcesses / mappedServices) — the same fields the assets PUT
 * guards. The per-asset connections read used by the process detail panel lives
 * on /assets/:id/process-connections (assets=read) — it's asset detail, not the map.
 */

import { Router } from "express";
import { z } from "zod";
import {
  buildApplicationMapGraph,
  saveAppMapLayout,
  deleteAppMapLayout,
} from "../../services/applicationMapService.js";
import {
  getConfig,
  saveConfig,
  normalizeConfig,
  normalizeRule,
  getInventoryAggregate,
  previewRule,
  previewScope,
  applyRules,
  unmapEverywhere,
  resolveRuleAssetLabels,
  normalizeScope,
  PROCESS_CAPABLE_ASSET_TYPES,
} from "../../services/appMapDiscoveryService.js";
import { listAssetTags } from "../../services/tagAssignmentService.js";
import { DEVICE_FILTER_FIELD_OPS, scopeConditionMeta } from "../../services/notificationTypes.js";
import { listScopeOptions } from "../../services/notificationRuleService.js";
import { listAssetTypes } from "../../services/assetTypeService.js";
import { logEvent } from "./events.js";
import { requirePermission } from "../middleware/permissions.js";
import { requestActor } from "../middleware/auth.js";

const router = Router();

// GET /application-map — the full graph payload (nodes, edges, savedLayout, stats).
router.get("/", requirePermission("applicationMap", "read"), async (_req, res, next) => {
  try {
    res.json(await buildApplicationMapGraph());
  } catch (err) {
    next(err);
  }
});

const LayoutPutSchema = z.object({
  view: z.string().min(1).max(64).default("global"),
  // Shape-validated by sanitizePositions inside the service (same validator
  // as the Device Map topology layout).
  positions: z.unknown(),
});

// PUT /application-map/layout — full-replace the shared layout (last-write-wins).
router.put("/layout", requirePermission("applicationMap", "write"), async (req, res, next) => {
  try {
    const input = LayoutPutSchema.parse(req.body ?? {});
    const dto = await saveAppMapLayout(input.view, input.positions, requestActor(req) ?? null);
    logEvent({
      action: "application_map.layout.saved",
      resourceType: "application_map",
      resourceId: dto.view,
      actor: requestActor(req),
      message: `Application Map layout "${dto.view}" saved (${Object.keys(dto.positions).length} nodes)`,
    });
    res.json(dto);
  } catch (err) {
    next(err);
  }
});

// DELETE /application-map/layout?view=global — reset to the computed layout.
router.delete("/layout", requirePermission("applicationMap", "write"), async (req, res, next) => {
  try {
    const view = typeof req.query.view === "string" && req.query.view ? req.query.view : "global";
    const removed = await deleteAppMapLayout(view);
    if (removed) {
      logEvent({
        action: "application_map.layout.reset",
        resourceType: "application_map",
        resourceId: view,
        actor: requestActor(req),
        message: `Application Map layout "${view}" reset`,
      });
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ─── Discovery: named map rules ─────────────────────────────────────────────
//
// The write gates are chained: `applicationMap=write` says "you may curate this
// map", `assets=write` says "you may change asset pin fields". Both are required
// because the write does both.
const requireDiscoveryWrite = [
  requirePermission("applicationMap", "write"),
  requirePermission("assets", "write"),
];

// GET /application-map/discovery — the stored rule set, plus the asset types a
// rule can meaningfully target. The client uses that list to constrain its
// asset-type picker instead of keeping a second copy of the constant in sync.
// assetLabels resolves every rule's explicit assetIds to hostnames so the list
// can render "which assets" for auto rules without a per-rule round-trip.
router.get("/discovery", requirePermission("applicationMap", "read"), async (_req, res, next) => {
  try {
    const cfg = await getConfig();
    const assetLabels = await resolveRuleAssetLabels(cfg);
    res.json({ ...cfg, assetLabels, processCapableAssetTypes: [...PROCESS_CAPABLE_ASSET_TYPES] });
  } catch (err) {
    next(err);
  }
});

// GET /application-map/discovery/filter-schema — the Devices step's condition-
// builder vocabulary + value suggestions. Its own route (the contacts /
// filter-schema precedent) so the wizard never needs automationManagement:read
// or assets:read for its pickers. The WIDE device-filter field set, because the
// flat builder it replaced already offered osVersion / department / location /
// fortigate and the wildcard operator.
router.get("/discovery/filter-schema", requirePermission("applicationMap", "read"), async (_req, res, next) => {
  try {
    const [options, assetTypes, tags] = await Promise.all([listScopeOptions(), listAssetTypes(), listAssetTags()]);
    res.json({
      scopeCondition: scopeConditionMeta(DEVICE_FILTER_FIELD_OPS),
      options: {
        ...options,
        assetTypes: assetTypes.map((t) => ({ name: t.name, label: t.label || t.name })),
        tags,
      },
    });
  } catch (err) {
    next(err);
  }
});

const ScopeBodySchema = z.object({
  scope: z.unknown().optional(),
  // Explicit asset targets (auto rules carry them) so the wizard's device
  // preview can show scope ∪ assetIds — the set the rule actually targets.
  assetIds: z.array(z.string().min(1).max(64)).max(1000).optional(),
});

// POST /application-map/discovery/scope-preview — which assets a scope selects.
// Backs the wizard's asset-selection step so the operator can see they picked the
// hosts they meant before choosing items.
router.post("/discovery/scope-preview", requirePermission("applicationMap", "read"), async (req, res, next) => {
  try {
    const body = ScopeBodySchema.parse(req.body ?? {});
    const scope = normalizeScope(body.scope);
    res.json(await previewScope(scope, body.assetIds ?? []));
  } catch (err) {
    next(err);
  }
});

// POST /application-map/discovery/inventory — the programs / units reported by the
// assets a scope selects. This is what makes the picker granular: it lists what
// THOSE hosts run, not the whole fleet's inventory.
router.post("/discovery/inventory", requirePermission("applicationMap", "read"), async (req, res, next) => {
  try {
    const body = ScopeBodySchema.parse(req.body ?? {});
    const scope = normalizeScope(body.scope);
    res.json(await getInventoryAggregate(scope));
  } catch (err) {
    next(err);
  }
});

// POST /application-map/discovery/preview — dry run for ONE rule; writes nothing.
// Read-gated because it only reports what the rule WOULD pin.
router.post("/discovery/preview", requirePermission("applicationMap", "read"), async (req, res, next) => {
  try {
    const rule = normalizeRule((req.body ?? {}).rule);
    res.json(await previewRule(rule));
  } catch (err) {
    next(err);
  }
});

// PUT /application-map/discovery — persist the rule set and apply it inline, so
// the operator sees pins land immediately instead of waiting for the reconcile
// tick. The tick is what covers assets discovered later.
router.put("/discovery", ...requireDiscoveryWrite, async (req, res, next) => {
  try {
    const cfg = normalizeConfig(req.body ?? {});
    await saveConfig(cfg);
    const actor = requestActor(req);
    logEvent({
      action: "application_map.automap.saved",
      resourceType: "application_map",
      resourceId: "discovery",
      actor,
      message: `Application Map map rules saved (${cfg.rules.length} rule(s), ${cfg.rules.filter((r) => r.enabled).length} enabled)`,
      details: { rules: cfg.rules } as any,
    });
    const applied = await applyRules(cfg.rules);
    if (applied.devices > 0) {
      logEvent({
        action: "application_map.automap.applied",
        resourceType: "application_map",
        resourceId: "discovery",
        actor,
        message:
          `Discovery rules pinned ${applied.processPins} process(es) + ${applied.servicePins} service(s) ` +
          `across ${applied.devices} device(s)`,
        details: applied as any,
      });
    }
    // Same shape as the GET so the list can re-render from either response.
    const assetLabels = await resolveRuleAssetLabels(cfg);
    res.json({ ...cfg, assetLabels, applied });
  } catch (err) {
    next(err);
  }
});

const UnmapSchema = z.object({
  kind: z.enum(["process", "service"]),
  name: z.string().min(1).max(256),
});

// POST /application-map/discovery/unmap — the explicit subtractive action. Apply
// is additive by design, so removing something from every host has to be asked
// for separately.
router.post("/discovery/unmap", ...requireDiscoveryWrite, async (req, res, next) => {
  try {
    const input = UnmapSchema.parse(req.body ?? {});
    const result = await unmapEverywhere(input.kind, input.name);
    logEvent({
      action: "application_map.automap.unmapped",
      resourceType: "application_map",
      resourceId: "discovery",
      actor: requestActor(req),
      message:
        `Un-mapped ${input.kind} "${input.name}" from ${result.devices} device(s) ` +
        `(${result.connectionRowsDeleted} connection row(s) deleted)`,
      details: { ...result, kind: input.kind, name: input.name } as any,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;

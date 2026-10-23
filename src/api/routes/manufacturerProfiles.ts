/**
 * src/api/routes/manufacturerProfiles.ts
 *
 * CRUD endpoints for the editable Manufacturer Profile model. Mounted at
 * `/server-settings/manufacturer-profiles`. Reads open to admin OR
 * assets-admin (same precedent as the MIB Database routes); writes
 * admin-only.
 *
 * The monitoring path doesn't consume these rows yet — the resolver swap
 * lands in a follow-up commit. This module owns the operator-editable
 * surface: list profiles, get one full profile, create, set the profile's
 * "also applies when" match pattern, edit metric row defaults, manage the
 * scoped rows under each metric (a device-type default, a per-model
 * exception, or both), manage custom widgets.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { requirePermission } from "../middleware/permissions.js";
import {
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile,
  updateMetricRow, createOverride, updateOverride, deleteOverride,
  createWidget, updateWidget, deleteWidget, listManufacturerSuggestions,
  symbolWarningsForProfile, setWidgetLayout,
} from "../../services/manufacturerProfileService.js";
import {
  TRANSFORM_KINDS,
  TRANSFORM_LABELS,
  COMBINER_KINDS,
  COMBINER_LABELS,
  METRIC_ROW_TRANSFORMS,
} from "../../utils/symbolTransforms.js";
import { requestActor } from "../middleware/auth.js";
import { logEvent } from "./events.js";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import { listWidgetCandidates, setWidgetAssets } from "../../services/customWidgetEnablementService.js";
import { exportProfile, previewProfileImport, applyProfileImport, saveProfileCode } from "../../services/manufacturerProfilePortabilityService.js";

// PUT /:id/widgets/:widgetId/assets (business rule 130). Bounded so one call
// cannot carry an unbounded id list.
const WidgetAssetsSchema = z.object({
  enable:  z.array(z.string().min(1)).max(5000).optional(),
  disable: z.array(z.string().min(1)).max(5000).optional(),
});

// POST /import/preview and /import. The file itself is validated by the
// service's ProfileFileSchema (one readable error); here only the envelope.
const ImportPreviewSchema = z.object({ file: z.unknown() });
const ImportApplySchema = z.object({
  file:  z.unknown(),
  items: z.array(z.string().min(1).max(200)).max(2000),
});

// PUT /:id/widget-layout. Shape-checked here, then sanitized against the
// profile's own widgets in the service (unknown ids dropped).
const WidgetLayoutSchema = z.object({
  layout: z.object({
    version: z.literal(1),
    columns: z.array(z.object({
      id:      z.string().min(1).max(64),
      width:   z.union([z.literal(3), z.literal(4), z.literal(6), z.literal(12)]),
      widgets: z.array(z.object({
        id:     z.string().min(1).max(64),
        height: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      })).max(500),
    })).max(48),
  }).nullable(),
});

const router: Router = Router();

function send(res: Response, body: unknown, status = 200): void {
  res.status(status).json(body);
}

// An override row's scope in one phrase, for the audit Event. Since Phase 4
// a row keys on a device type, a model pattern, or both, so `modelPattern`
// alone is nullable and would log a bare `null` on a device-type default.
function scopeLabel(o: { assetType: string | null; modelPattern: string | null }): string {
  if (o.assetType && o.modelPattern) return `${o.assetType} / ${o.modelPattern}`;
  if (o.assetType) return `${o.assetType} default`;
  return String(o.modelPattern);
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try { await fn(req, res); } catch (err) { next(err); }
  };
}

// GET / — list every profile (summary view).
router.get("/", requirePermission("manufacturerProfiles", "read"), handle(async (_req, res) => {
  const profiles = await listProfiles();
  send(res, {
    profiles,
    transforms: TRANSFORM_KINDS.map((k) => ({ kind: k, label: TRANSFORM_LABELS[k] })),
    combiners:  COMBINER_KINDS.map((k) => ({ kind: k, label: COMBINER_LABELS[k] })),
    // metricKey → the unary transforms a SCALAR metric row of that key may
    // carry. `transforms` above is the widget list; a metric row offers only
    // this subset, and no select at all where its metric is absent.
    metricTransforms: METRIC_ROW_TRANSFORMS,
  });
}));

// GET /suggestions — typeahead values for the "+ Add Manufacturer" box:
// manufacturers already present on assets + the canonical spellings from MAC &
// Vendor Identification (aliases + OUI overrides), minus the ones that already
// have a profile. Declared BEFORE /:id so the literal path isn't captured.
router.get("/suggestions", requirePermission("manufacturerProfiles", "read"), handle(async (_req, res) => {
  send(res, { suggestions: await listManufacturerSuggestions() });
}));

// GET /:id — full profile (metrics + overrides + custom widgets).
router.get("/:id", requirePermission("manufacturerProfiles", "read"), handle(async (req, res) => {
  const profile = await getProfile(String(req.params.id));
  if (!profile) return send(res, { error: "Profile not found" }, 404);
  send(res, { profile });
}));

// POST / — create a new profile. Body: { manufacturer }.
router.post("/", requirePermission("manufacturerProfiles", "write"), handle(async (req, res) => {
  const { manufacturer } = (req.body || {}) as { manufacturer?: string };
  if (!manufacturer || typeof manufacturer !== "string") {
    return send(res, { error: "manufacturer is required" }, 400);
  }
  const profile = await createProfile({ manufacturer, createdBy: requestActor(req) ?? null });
  logEvent({
    action: "manufacturer_profile.created",
    resourceType: "manufacturer_profile",
    resourceId: profile.id,
    resourceName: profile.manufacturer,
    actor: requestActor(req),
    message: `Manufacturer profile "${profile.manufacturer}" created`,
  });
  send(res, { profile }, 201);
}));

// PUT /:id — profile-level fields. Body: { matchPattern } — the "also
// applies when" regex consulted only when no profile is keyed by an asset's
// canonical manufacturer (alias spellings, OS-only identity, the MIB-pin
// redirect). Null clears it.
router.put("/:id", requirePermission("manufacturerProfiles", "write"), handle(async (req, res) => {
  const body = (req.body || {}) as { matchPattern?: string | null };
  const profile = await updateProfile(String(req.params.id), { matchPattern: body.matchPattern });
  logEvent({
    action: "manufacturer_profile.updated",
    resourceType: "manufacturer_profile",
    resourceId: profile.id,
    resourceName: profile.manufacturer,
    actor: requestActor(req),
    message: `Manufacturer profile "${profile.manufacturer}" match pattern ${profile.matchPattern ? `set to /${profile.matchPattern}/i` : "cleared"}`,
  });
  send(res, { profile });
}));

// PUT /:id/metrics/:metricKey — set the metric row's default symbol(s) +
// mib + type + transform. Body fields: { defaultSymbol, defaultSymbolB,
// defaultMibId, defaultMibStdKey, defaultType, defaultTransform,
// defaultAggregate, defaultLabel, defaultParsePattern, defaultParseTemplate }.
// The service validates that the shape is internally consistent (scalar →
// symbolB null, double_scalar → both symbols required, table → symbolB +
// transform null, empty-row state allowed), that the aggregate is one of
// none|avg|sum, and that the parse fields appear on the `model` row only.
router.put("/:id/metrics/:metricKey", requirePermission("manufacturerProfiles", "write"), handle(async (req, res) => {
  const updated = await updateMetricRow(String(req.params.id), String(req.params.metricKey), req.body || {});
  logEvent({
    action: "manufacturer_profile.metric_updated",
    resourceType: "manufacturer_profile",
    resourceId: String(req.params.id),
    actor: requestActor(req),
    message: `Manufacturer profile metric "${String(req.params.metricKey)}" updated`,
  });
  // A warning, not a refusal (see symbolWarnings): the row saved; the
  // operator may be about to upload the MIB that makes it resolve.
  const warnings = symbolWarningsForProfile(String(req.params.id), [
    { symbol: updated.defaultSymbol,  mibId: updated.defaultMibId },
    { symbol: updated.defaultSymbolB, mibId: updated.defaultMibId },
  ]);
  send(res, { metric: updated, warnings });
}));

// POST /:id/metrics/:metricKey/overrides — add a scoped row under the
// metric. Body fields: { assetType, modelPattern, symbol, symbolB, mibId,
// mibStdKey, type, transform, aggregate, label, parsePattern, parseTemplate,
// order }. Same shape validation as the metric row, plus the scope rule: a
// device type, a model pattern, or both — never neither. A device type with
// no pattern IS that type's default, and a metric may hold only one of those
// per type (409 if one already exists).
router.post("/:id/metrics/:metricKey/overrides", requirePermission("manufacturerProfiles", "write"), handle(async (req, res) => {
  const created = await createOverride(String(req.params.id), String(req.params.metricKey), req.body || {});
  logEvent({
    action: "manufacturer_profile.override_created",
    resourceType: "manufacturer_profile",
    resourceId: String(req.params.id),
    actor: requestActor(req),
    message: `Manufacturer profile override "${scopeLabel(created)}" added for metric "${String(req.params.metricKey)}"`,
  });
  const warnings = symbolWarningsForProfile(String(req.params.id), [
    { symbol: created.symbol,  mibId: created.mibId },
    { symbol: created.symbolB, mibId: created.mibId },
  ]);
  send(res, { override: created, warnings }, 201);
}));

// PUT /:id/metrics/:metricKey/overrides/:overrideId — edit. Scope is
// validated on the EFFECTIVE pair, so clearing the model pattern on a
// type-scoped row promotes it to that type's default (409 if the type
// already has one) and clearing it on an any-type row is refused.
router.put("/:id/metrics/:metricKey/overrides/:overrideId", requirePermission("manufacturerProfiles", "write"), handle(async (req, res) => {
  const updated = await updateOverride(String(req.params.overrideId), req.body || {});
  logEvent({
    action: "manufacturer_profile.override_updated",
    resourceType: "manufacturer_profile",
    resourceId: String(req.params.id),
    actor: requestActor(req),
    message: `Manufacturer profile override "${scopeLabel(updated)}" updated for metric "${String(req.params.metricKey)}"`,
  });
  const warnings = symbolWarningsForProfile(String(req.params.id), [
    { symbol: updated.symbol,  mibId: updated.mibId },
    { symbol: updated.symbolB, mibId: updated.mibId },
  ]);
  send(res, { override: updated, warnings });
}));

// DELETE /:id/metrics/:metricKey/overrides/:overrideId.
router.delete("/:id/metrics/:metricKey/overrides/:overrideId", requirePermission("manufacturerProfiles", "write"), handle(async (req, res) => {
  await deleteOverride(String(req.params.overrideId));
  logEvent({
    action: "manufacturer_profile.override_deleted",
    resourceType: "manufacturer_profile",
    resourceId: String(req.params.id),
    actor: requestActor(req),
    message: `Manufacturer profile override deleted for metric "${String(req.params.metricKey)}"`,
  });
  res.status(204).end();
}));

// POST /:id/widgets — add a custom widget.
router.post("/:id/widgets", requirePermission("manufacturerProfiles", "write"), handle(async (req, res) => {
  const widget = await createWidget(String(req.params.id), { ...(req.body || {}), createdBy: requestActor(req) ?? null });
  logEvent({
    action: "manufacturer_profile.widget_created",
    resourceType: "manufacturer_profile",
    resourceId: String(req.params.id),
    resourceName: widget.name,
    actor: requestActor(req),
    message: `Manufacturer profile custom widget "${widget.name}" created`,
  });
  const warnings = symbolWarningsForProfile(String(req.params.id), [{ symbol: widget.symbol, mibId: widget.mibId }]);
  send(res, { widget, warnings }, 201);
}));

// PUT /:id/widgets/:widgetId.
router.put("/:id/widgets/:widgetId", requirePermission("manufacturerProfiles", "write"), handle(async (req, res) => {
  const widget = await updateWidget(String(req.params.widgetId), req.body || {});
  logEvent({
    action: "manufacturer_profile.widget_updated",
    resourceType: "manufacturer_profile",
    resourceId: String(req.params.id),
    resourceName: widget.name,
    actor: requestActor(req),
    message: `Manufacturer profile custom widget "${widget.name}" updated`,
  });
  const warnings = symbolWarningsForProfile(String(req.params.id), [{ symbol: widget.symbol, mibId: widget.mibId }]);
  send(res, { widget, warnings });
}));

// DELETE /:id/widgets/:widgetId.
router.delete("/:id/widgets/:widgetId", requirePermission("manufacturerProfiles", "write"), handle(async (req, res) => {
  await deleteWidget(String(req.params.widgetId));
  logEvent({
    action: "manufacturer_profile.widget_deleted",
    resourceType: "manufacturer_profile",
    resourceId: String(req.params.id),
    actor: requestActor(req),
    message: "Manufacturer profile custom widget deleted",
  });
  res.status(204).end();
}));

// ── Export / import ──────────────────────────────────────────────────────
// A portable file: MIBs and credentials by NAME, no ids, no secrets, no
// per-asset switches. Import is preview (what each item would do, what it is
// missing) then apply (only the ticked item ids). See
// manufacturerProfilePortabilityService.

// GET /:id/export — download the profile as JSON.
router.get("/:id/export", requirePermission("manufacturerProfiles", "read"), handle(async (req, res) => {
  const file = await exportProfile(String(req.params.id));
  const safe = file.manufacturer.replace(/[^A-Za-z0-9._-]+/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="${safe}.manufacturer-profile.json"`);
  send(res, file);
}));

// GET /:id/code — the View Code JSON: the export format plus each override's
// and widget's row id, so a save edits rows in place.
router.get("/:id/code", requirePermission("manufacturerProfiles", "read"), handle(async (req, res) => {
  send(res, await exportProfile(String(req.params.id), { withIds: true }));
}));

// PUT /:id/code — { file } → make the profile match it (a full replace: rows
// left out are cleared / deleted). Writes manufacturer_profile.code_saved.
router.put("/:id/code", requirePermission("manufacturerProfiles", "write"), handle(async (req, res) => {
  const parsed = ImportPreviewSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, parsed.error.issues.map((e) => e.message).join("; "));
  send(res, await saveProfileCode(String(req.params.id), parsed.data.file, requestActor(req)));
}));

// POST /import/preview — { file } → every importable item, with warnings.
router.post("/import/preview", requirePermission("manufacturerProfiles", "write"), handle(async (req, res) => {
  const parsed = ImportPreviewSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, parsed.error.issues.map((e) => e.message).join("; "));
  send(res, await previewProfileImport(parsed.data.file));
}));

// POST /import — { file, items: [item id] } → per-item outcome. Writes one
// manufacturer_profile.imported Event (service).
router.post("/import", requirePermission("manufacturerProfiles", "write"), handle(async (req, res) => {
  const parsed = ImportApplySchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, parsed.error.issues.map((e) => e.message).join("; "));
  send(res, await applyProfileImport(parsed.data.file, parsed.data.items, requestActor(req)));
}));

// PUT /:id/widget-layout — the Custom MIB tab's arrangement of this profile's
// widgets (the pencil button's save). Shared by every asset under the profile,
// so it is a profile write. `layout: null` restores the default grid.
router.put("/:id/widget-layout", requirePermission("manufacturerProfiles", "write"), handle(async (req, res) => {
  const parsed = WidgetLayoutSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, parsed.error.issues.map((e) => e.message).join("; "));
  const layout = await setWidgetLayout(String(req.params.id), parsed.data.layout);
  logEvent({
    action: "manufacturer_profile.widget_layout_updated",
    resourceType: "manufacturer_profile",
    resourceId: String(req.params.id),
    actor: requestActor(req),
    message: layout
      ? `Custom MIB widget layout saved (${layout.columns.length} column(s))`
      : "Custom MIB widget layout reset to the default grid",
  });
  send(res, { layout });
}));

// GET /:id/widgets/:widgetId/assets — the assets a widget applies to, each with
// whether it is switched on (business rule 130). Lists devices, so it needs
// assets read on top of the profile key.
router.get(
  "/:id/widgets/:widgetId/assets",
  requirePermission("manufacturerProfiles", "read"),
  requirePermission("assets", "read"),
  handle(async (req, res) => {
    const assets = await listWidgetCandidates(String(req.params.id), String(req.params.widgetId));
    send(res, { assets });
  }),
);

// PUT /:id/widgets/:widgetId/assets — switch the widget on for some assets and
// off for others (the "enable on these devices" picker). Changes what Polaris
// asks each device, so it needs assets write too; the service writes one
// asset.custom_widget.* Event per asset changed.
router.put(
  "/:id/widgets/:widgetId/assets",
  requirePermission("manufacturerProfiles", "write"),
  requirePermission("assets", "write"),
  handle(async (req, res) => {
    const parsed = WidgetAssetsSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, parsed.error.issues.map((e) => e.message).join("; "));
    const result = await setWidgetAssets(String(req.params.id), String(req.params.widgetId), parsed.data, requestActor(req));
    send(res, result);
  }),
);

// DELETE /:id — admin only.
router.delete("/:id", requirePermission("manufacturerProfiles", "write"), handle(async (req, res) => {
  const existing = await getProfile(String(req.params.id));
  await deleteProfile(String(req.params.id));
  logEvent({
    action: "manufacturer_profile.deleted",
    resourceType: "manufacturer_profile",
    resourceId: String(req.params.id),
    resourceName: existing?.manufacturer,
    actor: requestActor(req),
    message: existing
      ? `Manufacturer profile "${existing.manufacturer}" deleted`
      : "Manufacturer profile deleted",
  });
  res.status(204).end();
}));

export default router;

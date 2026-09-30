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
  symbolWarningsForProfile,
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

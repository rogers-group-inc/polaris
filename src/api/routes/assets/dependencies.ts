/**
 * src/api/routes/assets/dependencies.ts — Dependency-aware monitoring suppression for one asset: the dependency tree,
 * the operator override, the admin-only dependency test, the connection path.
 * Split out of routes/assets.ts (CQ-B062) and mounted there in order.
 */

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../../utils/errors.js";
import { requirePermission } from "../../middleware/permissions.js";
import { scopeAssetParam } from "../../middleware/writeScope.js";
import { requestActor } from "../../middleware/auth.js";
import { resolveConnectionPath } from "../../../services/connectionPathService.js";
import { getAssetDependencies, setDependencyOverride, clearDependencyOverride, startDependencyTest, clearDependencyTest } from "../../../services/assetDependencyService.js";


const router = Router();

// ─── Dependency-aware monitoring suppression ────────────────────────────────
//
// Three endpoints over `AssetDependencyParent`:
//   GET    /:id/dependencies                — read effective + computed
//                                             parents, layer, suppressed flag
//   PUT    /:id/dependencies/override       — admin: replace source="override"
//                                             rows; empty array = explicit
//                                             "no parents" pin
//   DELETE /:id/dependencies/override       — admin: clear all overrides;
//                                             computed set takes effect
//
// Effective-parents resolution: if any source="override" rows exist for an
// asset, the override set is its effective parents and the computed set is
// ignored. Empty override set is a deliberate pin (asset opts out of
// suppression entirely) and is distinct from "no override at all" — we
// represent it by writing zero override rows but stamping a marker. To keep
// the data model simple we don't use a separate marker column; instead the
// override endpoint is the SOLE way to write "0 overrides" without computed
// fallback. So the resolution rule is "if the operator most recently called
// PUT /override, the override set wins (even if empty)". The DELETE endpoint
// reverts to computed.
//
// Cycles are rejected at write time: walking back through every proposed
// parent's existing parents must never reach the asset itself.

const dependencyOverrideBodySchema = z.object({
  parentAssetIds: z.array(z.string().min(1)).max(20),
});

router.get("/:id/dependencies", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    res.json(await getAssetDependencies(id));
  } catch (err) {
    next(err);
  }
});

router.put("/:id/dependencies/override", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const body = dependencyOverrideBodySchema.parse(req.body);

    res.json(await setDependencyOverride(id, body));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/dependencies/override", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    res.json(await clearDependencyOverride(id));
  } catch (err) {
    next(err);
  }
});

// ─── Dependency Test (admin-only simulation) ────────────────────────────────
//
// Admin-only "simulate this asset going down to see how children react."
// Sets Asset.dependencyTestUntil to a TTL deadline; the dependency reconciler
// then treats the asset as confirmed-down for child suppression evaluation.
// Real probes keep running and updating monitorStatus / lastResponseTimeMs
// normally — this is a what-if overlay, not a probe pause. Auto-expires at
// the deadline; reconciler clears the field and writes
// `asset.dependency_test.expired`. Manual clear via DELETE writes
// `asset.dependency_test.cleared`.
//
// Gated `assetMonitorSettings=fullwrite` — admin-only in every built-in
// role. The simulation can briefly mask a real outage (any monitored child of
// the test target gets marked dependencySuppressed even if it's also
// genuinely failing), so we keep the privilege narrow. It used to sit on
// `assetsProbe=write`, which did NOT deliver that: network-admin,
// assets-admin and even the plain `user` role all hold that level. And when
// `assetsProbe` became a read-only key (a probe writes nothing; this does —
// it stamps `dependencyTestUntil`) there was no level left there to express
// "admin only" at all.

const dependencyTestSchema = z.object({
  durationMinutes: z.number().int().min(1).max(240).default(30),
});

router.post("/:id/dependency-test", requirePermission("assetMonitorSettings", "fullwrite"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const { durationMinutes } = dependencyTestSchema.parse(req.body ?? {});

    res.json(await startDependencyTest(id, durationMinutes, requestActor(req)));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/dependency-test", requirePermission("assetMonitorSettings", "fullwrite"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    res.json(await clearDependencyTest(id, requestActor(req)));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/connection-path — endpoint → switch → … → FortiGate
//
// Returns the upward chain from this asset to its upstream FortiGate, used by
// the Device Map topology overlay to dim everything off-path. See
// connectionPathService for the resolution rules. Open to any authenticated
// caller (read-only; same scope as the existing /:id/dependencies endpoint).
router.get("/:id/connection-path", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const path = await resolveConnectionPath(id);
    if (!path) throw new AppError(404, "Asset not found");
    res.json(path);
  } catch (err) {
    next(err);
  }
});

export default router;

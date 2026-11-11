/**
 * src/api/routes/assets/write.ts — Creating and updating an asset: POST /, PUT /:id (validate, build the patch,
 * apply its side effects) and resetting the monitor override. Split out of
 * routes/assets.ts (CQ-B062) and mounted there in order.
 */

import { Router } from "express";
import { AppError } from "../../../utils/errors.js";
import { requirePermission, credentialUseActor, assertTagChangeAllowed } from "../../middleware/permissions.js";
import { scopeAssetParam } from "../../middleware/writeScope.js";
import { requestActor } from "../../middleware/auth.js";
import { assertIpChangeMayRetargetIntegrationToken } from "./shared.js";
import {
  CreateAssetSchema,
  UpdateAssetSchema,
  validateAssetCreate,
  createAsset,
  loadAssetForUpdate,
  updateAsset,
  resetMonitorOverrideToIntegrationDefault,
} from "../../../services/assetWriteService.js";

const router = Router();

router.post("/", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const input = CreateAssetSchema.parse(req.body);
    validateAssetCreate(input);
    // Nothing to round-trip on a create, so every region tag in the body is an
    // addition and must name a real region — and any tag at all is the Tags
    // key's grant, not this one's.
    assertTagChangeAllowed(req, [], input.tags);
    res.status(201).json(await createAsset(input, requestActor(req), credentialUseActor(req)));
  } catch (err) {
    next(err);
  }
});

router.put("/:id", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await loadAssetForUpdate(id);
    if (!existing) throw new AppError(404, "Asset not found");
    const input = UpdateAssetSchema.parse(req.body);
    assertIpChangeMayRetargetIntegrationToken(req, existing, input.ipAddress);
    assertTagChangeAllowed(req, existing.tags, input.tags);
    res.json(await updateAsset(id, existing, input, requestActor(req), credentialUseActor(req)));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/monitor-override/reset — clear an explicit
// monitor-override pin and realign the asset to its discovering integration's
// per-class Auto-Monitor default. Sets `monitored = <addAsMonitored flag>`
// and `monitorOverride = false`, so discovery resumes auto-managing the asset
// on the next cycle. This is the operator's escape hatch for an asset that
// shows the "Asset Override" badge but shouldn't be pinned.
router.post("/:id/monitor-override/reset", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    res.json(await resetMonitorOverrideToIntegrationDefault(id, requestActor(req)));
  } catch (err) {
    next(err);
  }
});

export default router;

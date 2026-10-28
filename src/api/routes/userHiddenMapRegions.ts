/**
 * src/api/routes/userHiddenMapRegions.ts
 *
 * The caller's OWN hidden map regions — the Device Map Regions panel's eyes.
 *
 *   GET /me/hidden-map-regions → { regionIds }
 *   PUT /me/hidden-map-regions → { regionIds }   (body: { regionIds: string[] })
 *
 * A `/me/*` route, sibling to /me/table-tabs and /me/timezone: strictly
 * per-caller, never addressable for another user, no admin surface.
 *
 * NO `requirePermission` gate — the /me/timezone precedent. Hiding a region
 * changes what this account's map DRAWS, never which data it can reach, so a
 * function-key gate would only stop a signed-in viewer from tidying their own
 * view. The global requireAuth in router.ts is the whole gate.
 *
 * The PUT replaces the whole list (the client holds it all), normalized by
 * the service: unknown or stale ids are kept or dropped silently, never a 400.
 */

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import {
  MAX_HIDDEN_MAP_REGIONS,
  getHiddenMapRegionIds,
  setHiddenMapRegionIds,
} from "../../services/userMapViewService.js";

const router = Router();

const bodySchema = z.object({
  regionIds: z.array(z.string()).max(MAX_HIDDEN_MAP_REGIONS),
});

router.get("/", async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) throw new AppError(401, "Not authenticated");
    res.json({ regionIds: await getHiddenMapRegionIds(userId) });
  } catch (err) {
    next(err);
  }
});

router.put("/", async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) throw new AppError(401, "Not authenticated");
    const { regionIds } = bodySchema.parse(req.body);
    res.json({ regionIds: await setHiddenMapRegionIds(userId, regionIds) });
  } catch (err) {
    next(err);
  }
});

export default router;

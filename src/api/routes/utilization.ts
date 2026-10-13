/**
 * src/api/routes/utilization.ts
 */

import { Router } from "express";
import { hasPermission } from "../middleware/permissions.js";
import * as utilizationService from "../../services/utilizationService.js";

const router = Router();

// GET /utilization — global dashboard summary
router.get("/", async (req, res, next) => {
  try {
    const summary = await utilizationService.getGlobalUtilization();
    // The mount needs only ipBlocks:read; the recent-reservation rows are
    // reservations data, split by key exactly as /dashboard/summary does
    // (business rule 114(f)).
    if (!hasPermission(req, "reservations", "read")) {
      const { recentReservations: _omit, ...blocksOnly } = summary as typeof summary & { recentReservations?: unknown };
      return res.json(blocksOnly);
    }
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// GET /utilization/blocks/:id — per-block breakdown
router.get("/blocks/:id", async (req, res, next) => {
  try {
    const data = await utilizationService.getBlockUtilization(req.params.id);
    if (!data) return res.status(404).json({ error: "Block not found" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;

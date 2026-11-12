/**
 * src/api/routes/userDashboard.ts
 *
 * Per-user dashboard layout persistence. Mounted at /api/v1/me/dashboard
 * (after the global requireAuth in router.ts). No admin override —
 * layouts are strictly per-caller. No Event audit log — this is UI
 * preference, not security-relevant.
 *
 * GET  /me/dashboard — returns the caller's layout, or the empty layout
 *                       ({version:3,dashboards:[],activeId:""}) when no row
 *                       exists yet. A legacy v1/v2 row is returned untouched
 *                       (GET is not validated) and wrapped into one tab
 *                       client-side.
 * PUT  /me/dashboard — Zod-validates the full v3 layout (multiple named
 *                       dashboards + activeId), upserts, returns the saved
 *                       shape. The client always normalizes to v3 before
 *                       saving, so PUT only ever needs to accept v3.
 */

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import {
  getLayoutForUser,
  saveLayoutForUser,
  type DashboardLayout,
} from "../../services/userDashboardService.js";
// The column/widget shape + its caps are shared with the saved-dashboard
// registry (src/api/routes/savedDashboards.ts) — one definition, so a blob one
// surface accepts can always be rendered by the other. See utils/dashboardLayout.ts.
import {
  ColumnsSchema,
  MAX_DASHBOARDS,
  MAX_DASHBOARD_NAME_LEN,
} from "../../utils/dashboardLayout.js";

const router = Router();

const DashboardSchema = z.object({
  id:      z.string().guid("dashboard id must be a uuid"),
  name:    z.string().min(1).max(MAX_DASHBOARD_NAME_LEN),
  columns: ColumnsSchema,
});

const LayoutSchema = z
  .object({
    version:    z.literal(3),
    dashboards: z.array(DashboardSchema).min(1).max(MAX_DASHBOARDS),
    activeId:   z.string().guid(),
  })
  .superRefine((layout, ctx) => {
    if (!layout.dashboards.some((d) => d.id === layout.activeId)) {
      ctx.addIssue({ code: "custom", message: "activeId must match a dashboard id" });
    }
  });

router.get("/", async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) throw new AppError(401, "Unauthorized");
    const layout = await getLayoutForUser(userId);
    res.json(layout);
  } catch (err) {
    next(err);
  }
});

router.put("/", async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) throw new AppError(401, "Unauthorized");
    // Inline parse like every other route file — the global errorHandler
    // formats a thrown ZodError into a field-labeled 400.
    const body = LayoutSchema.parse(req.body) as DashboardLayout;
    const layout = await saveLayoutForUser(userId, body);
    res.json(layout);
  } catch (err) {
    next(err);
  }
});

export default router;

/**
 * src/api/routes/notifications.ts — triggered notifications (View tab).
 *
 * Mounted at /api/v1/notifications. Gates:
 *   GET  /            notifications:read   (view; region-scoped to the caller unless admin-equivalent)
 *   POST /acknowledge notifications:write  (user and up; readonly cannot)
 *   POST /clear       alerts:fullwrite (admin + assetsadmin)
 *   GET  /:id         alerts:read          (one alert, for the acknowledge page)
 *
 * Rule CRUD lives in notificationRules.ts. Business logic in
 * notificationService; region scope via regionScopeService.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { requirePermission, callerIsAdminEquivalent } from "../middleware/permissions.js";
import {
  listNotifications,
  acknowledgeNotifications,
  clearNotifications,
  getNotificationForViewer,
} from "../../services/notificationService.js";
import { getEffectiveRegionTags } from "../../services/regionScopeService.js";

export const notificationsRouter = Router();

/**
 * The region scope the alert READS apply to this caller. Empty = unrestricted.
 *
 * An admin-equivalent caller is never region-scoped here. Region tags reach an
 * account from three places (user, role, SSO group mapping), and an admin who
 * sits in a regional IdP group picks one up without anyone meaning to narrow
 * them — after which the Active Alerts widget (unscoped) shows an alert whose
 * acknowledge card 404s it as "not here any more". The acknowledge POST was
 * never scoped, so the scope only ever hid the alert, never protected it; and
 * an admin-equivalent role can widen its own scope anyway, so honouring it
 * here bought nothing but a dead end.
 */
async function alertViewerRegionTags(req: Request): Promise<string[]> {
  if (!req.session?.userId || callerIsAdminEquivalent(req)) return [];
  return getEffectiveRegionTags(req.session.userId);
}

const csvList = (v: unknown): string[] | undefined => {
  if (typeof v !== "string" || v.trim() === "") return undefined;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
};

notificationsRouter.get("/", requirePermission("alerts", "read"), async (req, res, next) => {
  try {
    const viewerRegionTags = await alertViewerRegionTags(req);
    const ackParam = req.query.acknowledged;
    const result = await listNotifications({
      viewerRegionTags,
      filters: {
        severity: csvList(req.query.severity),
        acknowledged:
          ackParam === "true" ? true : ackParam === "false" ? false : undefined,
        assetId: typeof req.query.assetId === "string" ? req.query.assetId : undefined,
        region: csvList(req.query.region),
        search: typeof req.query.search === "string" ? req.query.search : undefined,
        includeCleared: req.query.includeCleared === "true",
      },
      sortBy: typeof req.query.sortBy === "string" ? req.query.sortBy : undefined,
      sortDir: req.query.sortDir === "asc" ? "asc" : "desc",
      limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
      offset: req.query.offset ? parseInt(String(req.query.offset), 10) : undefined,
    });
    res.json(result);
  } catch (err) { next(err); }
});

const AckSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(2000),
  note: z.string().max(2000).optional(),
  // Provenance for the audit Event only — never a gate, and deliberately a
  // closed set so a caller can't write arbitrary text into the log. Absent =
  // the in-app surfaces.
  source: z.enum(["ack_page", "web_push_action"]).optional(),
});

notificationsRouter.post("/acknowledge", requirePermission("alerts", "write"), async (req, res, next) => {
  try {
    const { ids, note, source } = AckSchema.parse(req.body);
    const count = await acknowledgeNotifications(ids, req.session?.username ?? "unknown", note, { source: source ?? "ui" });
    res.json({ acknowledged: count });
  } catch (err) { next(err); }
});

const ClearSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(2000),
});

notificationsRouter.post("/clear", requirePermission("alerts", "fullwrite"), async (req, res, next) => {
  try {
    const { ids } = ClearSchema.parse(req.body);
    const count = await clearNotifications(ids, req.session?.username ?? "unknown");
    res.json({ cleared: count });
  } catch (err) { next(err); }
});

/**
 * One alert. Backs public/alert-ack.html, the page an emailed Acknowledge
 * button lands on — declared LAST so it can never capture /acknowledge or
 * /clear (both POST, but keeping the order right costs nothing and survives
 * someone adding a GET sibling).
 *
 * 404 rather than 403 when the caller's region scope excludes it: which alerts
 * exist outside your regions is not something this route should confirm. An
 * admin-equivalent caller has no region scope here (alertViewerRegionTags).
 */
notificationsRouter.get("/:id", requirePermission("alerts", "read"), async (req, res, next) => {
  try {
    const viewerRegionTags = await alertViewerRegionTags(req);
    const alert = await getNotificationForViewer(String(req.params.id), viewerRegionTags);
    if (!alert) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    res.json(alert);
  } catch (err) { next(err); }
});

export default notificationsRouter;

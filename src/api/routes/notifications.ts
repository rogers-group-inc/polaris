/**
 * src/api/routes/notifications.ts — triggered notifications (View tab).
 *
 * Mounted at /api/v1/notifications. Gates:
 *   GET  /            alerts:read   (view; region-scoped to the caller unless admin-equivalent)
 *   POST /acknowledge alerts:write  (every built-in that holds any write; readonly cannot —
 *                     and, per business rule 141 (e), at Read-Write only an alert whose
 *                     device (the lead, or any grouped member) the caller owns or that
 *                     carries one of their tags; an alert with no device is Full Read-Write;
 *                     assertAlertsInScope below, every id before any write)
 *   POST /clear       alertClear:write (its own key from 2026-11-03 — seeded onto the roles
 *                     that held alerts:fullwrite, admin + assetsadmin among the built-ins)
 *                     + the same scope as acknowledge. GET / rows carry canAcknowledge /
 *                     canClear.
 *   GET  /:id         alerts:read   (one alert, for the acknowledge page)
 *
 * Rule CRUD lives in notificationRules.ts. Business logic in
 * notificationService; region scope via regionScopeService.
 */

import { intQuery, boolQuery } from "../../utils/queryParams.js";
import { Router, type Request } from "express";
import { z } from "zod";
import { requirePermission, callerIsAdminEquivalent } from "../middleware/permissions.js";
import { hasPermission } from "../middleware/permissions.js";
import { resolveWriteScope, inWriteScope, assertFleetWide } from "../../services/writeScopeService.js";
import { AppError } from "../../utils/errors.js";
import { prisma } from "../../db.js";
import {
  listNotifications,
  acknowledgeNotifications,
  clearNotifications,
  getNotificationForViewer,
} from "../../services/notificationService.js";
import { getEffectiveRegionTags } from "../../services/regionScopeService.js";

const notificationsRouter = Router();

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
        includeCleared: boolQuery(req.query.includeCleared),
      },
      sortBy: typeof req.query.sortBy === "string" ? req.query.sortBy : undefined,
      sortDir: req.query.sortDir === "asc" ? "asc" : "desc",
      limit: intQuery(req.query.limit),
      offset: intQuery(req.query.offset),
    });
    // Rule 141 (e): per-row verbs for THIS caller (clear also needs its key).
    const rows = (result as { notifications: Array<{ id: string }> }).notifications;
    const flags = await alertScopeFlags(req, rows.map((n) => n.id));
    const mayClear = hasPermission(req, "alertClear", "write");
    const reach = (id: string) => flags.all || (flags.inScope.get(id) === true);
    res.json({ ...result, notifications: rows.map((n) => ({ ...n, canAcknowledge: reach(n.id), canClear: mayClear && reach(n.id) })) });
  } catch (err) { next(err); }
});


/**
 * Business rule 141 (e): acknowledging or clearing reaches an alert whose
 * device — the lead asset, or any member of a grouped alert (rule 75) — the
 * caller owns or that carries one of their tags; an alert with no device is
 * Full Read-Write only. Judged on the `alerts` key for both verbs (clear
 * additionally needs the alertClear key, which has no fullwrite rung of its
 * own). Every alert is checked before any is changed. Two reads: the alerts
 * (ids, lead + member asset ids) and their assets, however many ids.
 */
/** Per alert: is its device (lead, or any grouped member) in the caller's alerts write scope? Empty map when the scope is 'all'. One read for the alerts, one for their assets. */
async function alertScopeFlags(req: Request, ids: string[]): Promise<{ all: boolean; inScope: Map<string, boolean>; noDevice: Set<string> }> {
  const scope = await resolveWriteScope(req, "alerts");
  const inScope = new Map<string, boolean>();
  const noDevice = new Set<string>();
  if (scope.kind === "all" || ids.length === 0) return { all: scope.kind === "all", inScope, noDevice };
  const rows = await prisma.notification.findMany({ where: { id: { in: ids } }, select: { id: true, assetId: true, members: true } });
  const assetIdsOf = (row: { assetId: string | null; members: unknown }): string[] => {
    const out: string[] = [];
    if (row.assetId) out.push(row.assetId);
    if (Array.isArray(row.members)) {
      for (const m of row.members as { assetId?: unknown }[]) {
        if (m && typeof m.assetId === "string" && m.assetId) out.push(m.assetId);
      }
    }
    return out;
  };
  const allIds = Array.from(new Set(rows.flatMap(assetIdsOf)));
  const assets = allIds.length
    ? await prisma.asset.findMany({ where: { id: { in: allIds } }, select: { id: true, createdBy: true, tags: true } })
    : [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  for (const row of rows) {
    const candidates = assetIdsOf(row).map((id) => byId.get(id)).filter((a): a is NonNullable<typeof a> => !!a);
    if (candidates.length === 0) noDevice.add(row.id);
    inScope.set(row.id, candidates.some((a) => inWriteScope(scope, a)));
  }
  return { all: false, inScope, noDevice };
}

async function assertAlertsInScope(req: Request, ids: string[], verb: string): Promise<void> {
  const flags = await alertScopeFlags(req, ids);
  if (flags.all) return;
  const scope = await resolveWriteScope(req, "alerts");
  for (const id of ids) {
    if (flags.noDevice.has(id)) assertFleetWide(scope, `${verb} an alert that names no device`);
    if (!flags.inScope.get(id)) {
      throw new AppError(403, `Forbidden — you can only ${verb} alerts on devices you created or that carry one of your tags`);
    }
  }
}

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
    await assertAlertsInScope(req, ids, "acknowledge");
    const count = await acknowledgeNotifications(ids, req.session?.username ?? "unknown", note, { source: source ?? "ui" });
    res.json({ acknowledged: count });
  } catch (err) { next(err); }
});

const ClearSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(2000),
});

notificationsRouter.post("/clear", requirePermission("alertClear", "write"), async (req, res, next) => {
  try {
    const { ids } = ClearSchema.parse(req.body);
    await assertAlertsInScope(req, ids, "clear");
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

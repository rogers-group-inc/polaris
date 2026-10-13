/**
 * src/api/routes/calendar.ts — the Events page's Calendar tab.
 *
 *   GET /calendar?from=YYYY-MM-DD&to=YYYY-MM-DD   events:read
 *
 * Maintenance windows, reboots and firmware upgrades — booked and past — over
 * a local day range (operationsCalendarService). The route is the Events
 * page's key; each KIND is included only when the caller also holds that
 * kind's own read key (maintenanceManagement for windows, assets for reboots
 * and firmware), so the calendar shows nobody what its own page would not. A
 * kind the caller may not read comes back `null` (not `[]`), which the page
 * reads as "not shown to you" rather than "nothing scheduled".
 */

import { Router } from "express";
import { z } from "zod";
import { requirePermission, hasPermission } from "../middleware/permissions.js";
import { listCalendar, type CalendarKind } from "../../services/operationsCalendarService.js";

const localDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected a local date like 2026-07-12");
const calendarQuerySchema = z.object({ from: localDay, to: localDay });

export const calendarRouter = Router();

calendarRouter.get("/", requirePermission("events", "read"), async (req, res, next) => {
  try {
    const q = calendarQuerySchema.parse(req.query);
    const kinds = new Set<CalendarKind>();
    if (hasPermission(req, "maintenanceManagement", "read")) kinds.add("maintenance");
    if (hasPermission(req, "assets", "read")) { kinds.add("reboot"); kinds.add("firmware"); }
    res.json(await listCalendar({ from: q.from, to: q.to, kinds }));
  } catch (err) { next(err); }
});

export default calendarRouter;

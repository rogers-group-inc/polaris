/**
 * src/api/routes/maintenanceSchedules.ts — maintenance-schedule CRUD
 * (Assets page → Maintenance modal).
 *
 * Mounted at /api/v1/maintenance-schedules.
 *   GET  /              maintenanceManagement:read  (list; ?target=assets |
 *                  pathChecks narrows it to one kind — business rule 135)
 *   GET  /path-checks/:checkId          maintenanceManagement:read  (one path
 *                  check's open windows + every schedule naming it)
 *   POST /path-checks/:checkId/release  maintenanceManagement:write  (end
 *                  its maintenance now — the Path Monitor "End maintenance")
 *   GET  /occurrences   maintenanceManagement:read  (calendar tab — every
 *                  schedule's occurrences expanded over a ?from/?to day range,
 *                  returned as server-local wall-clock strings)
 *   GET  /server-time   maintenanceManagement:read  (the server's wall clock +
 *                  zone, so the browser prefills/validates/labels the window
 *                  pickers in the zone the recurrence engine actually uses)
 *   POST /preview  maintenanceManagement:write  (dry-run the target filter
 *                  → capped device list + total; only monitored assets)
 *   POST / PUT/:id / DELETE/:id   maintenanceManagement:write  (CRUD — and,
 *                  per business rule 141 (e), at Read-Write only a window the
 *                  caller created or whose every explicit device they own or
 *                  that carries one of their tags; a window with a device
 *                  FILTER, or over path checks they did not create, is Full
 *                  Read-Write — assertScheduleInScope below. GET / carries
 *                  canEdit per row.)
 *   DELETE /:id/assets/:assetId   maintenanceManagement:write  (drop one
 *                  asset from a schedule's explicit target list — the asset
 *                  edit modal's Maintenance tab; deletes the schedule when
 *                  that asset was its last target)
 *
 * Zod validates the outer shape; the recurrence blob + criteria are validated
 * in maintenanceScheduleService (validateScheduleShape / normalizeCriteria).
 * Every mutation runs the maintenance reconcile inline, so an ad-hoc
 * now-starting one-shot (the status-pill "enter maintenance mode" path) takes
 * effect before the response returns.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { requirePermission } from "../middleware/permissions.js";
import { scheduleCanEditMap } from "../../services/writeScopeService.js";
import { resolveWriteScope, assertAllInWriteScope, assertFleetWide } from "../../services/writeScopeService.js";
import { prisma } from "../../db.js";
import { requestActor } from "../middleware/auth.js";
import {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  removeAssetFromSchedule,
  previewTargets,
  listOccurrences,
  getPathCheckMaintenanceInfo,
  operatorReleasePathCheck,
} from "../../services/maintenanceScheduleService.js";
import { serverClockInfo } from "../../utils/maintenanceRecurrence.js";

const scheduleInputSchema = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean().optional(),
  criteria: z.unknown().optional(),
  assetIds: z.array(z.string()).max(500).optional(),
  // Business rule 135: a schedule pauses path checks INSTEAD of assets —
  // normalizeInput refuses a body carrying both.
  pathCheckIds: z.array(z.string()).max(500).optional(),
  schedule: z.unknown(),
  // In-window assets count as DOWN for child dependency suppression
  // (default true — omitting preserves launch behavior).
  suppressChildren: z.boolean().optional(),
});

const listQuerySchema = z.object({ target: z.enum(["assets", "pathChecks"]).optional() });

const localDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected a local date like 2026-07-12");
const occurrencesQuerySchema = z.object({ from: localDay, to: localDay });

const previewInputSchema = z.object({
  criteria: z.unknown().optional(),
  assetIds: z.array(z.string()).max(500).optional(),
});

const maintenanceSchedulesRouter = Router();

maintenanceSchedulesRouter.get("/", requirePermission("maintenanceManagement", "read"), async (req, res, next) => {
  try {
    const q = listQuerySchema.parse(req.query);
    const schedules = await listSchedules(q.target) as Array<{ id: string; createdBy?: string | null; criteria?: unknown; assetIds?: string[]; pathCheckIds?: string[] }>;
    // Rule 141 (e): `canEdit` per window — the creator's, or every explicit
    // device in scope; a filter-based window only at Full Read-Write.
    const scope = await resolveWriteScope(req, "maintenanceManagement");
    const canEdit = await scheduleCanEditMap(scope, schedules);
    res.json({ schedules: schedules.map((s) => ({ ...s, canEdit: canEdit.get(s.id) === true })) });
  } catch (err) { next(err); }
});

// Path-check maintenance (business rule 135). One check's picture: its open
// windows (with the current occurrence's end, server-local) and every schedule
// naming it. Static first segment, so no "/:id" route captures it.
maintenanceSchedulesRouter.get("/path-checks/:checkId", requirePermission("maintenanceManagement", "read"), async (req, res, next) => {
  try {
    res.json(await getPathCheckMaintenanceInfo(req.params.checkId as string));
  } catch (err) { next(err); }
});

// End a check's maintenance now. Holds for the rest of the current occurrence
// of each schedule it closed; an ad-hoc one-shot it ended is deleted.

/**
 * Business rule 141 (e). A window is reachable by its creator, or when EVERY
 * device it names (explicit `assetIds`) is one the caller owns or that
 * carries one of their tags; a window on path checks is reachable when the
 * caller created every one of them; a window with a device FILTER re-resolves
 * forever against devices nobody has yet, so it is Full Read-Write only.
 * `posted` is the body on create / update; `existingId` the stored row on
 * update / delete (its own targets are judged too, so a scoped caller cannot
 * shrink someone else's window into their own scope).
 */
async function assertScheduleInScope(
  req: Request,
  posted: { criteria?: unknown; assetIds?: string[]; pathCheckIds?: string[] } | null,
  existingId: string | null,
  verb: string,
): Promise<void> {
  const scope = await resolveWriteScope(req, "maintenanceManagement");
  if (scope.kind === "all") return;
  const assetIds = new Set<string>(posted?.assetIds ?? []);
  const pathCheckIds = new Set<string>(posted?.pathCheckIds ?? []);
  let criteria: unknown = posted?.criteria ?? null;
  if (existingId) {
    const row = await prisma.maintenanceSchedule.findUnique({
      where: { id: existingId },
      select: { createdBy: true, criteria: true, assetIds: true, pathCheckIds: true },
    });
    if (!row) return;   // the handler answers 404
    if (scope.kind === "scoped" && row.createdBy != null && row.createdBy === scope.actor) return;
    for (const id of row.assetIds) assetIds.add(id);
    for (const id of row.pathCheckIds) pathCheckIds.add(id);
    if (criteria == null) criteria = row.criteria;
  }
  const hasCriteria = criteria != null && !(typeof criteria === "object" && Object.keys(criteria as object).length === 0);
  if (hasCriteria) assertFleetWide(scope, "a maintenance window with a device filter");
  if (assetIds.size > 0) {
    const assets = await prisma.asset.findMany({ where: { id: { in: [...assetIds] } }, select: { id: true, hostname: true, createdBy: true, tags: true } });
    assertAllInWriteScope(scope, assets, verb, (a) => a.hostname || a.id);
  }
  if (pathCheckIds.size > 0) {
    const checks = await prisma.pathCheck.findMany({ where: { id: { in: [...pathCheckIds] } }, select: { id: true, name: true, createdBy: true } });
    assertAllInWriteScope(scope, checks.map((c) => ({ ...c, tags: [] })), `${verb} on path checks`, (c) => c.name || c.id);
  }
  if (assetIds.size === 0 && pathCheckIds.size === 0 && !hasCriteria) assertFleetWide(scope, "a maintenance window with no explicit devices");
}

maintenanceSchedulesRouter.post("/path-checks/:checkId/release", requirePermission("maintenanceManagement", "write"), async (req, res, next) => {
  try {
    await assertScheduleInScope(req, { pathCheckIds: [req.params.checkId as string] }, null, "release maintenance");
    const released = await operatorReleasePathCheck(req.params.checkId as string, requestActor(req) ?? undefined);
    res.json({ released });
  } catch (err) { next(err); }
});

// Calendar tab: every schedule's occurrences over a day range, expanded
// server-side (the recurrence engine is server-local wall-clock — see
// listOccurrences). Read-level: it exposes nothing the list doesn't.
maintenanceSchedulesRouter.get("/occurrences", requirePermission("maintenanceManagement", "read"), async (req, res, next) => {
  try {
    const q = occurrencesQuerySchema.parse(req.query);
    res.json(await listOccurrences(q));
  } catch (err) { next(err); }
});

// Static path BEFORE any "/:id" so it isn't captured as an id.
//
// The window pickers are server-local wall clock with no offset (see
// serverClockInfo). A browser prefilling them from its OWN clock posts the
// operator's digits for the server to read as its own, which on a UTC-clocked
// host silently produces a window that has already ended.
maintenanceSchedulesRouter.get("/server-time", requirePermission("maintenanceManagement", "read"), (_req, res) => {
  res.json(serverClockInfo());
});

// Static path BEFORE any "/:id" so it isn't captured as an id.
maintenanceSchedulesRouter.post("/preview", requirePermission("maintenanceManagement", "write"), async (req, res, next) => {
  try {
    const input = previewInputSchema.parse(req.body);
    res.json(await previewTargets(input));
  } catch (err) { next(err); }
});

maintenanceSchedulesRouter.post("/", requirePermission("maintenanceManagement", "write"), async (req, res, next) => {
  try {
    const input = scheduleInputSchema.parse(req.body);
    await assertScheduleInScope(req, input, null, "schedule maintenance on devices");
    const schedule = await createSchedule(input, requestActor(req) ?? undefined);
    res.status(201).json({ schedule });
  } catch (err) { next(err); }
});

maintenanceSchedulesRouter.put("/:id", requirePermission("maintenanceManagement", "write"), async (req, res, next) => {
  try {
    const input = scheduleInputSchema.parse(req.body);
    await assertScheduleInScope(req, input, req.params.id as string, "change maintenance on devices");
    const schedule = await updateSchedule(req.params.id as string, input, requestActor(req) ?? undefined);
    res.json({ schedule });
  } catch (err) { next(err); }
});

// Per-asset removal, from the asset edit modal's Maintenance tab. Mounted
// BEFORE "/:id" is irrelevant (distinct depth), but the fullwrite gate is the
// same one the schedule builder carries: this edits the schedule, it just
// reaches it from the device.
maintenanceSchedulesRouter.delete("/:id/assets/:assetId", requirePermission("maintenanceManagement", "write"), async (req, res, next) => {
  try {
    await assertScheduleInScope(req, { assetIds: [req.params.assetId as string] }, null, "change maintenance on devices");
    const result = await removeAssetFromSchedule(
      req.params.id as string,
      req.params.assetId as string,
      requestActor(req) ?? undefined,
    );
    res.json(result);
  } catch (err) { next(err); }
});

maintenanceSchedulesRouter.delete("/:id", requirePermission("maintenanceManagement", "write"), async (req, res, next) => {
  try {
    await assertScheduleInScope(req, null, req.params.id as string, "delete maintenance on devices");
    await deleteSchedule(req.params.id as string, requestActor(req) ?? undefined);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default maintenanceSchedulesRouter;

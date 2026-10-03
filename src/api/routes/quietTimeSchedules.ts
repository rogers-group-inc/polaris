/**
 * src/api/routes/quietTimeSchedules.ts — /api/v1/automations/quiet-times
 *
 * CRUD for the GLOBAL quiet-time schedules (business rule 92): windows during
 * which every automation without a quiet time of its own holds the
 * people-facing sends of the alerts the schedule selects, and emails a
 * summary of what is still outstanding when the window ends. Edited from
 * Automations → Settings → Global Quiet Times.
 *
 * MOUNTED ABOVE `/automations` in the router, like `/automations/groups`, so
 * the literal path is never captured as a rule id.
 *
 * Gated on `automationManagement` exactly as the automations are: a schedule
 * decides who is NOT paged overnight, which is at least as sensitive as an
 * automation deciding who is. Reads take `read`, writes take `write` — the
 * top of this key's ladder (none / read / write).
 */

import { Router } from "express";
import { z } from "zod";
import { requirePermission, } from "../middleware/permissions.js";
import { requestActor } from "../middleware/auth.js";
import {
  listQuietTimeSchedules,
  getQuietTimeSchedule,
  createQuietTimeSchedule,
  updateQuietTimeSchedule,
  deleteQuietTimeSchedule,
  listQuietTimeSummaries,
} from "../../services/quietTimeScheduleService.js";
import { scopeSchema, SEVERITIES } from "../../services/notificationTypes.js";
import { quietTimeConfigSchema } from "../../utils/quietTime.js";

const quietTimeSchedulesRouter = Router();

/**
 * One global schedule. The scope is the automations' OWN scope schema (same
 * builder, same shape, same evaluator), and the quiet config is the shared
 * `quietTimeConfigSchema` an automation's `quietTime` also carries — a global
 * schedule is "an automation-level quiet time with a device filter and an
 * alert-kind filter in front of it", nothing more. Severity membership is
 * refined HERE because the config schema lives below notificationTypes and
 * cannot name SEVERITIES itself.
 */
const quietScheduleInputSchema = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean().optional(),
  scope: scopeSchema.optional().nullable(),
  quiet: quietTimeConfigSchema.superRefine((q, ctx) => {
    for (const s of q.severities ?? []) {
      if (!(SEVERITIES as readonly string[]).includes(s)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["severities"], message: `Unknown severity "${s}"` });
      }
    }
  }),
});

quietTimeSchedulesRouter.get("/", requirePermission("automationManagement", "read"), async (_req, res, next) => {
  try {
    res.json({ schedules: await listQuietTimeSchedules() });
  } catch (err) { next(err); }
});

/** Recent summary runs across every source (global and per-automation). Ahead
 *  of `/:id` so the literal path wins. */
quietTimeSchedulesRouter.get("/summaries", requirePermission("automationManagement", "read"), async (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 20;
    res.json({ summaries: await listQuietTimeSummaries(limit) });
  } catch (err) { next(err); }
});

quietTimeSchedulesRouter.get("/:id", requirePermission("automationManagement", "read"), async (req, res, next) => {
  try {
    res.json(await getQuietTimeSchedule(req.params.id as string));
  } catch (err) { next(err); }
});

quietTimeSchedulesRouter.post("/", requirePermission("automationManagement", "write"), async (req, res, next) => {
  try {
    const input = quietScheduleInputSchema.parse(req.body);
    res.status(201).json(await createQuietTimeSchedule({ ...input, scope: input.scope ?? {} }, requestActor(req)));
  } catch (err) { next(err); }
});

quietTimeSchedulesRouter.put("/:id", requirePermission("automationManagement", "write"), async (req, res, next) => {
  try {
    const input = quietScheduleInputSchema.parse(req.body);
    res.json(await updateQuietTimeSchedule(req.params.id as string, { ...input, scope: input.scope ?? {} }, requestActor(req)));
  } catch (err) { next(err); }
});

quietTimeSchedulesRouter.delete("/:id", requirePermission("automationManagement", "write"), async (req, res, next) => {
  try {
    await deleteQuietTimeSchedule(req.params.id as string, requestActor(req));
    res.status(204).end();
  } catch (err) { next(err); }
});

export default quietTimeSchedulesRouter;

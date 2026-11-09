/**
 * src/api/routes/reboot.ts — rebooting an asset now or later (business rule
 * 115). Mounted at /assets/:id/reboot, BEFORE /assets so "reboot" is never
 * read as an asset sub-resource.
 *
 * Reads are `assets:read` (whoever can open the asset sees the Reboot button
 * and its history). Rebooting and booking a reboot are `assets:write` — the
 * firmware precedent (rule 43(g)): whoever may edit an asset may take it down
 * on purpose, and the opt-in that makes it possible at all is held elsewhere
 * (a credential's or an integration's Allow reboots, the agent host's own).
 * Turning an agent host's opt-in on or off is `assets:fullwrite`, like every
 * verb that changes what the agent may do on a host (rule 43a).
 *
 * Handlers are thin; every rule lives in rebootService / rebootScheduleService
 * / agentRebootPermissionService.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requirePermission, credentialUseActor } from "../middleware/permissions.js";
import { scopeAssetParam } from "../middleware/writeScope.js";
import { requestActor } from "../middleware/auth.js";
import { AppError } from "../../utils/errors.js";
import { getRebootAvailability, startReboot, getRebootRunForAsset, listRebootRunsForAsset, recordRebootCredentialUse } from "../../services/rebootService.js";
import {
  getPendingRebootSchedule,
  listRebootSchedulesForAsset,
  createRebootSchedule,
  updateRebootSchedule,
  cancelRebootSchedule,
} from "../../services/rebootScheduleService.js";
import { normalizeRecipients, MAX_RECIPIENTS } from "../../services/firmwareScheduleService.js";
import { notifySpecSchema, prepareNotify, rememberNotifyFor, notifyDialogDefaults } from "../../services/operationNotifyService.js";
import { setAgentRebootEnabled } from "../../services/agentRebootPermissionService.js";
import { getRebootSettings } from "../../services/rebootSettingsService.js";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const ScheduledForSchema = z.string().datetime({ offset: true, message: "scheduledFor must be an ISO date-time with a zone offset" });
const RecipientsSchema = z.array(z.string().trim().max(254)).max(MAX_RECIPIENTS);
// Why (rule 115(d)). A raw-size guard only — rebootSettingsService trims it,
// caps it at REBOOT_NOTE_MAX and decides whether a blank one is refused.
const NoteSchema = z.string().max(2000, "The reboot note is too long").nullable();

// `notifyEmails` (optional, may be empty): emailed when the reboot is sent and
// when it ends — the dialog's "Email notifications" box (2026-11-09).
const RebootNowSchema = z.object({ note: NoteSchema.optional(), notifyEmails: RecipientsSchema.optional(), notify: notifySpecSchema.optional() }).strict();

const CreateScheduleSchema = z.object({
  scheduledFor: ScheduledForSchema,
  // Plain addresses (the original shape) or the dialog's picker spec — one is needed.
  notifyEmails: RecipientsSchema.optional(),
  notify: notifySpecSchema.optional(),
  note: NoteSchema.optional(),
}).strict();

const UpdateScheduleSchema = z.object({
  scheduledFor: ScheduledForSchema.optional(),
  notifyEmails: RecipientsSchema.optional(),
  notify: notifySpecSchema.optional(),
  note: NoteSchema.optional(),
}).strict().refine((v) => v.scheduledFor || v.notifyEmails || v.notify || v.note !== undefined, { message: "Nothing to change" });

const ListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() });

const AgentPermissionSchema = z.object({ enabled: z.boolean() }).strict();

function firstIssue(err: z.ZodError): string {
  return err.issues[0]?.message ?? "Invalid request";
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export const rebootAssetRouter: Router = Router({ mergeParams: true });

rebootAssetRouter.get("/", requirePermission("assets", "read"), handle(async (req, res) => {
  const assetId = String(req.params.id);
  const [availability, schedule, settings] = await Promise.all([getRebootAvailability(assetId), getPendingRebootSchedule(assetId), getRebootSettings()]);
  res.json({ ...availability, schedule, noteRequired: settings.requireNote });
}));

// Reboot now. 202 — the run is watched, not awaited.
rebootAssetRouter.post("/", requirePermission("assets", "write"), scopeAssetParam("assets", "reboot devices"), handle(async (req, res) => {
  const body = RebootNowSchema.safeParse(req.body ?? {});
  if (!body.success) throw new AppError(400, body.error.issues[0]?.code === "unrecognized_keys" ? "A reboot takes only a note and notifyEmails" : firstIssue(body.error));
  const assetId = String(req.params.id);
  // Validated (channels, a To that reaches someone) BEFORE anything is sent.
  const who = body.data.notify
    ? await prepareNotify(assetId, body.data.notify)
    : { notifyEmails: normalizeRecipients(body.data.notifyEmails ?? [], { allowEmpty: true }) };
  const run = await startReboot({ assetId, actor: requestActor(req) ?? "unknown", note: body.data.note, ...who });
  // The caller's next reboot dialog pre-fills this.
  if (body.data.notify) await rememberNotifyFor(req.session?.userId, "reboot", body.data.notify);
  // Rule 112: the stored credential this reboot signs with, aimed at the gate.
  await recordRebootCredentialUse(String(req.params.id), credentialUseActor(req));
  res.status(202).json({ run });
}));

rebootAssetRouter.get("/runs", requirePermission("assets", "read"), handle(async (req, res) => {
  const q = ListQuerySchema.safeParse(req.query);
  if (!q.success) throw new AppError(400, firstIssue(q.error));
  res.json({ runs: await listRebootRunsForAsset(String(req.params.id), q.data.limit ?? 20) });
}));

// One run of THIS asset — 404 when it belongs to another, so an id is not a
// way to read runs the caller was not shown.
rebootAssetRouter.get("/runs/:runId", requirePermission("assets", "read"), handle(async (req, res) => {
  res.json({ run: await getRebootRunForAsset(String(req.params.id), String(req.params.runId)) });
}));

rebootAssetRouter.get("/schedules", requirePermission("assets", "read"), handle(async (req, res) => {
  const q = ListQuerySchema.safeParse(req.query);
  if (!q.success) throw new AppError(400, firstIssue(q.error));
  res.json({ schedules: await listRebootSchedulesForAsset(String(req.params.id), q.data.limit ?? 20) });
}));

rebootAssetRouter.get("/schedules/defaults", requirePermission("assets", "write"), handle(async (req, res) => {
  res.json({ ...(await notifyDialogDefaults(req.session?.userId ?? null, "reboot")), maxRecipients: MAX_RECIPIENTS });
}));

rebootAssetRouter.post("/schedules", requirePermission("assets", "write"), scopeAssetParam("assets", "book reboots of devices"), handle(async (req, res) => {
  const body = CreateScheduleSchema.safeParse(req.body ?? {});
  if (!body.success) throw new AppError(400, firstIssue(body.error));
  const schedule = await createRebootSchedule({
    assetId: String(req.params.id),
    scheduledFor: new Date(body.data.scheduledFor),
    notifyEmails: body.data.notifyEmails,
    notify: body.data.notify,
    note: body.data.note,
    actor: requestActor(req) ?? "unknown",
  });
  // Rule 112: recorded when BOOKED, by the person who booked it (the flash precedent).
  await recordRebootCredentialUse(String(req.params.id), credentialUseActor(req));
  if (body.data.notify) await rememberNotifyFor(req.session?.userId, "reboot", body.data.notify);
  res.status(201).json({ schedule });
}));

rebootAssetRouter.patch("/schedules/:scheduleId", requirePermission("assets", "write"), scopeAssetParam("assets", "change booked reboots of devices"), handle(async (req, res) => {
  const body = UpdateScheduleSchema.safeParse(req.body ?? {});
  if (!body.success) throw new AppError(400, firstIssue(body.error));
  const schedule = await updateRebootSchedule({
    assetId: String(req.params.id),
    scheduleId: String(req.params.scheduleId),
    scheduledFor: body.data.scheduledFor ? new Date(body.data.scheduledFor) : undefined,
    notifyEmails: body.data.notifyEmails,
    notify: body.data.notify,
    note: body.data.note,
    actor: requestActor(req) ?? "unknown",
  });
  if (body.data.notify) await rememberNotifyFor(req.session?.userId, "reboot", body.data.notify);
  res.json({ schedule });
}));

rebootAssetRouter.delete("/schedules/:scheduleId", requirePermission("assets", "write"), scopeAssetParam("assets", "cancel booked reboots of devices"), handle(async (req, res) => {
  res.json({ schedule: await cancelRebootSchedule(String(req.params.id), String(req.params.scheduleId), requestActor(req) ?? "unknown") });
}));

// An agent host's opt-in (rule 115): installs or removes the host-side
// permission over the agent's install credential, and answers once the host
// has (seconds — one short script over SSH / WinRM).
// Agent Deploy, not Assets: the opt-in is about the agent's install
// credential, the same grant as putting the agent there in the first place.
rebootAssetRouter.put("/agent", requirePermission("agentDeploy", "write"), handle(async (req, res) => {
  const body = AgentPermissionSchema.safeParse(req.body ?? {});
  if (!body.success) throw new AppError(400, firstIssue(body.error));
  res.json(await setAgentRebootEnabled({ assetId: String(req.params.id), enabled: body.data.enabled, actor: requestActor(req) ?? "unknown" }));
}));

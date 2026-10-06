/**
 * src/api/routes/firmware.ts — the firmware repository (business rule 87).
 *
 * Two routers:
 *
 *   firmwareRouter       mounted at /server-settings/firmware, ABOVE the
 *                        blanket serverSettingsSystem=read gate (the
 *                        /server-settings/manufacturer-profiles precedent) so
 *                        a role holding only `firmware` reaches it.
 *   firmwareAssetRouter  mounted at /assets/:id/firmware-upgrade, BEFORE
 *                        /assets so the literal path is never an asset id.
 *
 * The Repository gates on the `firmware` key: read = look, write = images
 * and bindings. The asset side gates on `assets` (rule 43(g)): read = the
 * card, write = flash it now or book a flash for later (rule 93). Handlers are
 * thin; every rule lives in firmwareRepositoryService /
 * firmwareUpgradeService / firmwareScheduleService.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { requirePermission } from "../middleware/permissions.js";
import { requestActor } from "../middleware/auth.js";
import { AppError } from "../../utils/errors.js";
import { FIRMWARE_INCOMING_DIR } from "../../utils/paths.js";
import {
  FIRMWARE_ASSET_TYPES,
  FIRMWARE_MAX_IMAGE_BYTES,
  getFirmwareTree,
  listImages,
  getImage,
  registerUploadedImage,
  discardIncomingUpload,
  setPrimaryImage,
  deleteImage,
  purgeModelImages,
  listBindings,
  upsertBinding,
  deleteBinding,
  listRecentRuns,
  listAssetsForNode,
} from "../../services/firmwareRepositoryService.js";
import {
  getUpgradeAvailability,
  startFirmwareUpgrade,
  getRun,
  getRunForAsset,
  listRunsForAsset,
} from "../../services/firmwareUpgradeService.js";
import {
  getPendingSchedule,
  listSchedulesForAsset,
  createSchedule,
  updateSchedule,
  cancelSchedule,
  defaultRecipientsFor,
  MAX_RECIPIENTS,
} from "../../services/firmwareScheduleService.js";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const AssetTypeSchema = z.enum(FIRMWARE_ASSET_TYPES);

const NodeAssetsQuerySchema = z.object({
  manufacturer: z.string().trim().min(1),
  assetType: AssetTypeSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  // The tree's "(no model)" node — a flag, because a query string drops an empty model.
  noModel: z.enum(["1", "true"]).optional().transform((v) => v !== undefined),
})
  .refine((q) => (q.model === undefined && !q.noModel) || q.assetType !== undefined, { message: "model needs assetType" })
  .refine((q) => !(q.model && q.noModel), { message: "model and noModel are exclusive" });

const ImageListQuerySchema = z.object({
  manufacturer: z.string().trim().min(1).optional(),
  assetType: AssetTypeSchema.optional(),
  model: z.string().optional(),
});

// Parsed from req.body AFTER multer has read the multipart text fields.
const ImageUploadFieldsSchema = z.object({
  manufacturer: z.string().trim().min(1, "manufacturer is required"),
  assetType: AssetTypeSchema,
  model: z.string().trim().min(1, "model is required").max(200),
  notes: z.string().trim().max(2000).optional(),
});

const ModelScopeSchema = z.object({
  manufacturer: z.string().trim().min(1),
  assetType: AssetTypeSchema,
  model: z.string().min(1).max(200),
});

const BindingUpsertSchema = z.object({
  manufacturer: z.string().trim().min(1),
  assetType: AssetTypeSchema.optional().nullable(),
  model: z.string().max(200).optional().nullable(),
  credentialId: z.string().uuid().nullable(),
});

const RunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(["queued", "running", "succeeded", "failed", "unverified"]).optional(),
});

const StartUpgradeSchema = z.object({
  imageId: z.string().uuid({ message: "imageId is required — approve the image to push" }),
});

// An absolute instant (the browser converts its local pick to ISO with an
// offset), so the booking means the same moment whatever zone reads it.
const ScheduledForSchema = z.string().datetime({ offset: true, message: "scheduledFor must be an ISO date-time with a zone offset" });
const RecipientsSchema = z.array(z.string().trim().max(254)).max(MAX_RECIPIENTS);

const CreateScheduleSchema = z.object({
  imageId: z.string().uuid({ message: "imageId is required — approve the image to push" }),
  scheduledFor: ScheduledForSchema,
  notifyEmails: RecipientsSchema,
});

const UpdateScheduleSchema = z.object({
  imageId: z.string().uuid().optional(),
  scheduledFor: ScheduledForSchema.optional(),
  notifyEmails: RecipientsSchema.optional(),
}).refine((v) => v.imageId || v.scheduledFor || v.notifyEmails, { message: "Nothing to change" });

const ScheduleListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try { await fn(req, res); } catch (err) { next(err); }
  };
}

function firstIssue(err: z.ZodError): string {
  return err.issues[0]?.message ?? "Invalid request";
}

// ─── Upload storage ───────────────────────────────────────────────────────────

// Disk, never memory: an image is up to 100 MiB. Into FIRMWARE_DIR/.incoming
// (not os.tmpdir()) so the service's final rename is on one filesystem and
// atomic. The ceiling here is the FortiSwitch upload endpoint's own; multer
// answers LIMIT_FILE_SIZE before the handler sees anything.
const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try { mkdirSync(FIRMWARE_INCOMING_DIR, { recursive: true }); cb(null, FIRMWARE_INCOMING_DIR); }
      catch (err) { cb(err as Error, FIRMWARE_INCOMING_DIR); }
    },
    filename: (_req, _file, cb) => cb(null, `firmware-upload-${Date.now()}-${randomBytes(6).toString("hex")}`),
  }),
  limits: { fileSize: FIRMWARE_MAX_IMAGE_BYTES, files: 1 },
});

function uploadSingle(field: string) {
  const mw = imageUpload.single(field);
  return (req: Request, res: Response, next: NextFunction) => {
    mw(req, res, (err: unknown) => {
      if (!err) return next();
      const code = (err as { code?: string }).code;
      if (code === "LIMIT_FILE_SIZE") return next(new AppError(413, "Firmware images are limited to 100 MiB"));
      if (code === "LIMIT_FILE_COUNT" || code === "LIMIT_UNEXPECTED_FILE") return next(new AppError(400, `Send exactly one file in the "${field}" field`));
      next(err);
    });
  };
}

// ─── /server-settings/firmware ────────────────────────────────────────────────

export const firmwareRouter: Router = Router();

firmwareRouter.get("/tree", requirePermission("firmware", "read"), handle(async (_req, res) => {
  res.json(await getFirmwareTree());
}));

// The asset-count slide-in on a tree node. Names devices, so it takes
// `assets:read` as well as the Repository's own key: a role that may see the
// tree's counts but not the inventory gets the counts only.
firmwareRouter.get("/assets", requirePermission("firmware", "read"), requirePermission("assets", "read"), handle(async (req, res) => {
  const q = NodeAssetsQuerySchema.safeParse(req.query);
  if (!q.success) throw new AppError(400, firstIssue(q.error));
  res.json(await listAssetsForNode(q.data));
}));

firmwareRouter.get("/images", requirePermission("firmware", "read"), handle(async (req, res) => {
  const q = ImageListQuerySchema.safeParse(req.query);
  if (!q.success) throw new AppError(400, firstIssue(q.error));
  res.json({ images: await listImages(q.data) });
}));

firmwareRouter.post("/images", requirePermission("firmware", "write"), uploadSingle("file"), handle(async (req, res) => {
  if (!req.file) throw new AppError(400, "Missing 'file' upload");
  const fields = ImageUploadFieldsSchema.safeParse(req.body ?? {});
  if (!fields.success) {
    await discardIncomingUpload(req.file.path);
    throw new AppError(400, firstIssue(fields.error));
  }
  const result = await registerUploadedImage({
    tmpPath: req.file.path,
    originalName: req.file.originalname,
    sizeBytes: req.file.size,
    manufacturer: fields.data.manufacturer,
    assetType: fields.data.assetType,
    model: fields.data.model,
    notes: fields.data.notes ?? null,
    actor: requestActor(req) ?? null,
  });
  res.status(201).json(result);
}));

firmwareRouter.get("/images/:id", requirePermission("firmware", "read"), handle(async (req, res) => {
  res.json({ image: await getImage(String(req.params.id)) });
}));

firmwareRouter.post("/images/:id/make-primary", requirePermission("firmware", "write"), handle(async (req, res) => {
  res.json({ image: await setPrimaryImage(String(req.params.id), requestActor(req) ?? null) });
}));

firmwareRouter.delete("/images/:id", requirePermission("firmware", "write"), handle(async (req, res) => {
  await deleteImage(String(req.params.id), requestActor(req) ?? null);
  res.status(204).end();
}));

// Body, not path params: a model string carries spaces and slashes.
firmwareRouter.post("/models/purge", requirePermission("firmware", "write"), handle(async (req, res) => {
  const body = ModelScopeSchema.safeParse(req.body ?? {});
  if (!body.success) throw new AppError(400, firstIssue(body.error));
  res.json(await purgeModelImages(body.data, requestActor(req) ?? null));
}));

firmwareRouter.get("/bindings", requirePermission("firmware", "read"), handle(async (_req, res) => {
  res.json({ bindings: await listBindings() });
}));

firmwareRouter.put("/bindings", requirePermission("firmware", "write"), handle(async (req, res) => {
  const body = BindingUpsertSchema.safeParse(req.body ?? {});
  if (!body.success) throw new AppError(400, firstIssue(body.error));
  const binding = await upsertBinding({ ...body.data, actor: requestActor(req) ?? null });
  res.json({ binding });
}));

firmwareRouter.delete("/bindings/:id", requirePermission("firmware", "write"), handle(async (req, res) => {
  await deleteBinding(String(req.params.id), requestActor(req) ?? null);
  res.status(204).end();
}));

firmwareRouter.get("/runs", requirePermission("firmware", "read"), handle(async (req, res) => {
  const q = RunsQuerySchema.safeParse(req.query);
  if (!q.success) throw new AppError(400, firstIssue(q.error));
  res.json({ runs: await listRecentRuns(q.data) });
}));

firmwareRouter.get("/runs/:id", requirePermission("firmware", "read"), handle(async (req, res) => {
  res.json({ run: await getRun(String(req.params.id)) });
}));

// ─── /assets/:id/firmware-upgrade ─────────────────────────────────────────────

export const firmwareAssetRouter: Router = Router({ mergeParams: true });

// The asset's Firmware card is part of the asset: every read here is
// `assets:read`, so whoever can open the asset — and so whoever may flash it —
// sees the card, its run history and a run's progress without also holding
// the Repository key. Flashing itself is `assets:write` (operator decision,
// 2026-09-26: whoever may edit an asset may upgrade it); the `firmware` key
// governs the repository, not the device.
firmwareAssetRouter.get("/", requirePermission("assets", "read"), handle(async (req, res) => {
  const assetId = String(req.params.id);
  const [availability, schedule] = await Promise.all([getUpgradeAvailability(assetId), getPendingSchedule(assetId)]);
  res.json({ ...availability, schedule });
}));

// Flashing a device. 202 — the run is watched, not awaited.
firmwareAssetRouter.post("/", requirePermission("assets", "write"), handle(async (req, res) => {
  const body = StartUpgradeSchema.safeParse(req.body ?? {});
  if (!body.success) throw new AppError(400, firstIssue(body.error));
  const run = await startFirmwareUpgrade({ assetId: String(req.params.id), imageId: body.data.imageId, actor: requestActor(req) ?? "unknown" });
  res.status(202).json({ run });
}));

firmwareAssetRouter.get("/runs", requirePermission("assets", "read"), handle(async (req, res) => {
  const q = RunsQuerySchema.safeParse(req.query);
  if (!q.success) throw new AppError(400, firstIssue(q.error));
  res.json({ runs: await listRunsForAsset(String(req.params.id), q.data.limit ?? 20) });
}));

// One run of THIS asset, with its log — what the card polls while a flash is
// live and what View log opens. 404 when the run belongs to another asset, so
// an assets:read caller cannot read any run by guessing an id.
firmwareAssetRouter.get("/runs/:runId", requirePermission("assets", "read"), handle(async (req, res) => {
  res.json({ run: await getRunForAsset(String(req.params.id), String(req.params.runId)) });
}));

// ─── Scheduled upgrades (business rule 93) ───────────────────────────────────
// Booking, changing and cancelling are `assets:write` — the same grant as
// flashing now, because a booking IS a flash, approved by name, deferred.

firmwareAssetRouter.get("/schedules", requirePermission("assets", "read"), handle(async (req, res) => {
  const q = ScheduleListQuerySchema.safeParse(req.query);
  if (!q.success) throw new AppError(400, firstIssue(q.error));
  res.json({ schedules: await listSchedulesForAsset(String(req.params.id), q.data.limit ?? 20) });
}));

// The address the booking modal pre-fills: the caller's own profile email.
firmwareAssetRouter.get("/schedules/defaults", requirePermission("assets", "write"), handle(async (req, res) => {
  res.json({ notifyEmails: await defaultRecipientsFor(req.session?.userId ?? null), maxRecipients: MAX_RECIPIENTS });
}));

firmwareAssetRouter.post("/schedules", requirePermission("assets", "write"), handle(async (req, res) => {
  const body = CreateScheduleSchema.safeParse(req.body ?? {});
  if (!body.success) throw new AppError(400, firstIssue(body.error));
  const schedule = await createSchedule({
    assetId: String(req.params.id),
    imageId: body.data.imageId,
    scheduledFor: new Date(body.data.scheduledFor),
    notifyEmails: body.data.notifyEmails,
    actor: requestActor(req) ?? "unknown",
  });
  res.status(201).json({ schedule });
}));

firmwareAssetRouter.patch("/schedules/:scheduleId", requirePermission("assets", "write"), handle(async (req, res) => {
  const body = UpdateScheduleSchema.safeParse(req.body ?? {});
  if (!body.success) throw new AppError(400, firstIssue(body.error));
  const schedule = await updateSchedule({
    assetId: String(req.params.id),
    scheduleId: String(req.params.scheduleId),
    scheduledFor: body.data.scheduledFor ? new Date(body.data.scheduledFor) : undefined,
    notifyEmails: body.data.notifyEmails,
    imageId: body.data.imageId,
    actor: requestActor(req) ?? "unknown",
  });
  res.json({ schedule });
}));

firmwareAssetRouter.delete("/schedules/:scheduleId", requirePermission("assets", "write"), handle(async (req, res) => {
  const schedule = await cancelSchedule(String(req.params.id), String(req.params.scheduleId), requestActor(req) ?? "unknown");
  res.json({ schedule });
}));

export default firmwareRouter;

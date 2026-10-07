/**
 * src/api/routes/workloads.ts
 *
 * The per-asset workload surface for VMs and containers discovered by an
 * Unraid or TrueNAS SCALE integration (business rule 94). Mounted at
 * /assets/:id/workload BEFORE /assets, so "workload" is never read as an
 * asset sub-resource of the assets router.
 *
 * Gates follow the firmware precedent (operator decision 2026-09-26: whoever
 * may edit an asset may act on the device): reading the live state is
 * `assets:read`; start / stop / restart / update and the update re-check are
 * `assets:write`. Every action writes an Event in the service.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requirePermission } from "../middleware/permissions.js";
import { requestActor } from "../middleware/auth.js";
import { AppError } from "../../utils/errors.js";
import {
  WORKLOAD_VERBS,
  checkWorkloadUpdates,
  getWorkloadStatus,
  runWorkloadAction,
  type WorkloadVerb,
} from "../../services/workloadActionService.js";

const VerbSchema = z.enum(WORKLOAD_VERBS as unknown as [WorkloadVerb, ...WorkloadVerb[]]);
const ActionBodySchema = z.object({
  // Stop only: pause monitoring until it is started from Polaris (default on).
  pauseMonitoring: z.boolean().optional(),
}).strict();

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export const workloadAssetRouter: Router = Router({ mergeParams: true });

workloadAssetRouter.get("/", requirePermission("assets", "read"), handle(async (req, res) => {
  res.json(await getWorkloadStatus(String(req.params.id)));
}));

workloadAssetRouter.post("/check-updates", requirePermission("assets", "write"), handle(async (req, res) => {
  res.json(await checkWorkloadUpdates(String(req.params.id), requestActor(req) ?? "unknown"));
}));

workloadAssetRouter.post("/:verb", requirePermission("assets", "write"), handle(async (req, res) => {
  const verb = VerbSchema.safeParse(req.params.verb);
  if (!verb.success) throw new AppError(404, `Unknown workload action "${req.params.verb}"`);
  const body = ActionBodySchema.safeParse(req.body ?? {});
  if (!body.success) throw new AppError(400, body.error.issues[0]?.message ?? "Invalid body");
  res.json(await runWorkloadAction({
    assetId: String(req.params.id),
    verb: verb.data,
    actor: requestActor(req) ?? "unknown",
    pauseMonitoring: body.data.pauseMonitoring,
  }));
}));

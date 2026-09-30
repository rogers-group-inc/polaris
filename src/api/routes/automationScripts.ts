/**
 * src/api/routes/automationScripts.ts — AutomationScript registry (Automations
 * → Scripts tab) + run history.
 *
 * Mounted at /api/v1/automations/scripts (BEFORE the /automations rules
 * router so "scripts" is never captured as a rule id).
 *
 *   GET  /              automationScripts:read       (list, body included)
 *   GET  /runs          automationScripts:read       (run history, filterable)
 *   GET  /runs/:id      automationScripts:read       (single run — test-run polling)
 *   GET  /:id           automationScripts:read
 *   POST /              automationScripts:fullwrite  (create — warning Event)
 *   PUT  /:id           automationScripts:fullwrite  (update — warning Event on body change)
 *   DELETE /:id         automationScripts:fullwrite  (409 when referenced by an automation)
 *   POST /:id/test-run  automationScripts:fullwrite  (server-target only; enqueues a run
 *                                                     and returns runId — poll /runs/:id)
 *
 * The `automationScripts` key is RCE-equivalent (see permissions.ts) — every
 * route here sits behind it; attaching script actions to an automation is
 * additionally gated in the rules route.
 */

import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../middleware/permissions.js";
import { SCRIPT_INTERPRETERS } from "../../services/notificationTypes.js";
import {
  listScripts,
  getScript,
  createScript,
  updateScript,
  deleteScript,
  requestScriptRun,
  listRuns,
  getRun,
  SCRIPT_RUN_TARGET_VALUES,
  MAX_SCRIPT_BODY_BYTES,
  MAX_SCRIPT_TIMEOUT_SEC,
} from "../../services/automationScriptService.js";

export const automationScriptsRouter = Router();

const scriptInputSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional().nullable(),
  interpreter: z.enum(SCRIPT_INTERPRETERS),
  body: z.string().min(1).max(MAX_SCRIPT_BODY_BYTES),
  runTarget: z.enum(SCRIPT_RUN_TARGET_VALUES).default("server"),
  timeoutSec: z.number().int().min(1).max(MAX_SCRIPT_TIMEOUT_SEC).optional().nullable(),
  enabled: z.boolean().optional(),
});

const testRunSchema = z.object({
  args: z.string().max(2000).optional().nullable(),
});

automationScriptsRouter.get("/", requirePermission("automationScripts", "read"), async (_req, res, next) => {
  try {
    res.json({ scripts: await listScripts() });
  } catch (err) { next(err); }
});

// Static paths BEFORE "/:id" so they aren't captured as script ids.
automationScriptsRouter.get("/runs", requirePermission("automationScripts", "read"), async (req, res, next) => {
  try {
    res.json({
      runs: await listRuns({
        scriptId: req.query.scriptId ? String(req.query.scriptId) : undefined,
        notificationId: req.query.notificationId ? String(req.query.notificationId) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    });
  } catch (err) { next(err); }
});

automationScriptsRouter.get("/runs/:id", requirePermission("automationScripts", "read"), async (req, res, next) => {
  try {
    res.json({ run: await getRun(req.params.id as string) });
  } catch (err) { next(err); }
});

automationScriptsRouter.get("/:id", requirePermission("automationScripts", "read"), async (req, res, next) => {
  try {
    res.json({ script: await getScript(req.params.id as string) });
  } catch (err) { next(err); }
});

automationScriptsRouter.post("/", requirePermission("automationScripts", "write"), async (req, res, next) => {
  try {
    const input = scriptInputSchema.parse(req.body);
    const script = await createScript(input, req.session?.username);
    res.status(201).json({ script });
  } catch (err) { next(err); }
});

automationScriptsRouter.put("/:id", requirePermission("automationScripts", "write"), async (req, res, next) => {
  try {
    const input = scriptInputSchema.parse(req.body);
    const script = await updateScript(req.params.id as string, input, req.session?.username);
    res.json({ script });
  } catch (err) { next(err); }
});

automationScriptsRouter.delete("/:id", requirePermission("automationScripts", "write"), async (req, res, next) => {
  try {
    await deleteScript(req.params.id as string, req.session?.username);
    res.status(204).end();
  } catch (err) { next(err); }
});

// Operator-initiated test run — SERVER target only (an agent test would act
// on a production asset; run those through a real automation deliberately).
// Enqueues the run and returns immediately; the runner job (5s tick) executes
// it and the client polls GET /runs/:id for exitCode/stdout/stderr.
automationScriptsRouter.post("/:id/test-run", requirePermission("automationScripts", "write"), async (req, res, next) => {
  try {
    const input = testRunSchema.parse(req.body ?? {});
    const { runId } = await requestScriptRun({
      scriptId: req.params.id as string,
      runOn: "server",
      args: input.args?.trim() ? input.args : null,
      requestedBy: req.session?.username ?? "operator",
    });
    res.status(202).json({ runId });
  } catch (err) { next(err); }
});

export default automationScriptsRouter;

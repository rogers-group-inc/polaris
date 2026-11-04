/**
 * src/api/routes/logFlagRules.ts — CRUD for user-defined log-flag rules.
 *
 * Mounted at /api/v1/log-flag-rules. List is assets:read; writes are
 * assets:write (matches the per-process log config gate). Business logic +
 * the read-time eval live in logFlagRuleService.
 */

import { Router, type Request } from "express";
import { prisma } from "../../db.js";
import { z } from "zod";
import { requirePermission } from "../middleware/permissions.js";
import { resolveWriteScope, assertInWriteScope, assertFleetWide } from "../../services/writeScopeService.js";
import { AppError } from "../../utils/errors.js";
import {
  listLogFlagRules,
  createLogFlagRule,
  updateLogFlagRule,
  deleteLogFlagRule,
} from "../../services/logFlagRuleService.js";

export const logFlagRulesRouter = Router();

const RuleObject = z.object({
  name:          z.string().min(1).max(128),
  enabled:       z.boolean().optional(),
  scope:         z.enum(["global", "asset", "process"]),
  assetId:       z.string().uuid().nullable().optional(),
  processName:   z.string().max(255).nullable().optional(),
  matchType:     z.enum(["substring", "regex", "glob"]),
  pattern:       z.string().min(1).max(1024),
  caseSensitive: z.boolean().optional(),
  minLevel:      z.enum(["info", "warning", "error", "critical"]).nullable().optional(),
  label:         z.string().max(128).nullable().optional(),
  color:         z.string().max(32).nullable().optional(),
});

const RuleSchema = RuleObject.refine((v) => v.scope === "global" || !!v.assetId, {
  message: "assetId is required for asset/process scope",
  path: ["assetId"],
}).refine((v) => v.scope !== "process" || !!v.processName, {
  message: "processName is required for process scope",
  path: ["processName"],
});

// Update accepts a loose partial; the service keeps scope/assetId/processName
// coherent when scope changes.
const RuleUpdateSchema = RuleObject.partial();

logFlagRulesRouter.get("/", requirePermission("assets", "read"), async (_req, res, next) => {
  try {
    res.json({ rules: await listLogFlagRules() });
  } catch (err) { next(err); }
});

// Business rule 141 (e): a rule scoped to one device is that device's (own or
// tagged); a global rule flags every device's logs, so it is Full Read-Write.
async function assertLogFlagRuleInScope(req: Request, ruleId: string | null, posted: { scope?: unknown; assetId?: unknown } | null): Promise<void> {
  const scope = await resolveWriteScope(req, "assets");
  if (scope.kind === "all") return;
  let assetId: string | null = null;
  let ruleScope: string | null = null;
  if (ruleId) {
    const row = await prisma.logFlagRule.findUnique({ where: { id: ruleId }, select: { scope: true, assetId: true } });
    if (!row) return;   // the handler answers 404
    ruleScope = row.scope; assetId = row.assetId;
  }
  if (posted) {
    if (typeof posted.scope === "string") ruleScope = posted.scope;
    if (typeof posted.assetId === "string") assetId = posted.assetId;
  }
  if (ruleScope === "global" || !assetId) assertFleetWide(scope, "a fleet-wide log-flag rule");
  else {
    const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { createdBy: true, tags: true } });
    if (asset) assertInWriteScope(scope, asset, "flag logs on devices");
  }
}

logFlagRulesRouter.post("/", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const input = RuleSchema.parse(req.body);
    await assertLogFlagRuleInScope(req, null, input as { scope?: unknown; assetId?: unknown });
    const row = await createLogFlagRule(input, req.session?.username);
    res.status(201).json({ rule: row });
  } catch (err) { next(err); }
});

logFlagRulesRouter.put("/:id", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const input = RuleUpdateSchema.parse(req.body);
    await assertLogFlagRuleInScope(req, id, input as { scope?: unknown; assetId?: unknown });
    const row = await updateLogFlagRule(id, input, req.session?.username);
    res.json({ rule: row });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2025") return next(new AppError(404, "Log-flag rule not found"));
    next(err);
  }
});

logFlagRulesRouter.delete("/:id", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    await assertLogFlagRuleInScope(req, req.params.id as string, null);
    await deleteLogFlagRule(req.params.id as string, req.session?.username);
    res.status(204).end();
  } catch (err) {
    if ((err as { code?: string })?.code === "P2025") return next(new AppError(404, "Log-flag rule not found"));
    next(err);
  }
});

export default logFlagRulesRouter;

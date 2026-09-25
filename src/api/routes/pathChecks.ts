/**
 * src/api/routes/pathChecks.ts — agent-run path checks
 * (Path Monitor page (/path-monitor.html)).
 *
 * Mounted at /api/v1/path-checks.
 *   GET    /                  pathChecks:read   (list + per-check pass/fail summary)
 *   GET    /filter-schema     pathChecks:read   (the Sources tab's condition-builder
 *                             vocabulary — its own route so the check modal never needs
 *                             automationManagement:read; the contacts /filter-schema precedent)
 *   POST   /preview-sources   pathChecks:write  (dry-run the Sources filter → agent hosts)
 *   GET    /:id               pathChecks:read
 *   GET    /:id/results       pathChecks:read   (fleet view: latest result per host)
 *   POST   /                  pathChecks:write
 *   PUT    /:id               pathChecks:write
 *   POST   /:id/enabled       pathChecks:write
 *   DELETE /:id               pathChecks:write
 *
 * Zod validates the outer shape; the semantic checks (target refusal, status
 * spec, RE2-compatible regex, interval / timeout rules) live in
 * pathCheckService.normalizeCheckInput so every caller gets them.
 * Static paths are declared BEFORE "/:id".
 */

import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../middleware/permissions.js";
import { requestActor } from "../middleware/auth.js";
import {
  CHECK_KINDS,
  BODY_MATCH_MODES,
  listChecks,
  getCheck,
  createCheck,
  updateCheck,
  deleteCheck,
  setCheckEnabled,
  previewSources,
  listCheckResults,
} from "../../services/pathCheckService.js";
import { listScopeOptions } from "../../services/notificationRuleService.js";
import { SCOPE_FIELD_OPS, scopeConditionMeta, scopeSchema } from "../../services/notificationTypes.js";
import { listAssetTypes } from "../../services/assetTypeService.js";
import { listAssetTags } from "../../services/tagAssignmentService.js";

/** Exported so the check modal's DOM test can validate what the form posts. */
export const pathCheckInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
  enabled: z.boolean().optional(),
  kind: z.enum(CHECK_KINDS),
  target: z.string().min(1).max(512),
  intervalSec: z.number().int().min(60).max(3600).optional(),
  timeoutMs: z.number().int().min(100).max(60000).optional(),
  http: z.object({
    expectStatus: z.string().max(200).optional(),
    bodyMatch: z.object({
      mode: z.enum(BODY_MATCH_MODES),
      pattern: z.string().max(1024),
      caseSensitive: z.boolean().optional(),
    }).nullable().optional(),
    verifyTls: z.boolean().optional(),
  }).nullable().optional(),
  traceroute: z.object({
    enabled: z.boolean().optional(),
    everyNRuns: z.number().int().min(1).max(100).optional(),
    maxHops: z.number().int().min(1).max(64).optional(),
    probesPerHop: z.number().int().min(1).max(5).optional(),
    probeTimeoutMs: z.number().int().min(100).max(5000).optional(),
  }).nullable().optional(),
  keepBodyExcerpt: z.boolean().optional(),
  scope: scopeSchema.nullable().optional(),
  assetIds: z.array(z.string().max(64)).max(2000).optional(),
});

const previewSchema = z.object({
  scope: scopeSchema.nullable().optional(),
  assetIds: z.array(z.string().max(64)).max(2000).optional(),
});

const enabledSchema = z.object({ enabled: z.boolean() });

export const pathChecksRouter = Router();

pathChecksRouter.get("/", requirePermission("pathChecks", "read"), async (_req, res, next) => {
  try {
    res.json({ checks: await listChecks() });
  } catch (err) { next(err); }
});

pathChecksRouter.get("/filter-schema", requirePermission("pathChecks", "read"), async (_req, res, next) => {
  try {
    const [options, assetTypes, tags] = await Promise.all([listScopeOptions(), listAssetTypes(), listAssetTags()]);
    res.json({
      scopeCondition: scopeConditionMeta(SCOPE_FIELD_OPS),
      options: {
        ...options,
        assetTypes: assetTypes.map((t) => ({ name: t.name, label: t.label || t.name })),
        tags,
      },
    });
  } catch (err) { next(err); }
});

pathChecksRouter.post("/preview-sources", requirePermission("pathChecks", "write"), async (req, res, next) => {
  try {
    const input = previewSchema.parse(req.body ?? {});
    res.json(await previewSources({ scope: input.scope ?? undefined, assetIds: input.assetIds }));
  } catch (err) { next(err); }
});

pathChecksRouter.get("/:id", requirePermission("pathChecks", "read"), async (req, res, next) => {
  try {
    res.json(await getCheck(String(req.params.id)));
  } catch (err) { next(err); }
});

pathChecksRouter.get("/:id/results", requirePermission("pathChecks", "read"), async (req, res, next) => {
  try {
    res.json({ results: await listCheckResults(String(req.params.id)) });
  } catch (err) { next(err); }
});

pathChecksRouter.post("/", requirePermission("pathChecks", "write"), async (req, res, next) => {
  try {
    const input = pathCheckInputSchema.parse(req.body);
    res.status(201).json(await createCheck({ ...input, scope: input.scope ?? undefined }, requestActor(req)));
  } catch (err) { next(err); }
});

pathChecksRouter.put("/:id", requirePermission("pathChecks", "write"), async (req, res, next) => {
  try {
    const input = pathCheckInputSchema.parse(req.body);
    res.json(await updateCheck(String(req.params.id), { ...input, scope: input.scope ?? undefined }, requestActor(req)));
  } catch (err) { next(err); }
});

pathChecksRouter.post("/:id/enabled", requirePermission("pathChecks", "write"), async (req, res, next) => {
  try {
    const { enabled } = enabledSchema.parse(req.body);
    res.json(await setCheckEnabled(String(req.params.id), enabled, requestActor(req)));
  } catch (err) { next(err); }
});

pathChecksRouter.delete("/:id", requirePermission("pathChecks", "write"), async (req, res, next) => {
  try {
    await deleteCheck(String(req.params.id), requestActor(req));
    res.status(204).end();
  } catch (err) { next(err); }
});

export default pathChecksRouter;

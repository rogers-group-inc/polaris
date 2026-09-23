/**
 * src/api/routes/connectivityChecks.ts — agent-run connectivity checks
 * (Automations → Connectivity tab).
 *
 * Mounted at /api/v1/connectivity-checks.
 *   GET    /                  connectivityChecks:read   (list + per-check pass/fail summary)
 *   GET    /filter-schema     connectivityChecks:read   (the Sources tab's condition-builder
 *                             vocabulary — its own route so the check modal never needs
 *                             automationManagement:read; the contacts /filter-schema precedent)
 *   POST   /preview-sources   connectivityChecks:write  (dry-run the Sources filter → agent hosts)
 *   GET    /:id               connectivityChecks:read
 *   GET    /:id/results       connectivityChecks:read   (fleet view: latest result per host)
 *   POST   /                  connectivityChecks:write
 *   PUT    /:id               connectivityChecks:write
 *   POST   /:id/enabled       connectivityChecks:write
 *   DELETE /:id               connectivityChecks:write
 *
 * Zod validates the outer shape; the semantic checks (target refusal, status
 * spec, RE2-compatible regex, interval / timeout rules) live in
 * connectivityCheckService.normalizeCheckInput so every caller gets them.
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
} from "../../services/connectivityCheckService.js";
import { listScopeOptions } from "../../services/notificationRuleService.js";
import { SCOPE_FIELD_OPS, scopeConditionMeta, scopeSchema } from "../../services/notificationTypes.js";
import { listAssetTypes } from "../../services/assetTypeService.js";
import { listAssetTags } from "../../services/tagAssignmentService.js";

/** Exported so the check modal's DOM test can validate what the form posts. */
export const connectivityCheckInputSchema = z.object({
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

export const connectivityChecksRouter = Router();

connectivityChecksRouter.get("/", requirePermission("connectivityChecks", "read"), async (_req, res, next) => {
  try {
    res.json({ checks: await listChecks() });
  } catch (err) { next(err); }
});

connectivityChecksRouter.get("/filter-schema", requirePermission("connectivityChecks", "read"), async (_req, res, next) => {
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

connectivityChecksRouter.post("/preview-sources", requirePermission("connectivityChecks", "write"), async (req, res, next) => {
  try {
    const input = previewSchema.parse(req.body ?? {});
    res.json(await previewSources({ scope: input.scope ?? undefined, assetIds: input.assetIds }));
  } catch (err) { next(err); }
});

connectivityChecksRouter.get("/:id", requirePermission("connectivityChecks", "read"), async (req, res, next) => {
  try {
    res.json(await getCheck(String(req.params.id)));
  } catch (err) { next(err); }
});

connectivityChecksRouter.get("/:id/results", requirePermission("connectivityChecks", "read"), async (req, res, next) => {
  try {
    res.json({ results: await listCheckResults(String(req.params.id)) });
  } catch (err) { next(err); }
});

connectivityChecksRouter.post("/", requirePermission("connectivityChecks", "write"), async (req, res, next) => {
  try {
    const input = connectivityCheckInputSchema.parse(req.body);
    res.status(201).json(await createCheck({ ...input, scope: input.scope ?? undefined }, requestActor(req)));
  } catch (err) { next(err); }
});

connectivityChecksRouter.put("/:id", requirePermission("connectivityChecks", "write"), async (req, res, next) => {
  try {
    const input = connectivityCheckInputSchema.parse(req.body);
    res.json(await updateCheck(String(req.params.id), { ...input, scope: input.scope ?? undefined }, requestActor(req)));
  } catch (err) { next(err); }
});

connectivityChecksRouter.post("/:id/enabled", requirePermission("connectivityChecks", "write"), async (req, res, next) => {
  try {
    const { enabled } = enabledSchema.parse(req.body);
    res.json(await setCheckEnabled(String(req.params.id), enabled, requestActor(req)));
  } catch (err) { next(err); }
});

connectivityChecksRouter.delete("/:id", requirePermission("connectivityChecks", "write"), async (req, res, next) => {
  try {
    await deleteCheck(String(req.params.id), requestActor(req));
    res.status(204).end();
  } catch (err) { next(err); }
});

export default connectivityChecksRouter;

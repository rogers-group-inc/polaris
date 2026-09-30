/**
 * src/api/routes/pathChecks.ts — agent-run path checks
 * (Path Monitor page (/path-monitor.html)).
 *
 * Mounted at /api/v1/path-checks.
 *   GET    /                  pathChecks:read   (list + per-check pass/fail summary)
 *   GET    /filter-schema     pathChecks:read   (the wizard's Sources-step condition-builder
 *                             vocabulary — its own route so the check modal never needs
 *                             automationManagement:read; the contacts /filter-schema precedent)
 *   POST   /preview-sources   pathChecks:write  (dry-run the Sources filter → agent hosts)
 *   POST   /test              pathChecks:write + networkScan:write  (run a DRAFT once from
 *                             this server and return the answer — the Expectations step's
 *                             Test button; audited, 10 a minute per caller)
 *   GET    /:id               pathChecks:read
 *   GET    /:id/results       pathChecks:read   (fleet view: latest result per host,
 *                             the Polaris server's own row first)
 *   GET    /:id/server        pathChecks:read   (the server source, in the asset Paths
 *                             tab's {checks:[…]} shape — empty when it does not run there)
 *   GET    /:id/server/history      pathChecks:read   (?range= | ?from=&to=, tier-picked)
 *   GET    /:id/server/traceroutes  pathChecks:read   (?limit= ≤ 50, newest first)
 *   POST   /                  pathChecks:write  (+ networkScan:write when runOnServer)
 *   PUT    /:id               pathChecks:write  (+ networkScan:write when it re-aims the server)
 *   POST   /:id/enabled       pathChecks:write  (+ networkScan:write to re-enable a server-run check)
 *   DELETE /:id               pathChecks:write
 *
 * The server source's reads ride pathChecks:read, not assets:read: the server
 * is no asset, and these endpoints describe the CHECK (the /assets/:id/path-check-*
 * trio is the per-host twin). Pointing the SERVER at a target is chained on
 * networkScan:write (pathCheckService.CheckWriteOpts) — decided by the service
 * from `mayRunOnServer`, because only it knows whether an edit re-aims the server.
 * A `credentialId` (authenticate with an http Credential) makes the check
 * server-only and is a USE of that secret: any `credentials` rung from read
 * up may use any credential (the operator's decision); changing it is the
 * /credentials routes' business.
 *
 * Zod validates the outer shape; the semantic checks (target refusal, status
 * spec, RE2-compatible regex, interval / timeout rules) live in
 * pathCheckService.normalizeCheckInput so every caller gets them.
 * Static paths are declared BEFORE "/:id".
 */

import { Router } from "express";
import { z } from "zod";
import { requirePermission, hasPermission } from "../middleware/permissions.js";
import { requestActor } from "../middleware/auth.js";
import {
  CHECK_KINDS,
  BODY_MATCH_MODES,
  HTTP_METHODS,
  listChecks,
  getCheck,
  createCheck,
  updateCheck,
  deleteCheck,
  setCheckEnabled,
  previewSources,
  testCheck,
  listCheckResults,
  getServerCheck,
  listServerTraceroutes,
  POLARIS_SERVER_SUBJECT,
} from "../../services/pathCheckService.js";
import { resolveRange, extendSinceForLookback } from "../../utils/chartRange.js";
import { pickSampleTierForAsset } from "../../services/sampleQueryRouter.js";
import { readPathCheckHistory } from "../../services/sampleHistoryService.js";
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
      negate: z.boolean().optional(),
    }).nullable().optional(),
    verifyTls: z.boolean().optional(),
    // GET / HEAD only — anything that writes is refused by design, and the
    // enum is what refuses it.
    method: z.enum(HTTP_METHODS).optional(),
    hostHeader: z.string().max(260).nullable().optional(),
    followRedirects: z.boolean().optional(),
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
  runOnServer: z.boolean().optional(),
  credentialId: z.string().max(64).nullable().optional(),
});

const previewSchema = z.object({
  scope: scopeSchema.nullable().optional(),
  assetIds: z.array(z.string().max(64)).max(2000).optional(),
});

const enabledSchema = z.object({ enabled: z.boolean() });

/** A draft under test: the full check body, but no name or Sources needed yet. */
const testSchema = pathCheckInputSchema.extend({ name: z.string().max(120).optional() });

/**
 * The chained half of the server-source gate, and who may USE which stored
 * credential (see the header) — both decided by the service, which alone
 * knows whether an edit re-aims the server or re-points a secret.
 */
function writeOpts(req: Parameters<typeof hasPermission>[0]) {
  const credentialAccess = hasPermission(req, "credentials", "fullwrite") ? "fullwrite" as const
    : hasPermission(req, "credentials", "write") ? "write" as const
    : hasPermission(req, "credentials", "read") ? "read" as const : "none" as const;
  return { mayRunOnServer: hasPermission(req, "networkScan", "write"), credentialAccess };
}

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

pathChecksRouter.post("/test", requirePermission("pathChecks", "write"), async (req, res, next) => {
  try {
    const input = testSchema.parse(req.body ?? {});
    res.json(await testCheck({ ...input, name: input.name ?? "", scope: input.scope ?? undefined }, requestActor(req), writeOpts(req)));
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

pathChecksRouter.get("/:id/server", requirePermission("pathChecks", "read"), async (req, res, next) => {
  try {
    res.json(await getServerCheck(String(req.params.id)));
  } catch (err) { next(err); }
});

pathChecksRouter.get("/:id/server/history", requirePermission("pathChecks", "read"), async (req, res, next) => {
  try {
    const checkId = String(req.params.id);
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(POLARIS_SERVER_SUBJECT, "pathCheck", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    const result = await readPathCheckHistory(POLARIS_SERVER_SUBJECT, since, until, pick.tier, checkId, fetchSince);
    res.json({
      range: rangeLabel,
      checkId,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
    });
  } catch (err) { next(err); }
});

pathChecksRouter.get("/:id/server/traceroutes", requirePermission("pathChecks", "read"), async (req, res, next) => {
  try {
    const checkId = String(req.params.id);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    res.json({ checkId, traceroutes: await listServerTraceroutes(checkId, limit) });
  } catch (err) { next(err); }
});

pathChecksRouter.post("/", requirePermission("pathChecks", "write"), async (req, res, next) => {
  try {
    const input = pathCheckInputSchema.parse(req.body);
    res.status(201).json(await createCheck({ ...input, scope: input.scope ?? undefined }, requestActor(req), writeOpts(req)));
  } catch (err) { next(err); }
});

pathChecksRouter.put("/:id", requirePermission("pathChecks", "write"), async (req, res, next) => {
  try {
    const input = pathCheckInputSchema.parse(req.body);
    res.json(await updateCheck(String(req.params.id), { ...input, scope: input.scope ?? undefined }, requestActor(req), writeOpts(req)));
  } catch (err) { next(err); }
});

pathChecksRouter.post("/:id/enabled", requirePermission("pathChecks", "write"), async (req, res, next) => {
  try {
    const { enabled } = enabledSchema.parse(req.body);
    res.json(await setCheckEnabled(String(req.params.id), enabled, requestActor(req), writeOpts(req)));
  } catch (err) { next(err); }
});

pathChecksRouter.delete("/:id", requirePermission("pathChecks", "write"), async (req, res, next) => {
  try {
    await deleteCheck(String(req.params.id), requestActor(req));
    res.status(204).end();
  } catch (err) { next(err); }
});

export default pathChecksRouter;

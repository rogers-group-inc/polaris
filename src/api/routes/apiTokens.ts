/**
 * src/api/routes/apiTokens.ts — CRUD for bearer-token API access.
 *
 * Mounted at /api/v1/api-tokens with `requirePermission("apiTokens","read")`
 * at router.ts; writes here escalate to `apiTokens=write`. Each token is
 * bound to a Role at mint time — it acts with that role's permission matrix
 * everywhere requirePermission gates. The raw token value is shown ONCE on
 * creation and never recoverable. An optional trustedHosts list (IPs /
 * CIDRs) limits the source addresses the token is accepted from.
 */

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import {
  createToken,
  deleteToken,
  listTokens,
  revokeToken,
  updateTrustedHosts,
  listRoleChoices,
  listQuarantineIntegrations,
} from "../../services/apiTokenService.js";
import { logEvent } from "./events.js";
import { requirePermission } from "../middleware/permissions.js";
import { getPublicApiBaseUrl } from "../../utils/publicUrl.js";

const router = Router();

const CreateTokenSchema = z.object({
  name: z.string().min(1).max(80),
  roleId: z.string().min(1),
  integrationIds: z.array(z.string().uuid()).optional(),
  // Bare IPs / CIDRs the token is accepted from; omitted or empty = any
  // source. Format is validated in the service (normalizeTrustedHosts).
  trustedHosts: z.array(z.string().max(64)).max(256).optional(),
  expiresAt: z.string().datetime().optional(),
});

router.get("/", async (_req, res, next) => {
  try {
    const [tokens, roles, quarantineIntegrations] = await Promise.all([
      listTokens(),
      listRoleChoices(),
      listQuarantineIntegrations(),
    ]);
    // apiBaseUrl: what an external caller should dial — null when
    // POLARIS_PUBLIC_URL is unset (the tab falls back to the browser origin).
    res.json({ tokens, roles, quarantineIntegrations, apiBaseUrl: getPublicApiBaseUrl() });
  } catch (err) {
    next(err);
  }
});

router.post("/", requirePermission("apiTokens", "write"), async (req, res, next) => {
  try {
    const input = CreateTokenSchema.parse(req.body);
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new AppError(400, "expiresAt must be in the future");
    }
    const result = await createToken({
      name: input.name,
      roleId: input.roleId,
      integrationIds: input.integrationIds,
      trustedHosts: input.trustedHosts,
      expiresAt,
      createdBy: req.session?.username || "unknown",
    });
    logEvent({
      action: "api_token.created",
      resourceType: "api_token",
      resourceId: result.token.id,
      resourceName: result.token.name,
      actor: req.session?.username,
      message:
        `API token "${result.token.name}" created with role "${result.token.roleName}"` +
        (result.token.trustedHosts.length
          ? `, accepted only from ${result.token.trustedHosts.join(", ")}`
          : ", accepted from any source address"),
      details: { trustedHosts: result.token.trustedHosts },
    });
    // The raw token field is the ONLY time the caller sees the value.
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

const UpdateTrustedHostsSchema = z.object({
  trustedHosts: z.array(z.string().max(64)).max(256),
});

router.put("/:id/trusted-hosts", requirePermission("apiTokens", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const input = UpdateTrustedHostsSchema.parse(req.body);
    const { token, before } = await updateTrustedHosts(id, input.trustedHosts);
    const describe = (hosts: string[]) => (hosts.length ? hosts.join(", ") : "any source");
    logEvent({
      action: "api_token.trusted_hosts_updated",
      resourceType: "api_token",
      resourceId: token.id,
      resourceName: token.name,
      actor: req.session?.username,
      // Opening a restricted token to every source is the widening an
      // auditor needs to see first.
      level: before.length > 0 && token.trustedHosts.length === 0 ? "warning" : "info",
      message: `API token "${token.name}" trusted hosts changed from ${describe(before)} to ${describe(token.trustedHosts)}`,
      details: { before, after: token.trustedHosts },
    });
    res.json({ token });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/revoke", requirePermission("apiTokens", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    await revokeToken(id, req.session?.username || "unknown");
    logEvent({
      action: "api_token.revoked",
      resourceType: "api_token",
      resourceId: id,
      actor: req.session?.username,
      level: "warning",
      message: `API token ${id} revoked`,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requirePermission("apiTokens", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    await deleteToken(id);
    logEvent({
      action: "api_token.deleted",
      resourceType: "api_token",
      resourceId: id,
      actor: req.session?.username,
      level: "warning",
      message: `API token ${id} deleted`,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;

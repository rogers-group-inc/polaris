/**
 * src/services/llmIntegrationService.ts — the role + API token an `llm`
 * integration provisions for its LLM server (business rule 95(f)).
 *
 * Creating an llm integration mints, in one step:
 *   - a custom Role `llm-<name>` holding READ on every function key whose
 *     ladder has a read rung — except the keys that expose secrets, identities
 *     or server administration (BOT_EXCLUDED_KEYS) and `assistant` itself. It
 *     can never write anything.
 *   - an API token bound to that role, returned ONCE (the hash is all that is
 *     stored, exactly like Server Settings → API Tokens).
 *
 * The token is for the LLM host's OWN direct lookups (an Open WebUI tool, an
 * MCP server, a script). The in-app chat never uses it: chat lookups run as
 * the chatting user (rule 95(a)), so the bot role can never widen what a user
 * sees in the widget.
 *
 * Deleting the integration removes the token first and then the role (the
 * role FK is Restrict). Both stay ordinary rows the operator can inspect or
 * revoke under Users → Roles and Server Settings → API Tokens.
 */

import type { Request } from "express";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { createRole, deleteRole } from "./roleService.js";
import { createToken, deleteToken } from "./apiTokenService.js";
import {
  isAzureProvider,
  listModels,
  matchModelId,
  pickDefaultModel,
  probeToolCalling,
  type LlmConfig,
  type ToolCallingSupport,
} from "./llmService.js";
import {
  FUNCTION_KEYS,
  keySupportsLevel,
  hasPermission,
  assertNoPrivilegeEscalation,
  type AccessLevel,
} from "../api/middleware/permissions.js";

/**
 * Keys the bot role never reads, even though they have a read rung: stored
 * credentials, the token list, accounts, roles, how people sign in, the
 * automation-script registry (script bodies), server administration — and the
 * assistant widget, which a token has no user to drive.
 */
export const BOT_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  "credentials",
  "apiTokens",
  "users",
  "roles",
  "authentication",
  "automationScripts",
  "serverSettingsSystem",
  "serverSettingsData",
  "assistant",
]);

/** The bot role's matrix: read wherever a read rung exists and the key is not excluded. */
export function botPermissions(): Record<string, AccessLevel> {
  const out: Record<string, AccessLevel> = {};
  for (const def of FUNCTION_KEYS) {
    out[def.key] = !BOT_EXCLUDED_KEYS.has(def.key) && keySupportsLevel(def.key, "read") ? "read" : "none";
  }
  return out;
}

/** `llm-<slug>`, fitting roleService's ^[A-Za-z0-9_-]{2,32}$. Exported for tests. */
export function botRoleBaseName(integrationName: string): string {
  const slug = integrationName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return `llm-${slug || "assistant"}`;
}

async function uniqueRoleName(base: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base.slice(0, 28)}-${i + 1}`;
    const clash = await prisma.role.findFirst({ where: { name: { equals: candidate, mode: "insensitive" } }, select: { id: true } });
    if (!clash) return candidate;
  }
  throw new AppError(409, "Could not find a free role name for the AI Assistant integration");
}

async function uniqueTokenName(base: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base} (${i + 1})`;
    const clash = await prisma.apiToken.findUnique({ where: { name: candidate }, select: { id: true } });
    if (!clash) return candidate;
  }
  throw new AppError(409, "Could not find a free token name for the AI Assistant integration");
}

/**
 * The caller must be able to do by hand what this does automatically: create
 * a role and mint a token. Checked BEFORE the integration row is written.
 */
export function assertCanProvision(req: Request): void {
  if (!hasPermission(req, "roles", "write") || !hasPermission(req, "apiTokens", "write")) {
    throw new AppError(
      403,
      "Forbidden — creating an AI Assistant integration also creates a read-only role and an API token for the LLM server, " +
        "which needs Roles Read-Write and API Tokens Read-Write. Ask an administrator.",
    );
  }
  // The bot role is never admin-equivalent, so this is a no-op today; it is
  // here so a future change to botPermissions() cannot quietly break rule 48.
  assertNoPrivilegeEscalation(req, botPermissions(), "the AI Assistant integration's role");
}

export interface ProvisionResult {
  roleId: string;
  roleName: string;
  tokenId: string;
  tokenName: string;
  rawToken: string;
}

export async function provisionLlmAccess(
  integration: { id: string; name: string },
  actor: string,
): Promise<ProvisionResult> {
  const roleName = await uniqueRoleName(botRoleBaseName(integration.name));
  const role = await createRole({
    name: roleName,
    description: `Read-only access for the "${integration.name}" AI Assistant integration's API token. Managed by that integration.`,
    permissions: botPermissions(),
  }, actor);
  try {
    const tokenName = await uniqueTokenName(`LLM: ${integration.name}`.slice(0, 100));
    const { token, rawToken } = await createToken({ name: tokenName, roleId: role.id, createdBy: actor });
    await logEvent({
      action: "integration.llm.provisioned",
      resourceType: "integration",
      resourceId: integration.id,
      resourceName: integration.name,
      actor,
      message: `AI Assistant integration "${integration.name}" provisioned read-only role "${roleName}" and API token "${tokenName}"`,
      details: { roleId: role.id, tokenId: token.id },
    });
    return { roleId: role.id, roleName, tokenId: token.id, tokenName, rawToken };
  } catch (err) {
    // Don't strand a role with no token behind a failed create.
    await deleteRole(role.id, actor).catch(() => {});
    throw err;
  }
}

/** Revoke-by-delete the old token and mint a fresh one on the same role. */
export async function regenerateLlmToken(
  integration: { id: string; name: string; config: Record<string, unknown> },
  actor: string,
): Promise<{ tokenId: string; tokenName: string; rawToken: string; roleName: string }> {
  const roleId = typeof integration.config.roleId === "string" ? integration.config.roleId : null;
  const role = roleId ? await prisma.role.findUnique({ where: { id: roleId }, select: { id: true, name: true } }) : null;
  if (!role) {
    throw new AppError(409, "This integration's role no longer exists — delete and re-create the integration to provision a new one");
  }
  const oldTokenId = typeof integration.config.tokenId === "string" ? integration.config.tokenId : null;
  if (oldTokenId) await deleteToken(oldTokenId).catch(() => {});
  const tokenName = await uniqueTokenName(`LLM: ${integration.name}`.slice(0, 100));
  const { token, rawToken } = await createToken({ name: tokenName, roleId: role.id, createdBy: actor });
  await logEvent({
    action: "integration.llm.token_regenerated",
    resourceType: "integration",
    resourceId: integration.id,
    resourceName: integration.name,
    actor,
    level: "warning",
    message: `API token for AI Assistant integration "${integration.name}" regenerated — the previous token no longer works`,
    details: { oldTokenId, tokenId: token.id },
  });
  return { tokenId: token.id, tokenName, rawToken, roleName: role.name };
}

// ─── Tool-calling check after save ───────────────────────────────────────────

export interface LlmToolCheck {
  /** The model that was asked — the configured one, or the server's default pick for a blank Model. */
  model: string;
  result: ToolCallingSupport;
  at: string;
}

/**
 * Run "Check tool calling" against the model a saved integration will chat
 * with, and stamp the outcome on its config as `toolCheck` (server-owned —
 * PUT preserves it, a client cannot set it). The integration card reads it,
 * so an operator sees on the card whether lookups will work rather than
 * finding out from a chat that answers without looking anything up.
 * Throws when the server cannot be reached; that is not a verdict on the model.
 */
export async function checkLlmToolCalling(integrationId: string, actor: string): Promise<LlmToolCheck> {
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { id: true, name: true, type: true, config: true },
  });
  if (!integration) throw new AppError(404, "Integration not found");
  if (integration.type !== "llm") throw new AppError(400, "Only AI Assistant integrations have a tool-calling check");
  const config = (integration.config ?? {}) as Record<string, unknown> & LlmConfig;

  const configured = (config.model ?? "").trim();
  let model: string | null;
  if (isAzureProvider(config)) {
    // Foundry cannot list deployments; Model IS the deployment name.
    model = configured || null;
    if (!model) throw new AppError(409, "Set Model on the integration to the Azure deployment name");
  } else {
    const models = await listModels(config);
    model = configured ? (matchModelId(models.map((m) => m.id), configured) ?? configured) : pickDefaultModel(models);
    if (!model) throw new AppError(409, "The LLM server lists no chat model — set Model on the integration");
  }

  const result = await probeToolCalling(config, model);
  const toolCheck: LlmToolCheck = { model, result, at: new Date().toISOString() };
  // Re-read before writing so an edit saved during the (up to 90 s) probe is kept.
  const fresh = await prisma.integration.findUnique({ where: { id: integrationId }, select: { config: true } });
  if (fresh) {
    await prisma.integration.update({
      where: { id: integrationId },
      data: { config: { ...(fresh.config as Record<string, unknown>), toolCheck } as any },
    });
  }
  await logEvent({
    action: "integration.llm.tool_check",
    resourceType: "integration",
    resourceId: integration.id,
    resourceName: integration.name,
    actor,
    level: result === "no" ? "warning" : "info",
    message: result === "yes"
      ? `AI Assistant "${integration.name}": model "${model}" calls tools — lookups will work`
      : result === "no"
        ? `AI Assistant "${integration.name}": model "${model}" did NOT call a tool — the assistant can chat but cannot look anything up`
        : `AI Assistant "${integration.name}": tool calling for model "${model}" could not be determined`,
    details: { model, result },
  });
  return toolCheck;
}

/**
 * Remove what provisionLlmAccess created. Best-effort per step: an operator
 * who already deleted the token or reassigned the role by hand must still be
 * able to delete the integration.
 */
export async function deprovisionLlmAccess(
  integration: { id: string; name: string; config: Record<string, unknown> },
  actor: string,
): Promise<void> {
  const tokenId = typeof integration.config.tokenId === "string" ? integration.config.tokenId : null;
  const roleId = typeof integration.config.roleId === "string" ? integration.config.roleId : null;
  const problems: string[] = [];
  if (tokenId) {
    await deleteToken(tokenId).catch((err: Error) => {
      if (!(err instanceof AppError && err.httpStatus === 404)) problems.push(`token: ${err.message}`);
    });
  }
  if (roleId) {
    await deleteRole(roleId, actor).catch((err: Error) => {
      if (!(err instanceof AppError && err.httpStatus === 404)) problems.push(`role: ${err.message}`);
    });
  }
  await logEvent({
    action: "integration.llm.deprovisioned",
    resourceType: "integration",
    resourceId: integration.id,
    resourceName: integration.name,
    actor,
    level: problems.length ? "warning" : "info",
    message: problems.length
      ? `AI Assistant integration "${integration.name}" removed; clean-up left something behind (${problems.join("; ")})`
      : `AI Assistant integration "${integration.name}" removed its API token and role`,
  });
}

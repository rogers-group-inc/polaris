/**
 * src/services/apiTokenService.ts — Bearer-token authentication for
 * external callers (e.g. SIEM systems invoking quarantine, NOC kiosks,
 * read-only inventory consumers).
 *
 * Each token is bound to a Role at mint time; requirePermission resolves
 * the token's role matrix exactly like a session role snapshot, so the
 * token can reach whatever the chosen role grants and nothing else.
 * (The prior fixed scope-string list — assets:read / dashboard:read /
 * assets:quarantine — was retired in migration 20260706000000; legacy
 * tokens were mapped onto seeded api-* roles with matching matrices.)
 *
 * Binding a token to an admin-equivalent role is allowed but logs a
 * warning Event — a leaked token would be a full-control credential.
 *
 * The raw token is shown ONCE at creation; only the argon2id hash is
 * stored. Lookup cost is bounded by the number of non-revoked,
 * non-expired tokens sharing the 8-char prefix (small N in practice).
 *
 * Wire format: `Authorization: Bearer polaris_<32-char-base62-tail>`.
 *
 * Trusted hosts: a token may name the source addresses it is accepted from
 * (bare IPs or CIDRs, matched against the trust-proxy-resolved req.ip). Empty
 * = any source. The check runs AFTER the hash matches, so only a holder of the
 * real token learns that it was refused for its source address — and that
 * refusal is a 403 naming the address Polaris saw, because "my SIEM gets 401"
 * with no further clue is the support call this feature would otherwise cause
 * (a reverse proxy without trust-proxy set makes every caller 127.0.0.1).
 */

import { TOKEN_PREFIX, generateRawToken } from "../utils/bearerToken.js";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import { logEvent } from "./eventLogService.js";
import { ipMatchesAllowlist, isValidAllowlistEntry } from "../utils/ipAllowlist.js";
import { detectIpVersion, isValidIpAddress, normalizeCidr } from "../utils/cidr.js";
import {
  normalizePermissions,
  isAdminEquivalentPermissions,
  type AccessLevel,
} from "../api/middleware/permissions.js";


export interface ApiTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  roleId: string;
  roleName: string;
  integrationIds: string[];
  trustedHosts: string[];
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  revokedAt: Date | null;
  revokedBy: string | null;
}

export interface AuthenticatedToken {
  id: string;
  name: string;
  roleId: string;
  integrationIds: string[];
}

export interface CreateTokenInput {
  name: string;
  roleId: string;
  integrationIds?: string[];
  trustedHosts?: string[];
  expiresAt?: Date | null;
  createdBy: string;
}

const QUARANTINE_INTEGRATION_TYPES = new Set(["fortimanager", "fortigate"]);

function grantsQuarantineWrite(perms: Record<string, AccessLevel>): boolean {
  return perms.assetsQuarantine === "write" || perms.assetsQuarantine === "fullwrite";
}

async function validateIntegrationIds(
  needsIntegrations: boolean,
  integrationIds: string[],
): Promise<string[]> {
  if (!needsIntegrations) return [];
  if (integrationIds.length === 0) {
    throw new AppError(
      400,
      "Tokens whose role grants Asset Quarantine write must select at least one FortiManager or FortiGate integration",
    );
  }
  const unique = Array.from(new Set(integrationIds));
  const rows = await prisma.integration.findMany({
    where: { id: { in: unique } },
    select: { id: true, type: true },
  });
  const found = new Map(rows.map((r) => [r.id, r.type]));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new AppError(400, `Unknown integration id(s): ${missing.join(", ")}`);
  }
  const wrongType = unique.filter((id) => !QUARANTINE_INTEGRATION_TYPES.has(found.get(id) || ""));
  if (wrongType.length > 0) {
    throw new AppError(
      400,
      `Integration(s) ${wrongType.join(", ")} are not FortiManager or FortiGate — quarantine push only supports those types`,
    );
  }
  return unique;
}

/** Upper bound on a token's trusted-host list — a list this long is a network, not a host set. */
export const MAX_TRUSTED_HOSTS = 64;

/**
 * Validate and canonicalize an operator-entered trusted-host list: trims,
 * drops blanks, rejects anything that is not an IPv4/IPv6 address or CIDR
 * (a typo must fail the save, never sit in the list matching nothing),
 * zeroes host bits on IPv4 CIDRs ("10.1.2.5/24" → "10.1.2.0/24") and
 * de-duplicates. Empty in → empty out, which means "any source".
 */
export function normalizeTrustedHosts(raw: readonly string[] | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const item of raw) {
    let entry = String(item ?? "").trim().toLowerCase();
    if (!entry) continue;
    // isValidCidr checks only the prefix length of an IPv6 CIDR, so the
    // address half is validated here as well.
    const valid =
      isValidAllowlistEntry(entry) && isValidIpAddress(entry.includes("/") ? entry.split("/")[0] : entry);
    if (!valid) {
      invalid.push(entry);
      continue;
    }
    if (entry.includes("/") && detectIpVersion(entry) === "v4") entry = normalizeCidr(entry);
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  if (invalid.length > 0) {
    throw new AppError(
      400,
      `Invalid trusted host${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")} — each must be an IP address or a CIDR such as 10.20.0.0/16`,
    );
  }
  if (out.length > MAX_TRUSTED_HOSTS) {
    throw new AppError(400, `A token may list at most ${MAX_TRUSTED_HOSTS} trusted hosts — use a wider CIDR instead`);
  }
  return out;
}

export interface CreateTokenResult {
  token: ApiTokenSummary;
  rawToken: string; // Shown ONCE; never recoverable later.
}

export async function createToken(input: CreateTokenInput): Promise<CreateTokenResult> {
  if (!input.name?.trim()) throw new AppError(400, "Token name is required");
  if (!input.roleId?.trim()) throw new AppError(400, "Token role is required");

  const role = await prisma.role.findUnique({ where: { id: input.roleId } });
  if (!role) throw new AppError(400, `Role ${input.roleId} not found`);
  const perms = normalizePermissions(role.permissions);

  const existing = await prisma.apiToken.findUnique({ where: { name: input.name.trim() } });
  if (existing) throw new AppError(409, `A token named "${input.name}" already exists`);

  const integrationIds = await validateIntegrationIds(
    grantsQuarantineWrite(perms),
    input.integrationIds ?? [],
  );

  const trustedHosts = normalizeTrustedHosts(input.trustedHosts);

  const raw = generateRawToken();
  const tokenHash = await hashPassword(raw);
  const tokenPrefix = raw.slice(0, TOKEN_PREFIX.length + 8); // "polaris_xxxxxxxx"

  const row = await prisma.apiToken.create({
    data: {
      name: input.name.trim(),
      tokenHash,
      tokenPrefix,
      roleId: role.id,
      integrationIds,
      trustedHosts,
      createdBy: input.createdBy,
      expiresAt: input.expiresAt ?? null,
    },
    include: { role: { select: { name: true } } },
  });

  // Same posture as groupMappingService: an admin-equivalent binding is
  // allowed but leaves a loud audit trail — a leaked long-lived token bound
  // to this role is a full-control credential.
  if (isAdminEquivalentPermissions(perms)) {
    void logEvent({
      action: "api_token.admin_equivalent",
      resourceType: "api_token",
      resourceId: row.id,
      resourceName: row.name,
      actor: input.createdBy,
      level: "warning",
      message: `API token "${row.name}" is bound to admin-equivalent role "${role.name}" — anyone holding this token has full control of Polaris`,
    });
  }

  return { token: toSummary(row), rawToken: raw };
}

/**
 * The FMG/FortiGate rows the API Tokens tab's per-integration quarantine
 * picker renders (with each one's enabled + pushQuarantine-config flags, so
 * the UI can show the "push disabled" alert without a second round-trip
 * to /integrations).
 */
export async function listQuarantineIntegrations() {
  const rows = await prisma.integration.findMany({
    where: { type: { in: ["fortimanager", "fortigate"] } },
    select: { id: true, name: true, type: true, enabled: true, config: true },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => {
    const cfg = (r.config ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      enabled: r.enabled,
      pushQuarantineEnabled: cfg.pushQuarantine === true,
    };
  });
}

/**
 * Role catalogue for the "acts as role" dropdown — embedded in the tokens
 * listing (rather than the UI calling /api/v1/roles) so the tab renders for
 * any caller holding apiTokens=read regardless of their roles-function
 * access. grantsQuarantineWrite drives the integration-picker toggle;
 * adminEquivalent drives the "full control" warning banner.
 */
export async function listRoleChoices() {
  return (await prisma.role.findMany({ orderBy: { name: "asc" } })).map((r) => {
    const perms = normalizePermissions(r.permissions);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      grantsQuarantineWrite:
        perms.assetsQuarantine === "write" || perms.assetsQuarantine === "fullwrite",
      adminEquivalent: isAdminEquivalentPermissions(perms),
    };
  });
}

export async function listTokens(): Promise<ApiTokenSummary[]> {
  const rows = await prisma.apiToken.findMany({
    orderBy: { createdAt: "desc" },
    include: { role: { select: { name: true } } },
  });
  return rows.map(toSummary);
}

export interface UpdateTrustedHostsResult {
  token: ApiTokenSummary;
  before: string[];
}

/**
 * Replace a live token's trusted-host list — the one field editable after
 * mint, because a caller's address changing must not force re-issuing the
 * secret. Same validation as create; an empty list re-opens the token to
 * any source. A revoked token refuses (409): nothing can reach it any more.
 */
export async function updateTrustedHosts(id: string, raw: readonly string[]): Promise<UpdateTrustedHostsResult> {
  const trustedHosts = normalizeTrustedHosts(raw);
  const existing = await prisma.apiToken.findUnique({ where: { id }, select: { trustedHosts: true, revokedAt: true } });
  if (!existing) throw new AppError(404, "Token not found");
  if (existing.revokedAt) throw new AppError(409, "Token is revoked — its trusted hosts can no longer be changed");
  const row = await prisma.apiToken.update({
    where: { id },
    data: { trustedHosts },
    include: { role: { select: { name: true } } },
  });
  return { token: toSummary(row), before: existing.trustedHosts };
}

export async function revokeToken(id: string, revokedBy: string): Promise<void> {
  const row = await prisma.apiToken.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Token not found");
  if (row.revokedAt) throw new AppError(409, "Token is already revoked");
  await prisma.apiToken.update({
    where: { id },
    data: { revokedAt: new Date(), revokedBy },
  });
}

export async function deleteToken(id: string): Promise<void> {
  const row = await prisma.apiToken.findUnique({ where: { id }, select: { id: true } });
  if (!row) throw new AppError(404, "Token not found");
  await prisma.apiToken.delete({ where: { id } });
}

function toSummary(row: {
  id: string;
  name: string;
  tokenPrefix: string;
  roleId: string;
  role: { name: string };
  integrationIds: string[];
  trustedHosts: string[];
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  revokedAt: Date | null;
  revokedBy: string | null;
}): ApiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    roleId: row.roleId,
    roleName: row.role.name,
    integrationIds: row.integrationIds,
    trustedHosts: row.trustedHosts,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
  };
}

/**
 * Outcome of presenting a bearer token. `untrusted_host` is a REAL token
 * presented from an address outside its trustedHosts list — distinct from
 * "no such token" so the caller can answer 403 with the address it saw.
 */
export type TokenVerification =
  | { ok: true; token: AuthenticatedToken }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "untrusted_host"; tokenName: string; callerIp: string | null };

// One warning Event per (token, source address) per window — a leaked token
// replayed from outside its trusted hosts must leave a trail, but a client
// retrying every second must not write 3600 rows an hour.
const UNTRUSTED_EVENT_WINDOW_MS = 15 * 60 * 1000;
const UNTRUSTED_EVENT_MAX_KEYS = 1000;
const untrustedEventLoggedAt = new Map<string, number>();

function noteUntrustedHost(
  row: { id: string; name: string; trustedHosts: string[] },
  callerIp: string | null,
): void {
  const key = `${row.id}|${callerIp ?? ""}`;
  const now = Date.now();
  const last = untrustedEventLoggedAt.get(key);
  if (last !== undefined && now - last < UNTRUSTED_EVENT_WINDOW_MS) return;
  if (untrustedEventLoggedAt.size >= UNTRUSTED_EVENT_MAX_KEYS) untrustedEventLoggedAt.clear();
  untrustedEventLoggedAt.set(key, now);
  void logEvent({
    action: "api_token.untrusted_host",
    resourceType: "api_token",
    resourceId: row.id,
    resourceName: row.name,
    actor: `api:${row.name}`,
    level: "warning",
    message: `API token "${row.name}" was presented from ${callerIp || "an unknown address"}, which is not one of its trusted hosts (${row.trustedHosts.join(", ")}) — request refused`,
    details: { callerIp, trustedHosts: row.trustedHosts },
  });
}

/** Test hook: forget which (token, address) pairs have already logged. */
export function _resetUntrustedHostEventThrottle(): void {
  untrustedEventLoggedAt.clear();
}

/**
 * Verify a presented bearer token. Walks every live (non-revoked, non-
 * expired) token row sharing the prefix and verifies argon2id against
 * each. A match whose trustedHosts list is non-empty must also come from
 * an address in that list (`ipMatchesAllowlist`, fail closed on an unknown
 * address); otherwise the result is `untrusted_host`, lastUsed is NOT
 * bumped, and a throttled warning Event is written.
 *
 * On success, lastUsedAt + lastUsedIp are bumped opportunistically (best-
 * effort — failure here doesn't fail auth).
 */
export async function verifyToken(rawToken: string, callerIp: string | null): Promise<TokenVerification> {
  if (!rawToken || !rawToken.startsWith(TOKEN_PREFIX)) return { ok: false, reason: "invalid" };

  const candidates = await prisma.apiToken.findMany({
    where: {
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      tokenPrefix: rawToken.slice(0, TOKEN_PREFIX.length + 8),
    },
  });

  for (const row of candidates) {
    const { valid } = await verifyPassword(rawToken, row.tokenHash);
    if (!valid) continue;

    if (row.trustedHosts.length > 0 && !ipMatchesAllowlist(callerIp ?? undefined, row.trustedHosts)) {
      noteUntrustedHost(row, callerIp);
      return { ok: false, reason: "untrusted_host", tokenName: row.name, callerIp };
    }

    // Best-effort lastUsed bump.
    prisma.apiToken
      .update({
        where: { id: row.id },
        data: { lastUsedAt: new Date(), lastUsedIp: callerIp ?? null },
      })
      .catch(() => {
        /* ignore */
      });

    return {
      ok: true,
      token: { id: row.id, name: row.name, roleId: row.roleId, integrationIds: row.integrationIds },
    };
  }
  return { ok: false, reason: "invalid" };
}

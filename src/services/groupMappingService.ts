/**
 * src/services/groupMappingService.ts
 *
 * CRUD over the GroupMapping table + the login-time resolver that turns a
 * user's IdP group claims into a role + region/other tags.
 *
 * A GroupMapping maps one IdP group (scoped by `provider`) to an optional
 * Polaris role plus region tags and free-form "other" tags. At SSO/LDAP login
 * the user's group claims are matched against the enabled mappings for that
 * provider; the matched mappings' tags union into the user's effective scope,
 * and the HIGHEST-PRIVILEGE matched role wins (see rankRole). A mapping with a
 * null roleId is tags-only.
 *
 * SECURITY: a mapping targeting an admin-equivalent role makes IdP group
 * membership a path to Polaris admin. We allow it (the operator asked for
 * highest-privilege-wins) but stamp a warning-level Event so it's auditable.
 *
 * Every write emits a `groupMapping.*` Event and invalidates the 30s
 * enabled-mappings cache the resolver reads.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { normalizeTags, unionTags } from "../utils/tagNormalize.js";
import {
  normalizePermissions,
  isAdminEquivalentPermissions,
  pickHighestPrivilegeRoleId,
} from "../api/middleware/permissions.js";

export const GROUP_MAPPING_PROVIDERS = ["oidc", "ldap", "saml", "entra-proxy"] as const;
export type GroupMappingProvider = (typeof GROUP_MAPPING_PROVIDERS)[number];

const GROUP_KEY_MAX_LEN = 512; // LDAP DNs can be long
const DESCRIPTION_MAX = 200;

export interface GroupMappingSummary {
  id: string;
  provider: string;
  groupKey: string;
  groupLabel: string | null;
  roleId: string | null;
  roleName: string | null;
  regionTags: string[];
  otherTags: string[];
  enabled: boolean;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateGroupMappingInput {
  provider: string;
  groupKey: string; // raw, as the operator typed it
  roleId?: string | null;
  regionTags?: string[];
  otherTags?: string[];
  enabled?: boolean;
  description?: string | null;
}

export interface UpdateGroupMappingInput {
  groupKey?: string;
  roleId?: string | null;
  regionTags?: string[];
  otherTags?: string[];
  enabled?: boolean;
  description?: string | null;
}

export interface ResolvedGroupAccess {
  roleId: string | null;
  regionTags: string[];
  otherTags: string[];
  matchedGroups: string[]; // normalized keys that matched (for ssoGroups + Event)
}

function isValidProvider(p: string): p is GroupMappingProvider {
  return (GROUP_MAPPING_PROVIDERS as readonly string[]).includes(p);
}

/**
 * Translate a User.authProvider value to the group-mapping provider key its
 * groups resolve under. The two vocabularies differ in exactly one place:
 * SAML logins stamp authProvider "azure" but their mappings live under
 * "saml" (the protocol name the Group Mappings UI offers). Everything else
 * is identity — including values (like "local") that aren't mapping
 * providers at all; resolveGroupsToAccess returns empty for those.
 */
export function mappingProviderForAuthProvider(authProvider: string): string {
  return authProvider === "azure" ? "saml" : authProvider;
}

function assertValidProvider(p: string): GroupMappingProvider {
  if (!isValidProvider(p)) {
    throw new AppError(400, `Unknown group-mapping provider "${p}" (expected one of ${GROUP_MAPPING_PROVIDERS.join(", ")})`);
  }
  return p;
}

/**
 * Normalize a group identifier for matching. LDAP DNs are case-insensitive, so
 * we lowercase + trim them; entra-proxy group keys are Entra group object-ID
 * GUIDs, also case-insensitive, so they lowercase too. OIDC/SAML group claim
 * values are case-stable, so we trim only. The SAME function is used on write
 * (the stored groupKey) and on read (incoming claims) so the two can never
 * diverge. Returns "" for blanks.
 */
export function normalizeGroupKey(provider: string, raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return provider === "ldap" || provider === "entra-proxy" ? trimmed.toLowerCase() : trimmed;
}

function normalizeDescription(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  if (trimmed.length > DESCRIPTION_MAX) {
    throw new AppError(400, `Description must be ≤ ${DESCRIPTION_MAX} characters`);
  }
  return trimmed;
}

function summarize(row: {
  id: string;
  provider: string;
  groupKey: string;
  groupLabel: string | null;
  roleId: string | null;
  regionTags: string[];
  otherTags: string[];
  enabled: boolean;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  role?: { name: string } | null;
}): GroupMappingSummary {
  return {
    id: row.id,
    provider: row.provider,
    groupKey: row.groupKey,
    groupLabel: row.groupLabel,
    roleId: row.roleId,
    roleName: row.role?.name ?? null,
    regionTags: [...row.regionTags],
    otherTags: [...row.otherTags],
    enabled: row.enabled,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Enabled-mappings cache (read by the login resolver) ────────────────

interface CachedRows {
  at: number;
  rows: { groupKey: string; roleId: string | null; regionTags: string[]; otherTags: string[] }[];
}
const ENABLED_CACHE_TTL_MS = 30_000;
const enabledCache = new Map<string, CachedRows>();

function invalidateCache(): void {
  enabledCache.clear();
}

/** Test hook: drop the enabled-mappings cache so rows seeded via raw Prisma are visible. */
export function invalidateGroupMappingCacheForTests(): void {
  invalidateCache();
}

async function getEnabledMappings(provider: string) {
  const cached = enabledCache.get(provider);
  if (cached && Date.now() - cached.at < ENABLED_CACHE_TTL_MS) return cached.rows;
  const rows = await prisma.groupMapping.findMany({
    where: { provider, enabled: true },
    select: { groupKey: true, roleId: true, regionTags: true, otherTags: true },
  });
  enabledCache.set(provider, { at: Date.now(), rows });
  return rows;
}

// ─── Resolver ───────────────────────────────────────────────────────────

/**
 * Resolve a user's IdP groups to a role + tags. Returns an all-empty result
 * (roleId null, no tags) when the provider is unknown, no groups are supplied,
 * or nothing matches — callers fall back to the default role in that case.
 */
export async function resolveGroupsToAccess(provider: string, groupNames: unknown): Promise<ResolvedGroupAccess> {
  const empty: ResolvedGroupAccess = { roleId: null, regionTags: [], otherTags: [], matchedGroups: [] };
  if (!isValidProvider(provider)) return empty;
  if (!Array.isArray(groupNames) || groupNames.length === 0) return empty;

  const incoming = new Set<string>();
  for (const g of groupNames) {
    const k = normalizeGroupKey(provider, g);
    if (k) incoming.add(k);
  }
  if (incoming.size === 0) return empty;

  const mappings = await getEnabledMappings(provider);
  const matched = mappings.filter((m) => incoming.has(m.groupKey));
  if (matched.length === 0) return empty;

  const regionTags = unionTags(...matched.map((m) => m.regionTags));
  const otherTags = unionTags(...matched.map((m) => m.otherTags));
  const matchedGroups = matched.map((m) => m.groupKey);

  // Highest-privilege role among matched mappings that name a role.
  const roleIds = [...new Set(matched.map((m) => m.roleId).filter((x): x is string => !!x))];
  let roleId: string | null = null;
  if (roleIds.length === 1) {
    roleId = roleIds[0];
  } else if (roleIds.length > 1) {
    const roles = await prisma.role.findMany({
      where: { id: { in: roleIds } },
      select: { id: true, permissions: true },
    });
    roleId = pickHighestPrivilegeRoleId(roles);
  }

  return { roleId, regionTags, otherTags, matchedGroups };
}

// ─── CRUD ─────────────────────────────────────────────────────────────

export async function listGroupMappings(provider?: string): Promise<GroupMappingSummary[]> {
  const rows = await prisma.groupMapping.findMany({
    where: provider ? { provider } : undefined,
    include: { role: { select: { name: true } } },
    orderBy: [{ provider: "asc" }, { groupKey: "asc" }],
  });
  return rows.map(summarize);
}

export async function getGroupMapping(id: string): Promise<GroupMappingSummary> {
  const row = await prisma.groupMapping.findUnique({
    where: { id },
    include: { role: { select: { name: true } } },
  });
  if (!row) throw new AppError(404, `Group mapping ${id} not found`);
  return summarize(row);
}

// Returns the role's name when it grants admin-equivalent control, else null.
// Used to stamp a warning Event when a mapping points at an admin role.
async function adminEquivalentRoleName(roleId: string | null | undefined): Promise<string | null> {
  if (!roleId) return null;
  const role = await prisma.role.findUnique({ where: { id: roleId }, select: { name: true, permissions: true } });
  if (!role) throw new AppError(400, `Role ${roleId} not found`);
  return isAdminEquivalentPermissions(normalizePermissions(role.permissions)) ? role.name : null;
}

export async function createGroupMapping(input: CreateGroupMappingInput, actor?: string): Promise<GroupMappingSummary> {
  const provider = assertValidProvider(input.provider);
  const label = typeof input.groupKey === "string" ? input.groupKey.trim() : "";
  const groupKey = normalizeGroupKey(provider, input.groupKey);
  if (!groupKey) throw new AppError(400, "Group identifier is required");
  if (label.length > GROUP_KEY_MAX_LEN) {
    throw new AppError(400, `Group identifier exceeds ${GROUP_KEY_MAX_LEN} characters`);
  }
  const regionTags = normalizeTags(input.regionTags, "region tag");
  const otherTags = normalizeTags(input.otherTags, "tag");
  const description = normalizeDescription(input.description);
  const roleId = input.roleId || null;
  const adminRoleName = await adminEquivalentRoleName(roleId);

  let created;
  try {
    created = await prisma.groupMapping.create({
      data: {
        provider,
        groupKey,
        groupLabel: label || groupKey,
        roleId,
        regionTags,
        otherTags,
        enabled: input.enabled ?? true,
        description,
      },
      include: { role: { select: { name: true } } },
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      throw new AppError(409, `A ${provider} group mapping for "${label || groupKey}" already exists`);
    }
    throw err;
  }
  invalidateCache();

  await logEvent({
    action: "groupMapping.created",
    resourceType: "groupMapping",
    resourceId: created.id,
    resourceName: created.groupLabel || created.groupKey,
    actor,
    level: adminRoleName ? "warning" : undefined,
    message: adminRoleName
      ? `Group mapping "${created.groupLabel}" (${provider}) created — grants ADMIN-equivalent role "${adminRoleName}" to IdP group members`
      : `Group mapping "${created.groupLabel}" (${provider}) created`,
    details: { provider, groupKey, roleId, regionTags, otherTags, enabled: created.enabled },
  });

  return summarize(created);
}

/** The role a mapping (or a role id) would grant: its name and matrix, for the rule 114(g) check. Null when none. */
export async function roleGrantFor(roleId: string | null | undefined): Promise<{ name: string; permissions: unknown } | null> {
  if (!roleId) return null;
  return prisma.role.findUnique({ where: { id: roleId }, select: { name: true, permissions: true } });
}

/** What a stored mapping grants and to whom, before an edit (rule 114(g)). Null for an unknown id. */
export async function mappingGrantState(id: string): Promise<{ roleId: string | null; groupKey: string; groupLabel: string | null; enabled: boolean } | null> {
  return prisma.groupMapping.findUnique({ where: { id }, select: { roleId: true, groupKey: true, groupLabel: true, enabled: true } });
}

export async function updateGroupMapping(id: string, input: UpdateGroupMappingInput, actor?: string): Promise<GroupMappingSummary> {
  const before = await prisma.groupMapping.findUnique({ where: { id } });
  if (!before) throw new AppError(404, `Group mapping ${id} not found`);

  const data: {
    groupKey?: string;
    groupLabel?: string;
    roleId?: string | null;
    regionTags?: string[];
    otherTags?: string[];
    enabled?: boolean;
    description?: string | null;
  } = {};
  const diff: Record<string, { from: unknown; to: unknown }> = {};

  if (input.groupKey !== undefined) {
    const label = input.groupKey.trim();
    const nextKey = normalizeGroupKey(before.provider, input.groupKey);
    if (!nextKey) throw new AppError(400, "Group identifier is required");
    if (label.length > GROUP_KEY_MAX_LEN) throw new AppError(400, `Group identifier exceeds ${GROUP_KEY_MAX_LEN} characters`);
    if (nextKey !== before.groupKey || label !== before.groupLabel) {
      data.groupKey = nextKey;
      data.groupLabel = label || nextKey;
      diff.groupKey = { from: before.groupLabel || before.groupKey, to: label || nextKey };
    }
  }
  let nextRoleId = before.roleId;
  if (input.roleId !== undefined) {
    nextRoleId = input.roleId || null;
    if (nextRoleId !== before.roleId) {
      data.roleId = nextRoleId;
      diff.roleId = { from: before.roleId, to: nextRoleId };
    }
  }
  if (input.regionTags !== undefined) {
    const next = normalizeTags(input.regionTags, "region tag");
    const prev = [...before.regionTags];
    if (!(next.length === prev.length && next.every((v, i) => v === prev[i]))) {
      data.regionTags = next;
      diff.regionTags = { from: prev, to: next };
    }
  }
  if (input.otherTags !== undefined) {
    const next = normalizeTags(input.otherTags, "tag");
    const prev = [...before.otherTags];
    if (!(next.length === prev.length && next.every((v, i) => v === prev[i]))) {
      data.otherTags = next;
      diff.otherTags = { from: prev, to: next };
    }
  }
  if (input.enabled !== undefined && input.enabled !== before.enabled) {
    data.enabled = input.enabled;
    diff.enabled = { from: before.enabled, to: input.enabled };
  }
  if (input.description !== undefined) {
    const next = normalizeDescription(input.description);
    if (next !== before.description) {
      data.description = next;
      diff.description = { from: before.description, to: next };
    }
  }

  if (Object.keys(data).length === 0) return getGroupMapping(id);

  // Validate (and detect admin-equivalence of) the resulting role.
  const adminRoleName = await adminEquivalentRoleName(nextRoleId);

  let updated;
  try {
    updated = await prisma.groupMapping.update({
      where: { id },
      data,
      include: { role: { select: { name: true } } },
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      throw new AppError(409, `A ${before.provider} group mapping for that group already exists`);
    }
    throw err;
  }
  invalidateCache();

  await logEvent({
    action: "groupMapping.updated",
    resourceType: "groupMapping",
    resourceId: updated.id,
    resourceName: updated.groupLabel || updated.groupKey,
    actor,
    level: adminRoleName ? "warning" : undefined,
    message: adminRoleName
      ? `Group mapping "${updated.groupLabel}" (${updated.provider}) updated — grants ADMIN-equivalent role "${adminRoleName}" to IdP group members`
      : `Group mapping "${updated.groupLabel}" (${updated.provider}) updated`,
    details: { diff },
  });

  return summarize(updated);
}

export async function deleteGroupMapping(id: string, actor?: string): Promise<void> {
  const before = await prisma.groupMapping.findUnique({ where: { id } });
  if (!before) throw new AppError(404, `Group mapping ${id} not found`);
  await prisma.groupMapping.delete({ where: { id } });
  invalidateCache();

  await logEvent({
    action: "groupMapping.deleted",
    resourceType: "groupMapping",
    resourceId: id,
    resourceName: before.groupLabel || before.groupKey,
    actor,
    message: `Group mapping "${before.groupLabel || before.groupKey}" (${before.provider}) deleted`,
  });
}

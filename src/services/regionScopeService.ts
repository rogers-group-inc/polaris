/**
 * src/services/regionScopeService.ts
 *
 * Shared resolver for a user's effective region/other tag scope —
 * union(role tags, user tags, group-derived tags). Extracted from the
 * GET /auth/me handler so the notifications list (and any future
 * region-scoped surface) computes scope identically.
 *
 * Group-derived tags are re-resolved live from the user's last-seen SSO
 * groups (never persisted onto the user's own columns), so a GroupMapping
 * edit takes effect without re-login.
 *
 * It also owns the WRITE side of the same three columns: carrying a map-region
 * rename into them, and reporting who a region delete strands. See the section
 * comment further down for why that lives here and not in mapRegionService.
 */

import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { resolveGroupsToAccess, mappingProviderForAuthProvider } from "./groupMappingService.js";
import { unionTags, renameTagInList } from "../utils/tagNormalize.js";

export interface TagScope {
  user: string[];
  role: string[];
  group: string[];
  effective: string[];
}

export interface UserTagScopes {
  regionTags: TagScope;
  otherTags: TagScope;
}

/**
 * A user row already loaded with its role. Accepts the minimal shape so
 * callers that already hold a `prisma.user.findUnique({ include: { role } })`
 * result (e.g. /auth/me) don't pay a second query.
 */
interface UserWithRoleTags {
  regionTags: string[] | null;
  otherTags: string[] | null;
  ssoGroups: string[] | null;
  authProvider: string;
  role: { regionTags: string[] | null; otherTags: string[] | null };
}

/** Compute both tag-scope dimensions for an already-loaded user+role. */
export async function resolveTagScopesForUser(u: UserWithRoleTags): Promise<UserTagScopes> {
  const userRegions = Array.isArray(u.regionTags) ? u.regionTags : [];
  const roleRegions = Array.isArray(u.role.regionTags) ? u.role.regionTags : [];
  const userOther = Array.isArray(u.otherTags) ? u.otherTags : [];
  const roleOther = Array.isArray(u.role.otherTags) ? u.role.otherTags : [];

  let groupRegions: string[] = [];
  let groupOther: string[] = [];
  if (Array.isArray(u.ssoGroups) && u.ssoGroups.length > 0) {
    // authProvider "azure" resolves under the "saml" mapping provider —
    // SAML logins write ssoGroups too since the 2026-08 provisioning fold.
    const access = await resolveGroupsToAccess(mappingProviderForAuthProvider(u.authProvider), u.ssoGroups);
    groupRegions = access.regionTags;
    groupOther = access.otherTags;
  }

  return {
    regionTags: {
      user: userRegions,
      role: roleRegions,
      group: groupRegions,
      effective: unionTags(roleRegions, userRegions, groupRegions),
    },
    otherTags: {
      user: userOther,
      role: roleOther,
      group: groupOther,
      effective: unionTags(roleOther, userOther, groupOther),
    },
  };
}

/**
 * Effective region tags for a user id. Empty array means "unrestricted"
 * (no region scoping applies — the caller sees everything). One indexed PK
 * lookup + (for SSO users) one cached group resolution.
 */
export async function getEffectiveRegionTags(userId: string): Promise<string[]> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    include: { role: true },
  });
  if (!u) return [];
  const scopes = await resolveTagScopesForUser(u);
  return scopes.regionTags.effective;
}

/**
 * Both effective scope dimensions for a user id — the region names and the
 * free-form scope tags their role, account and sign-in groups give them —
 * for surfaces that DESCRIBE a person's scope (the AI assistant's prompt).
 * Unlike the alert scoping, administrators are not treated as unscoped here:
 * an admin with regions assigned still has regions of their own.
 */
export async function getEffectiveTagScopes(userId: string): Promise<{ regions: string[]; tags: string[] }> {
  const u = await prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
  if (!u) return { regions: [], tags: [] };
  const scopes = await resolveTagScopesForUser(u);
  return { regions: scopes.regionTags.effective, tags: scopes.otherTags.effective };
}

// ─── The write side: a region's name changing, or going away ────────────────
//
// The three principal scope columns (`User.regionTags`, `Role.regionTags`,
// `GroupMapping.regionTags`) hold BARE region names and are deliberately not
// FK'd to any registry, so nothing in the database ties them to the region they
// name. `mapRegionService` rewrites asset tags, subnet tags and the `Tag`
// registry on a rename and never touched these — which meant a rename revoked
// every scoped operator's region without a word: the tag stayed in the column,
// matched no region, and the Users page filed it under "Unknown region tags (no
// longer in the map)".
//
// They live HERE rather than in mapRegionService because this module already
// owns the principal side of region scope (it is the one place that reads all
// three columns), and because mapRegionService is imported by jobs that have no
// business pulling in group-mapping resolution.

/** What a rename moved, named for the audit Event. */
export interface PrincipalScopeMoves {
  /** Usernames whose own scope was rewritten. */
  users: string[];
  /** Role names whose scope was rewritten. */
  roles: string[];
  /** `provider:groupKey` for each IdP mapping rewritten. */
  groupMappings: string[];
  total: number;
}

const emptyMoves = (): PrincipalScopeMoves => ({ users: [], roles: [], groupMappings: [], total: 0 });

/**
 * Carry a region rename into every principal's region scope.
 *
 * Matching is case-insensitive because every consumer that resolves a region
 * tag compares that way (`normalizeNeedle` in notificationRecipientService,
 * `key()` in regionHierarchyService, the Users page picker), so a tag differing
 * only in case is a live assignment and must move too.
 *
 * Scale: three `findMany`s over principal tables — users, roles and IdP group
 * mappings are operator-created and number in the tens to low hundreds even on
 * a 2000-asset install, so this reads them whole and filters in memory rather
 * than pushing a case-insensitive array predicate into SQL. Only rows that
 * actually change are written, batched into one transaction.
 *
 * Callers must invalidate the recipient index afterwards
 * (`notificationRecipientService.bumpRecipientIndex`) — imported there, not
 * here, because that module imports this one.
 */
export async function renameRegionInPrincipalScopes(
  previousName: string,
  nextName: string,
): Promise<PrincipalScopeMoves> {
  const from = String(previousName ?? "").trim();
  const to = String(nextName ?? "").trim();
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) return emptyMoves();

  const [users, roles, mappings] = await Promise.all([
    prisma.user.findMany({ select: { id: true, username: true, regionTags: true } }),
    prisma.role.findMany({ select: { id: true, name: true, regionTags: true } }),
    prisma.groupMapping.findMany({ select: { id: true, provider: true, groupKey: true, regionTags: true } }),
  ]);

  const moves = emptyMoves();
  const writes: Prisma.PrismaPromise<unknown>[] = [];

  for (const u of users) {
    const next = renameTagInList(u.regionTags, from, to);
    if (!next) continue;
    moves.users.push(u.username);
    writes.push(prisma.user.update({ where: { id: u.id }, data: { regionTags: next } }));
  }
  for (const r of roles) {
    const next = renameTagInList(r.regionTags, from, to);
    if (!next) continue;
    moves.roles.push(r.name);
    writes.push(prisma.role.update({ where: { id: r.id }, data: { regionTags: next } }));
  }
  for (const m of mappings) {
    const next = renameTagInList(m.regionTags, from, to);
    if (!next) continue;
    moves.groupMappings.push(`${m.provider}:${m.groupKey}`);
    writes.push(prisma.groupMapping.update({ where: { id: m.id }, data: { regionTags: next } }));
  }

  if (writes.length > 0) await prisma.$transaction(writes);
  moves.total = moves.users.length + moves.roles.length + moves.groupMappings.length;
  return moves;
}

/**
 * Which principals are scoped to `name` — the DELETE counterpart, which
 * deliberately only REPORTS.
 *
 * A delete is not a rename: there is no new name to move the assignment to, and
 * stripping it would destroy an operator's statement of who is answerable for
 * that area with nothing to restore it from (a region redrawn under the same
 * name is common). So the tag is left in place — the Users page already renders
 * it as removable — and the deletion Event names who is now holding a tag that
 * matches no region, which is the part that was invisible.
 */
export async function principalsScopedToRegion(name: string): Promise<PrincipalScopeMoves> {
  const key = String(name ?? "").trim().toLowerCase();
  if (!key) return emptyMoves();
  const holds = (tags: string[] | null) =>
    Array.isArray(tags) && tags.some((t) => String(t ?? "").trim().toLowerCase() === key);

  const [users, roles, mappings] = await Promise.all([
    prisma.user.findMany({ select: { username: true, regionTags: true } }),
    prisma.role.findMany({ select: { name: true, regionTags: true } }),
    prisma.groupMapping.findMany({ select: { provider: true, groupKey: true, regionTags: true } }),
  ]);

  const moves = emptyMoves();
  moves.users = users.filter((u) => holds(u.regionTags)).map((u) => u.username);
  moves.roles = roles.filter((r) => holds(r.regionTags)).map((r) => r.name);
  moves.groupMappings = mappings
    .filter((m) => holds(m.regionTags))
    .map((m) => `${m.provider}:${m.groupKey}`);
  moves.total = moves.users.length + moves.roles.length + moves.groupMappings.length;
  return moves;
}

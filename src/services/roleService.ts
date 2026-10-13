/**
 * src/services/roleService.ts
 *
 * CRUD over the Role table. Enforces the built-in / protected invariants:
 *   - isProtected (admin / readonly): cannot be edited, renamed, or deleted.
 *   - isBuiltIn (networkadmin / assetsadmin / user): can be edited, NOT deleted.
 *   - Custom roles: full edit + delete.
 *   - Delete refuses with 409 when any user holds the role (admin reassigns
 *     first) or any API token is bound to it (admin deletes the token first).
 *
 * Every write bumps the in-process role-version cache via bumpRoleVersion()
 * so live sessions holding the old snapshot refresh on their next request.
 *
 * Every write emits a `role.*` Event with the actor + per-field diff.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { normalizeTags } from "../utils/tagNormalize.js";
import {
  bumpRoleVersion,
  normalizePermissions,
  FUNCTION_KEYS,
  type AccessLevel,
} from "../api/middleware/permissions.js";

export interface RoleSummary {
  id: string;
  name: string;
  description: string | null;
  permissions: Record<string, AccessLevel>;
  // Region scope inherited by users holding this role. Empty = unrestricted.
  // Effective scope for a session is union(role, user, group-derived).
  regionTags: string[];
  // Free-form ("other") tag scope — a second dimension parallel to regionTags.
  otherTags: string[];
  // Badge color as `#rrggbb`, or null to fall back to the legacy name-keyed
  // badge classes in the frontend.
  color: string | null;
  isBuiltIn: boolean;
  isProtected: boolean;
  // Business rule 114(i): flagged for an administrator's grant review.
  grantReviewNeeded: boolean;
  userCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRoleInput {
  name: string;
  description?: string | null;
  permissions: Record<string, AccessLevel>;
  regionTags?: string[];
  otherTags?: string[];
  color?: string | null;
}

export interface UpdateRoleInput {
  name?: string;
  description?: string | null;
  permissions?: Record<string, AccessLevel>;
  regionTags?: string[];
  otherTags?: string[];
  color?: string | null;
}

// Tag values are operator-typed strings, normalized by the shared
// utils/tagNormalize helper (trim, drop empties, dedupe case-insensitively,
// cap length + count). Neither dimension is FK'd to a registry.
const normalizeRegionTags = (input: unknown): string[] => normalizeTags(input, "region tag");
const normalizeOtherTags = (input: unknown): string[] => normalizeTags(input, "tag");

const NAME_RE = /^[A-Za-z0-9_-]{2,32}$/;
const DESCRIPTION_MAX = 200;

function validateName(name: string): string {
  const trimmed = name.trim();
  if (!NAME_RE.test(trimmed)) {
    throw new AppError(400, "Role name must be 2-32 characters, letters / digits / dash / underscore only");
  }
  return trimmed;
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

// Badge color is a `#rrggbb` hex string (case-insensitive in, lowercased out).
// Empty/null clears the color → frontend falls back to its legacy name-keyed
// badge classes. Anything else that isn't a 6-digit hex is rejected.
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function normalizeColor(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  if (!COLOR_RE.test(trimmed)) {
    throw new AppError(400, "Role color must be a #rrggbb hex string");
  }
  return trimmed.toLowerCase();
}

// Protected names cannot be picked for new roles either — operators can't
// shadow the built-in identities even with a different case (the unique
// index is case-sensitive at the DB; we add a case-insensitive guard at
// the service layer).
const RESERVED_NAMES_LC = new Set(["admin", "readonly"]);

function summarize(role: {
  id: string;
  name: string;
  description: string | null;
  permissions: unknown;
  regionTags: string[];
  otherTags: string[];
  color: string | null;
  isBuiltIn: boolean;
  isProtected: boolean;
  grantReviewNeeded?: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count: { users: number };
}): RoleSummary {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    permissions: normalizePermissions(role.permissions),
    regionTags: [...role.regionTags],
    otherTags: [...role.otherTags],
    color: role.color,
    isBuiltIn: role.isBuiltIn,
    isProtected: role.isProtected,
    grantReviewNeeded: role.grantReviewNeeded === true,
    userCount: role._count.users,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

export async function listRoles(): Promise<RoleSummary[]> {
  const rows = await prisma.role.findMany({
    include: { _count: { select: { users: true } } },
    orderBy: { name: "asc" },
  });
  return rows.map(summarize);
}

export async function getRole(id: string): Promise<RoleSummary> {
  const row = await prisma.role.findUnique({
    where: { id },
    include: { _count: { select: { users: true } } },
  });
  if (!row) throw new AppError(404, `Role ${id} not found`);
  return summarize(row);
}

export async function getRoleByName(name: string) {
  return prisma.role.findUnique({ where: { name } });
}

async function nameCollides(name: string, excludeId?: string): Promise<boolean> {
  const lc = name.toLowerCase();
  if (RESERVED_NAMES_LC.has(lc)) return true;
  const existing = await prisma.role.findMany({
    where: excludeId ? { NOT: { id: excludeId } } : undefined,
    select: { id: true, name: true },
  });
  return existing.some(r => r.name.toLowerCase() === lc);
}

export async function createRole(input: CreateRoleInput, actor?: string): Promise<RoleSummary> {
  const name = validateName(input.name);
  if (await nameCollides(name)) {
    throw new AppError(409, `A role named "${name}" already exists`);
  }
  const description = normalizeDescription(input.description);
  const permissions = normalizePermissions(input.permissions);
  const regionTags = normalizeRegionTags(input.regionTags);
  const otherTags = normalizeOtherTags(input.otherTags);
  const color = normalizeColor(input.color);

  const created = await prisma.role.create({
    data: {
      name,
      description,
      permissions,
      regionTags,
      otherTags,
      color,
      isBuiltIn: false,
      isProtected: false,
    },
    include: { _count: { select: { users: true } } },
  });
  bumpRoleVersion(created.id, created.updatedAt);

  await logEvent({
    action: "role.created",
    resourceType: "role",
    resourceId: created.id,
    resourceName: created.name,
    actor,
    message: `Role "${created.name}" created`,
    details: { permissions, description, regionTags, otherTags, color },
  });

  return summarize(created);
}

export async function updateRole(id: string, input: UpdateRoleInput, actor?: string): Promise<RoleSummary> {
  const before = await prisma.role.findUnique({ where: { id } });
  if (!before) throw new AppError(404, `Role ${id} not found`);
  if (before.isProtected) {
    throw new AppError(403, `Role "${before.name}" is protected and cannot be edited`);
  }

  const data: {
    name?: string;
    description?: string | null;
    permissions?: Record<string, AccessLevel>;
    regionTags?: string[];
    otherTags?: string[];
    color?: string | null;
    grantReviewNeeded?: boolean;
  } = {};
  const diff: Record<string, { from: unknown; to: unknown }> = {};

  if (input.name !== undefined) {
    const next = validateName(input.name);
    if (next !== before.name) {
      if (await nameCollides(next, id)) {
        throw new AppError(409, `A role named "${next}" already exists`);
      }
      data.name = next;
      diff.name = { from: before.name, to: next };
    }
  }
  if (input.description !== undefined) {
    const next = normalizeDescription(input.description);
    if (next !== before.description) {
      data.description = next;
      diff.description = { from: before.description, to: next };
    }
  }
  if (input.permissions !== undefined) {
    const next = normalizePermissions(input.permissions);
    const prev = normalizePermissions(before.permissions);
    const changed: Record<string, { from: AccessLevel; to: AccessLevel }> = {};
    for (const def of FUNCTION_KEYS) {
      if (prev[def.key] !== next[def.key]) {
        changed[def.key] = { from: prev[def.key], to: next[def.key] };
      }
    }
    if (Object.keys(changed).length > 0) {
      data.permissions = next;
      diff.permissions = { from: prev, to: next };
      diff.permissionChanges = { from: null, to: changed };
    }
    // Saving the permission matrix — changed or not — is the review the
    // rule-114(i) flag asks for: an administrator has looked at it and stood
    // behind it.
    if (before.grantReviewNeeded) {
      data.grantReviewNeeded = false;
      diff.grantReviewNeeded = { from: true, to: false };
    }
  }
  if (input.regionTags !== undefined) {
    const next = normalizeRegionTags(input.regionTags);
    const prev = [...before.regionTags];
    const same = next.length === prev.length && next.every((v, i) => v === prev[i]);
    if (!same) {
      data.regionTags = next;
      diff.regionTags = { from: prev, to: next };
    }
  }
  if (input.otherTags !== undefined) {
    const next = normalizeOtherTags(input.otherTags);
    const prev = [...before.otherTags];
    const same = next.length === prev.length && next.every((v, i) => v === prev[i]);
    if (!same) {
      data.otherTags = next;
      diff.otherTags = { from: prev, to: next };
    }
  }
  if (input.color !== undefined) {
    const next = normalizeColor(input.color);
    if (next !== before.color) {
      data.color = next;
      diff.color = { from: before.color, to: next };
    }
  }

  if (Object.keys(data).length === 0) {
    // Nothing to do — return current state without a write or Event.
    return getRole(id);
  }

  const updated = await prisma.role.update({
    where: { id },
    data,
    include: { _count: { select: { users: true } } },
  });
  bumpRoleVersion(updated.id, updated.updatedAt);

  await logEvent({
    action: "role.updated",
    resourceType: "role",
    resourceId: updated.id,
    resourceName: updated.name,
    actor,
    message: `Role "${updated.name}" updated`,
    details: { diff },
  });

  return summarize(updated);
}

/**
 * Business rule 114(i): confirm a flagged role's grants are intended without
 * editing it. Audited; a no-op on a role that is not flagged.
 */
export async function markRoleGrantReviewed(id: string, actor?: string): Promise<RoleSummary> {
  const before = await prisma.role.findUnique({ where: { id } });
  if (!before) throw new AppError(404, `Role ${id} not found`);
  if (!before.grantReviewNeeded) return getRole(id);
  const updated = await prisma.role.update({
    where: { id },
    data: { grantReviewNeeded: false },
    include: { _count: { select: { users: true } } },
  });
  await logEvent({
    action: "role.grant_reviewed",
    resourceType: "role",
    resourceId: updated.id,
    resourceName: updated.name,
    actor,
    message: `Role "${updated.name}" was reviewed and its grants confirmed as intended`,
  });
  return summarize(updated);
}

/** The names of the roles still flagged for a grant review (rule 114(i)). */
export async function listRolesNeedingGrantReview(): Promise<string[]> {
  const rows = await prisma.role.findMany({ where: { grantReviewNeeded: true }, select: { name: true }, orderBy: { name: "asc" } });
  return rows.map((r) => r.name);
}

export async function deleteRole(id: string, actor?: string): Promise<void> {
  const before = await prisma.role.findUnique({
    where: { id },
    include: { _count: { select: { users: true, apiTokens: true } } },
  });
  if (!before) throw new AppError(404, `Role ${id} not found`);
  if (before.isBuiltIn) {
    throw new AppError(409, `Role "${before.name}" is built-in and cannot be deleted`);
  }
  if (before._count.users > 0) {
    throw new AppError(409, `Role "${before.name}" is assigned to ${before._count.users} user(s). Reassign them first.`);
  }
  if (before._count.apiTokens > 0) {
    throw new AppError(409, `Role "${before.name}" is bound to ${before._count.apiTokens} API token(s). Delete those tokens first.`);
  }
  await prisma.role.delete({ where: { id } });
  // bumpRoleVersion not strictly required (no live session can hold a deleted
  // role's snapshot — FK Restrict prevented the delete if any did), but the
  // map entry is harmless to leave behind.

  await logEvent({
    action: "role.deleted",
    resourceType: "role",
    resourceId: id,
    resourceName: before.name,
    actor,
    message: `Role "${before.name}" deleted`,
  });
}

// ─── Helpers for callers outside the route module ──────────────────────

/**
 * Returns the count of users whose Role grants both `users=fullwrite`
 * AND `roles=fullwrite` — the "admin-equivalent" rescue set. Used by
 * userService's lastAdminEquivalent invariant to refuse the action that
 * would leave Polaris with zero admins.
 */
export async function countAdminEquivalentUsers(excludeUserId?: string): Promise<number> {
  // The matrix lookup is in JSON so we filter in JS — admin-equivalent
  // roles are typically 1-2 rows out of a dozen total. Cheap.
  const roles = await prisma.role.findMany();
  const adminEquivRoleIds = roles
    .filter(r => {
      const p = normalizePermissions(r.permissions);
      return p.users === "fullwrite" && p.roles === "fullwrite";
    })
    .map(r => r.id);
  if (adminEquivRoleIds.length === 0) return 0;
  return prisma.user.count({
    where: {
      roleId: { in: adminEquivRoleIds },
      ...(excludeUserId ? { NOT: { id: excludeUserId } } : {}),
    },
  });
}

/**
 * Boolean shorthand for "this role currently grants admin-equivalent control."
 * Used by userService to detect when an admin is about to demote themselves
 * (the only admin) into a lesser role.
 */
export async function isAdminEquivalentRole(roleId: string): Promise<boolean> {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) return false;
  const p = normalizePermissions(role.permissions);
  return p.users === "fullwrite" && p.roles === "fullwrite";
}

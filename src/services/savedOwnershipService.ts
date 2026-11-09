/**
 * src/services/savedOwnershipService.ts — who owns a saved folder, filter or
 * dashboard, and what that lets them do (business rule 140).
 *
 * All three tables carry the same four ownership columns:
 *
 *   ownerId      a USER owns it
 *   ownerRoleId  every holder of a ROLE owns it
 *   ownerRegion  every user whose effective region scope NAMES the region owns
 *                it (an unrestricted user — empty scope — does not count)
 *   none set     OWNERLESS: only a fullwrite holder of the page's key manages it
 *
 * `ownerName` is the display snapshot of the current owner and is KEPT when the
 * owner goes away, so an ownerless row reads "was <name>".
 *
 * The decisions, in one place so the two item services and the folder service
 * cannot drift:
 *
 *   see     public, or you own it, or it is ownerless and you hold fullwrite
 *   manage  you own it, or it is ownerless and you hold fullwrite — edit, move,
 *           delete, change owner. Fullwrite does NOT delete an OWNED public
 *           row any more: only its owner does.
 *   take    you own it, or you hold fullwrite — "Make private to me": you
 *           become the user owner and it turns private. Logged with the
 *           previous owner, because for a fullwrite holder it is a takeover.
 *
 * A null viewer is the Dash wallboard (no session): public rows only, owner of
 * nothing.
 */

import type { Request } from "express";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { ensureRoleSnapshot, hasPermission } from "../api/middleware/permissions.js";
import { getEffectiveRegionTags } from "./regionScopeService.js";
import { listRegions } from "./mapRegionService.js";

export type SavedOwnerKind = "user" | "role" | "region" | "none";

/** The ownership columns every saved row carries. */
export interface OwnedRow {
  ownerId: string | null;
  ownerRoleId: string | null;
  ownerRegion: string | null;
  ownerName: string;
  visibility: string;
  /** Present when the query included the role (its live name beats the snapshot). */
  ownerRole?: { name: string } | null;
}

/** The caller, as the ownership rules see them. */
export interface SavedViewer {
  id: string;
  username: string;
  roleId: string | null;
  /** Effective region scope, lower-cased. Empty = unrestricted (owns no region). */
  regions: string[];
  /** May publish (visibility "public") on the page's key. */
  write: boolean;
  /** Manages ownerless rows and may take any row. */
  fullwrite: boolean;
}

export interface OwnershipDto {
  ownerKind: SavedOwnerKind;
  ownerId: string | null;
  ownerRoleId: string | null;
  ownerRegion: string | null;
  /** Current owner's display name; for an ownerless row, the LAST owner's. */
  ownerName: string;
  /** The caller is the owner (as the user, or through the role / a region). */
  isOwner: boolean;
  /** The caller may edit, move, delete and change the owner. */
  canManage: boolean;
  /** The caller may "Make private to me". */
  canTake: boolean;
}

export function ownerKindOf(row: OwnedRow): SavedOwnerKind {
  if (row.ownerId) return "user";
  if (row.ownerRoleId) return "role";
  if (row.ownerRegion) return "region";
  return "none";
}

function isOwnerless(row: OwnedRow): boolean {
  return ownerKindOf(row) === "none";
}

export function isOwner(row: OwnedRow, viewer: SavedViewer | null): boolean {
  if (!viewer) return false;
  if (row.ownerId) return row.ownerId === viewer.id;
  if (row.ownerRoleId) return viewer.roleId != null && row.ownerRoleId === viewer.roleId;
  if (row.ownerRegion) return viewer.regions.includes(row.ownerRegion.trim().toLowerCase());
  return false;
}

export function canSee(row: OwnedRow, viewer: SavedViewer | null): boolean {
  if (row.visibility === "public") return true;
  if (!viewer) return false;
  return isOwner(row, viewer) || (isOwnerless(row) && viewer.fullwrite);
}

export function canManage(row: OwnedRow, viewer: SavedViewer | null): boolean {
  if (!viewer) return false;
  return isOwner(row, viewer) || (isOwnerless(row) && viewer.fullwrite);
}

export function canTake(row: OwnedRow, viewer: SavedViewer | null): boolean {
  if (!viewer) return false;
  return isOwner(row, viewer) || viewer.fullwrite;
}

/** The owner's display name — the role's LIVE name when it was loaded. */
function ownerDisplayName(row: OwnedRow): string {
  if (row.ownerRoleId && row.ownerRole?.name) return row.ownerRole.name;
  return row.ownerName;
}

/** "user jsmith" / "role NOC" / "region Middle TN" / "no one" — for Events and errors. */
export function ownerLabel(row: OwnedRow): string {
  const kind = ownerKindOf(row);
  if (kind === "none") return "no one";
  return `${kind} ${ownerDisplayName(row)}`;
}

export function ownershipDto(row: OwnedRow, viewer: SavedViewer | null): OwnershipDto {
  return {
    ownerKind: ownerKindOf(row),
    ownerId: row.ownerId,
    ownerRoleId: row.ownerRoleId,
    ownerRegion: row.ownerRegion,
    ownerName: ownerDisplayName(row),
    isOwner: isOwner(row, viewer),
    canManage: canManage(row, viewer),
    canTake: canTake(row, viewer),
  };
}

/** 403 unless the caller may manage the row. `noun` is "saved filter" etc. */
export function assertCanManage(row: OwnedRow, viewer: SavedViewer | null, noun: string): void {
  if (canManage(row, viewer)) return;
  if (isOwnerless(row)) {
    throw new AppError(403, `Forbidden — this ${noun} has no owner; only full read-write holders can change it`);
  }
  throw new AppError(403, `Forbidden — only the ${noun}'s owner (${ownerLabel(row)}) can change it`);
}

export function assertCanTake(row: OwnedRow, viewer: SavedViewer | null, noun: string): void {
  if (canTake(row, viewer)) return;
  throw new AppError(403, `Forbidden — only the ${noun}'s owner or a full read-write holder can make it private`);
}

/**
 * Prisma `where` fragment selecting the rows a viewer can SEE. The same four
 * clauses as `canSee`, pushed into SQL so a list never loads a row it would
 * then drop. Region matching is case-insensitive, like every region consumer.
 */
export function visibleWhere(viewer: SavedViewer | null): Record<string, unknown> {
  if (!viewer) return { visibility: "public" };
  const or: Record<string, unknown>[] = [{ visibility: "public" }, { ownerId: viewer.id }];
  if (viewer.roleId) or.push({ ownerRoleId: viewer.roleId });
  for (const r of viewer.regions) or.push({ ownerRegion: { equals: r, mode: "insensitive" } });
  if (viewer.fullwrite) or.push({ ownerId: null, ownerRoleId: null, ownerRegion: null });
  return { OR: or };
}

/**
 * Build the viewer for a request against the function key that gates the page
 * (`assets` for the Assets filters, `savedDashboards` for dashboards). Null
 * when there is no session — the wallboard, or a bearer token (which has no
 * user identity to own anything with).
 */
export async function viewerFromRequest(req: Request, functionKey: string): Promise<SavedViewer | null> {
  const id = req.session?.userId;
  const username = req.session?.username;
  if (!id || !username) return null;
  await ensureRoleSnapshot(req);
  const regions = (await getEffectiveRegionTags(id)).map((r) => String(r ?? "").trim().toLowerCase()).filter(Boolean);
  return {
    id,
    username,
    roleId: req.session?.roleId ?? null,
    regions,
    write: hasPermission(req, functionKey, "write"),
    fullwrite: hasPermission(req, functionKey, "fullwrite"),
  };
}

/** Like viewerFromRequest, but 401 without a signed-in user (every mutation). */
export async function requireViewer(req: Request, functionKey: string): Promise<SavedViewer> {
  const v = await viewerFromRequest(req, functionKey);
  if (!v) throw new AppError(401, "This endpoint requires a signed-in user");
  return v;
}

// ─── Changing the owner ──────────────────────────────────────────────────────

export type OwnerTargetInput =
  | { kind: "user"; userId: string }
  | { kind: "role"; roleId: string }
  | { kind: "region"; region: string };

/** The columns a new owner writes, plus a label for Events and the toast. */
export interface OwnerColumns {
  ownerId: string | null;
  ownerRoleId: string | null;
  ownerRegion: string | null;
  ownerName: string;
}

/**
 * Validate a requested new owner and turn it into the four columns. A user
 * must exist and not be disabled; a role must exist; a region must be a region
 * on the map (stored with the map's own spelling).
 */
export async function resolveOwnerTarget(input: OwnerTargetInput): Promise<{ columns: OwnerColumns; label: string }> {
  if (input.kind === "user") {
    const u = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, username: true, disabledAt: true } });
    if (!u) throw new AppError(400, "That user does not exist");
    if (u.disabledAt) throw new AppError(400, `${u.username} is disabled and cannot own anything`);
    return { columns: { ownerId: u.id, ownerRoleId: null, ownerRegion: null, ownerName: u.username }, label: `user ${u.username}` };
  }
  if (input.kind === "role") {
    const r = await prisma.role.findUnique({ where: { id: input.roleId }, select: { id: true, name: true } });
    if (!r) throw new AppError(400, "That role does not exist");
    return { columns: { ownerId: null, ownerRoleId: r.id, ownerRegion: null, ownerName: r.name }, label: `role ${r.name}` };
  }
  const want = String(input.region ?? "").trim().toLowerCase();
  const region = (await listRegions()).find((r) => r.name.trim().toLowerCase() === want);
  if (!want || !region) throw new AppError(400, "That region does not exist");
  return { columns: { ownerId: null, ownerRoleId: null, ownerRegion: region.name, ownerName: region.name }, label: `region ${region.name}` };
}

/** The columns "Make private to me" writes. */
export function takenColumns(viewer: SavedViewer): OwnerColumns & { visibility: "private" } {
  return { ownerId: viewer.id, ownerRoleId: null, ownerRegion: null, ownerName: viewer.username, visibility: "private" };
}

/** The pickers of the Change owner dialog: active users, roles, map regions. */
export async function listOwnerOptions(): Promise<{
  users: { id: string; username: string; displayName: string | null }[];
  roles: { id: string; name: string }[];
  regions: string[];
}> {
  const [users, roles, regions] = await Promise.all([
    prisma.user.findMany({
      where: { disabledAt: null },
      select: { id: true, username: true, displayName: true },
      orderBy: { username: "asc" },
    }),
    prisma.role.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    listRegions(),
  ]);
  return { users, roles, regions: regions.map((r) => r.name).sort((a, b) => a.localeCompare(b)) };
}

/** A unique-index clash on a transfer / take, as the 409 the operator can act on. */
export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "P2002";
}

// ─── Folder trees (pure) ─────────────────────────────────────────────────────

/**
 * Where a doomed folder's contents go: its nearest ancestor that is NOT also
 * being deleted, or the top level. Guards against a corrupt cycle by bounding
 * the walk.
 */
export function survivingAncestor(
  folderId: string,
  parentOf: Map<string, string | null>,
  doomed: Set<string>,
): string | null {
  let cur = parentOf.get(folderId) ?? null;
  for (let hops = 0; cur && hops < 1000; hops++) {
    if (!doomed.has(cur)) return cur;
    cur = parentOf.get(cur) ?? null;
  }
  return null;
}

/** Every folder id under `rootId` (excluding it), breadth first. */
export function descendantFolderIds(rootId: string, childrenOf: Map<string, string[]>): string[] {
  const out: string[] = [];
  const seen = new Set<string>([rootId]);
  const queue = [...(childrenOf.get(rootId) ?? [])];
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    queue.push(...(childrenOf.get(id) ?? []));
  }
  return out;
}

/**
 * Delete folders and move what they held up to the nearest surviving ancestor
 * — the one way a folder is ever removed, so nothing inside a folder is lost
 * with it (business rule 140). One transaction.
 */
export async function deleteFoldersReparenting(doomedIds: string[]): Promise<void> {
  if (doomedIds.length === 0) return;
  const all = await prisma.savedFolder.findMany({ select: { id: true, parentId: true } });
  const parentOf = new Map(all.map((f) => [f.id, f.parentId]));
  const doomed = new Set(doomedIds);
  const writes = [];
  for (const id of doomedIds) {
    const target = survivingAncestor(id, parentOf, doomed);
    writes.push(prisma.savedTableFilter.updateMany({ where: { folderId: id }, data: { folderId: target } }));
    writes.push(prisma.savedDashboard.updateMany({ where: { folderId: id }, data: { folderId: target } }));
    writes.push(prisma.savedFolder.updateMany({ where: { parentId: id, id: { notIn: doomedIds } }, data: { parentId: target } }));
  }
  writes.push(prisma.savedFolder.deleteMany({ where: { id: { in: doomedIds } } }));
  await prisma.$transaction(writes);
}

// ─── An owner going away ─────────────────────────────────────────────────────

export interface ReleasedOwnership {
  /** Private rows deleted. */
  deleted: { folders: number; filters: number; dashboards: number };
  /** Public rows left ownerless. */
  ownerless: { folders: number; filters: number; dashboards: number };
}

/**
 * A user deleted or disabled: their PRIVATE folders, filters and dashboards are
 * deleted (a deleted private folder's contents move up, never vanish with it),
 * their PUBLIC ones become ownerless, keeping `ownerName` so the menu reads
 * "was <username>". Role- and region-owned rows are untouched — the user was
 * one owner among many there.
 */
export async function releaseUserOwnership(userId: string): Promise<ReleasedOwnership> {
  const privateFolders = await prisma.savedFolder.findMany({
    where: { ownerId: userId, visibility: "private" },
    select: { id: true },
  });
  await deleteFoldersReparenting(privateFolders.map((f) => f.id));
  const mine = { ownerId: userId };
  const [filters, dashboards, pubFolders, pubFilters, pubDashboards] = await prisma.$transaction([
    prisma.savedTableFilter.deleteMany({ where: { ...mine, visibility: "private" } }),
    prisma.savedDashboard.deleteMany({ where: { ...mine, visibility: "private" } }),
    prisma.savedFolder.updateMany({ where: mine, data: { ownerId: null } }),
    prisma.savedTableFilter.updateMany({ where: mine, data: { ownerId: null } }),
    prisma.savedDashboard.updateMany({ where: mine, data: { ownerId: null } }),
  ]);
  return {
    deleted: { folders: privateFolders.length, filters: filters.count, dashboards: dashboards.count },
    ownerless: { folders: pubFolders.count, filters: pubFilters.count, dashboards: pubDashboards.count },
  };
}

/** A region renamed: its rows follow the new name. Case-insensitive, like every region match. */
export async function renameRegionOwner(previousName: string, nextName: string): Promise<number> {
  const from = String(previousName ?? "").trim();
  const to = String(nextName ?? "").trim();
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) return 0;
  const where = { ownerRegion: { equals: from, mode: "insensitive" as const } };
  const data = { ownerRegion: to, ownerName: to };
  const counts = await prisma.$transaction([
    prisma.savedFolder.updateMany({ where, data }),
    prisma.savedTableFilter.updateMany({ where, data }),
    prisma.savedDashboard.updateMany({ where, data }),
  ]);
  return counts.reduce((n, c) => n + c.count, 0);
}

/** A region deleted: its rows become ownerless (the name stays as "was …"). */
export async function releaseRegionOwner(name: string): Promise<number> {
  const key = String(name ?? "").trim();
  if (!key) return 0;
  const where = { ownerRegion: { equals: key, mode: "insensitive" as const } };
  const data = { ownerRegion: null };
  const counts = await prisma.$transaction([
    prisma.savedFolder.updateMany({ where, data }),
    prisma.savedTableFilter.updateMany({ where, data }),
    prisma.savedDashboard.updateMany({ where, data }),
  ]);
  return counts.reduce((n, c) => n + c.count, 0);
}

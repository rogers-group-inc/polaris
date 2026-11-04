/**
 * src/services/savedFolderService.ts — nested folders of saved filters and
 * saved dashboards (business rule 140).
 *
 * One table, two kinds: `kind: "filter"` with `scope` = the filter's table
 * ("assets"), and `kind: "dashboard"` with `scope: "dashboards"`. A folder is
 * Private or Public and has an owner exactly like the items it holds
 * (savedOwnershipService), and each row keeps its OWN visibility, so a viewer
 * sees exactly the rows visible to them: a visible item or folder whose parent
 * they cannot see is reported with `parentId` / `folderId` null and drawn at
 * the top level.
 *
 * Filing is open: you may put a row you MANAGE into any folder you can SEE
 * (a shared team folder included). Moving, renaming, publishing, deleting and
 * re-owning a folder is its owner's alone (fullwrite for an ownerless one).
 * Deleting a folder moves its contents up a level — nothing inside is lost.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { normalizeName } from "./savedFilterService.js";
import {
  assertCanManage,
  assertCanTake,
  canManage,
  canSee,
  canTake,
  deleteFoldersReparenting,
  descendantFolderIds,
  isUniqueViolation,
  ownerLabel,
  ownershipDto,
  resolveOwnerTarget,
  takenColumns,
  visibleWhere,
  type OwnerTargetInput,
  type OwnershipDto,
  type SavedViewer,
} from "./savedOwnershipService.js";

export type SavedFolderKind = "filter" | "dashboard";
export type SavedVisibility = "private" | "public";

/** Deepest nesting allowed — a menu indents per level, so this is a readability bound. */
const MAX_FOLDER_DEPTH = 8;
/** Folders one user may own per kind + scope — a bound on menu render cost. */
const MAX_FOLDERS_PER_USER = 200;

export interface SavedFolderDto extends OwnershipDto {
  id: string;
  kind: SavedFolderKind;
  scope: string;
  name: string;
  /** Null at the top level, or when the parent is not visible to the caller. */
  parentId: string | null;
  visibility: SavedVisibility;
  createdAt: string;
  updatedAt: string;
}

type FolderRow = {
  id: string;
  kind: string;
  scope: string;
  name: string;
  parentId: string | null;
  ownerId: string | null;
  ownerRoleId: string | null;
  ownerRegion: string | null;
  ownerName: string;
  visibility: string;
  createdAt: Date;
  updatedAt: Date;
  ownerRole?: { name: string } | null;
};

const withRole = { ownerRole: { select: { name: true } } } as const;

const NOUN = "folder";

function toDto(row: FolderRow, viewer: SavedViewer | null, visibleIds: Set<string>): SavedFolderDto {
  return {
    id: row.id,
    kind: row.kind === "dashboard" ? "dashboard" : "filter",
    scope: row.scope,
    name: row.name,
    parentId: row.parentId && visibleIds.has(row.parentId) ? row.parentId : null,
    visibility: row.visibility === "public" ? "public" : "private",
    ...ownershipDto(row, viewer),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Every folder of a kind + scope the caller can see, plus their ids for item placement. */
export async function listVisibleFolders(
  kind: SavedFolderKind,
  scope: string,
  viewer: SavedViewer | null,
): Promise<{ folders: SavedFolderDto[]; visibleIds: Set<string> }> {
  const rows = await prisma.savedFolder.findMany({
    where: { kind, scope, ...visibleWhere(viewer) },
    include: withRole,
    orderBy: [{ name: "asc" }],
  });
  const visibleIds = new Set(rows.map((r) => r.id));
  return { folders: rows.map((r) => toDto(r, viewer, visibleIds)), visibleIds };
}

async function load(id: string): Promise<FolderRow> {
  const row = await prisma.savedFolder.findUnique({ where: { id }, include: withRole });
  if (!row) throw new AppError(404, "Folder not found");
  return row;
}

/** One folder, for a route that must resolve its scope's key before acting. 404 when invisible. */
async function getFolderForViewer(id: string, viewer: SavedViewer | null): Promise<FolderRow> {
  const row = await load(id);
  if (!canSee(row, viewer)) throw new AppError(404, "Folder not found");
  return row;
}

/** The raw row (no visibility check) — routes use it to learn the scope first. */
export async function getFolderScope(id: string): Promise<{ kind: SavedFolderKind; scope: string }> {
  const row = await prisma.savedFolder.findUnique({ where: { id }, select: { kind: true, scope: true } });
  if (!row) throw new AppError(404, "Folder not found");
  return { kind: row.kind === "dashboard" ? "dashboard" : "filter", scope: row.scope };
}

/**
 * Assert `folderId` is a folder of this kind + scope the caller can see — the
 * check behind every "put X in folder Y". Null (top level) always passes.
 */
export async function assertFolderTarget(
  kind: SavedFolderKind,
  scope: string,
  folderId: string | null,
  viewer: SavedViewer | null,
): Promise<void> {
  if (!folderId) return;
  const row = await prisma.savedFolder.findUnique({ where: { id: folderId } });
  if (!row || !canSee(row, viewer)) throw new AppError(400, "That folder does not exist");
  if (row.kind !== kind || row.scope !== scope) throw new AppError(400, "That folder belongs to a different list");
}

async function treeOf(kind: SavedFolderKind, scope: string) {
  const all = await prisma.savedFolder.findMany({ where: { kind, scope }, select: { id: true, parentId: true } });
  const parentOf = new Map(all.map((f) => [f.id, f.parentId]));
  const childrenOf = new Map<string, string[]>();
  for (const f of all) {
    if (!f.parentId) continue;
    const list = childrenOf.get(f.parentId) ?? [];
    list.push(f.id);
    childrenOf.set(f.parentId, list);
  }
  return { parentOf, childrenOf };
}

/** Depth of a folder counting itself (top level = 1). */
function depthOf(id: string | null, parentOf: Map<string, string | null>): number {
  let d = 0;
  let cur = id;
  while (cur && d < 1000) {
    d++;
    cur = parentOf.get(cur) ?? null;
  }
  return d;
}

/** Height of a subtree counting its root (a leaf = 1). */
function heightOf(id: string, childrenOf: Map<string, string[]>): number {
  const kids = childrenOf.get(id) ?? [];
  let h = 0;
  for (const k of kids) h = Math.max(h, heightOf(k, childrenOf));
  return h + 1;
}

export interface CreateFolderInput {
  kind: SavedFolderKind;
  scope: string;
  name: string;
  parentId: string | null;
  visibility: SavedVisibility;
}

export async function createFolder(input: CreateFolderInput, viewer: SavedViewer): Promise<SavedFolderDto> {
  const name = normalizeName(input.name);
  await assertFolderTarget(input.kind, input.scope, input.parentId, viewer);
  const { parentOf } = await treeOf(input.kind, input.scope);
  if (depthOf(input.parentId, parentOf) + 1 > MAX_FOLDER_DEPTH) {
    throw new AppError(400, `Folders nest at most ${MAX_FOLDER_DEPTH} deep`);
  }
  const count = await prisma.savedFolder.count({ where: { kind: input.kind, scope: input.scope, ownerId: viewer.id } });
  if (count >= MAX_FOLDERS_PER_USER) {
    throw new AppError(400, `You already have ${MAX_FOLDERS_PER_USER} folders here — delete one first`);
  }
  const row = await prisma.savedFolder.create({
    data: {
      kind: input.kind,
      scope: input.scope,
      name,
      parentId: input.parentId,
      visibility: input.visibility,
      ownerId: viewer.id,
      ownerName: viewer.username,
    },
    include: withRole,
  });
  void logEvent({
    action: "saved_folder.created",
    resourceType: "saved_folder",
    resourceId: row.id,
    resourceName: row.name,
    actor: viewer.username,
    message: `Created ${row.visibility} ${input.kind} folder "${row.name}"`,
    details: { kind: row.kind, scope: row.scope, visibility: row.visibility, parentId: row.parentId },
  });
  return toDto(row, viewer, new Set(input.parentId ? [input.parentId] : []));
}

/** Rename and / or publish / unpublish. Publishing is checked by the route (write). */
export async function updateFolder(
  id: string,
  input: { name: string; visibility: SavedVisibility },
  viewer: SavedViewer,
): Promise<SavedFolderDto> {
  const before = await getFolderForViewer(id, viewer);
  assertCanManage(before, viewer, NOUN);
  const row = await prisma.savedFolder.update({
    where: { id },
    data: { name: normalizeName(input.name), visibility: input.visibility },
    include: withRole,
  });
  void logEvent({
    action: "saved_folder.updated",
    resourceType: "saved_folder",
    resourceId: row.id,
    resourceName: row.name,
    actor: viewer.username,
    message: `Updated ${row.visibility} ${row.kind} folder "${row.name}"`,
    details: {
      previousName: before.name !== row.name ? before.name : undefined,
      previousVisibility: before.visibility !== row.visibility ? before.visibility : undefined,
    },
  });
  return toDto(row, viewer, new Set(row.parentId ? [row.parentId] : []));
}

/** Drag a folder into another (or to the top level). Refuses a cycle and an over-deep tree. */
export async function moveFolder(id: string, parentId: string | null, viewer: SavedViewer): Promise<void> {
  const row = await getFolderForViewer(id, viewer);
  assertCanManage(row, viewer, NOUN);
  const kind: SavedFolderKind = row.kind === "dashboard" ? "dashboard" : "filter";
  await assertFolderTarget(kind, row.scope, parentId, viewer);
  if (parentId === row.parentId) return;
  const { parentOf, childrenOf } = await treeOf(kind, row.scope);
  if (parentId && (parentId === id || descendantFolderIds(id, childrenOf).includes(parentId))) {
    throw new AppError(400, "A folder cannot be moved into itself");
  }
  if (depthOf(parentId, parentOf) + heightOf(id, childrenOf) > MAX_FOLDER_DEPTH) {
    throw new AppError(400, `Folders nest at most ${MAX_FOLDER_DEPTH} deep`);
  }
  await prisma.savedFolder.update({ where: { id }, data: { parentId } });
  void logEvent({
    action: "saved_folder.moved",
    resourceType: "saved_folder",
    resourceId: row.id,
    resourceName: row.name,
    actor: viewer.username,
    message: `Moved ${row.kind} folder "${row.name}"`,
    details: { from: row.parentId, to: parentId },
  });
}

/** Delete one folder; its contents move up a level. */
export async function deleteFolder(id: string, viewer: SavedViewer): Promise<void> {
  const row = await getFolderForViewer(id, viewer);
  assertCanManage(row, viewer, NOUN);
  await deleteFoldersReparenting([id]);
  void logEvent({
    action: "saved_folder.deleted",
    resourceType: "saved_folder",
    resourceId: row.id,
    resourceName: row.name,
    actor: viewer.username,
    message: `Deleted ${row.visibility} ${row.kind} folder "${row.name}" (its contents moved up a level)`,
    details: { kind: row.kind, scope: row.scope, owner: ownerLabel(row) },
  });
}

/**
 * The folder's subtree, split by what the caller may act on with `allowed`.
 * Used by Change owner / Make private to me with "include the items inside".
 */
async function subtreeIds(
  root: FolderRow,
  viewer: SavedViewer,
  allowed: (row: Parameters<typeof canManage>[0], viewer: SavedViewer) => boolean,
): Promise<{ folders: string[]; filters: string[]; dashboards: string[] }> {
  const kind: SavedFolderKind = root.kind === "dashboard" ? "dashboard" : "filter";
  const { childrenOf } = await treeOf(kind, root.scope);
  const folderIds = [root.id, ...descendantFolderIds(root.id, childrenOf)];
  const [folders, filters, dashboards] = await Promise.all([
    prisma.savedFolder.findMany({ where: { id: { in: folderIds.slice(1) } } }),
    kind === "filter" ? prisma.savedTableFilter.findMany({ where: { folderId: { in: folderIds } } }) : Promise.resolve([]),
    kind === "dashboard" ? prisma.savedDashboard.findMany({ where: { folderId: { in: folderIds } } }) : Promise.resolve([]),
  ]);
  return {
    folders: folders.filter((f) => allowed(f, viewer)).map((f) => f.id),
    filters: filters.filter((f) => allowed(f, viewer)).map((f) => f.id),
    dashboards: dashboards.filter((d) => allowed(d, viewer)).map((d) => d.id),
  };
}

export interface SubtreeCounts {
  folders: number;
  filters: number;
  dashboards: number;
}

/**
 * Give a folder to a user, role or region. With `includeContents`, every
 * folder, filter or dashboard under it that the caller manages moves too.
 */
export async function changeFolderOwner(
  id: string,
  target: OwnerTargetInput,
  includeContents: boolean,
  viewer: SavedViewer,
): Promise<{ folder: SavedFolderDto; moved: SubtreeCounts }> {
  const row = await getFolderForViewer(id, viewer);
  assertCanManage(row, viewer, NOUN);
  const { columns, label } = await resolveOwnerTarget(target);
  const sub = includeContents ? await subtreeIds(row, viewer, canManage) : { folders: [], filters: [], dashboards: [] };
  try {
    await prisma.$transaction([
      prisma.savedFolder.updateMany({ where: { id: { in: [id, ...sub.folders] } }, data: columns }),
      prisma.savedTableFilter.updateMany({ where: { id: { in: sub.filters } }, data: columns }),
      prisma.savedDashboard.updateMany({ where: { id: { in: sub.dashboards } }, data: columns }),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, `${label} already has an item with the same name as one inside this folder — rename it first`);
    throw err;
  }
  const moved = { folders: sub.folders.length, filters: sub.filters.length, dashboards: sub.dashboards.length };
  void logEvent({
    action: "saved_folder.owner_changed",
    resourceType: "saved_folder",
    resourceId: row.id,
    resourceName: row.name,
    actor: viewer.username,
    message: `Gave ${row.kind} folder "${row.name}" from ${ownerLabel(row)} to ${label}`,
    details: { previousOwner: ownerLabel(row), newOwner: label, includeContents, moved },
  });
  const after = await load(id);
  return { folder: toDto(after, viewer, new Set(after.parentId ? [after.parentId] : [])), moved };
}

/**
 * "Make private to me": the caller becomes the user owner and the folder turns
 * private. For a fullwrite holder this is a takeover of someone else's folder,
 * which is why the Event names the previous owner at warning level.
 */
export async function takeFolder(
  id: string,
  includeContents: boolean,
  viewer: SavedViewer,
): Promise<{ folder: SavedFolderDto; moved: SubtreeCounts }> {
  const row = await getFolderForViewer(id, viewer);
  assertCanTake(row, viewer, NOUN);
  const columns = takenColumns(viewer);
  const sub = includeContents ? await subtreeIds(row, viewer, canTake) : { folders: [], filters: [], dashboards: [] };
  try {
    await prisma.$transaction([
      prisma.savedFolder.updateMany({ where: { id: { in: [id, ...sub.folders] } }, data: columns }),
      prisma.savedTableFilter.updateMany({ where: { id: { in: sub.filters } }, data: columns }),
      prisma.savedDashboard.updateMany({ where: { id: { in: sub.dashboards } }, data: columns }),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, "You already own an item with the same name as one inside this folder — rename it first");
    throw err;
  }
  const moved = { folders: sub.folders.length, filters: sub.filters.length, dashboards: sub.dashboards.length };
  const wasMine = row.ownerId === viewer.id;
  void logEvent({
    action: wasMine ? "saved_folder.updated" : "saved_folder.taken",
    resourceType: "saved_folder",
    resourceId: row.id,
    resourceName: row.name,
    actor: viewer.username,
    level: wasMine ? "info" : "warning",
    message: wasMine
      ? `Made ${row.kind} folder "${row.name}" private`
      : `${viewer.username} took ${row.kind} folder "${row.name}" from ${ownerLabel(row)} and made it private`,
    details: { previousOwner: ownerLabel(row), previousVisibility: row.visibility, includeContents, moved },
  });
  const after = await load(id);
  return { folder: toDto(after, viewer, new Set(after.parentId ? [after.parentId] : [])), moved };
}

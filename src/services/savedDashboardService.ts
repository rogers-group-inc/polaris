/**
 * src/services/savedDashboardService.ts — saved dashboards (named canvases).
 *
 * A SavedDashboard is a named snapshot of ONE dashboard canvas (its column
 * stack), stored server-side so it follows the operator across browsers AND
 * can be shared: a `public` dashboard is offered to every caller who can read
 * the registry, a `private` one only to its owner.
 *
 * This is savedFilterService's model applied to the dashboard, with one
 * consequence that has no parallel there: **a public dashboard is also what the
 * unauthenticated Dash wallboard can load** (src/dash/dashServer.ts mounts the
 * list + read routes, GET-only, and passes no session). So:
 *
 *   list (owned u public) / create + edit + delete OWNED   -> savedDashboards:read
 *   create or edit a PUBLIC one (publishing to everyone,
 *   the wallboard included)                                -> savedDashboards:write
 *   manage an OWNERLESS one; "Make private to me" on any   -> savedDashboards:fullwrite
 *   list from the wallboard (no session at all)            -> public rows ONLY
 *
 * Ownership (a user, a role, a region, or nobody) and folders are business
 * rule 140 (savedOwnershipService / savedFolderService). Nobody but its owner
 * deletes an OWNED public dashboard, fullwrite included.
 *
 * It gets its OWN function key rather than riding a page's gate the way
 * SAVED_FILTER_SCOPES does, because the Dashboard page has no function key to
 * inherit — it is gated per WIDGET (PolarisWidgets.getAllowed()), which is also
 * what keeps a loaded dashboard honest: a widget the viewer may not read is
 * dropped at render on their side, so a published layout can't disclose
 * anything its reader couldn't already fetch.
 *
 * The stored blob is another operator's browser input replayed into yours, so
 * `sanitizeDashboardLayout` accepts only the column/widget shape
 * utils/dashboardLayout.ts defines — the same one /me/dashboard stores.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { ColumnsSchema, type DashboardColumnInput } from "../utils/dashboardLayout.js";
// One definition of "an operator-typed preset name" — trim + collapse
// whitespace, reject control characters (the name is rendered into every other
// operator's menu), 60-char ceiling. Shared with saved filters deliberately:
// two name rules for two lists of named presets is a difference operators feel.
import { normalizeName } from "./savedFilterService.js";
import type { Prisma } from "../generated/prisma/client.js";
import {
  assertCanManage,
  assertCanTake,
  canSee,
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
import { assertFolderTarget, listVisibleFolders, type SavedFolderDto } from "./savedFolderService.js";

export { normalizeName };

/** Dashboards one user may own — a bound on list-render cost. */
const MAX_SAVED_DASHBOARDS_PER_USER = 50;

export type SavedDashboardVisibility = "private" | "public";

/** What a saved dashboard stores: one canvas, no id/name of its own. */
export interface SavedDashboardLayout {
  columns: DashboardColumnInput[];
}

/** A dashboard as the menu sees it; the ownership half is the caller's view. */
export interface SavedDashboardDto extends OwnershipDto {
  id: string;
  name: string;
  visibility: SavedDashboardVisibility;
  /** Null at the top level, or when the folder is not visible to the caller. */
  folderId: string | null;
  /** Widget count — the menu labels a row without parsing the layout. */
  widgetCount: number;
  layout: SavedDashboardLayout;
  createdAt: string;
  updatedAt: string;
}

/**
 * Validate + normalize a layout blob into exactly the column stack the
 * dashboard renderer consumes. Zod's failure is folded into an AppError so
 * every throw out of this file is the one error type the routes expect.
 */
export function sanitizeDashboardLayout(raw: unknown): SavedDashboardLayout {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(400, "layout must be an object");
  }
  const columns = (raw as { columns?: unknown }).columns ?? [];
  const parsed = ColumnsSchema.safeParse(columns);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new AppError(400, `layout.columns is invalid: ${first ? first.message : "unrecognized shape"}`);
  }
  // An EMPTY canvas is a legitimate thing to store (a placeholder screen), so
  // it isn't refused here — the UI is where "save nothing?" is a question.
  return { columns: parsed.data as DashboardColumnInput[] };
}

export function countWidgets(layout: SavedDashboardLayout): number {
  return layout.columns.reduce((n, c) => n + c.widgets.length, 0);
}


type Row = {
  id: string;
  name: string;
  ownerId: string | null;
  ownerRoleId: string | null;
  ownerRegion: string | null;
  ownerName: string;
  visibility: string;
  layout: Prisma.JsonValue;
  folderId: string | null;
  createdAt: Date;
  updatedAt: Date;
  ownerRole?: { name: string } | null;
};

const withRole = { ownerRole: { select: { name: true } } } as const;
const NOUN = "saved dashboard";
/** The folder scope every saved-dashboard folder lives in. */
export const DASHBOARD_FOLDER_SCOPE = "dashboards";

function toDto(row: Row, viewer: SavedViewer | null, visibleFolderIds: Set<string>): SavedDashboardDto {
  const stored = (row.layout as unknown as SavedDashboardLayout) || { columns: [] };
  const columns = Array.isArray(stored.columns) ? stored.columns : [];
  return {
    id: row.id,
    name: row.name,
    visibility: row.visibility === "public" ? "public" : "private",
    ...ownershipDto(row, viewer),
    folderId: row.folderId && visibleFolderIds.has(row.folderId) ? row.folderId : null,
    widgetCount: countWidgets({ columns }),
    layout: { columns },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function oneFolder(folderId: string | null): Set<string> {
  return new Set(folderId ? [folderId] : []);
}

/**
 * Dashboards and folders visible to one caller (business rule 140): public
 * rows, rows they own (as the user, through their role or a region in their
 * scope) and, at fullwrite, ownerless rows. A null viewer is the wallboard —
 * public rows ONLY, and nothing reads as owned.
 */
export async function listSavedDashboards(
  viewer: SavedViewer | null,
): Promise<{ dashboards: SavedDashboardDto[]; folders: SavedFolderDto[] }> {
  const [{ folders, visibleIds }, rows] = await Promise.all([
    listVisibleFolders("dashboard", DASHBOARD_FOLDER_SCOPE, viewer),
    prisma.savedDashboard.findMany({
      where: visibleWhere(viewer),
      include: withRole,
      orderBy: [{ name: "asc" }],
    }),
  ]);
  return { dashboards: rows.map((r) => toDto(r, viewer, visibleIds)), folders };
}

async function load(id: string): Promise<Row> {
  const row = await prisma.savedDashboard.findUnique({ where: { id }, include: withRole });
  if (!row) throw new AppError(404, "Saved dashboard not found");
  return row;
}

async function loadVisible(id: string, viewer: SavedViewer | null): Promise<Row> {
  const row = await load(id);
  if (!canSee(row, viewer)) throw new AppError(404, "Saved dashboard not found");
  return row;
}

/**
 * One saved dashboard by id, as a DTO — the wallboard's re-read of the screen
 * it is pinned to, and the Dashboard page's refresh of a loaded tab. A row the
 * caller can't see answers 404, not 403 (the GET /alerts/:id posture): that an
 * id exists is itself something an anonymous viewer shouldn't learn.
 */
export async function readSavedDashboard(id: string, viewer: SavedViewer | null): Promise<SavedDashboardDto> {
  const row = await loadVisible(id, viewer);
  return toDto(row, viewer, oneFolder(row.folderId));
}

export interface SaveDashboardInput {
  name: string;
  visibility: SavedDashboardVisibility;
  layout: SavedDashboardLayout;
  /** undefined = leave where it is (an update) / top level (a create). */
  folderId?: string | null;
}

/**
 * Create one owned by `user`. A same-(owner, name) row is UPDATED instead of
 * duplicated — the UI's "save over an existing name" flow — so the caller never
 * has to choose between POST and PUT.
 */
export async function createSavedDashboard(input: SaveDashboardInput, user: SavedViewer): Promise<SavedDashboardDto> {
  const existing = await prisma.savedDashboard.findFirst({ where: { ownerId: user.id, name: input.name } });
  if (existing) return updateSavedDashboard(existing.id, input, user);

  const count = await prisma.savedDashboard.count({ where: { ownerId: user.id } });
  if (count >= MAX_SAVED_DASHBOARDS_PER_USER) {
    throw new AppError(
      400,
      `You already have ${MAX_SAVED_DASHBOARDS_PER_USER} saved dashboards — delete one first`,
    );
  }
  const folderId = input.folderId ?? null;
  await assertFolderTarget("dashboard", DASHBOARD_FOLDER_SCOPE, folderId, user);

  const row = await prisma.savedDashboard.create({
    data: {
      name: input.name,
      ownerId: user.id,
      ownerName: user.username,
      visibility: input.visibility,
      layout: input.layout as unknown as Prisma.InputJsonValue,
      folderId,
    },
    include: withRole,
  });
  void logEvent({
    action: "saved_dashboard.created",
    resourceType: "saved_dashboard",
    resourceId: row.id,
    resourceName: row.name,
    actor: user.username,
    message: `Saved ${row.visibility} dashboard "${row.name}"`,
    details: { visibility: row.visibility, widgetCount: countWidgets(input.layout), folderId },
  });
  return toDto(row, user, oneFolder(folderId));
}

/** Update one — its owner's (or, ownerless, a fullwrite holder's) alone. */
export async function updateSavedDashboard(
  id: string,
  input: SaveDashboardInput,
  user: SavedViewer,
): Promise<SavedDashboardDto> {
  const before = await loadVisible(id, user);
  assertCanManage(before, user, NOUN);
  if (input.folderId !== undefined) await assertFolderTarget("dashboard", DASHBOARD_FOLDER_SCOPE, input.folderId, user);
  let row: Row;
  try {
    row = await prisma.savedDashboard.update({
      where: { id },
      data: {
        name: input.name,
        visibility: input.visibility,
        layout: input.layout as unknown as Prisma.InputJsonValue,
        ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
      },
      include: withRole,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, `There is already a saved dashboard named "${input.name}" with this owner`);
    throw err;
  }
  void logEvent({
    action: "saved_dashboard.updated",
    resourceType: "saved_dashboard",
    resourceId: row.id,
    resourceName: row.name,
    actor: user.username,
    message: `Updated ${row.visibility} dashboard "${row.name}"`,
    details: {
      visibility: row.visibility,
      widgetCount: countWidgets(input.layout),
      previousName: before.name !== row.name ? before.name : undefined,
      previousVisibility: before.visibility !== row.visibility ? before.visibility : undefined,
    },
  });
  return toDto(row, user, oneFolder(row.folderId));
}

/**
 * Delete one. Its owner only — a fullwrite holder may delete an OWNERLESS one,
 * never someone's owned public dashboard (business rule 140).
 */
export async function deleteSavedDashboard(id: string, user: SavedViewer): Promise<void> {
  const row = await loadVisible(id, user);
  assertCanManage(row, user, NOUN);
  await prisma.savedDashboard.delete({ where: { id } });
  void logEvent({
    action: "saved_dashboard.deleted",
    resourceType: "saved_dashboard",
    resourceId: row.id,
    resourceName: row.name,
    actor: user.username,
    message: `Deleted ${row.visibility} dashboard "${row.name}"`,
    details: { visibility: row.visibility, owner: ownerLabel(row) },
  });
}

/** File one in a folder (drag and drop), or at the top level with null. */
export async function moveSavedDashboard(id: string, folderId: string | null, user: SavedViewer): Promise<void> {
  const row = await loadVisible(id, user);
  assertCanManage(row, user, NOUN);
  await assertFolderTarget("dashboard", DASHBOARD_FOLDER_SCOPE, folderId, user);
  if (row.folderId === folderId) return;
  await prisma.savedDashboard.update({ where: { id }, data: { folderId } });
}

/** Give one to a user, role or region. */
export async function changeSavedDashboardOwner(
  id: string,
  target: OwnerTargetInput,
  user: SavedViewer,
): Promise<SavedDashboardDto> {
  const row = await loadVisible(id, user);
  assertCanManage(row, user, NOUN);
  const { columns, label } = await resolveOwnerTarget(target);
  let after: Row;
  try {
    after = await prisma.savedDashboard.update({ where: { id }, data: columns, include: withRole });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, `${label} already has a saved dashboard named "${row.name}" — rename one first`);
    throw err;
  }
  void logEvent({
    action: "saved_dashboard.owner_changed",
    resourceType: "saved_dashboard",
    resourceId: row.id,
    resourceName: row.name,
    actor: user.username,
    message: `Gave dashboard "${row.name}" from ${ownerLabel(row)} to ${label}`,
    details: { previousOwner: ownerLabel(row), newOwner: label },
  });
  return toDto(after, user, oneFolder(after.folderId));
}

/** "Make private to me" — the caller becomes the user owner; it turns private. */
export async function takeSavedDashboard(id: string, user: SavedViewer): Promise<SavedDashboardDto> {
  const row = await loadVisible(id, user);
  assertCanTake(row, user, NOUN);
  let after: Row;
  try {
    after = await prisma.savedDashboard.update({ where: { id }, data: takenColumns(user), include: withRole });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, `You already have a saved dashboard named "${row.name}" — rename one first`);
    throw err;
  }
  const wasMine = row.ownerId === user.id;
  void logEvent({
    action: wasMine ? "saved_dashboard.updated" : "saved_dashboard.taken",
    resourceType: "saved_dashboard",
    resourceId: row.id,
    resourceName: row.name,
    actor: user.username,
    level: wasMine ? "info" : "warning",
    message: wasMine
      ? `Made dashboard "${row.name}" private`
      : `${user.username} took dashboard "${row.name}" from ${ownerLabel(row)} and made it private`,
    details: { previousOwner: ownerLabel(row), previousVisibility: row.visibility },
  });
  return toDto(after, user, oneFolder(after.folderId));
}

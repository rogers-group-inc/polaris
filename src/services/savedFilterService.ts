/**
 * src/services/savedFilterService.ts — saved table filters (list-page presets).
 *
 * A SavedTableFilter is a named snapshot of one list page's TableSF filter +
 * sort state, stored server-side so it follows the operator across browsers
 * AND can be shared: a `public` preset is offered to every caller who can read
 * the scope, a `private` one only to its owner.
 *
 * Access model (no new RBAC function key — each scope rides the key that
 * already gates its page, see SAVED_FILTER_SCOPES):
 *   read the list / create + edit + delete what you OWN       → <key>:read
 *   create or edit a PUBLIC preset (publishing to everyone)  → <key>:write
 *   manage an OWNERLESS preset; "Make private to me" on any  → <key>:fullwrite
 *
 * Ownership (a user, a role, a region, or nobody), folders and the take-over
 * verb are business rule 140 — savedOwnershipService decides them for all
 * three saved tables, savedFolderService owns the folders. Nobody but its
 * owner deletes an OWNED public preset, fullwrite included.
 *
 * A preset holds only the query (`sfFilters` + sort). Column widths /
 * visibility deliberately stay per-browser in localStorage — they describe the
 * operator's screen, not what they're looking for.
 *
 * The pure validators (normalizeName / sanitizeFilterState) are exported for
 * unit tests; the DB-bound CRUD lives alongside.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
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
// A cycle by design (savedFolderService reuses normalizeName): both sides only
// call the other at request time, never while their module is evaluating.
import { assertFolderTarget, listVisibleFolders, type SavedFolderDto } from "./savedFolderService.js";

/**
 * scope → the RBAC function key that gates it. A scope absent from this map is
 * rejected, so adding saved filters to another list page is a one-line change
 * here plus the frontend wiring — no new permission key, no role migration.
 */
const SAVED_FILTER_SCOPES: Record<string, string> = {
  assets: "assets",
};

export const MAX_NAME_LEN = 60;
/** Filter columns per preset — far above any real table's column count. */
export const MAX_FILTER_KEYS = 60;
/** Values inside a filter (a multi-select's checked options). */
const MAX_FILTER_VALUES = 200;
/** Per-string cap (a typed substring, a date, a column key). */
export const MAX_VALUE_LEN = 300;
/** Presets one user may own per scope — a bound on list-render cost. */
const MAX_PRESETS_PER_USER = 100;

// C0 range + DEL. Never legitimate in an operator-typed preset name, and a
// public preset's name is rendered into every other operator's menu.
const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u001f\\u007f]");

export type SavedFilterVisibility = "private" | "public";

/** The TableSF prefs shape a preset stores — see public/js/table-sf.js. */
export interface SavedFilterState {
  sfFilters: Record<string, unknown>;
  sortKey: string | null;
  sortDir: "asc" | "desc" | null;
}

/**
 * A preset as the menu sees it. The ownership half (`ownerKind`, `isOwner`,
 * `canManage`, `canTake`, …) is the caller's view, from savedOwnershipService.
 */
export interface SavedFilterDto extends OwnershipDto {
  id: string;
  scope: string;
  name: string;
  visibility: SavedFilterVisibility;
  /** Null at the top level, or when the folder is not visible to the caller. */
  folderId: string | null;
  state: SavedFilterState;
  createdAt: string;
  updatedAt: string;
}

export function isValidScope(scope: unknown): scope is string {
  return typeof scope === "string" && Object.prototype.hasOwnProperty.call(SAVED_FILTER_SCOPES, scope);
}

/** The function key gating a scope. Throws 400 on an unknown scope. */
export function functionKeyForScope(scope: string): string {
  const key = SAVED_FILTER_SCOPES[scope];
  if (!key) throw new AppError(400, `Unknown saved-filter scope "${scope}"`);
  return key;
}

/**
 * Trim + validate a preset name. Names are the operator's handle for the
 * preset AND the overwrite key (same owner + scope + name = update), so an
 * all-whitespace or control-character name is rejected rather than repaired.
 */
export function normalizeName(raw: unknown): string {
  if (typeof raw !== "string") throw new AppError(400, "name is required");
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) throw new AppError(400, "name is required");
  if (name.length > MAX_NAME_LEN) throw new AppError(400, `name exceeds ${MAX_NAME_LEN} characters`);
  if (CONTROL_CHARS_RE.test(name)) throw new AppError(400, "name contains control characters");
  return name;
}

/**
 * Validate + normalize a filter-state blob into exactly what TableSF.setPrefs
 * consumes. Anything the table can't produce is rejected (400) rather than
 * stored: this JSON is replayed into another operator's browser when a public
 * preset is loaded, so an unbounded blob is both a storage and a render risk.
 *
 * Accepted per-column filter values mirror table-sf.js:
 *   "text"                                   — contains (a leading "!" negates)
 *   ["a","b"]                                — multi-select checked values
 *   { op: "contains"|"not-contains", q }     — operator text filter
 *   { op: "empty"|"notempty" }               — emptiness filter
 *   { op: "in-networks", terms: [...] }      — IP network filter (IPv4 prefixes / CIDRs, any-of)
 *   { op: "pick", mode, values: [...], none } — pick filter (exact values, any / all; none = untagged)
 *   { type: "date", from?, to? }             — date range
 */
export function sanitizeFilterState(raw: unknown): SavedFilterState {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(400, "state must be an object");
  }
  const input = raw as { sfFilters?: unknown; sortKey?: unknown; sortDir?: unknown };

  const filtersRaw = input.sfFilters ?? {};
  if (filtersRaw === null || typeof filtersRaw !== "object" || Array.isArray(filtersRaw)) {
    throw new AppError(400, "state.sfFilters must be an object");
  }
  const entries = Object.entries(filtersRaw as Record<string, unknown>);
  if (entries.length > MAX_FILTER_KEYS) {
    throw new AppError(400, `state.sfFilters exceeds the ${MAX_FILTER_KEYS}-column cap`);
  }

  const sfFilters: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (!key || key.length > MAX_VALUE_LEN) throw new AppError(400, "state.sfFilters has an invalid column key");
    sfFilters[key] = sanitizeFilterValue(key, value);
  }

  const sortKey =
    typeof input.sortKey === "string" && input.sortKey.length > 0 && input.sortKey.length <= MAX_VALUE_LEN
      ? input.sortKey
      : null;
  const sortDir = input.sortDir === "asc" || input.sortDir === "desc" ? input.sortDir : null;

  return { sfFilters, sortKey, sortDir };
}

function assertShortString(value: unknown, where: string): string {
  if (typeof value !== "string") throw new AppError(400, `${where} must be a string`);
  if (value.length > MAX_VALUE_LEN) throw new AppError(400, `${where} exceeds ${MAX_VALUE_LEN} characters`);
  return value;
}

function sanitizeFilterValue(key: string, value: unknown): unknown {
  const where = `state.sfFilters["${key}"]`;
  if (typeof value === "string") return assertShortString(value, where);

  if (Array.isArray(value)) {
    if (value.length > MAX_FILTER_VALUES) throw new AppError(400, `${where} exceeds ${MAX_FILTER_VALUES} values`);
    return value.map((v) => assertShortString(v, where));
  }

  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.type === "date") {
      const from = obj.from == null ? null : assertShortString(obj.from, `${where}.from`);
      const to = obj.to == null ? null : assertShortString(obj.to, `${where}.to`);
      return { type: "date", from, to };
    }
    if (obj.op === "empty" || obj.op === "notempty") return { op: obj.op };
    if (obj.op === "contains" || obj.op === "not-contains") {
      return { op: obj.op, q: obj.q == null ? "" : assertShortString(obj.q, `${where}.q`) };
    }
    if (obj.op === "in-networks") {
      if (!Array.isArray(obj.terms)) throw new AppError(400, `${where}.terms must be an array`);
      if (obj.terms.length > MAX_FILTER_VALUES) throw new AppError(400, `${where} exceeds ${MAX_FILTER_VALUES} values`);
      return { op: "in-networks", terms: obj.terms.map((t) => assertShortString(t, `${where}.terms`)) };
    }
    // TableSF pick filter (the Assets Tags column's checkbox menu).
    if (obj.op === "pick") {
      if (!Array.isArray(obj.values)) throw new AppError(400, `${where}.values must be an array`);
      if (obj.values.length > MAX_FILTER_VALUES) throw new AppError(400, `${where} exceeds ${MAX_FILTER_VALUES} values`);
      return {
        op: "pick",
        mode: obj.mode === "all" ? "all" : "any",
        values: obj.values.map((v) => assertShortString(v, `${where}.values`)),
        none: obj.none === true,
      };
    }
    throw new AppError(400, `${where} is not a recognized filter shape`);
  }

  throw new AppError(400, `${where} is not a recognized filter shape`);
}


type Row = {
  id: string;
  scope: string;
  name: string;
  ownerId: string | null;
  ownerRoleId: string | null;
  ownerRegion: string | null;
  ownerName: string;
  visibility: string;
  state: Prisma.JsonValue;
  folderId: string | null;
  createdAt: Date;
  updatedAt: Date;
  ownerRole?: { name: string } | null;
};

const withRole = { ownerRole: { select: { name: true } } } as const;
const NOUN = "saved filter";

function toDto(row: Row, viewer: SavedViewer | null, visibleFolderIds: Set<string>): SavedFilterDto {
  return {
    id: row.id,
    scope: row.scope,
    name: row.name,
    visibility: row.visibility === "public" ? "public" : "private",
    ...ownershipDto(row, viewer),
    folderId: row.folderId && visibleFolderIds.has(row.folderId) ? row.folderId : null,
    state: row.state as unknown as SavedFilterState,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The presets and folders one caller sees in one scope (business rule 140):
 * public rows, rows they own (as the user, through their role or a region in
 * their scope), and — for a fullwrite holder — ownerless rows. An item whose
 * folder they cannot see comes back with `folderId` null (top level).
 */
export async function listSavedFilters(
  scope: string,
  viewer: SavedViewer | null,
): Promise<{ filters: SavedFilterDto[]; folders: SavedFolderDto[] }> {
  const [{ folders, visibleIds }, rows] = await Promise.all([
    listVisibleFolders("filter", scope, viewer),
    prisma.savedTableFilter.findMany({
      where: { scope, ...visibleWhere(viewer) },
      include: withRole,
      orderBy: [{ name: "asc" }],
    }),
  ]);
  return { filters: rows.map((r) => toDto(r, viewer, visibleIds)), folders };
}

async function loadOwned(id: string): Promise<Row> {
  const row = await prisma.savedTableFilter.findUnique({ where: { id }, include: withRole });
  if (!row) throw new AppError(404, "Saved filter not found");
  return row;
}

/** One preset, 404 when the caller can't see it. */
async function loadVisible(id: string, viewer: SavedViewer | null): Promise<Row> {
  const row = await loadOwned(id);
  if (!canSee(row, viewer)) throw new AppError(404, "Saved filter not found");
  return row;
}

function oneFolder(folderId: string | null): Set<string> {
  return new Set(folderId ? [folderId] : []);
}

export interface SaveFilterInput {
  scope: string;
  name: string;
  visibility: SavedFilterVisibility;
  state: SavedFilterState;
  /** undefined = leave where it is (an update) / top level (a create). */
  folderId?: string | null;
}

/**
 * Create a preset owned by `user`. A same-(scope, owner, name) row is UPDATED
 * instead of duplicated — the UI's "save over an existing name" flow — so the
 * caller never has to choose between POST and PUT.
 */
export async function createSavedFilter(input: SaveFilterInput, user: SavedViewer): Promise<SavedFilterDto> {
  const existing = await prisma.savedTableFilter.findFirst({
    where: { scope: input.scope, ownerId: user.id, name: input.name },
  });
  if (existing) return updateSavedFilter(existing.id, input, user);

  const count = await prisma.savedTableFilter.count({ where: { scope: input.scope, ownerId: user.id } });
  if (count >= MAX_PRESETS_PER_USER) {
    throw new AppError(400, `You already have ${MAX_PRESETS_PER_USER} saved filters for this page — delete one first`);
  }
  const folderId = input.folderId ?? null;
  await assertFolderTarget("filter", input.scope, folderId, user);

  const row = await prisma.savedTableFilter.create({
    data: {
      scope: input.scope,
      name: input.name,
      ownerId: user.id,
      ownerName: user.username,
      visibility: input.visibility,
      state: input.state as unknown as Prisma.InputJsonValue,
      folderId,
    },
    include: withRole,
  });
  void logEvent({
    action: "saved_filter.created",
    resourceType: "saved_filter",
    resourceId: row.id,
    resourceName: row.name,
    actor: user.username,
    message: `Saved ${row.visibility} filter "${row.name}" on ${row.scope}`,
    details: { scope: row.scope, visibility: row.visibility, folderId },
  });
  return toDto(row, user, oneFolder(folderId));
}

/** Update a preset — its owner's (or, ownerless, a fullwrite holder's) alone. */
export async function updateSavedFilter(id: string, input: SaveFilterInput, user: SavedViewer): Promise<SavedFilterDto> {
  const before = await loadVisible(id, user);
  assertCanManage(before, user, NOUN);
  if (input.folderId !== undefined) await assertFolderTarget("filter", before.scope, input.folderId, user);
  let row: Row;
  try {
    row = await prisma.savedTableFilter.update({
      where: { id },
      data: {
        name: input.name,
        visibility: input.visibility,
        state: input.state as unknown as Prisma.InputJsonValue,
        ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
      },
      include: withRole,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, `There is already a saved filter named "${input.name}" with this owner`);
    throw err;
  }
  void logEvent({
    action: "saved_filter.updated",
    resourceType: "saved_filter",
    resourceId: row.id,
    resourceName: row.name,
    actor: user.username,
    message: `Updated ${row.visibility} filter "${row.name}" on ${row.scope}`,
    details: {
      scope: row.scope,
      visibility: row.visibility,
      previousName: before.name !== row.name ? before.name : undefined,
      previousVisibility: before.visibility !== row.visibility ? before.visibility : undefined,
    },
  });
  return toDto(row, user, oneFolder(row.folderId));
}

/**
 * Delete a preset. Its owner only — a fullwrite holder may delete an OWNERLESS
 * one, never someone's owned public preset (business rule 140).
 */
export async function deleteSavedFilter(id: string, user: SavedViewer): Promise<void> {
  const row = await loadVisible(id, user);
  assertCanManage(row, user, NOUN);
  await prisma.savedTableFilter.delete({ where: { id } });
  void logEvent({
    action: "saved_filter.deleted",
    resourceType: "saved_filter",
    resourceId: row.id,
    resourceName: row.name,
    actor: user.username,
    message: `Deleted ${row.visibility} filter "${row.name}" on ${row.scope}`,
    details: { scope: row.scope, visibility: row.visibility, owner: ownerLabel(row) },
  });
}

/** File a preset in a folder (drag and drop), or at the top level with null. */
export async function moveSavedFilter(id: string, folderId: string | null, user: SavedViewer): Promise<void> {
  const row = await loadVisible(id, user);
  assertCanManage(row, user, NOUN);
  await assertFolderTarget("filter", row.scope, folderId, user);
  if (row.folderId === folderId) return;
  await prisma.savedTableFilter.update({ where: { id }, data: { folderId } });
}

/** Give a preset to a user, role or region. */
export async function changeSavedFilterOwner(
  id: string,
  target: OwnerTargetInput,
  user: SavedViewer,
): Promise<SavedFilterDto> {
  const row = await loadVisible(id, user);
  assertCanManage(row, user, NOUN);
  const { columns, label } = await resolveOwnerTarget(target);
  let after: Row;
  try {
    after = await prisma.savedTableFilter.update({ where: { id }, data: columns, include: withRole });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, `${label} already has a saved filter named "${row.name}" — rename one first`);
    throw err;
  }
  void logEvent({
    action: "saved_filter.owner_changed",
    resourceType: "saved_filter",
    resourceId: row.id,
    resourceName: row.name,
    actor: user.username,
    message: `Gave filter "${row.name}" on ${row.scope} from ${ownerLabel(row)} to ${label}`,
    details: { scope: row.scope, previousOwner: ownerLabel(row), newOwner: label },
  });
  return toDto(after, user, oneFolder(after.folderId));
}

/** "Make private to me" — the caller becomes the user owner; it turns private. */
export async function takeSavedFilter(id: string, user: SavedViewer): Promise<SavedFilterDto> {
  const row = await loadVisible(id, user);
  assertCanTake(row, user, NOUN);
  let after: Row;
  try {
    after = await prisma.savedTableFilter.update({ where: { id }, data: takenColumns(user), include: withRole });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, `You already have a saved filter named "${row.name}" — rename one first`);
    throw err;
  }
  const wasMine = row.ownerId === user.id;
  void logEvent({
    action: wasMine ? "saved_filter.updated" : "saved_filter.taken",
    resourceType: "saved_filter",
    resourceId: row.id,
    resourceName: row.name,
    actor: user.username,
    level: wasMine ? "info" : "warning",
    message: wasMine
      ? `Made filter "${row.name}" on ${row.scope} private`
      : `${user.username} took filter "${row.name}" on ${row.scope} from ${ownerLabel(row)} and made it private`,
    details: { scope: row.scope, previousOwner: ownerLabel(row), previousVisibility: row.visibility },
  });
  return toDto(after, user, oneFolder(after.folderId));
}

/** The raw row, for a route that must learn the preset's scope before gating. */
export async function getSavedFilter(id: string): Promise<Row> {
  return loadOwned(id);
}

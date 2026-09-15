/**
 * src/services/tableTabsService.ts — per-user list-page tabs.
 *
 * A tab is one open VIEW on a table: a name plus the same filter/sort state a
 * SavedTableFilter stores. The two are deliberately different things:
 *
 *   SavedTableFilter — durable, named, optionally SHARED. The artifact.
 *   UserTableTabs    — this operator's working set of open views. Private,
 *                      never shared, cascades with the user.
 *
 * A tab opened from a preset keeps only a REFERENCE (`savedFilterId` +
 * `savedFilterName`) for its label and tooltip. Editing that tab's filters
 * never writes back to the preset — the preset may belong to someone else, and
 * a tab is scratch space.
 *
 * A tab may additionally pin one preset as its BASE filter (`defaultFilterId` +
 * `defaultFilterName` + `defaultState`): the view the tab returns to, so the
 * operator can narrow further on top of it and get back with one click ("Reset
 * Filter" replaces "Clear Filters" on the page-controls row while a base is
 * set). `defaultState` is a SNAPSHOT and is what Reset actually applies — the
 * id/name are labels, and like `savedFilterId` they may dangle, so a preset
 * someone else deleted can never take a tab's base away from it. The client
 * refreshes the snapshot from the live preset whenever it lists them, which is
 * what makes an edit to the preset reach the tabs based on it.
 *
 * A tab also owns its own FAVORITES (`favoriteIds`) — the starred rows that
 * float to the top of that view. They live here rather than in localStorage
 * (where blocks/subnets favorites still live) because a favorite is part of the
 * view, and the view is server-persisted and follows the operator across
 * browsers. `null` means "this tab predates per-tab favorites", which is what
 * lets the client seed it ONCE from the old per-user localStorage set without
 * a second browser later re-seeding curated tabs.
 *
 * A tab likewise owns its COLUMN ORDER (`columnOrder`) — the left-to-right
 * sequence of the movable columns, exactly the permutation setupColumnLayout
 * persists. Order is part of a view in a way widths and visibility are not: an
 * operator arranges the columns each view is ABOUT (a firewall tab leading with
 * the FortiGate columns, an IPAM tab leading with the addresses), so it follows
 * the tab and the server, while widths / hidden columns stay per-browser in
 * localStorage where the screen they were sized for is. `null` means "this tab
 * predates per-tab column order" — same one-shot seeding rule as favoriteIds,
 * from this browser's stored layout.
 *
 * Whole-blob read/replace per (user, scope), like userDashboardService: the
 * client owns tab order + active tab and PUTs the full set. `sanitizeTabs` is
 * pure and unit-tested; it delegates per-tab state validation to
 * savedFilterService.sanitizeFilterState so a tab and a preset can never
 * disagree about what a filter blob may contain.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { sanitizeFilterState, type SavedFilterState } from "./savedFilterService.js";
import type { Prisma } from "../generated/prisma/client.js";

/** Open views per table. Above this the strip stops being navigable anyway. */
export const MAX_TABS = 20;
export const MAX_TAB_NAME_LEN = 40;
export const MAX_TAB_ID_LEN = 64;
/**
 * Starred rows per tab. Well above any real "rows I watch" list, and far below
 * what would matter: the whole strip is ONE JSON blob, so 20 tabs × this × a
 * cuid is the size the client PUTs on every star. The list route accepts up to
 * ASSET_FAVORITES_MAX (5000) ids in a query — deliberately not the same number,
 * since that one bounds a URL and this one bounds stored state.
 */
export const MAX_TAB_FAVORITES = 500;
/**
 * Column ids in one tab's saved order. The widest table this backs carries ~25
 * columns; the cap only has to stop a client from posting an unbounded array
 * into a blob that is read back on every page load.
 */
export const MAX_TAB_COLUMNS = 200;

export interface TableTab {
  id: string;
  name: string;
  state: SavedFilterState;
  /** Set when the tab was opened from a saved preset — reference only. */
  savedFilterId: string | null;
  savedFilterName: string | null;
  /**
   * The tab's BASE filter, pinned from a preset. `defaultState` is the one
   * that matters (it is what Reset applies); the id + name label it and may
   * dangle. All three are null together — see sanitizeTabs.
   */
  defaultFilterId: string | null;
  defaultFilterName: string | null;
  defaultState: SavedFilterState | null;
  /**
   * Row ids starred IN THIS TAB, in the order they were starred. `null` = the
   * tab predates per-tab favorites and the client may seed it from the legacy
   * per-user localStorage set; `[]` = the operator has none here.
   */
  favoriteIds: string[] | null;
  /**
   * The movable columns left-to-right IN THIS TAB, as setupColumnLayout stores
   * them (a permutation of column ids, not absolute indexes, so a Polaris
   * update that adds a column splices it in rather than stranding it). `null` =
   * the tab predates per-tab column order and the client may seed it from this
   * browser's stored table layout; `[]` = the operator is on the authored
   * order.
   */
  columnOrder: string[] | null;
}

export interface TableTabsLayout {
  version: 1;
  tabs: TableTab[];
  /** "" when there are no tabs; otherwise always one of tabs[].id. */
  activeId: string;
}

export const EMPTY_LAYOUT: TableTabsLayout = { version: 1, tabs: [], activeId: "" };

// C0 range + DEL — a tab name is rendered into the strip.
const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u001f\\u007f]");

function shortString(value: unknown, where: string, max: number): string {
  if (typeof value !== "string") throw new AppError(400, `${where} must be a string`);
  if (value.length > max) throw new AppError(400, `${where} exceeds ${max} characters`);
  return value;
}

/**
 * One tab's starred row ids: deduped, order preserved, bounded. Throws rather
 * than truncating — a client over the cap has a bug, and silently dropping the
 * tail would look like a star that didn't stick (the client enforces the same
 * cap at the click, where it can say so).
 */
function sanitizeFavoriteIds(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw)) throw new AppError(400, `${where} must be an array`);
  if (raw.length > MAX_TAB_FAVORITES) {
    throw new AppError(400, `${where} exceeds the ${MAX_TAB_FAVORITES}-favorite cap`);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  raw.forEach((value, i) => {
    const id = shortString(value, `${where}[${i}]`, MAX_TAB_ID_LEN);
    if (!id) throw new AppError(400, `${where}[${i}] is required`);
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  });
  return out;
}

/**
 * One tab's column order: deduped, order preserved, bounded. Unlike the
 * favorites list this does NOT throw on an unknown or missing id — the client
 * stores a permutation of whatever columns the page had when it was written,
 * and setupColumnLayout.normalizeOrder already splices in newcomers and drops
 * strangers at apply time. The server only bounds the array.
 */
function sanitizeColumnOrder(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw)) throw new AppError(400, `${where} must be an array`);
  if (raw.length > MAX_TAB_COLUMNS) {
    throw new AppError(400, `${where} exceeds the ${MAX_TAB_COLUMNS}-column cap`);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  raw.forEach((value, i) => {
    const id = shortString(value, `${where}[${i}]`, MAX_TAB_ID_LEN);
    if (!id) throw new AppError(400, `${where}[${i}] is required`);
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  });
  return out;
}

/**
 * Validate + normalize a whole tab layout. Throws AppError(400) on anything
 * malformed rather than repairing it: the client always PUTs a blob it just
 * built from live state, so a bad shape is a caller bug.
 */
export function sanitizeTabs(raw: unknown): TableTabsLayout {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(400, "tabs must be an object");
  }
  const input = raw as { tabs?: unknown; activeId?: unknown };
  if (!Array.isArray(input.tabs)) throw new AppError(400, "tabs.tabs must be an array");
  if (input.tabs.length > MAX_TABS) throw new AppError(400, `too many tabs (max ${MAX_TABS})`);

  const seen = new Set<string>();
  const tabs: TableTab[] = input.tabs.map((entry, i) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AppError(400, `tabs[${i}] must be an object`);
    }
    const t = entry as Record<string, unknown>;
    const id = shortString(t.id, `tabs[${i}].id`, MAX_TAB_ID_LEN);
    if (!id) throw new AppError(400, `tabs[${i}].id is required`);
    if (seen.has(id)) throw new AppError(400, "tab ids must be unique");
    seen.add(id);

    const name = shortString(t.name, `tabs[${i}].name`, MAX_TAB_NAME_LEN).trim();
    if (!name) throw new AppError(400, `tabs[${i}].name is required`);
    if (CONTROL_CHARS_RE.test(name)) throw new AppError(400, `tabs[${i}].name contains control characters`);

    // The snapshot is the single truth for "this tab has a base": with no
    // state to return to, a leftover id/name would label a Reset button that
    // could do nothing, so the three are normalized together.
    const defaultState = t.defaultState == null ? null : sanitizeFilterState(t.defaultState);

    return {
      id,
      name,
      state: sanitizeFilterState(t.state ?? {}),
      // A dangling savedFilterId (preset deleted, or someone else's private
      // one) is harmless — it only labels the tab — so it is NOT resolved here.
      savedFilterId:   t.savedFilterId   == null ? null : shortString(t.savedFilterId, `tabs[${i}].savedFilterId`, MAX_TAB_ID_LEN),
      savedFilterName: t.savedFilterName == null ? null : shortString(t.savedFilterName, `tabs[${i}].savedFilterName`, MAX_TAB_NAME_LEN),
      defaultFilterId:   defaultState && t.defaultFilterId   != null ? shortString(t.defaultFilterId, `tabs[${i}].defaultFilterId`, MAX_TAB_ID_LEN) : null,
      defaultFilterName: defaultState && t.defaultFilterName != null ? shortString(t.defaultFilterName, `tabs[${i}].defaultFilterName`, MAX_TAB_NAME_LEN) : null,
      defaultState,
      // Absent stays NULL rather than becoming []: the two mean different
      // things to the client (seed me from the legacy set vs. I have none).
      favoriteIds: t.favoriteIds == null ? null : sanitizeFavoriteIds(t.favoriteIds, `tabs[${i}].favoriteIds`),
      // Same null-vs-[] distinction as favoriteIds: absent means the client may
      // seed this tab from the browser's stored layout, [] means the operator
      // is deliberately on the authored order.
      columnOrder: t.columnOrder == null ? null : sanitizeColumnOrder(t.columnOrder, `tabs[${i}].columnOrder`),
    };
  });

  const activeRaw = input.activeId == null ? "" : shortString(input.activeId, "tabs.activeId", MAX_TAB_ID_LEN);
  if (tabs.length === 0) return { version: 1, tabs, activeId: "" };
  // Fall back to the first tab rather than 400-ing: an activeId that no longer
  // matches is a stale client, and losing the whole layout over it is worse.
  const activeId = tabs.some((t) => t.id === activeRaw) ? activeRaw : tabs[0]!.id;
  return { version: 1, tabs, activeId };
}

/** The caller's tabs for one table; EMPTY_LAYOUT when they have none yet. */
export async function getTabsForUser(userId: string, scope: string): Promise<TableTabsLayout> {
  const row = await prisma.userTableTabs.findUnique({ where: { userId_scope: { userId, scope } } });
  if (!row) return EMPTY_LAYOUT;
  return row.tabs as unknown as TableTabsLayout;
}

/** Full-replace upsert of one (user, scope) layout. `layout` must be sanitized. */
export async function saveTabsForUser(
  userId: string,
  scope: string,
  layout: TableTabsLayout,
): Promise<TableTabsLayout> {
  const json = layout as unknown as Prisma.InputJsonValue;
  const row = await prisma.userTableTabs.upsert({
    where:  { userId_scope: { userId, scope } },
    create: { userId, scope, tabs: json },
    update: { tabs: json },
  });
  return row.tabs as unknown as TableTabsLayout;
}

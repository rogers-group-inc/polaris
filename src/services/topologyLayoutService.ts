/**
 * src/services/topologyLayoutService.ts
 *
 * Shared Device Map topology layouts — the server-persisted counterpart of
 * the browser's old localStorage-only node positions. One TopologyLayout row
 * per (siteId, view): siteId is the FortiGate Asset id the topology graph is
 * rooted on; view is "flat" or a floor-view key from computeFloorViews
 * ("b|<area>|<building>" / "f|<area>|<building>|<floor>"). `positions` is
 * { [nodeId]: { x, y } } in pixel model coordinates — the exact shape
 * map.js saves/loads, so the client can treat server and localStorage
 * layouts interchangeably (server wins, localStorage is the per-browser
 * fallback for non-writers).
 *
 * Two blobs per row. `positions` is the LIVE layout -- rewritten by the
 * client's debounced drag save, shared with every viewer. `savedPositions`
 * is the operator's RESTORE POINT, written only by an explicit Save, which
 * is what makes "Reset to last save" a different thing from "Reset to
 * baseline": the first copies the restore point back over the live blob, the
 * second clears the live blob and keeps the restore point (a row with no
 * restore point is deleted outright).
 *
 * Full-replace semantics per (site, view): each save overwrites the whole
 * blob, so nodeIds that left the topology age out on the next save and
 * concurrent editors are last-write-wins (updatedBy/updatedAt are stored
 * for a future conditional write).
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import type { Prisma } from "../generated/prisma/client.js";

export interface TopologyNodePosition {
  x: number;
  y: number;
}

export type TopologyPositions = Record<string, TopologyNodePosition>;

export interface TopologyLayoutDto {
  view: string;
  positions: TopologyPositions;
  /** The last explicitly-saved layout, or null when this view was never saved. */
  savedPositions: TopologyPositions | null;
  savedBy: string | null;
  savedAt: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

/** Hard cap on nodes per layout blob — far above any real site's node count. */
export const MAX_LAYOUT_NODES = 3000;
/** View-key length cap (floor-view keys embed operator location-code text). */
export const MAX_VIEW_KEY_LEN = 200;
/** Node-id key length cap (real ids are UUIDs; leave slack for synthetics). */
export const MAX_NODE_ID_LEN = 300;
/** Coordinate magnitude cap — pixel model coords; nothing sane approaches this. */
export const MAX_COORD = 1e7;

// Control characters (C0 range + DEL) are never legitimate in a view key —
// keys derive from operator-typed location codes, which locKey() has already
// whitespace-collapsed.
const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u001f\\u007f]");

/**
 * A view key is "flat" (the default whole-site view, labelled "Base") or an
 * area/building/floor view key produced by computeFloorViews in
 * topology-render.js: "a|<area>", "b|<area>|<building>" or
 * "f|<area>|<building>|<floor>".
 */
export function isValidViewKey(view: unknown): view is string {
  if (typeof view !== "string") return false;
  if (view.length === 0 || view.length > MAX_VIEW_KEY_LEN) return false;
  if (CONTROL_CHARS_RE.test(view)) return false;
  return view === "flat" || /^[abf]\|/.test(view);
}

/**
 * Validate + normalize a positions blob. Throws AppError(400) on anything
 * malformed rather than silently dropping entries — the client always sends
 * a blob it just built from live Cytoscape positions, so a bad shape is a
 * caller bug, not operator data to be repaired.
 */
export function sanitizePositions(raw: unknown): TopologyPositions {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(400, "positions must be an object of { nodeId: { x, y } }");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_LAYOUT_NODES) {
    throw new AppError(400, `positions exceeds the ${MAX_LAYOUT_NODES}-node cap`);
  }
  const out: TopologyPositions = {};
  for (const [id, value] of entries) {
    if (id.length === 0 || id.length > MAX_NODE_ID_LEN) {
      throw new AppError(400, "positions contains an invalid node id");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new AppError(400, `position for "${id}" must be { x, y }`);
    }
    const { x, y } = value as { x?: unknown; y?: unknown };
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new AppError(400, `position for "${id}" must have finite numeric x and y`);
    }
    if (Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) {
      throw new AppError(400, `position for "${id}" is out of range`);
    }
    out[id] = { x, y };
  }
  return out;
}

interface LayoutRow {
  view: string;
  positions: Prisma.JsonValue;
  savedPositions: Prisma.JsonValue | null;
  savedBy: string | null;
  savedAt: Date | null;
  updatedBy: string | null;
  updatedAt: Date;
}

function toDto(row: LayoutRow): TopologyLayoutDto {
  return {
    view: row.view,
    positions: row.positions as unknown as TopologyPositions,
    savedPositions: (row.savedPositions ?? null) as unknown as TopologyPositions | null,
    savedBy: row.savedBy,
    savedAt: row.savedAt ? row.savedAt.toISOString() : null,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * All saved layouts for a site, keyed by view — embedded into the
 * GET /map/sites/:id/topology payload as `savedLayouts` so the modal has
 * every view's layout in one round-trip.
 */
export async function getLayoutsForSite(siteId: string): Promise<Record<string, TopologyLayoutDto>> {
  const rows = await prisma.topologyLayout.findMany({ where: { siteId } });
  const out: Record<string, TopologyLayoutDto> = {};
  for (const row of rows) out[row.view] = toDto(row);
  return out;
}

/** Ensure the site exists and is a firewall (topology roots are FortiGates). */
async function assertTopologySite(siteId: string): Promise<void> {
  const site = await prisma.asset.findUnique({ where: { id: siteId }, select: { assetType: true } });
  if (!site || site.assetType !== "firewall") {
    throw new AppError(404, "Site not found");
  }
}

/**
 * Full-replace upsert of one (site, view) LIVE layout -- the debounced drag
 * save. `positions` must already be validated (route Zod + sanitizePositions).
 * Deliberately never touches `savedPositions`: a drag is not a decision, and
 * overwriting the restore point from here would leave nothing to reset to.
 */
export async function saveLayout(
  siteId: string,
  view: string,
  positions: TopologyPositions,
  actor: string | null,
): Promise<TopologyLayoutDto> {
  if (!isValidViewKey(view)) throw new AppError(400, "Invalid view key");
  await assertTopologySite(siteId);
  const json = positions as unknown as Prisma.InputJsonValue;
  const row = await prisma.topologyLayout.upsert({
    where:  { siteId_view: { siteId, view } },
    create: { siteId, view, positions: json, updatedBy: actor },
    update: { positions: json, updatedBy: actor },
  });
  return toDto(row);
}

/**
 * Stamp the operator's restore point for one (site, view): the positions
 * they are looking at become BOTH the live layout and `savedPositions`.
 * Writing the live blob in the same statement is what makes Save reliable --
 * the client's debounced drag PUT may not have landed yet, and a checkpoint
 * of a layout the server has not seen would be restorable to a state nobody
 * ever displayed.
 */
export async function saveCheckpoint(
  siteId: string,
  view: string,
  positions: TopologyPositions,
  actor: string | null,
): Promise<TopologyLayoutDto> {
  if (!isValidViewKey(view)) throw new AppError(400, "Invalid view key");
  await assertTopologySite(siteId);
  const json = positions as unknown as Prisma.InputJsonValue;
  const savedAt = new Date();
  const row = await prisma.topologyLayout.upsert({
    where:  { siteId_view: { siteId, view } },
    create: { siteId, view, positions: json, savedPositions: json, savedBy: actor, savedAt, updatedBy: actor },
    update: { positions: json, savedPositions: json, savedBy: actor, savedAt, updatedBy: actor },
  });
  return toDto(row);
}

export interface LayoutResetResult {
  /** True when a stored layout was actually cleared (false = nothing to reset). */
  changed: boolean;
  /** True when the row survived because it still carries a restore point. */
  checkpointKept: boolean;
}

/**
 * Reset one (site, view) layout to the column solver's baseline -- the server
 * half of "Reset to baseline".
 *
 * A row carrying a restore point is EMPTIED rather than deleted (`positions`
 * becomes `{}`, which restores nothing at render so the solver's own
 * placement stands): an operator who resets to baseline must still be able to
 * change their mind and go back to their last save. A row with no restore
 * point has nothing worth keeping and is deleted outright, which is the
 * pre-checkpoint behavior. Idempotent either way -- the client's reset flow
 * is unconditional.
 */
export async function resetLayout(siteId: string, view: string): Promise<LayoutResetResult> {
  if (!isValidViewKey(view)) throw new AppError(400, "Invalid view key");
  const row = await prisma.topologyLayout.findUnique({
    where: { siteId_view: { siteId, view } },
    select: { id: true, savedPositions: true },
  });
  if (!row) return { changed: false, checkpointKept: false };
  if (row.savedPositions != null) {
    await prisma.topologyLayout.update({
      where: { id: row.id },
      data: { positions: {} as Prisma.InputJsonValue },
    });
    return { changed: true, checkpointKept: true };
  }
  await prisma.topologyLayout.delete({ where: { id: row.id } });
  return { changed: true, checkpointKept: false };
}

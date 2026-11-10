/**
 * src/services/topologyViewService.ts
 *
 * Saved, SHARED per-site Device Map topology views (business rules 147-149).
 * Single writer of TopologyView and TopologyBackgroundImage; node positions
 * stay in TopologyLayout (topologyLayoutService) under the view's key prefix.
 *
 *   - A view has exactly ONE mode: layer2 | topology | rack.
 *   - `shownTypes` is the set of asset types drawn (firewall always is).
 *   - topology views carry a background (OSM centre + zoom, or an uploaded
 *     image) and location-group polygons in background coordinates.
 *   - rack views carry racks and rack placements (devices and cable
 *     management placeholders), validated for bounds and overlap here.
 *   - Changing a view's mode resets everything mode-specific (rule 149).
 *
 * The default view is materialised on first read, so a site that never
 * touched views keeps behaving as before.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import type { Prisma } from "../generated/prisma/client.js";
import { detectImageMagic } from "../utils/imageMagic.js";
import { readImageSize } from "../utils/imageDimensions.js";
import { locationCodeValueProblem, setLocationCodes, type LocationCodes } from "../utils/locationCodes.js";
import { deleteLayoutsForView, countTopologyPlacements, viewLayoutPrefix } from "./topologyLayoutService.js";
import { buildChanges, logEventsBatch } from "./eventLogService.js";
import { syncDescriptionsOnSave } from "./descriptionSyncService.js";

// ─── Limits + defaults ────────────────────────────────────────────────────────

const TOPOLOGY_VIEW_MODES = ["layer2", "topology", "rack"] as const;
export type TopologyViewMode = (typeof TOPOLOGY_VIEW_MODES)[number];

/** Types a new (or reset) view draws: the infrastructure tier. */
const DEFAULT_SHOWN_TYPES = ["firewall", "router", "switch", "access_point"];
const DEFAULT_VIEW_NAME = "Base view";
const DEFAULT_RACK_UNITS = 42;
export const MAX_RACK_UNITS = 60;
const MAX_RACKS = 50;
const MAX_RACK_PLACEMENTS = 2000;
const MAX_POLYGONS = 500;
const MAX_POLYGON_POINTS = 1000;
const MAX_VIEWS_PER_SITE = 100;
export const MAX_VIEW_NAME_LEN = 80;
const MAX_SHOWN_TYPES = 100;
export const MAX_BACKGROUND_IMAGE_BYTES = 15 * 1024 * 1024;
/** Largest image side accepted (pixels) — well above any real floor-plan scan. */
const MAX_BACKGROUND_IMAGE_SIDE = 30000;
const MAX_ID_LEN = 64;
const MAX_RACK_NAME_LEN = 60;
const MAX_COORD = 1e7;
/** An unreferenced uploaded image older than this is an abandoned edit. */
const ORPHAN_IMAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ─── Shapes ───────────────────────────────────────────────────────────────────

type TopologyBackground =
  | { kind: "osm"; center: [number, number]; zoom: number }
  | { kind: "image"; imageId: string; width: number; height: number };

export interface TopologyPolygon {
  id: string;
  codes: LocationCodes;
  points: Array<[number, number]>;
}

export interface TopologyRack {
  id: string;
  name: string;
  units: number;
  order: number;
  face: "front" | "rear";
}

export interface TopologyRackPlacement {
  id: string;
  kind: "asset" | "cableManagement";
  assetId: string | null;
  rackId: string;
  face: "front" | "rear";
  startU: number;
  heightU: number;
  fullDepth: boolean;
}

export interface TopologyViewDto {
  id: string;
  siteId: string;
  name: string;
  isDefault: boolean;
  mode: TopologyViewMode;
  shownTypes: string[];
  background: TopologyBackground | null;
  polygons: TopologyPolygon[];
  racks: TopologyRack[];
  rackPlacements: TopologyRackPlacement[];
  /** TopologyLayout key prefix: "" for the default view, "v:<id>" otherwise. */
  layoutPrefix: string;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

type ViewRow = {
  id: string;
  siteId: string;
  name: string;
  isDefault: boolean;
  mode: string;
  shownTypes: string[];
  background: Prisma.JsonValue | null;
  polygons: Prisma.JsonValue;
  racks: Prisma.JsonValue;
  rackPlacements: Prisma.JsonValue;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toDto(row: ViewRow): TopologyViewDto {
  return {
    id: row.id,
    siteId: row.siteId,
    name: row.name,
    isDefault: row.isDefault,
    mode: (TOPOLOGY_VIEW_MODES as readonly string[]).includes(row.mode) ? (row.mode as TopologyViewMode) : "layer2",
    shownTypes: row.shownTypes,
    background: (row.background ?? null) as unknown as TopologyBackground | null,
    polygons: (Array.isArray(row.polygons) ? row.polygons : []) as unknown as TopologyPolygon[],
    racks: (Array.isArray(row.racks) ? row.racks : []) as unknown as TopologyRack[],
    rackPlacements: (Array.isArray(row.rackPlacements) ? row.rackPlacements : []) as unknown as TopologyRackPlacement[],
    layoutPrefix: viewLayoutPrefix(row),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

// ─── Validation (pure; every function throws AppError(400) on bad input) ──────

const bad = (msg: string): never => {
  throw new AppError(400, msg);
};

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function finite(v: unknown, what: string, max = MAX_COORD): number {
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > max) bad(`${what} must be a finite number`);
  return v as number;
}

function int(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) bad(`${what} must be a whole number from ${min} to ${max}`);
  return v as number;
}

function itemId(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_ID_LEN || /[^A-Za-z0-9_-]/.test(v)) {
    bad(`${what} id must be 1-${MAX_ID_LEN} letters, digits, "-" or "_"`);
  }
  return v as string;
}

function face(v: unknown, what: string): "front" | "rear" {
  if (v !== "front" && v !== "rear") bad(`${what} face must be "front" or "rear"`);
  return v as "front" | "rear";
}

export function sanitizeViewName(raw: unknown): string {
  if (typeof raw !== "string") bad("name is required");
  const name = (raw as string).trim().replace(/\s+/g, " ");
  if (!name) bad("name is required");
  if (name.length > MAX_VIEW_NAME_LEN) bad(`name may be at most ${MAX_VIEW_NAME_LEN} characters`);
  if (/[\u0000-\u001f\u007f]/.test(name)) bad("name contains a control character");
  return name;
}

export function sanitizeMode(raw: unknown): TopologyViewMode {
  if (!(TOPOLOGY_VIEW_MODES as readonly unknown[]).includes(raw)) bad(`mode must be one of ${TOPOLOGY_VIEW_MODES.join(", ")}`);
  return raw as TopologyViewMode;
}

/** Shown asset types: trimmed, de-duplicated, firewall always included. */
export function sanitizeShownTypes(raw: unknown): string[] {
  if (!Array.isArray(raw)) bad("shownTypes must be an array of asset types");
  const arr = raw as unknown[];
  if (arr.length > MAX_SHOWN_TYPES) bad(`shownTypes may list at most ${MAX_SHOWN_TYPES} types`);
  const out = new Set<string>(["firewall"]);
  for (const t of arr) {
    if (typeof t !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(t.trim())) bad("shownTypes contains an invalid asset type");
    out.add((t as string).trim());
  }
  return [...out];
}

/**
 * A background as the client sends it. An image background names an upload
 * by id; width/height are filled from the stored image by the caller, never
 * trusted from the client.
 */
export function sanitizeBackground(raw: unknown): { kind: "osm"; center: [number, number]; zoom: number } | { kind: "image"; imageId: string } | null {
  if (raw === null || raw === undefined) return null;
  if (!isObj(raw)) return bad("background must be null or an object");
  if (raw.kind === "osm") {
    const c = raw.center;
    if (!Array.isArray(c) || c.length !== 2) bad("background.center must be [lat, lng]");
    const lat = finite((c as unknown[])[0], "background latitude", 90);
    const lng = finite((c as unknown[])[1], "background longitude", 180);
    const zoom = finite(raw.zoom, "background zoom", 22);
    if (zoom < 1) bad("background zoom must be from 1 to 22");
    return { kind: "osm", center: [lat, lng], zoom };
  }
  if (raw.kind === "image") {
    if (typeof raw.imageId !== "string" || !/^[0-9a-f-]{36}$/.test(raw.imageId)) bad("background.imageId must be an uploaded image id");
    return { kind: "image", imageId: raw.imageId as string };
  }
  return bad('background.kind must be "osm" or "image"');
}

const CODE_FIELDS: Array<keyof LocationCodes> = ["area", "building", "floor", "room", "junctionBox"];

/** Location codes of a polygon's group: at least one value, each writable. */
function sanitizeLocationCodesObject(raw: unknown, what: string): LocationCodes {
  if (!isObj(raw)) bad(`${what} codes must be an object`);
  const r = raw as Record<string, unknown>;
  const out: LocationCodes = { area: null, building: null, floor: null, room: null, junctionBox: null };
  for (const f of CODE_FIELDS) {
    const v = r[f];
    if (v === null || v === undefined || v === "") continue;
    if (typeof v !== "string") bad(`${what} ${f} must be a string`);
    const problem = locationCodeValueProblem(v as string);
    if (problem) bad(`${what} ${f} ${problem}`);
    out[f] = (v as string).trim().replace(/\s+/g, " ");
  }
  if (CODE_FIELDS.every((f) => out[f] === null)) bad(`${what} needs at least one location code`);
  return out;
}

export function sanitizePolygons(raw: unknown): TopologyPolygon[] {
  if (!Array.isArray(raw)) bad("polygons must be an array");
  const arr = raw as unknown[];
  if (arr.length > MAX_POLYGONS) bad(`a view may hold at most ${MAX_POLYGONS} polygons`);
  const ids = new Set<string>();
  return arr.map((p, i) => {
    if (!isObj(p)) bad(`polygon ${i + 1} must be an object`);
    const pr = p as Record<string, unknown>;
    const id = itemId(pr.id, "polygon");
    if (ids.has(id)) bad(`polygon id "${id}" is used twice`);
    ids.add(id);
    const codes = sanitizeLocationCodesObject(pr.codes, `polygon ${i + 1}`);
    if (!Array.isArray(pr.points)) bad(`polygon ${i + 1} points must be an array`);
    const pts = pr.points as unknown[];
    if (pts.length < 3 || pts.length > MAX_POLYGON_POINTS) bad(`polygon ${i + 1} needs 3 to ${MAX_POLYGON_POINTS} points`);
    const points = pts.map((pt) => {
      if (!Array.isArray(pt) || pt.length !== 2) bad(`polygon ${i + 1} has a point that is not [x, y]`);
      return [finite((pt as unknown[])[0], "polygon point"), finite((pt as unknown[])[1], "polygon point")] as [number, number];
    });
    return { id, codes, points };
  });
}

export function sanitizeRacks(raw: unknown): TopologyRack[] {
  if (!Array.isArray(raw)) bad("racks must be an array");
  const arr = raw as unknown[];
  if (arr.length > MAX_RACKS) bad(`a view may hold at most ${MAX_RACKS} racks`);
  const ids = new Set<string>();
  const racks = arr.map((r, i) => {
    if (!isObj(r)) bad(`rack ${i + 1} must be an object`);
    const rr = r as Record<string, unknown>;
    const id = itemId(rr.id, "rack");
    if (ids.has(id)) bad(`rack id "${id}" is used twice`);
    ids.add(id);
    if (typeof rr.name !== "string" || !rr.name.trim() || rr.name.trim().length > MAX_RACK_NAME_LEN) {
      bad(`rack ${i + 1} needs a name of 1-${MAX_RACK_NAME_LEN} characters`);
    }
    return {
      id,
      name: (rr.name as string).trim(),
      units: int(rr.units, `rack ${i + 1} size (U)`, 1, MAX_RACK_UNITS),
      order: int(rr.order ?? i, `rack ${i + 1} order`, 0, 10000),
      face: rr.face === undefined ? "front" : face(rr.face, `rack ${i + 1}`),
    } as TopologyRack;
  });
  return racks.sort((a, b) => a.order - b.order).map((r, i) => ({ ...r, order: i }));
}

/** Faces a placement occupies: a full-depth device blocks both. */
function occupiedFaces(p: TopologyRackPlacement): Array<"front" | "rear"> {
  return p.fullDepth ? ["front", "rear"] : [p.face];
}

/**
 * Rack placements, checked against `racks`: inside the rack, no two
 * placements sharing a U on a face either occupies, each asset at most once.
 * An overlap names both items so the operator can find them.
 */
export function sanitizeRackPlacements(raw: unknown, racks: TopologyRack[]): TopologyRackPlacement[] {
  if (!Array.isArray(raw)) bad("rackPlacements must be an array");
  const arr = raw as unknown[];
  if (arr.length > MAX_RACK_PLACEMENTS) bad(`a view may hold at most ${MAX_RACK_PLACEMENTS} rack placements`);
  const rackById = new Map(racks.map((r) => [r.id, r]));
  const ids = new Set<string>();
  const assets = new Set<string>();
  const out = arr.map((p, i) => {
    if (!isObj(p)) bad(`rack placement ${i + 1} must be an object`);
    const pr = p as Record<string, unknown>;
    const id = itemId(pr.id, "rack placement");
    if (ids.has(id)) bad(`rack placement id "${id}" is used twice`);
    ids.add(id);
    const kind = pr.kind === "cableManagement" ? "cableManagement" : pr.kind === "asset" ? "asset" : bad(`rack placement ${i + 1} kind must be "asset" or "cableManagement"`);
    let assetId: string | null = null;
    if (kind === "asset") {
      if (typeof pr.assetId !== "string" || !/^[0-9a-f-]{36}$/.test(pr.assetId)) bad(`rack placement ${i + 1} needs an assetId`);
      assetId = pr.assetId as string;
      if (assets.has(assetId)) bad("a device can be racked only once per view");
      assets.add(assetId);
    }
    if (typeof pr.rackId !== "string" || !rackById.has(pr.rackId)) bad(`rack placement ${i + 1} names a rack that does not exist`);
    const rack = rackById.get(pr.rackId as string)!;
    const startU = int(pr.startU, `rack placement ${i + 1} start U`, 1, rack.units);
    const heightU = int(pr.heightU, `rack placement ${i + 1} height (U)`, 1, rack.units);
    if (startU + heightU - 1 > rack.units) bad(`rack placement ${i + 1} runs past the top of ${rack.name} (${rack.units}U)`);
    return {
      id,
      kind,
      assetId,
      rackId: rack.id,
      face: face(pr.face, `rack placement ${i + 1}`),
      startU,
      heightU,
      fullDepth: pr.fullDepth === undefined ? kind === "asset" : pr.fullDepth === true,
    } as TopologyRackPlacement;
  });
  // Overlap: per rack, per face, per U.
  const taken = new Map<string, string>();
  for (const p of out) {
    for (const f of occupiedFaces(p)) {
      for (let u = p.startU; u < p.startU + p.heightU; u++) {
        const key = `${p.rackId}|${f}|${u}`;
        const other = taken.get(key);
        if (other) bad(`rack placements "${other}" and "${p.id}" overlap at U${u} (${f})`);
        taken.set(key, p.id);
      }
    }
  }
  return out;
}

/** Racks after a rack shrinks may not cut an existing placement; returns the ones in the way. */
function placementsOutsideRacks(placements: TopologyRackPlacement[], racks: TopologyRack[]): TopologyRackPlacement[] {
  const byId = new Map(racks.map((r) => [r.id, r]));
  return placements.filter((p) => {
    const r = byId.get(p.rackId);
    return !r || p.startU + p.heightU - 1 > r.units;
  });
}

function newRack(order = 0, name = "Rack 1"): TopologyRack {
  return { id: randomUUID(), name, units: DEFAULT_RACK_UNITS, order, face: "front" };
}

/** Mode-specific fields of a freshly created or reset view. */
function freshModeFields(mode: TopologyViewMode) {
  return {
    mode,
    shownTypes: [...DEFAULT_SHOWN_TYPES],
    background: null as unknown as Prisma.InputJsonValue,
    polygons: json([]),
    racks: json(mode === "rack" ? [newRack()] : []),
    rackPlacements: json([]),
  };
}

// ─── Reads ────────────────────────────────────────────────────────────────────

async function assertSite(siteId: string): Promise<void> {
  const site = await prisma.asset.findUnique({ where: { id: siteId }, select: { assetType: true } });
  if (!site || site.assetType !== "firewall") throw new AppError(404, "Site not found");
}

async function findDefault(siteId: string): Promise<ViewRow | null> {
  return prisma.topologyView.findFirst({ where: { siteId, isDefault: true } });
}

/**
 * The site's default view, created on first use. Two first reads racing both
 * try the insert; the partial unique index lets one win and the other re-reads.
 */
async function ensureDefaultView(siteId: string): Promise<TopologyViewDto> {
  const existing = await findDefault(siteId);
  if (existing) return toDto(existing);
  try {
    const row = await prisma.topologyView.create({
      data: { siteId, name: DEFAULT_VIEW_NAME, isDefault: true, ...freshModeFields("layer2") },
    });
    return toDto(row);
  } catch (err) {
    const again = await findDefault(siteId);
    if (again) return toDto(again);
    // A non-default view already called "Base view": give the default a free name.
    if ((err as { code?: string }).code === "P2002") {
      const row = await prisma.topologyView.create({
        data: { siteId, name: `${DEFAULT_VIEW_NAME} (default)`, isDefault: true, ...freshModeFields("layer2") },
      });
      return toDto(row);
    }
    throw err;
  }
}

/** Every view of a site, default first then by name. Materialises the default. */
export async function listViews(siteId: string): Promise<TopologyViewDto[]> {
  await ensureDefaultView(siteId);
  const rows = await prisma.topologyView.findMany({ where: { siteId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
  return rows.map(toDto);
}

async function loadView(siteId: string, viewId: string): Promise<ViewRow> {
  const row = await prisma.topologyView.findFirst({ where: { id: viewId, siteId } });
  if (!row) throw new AppError(404, "View not found");
  return row;
}

// ─── Writes ───────────────────────────────────────────────────────────────────

function nameTaken(err: unknown): boolean {
  return (err as { code?: string }).code === "P2002";
}

export async function createView(
  siteId: string,
  input: { name: unknown; mode: unknown; shownTypes?: unknown },
  actor: string | null,
): Promise<TopologyViewDto> {
  await assertSite(siteId);
  const name = sanitizeViewName(input.name);
  const mode = sanitizeMode(input.mode);
  const count = await prisma.topologyView.count({ where: { siteId } });
  if (count >= MAX_VIEWS_PER_SITE) throw new AppError(400, `A site may have at most ${MAX_VIEWS_PER_SITE} views`);
  const fields = freshModeFields(mode);
  if (input.shownTypes !== undefined) fields.shownTypes = sanitizeShownTypes(input.shownTypes);
  try {
    const row = await prisma.topologyView.create({
      data: { siteId, name, isDefault: false, ...fields, createdBy: actor, updatedBy: actor },
    });
    return toDto(row);
  } catch (err) {
    if (nameTaken(err)) throw new AppError(409, `A view named "${name}" already exists for this site`);
    throw err;
  }
}

export interface ViewPatch {
  name?: unknown;
  mode?: unknown;
  shownTypes?: unknown;
  background?: unknown;
  polygons?: unknown;
  racks?: unknown;
  rackPlacements?: unknown;
}

interface ModeChangeSummary {
  from: TopologyViewMode;
  to: TopologyViewMode;
  layoutsCleared: number;
  polygonsCleared: number;
  racksCleared: number;
  rackPlacementsCleared: number;
  imagesCleared: number;
}

export interface UpdateViewResult {
  view: TopologyViewDto;
  /** Set when the patch changed the mode (rule 149): what the reset removed. */
  modeChange: ModeChangeSummary | null;
}

/**
 * Update a view. A changed `mode` RESETS the view (business rule 149): its
 * layouts, background images, polygons, racks and rack placements are
 * deleted and `shownTypes` returns to the defaults, in one transaction; any
 * other mode-specific field in the same patch is ignored. Otherwise each
 * provided field is validated and replaced whole.
 */
export async function updateView(
  siteId: string,
  viewId: string,
  patch: ViewPatch,
  actor: string | null,
): Promise<UpdateViewResult> {
  const row = await loadView(siteId, viewId);
  const current = toDto(row);
  const data: Prisma.TopologyViewUpdateInput = { updatedBy: actor };
  if (patch.name !== undefined) data.name = sanitizeViewName(patch.name);

  if (patch.mode !== undefined && sanitizeMode(patch.mode) !== current.mode) {
    const to = sanitizeMode(patch.mode);
    const fresh = freshModeFields(to);
    try {
      const result = await prisma.$transaction(async (tx) => {
        const layoutsCleared = await deleteLayoutsForView(tx, siteId, current);
        const images = await tx.topologyBackgroundImage.deleteMany({ where: { viewId } });
        const updated = await tx.topologyView.update({ where: { id: viewId }, data: { ...data, ...fresh } });
        return { updated, layoutsCleared, imagesCleared: images.count };
      });
      return {
        view: toDto(result.updated),
        modeChange: {
          from: current.mode,
          to,
          layoutsCleared: result.layoutsCleared,
          polygonsCleared: current.polygons.length,
          racksCleared: current.racks.length,
          rackPlacementsCleared: current.rackPlacements.length,
          imagesCleared: result.imagesCleared,
        },
      };
    } catch (err) {
      if (nameTaken(err)) throw new AppError(409, `A view with that name already exists for this site`);
      throw err;
    }
  }

  if (patch.shownTypes !== undefined) data.shownTypes = sanitizeShownTypes(patch.shownTypes);
  let keepImageId: string | null | undefined;
  if (patch.background !== undefined) {
    const bg = sanitizeBackground(patch.background);
    if (bg && bg.kind === "image") {
      const img = await prisma.topologyBackgroundImage.findFirst({
        where: { id: bg.imageId, viewId },
        select: { id: true, width: true, height: true },
      });
      if (!img) throw new AppError(400, "The background image was not uploaded to this view");
      data.background = json({ kind: "image", imageId: img.id, width: img.width, height: img.height });
      keepImageId = img.id;
    } else {
      data.background = bg === null ? (null as unknown as Prisma.InputJsonValue) : json(bg);
      keepImageId = null;
    }
  }
  if (patch.polygons !== undefined) data.polygons = json(sanitizePolygons(patch.polygons));
  const racks = patch.racks !== undefined ? sanitizeRacks(patch.racks) : current.racks;
  if (patch.racks !== undefined) data.racks = json(racks);
  if (patch.rackPlacements !== undefined) {
    data.rackPlacements = json(sanitizeRackPlacements(patch.rackPlacements, racks));
  } else if (patch.racks !== undefined) {
    // Racks changed alone: existing placements must still fit.
    const stranded = placementsOutsideRacks(current.rackPlacements, racks);
    if (stranded.length) {
      throw new AppError(400, `${stranded.length} rack placement${stranded.length === 1 ? "" : "s"} would no longer fit — move ${stranded.length === 1 ? "it" : "them"} first`);
    }
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.topologyView.update({ where: { id: viewId }, data });
      // Saving the background drops every uploaded image it no longer names.
      if (keepImageId !== undefined) {
        await tx.topologyBackgroundImage.deleteMany({
          where: { viewId, ...(keepImageId ? { NOT: { id: keepImageId } } : {}) },
        });
      }
      return u;
    });
    return { view: toDto(updated), modeChange: null };
  } catch (err) {
    if (nameTaken(err)) throw new AppError(409, `A view with that name already exists for this site`);
    throw err;
  }
}

/** What a mode change would remove — the numbers the warning dialog shows. */
export async function describeModeChangeLoss(siteId: string, viewId: string): Promise<{
  mode: TopologyViewMode;
  placedDevices: number;
  polygons: number;
  racks: number;
  rackPlacements: number;
  hasImage: boolean;
}> {
  const view = toDto(await loadView(siteId, viewId));
  return {
    mode: view.mode,
    placedDevices: await countTopologyPlacements(siteId, view),
    polygons: view.polygons.length,
    racks: view.racks.length,
    rackPlacements: view.rackPlacements.length,
    hasImage: view.background?.kind === "image",
  };
}

/** Delete a saved view with its layouts and images. The default view cannot be deleted. */
export async function deleteView(siteId: string, viewId: string): Promise<TopologyViewDto> {
  const row = await loadView(siteId, viewId);
  if (row.isDefault) throw new AppError(400, "The default view can't be deleted");
  await prisma.$transaction(async (tx) => {
    await deleteLayoutsForView(tx, siteId, row);
    await tx.topologyView.delete({ where: { id: viewId } }); // cascades the images
  });
  return toDto(row);
}

// ─── Location codes from polygon placements (business rule 148) ──────────────

const MAX_LOCATION_CODE_CHANGES = 500;
const MAX_DESCRIPTION_LEN = 255;

export interface LocationCodeChange {
  assetId: string;
  codes: LocationCodes;
}

export type LocationCodeResult =
  | { assetId: string; status: "updated"; description: string }
  | { assetId: string; status: "unchanged"; description: string }
  | { assetId: string; status: "refused"; reason: string };

/** Parse the commit body's changes (pure). */
export function sanitizeLocationCodeChanges(raw: unknown): LocationCodeChange[] {
  if (!Array.isArray(raw)) bad("changes must be an array");
  const arr = raw as unknown[];
  if (arr.length === 0) bad("changes is empty");
  if (arr.length > MAX_LOCATION_CODE_CHANGES) bad(`at most ${MAX_LOCATION_CODE_CHANGES} changes per save`);
  const seen = new Set<string>();
  return arr.map((c, i) => {
    if (!isObj(c)) bad(`change ${i + 1} must be an object`);
    const cr = c as Record<string, unknown>;
    if (typeof cr.assetId !== "string" || !/^[0-9a-f-]{36}$/.test(cr.assetId)) bad(`change ${i + 1} needs an assetId`);
    if (seen.has(cr.assetId as string)) bad("an asset appears twice in changes");
    seen.add(cr.assetId as string);
    return { assetId: cr.assetId as string, codes: sanitizeLocationCodesObject(cr.codes, `change ${i + 1}`) };
  });
}

/**
 * Commit staged location-code rewrites — the asset half of saving a
 * Topology view whose devices were dropped inside group polygons. Each
 * asset's description keeps its free text and takes the polygon group's
 * codes (setLocationCodes). Per-asset results: an asset outside the caller's
 * assets write scope, missing, decommissioned, or whose new description
 * would pass 255 characters is REFUSED and the others still land. Updates
 * run in one transaction; each changed asset gets the same `asset.updated`
 * Event an Edit-form save writes, and a Fortinet asset whose integration
 * syncs descriptions has the new one pushed to the device.
 */
export async function applyLocationCodeChanges(
  changes: LocationCodeChange[],
  ctx: { actor: string | null; inScope: (rec: { createdBy: string | null; tags: string[] }) => boolean },
): Promise<LocationCodeResult[]> {
  const rows = await prisma.asset.findMany({
    where: { id: { in: changes.map((c) => c.assetId) } },
    select: { id: true, hostname: true, ipAddress: true, description: true, status: true, createdBy: true, tags: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const results: LocationCodeResult[] = [];
  const writes: Array<{ id: string; name: string; from: string | null; to: string }> = [];
  for (const c of changes) {
    const a = byId.get(c.assetId);
    if (!a) { results.push({ assetId: c.assetId, status: "refused", reason: "Asset not found" }); continue; }
    if (a.status === "decommissioned") { results.push({ assetId: a.id, status: "refused", reason: "Asset is decommissioned" }); continue; }
    if (!ctx.inScope({ createdBy: a.createdBy, tags: a.tags })) {
      results.push({ assetId: a.id, status: "refused", reason: "Outside your assets write scope" });
      continue;
    }
    const next = setLocationCodes(a.description, c.codes);
    if (next.length > MAX_DESCRIPTION_LEN) {
      results.push({ assetId: a.id, status: "refused", reason: `The description would be ${next.length} characters (the limit is ${MAX_DESCRIPTION_LEN})` });
      continue;
    }
    if (next === (a.description ?? "")) { results.push({ assetId: a.id, status: "unchanged", description: next }); continue; }
    writes.push({ id: a.id, name: a.hostname || a.ipAddress || "unknown", from: a.description, to: next });
    results.push({ assetId: a.id, status: "updated", description: next });
  }
  if (writes.length) {
    await prisma.$transaction(writes.map((w) => prisma.asset.update({ where: { id: w.id }, data: { description: w.to } })));
    await logEventsBatch(writes.map((w) => ({
      action: "asset.updated",
      resourceType: "asset",
      resourceId: w.id,
      resourceName: w.name,
      actor: ctx.actor ?? undefined,
      message: `Asset "${w.name}" updated (location codes from a Device Map topology view)`,
      details: { changes: buildChanges({ description: w.from }, { description: w.to }), via: "topology-view" },
    })));
    for (const w of writes) {
      syncDescriptionsOnSave({ assetId: w.id, scope: "device", actor: ctx.actor ?? undefined }).catch(() => {});
    }
  }
  return results;
}

// ─── Background images ────────────────────────────────────────────────────────

export interface BackgroundImageDto {
  id: string;
  viewId: string;
  mimeType: string;
  width: number;
  height: number;
  size: number;
}

const MIME_BY_EXT = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" } as const;

/**
 * Store an uploaded background for a view. Does NOT change the view: the
 * client stages `background: {kind:"image", imageId}` and the save commits it
 * (and drops the images it no longer names). Unreferenced uploads older than
 * a day — abandoned edits — are pruned here.
 */
export async function saveBackgroundImage(
  siteId: string,
  viewId: string,
  buf: Buffer,
  actor: string | null,
): Promise<BackgroundImageDto> {
  const view = toDto(await loadView(siteId, viewId));
  if (view.mode !== "topology") throw new AppError(400, "Only a Topology view takes a background image");
  if (buf.length === 0) throw new AppError(400, "The image is empty");
  if (buf.length > MAX_BACKGROUND_IMAGE_BYTES) throw new AppError(413, `The image is larger than ${MAX_BACKGROUND_IMAGE_BYTES / (1024 * 1024)} MB`);
  const ext = detectImageMagic(buf);
  if (!ext) throw new AppError(400, "The background must be a PNG, JPEG or WebP image");
  const size = readImageSize(buf, ext);
  if (!size) throw new AppError(400, "The image's size could not be read");
  if (size.width > MAX_BACKGROUND_IMAGE_SIDE || size.height > MAX_BACKGROUND_IMAGE_SIDE) {
    throw new AppError(400, `The image may be at most ${MAX_BACKGROUND_IMAGE_SIDE} pixels on a side`);
  }
  const referenced = view.background?.kind === "image" ? view.background.imageId : null;
  await prisma.topologyBackgroundImage.deleteMany({
    where: {
      viewId,
      uploadedAt: { lt: new Date(Date.now() - ORPHAN_IMAGE_MAX_AGE_MS) },
      ...(referenced ? { NOT: { id: referenced } } : {}),
    },
  });
  const row = await prisma.topologyBackgroundImage.create({
    data: {
      siteId,
      viewId,
      mimeType: MIME_BY_EXT[ext],
      width: size.width,
      height: size.height,
      size: buf.length,
      data: new Uint8Array(buf),
      uploadedBy: actor,
    },
    select: { id: true, viewId: true, mimeType: true, width: true, height: true, size: true },
  });
  return row;
}

export async function getBackgroundImage(siteId: string, imageId: string): Promise<{ mimeType: string; data: Buffer; uploadedAt: Date }> {
  const row = await prisma.topologyBackgroundImage.findFirst({
    where: { id: imageId, siteId },
    select: { mimeType: true, data: true, uploadedAt: true },
  });
  if (!row) throw new AppError(404, "Image not found");
  return { mimeType: row.mimeType, data: Buffer.from(row.data), uploadedAt: row.uploadedAt };
}

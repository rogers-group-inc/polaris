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
import { isFloorNumber, locationCodeValueProblem, mergeLocationLevels, resolveEffectiveLocation, setLocationCodes, LOCATION_LEVELS, type LocationCodes, type LocationLevel } from "../utils/locationCodes.js";
import { deleteLayoutsForView, countTopologyPlacements, viewLayoutPrefix } from "./topologyLayoutService.js";
import { loadRegionIndex, resolveLocation, type RegionIndex } from "./regionTreeService.js";
import { polygonsOverlap, doubleArea, type Point } from "../utils/wallGeometry.js";
import { autoPlaceRack, autoPlaceWall, type PlaceableDevice } from "../utils/regionAutoPlace.js";
import { buildChanges, logEventsBatch } from "./eventLogService.js";
import { syncDescriptionsOnSave } from "./descriptionSyncService.js";

// ─── Limits + defaults ────────────────────────────────────────────────────────

// Rule 156: Rack and Wall views became one Room mode (migration
// 20261111120000_room_views converted every stored one).
const TOPOLOGY_VIEW_MODES = ["layer2", "topology", "room"] as const;
export type TopologyViewMode = (typeof TOPOLOGY_VIEW_MODES)[number];

/** Types a new (or reset) view draws: the infrastructure tier. */
const DEFAULT_SHOWN_TYPES = ["firewall", "router", "switch", "access_point"];
const DEFAULT_VIEW_NAME = "Base view";
const DEFAULT_RACK_UNITS = 42;
export const MAX_RACK_UNITS = 60;
const MAX_RACKS = 50;
const MAX_RACK_PLACEMENTS = 2000;
const MAX_POLYGONS = 500;
// Wall mode (rule 151): inches; one wall at most 50 ft a side.
const MAX_WALLS = 50;
const MAX_WALL_SIDE_IN = 600;
const MIN_WALL_SIDE_IN = 4;
const MAX_WALL_PLACEMENTS = 1000;
const MAX_WALL_ITEM_POINTS = 40;
const DEFAULT_WALL_W = 96;
const DEFAULT_WALL_H = 48;
// Floor layers (rule 152).
const MAX_LAYERS = 40;
const MIN_LAYER_LEVEL = -20;
const MAX_LAYER_LEVEL = 99;
const MAX_POLYGON_POINTS = 1000;
const MAX_VIEWS_PER_SITE = 100;
export const MAX_VIEW_NAME_LEN = 80;
const MAX_SHOWN_TYPES = 100;
export const MAX_BACKGROUND_IMAGE_BYTES = 15 * 1024 * 1024;
/** Largest image side accepted (pixels) — well above any real floor-plan scan. */
const MAX_BACKGROUND_IMAGE_SIDE = 30000;
const MAX_ID_LEN = 64;
const MAX_RACK_NAME_LEN = 60;
const MAX_RACK_LABEL_LEN = 64;
const THIRD_PARTY_DEFAULT_LABEL = "Third party";
const MAX_COORD = 1e7;
/** An unreferenced uploaded image older than this is an abandoned edit. */
const ORPHAN_IMAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ─── Shapes ───────────────────────────────────────────────────────────────────

type TopologyBackground =
  | { kind: "osm"; center: [number, number]; zoom: number; layer: "map" | "satellite" }
  | { kind: "image"; imageId: string; width: number; height: number };

export interface TopologyPolygon {
  id: string;
  codes: LocationCodes;
  points: Array<[number, number]>;
  /** The floor layer it is drawn on (rule 152); 0 = the flat layer. */
  layer: number;
}

/** A wall of a Wall view, in inches (rule 151). */
export interface TopologyWall {
  id: string;
  name: string;
  width: number;
  height: number;
  order: number;
}

/** One thing mounted on a wall: a polygon with whole-inch corners. */
export interface TopologyWallPlacement {
  id: string;
  kind: "asset" | "cableManagement" | "thirdParty" | "rack";
  assetId: string | null;
  /** A thirdParty box's or a rack's name; null otherwise. */
  label: string | null;
  wallId: string;
  points: Array<[number, number]>;
  /** A rack's size in U; null on the other kinds. */
  units: number | null;
  /** The Rack view a wall rack opens (same site), or null. */
  linkedViewId: string | null;
}

/** A floor layer of a Topology view (rule 152). Layer 0 is the view itself. */
export interface TopologyLayer {
  /** The floor NUMBER: what f: becomes for a device placed on it (rule 168). */
  level: number;
  /** An optional label ("Basement"); empty when the floor has none. */
  name: string;
  /** The floor's plan image (rule 152(a)); null shows only the ground. */
  background: TopologyBackground | null;
  /** Where the plan sits on the ground: centre, ground units per plan unit, degrees. */
  plan?: TopologyPlan;
}

/** A floor plan's placement on the ground (rule 152(a)). */
interface TopologyPlan {
  cx: number;
  cy: number;
  sx: number;
  sy: number;
  rot: number;
}

/** A plan placement, or undefined when absent; 400 when malformed. */
function sanitizePlan(raw: unknown, what: string): TopologyPlan | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObj(raw)) bad(`${what} plan must be an object`);
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, k: string, lo: number, hi: number): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) bad(`${what} plan ${k} must be a number from ${lo} to ${hi}`);
    return v as number;
  };
  const rot = num(r.rot ?? 0, "rot", -1e6, 1e6) % 360;
  return {
    cx: num(r.cx, "cx", -1e8, 1e8),
    cy: num(r.cy, "cy", -1e8, 1e8),
    sx: num(r.sx, "sx", 1e-7, 1e6),
    sy: num(r.sy, "sy", 1e-7, 1e6),
    rot,
  };
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
  /** asset = a Polaris device; cableManagement / thirdParty = placeholders that are not assets. */
  kind: "asset" | "cableManagement" | "thirdParty";
  assetId: string | null;
  /** The operator's name for a thirdParty block (gear Polaris does not monitor); null on the other kinds. */
  label: string | null;
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
  /** The location region the view stands for (rule 150), or null. */
  region: LocationCodes | null;
  walls: TopologyWall[];
  wallPlacements: TopologyWallPlacement[];
  layers: TopologyLayer[];
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
  region: Prisma.JsonValue | null;
  walls: Prisma.JsonValue;
  wallPlacements: Prisma.JsonValue;
  layers: Prisma.JsonValue;
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
    mode: (TOPOLOGY_VIEW_MODES as readonly string[]).includes(row.mode) ? (row.mode as TopologyViewMode)
      : row.mode === "rack" || row.mode === "wall" ? "room" : "layer2",
    shownTypes: row.shownTypes,
    background: (row.background ?? null) as unknown as TopologyBackground | null,
    polygons: ((Array.isArray(row.polygons) ? row.polygons : []) as unknown as TopologyPolygon[])
      .map((p) => ({ ...p, layer: Number.isInteger(p.layer) ? p.layer : 0 })),
    racks: (Array.isArray(row.racks) ? row.racks : []) as unknown as TopologyRack[],
    rackPlacements: (Array.isArray(row.rackPlacements) ? row.rackPlacements : []) as unknown as TopologyRackPlacement[],
    region: (row.region && typeof row.region === "object" && !Array.isArray(row.region) ? row.region : null) as unknown as LocationCodes | null,
    walls: (Array.isArray(row.walls) ? row.walls : []) as unknown as TopologyWall[],
    wallPlacements: (Array.isArray(row.wallPlacements) ? row.wallPlacements : []) as unknown as TopologyWallPlacement[],
    layers: (Array.isArray(row.layers) ? row.layers : []) as unknown as TopologyLayer[],
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
export function sanitizeBackground(raw: unknown): { kind: "osm"; center: [number, number]; zoom: number; layer: "map" | "satellite" } | { kind: "image"; imageId: string } | null {
  if (raw === null || raw === undefined) return null;
  if (!isObj(raw)) return bad("background must be null or an object");
  if (raw.kind === "osm") {
    const c = raw.center;
    if (!Array.isArray(c) || c.length !== 2) bad("background.center must be [lat, lng]");
    const lat = finite((c as unknown[])[0], "background latitude", 90);
    const lng = finite((c as unknown[])[1], "background longitude", 180);
    const zoom = finite(raw.zoom, "background zoom", 22);
    if (zoom < 1) bad("background zoom must be from 1 to 22");
    // The basemap: OpenStreetMap, or the operator-configured satellite source
    // (satelliteTileService). Kept even if satellite is later switched off —
    // the canvas then shows the map until it is back.
    if (raw.layer !== undefined && raw.layer !== "map" && raw.layer !== "satellite") bad('background.layer must be "map" or "satellite"');
    return { kind: "osm", center: [lat, lng], zoom, layer: raw.layer === "satellite" ? "satellite" : "map" };
  }
  if (raw.kind === "image") {
    if (typeof raw.imageId !== "string" || !/^[0-9a-f-]{36}$/.test(raw.imageId)) bad("background.imageId must be an uploaded image id");
    return { kind: "image", imageId: raw.imageId as string };
  }
  return bad('background.kind must be "osm" or "image"');
}

const CODE_FIELDS: Array<keyof LocationCodes> = ["area", "building", "floor", "room", "rack", "junctionBox"];

/** Location codes of a polygon's group: at least one value, each writable. */
function sanitizeLocationCodesObject(raw: unknown, what: string, allowEmpty = false): LocationCodes {
  if (!isObj(raw)) bad(`${what} codes must be an object`);
  const r = raw as Record<string, unknown>;
  const out: LocationCodes = { area: null, building: null, floor: null, room: null, rack: null, junctionBox: null };
  for (const f of CODE_FIELDS) {
    const v = r[f];
    if (v === null || v === undefined || v === "") continue;
    if (typeof v !== "string") bad(`${what} ${f} must be a string`);
    const problem = locationCodeValueProblem(v as string);
    if (problem) bad(`${what} ${f} ${problem}`);
    out[f] = (v as string).trim().replace(/\s+/g, " ");
  }
  if (!allowEmpty && CODE_FIELDS.every((f) => out[f] === null)) bad(`${what} needs at least one location code`);
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
    const layer = pr.layer === undefined || pr.layer === null ? 0 : int(pr.layer, `polygon ${i + 1} layer`, MIN_LAYER_LEVEL, MAX_LAYER_LEVEL);
    return { id, codes, points, layer };
  });
}

/**
 * Only a Rack or Wall view stands for a region (rule 150): a Topology or
 * Layer 2 view already DRAWS the site's regions, so grouping it under one
 * would say nothing (operator decision 2026-11-10).
 */
function modeTakesRegion(mode: TopologyViewMode): boolean {
  return mode === "room";
}

/**
 * The region a view stands for (rules 150, 156): a Room view stands for a
 * room, so a rack or junction box in the codes is dropped (they are the
 * view's own racks and boxes). Null when nothing is left.
 */
export function sanitizeRegion(raw: unknown): LocationCodes | null {
  if (raw === null || raw === undefined) return null;
  const codes = sanitizeLocationCodesObject(raw, "region");
  const room: LocationCodes = { ...codes, rack: null, junctionBox: null };
  return (["area", "building", "floor", "room"] as const).some((k) => room[k]) ? room : null;
}

/** A Wall view's walls, in whole inches; order normalised 0..n-1. */
export function sanitizeWalls(raw: unknown): TopologyWall[] {
  if (!Array.isArray(raw)) bad("walls must be an array");
  const arr = raw as unknown[];
  if (arr.length > MAX_WALLS) bad(`a view may hold at most ${MAX_WALLS} walls`);
  const ids = new Set<string>();
  const walls = arr.map((w, i) => {
    if (!isObj(w)) bad(`wall ${i + 1} must be an object`);
    const wr = w as Record<string, unknown>;
    const id = itemId(wr.id, "wall");
    if (ids.has(id)) bad(`wall id "${id}" is used twice`);
    ids.add(id);
    if (typeof wr.name !== "string" || !wr.name.trim() || wr.name.trim().length > MAX_RACK_NAME_LEN) {
      bad(`wall ${i + 1} needs a name of 1-${MAX_RACK_NAME_LEN} characters`);
    }
    return {
      id,
      name: (wr.name as string).trim(),
      width: int(wr.width, `wall ${i + 1} width (in)`, MIN_WALL_SIDE_IN, MAX_WALL_SIDE_IN),
      height: int(wr.height, `wall ${i + 1} height (in)`, MIN_WALL_SIDE_IN, MAX_WALL_SIDE_IN),
      order: int(wr.order ?? i, `wall ${i + 1} order`, 0, 10000),
    } as TopologyWall;
  });
  walls.sort((a, b) => a.order - b.order);
  walls.forEach((w, i) => { w.order = i; });
  return walls;
}

/**
 * What is mounted on a Wall view's walls (rule 151): each item a polygon with
 * whole-inch corners inside its wall, an asset at most once, and no two items
 * on a wall overlapping (they share no 1-inch cell — utils/wallGeometry.ts).
 * A rack carries its size and may name the Rack view it opens; the caller
 * checks that view exists (linkedViewIds).
 */
export function sanitizeWallPlacements(raw: unknown, walls: TopologyWall[]): TopologyWallPlacement[] {
  if (!Array.isArray(raw)) bad("wallPlacements must be an array");
  const arr = raw as unknown[];
  if (arr.length > MAX_WALL_PLACEMENTS) bad(`a view may hold at most ${MAX_WALL_PLACEMENTS} wall items`);
  const wallById = new Map(walls.map((w) => [w.id, w]));
  const ids = new Set<string>();
  const assets = new Set<string>();
  const out = arr.map((p, i) => {
    const what = `wall item ${i + 1}`;
    if (!isObj(p)) bad(`${what} must be an object`);
    const pr = p as Record<string, unknown>;
    const id = itemId(pr.id, "wall item");
    if (ids.has(id)) bad(`wall item id "${id}" is used twice`);
    ids.add(id);
    // Rule 156: a junction box holds devices and placeholders, never a rack.
    if (pr.kind === "rack") bad(`${what}: a rack can't go in a junction box; add it to the room as a rack`);
    const kind = pr.kind === "asset" || pr.kind === "cableManagement" || pr.kind === "thirdParty"
      ? pr.kind
      : bad(`${what} kind must be "asset", "cableManagement" or "thirdParty"`);
    let assetId: string | null = null;
    if (kind === "asset") {
      if (typeof pr.assetId !== "string" || !/^[0-9a-f-]{36}$/.test(pr.assetId)) bad(`${what} needs an assetId`);
      assetId = pr.assetId as string;
      if (assets.has(assetId)) bad("a device can be mounted only once per view");
      assets.add(assetId);
    }
    let label: string | null = null;
    if (kind === "thirdParty") {
      label = typeof pr.label === "string" ? pr.label.trim().replace(/\s+/g, " ") : "";
      if (!label) label = THIRD_PARTY_DEFAULT_LABEL;
      if (label.length > MAX_RACK_LABEL_LEN) bad(`${what} name may be at most ${MAX_RACK_LABEL_LEN} characters`);
      if (/[\x00-\x1f\x7f]/.test(label)) bad(`${what} name contains a control character`);
    }
    const units = null;
    const linkedViewId = null;
    if (typeof pr.wallId !== "string" || !wallById.has(pr.wallId)) bad(`${what} names a wall that does not exist`);
    const wall = wallById.get(pr.wallId as string)!;
    if (!Array.isArray(pr.points)) bad(`${what} points must be an array`);
    const pts = pr.points as unknown[];
    if (pts.length < 3 || pts.length > MAX_WALL_ITEM_POINTS) bad(`${what} needs 3 to ${MAX_WALL_ITEM_POINTS} corners`);
    const points = pts.map((pt) => {
      if (!Array.isArray(pt) || pt.length !== 2) bad(`${what} has a corner that is not [x, y]`);
      const x = int((pt as unknown[])[0], `${what} corner x`, 0, wall.width);
      const y = int((pt as unknown[])[1], `${what} corner y`, 0, wall.height);
      return [x, y] as [number, number];
    });
    if (doubleArea(points as Point[]) === 0) bad(`${what} has no area`);
    return { id, kind, assetId, label, wallId: wall.id, points, units, linkedViewId } as TopologyWallPlacement;
  });
  // Overlap, per wall. A view's items are few (a wall holds tens); pairwise is fine.
  const byWall = new Map<string, TopologyWallPlacement[]>();
  for (const p of out) {
    const list = byWall.get(p.wallId) ?? [];
    for (const q of list) {
      if (polygonsOverlap(p.points as Point[], q.points as Point[])) bad(`wall items "${q.id}" and "${p.id}" overlap`);
    }
    list.push(p);
    byWall.set(p.wallId, list);
  }
  return out;
}

/** A Topology view's floor layers (rule 152): distinct non-zero levels, each with a floor name. */
export function sanitizeLayers(raw: unknown): TopologyLayer[] {
  if (!Array.isArray(raw)) bad("layers must be an array");
  const arr = raw as unknown[];
  if (arr.length > MAX_LAYERS) bad(`a view may hold at most ${MAX_LAYERS} layers`);
  const levels = new Set<number>();
  const names = new Set<string>();
  const out = arr.map((l, i) => {
    if (!isObj(l)) bad(`layer ${i + 1} must be an object`);
    const lr = l as Record<string, unknown>;
    const level = int(lr.level, `layer ${i + 1} level`, MIN_LAYER_LEVEL, MAX_LAYER_LEVEL);
    if (level === 0) bad("layer 0 is the view itself and is not listed");
    if (levels.has(level)) bad(`layer ${level} is listed twice`);
    levels.add(level);
    // Rule 168: the level IS the floor (f:<level>); the name is an optional label.
    const name = typeof lr.name === "string" ? lr.name.trim().replace(/\s+/g, " ") : "";
    if (name) {
      const problem = locationCodeValueProblem(name);
      if (problem) bad(`layer ${level}'s name ${problem}`);
      if (name.length > 64) bad(`layer ${level}'s name may be at most 64 characters`);
      if (names.has(name.toLowerCase())) bad(`two layers are both called "${name}"`);
      names.add(name.toLowerCase());
    }
    const plan = sanitizePlan(lr.plan, `layer ${level}`);
    return { level, name, background: lr.background === undefined ? null : sanitizeBackground(lr.background), ...(plan ? { plan } : {}) } as TopologyLayer;
  });
  out.sort((a, b) => a.level - b.level);
  return out;
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
    const kind = pr.kind === "cableManagement" || pr.kind === "thirdParty" || pr.kind === "asset"
      ? pr.kind
      : bad(`rack placement ${i + 1} kind must be "asset", "cableManagement" or "thirdParty"`);
    let label: string | null = null;
    if (kind === "thirdParty") {
      label = typeof pr.label === "string" ? pr.label.trim().replace(/\s+/g, " ") : "";
      if (!label) label = THIRD_PARTY_DEFAULT_LABEL;
      if (label.length > MAX_RACK_LABEL_LEN) bad(`rack placement ${i + 1} name may be at most ${MAX_RACK_LABEL_LEN} characters`);
      if (/[\x00-\x1f\x7f]/.test(label)) bad(`rack placement ${i + 1} name contains a control character`);
    }
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
      label,
      rackId: rack.id,
      face: face(pr.face, `rack placement ${i + 1}`),
      startU,
      heightU,
      // Half depth unless marked full: the face it is on, so a front item and a
      // rear item may share a U (operator request 2026-11-10).
      fullDepth: pr.fullDepth === true,
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
function newWall(width = DEFAULT_WALL_W, height = DEFAULT_WALL_H, name = "Wall 1"): TopologyWall {
  return { id: randomUUID(), name, width, height, order: 0 };
}

/** Mode-specific fields of a freshly created or reset view (the region is decided by the caller). */
function freshModeFields(mode: TopologyViewMode) {
  return {
    mode,
    shownTypes: [...DEFAULT_SHOWN_TYPES],
    background: null as unknown as Prisma.InputJsonValue,
    polygons: json([]),
    racks: json([]),
    rackPlacements: json([]),
    walls: json([]),
    wallPlacements: json([]),
    layers: json([]),
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
  const index = await loadRegionIndex(siteId);
  return rows.map(toDto).map((v) => resolveViewChains(index, v));
}

/**
 * A view's stored chains read through the site's region tree (rule 153): a
 * region or polygon saved as a short code (`r:MDF`) comes back as its full
 * chain, so it compares equal to the devices' resolved locations. Storage is
 * untouched; the next save writes the resolved form. A chain the tree
 * disagrees with or doesn't know stays as saved.
 */
function resolveViewChains(index: RegionIndex, v: TopologyViewDto): TopologyViewDto {
  if (index.size === 0) return v;
  const resolve = (c: LocationCodes | null): LocationCodes | null => (c ? resolveLocation(index, c).location : c);
  return {
    ...v,
    region: resolve(v.region),
    polygons: v.polygons.map((p) => ({ ...p, codes: resolve(p.codes) ?? p.codes })),
  };
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

/** What filling a view from its region did (rule 150(a)): asset ids placed, and those that found no room. */
export interface AutoPlaced {
  placed: string[];
  unplaced: string[];
}

type PlacementFields = {
  racks: TopologyRack[];
  rackPlacements: TopologyRackPlacement[];
  walls: TopologyWall[];
  wallPlacements: TopologyWallPlacement[];
};

/**
 * Rule 150(a): a Rack or Wall view created for a region, or linked to one,
 * takes the devices whose codes already put them in that region's racks or
 * junction boxes. The region is resolved through the site's tree (rule 153)
 * and the devices arrive resolved (buildSiteTopology's `location`). Nothing
 * already placed moves, and no description is written — the codes are
 * already there. The result is validated as any client save would be.
 */
async function fillFromRegion(
  siteId: string,
  mode: TopologyViewMode,
  region: LocationCodes,
  fields: PlacementFields,
  devices: PlaceableDevice[],
  viewName: string,
): Promise<{ fields: Partial<PlacementFields>; autoPlaced: AutoPlaced }> {
  if (mode !== "room") return { fields: {}, autoPlaced: { placed: [], unplaced: [] } };
  const index = await loadRegionIndex(siteId);
  const resolved = (index.size ? resolveLocation(index, region).location : region) ?? region;
  // Rule 156: one place per device. Racks fill first (a device naming both a
  // rack and a junction box is racked), then junction boxes take the rest.
  const inBoxes = new Set(fields.wallPlacements.map((p) => p.assetId).filter((a): a is string => !!a));
  const r = autoPlaceRack(resolved, fields.racks, fields.rackPlacements, devices.filter((d) => !inBoxes.has(d.assetId)), {
    maxRacks: MAX_RACKS, maxPlacements: MAX_RACK_PLACEMENTS, defaultUnits: fields.racks[0]?.units ?? DEFAULT_RACK_UNITS, maxNameLen: MAX_RACK_NAME_LEN,
  });
  const inRacks = new Set(r.placements.map((p) => p.assetId).filter((a): a is string => !!a));
  const w = autoPlaceWall(resolved, fields.walls, fields.wallPlacements, devices.filter((d) => !inRacks.has(d.assetId)), {
    maxWalls: MAX_WALLS, maxPlacements: MAX_WALL_PLACEMENTS, defaultWidth: DEFAULT_WALL_W, defaultHeight: DEFAULT_WALL_H,
    maxNameLen: MAX_RACK_NAME_LEN, viewName,
  });
  const out: Partial<PlacementFields> = {};
  if (r.placed.length) {
    out.racks = sanitizeRacks(r.containers);
    out.rackPlacements = sanitizeRackPlacements(r.placements, out.racks);
  }
  if (w.placed.length) {
    out.walls = sanitizeWalls(w.containers);
    out.wallPlacements = sanitizeWallPlacements(w.placements, out.walls);
  }
  return { fields: out, autoPlaced: { placed: [...r.placed, ...w.placed], unplaced: [...r.unplaced, ...w.unplaced] } };
}

function asPlacementFields(v: { racks: unknown; rackPlacements: unknown; walls: unknown; wallPlacements: unknown }): PlacementFields {
  const arr = <T>(x: unknown) => (Array.isArray(x) ? x : []) as T[];
  return {
    racks: arr<TopologyRack>(v.racks),
    rackPlacements: arr<TopologyRackPlacement>(v.rackPlacements),
    walls: arr<TopologyWall>(v.walls),
    wallPlacements: arr<TopologyWallPlacement>(v.wallPlacements),
  };
}

function placementData(f: Partial<PlacementFields>): Record<string, Prisma.InputJsonValue> {
  const out: Record<string, Prisma.InputJsonValue> = {};
  for (const k of ["racks", "rackPlacements", "walls", "wallPlacements"] as const) if (f[k]) out[k] = json(f[k]);
  return out;
}

/** Two regions name the same place (after the tree resolves them). */
async function sameRegion(siteId: string, a: LocationCodes | null, b: LocationCodes | null): Promise<boolean> {
  if (!a || !b) return !a && !b;
  const index = await loadRegionIndex(siteId);
  const r = (c: LocationCodes): LocationCodes => (index.size ? resolveLocation(index, c).location : c) ?? c;
  const ra = r(a), rb = r(b);
  const keys: Array<keyof LocationCodes> = ["area", "building", "floor", "room", "rack", "junctionBox"];
  const n = (v: string | null | undefined) => String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return keys.every((k) => n(ra[k]) === n(rb[k]));
}

export async function createView(
  siteId: string,
  input: { name: unknown; mode: unknown; shownTypes?: unknown; region?: unknown; wallWidth?: unknown; wallHeight?: unknown; rackUnits?: unknown; fill?: unknown },
  actor: string | null,
  devices: PlaceableDevice[] = [],
): Promise<{ view: TopologyViewDto; autoPlaced: AutoPlaced }> {
  await assertSite(siteId);
  const name = sanitizeViewName(input.name);
  const mode = sanitizeMode(input.mode);
  const count = await prisma.topologyView.count({ where: { siteId } });
  if (count >= MAX_VIEWS_PER_SITE) throw new AppError(400, `A site may have at most ${MAX_VIEWS_PER_SITE} views`);
  const fields: ReturnType<typeof freshModeFields> & { region?: Prisma.InputJsonValue } = freshModeFields(mode);
  if (input.shownTypes !== undefined) fields.shownTypes = sanitizeShownTypes(input.shownTypes);
  const region = sanitizeRegion(input.region);
  if (region && !modeTakesRegion(mode)) throw new AppError(400, "Only a Room view can stand for a room");
  if (region) fields.region = json(region);
  // A Room view may open with one rack and / or one junction box of the size asked for.
  if (mode === "room" && (input.wallWidth !== undefined || input.wallHeight !== undefined)) {
    const w = int(input.wallWidth ?? DEFAULT_WALL_W, "junction box width (in)", MIN_WALL_SIDE_IN, MAX_WALL_SIDE_IN);
    const h = int(input.wallHeight ?? DEFAULT_WALL_H, "junction box height (in)", MIN_WALL_SIDE_IN, MAX_WALL_SIDE_IN);
    fields.walls = json([newWall(w, h, "JB 1")]);
  }
  if (mode === "room" && input.rackUnits !== undefined) {
    const r = newRack();
    r.units = int(input.rackUnits, "rack size (U)", 1, MAX_RACK_UNITS);
    fields.racks = json([r]);
  }
  let autoPlaced: AutoPlaced = { placed: [], unplaced: [] };
  if (region && devices.length && input.fill !== false) {
    const fill = await fillFromRegion(siteId, mode, region, asPlacementFields(fields), devices, name);
    Object.assign(fields, placementData(fill.fields));
    autoPlaced = fill.autoPlaced;
  }
  try {
    const row = await prisma.topologyView.create({
      data: { siteId, name, isDefault: false, ...fields, createdBy: actor, updatedBy: actor },
    });
    return { view: toDto(row), autoPlaced };
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
  region?: unknown;
  walls?: unknown;
  wallPlacements?: unknown;
  layers?: unknown;
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
  /** Devices placed because the patch linked the view to a region (rule 150(a)). */
  autoPlaced: AutoPlaced;
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
  devices: PlaceableDevice[] = [],
): Promise<UpdateViewResult> {
  const row = await loadView(siteId, viewId);
  let autoPlaced: AutoPlaced = { placed: [], unplaced: [] };
  const current = toDto(row);
  const data: Prisma.TopologyViewUpdateInput = { updatedBy: actor };
  if (patch.name !== undefined) data.name = sanitizeViewName(patch.name);

  if (patch.mode !== undefined && sanitizeMode(patch.mode) !== current.mode) {
    const to = sanitizeMode(patch.mode);
    const fresh: ReturnType<typeof freshModeFields> & { region?: Prisma.InputJsonValue } = freshModeFields(to);
    // The region survives a change between Rack and Wall, never one to a mode that takes none.
    if (!modeTakesRegion(to)) fresh.region = null as unknown as Prisma.InputJsonValue;
    else if (patch.region !== undefined) {
      const r = sanitizeRegion(patch.region);
      fresh.region = r === null ? (null as unknown as Prisma.InputJsonValue) : json(r);
    }
    // A reset view that still stands for a region is filled from it (rule 150(a)).
    const keptRegion = !modeTakesRegion(to) ? null : patch.region !== undefined ? sanitizeRegion(patch.region) : current.region;
    if (keptRegion && devices.length) {
      const fill = await fillFromRegion(siteId, to, keptRegion, asPlacementFields(fresh), devices, current.name);
      Object.assign(fresh, placementData(fill.fields));
      autoPlaced = fill.autoPlaced;
    }
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
        autoPlaced,
      };
    } catch (err) {
      if (nameTaken(err)) throw new AppError(409, `A view with that name already exists for this site`);
      throw err;
    }
  }

  if (patch.shownTypes !== undefined) data.shownTypes = sanitizeShownTypes(patch.shownTypes);
  let linkedRegion: LocationCodes | null = null;
  if (patch.region !== undefined) {
    const region = sanitizeRegion(patch.region);
    if (region && !modeTakesRegion(current.mode)) throw new AppError(400, "Only a Room view can stand for a room");
    data.region = region === null ? (null as unknown as Prisma.InputJsonValue) : json(region);
    // Newly linked, or linked to a different place: fill from it below (rule 150(a)).
    if (region && !(await sameRegion(siteId, current.region, region))) linkedRegion = region;
  }
  // An image background, on the view or on a layer, must be an upload of this
  // view; its size comes from the stored image, never the client.
  async function resolveImage(bg: ReturnType<typeof sanitizeBackground>): Promise<TopologyBackground | null> {
    if (!bg || bg.kind !== "image") return bg as TopologyBackground | null;
    const img = await prisma.topologyBackgroundImage.findFirst({
      where: { id: bg.imageId, viewId },
      select: { id: true, width: true, height: true },
    });
    if (!img) throw new AppError(400, "The background image was not uploaded to this view");
    return { kind: "image", imageId: img.id, width: img.width, height: img.height };
  }
  let nextBackground = current.background;
  let nextLayers = current.layers;
  let imagesTouched = false;
  if (patch.background !== undefined) {
    nextBackground = await resolveImage(sanitizeBackground(patch.background));
    data.background = nextBackground === null ? (null as unknown as Prisma.InputJsonValue) : json(nextBackground);
    imagesTouched = true;
  }
  if (patch.layers !== undefined) {
    const layers = sanitizeLayers(patch.layers);
    for (const l of layers) l.background = await resolveImage(l.background as ReturnType<typeof sanitizeBackground>);
    nextLayers = layers;
    data.layers = json(layers);
    imagesTouched = true;
  }
  if (patch.polygons !== undefined) data.polygons = json(sanitizePolygons(patch.polygons));
  const walls = patch.walls !== undefined ? sanitizeWalls(patch.walls) : current.walls;
  if (patch.walls !== undefined) data.walls = json(walls);
  if (patch.wallPlacements !== undefined || patch.walls !== undefined) {
    const placements = sanitizeWallPlacements(patch.wallPlacements !== undefined ? patch.wallPlacements : current.wallPlacements, walls);
    // A wall rack may open only a Rack view of this same site.
    const linked = [...new Set(placements.map((p) => p.linkedViewId).filter((v): v is string => !!v))];
    if (linked.length) {
      const found = await prisma.topologyView.findMany({ where: { id: { in: linked }, siteId, mode: "rack" }, select: { id: true } });
      const ok = new Set(found.map((f) => f.id));
      const missing = linked.filter((id) => !ok.has(id));
      if (missing.length) throw new AppError(400, "A wall rack is linked to a view that is not a Rack view of this site");
    }
    data.wallPlacements = json(placements);
  }
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
  // Rule 156: a device is in one place in a room, a rack or a junction box.
  if (current.mode === "room" && (patch.rackPlacements !== undefined || patch.wallPlacements !== undefined)) {
    const racked = new Set(((data.rackPlacements ?? current.rackPlacements) as unknown as TopologyRackPlacement[]).map((p) => p.assetId).filter(Boolean));
    const both = ((data.wallPlacements ?? current.wallPlacements) as unknown as TopologyWallPlacement[]).filter((p) => p.assetId && racked.has(p.assetId));
    if (both.length) throw new AppError(400, "A device can be in one place in a room: a rack or a junction box, not both");
  }
  // A patch that places devices itself is the operator's layout; only a bare link fills.
  if (linkedRegion && devices.length && patch.rackPlacements === undefined && patch.wallPlacements === undefined) {
    const fill = await fillFromRegion(siteId, current.mode, linkedRegion, {
      racks,
      rackPlacements: current.rackPlacements,
      walls,
      wallPlacements: current.wallPlacements,
    }, devices, typeof data.name === "string" ? data.name : current.name);
    Object.assign(data, placementData(fill.fields));
    autoPlaced = fill.autoPlaced;
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.topologyView.update({ where: { id: viewId }, data });
      // Saving a background (the view's or a layer's) drops every uploaded
      // image neither the view nor any of its layers still names.
      if (imagesTouched) {
        const keep = referencedImageIds(nextBackground, nextLayers);
        await tx.topologyBackgroundImage.deleteMany({
          where: { viewId, ...(keep.length ? { id: { notIn: keep } } : {}) },
        });
      }
      return u;
    });
    return { view: toDto(updated), modeChange: null, autoPlaced };
  } catch (err) {
    if (nameTaken(err)) throw new AppError(409, `A view with that name already exists for this site`);
    throw err;
  }
}

/** Every uploaded image a view still uses: its own background and each layer's. */
function referencedImageIds(background: TopologyBackground | null, layers: TopologyLayer[]): string[] {
  const ids: string[] = [];
  if (background?.kind === "image") ids.push(background.imageId);
  for (const l of layers) if (l.background?.kind === "image") ids.push(l.background.imageId);
  return ids;
}

/** What a mode change would remove — the numbers the warning dialog shows. */
export async function describeModeChangeLoss(siteId: string, viewId: string): Promise<{
  mode: TopologyViewMode;
  placedDevices: number;
  polygons: number;
  racks: number;
  rackPlacements: number;
  walls: number;
  wallPlacements: number;
  layers: number;
  hasImage: boolean;
}> {
  const view = toDto(await loadView(siteId, viewId));
  return {
    mode: view.mode,
    placedDevices: await countTopologyPlacements(siteId, view),
    polygons: view.polygons.length,
    racks: view.racks.length,
    rackPlacements: view.rackPlacements.length,
    walls: view.walls.length,
    wallPlacements: view.wallPlacements.length,
    layers: view.layers.length,
    hasImage: referencedImageIds(view.background, view.layers).length > 0,
  };
}

/** A site's Rack and Wall views with the regions they stand for (rule 150). */
export async function regionViewsForSite(siteId: string): Promise<Array<{ id: string; name: string; mode: TopologyViewMode; region: LocationCodes | null }>> {
  const rows = await prisma.topologyView.findMany({ where: { siteId, mode: "room" }, orderBy: { name: "asc" } });
  const index = await loadRegionIndex(siteId);
  return rows.map(toDto).map((v) => resolveViewChains(index, v)).map((v) => ({ id: v.id, name: v.name, mode: v.mode, region: v.region }));
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
  /**
   * The levels this change sets (rule 148(a)): only these are taken from
   * `codes`; every other level keeps what the device has now. Absent = the
   * codes replace all of them (a region-tree rewrite).
   */
  levels?: LocationLevel[];
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
    let levels: LocationLevel[] | undefined;
    if (cr.levels !== undefined) {
      if (!Array.isArray(cr.levels) || !cr.levels.length || cr.levels.some((l) => !(LOCATION_LEVELS as readonly unknown[]).includes(l))) {
        bad(`change ${i + 1}: levels must list one or more of ${LOCATION_LEVELS.join(", ")}`);
      }
      levels = [...new Set(cr.levels as LocationLevel[])];
    }
    // A placement's levels may all be CLEARS (a device dropped on floor 0
    // loses its f:, rule 168), so with levels an empty codes object is fine.
    const codes = sanitizeLocationCodesObject(cr.codes, `change ${i + 1}`, !!levels);
    // Rule 168: a placement that sets a floor sets a number.
    if (levels && levels.includes("floor") && codes.floor && !isFloorNumber(codes.floor)) bad(`change ${i + 1}: a floor is a number (f:-1, f:2), not "${codes.floor}"`);
    return { assetId: cr.assetId as string, codes, ...(levels ? { levels } : {}) };
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
    select: { id: true, hostname: true, ipAddress: true, description: true, status: true, createdBy: true, tags: true, fortinetTopology: true },
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
    // Rule 148(a): a placement sets only its own levels; the rest stay as the
    // device has them now (its description, else the device-side one, as the map reads it).
    const codes = c.levels
      ? mergeLocationLevels(resolveEffectiveLocation({
          description: a.description,
          deviceDescription: (a.fortinetTopology as { deviceDescription?: string | null } | null)?.deviceDescription ?? null,
        }), c.codes, c.levels)
      : c.codes;
    const next = setLocationCodes(a.description, codes);
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
  const referenced = referencedImageIds(view.background, view.layers);
  await prisma.topologyBackgroundImage.deleteMany({
    where: {
      viewId,
      uploadedAt: { lt: new Date(Date.now() - ORPHAN_IMAGE_MAX_AGE_MS) },
      ...(referenced.length ? { id: { notIn: referenced } } : {}),
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

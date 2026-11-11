/**
 * src/utils/regionAutoPlace.ts — filling a Rack or Wall view from the codes
 * its devices already carry (business rule 150(a)).
 *
 * A device whose description already puts it in a rack (`ra:`) or a junction
 * box (`jb:`) belongs to that group before any view draws it. When a Rack or
 * Wall view is created for a region, or linked to one, those devices are
 * placed for the operator: a Rack view racks every device inside the region
 * that names a rack, one rack per rack name; a Wall view mounts every device
 * that names a junction box, one wall per junction box. Placing writes no
 * description — the devices already carry the codes.
 *
 * Pure: the caller resolves the region and the devices' locations through the
 * site's region tree (rule 153) first, so `ra:rack1` alone matches its chain.
 * Nothing already in the view moves; a device already placed is skipped; a
 * device that finds no room is returned in `unplaced`.
 */

import { randomUUID } from "node:crypto";
import type { LocationCodes } from "./locationCodes.js";
import { polygonsOverlap, type Point } from "./wallGeometry.js";

export interface PlaceableDevice {
  assetId: string;
  name: string;
  /** The device's location, resolved through the region tree. */
  location: LocationCodes | null;
}

export interface AutoRack { id: string; name: string; units: number; order: number; face: "front" | "rear" }
export interface AutoRackPlacement {
  id: string; kind: "asset" | "cableManagement" | "thirdParty"; assetId: string | null; label: string | null;
  rackId: string; face: "front" | "rear"; startU: number; heightU: number; fullDepth: boolean;
}
export interface AutoWall { id: string; name: string; width: number; height: number; order: number }
export interface AutoWallPlacement {
  id: string; kind: "asset" | "cableManagement" | "thirdParty" | "rack"; assetId: string | null; label: string | null;
  wallId: string; points: Point[]; units: number | null; linkedViewId: string | null;
}

export interface AutoPlaceResult<C, P> {
  containers: C[];
  placements: P[];
  /** Asset ids placed by this call. */
  placed: string[];
  /** Asset ids that belonged here but found no room (or no container could be added). */
  unplaced: string[];
}

const CHAIN: Array<keyof LocationCodes> = ["area", "building", "floor", "room", "rack", "junctionBox"];
/** A device box on a wall, as the editor drops one (public/js/topology-wall.js). */
const WALL_DEVICE_W = 12;
const WALL_DEVICE_H = 8;
const WALL_GAP = 1;

function norm(v: string | null | undefined): string {
  return String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** True when every code the region sets is the device's own (case- and spacing-blind). */
export function locationWithin(region: LocationCodes, loc: LocationCodes | null): boolean {
  if (!loc) return false;
  let any = false;
  for (const k of CHAIN) {
    if (!norm(region[k])) continue;
    any = true;
    if (norm(region[k]) !== norm(loc[k])) return false;
  }
  return any;
}

interface Group { key: string; name: string; qualifier: string; devices: PlaceableDevice[] }

/**
 * The region's devices grouped by the code that names their container: the
 * rack (`by: "rack"`) or the junction box (`by: "junctionBox"`). Groups and
 * the devices in them come back in name order, so a fill is repeatable.
 */
export function groupRegionDevices(region: LocationCodes, devices: PlaceableDevice[], by: "rack" | "junctionBox"): Group[] {
  const cut = CHAIN.indexOf(by);
  const above = CHAIN.slice(0, cut);
  const set = (loc: LocationCodes) => above.filter((k) => norm(loc[k])).length;
  // The most fully written first, so a short code (`ra:R1` alone, one the
  // tree could not expand) joins the rack it names rather than starting one.
  const ordered = devices
    .filter((d) => d.location && norm(d.location[by]) && locationWithin(region, d.location))
    .sort((a, b) => set(b.location!) - set(a.location!));
  const groups: Array<Group & { chain: Partial<Record<keyof LocationCodes, string>> }> = [];
  for (const d of ordered) {
    const loc = d.location!;
    const name = norm(loc[by]);
    // Compatible: the same name, and no level both write differently.
    const fits = groups.filter((g) => norm(g.chain[by]) === name && above.every((k) => !norm(loc[k]) || !g.chain[k] || norm(g.chain[k]) === norm(loc[k])));
    // Joins only an unambiguous match; a short code two places could own stays apart.
    let g = fits.length === 1 ? fits[0] : undefined;
    if (!g) {
      const chain: Partial<Record<keyof LocationCodes, string>> = {};
      for (const k of [...above, by]) if (norm(loc[k])) chain[k] = String(loc[k]).trim();
      g = { key: [...above, by].map((k) => norm(loc[k])).join("|"), name: String(loc[by]).trim(), qualifier: "", devices: [], chain };
      groups.push(g);
    }
    for (const k of above) if (norm(loc[k]) && !g.chain[k]) g.chain[k] = String(loc[k]).trim();
    g.devices.push(d);
  }
  for (const g of groups) g.qualifier = above.filter((k) => k !== "rack" && g.chain[k]).map((k) => g.chain[k]).join(" / ");
  const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  const out: Group[] = groups.map((g) => ({ key: g.key, name: g.name, qualifier: g.qualifier, devices: g.devices })).sort((a, b) => cmp(a.name, b.name) || cmp(a.key, b.key));
  // Two racks of one name in different places: say where each is.
  const counts = new Map<string, number>();
  for (const g of out) counts.set(norm(g.name), (counts.get(norm(g.name)) ?? 0) + 1);
  for (const g of out) {
    if ((counts.get(norm(g.name)) ?? 0) > 1 && g.qualifier) g.name = `${g.name} · ${g.qualifier}`;
    g.devices.sort((a, b) => cmp(a.name, b.name) || cmp(a.assetId, b.assetId));
  }
  return out;
}

function clip(name: string, max: number): string {
  return name.length <= max ? name : name.slice(0, max).trim();
}

/**
 * The container a group fills: one already named for it; else an empty one
 * still carrying a placeholder name (a fresh view's "Rack 1" / "Wall 1", or a
 * wall named after its view), renamed for the group; else a new one.
 */
function containerFor<C extends { id: string; name: string; order: number }>(
  containers: C[],
  claimed: Set<string>,
  isEmpty: (c: C) => boolean,
  isPlaceholder: (c: C) => boolean,
  name: string,
  max: number,
  make: (name: string, order: number) => C,
): C | null {
  const named = containers.find((c) => !claimed.has(c.id) && norm(c.name) === norm(name));
  if (named) return named;
  const spare = containers.find((c) => !claimed.has(c.id) && isEmpty(c) && isPlaceholder(c));
  if (spare) { spare.name = name; return spare; }
  if (containers.length >= max) return null;
  const c = make(name, containers.length);
  containers.push(c);
  return c;
}

/**
 * Rack every device of the region that names a rack: one rack per rack name,
 * each device a 1U half-depth block on the first free U from the bottom —
 * front face first, then the rear (a half-depth block leaves the other face free).
 */
export function autoPlaceRack(
  region: LocationCodes,
  racksIn: AutoRack[],
  placementsIn: AutoRackPlacement[],
  devices: PlaceableDevice[],
  opts: { maxRacks: number; maxPlacements: number; defaultUnits: number; maxNameLen: number },
): AutoPlaceResult<AutoRack, AutoRackPlacement> {
  const racks = racksIn.map((r) => ({ ...r }));
  const placements = placementsIn.map((p) => ({ ...p }));
  const already = new Set(placements.map((p) => p.assetId).filter((a): a is string => !!a));
  const placed: string[] = [];
  const unplaced: string[] = [];
  const claimed = new Set<string>();
  const used = (rackId: string) => placements.some((p) => p.rackId === rackId);
  const free = (rack: AutoRack, face: "front" | "rear", u: number) =>
    !placements.some((p) => p.rackId === rack.id && u >= p.startU && u < p.startU + p.heightU && (p.face === face || p.fullDepth));

  for (const g of groupRegionDevices(region, devices, "rack")) {
    const todo = g.devices.filter((d) => !already.has(d.assetId));
    if (!todo.length) continue;
    const rack = containerFor(racks, claimed, (r) => !used(r.id), (r) => /^rack \d+$/i.test(r.name.trim()),
      clip(g.name, opts.maxNameLen), opts.maxRacks,
      (name, order): AutoRack => ({ id: randomUUID(), name, units: opts.defaultUnits, order, face: "front" }));
    if (!rack) { unplaced.push(...todo.map((d) => d.assetId)); continue; }
    claimed.add(rack.id);
    for (const d of todo) {
      let spot: { face: "front" | "rear"; u: number } | null = null;
      for (const face of ["front", "rear"] as const) {
        for (let u = 1; u <= rack.units && !spot; u++) if (free(rack, face, u)) spot = { face, u };
        if (spot) break;
      }
      if (!spot || placements.length >= opts.maxPlacements) { unplaced.push(d.assetId); continue; }
      placements.push({
        id: `rp-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        kind: "asset", assetId: d.assetId, label: null,
        rackId: rack.id, face: spot.face, startU: spot.u, heightU: 1, fullDepth: false,
      });
      already.add(d.assetId);
      placed.push(d.assetId);
    }
  }
  return { containers: racks, placements, placed, unplaced };
}

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

/**
 * Mount every device of the region that names a junction box: one wall per
 * junction box, each device a 12 × 8 in box in reading order (left to right,
 * top to bottom, a 1 in gap), on the first spot nothing else covers.
 */
export function autoPlaceWall(
  region: LocationCodes,
  wallsIn: AutoWall[],
  placementsIn: AutoWallPlacement[],
  devices: PlaceableDevice[],
  opts: { maxWalls: number; maxPlacements: number; defaultWidth: number; defaultHeight: number; maxNameLen: number; viewName?: string },
): AutoPlaceResult<AutoWall, AutoWallPlacement> {
  const walls = wallsIn.map((w) => ({ ...w }));
  const placements = placementsIn.map((p) => ({ ...p }));
  const already = new Set(placements.map((p) => p.assetId).filter((a): a is string => !!a));
  const placed: string[] = [];
  const unplaced: string[] = [];
  const claimed = new Set<string>();
  const used = (wallId: string) => placements.some((p) => p.wallId === wallId);
  const placeholder = (w: AutoWall) => /^wall \d+$/i.test(w.name.trim()) || (!!opts.viewName && norm(w.name) === norm(opts.viewName));

  for (const g of groupRegionDevices(region, devices, "junctionBox")) {
    const todo = g.devices.filter((d) => !already.has(d.assetId));
    if (!todo.length) continue;
    const wall = containerFor(walls, claimed, (w) => !used(w.id), placeholder,
      clip(g.name, opts.maxNameLen), opts.maxWalls,
      (name, order) => ({ id: randomUUID(), name, width: opts.defaultWidth, height: opts.defaultHeight, order }));
    if (!wall) { unplaced.push(...todo.map((d) => d.assetId)); continue; }
    claimed.add(wall.id);
    const onWall = () => placements.filter((p) => p.wallId === wall.id);
    for (const d of todo) {
      let spot: Point[] | null = null;
      for (let y = WALL_GAP; y + WALL_DEVICE_H <= wall.height && !spot; y += WALL_DEVICE_H + WALL_GAP) {
        for (let x = WALL_GAP; x + WALL_DEVICE_W <= wall.width && !spot; x += WALL_DEVICE_W + WALL_GAP) {
          const cand = rect(x, y, WALL_DEVICE_W, WALL_DEVICE_H);
          if (!onWall().some((p) => polygonsOverlap(cand, p.points))) spot = cand;
        }
      }
      if (!spot || placements.length >= opts.maxPlacements) { unplaced.push(d.assetId); continue; }
      placements.push({
        id: `wp-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        kind: "asset", assetId: d.assetId, label: null, wallId: wall.id,
        points: spot, units: null, linkedViewId: null,
      });
      already.add(d.assetId);
      placed.push(d.assetId);
    }
  }
  return { containers: walls, placements, placed, unplaced };
}

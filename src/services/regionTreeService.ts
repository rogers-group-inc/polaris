/**
 * src/services/regionTreeService.ts — a site's REGION TREE (business rule 153).
 *
 * Areas > buildings > floors > rooms > racks > junction boxes, one tree per
 * Device Map site (`RegionNode`). A region's name is unique per site at its
 * level, EXCEPT a floor, which is unique within its parent ("1" is in every
 * building). That is what lets a description carry a short code — `ra:rack1`
 * alone — and still say exactly where a device is: `resolveLocation` expands
 * it through the tree to the full chain.
 *
 * The tree is built FROM the location codes already in descriptions
 * (`buildFromDescriptions` only ever ADDS) and edited directly (create /
 * rename / move / merge / delete). Nothing here changes a description by
 * itself: a rename or move RETURNS the descriptions that name the region and
 * the codes they would get, and the operator commits those through the
 * reviewed rule-148 path (POST …/topology/location-codes). A site with an
 * empty tree resolves every location exactly as before.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { isFloorNumber, locationCodeValueProblem, MAX_FLOOR, MIN_FLOOR, type LocationCodes } from "../utils/locationCodes.js";
import { buildInfraParentIndex, parentAssetWhereOr, readControllerStamp, resolveInfraParentAsset } from "../utils/fortinetParentKey.js";

const REGION_KINDS = ["area", "building", "floor", "room", "rack", "junctionBox"] as const;
export type RegionKind = (typeof REGION_KINDS)[number];
const RANK: Record<RegionKind, number> = { area: 0, building: 1, floor: 2, room: 3, rack: 4, junctionBox: 5 };
const MAX_NODES_PER_SITE = 5000;

export interface RegionNodeDto {
  id: string;
  kind: RegionKind;
  name: string;
  parentId: string | null;
  /** A floor's number (rule 168) — its f: code; null when it has none yet. */
  level?: number | null;
}

/** The code a node stands for: a numbered floor's number, else its name (rule 168). */
function nodeCode(n: RegionNodeDto): string {
  return n.kind === "floor" && typeof n.level === "number" ? String(n.level) : n.name;
}

/** How a device's written codes relate to the tree. */
export type LocationStatus =
  | "asWritten"   // nothing in the tree to resolve against; the codes stand as typed
  | "resolved"    // the tree filled in (or confirmed) the chain
  | "conflict"    // the written codes disagree with the tree; shown as written
  | "ambiguous"   // a floor named without anything that places it
  | "unknown";    // the tree has regions, but none the codes name (a rename left behind, or not built yet)

const norm = (s: string | null | undefined): string => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** The unique key of a node: per site per kind, a floor per parent. */
export function uniqueKeyFor(kind: RegionKind, name: string, parentId: string | null): string {
  return kind === "floor" ? `floor|${parentId ?? ""}|${norm(name)}` : `${kind}|${norm(name)}`;
}

function isKind(v: unknown): v is RegionKind {
  return typeof v === "string" && (REGION_KINDS as readonly string[]).includes(v);
}

// ─── Resolution (pure) ───────────────────────────────────────────────────────

export interface RegionIndex {
  byId: Map<string, RegionNodeDto>;
  byKey: Map<string, RegionNodeDto>;
  /** Numbered floors by `<parent id>|<number>` (rule 168). */
  byFloorLevel: Map<string, RegionNodeDto>;
  size: number;
}

export function buildRegionIndex(nodes: RegionNodeDto[]): RegionIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byKey = new Map(nodes.map((n) => [uniqueKeyFor(n.kind, n.name, n.parentId), n]));
  const byFloorLevel = new Map<string, RegionNodeDto>();
  for (const n of nodes) if (n.kind === "floor" && typeof n.level === "number") byFloorLevel.set(`${n.parentId ?? ""}|${n.level}`, n);
  return { byId, byKey, byFloorLevel, size: nodes.length };
}

/** A building's floor named by `value`: its number, or (an old text floor) its name (rule 168). */
export function findFloor(index: RegionIndex, holderId: string, value: string): RegionNodeDto | null {
  if (isFloorNumber(value)) {
    const byLevel = index.byFloorLevel.get(`${holderId}|${Number(value.trim())}`);
    if (byLevel) return byLevel;
  }
  return index.byKey.get(uniqueKeyFor("floor", value, holderId)) ?? null;
}

/** True when a written floor value names this floor node, by number or by name. */
function floorNames(node: RegionNodeDto, value: string): boolean {
  if (typeof node.level === "number" && isFloorNumber(value) && Number(value.trim()) === node.level) return true;
  return norm(value) === norm(node.name);
}

/** A node's chain, outermost first, as codes. */
export function chainOf(index: RegionIndex, node: RegionNodeDto): LocationCodes {
  const out: LocationCodes = { area: null, building: null, floor: null, room: null, rack: null, junctionBox: null };
  let cur: RegionNodeDto | undefined = node;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out[cur.kind] = nodeCode(cur);
    cur = cur.parentId ? index.byId.get(cur.parentId) : undefined;
  }
  return out;
}

/**
 * Expand a device's written codes through the tree (rule 153).
 *  - The DEEPEST written code that names a tree node decides the chain (a
 *    floor only through its building, or as the ancestor of a deeper node).
 *  - Every written code must agree with that chain; one that doesn't is a
 *    conflict, and the codes stand as written (never silently moved).
 *  - Codes deeper than the anchor that the tree doesn't know yet are kept:
 *    `ra:rack1 jb:9` with jb 9 not in the tree resolves rack1's chain + jb 9.
 */
export function resolveLocation(index: RegionIndex, written: LocationCodes | null): { location: LocationCodes | null; status: LocationStatus } {
  if (!written) return { location: null, status: "asWritten" };
  if (index.size === 0) return { location: written, status: "asWritten" };
  let anchor: RegionNodeDto | null = null;
  for (let i = REGION_KINDS.length - 1; i >= 0 && !anchor; i--) {
    const kind = REGION_KINDS[i];
    const value = written[kind];
    if (!value) continue;
    if (kind === "floor") {
      // A floor is placed by the building it names (or, with no building, the area).
      const holder = written.building ? index.byKey.get(uniqueKeyFor("building", written.building, null))
        : written.area ? index.byKey.get(uniqueKeyFor("area", written.area, null)) : null;
      if (holder) anchor = findFloor(index, holder.id, value);
      continue;
    }
    anchor = index.byKey.get(uniqueKeyFor(kind, value, null)) ?? null;
  }
  if (!anchor) {
    // A lone floor can't say which building's floor it is.
    const onlyFloor = !!written.floor && REGION_KINDS.every((k) => k === "floor" || k === "area" || !written[k]);
    if (onlyFloor && !written.building && !written.area) return { location: written, status: "ambiguous" };
    const named = REGION_KINDS.some((k) => !!written[k]);
    return { location: written, status: named ? "unknown" : "asWritten" };
  }
  const chain = chainOf(index, anchor);
  // The anchor's floor node, if its chain has one: a written floor matches it
  // by number or by name (an old text floor, rule 168).
  let floorNode: RegionNodeDto | undefined = anchor;
  while (floorNode && floorNode.kind !== "floor") floorNode = floorNode.parentId ? index.byId.get(floorNode.parentId) : undefined;
  for (const k of REGION_KINDS) {
    if (RANK[k] > RANK[anchor.kind]) continue;
    if (k === "floor" && written.floor && floorNode) {
      if (!floorNames(floorNode, written.floor)) return { location: written, status: "conflict" };
      continue;
    }
    if (written[k] && chain[k] && norm(written[k]) !== norm(chain[k])) return { location: written, status: "conflict" };
    if (written[k] && !chain[k]) return { location: written, status: "conflict" };
  }
  const out: LocationCodes = { ...chain };
  for (const k of REGION_KINDS) if (RANK[k] > RANK[anchor.kind] && written[k]) out[k] = written[k];
  return { location: out, status: "resolved" };
}

// ─── Carrying a tree edit into stored data (pure) ───────────────────────────
// A rename / move / merge changes a region's chain from `before` to `after`.
// Polaris's OWN stored copies of that chain (a Rack / Wall view's region, a
// Topology polygon's codes, the TopologyLayout keys of floor drill-downs and
// group boxes) follow it, so nothing saved against the old name is orphaned.
// Descriptions never follow silently — they come back as rewrites (rule 153).

/** True when `codes` sits at or under the region whose old chain is `before`. */
function namesRegion(codes: LocationCodes, kind: RegionKind, before: LocationCodes): boolean {
  if (!codes[kind] || norm(codes[kind]) !== norm(before[kind])) return false;
  return REGION_KINDS.every((k) => RANK[k] >= RANK[kind] || !codes[k] || norm(codes[k]) === norm(before[k]));
}

/**
 * The codes a stored chain gets when the region `before` becomes `after`:
 * every level down to the region takes the new chain IN FULL (stored view
 * data is canonical, not short), deeper levels are kept. Null when `codes`
 * is not at or under that region.
 */
export function remapLocationCodes(codes: LocationCodes | null, kind: RegionKind, before: LocationCodes, after: LocationCodes): LocationCodes | null {
  if (!codes || !namesRegion(codes, kind, before)) return null;
  const out: LocationCodes = { ...codes };
  for (const k of REGION_KINDS) if (RANK[k] <= RANK[kind]) out[k] = after[k];
  return out;
}

// The location-key grammar of topology-render.js (computeLocationGroups,
// jbKey, _viewKeyAt): lowercased, whitespace-collapsed segments in level
// order; a junction box carries a rack segment only when it is in one.
const locKey = (v: string | null): string => String(v ?? "").replace(/\s+/g, " ").replace(/^ | $/g, "").toLowerCase();
const KEY_FIELDS: Record<string, RegionKind[]> = {
  a: ["area"],
  b: ["area", "building"],
  f: ["area", "building", "floor"],
  r: ["area", "building", "floor", "room"],
  ra: ["area", "building", "floor", "room", "rack"],
};
function keyFields(prefix: string, segCount: number): RegionKind[] | null {
  if (prefix === "jb") {
    if (segCount === 5) return ["area", "building", "floor", "room", "junctionBox"];
    if (segCount === 6) return ["area", "building", "floor", "room", "rack", "junctionBox"];
    return null;
  }
  const f = KEY_FIELDS[prefix];
  return f && f.length === segCount ? f : null;
}
function encodeKey(prefix: string, c: LocationCodes): string {
  const fields = prefix === "jb" ? keyFields("jb", c.rack ? 6 : 5)! : KEY_FIELDS[prefix];
  return prefix + "|" + fields.map((f) => locKey(c[f])).join("|");
}

/**
 * Re-key one location key ("r|mine|shop|1|closet", "jb|…") for a tree edit.
 * Null when the key is not at or under the region — or when it doesn't
 * round-trip (a value holding "|"), which is left alone rather than guessed.
 */
export function remapLocationKey(key: string, kind: RegionKind, before: LocationCodes, after: LocationCodes): string | null {
  const bar = key.indexOf("|");
  if (bar < 0) return null;
  const prefix = key.slice(0, bar);
  const segs = key.slice(bar + 1).split("|");
  const fields = keyFields(prefix, segs.length);
  if (!fields || !fields.includes(kind)) return null;
  const codes: LocationCodes = { area: null, building: null, floor: null, room: null, rack: null, junctionBox: null };
  fields.forEach((f, i) => { codes[f] = segs[i] || null; });
  if (encodeKey(prefix, codes) !== key) return null;
  // A key's skipped level is a real "nothing here", so match it strictly.
  const lowered = (c: LocationCodes): LocationCodes => Object.fromEntries(REGION_KINDS.map((k) => [k, c[k] ? locKey(c[k]) : null])) as unknown as LocationCodes;
  const b = lowered(before);
  if (!REGION_KINDS.every((k) => RANK[k] > RANK[kind] || !fields.includes(k) || (codes[k] ?? null) === (b[k] ?? null))) return null;
  const next = remapLocationCodes(codes, kind, b, lowered(after));
  if (!next) return null;
  const out = encodeKey(prefix, next);
  return out === key ? null : out;
}

/** A TopologyLayout view key: the default view's bare key, or "v:<uuid>|<key>". */
export function remapLayoutViewKey(view: string, kind: RegionKind, before: LocationCodes, after: LocationCodes): string | null {
  const m = /^(v:[0-9a-f-]{36}\|)(.+)$/.exec(view);
  const prefix = m ? m[1] : "";
  const body = m ? m[2] : view;
  const next = remapLocationKey(body, kind, before, after);
  return next ? prefix + next : null;
}

/** A positions blob with its group-box keys ("locgroup:<key>") re-keyed; null when nothing moved. */
export function remapPositionKeys(positions: unknown, kind: RegionKind, before: LocationCodes, after: LocationCodes): Record<string, unknown> | null {
  if (!positions || typeof positions !== "object" || Array.isArray(positions)) return null;
  const src = positions as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  let changed = false;
  for (const id of Object.keys(src)) {
    if (!id.startsWith("locgroup:")) continue;
    const next = remapLocationKey(id.slice("locgroup:".length), kind, before, after);
    if (!next || ("locgroup:" + next) in src) continue; // never overwrite a box already saved there
    out["locgroup:" + next] = src[id];
    delete out[id];
    changed = true;
  }
  return changed ? out : null;
}

/**
 * The descriptions a tree edit would rewrite: a chain naming the region the
 * old way, with each level it WROTE (a short code stays short) moved to the
 * new chain. Short codes that resolve through the tree aren't listed.
 */
export function rewritesFor(
  kind: RegionKind,
  before: LocationCodes,
  after: LocationCodes,
  devices: Array<{ assetId: string; name: string; written: LocationCodes | null }>,
): RegionRewrite[] {
  const rewrites: RegionRewrite[] = [];
  for (const d of devices) {
    const w = d.written;
    if (!w || !namesRegion(w, kind, before)) continue;
    const next: LocationCodes = { ...w };
    let changed = false;
    for (const k of REGION_KINDS) {
      if (RANK[k] > RANK[kind]) continue;
      if (w[k] && norm(w[k]) !== norm(after[k])) { next[k] = after[k]; changed = true; }
    }
    if (changed) rewrites.push({ assetId: d.assetId, name: d.name, from: w, codes: next });
  }
  return rewrites;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function listRegionNodes(siteId: string): Promise<RegionNodeDto[]> {
  const rows = await prisma.regionNode.findMany({ where: { siteId }, select: { id: true, kind: true, name: true, parentId: true, level: true }, orderBy: [{ name: "asc" }] });
  return rows.filter((r) => isKind(r.kind)).map((r) => ({ id: r.id, kind: r.kind as RegionKind, name: r.name, parentId: r.parentId, level: r.level }));
}

export async function loadRegionIndex(siteId: string): Promise<RegionIndex> {
  return buildRegionIndex(await listRegionNodes(siteId));
}

// ─── Writes ───────────────────────────────────────────────────────────────────

function cleanName(raw: unknown): string {
  if (typeof raw !== "string") throw new AppError(400, "name is required");
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) throw new AppError(400, "name is required");
  const problem = locationCodeValueProblem(name);
  if (problem) throw new AppError(400, `The name ${problem}`);
  return name;
}

async function loadNode(siteId: string, id: string) {
  const n = await prisma.regionNode.findFirst({ where: { id, siteId } });
  if (!n || !isKind(n.kind)) throw new AppError(404, "Region not found");
  return n as typeof n & { kind: RegionKind };
}

/** A parent must be an OUTER level of the same site (a floor's parent is required). */
async function checkParent(siteId: string, kind: RegionKind, parentId: string | null, selfId?: string): Promise<void> {
  if (kind === "floor" && !parentId) throw new AppError(400, "A floor needs the building (or area) it is in");
  if (!parentId) return;
  if (parentId === selfId) throw new AppError(400, "A region can't be inside itself");
  const p = await loadNode(siteId, parentId);
  if (RANK[p.kind] >= RANK[kind]) throw new AppError(400, `A ${kind} can't be inside a ${p.kind}`);
  // No cycles: the parent must not sit under this node.
  let cur: string | null = p.parentId;
  for (let guard = 0; cur && guard < 10; guard++) {
    if (cur === selfId) throw new AppError(400, "That would put the region inside itself");
    cur = (await prisma.regionNode.findUnique({ where: { id: cur }, select: { parentId: true } }))?.parentId ?? null;
  }
}

/** A floor's number from input: a whole number in range, or null for "none" (rule 168). */
function cleanLevel(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < MIN_FLOOR || n > MAX_FLOOR) throw new AppError(400, `A floor number is a whole number from ${MIN_FLOOR} to ${MAX_FLOOR}`);
  return n;
}

/** A building has one floor per number (rule 168). */
async function checkFloorLevel(siteId: string, parentId: string | null, level: number | null, selfId?: string): Promise<void> {
  if (level === null) return;
  const twin = await prisma.regionNode.findFirst({ where: { siteId, kind: "floor", parentId, level, ...(selfId ? { NOT: { id: selfId } } : {}) }, select: { name: true } });
  if (twin) throw new AppError(409, `That building already has floor ${level}${twin.name !== String(level) ? ` ("${twin.name}")` : ""}`);
}

function clash(err: unknown): boolean {
  return (err as { code?: string }).code === "P2002";
}

export async function createRegionNode(siteId: string, input: { kind: unknown; name?: unknown; parentId?: unknown; level?: unknown }, actor: string | null): Promise<RegionNodeDto> {
  if (!isKind(input.kind)) throw new AppError(400, `kind must be one of ${REGION_KINDS.join(", ")}`);
  const kind = input.kind;
  // Rule 168: a floor is a number; its name is an optional label (the number when none).
  const level = kind === "floor" ? cleanLevel(input.level) : null;
  if (kind === "floor" && level === null) throw new AppError(400, "A floor needs its number (e.g. -1, 0, 2)");
  const name = kind === "floor" && (input.name === undefined || input.name === null || String(input.name).trim() === "") ? String(level) : cleanName(input.name);
  const parentId = typeof input.parentId === "string" && input.parentId ? input.parentId : null;
  await checkParent(siteId, kind, parentId);
  if (kind === "floor") await checkFloorLevel(siteId, parentId, level);
  if ((await prisma.regionNode.count({ where: { siteId } })) >= MAX_NODES_PER_SITE) throw new AppError(400, `A site may have at most ${MAX_NODES_PER_SITE} regions`);
  try {
    const row = await prisma.regionNode.create({ data: { siteId, kind, name, parentId, level, uniqueKey: uniqueKeyFor(kind, name, parentId), createdBy: actor } });
    return { id: row.id, kind, name: row.name, parentId: row.parentId, level: row.level };
  } catch (err) {
    if (clash(err)) throw new AppError(409, kind === "floor" ? `That building already has a floor "${name}"` : `This site already has a ${kind} called "${name}"`);
    throw err;
  }
}

/**
 * Add every region the site's descriptions name that the tree lacks, top
 * down, each under the nearest region its own chain names. ONLY ADDS: an
 * existing region keeps its place even when a description disagrees (that
 * description then reads as a conflict). Returns what it added.
 */
export async function buildFromDescriptions(siteId: string, locations: Array<LocationCodes | null>, actor: string | null): Promise<{ added: number }> {
  const nodes = await listRegionNodes(siteId);
  const index = buildRegionIndex(nodes);
  const toCreate: Array<{ id: string; kind: RegionKind; name: string; parentId: string | null; level: number | null; uniqueKey: string }> = [];
  const { randomUUID } = await import("node:crypto");
  for (const loc of locations) {
    if (!loc) continue;
    let parent: RegionNodeDto | null = null;
    for (const kind of REGION_KINDS) {
      const value = loc[kind];
      if (!value || locationCodeValueProblem(value)) continue;
      if (kind === "floor" && !parent) continue; // a floor with nothing above it can't be placed
      const key = uniqueKeyFor(kind, value, kind === "floor" ? parent!.id : null);
      let node: RegionNodeDto | null = kind === "floor" ? findFloor(index, parent!.id, value) : index.byKey.get(key) ?? null;
      if (!node) {
        // Rule 168: a numeric floor becomes that numbered floor; a text one a
        // floor of that name, waiting for its number.
        const level = kind === "floor" && isFloorNumber(value) ? Number(value.trim()) : null;
        node = { id: randomUUID(), kind, name: value.trim().replace(/\s+/g, " "), parentId: parent ? parent.id : null, level };
        index.byKey.set(key, node);
        index.byId.set(node.id, node);
        if (level !== null) index.byFloorLevel.set(`${parent!.id}|${level}`, node);
        toCreate.push({ id: node.id, kind, name: node.name, parentId: node.parentId, level, uniqueKey: key });
      }
      parent = node;
    }
  }
  if (nodes.length + toCreate.length > MAX_NODES_PER_SITE) throw new AppError(400, `A site may have at most ${MAX_NODES_PER_SITE} regions`);
  if (toCreate.length) {
    // Parents first (toCreate is already top-down per chain).
    await prisma.$transaction(toCreate.map((n) => prisma.regionNode.create({ data: { ...n, siteId, createdBy: actor } })));
  }
  return { added: toCreate.length };
}

/** One description a tree edit would rewrite, and the codes it would get. */
export interface RegionRewrite {
  assetId: string;
  name: string;
  from: LocationCodes;
  codes: LocationCodes;
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Carry a tree edit into the site's stored view data, inside the edit's own
 * transaction: Rack / Wall view regions, Topology polygon codes and the
 * TopologyLayout keys (floor drill-down views and saved group boxes). A
 * re-keyed layout row never replaces one already saved under the new key.
 */
async function carryStoredChains(tx: Tx, siteId: string, kind: RegionKind, before: LocationCodes, after: LocationCodes): Promise<{ views: number; layouts: number }> {
  let views = 0;
  let layouts = 0;
  const rows = await tx.topologyView.findMany({ where: { siteId }, select: { id: true, mode: true, region: true, polygons: true, racks: true, walls: true } });
  for (const v of rows) {
    const data: { region?: object; polygons?: object[]; racks?: object[]; walls?: object[] } = {};
    // Rule 156: a Room view's racks and junction boxes are named by their
    // codes, so a renamed rack / box renames the one in its room's view.
    if (v.mode === "room" && (kind === "rack" || kind === "junctionBox")) {
      const field = kind === "rack" ? "racks" : "walls";
      const renamed = renameRoomContainers(v.region as unknown as LocationCodes | null, v[field], kind, before, after);
      if (renamed) data[field] = renamed;
    }
    const region = remapLocationCodes(v.region as unknown as LocationCodes | null, kind, before, after);
    if (region) data.region = region;
    if (Array.isArray(v.polygons)) {
      let moved = false;
      const polys = (v.polygons as unknown as Array<{ codes?: LocationCodes }>).map((p) => {
        const codes = remapLocationCodes(p && p.codes ? p.codes : null, kind, before, after);
        if (!codes) return p;
        moved = true;
        return { ...p, codes };
      });
      if (moved) data.polygons = polys as object[];
    }
    if (Object.keys(data).length) {
      await tx.topologyView.update({ where: { id: v.id }, data });
      views++;
    }
  }
  const layoutRows = await tx.topologyLayout.findMany({ where: { siteId }, select: { id: true, view: true, positions: true, savedPositions: true } });
  const taken = new Set(layoutRows.map((r) => r.view));
  for (const r of layoutRows) {
    const data: { view?: string; positions?: object; savedPositions?: object } = {};
    const view = remapLayoutViewKey(r.view, kind, before, after);
    if (view && !taken.has(view)) { data.view = view; taken.delete(r.view); taken.add(view); }
    const positions = remapPositionKeys(r.positions, kind, before, after);
    if (positions) data.positions = positions;
    const saved = remapPositionKeys(r.savedPositions, kind, before, after);
    if (saved) data.savedPositions = saved;
    if (Object.keys(data).length) {
      await tx.topologyLayout.update({ where: { id: r.id }, data });
      layouts++;
    }
  }
  return { views, layouts };
}

/**
 * Pure (rule 156) — a Room view's racks or junction boxes after the region
 * tree renames one: the view must stand for the renamed container's room,
 * and only a container carrying the old name takes the new one. Null when
 * nothing changes. A move to another room renames nothing here.
 */
export function renameRoomContainers(
  viewRegion: LocationCodes | null,
  containers: unknown,
  kind: "rack" | "junctionBox",
  before: LocationCodes,
  after: LocationCodes,
): object[] | null {
  if (!viewRegion || !Array.isArray(containers)) return null;
  const n = (v: string | null | undefined) => String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const from = n(before[kind]), to = String(after[kind] ?? "").trim();
  if (!from || !to || from === n(to)) return null;
  // The view's room must be the container's room (levels the view sets).
  for (const k of ["area", "building", "floor", "room"] as const) {
    if (n(viewRegion[k]) && n(viewRegion[k]) !== n(before[k])) return null;
  }
  if (!n(viewRegion.room)) return null;
  let changed = false;
  const out = (containers as Array<{ name?: unknown }>).map((c) => {
    if (c && typeof c.name === "string" && n(c.name) === from) { changed = true; return { ...c, name: to }; }
    return c;
  });
  return changed ? (out as object[]) : null;
}

/** A region's chain after a rename / move, read from the index as it stands before it. */
function chainAfterEdit(index: RegionIndex, kind: RegionKind, name: string, parentId: string | null, level: number | null = null): LocationCodes {
  const parent = parentId ? index.byId.get(parentId) : undefined;
  const out = parent ? chainOf(index, parent) : { area: null, building: null, floor: null, room: null, rack: null, junctionBox: null };
  out[kind] = kind === "floor" && level !== null ? String(level) : name;
  return out;
}

/**
 * Rename and / or move a region. Stored view data (view regions, polygons,
 * layout keys) follows in the same transaction. Returns the node and the
 * descriptions that name it in a way the edit changes, with the codes each
 * would get; nothing is written to a description here.
 */
export async function updateRegionNode(
  siteId: string,
  id: string,
  patch: { name?: unknown; parentId?: unknown; level?: unknown },
  devices: Array<{ assetId: string; name: string; written: LocationCodes | null }>,
): Promise<{ node: RegionNodeDto; rewrites: RegionRewrite[]; carried: { views: number; layouts: number } }> {
  const node = await loadNode(siteId, id);
  const index = await loadRegionIndex(siteId);
  const before = chainOf(index, { id: node.id, kind: node.kind, name: node.name, parentId: node.parentId, level: node.level });
  const level = node.kind === "floor" && patch.level !== undefined ? cleanLevel(patch.level) : node.level;
  if (node.kind !== "floor" && patch.level !== undefined && patch.level !== null) throw new AppError(400, "Only a floor has a number");
  const name = patch.name !== undefined
    ? (node.kind === "floor" && String(patch.name ?? "").trim() === "" && level !== null ? String(level) : cleanName(patch.name))
    : node.name;
  const parentId = patch.parentId !== undefined ? (typeof patch.parentId === "string" && patch.parentId ? patch.parentId : null) : node.parentId;
  if (parentId !== node.parentId) await checkParent(siteId, node.kind, parentId, node.id);
  if (node.kind === "floor" && (level !== node.level || parentId !== node.parentId)) await checkFloorLevel(siteId, parentId, level, node.id);
  const after = chainAfterEdit(index, node.kind, name, parentId, level);
  let carried = { views: 0, layouts: 0 };
  try {
    await prisma.$transaction(async (tx) => {
      // A building's floors key on their parent id, which did not change; nothing to re-key.
      await tx.regionNode.update({ where: { id }, data: { name, parentId, level, uniqueKey: uniqueKeyFor(node.kind, name, parentId) } });
      carried = await carryStoredChains(tx, siteId, node.kind, before, after);
    });
  } catch (err) {
    if (clash(err)) throw new AppError(409, node.kind === "floor" ? `That building already has a floor "${name}"` : `This site already has a ${node.kind} called "${name}"`);
    throw err;
  }
  return { node: { id, kind: node.kind, name, parentId, level }, rewrites: rewritesFor(node.kind, before, after, devices), carried };
}

/**
 * Fold one region into another of the same kind: its children move, it is
 * removed, stored view data follows, and the descriptions that name it come
 * back as rewrites to the region it joined.
 */
export async function mergeRegionNodes(
  siteId: string,
  fromId: string,
  intoId: string,
  devices: Array<{ assetId: string; name: string; written: LocationCodes | null }> = [],
): Promise<{ node: RegionNodeDto; rewrites: RegionRewrite[]; carried: { views: number; layouts: number } }> {
  if (fromId === intoId) throw new AppError(400, "Pick a different region to merge into");
  const from = await loadNode(siteId, fromId);
  const into = await loadNode(siteId, intoId);
  if (from.kind !== into.kind) throw new AppError(400, "Only regions of the same kind can be merged");
  const index = await loadRegionIndex(siteId);
  const before = chainOf(index, { id: from.id, kind: from.kind, name: from.name, parentId: from.parentId, level: from.level });
  const after = chainOf(index, { id: into.id, kind: into.kind, name: into.name, parentId: into.parentId, level: into.level });
  let carried = { views: 0, layouts: 0 };
  await prisma.$transaction(async (tx) => {
    const kids = await tx.regionNode.findMany({ where: { parentId: fromId } });
    for (const k of kids) {
      if (!isKind(k.kind)) continue;
      const key = uniqueKeyFor(k.kind, k.name, intoId);
      const twin = await tx.regionNode.findFirst({ where: { siteId, uniqueKey: key, NOT: { id: k.id } } });
      if (twin) throw new AppError(409, `Both have a ${k.kind} called "${k.name}" — merge those first`);
      // Rule 168: a building has one floor per NUMBER, and the name is only a
      // label — "Ground" (level 1) and "1" (level 1) are different names but
      // the same floor, so the name check above lets them both through.
      if (k.kind === "floor" && k.level !== null) {
        const levelTwin = await tx.regionNode.findFirst({ where: { siteId, kind: "floor", parentId: intoId, level: k.level, NOT: { id: k.id } }, select: { name: true } });
        if (levelTwin) throw new AppError(409, `Both have floor ${k.level} ("${k.name}" and "${levelTwin.name}") — merge those first`);
      }
      await tx.regionNode.update({ where: { id: k.id }, data: { parentId: intoId, uniqueKey: key } });
    }
    await tx.regionNode.delete({ where: { id: fromId } });
    carried = await carryStoredChains(tx, siteId, from.kind, before, after);
  });
  return {
    node: { id: into.id, kind: into.kind, name: into.name, parentId: into.parentId },
    rewrites: rewritesFor(from.kind, before, after, devices),
    carried,
  };
}

/** Delete a region with nothing inside it. Descriptions are not touched. */
export async function deleteRegionNode(siteId: string, id: string): Promise<RegionNodeDto> {
  const node = await loadNode(siteId, id);
  const kids = await prisma.regionNode.count({ where: { parentId: id } });
  if (kids) throw new AppError(400, `"${node.name}" still has ${kids} region${kids === 1 ? "" : "s"} inside it`);
  await prisma.regionNode.delete({ where: { id } });
  return { id: node.id, kind: node.kind, name: node.name, parentId: node.parentId };
}

// ─── Which site a device is drawn on ─────────────────────────────────────────

/**
 * The Device Map site an asset belongs to — the tree its location codes
 * resolve through (rule 153), and the site the description-save prompt
 * (rule 150) offers views of. A FortiGate is its own site; a FortiSwitch /
 * FortiAP resolves to its controller FortiGate through the discovery stamps
 * (utils/fortinetParentKey.ts — never a hostname match); any other device
 * through the switch it hangs off (`endpointSite`). Null when nothing places it.
 */
export async function siteForAsset(assetId: string): Promise<string | null> {
  const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { id: true, assetType: true, fortinetTopology: true } });
  if (!asset) throw new AppError(404, "Asset not found");
  if (asset.assetType === "firewall") return asset.id;
  if (asset.assetType !== "switch" && asset.assetType !== "access_point") return endpointSite(asset.id);
  const stamp = readControllerStamp(asset.fortinetTopology);
  const or = parentAssetWhereOr(stamp);
  if (!or.length) return null;
  const candidates = await prisma.asset.findMany({
    where: { assetType: "firewall", OR: or },
    select: { id: true, hostname: true, serialNumber: true, assetType: true, fortinetTopology: true },
  });
  const hit = resolveInfraParentAsset(buildInfraParentIndex(candidates), stamp, "firewall");
  return hit ? hit.id : null;
}

/**
 * The site an endpoint is drawn on: through the switch it hangs off, found
 * the way the Device Map attributes it (buildSiteEndpointAttribution) — its
 * `switch-port` dependency edge, else a fleet-unique switch its
 * `lastSeenSwitch` names. A shared name settles nothing, so null.
 */
async function endpointSite(assetId: string): Promise<string | null> {
  const row = await prisma.asset.findUnique({
    where: { id: assetId },
    select: {
      lastSeenSwitch: true,
      dependencyParents: { where: { source: "endpoint", detectedVia: "switch-port" }, select: { parentAssetId: true } },
    },
  });
  if (!row) return null;
  const parentIds = row.dependencyParents.map((p) => p.parentAssetId);
  if (parentIds.length) {
    const sw = await prisma.asset.findFirst({ where: { id: { in: parentIds }, assetType: "switch" }, select: { id: true } });
    if (sw) return siteForAsset(sw.id);
  }
  const host = row.lastSeenSwitch ? row.lastSeenSwitch.split("/")[0].trim() : "";
  if (!host) return null;
  const named = await prisma.asset.findMany({
    where: { assetType: "switch", status: { notIn: ["decommissioned", "disabled"] }, hostname: { equals: host, mode: "insensitive" } },
    select: { id: true },
    take: 2,
  });
  return named.length === 1 ? siteForAsset(named[0].id) : null;
}

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
import { locationCodeValueProblem, type LocationCodes } from "../utils/locationCodes.js";

const REGION_KINDS = ["area", "building", "floor", "room", "rack", "junctionBox"] as const;
export type RegionKind = (typeof REGION_KINDS)[number];
const RANK: Record<RegionKind, number> = { area: 0, building: 1, floor: 2, room: 3, rack: 4, junctionBox: 5 };
const MAX_NODES_PER_SITE = 5000;

export interface RegionNodeDto {
  id: string;
  kind: RegionKind;
  name: string;
  parentId: string | null;
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
  size: number;
}

export function buildRegionIndex(nodes: RegionNodeDto[]): RegionIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byKey = new Map(nodes.map((n) => [uniqueKeyFor(n.kind, n.name, n.parentId), n]));
  return { byId, byKey, size: nodes.length };
}

/** A node's chain, outermost first, as codes. */
export function chainOf(index: RegionIndex, node: RegionNodeDto): LocationCodes {
  const out: LocationCodes = { area: null, building: null, floor: null, room: null, rack: null, junctionBox: null };
  let cur: RegionNodeDto | undefined = node;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out[cur.kind] = cur.name;
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
      if (holder) anchor = index.byKey.get(uniqueKeyFor("floor", value, holder.id)) ?? null;
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
  for (const k of REGION_KINDS) {
    if (RANK[k] > RANK[anchor.kind]) continue;
    if (written[k] && chain[k] && norm(written[k]) !== norm(chain[k])) return { location: written, status: "conflict" };
    if (written[k] && !chain[k]) return { location: written, status: "conflict" };
  }
  const out: LocationCodes = { ...chain };
  for (const k of REGION_KINDS) if (RANK[k] > RANK[anchor.kind] && written[k]) out[k] = written[k];
  return { location: out, status: "resolved" };
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function listRegionNodes(siteId: string): Promise<RegionNodeDto[]> {
  const rows = await prisma.regionNode.findMany({ where: { siteId }, select: { id: true, kind: true, name: true, parentId: true }, orderBy: [{ name: "asc" }] });
  return rows.filter((r) => isKind(r.kind)).map((r) => ({ id: r.id, kind: r.kind as RegionKind, name: r.name, parentId: r.parentId }));
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

function clash(err: unknown): boolean {
  return (err as { code?: string }).code === "P2002";
}

export async function createRegionNode(siteId: string, input: { kind: unknown; name: unknown; parentId?: unknown }, actor: string | null): Promise<RegionNodeDto> {
  if (!isKind(input.kind)) throw new AppError(400, `kind must be one of ${REGION_KINDS.join(", ")}`);
  const kind = input.kind;
  const name = cleanName(input.name);
  const parentId = typeof input.parentId === "string" && input.parentId ? input.parentId : null;
  await checkParent(siteId, kind, parentId);
  if ((await prisma.regionNode.count({ where: { siteId } })) >= MAX_NODES_PER_SITE) throw new AppError(400, `A site may have at most ${MAX_NODES_PER_SITE} regions`);
  try {
    const row = await prisma.regionNode.create({ data: { siteId, kind, name, parentId, uniqueKey: uniqueKeyFor(kind, name, parentId), createdBy: actor } });
    return { id: row.id, kind, name: row.name, parentId: row.parentId };
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
  const toCreate: Array<{ id: string; kind: RegionKind; name: string; parentId: string | null; uniqueKey: string }> = [];
  const { randomUUID } = await import("node:crypto");
  for (const loc of locations) {
    if (!loc) continue;
    let parent: RegionNodeDto | null = null;
    for (const kind of REGION_KINDS) {
      const value = loc[kind];
      if (!value || locationCodeValueProblem(value)) continue;
      if (kind === "floor" && !parent) continue; // a floor with nothing above it can't be placed
      const key = uniqueKeyFor(kind, value, kind === "floor" ? parent!.id : null);
      let node = index.byKey.get(key) ?? null;
      if (!node) {
        node = { id: randomUUID(), kind, name: value.trim().replace(/\s+/g, " "), parentId: parent ? parent.id : null };
        index.byKey.set(key, node);
        index.byId.set(node.id, node);
        toCreate.push({ ...node, uniqueKey: key });
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

/**
 * Rename and / or move a region. Returns the node and the descriptions that
 * name it in a way the edit changes — a FULL chain naming the old name or
 * the old parents — with the codes each would get. Short codes that resolve
 * through the tree follow on their own and are not listed. Nothing is
 * written to a description here.
 */
export async function updateRegionNode(
  siteId: string,
  id: string,
  patch: { name?: unknown; parentId?: unknown },
  devices: Array<{ assetId: string; name: string; written: LocationCodes | null }>,
): Promise<{ node: RegionNodeDto; rewrites: RegionRewrite[] }> {
  const node = await loadNode(siteId, id);
  const beforeIndex = await loadRegionIndex(siteId);
  const beforeChain = chainOf(beforeIndex, { id: node.id, kind: node.kind, name: node.name, parentId: node.parentId });
  const name = patch.name !== undefined ? cleanName(patch.name) : node.name;
  const parentId = patch.parentId !== undefined ? (typeof patch.parentId === "string" && patch.parentId ? patch.parentId : null) : node.parentId;
  if (parentId !== node.parentId) await checkParent(siteId, node.kind, parentId, node.id);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.regionNode.update({ where: { id }, data: { name, parentId, uniqueKey: uniqueKeyFor(node.kind, name, parentId) } });
      // A building's floors key on their parent id, which did not change; nothing to re-key.
    });
  } catch (err) {
    if (clash(err)) throw new AppError(409, node.kind === "floor" ? `That building already has a floor "${name}"` : `This site already has a ${node.kind} called "${name}"`);
    throw err;
  }
  const afterIndex = await loadRegionIndex(siteId);
  const after = afterIndex.byId.get(id)!;
  const afterChain = chainOf(afterIndex, after);
  const rewrites: RegionRewrite[] = [];
  for (const d of devices) {
    const w = d.written;
    if (!w || !w[node.kind] || norm(w[node.kind]) !== norm(beforeChain[node.kind])) continue;
    // Only a description whose chain down to this level matches the OLD place.
    const matches = REGION_KINDS.every((k) => RANK[k] > RANK[node.kind] || !w[k] || norm(w[k]) === norm(beforeChain[k]));
    if (!matches) continue;
    const next: LocationCodes = { ...w };
    let changed = false;
    for (const k of REGION_KINDS) {
      if (RANK[k] > RANK[node.kind]) continue;
      // Rewrite the levels the description WROTE (a short code stays short),
      // and add any new ancestor the move brings only where it wrote one above.
      if (w[k] && norm(w[k]) !== norm(afterChain[k])) { next[k] = afterChain[k]; changed = true; }
    }
    if (changed) rewrites.push({ assetId: d.assetId, name: d.name, from: w, codes: next });
  }
  return { node: { id: after.id, kind: after.kind, name: after.name, parentId: after.parentId }, rewrites };
}

/** Fold one region into another of the same kind: its children move, it is removed. */
export async function mergeRegionNodes(siteId: string, fromId: string, intoId: string): Promise<RegionNodeDto> {
  if (fromId === intoId) throw new AppError(400, "Pick a different region to merge into");
  const from = await loadNode(siteId, fromId);
  const into = await loadNode(siteId, intoId);
  if (from.kind !== into.kind) throw new AppError(400, "Only regions of the same kind can be merged");
  await prisma.$transaction(async (tx) => {
    const kids = await tx.regionNode.findMany({ where: { parentId: fromId } });
    for (const k of kids) {
      if (!isKind(k.kind)) continue;
      const key = uniqueKeyFor(k.kind, k.name, intoId);
      const twin = await tx.regionNode.findFirst({ where: { siteId, uniqueKey: key, NOT: { id: k.id } } });
      if (twin) throw new AppError(409, `Both have a ${k.kind} called "${k.name}" — merge those first`);
      await tx.regionNode.update({ where: { id: k.id }, data: { parentId: intoId, uniqueKey: key } });
    }
    await tx.regionNode.delete({ where: { id: fromId } });
  });
  return { id: into.id, kind: into.kind, name: into.name, parentId: into.parentId };
}

/** Delete a region with nothing inside it. Descriptions are not touched. */
export async function deleteRegionNode(siteId: string, id: string): Promise<RegionNodeDto> {
  const node = await loadNode(siteId, id);
  const kids = await prisma.regionNode.count({ where: { parentId: id } });
  if (kids) throw new AppError(400, `"${node.name}" still has ${kids} region${kids === 1 ? "" : "s"} inside it`);
  await prisma.regionNode.delete({ where: { id } });
  return { id: node.id, kind: node.kind, name: node.name, parentId: node.parentId };
}

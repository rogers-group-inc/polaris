/**
 * src/services/mapRegionService.ts
 *
 * Map regions — operator-drawn polygons on the Device Map. Each region has a
 * unique name; assets carry a `region:<name>` tag when they belong to it:
 *   - firewalls whose lat/lng falls inside the polygon,
 *   - the FortiSwitches / FortiAPs whose `fortinetTopology.controllerFortigate`
 *     matches an enclosed firewall's hostname, AND
 *   - any asset whose IP falls in a subnet served by an enclosed firewall
 *     (Subnet.fortigateDevice = the firewall hostname) — this is how servers /
 *     workstations / other non-geolocated assets inherit a region.
 *
 * **Subnets carry the tag too.** A `Subnet` served by an enclosed firewall
 * inherits `region:<name>` from that gate — the same match that propagates the
 * region to the subnet's assets, applied to the subnet row itself. Without it
 * the IPAM Networks list (whose Sources column IS `fortigateDevice`) had no way
 * to filter address space by region even though every asset inside it was
 * already tagged. Subnet tags follow the identical additive contract as asset
 * tags: added by membership, stripped only on rename/delete.
 *
 * Storage: single JSON blob in Setting under SETTING_KEY (mirrors the
 * allocationTemplateService pattern).
 *
 * **The reconciler re-evaluates membership in both directions, bounded by
 * provenance.** Devices move: a firewall is re-pinned, a switch is repointed to
 * a controller in another region, a subnet is re-served by a different gate.
 * Every add is recorded in `RegionTagAssignment` (one row per (region, target)
 * pair this service tagged — the `TagAutoAssignment` pattern), so a later
 * reconcile can strip the tag off a target that has drifted OUT of the region
 * while never touching the same tag where an operator attached it by hand: no
 * provenance row means operator-owned, left alone forever. That is also why
 * tags already stale before this feature shipped are never cleaned — they are
 * indistinguishable from a hand-applied tag, so they stay until an operator
 * removes them.
 *
 * Manually *removing* a region tag from an in-polygon asset will be re-added on
 * the next reconcile — that direction stays authoritative by design so polygon
 * membership always implies the tag.
 *
 * **Pinned FIREWALLS are the one carve-out from provenance-bounding, and only
 * on the map-save review.** For a coordinate-carrying gate, region membership
 * is purely geometric and the add direction is already authoritative (see the
 * paragraph above) — so when the operator clicks "Save Regions" on the Device
 * Map, `reviewRegionTagsForMapSave` additionally strips any `region:<name>`
 * tag from a pinned gate that sits OUTSIDE that region's polygon, provenance
 * row or not. That is what cleans gate tags that predate the provenance table
 * (migration 20260819020000) after a gate moves. The save click is the
 * operator's assertion that the drawn geography is the truth, which is why the
 * periodic job and the discovery-end hook deliberately do NOT get this pass —
 * they stay provenance-bounded. Non-gates (the hand-tagged printer case) and
 * gates without coordinates are never touched by it.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { pointInPolygon, type LatLng } from "../utils/geo.js";
import { buildCidrMatcher } from "../utils/cidr.js";
import { controllerIdentityKeys, readFirewallDeviceName } from "../utils/fortinetParentKey.js";
import { buildRegionHierarchy, type RegionHierarchy } from "../utils/regionHierarchy.js";
import { createTtlCache } from "../utils/ttlCache.js";

const SETTING_KEY = "mapRegions";
/**
 * Companion blob to `mapRegions`: the region NAMES that are no longer in use.
 *
 * A `region:<name>` tag whose name matches no region is unreachable — the
 * reconcile strips only pairs `RegionTagAssignment` recorded, and provenance is
 * keyed by region ID, which a rename does not change and a delete drops
 * entirely. So the one thing the strip half can never see is the tag left
 * behind when a rename or delete half-applies, which is exactly what happened
 * on prod twice in 2026-09.
 *
 * This list is the missing evidence. A name lands on it in the SAME locked
 * transaction that renames or deletes the region — before the tag rotation is
 * even attempted — so it survives a rotation that dies part-way, and the sweep
 * in `sweepRetiredRegionTags` can strip that name's tag later knowing Polaris
 * itself retired it. That is what keeps business rule 54 compatible with the
 * older invariant it sits beside: a hand-applied `region:Narnia` on some
 * operator's printer is NOT swept, because no region named Narnia was ever
 * retired. Only names Polaris watched go away are fair game.
 */
const RETIRED_SETTING_KEY = "mapRegionRetiredNames";
const TAG_PREFIX = "region:";
/**
 * The tag category this service OWNS. Exported because the tag registry refuses
 * hand-created tags in it (and refuses to move a tag into it): every row here is
 * minted by a region save and kept in step by the region reconcile through
 * RegionTagAssignment provenance, so a hand-added sibling would look identical
 * and belong to nobody. It is also why a tag in this category is not offered the
 * auto-assign device filter — TagAutoAssignment managing the same tag NAME that
 * RegionTagAssignment manages would be two reconcilers taking turns undoing
 * each other.
 */
export const REGION_TAG_CATEGORY = "Map Regions";
const TAG_CATEGORY = REGION_TAG_CATEGORY;
const TAG_COLOR_PALETTE = [
  "#4fc3f7", "#4ade80", "#f59e0b", "#f472b6", "#a78bfa",
  "#fb923c", "#38bdf8", "#34d399", "#e879f9", "#facc15",
  "#f87171", "#2dd4bf", "#818cf8", "#c084fc",
];

function randomTagColor(): string {
  return TAG_COLOR_PALETTE[Math.floor(Math.random() * TAG_COLOR_PALETTE.length)]!;
}

export interface MapRegion {
  id: string;
  name: string;
  /** [[lat, lng], ...]; >=3 points, <=1000 vertices */
  polygon: LatLng[];
  /** Hex color "#rrggbb" used for the polygon stroke + fill on the map. */
  color: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaveRegionInput {
  id?: string;
  name?: string;
  polygon?: LatLng[];
  color?: string;
  actor?: string | null;
}

export interface ReconcileSummary extends Record<string, unknown> {
  regionId?: string;
  /** Assets that gained the region tag. */
  added: number;
  /**
   * Assets that lost it — a member that drifted out of the region (provenance
   * says we tagged it, membership no longer includes it), plus the wholesale
   * strips on the rename / delete paths.
   */
  removed: number;
  assetsTouched: number;
  /** Subnets that gained the region tag (inherited from their serving gate). */
  subnetsAdded: number;
  /** Subnets that lost it — drifted-out members, plus rename / delete strips. */
  subnetsRemoved: number;
  /**
   * The fleet-wide retired-name sweep (business rule 54). Present ONLY on
   * `reconcileMapRegions`, which is the only caller that runs it — the
   * per-region helpers return a summary about one region and have nothing to
   * say about names that no longer belong to any.
   */
  retiredTagSweep?: RetiredTagSweep;
  subnetsTouched: number;
}

// --- Persistence helpers ---

/**
 * Advisory-lock class id for the mapRegions blob. Follows the existing
 * sequence: the retention prune uses 0x504c5253 ("PLRS") and subnet writes
 * 0x504c5254 ("PLRT") — see PRUNE_LOCK_CLASSID in monitoringService and
 * SUBNET_LOCK_CLASSID in subnetService.
 */
const REGION_LOCK_CLASSID = 0x504c5255; // "PLRU" — mapRegions blob write lock

/** Prisma client or interactive-transaction client. */
type RegionDb = Pick<typeof prisma, "setting">;

/**
 * Serialize one read-modify-write of the mapRegions blob against every other
 * region writer.
 *
 * EVERY region mutation is a read-modify-write of a SINGLE JSON blob — load the
 * whole array, change one element, write the whole array back — so two writers
 * that overlap both read the same starting array and the second one's write
 * silently discards the first one's edit. That is not a theoretical race: the
 * map's edit mode saves every changed polygon at once with Promise.all, so
 * dragging three regions and clicking Save reliably lost two of them while all
 * three PUTs returned 200 and the UI reported "3 regions saved".
 *
 * Same medicine as subnet overlap (business rule 20a): the check-then-write is
 * only as strong as whatever serializes the two halves. The lock is taken as
 * the FIRST statement in the transaction, before the read whose result the
 * write depends on, and releases at end of transaction so there is no unlock
 * path to leak.
 *
 * One lock for the whole blob rather than one per region, because the unit
 * being rewritten IS the whole blob — a per-region lock would serialize nothing.
 */
async function withRegionBlobLock<T>(fn: (db: RegionDb) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REGION_LOCK_CLASSID}::int, hashtext(${SETTING_KEY})::int)`;
    return fn(tx as unknown as RegionDb);
  });
}

/**
 * Load the blob along with its `Setting.updatedAt`, which the hierarchy cache
 * uses as a free, exact version stamp — no content hashing needed.
 */
async function loadAllWithVersion(db: RegionDb = prisma): Promise<{ regions: MapRegion[]; version: string }> {
  const row = await db.setting.findUnique({
    where: { key: SETTING_KEY },
    select: { value: true, updatedAt: true },
  });
  const version = row?.updatedAt ? new Date(row.updatedAt).toISOString() : "none";
  if (!row?.value) return { regions: [], version };
  const val = row.value as unknown;
  if (!Array.isArray(val)) return { regions: [], version };
  // Legacy regions pre-date the color field — back-fill at read time with a
  // random palette pick so the UI has something to render. Persist back on
  // the next write through updateRegion; we deliberately don't write here
  // (a read shouldn't mutate the Setting blob).
  const regions = (val as Partial<MapRegion>[]).map((r) => ({
    ...(r as MapRegion),
    color: typeof r.color === "string" && HEX_COLOR_RE.test(r.color) ? r.color.toLowerCase() : randomTagColor(),
  }));
  return { regions, version };
}

async function loadAll(db: RegionDb = prisma): Promise<MapRegion[]> {
  return (await loadAllWithVersion(db)).regions;
}

async function persistAll(regions: MapRegion[], db: RegionDb = prisma): Promise<void> {
  await db.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: regions as any },
    create: { key: SETTING_KEY, value: regions as any },
  });
  // Invalidation lives HERE rather than at the three CRUD call sites so a
  // future write path cannot forget it. Levels are global: editing one polygon
  // can re-level an entire ancestor chain, so any write invalidates everything.
  invalidateRegionHierarchy();
}

// --- Validation ---

const MAX_VERTICES = 1000;
const MAX_NAME = 64;
const CONTROL_CHARS = /\p{Cc}/u;

function validateName(name: unknown): string {
  if (typeof name !== "string") throw new AppError(400, "Region name is required");
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new AppError(400, "Region name is required");
  if (trimmed.length > MAX_NAME) {
    throw new AppError(400, `Region name must be ${MAX_NAME} characters or fewer`);
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new AppError(400, "Region name cannot contain control characters");
  }
  return trimmed;
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function validateColor(color: unknown): string {
  if (typeof color !== "string") throw new AppError(400, "Color must be a hex string");
  const trimmed = color.trim();
  if (!HEX_COLOR_RE.test(trimmed)) {
    throw new AppError(400, 'Color must be a 7-character hex string like "#4fc3f7"');
  }
  return trimmed.toLowerCase();
}

function validatePolygon(polygon: unknown): LatLng[] {
  if (!Array.isArray(polygon)) {
    throw new AppError(400, "Polygon must be an array of [lat, lng] pairs");
  }
  if (polygon.length < 3) throw new AppError(400, "Polygon must have at least 3 vertices");
  if (polygon.length > MAX_VERTICES) {
    throw new AppError(400, `Polygon cannot have more than ${MAX_VERTICES} vertices`);
  }
  const cleaned: LatLng[] = [];
  for (const pt of polygon) {
    if (!Array.isArray(pt) || pt.length !== 2) {
      throw new AppError(400, "Each polygon vertex must be a [lat, lng] pair");
    }
    const lat = Number(pt[0]);
    const lng = Number(pt[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new AppError(400, "Polygon vertex coordinates must be finite numbers");
    }
    if (lat < -90 || lat > 90) throw new AppError(400, "Latitude must be between -90 and 90");
    if (lng < -180 || lng > 180) throw new AppError(400, "Longitude must be between -180 and 180");
    cleaned.push([lat, lng]);
  }
  return cleaned;
}

// --- Tag helpers ---

function regionTag(name: string): string {
  return `${TAG_PREFIX}${name}`;
}

async function upsertTagRegistry(name: string): Promise<void> {
  const tagName = regionTag(name);
  try {
    // Pick a random palette color for new region tags so the operator sees a
    // varied default; existing tags keep whatever color was previously chosen.
    await prisma.tag.upsert({
      where: { name: tagName },
      update: {},
      create: { name: tagName, category: TAG_CATEGORY, color: randomTagColor() },
    });
  } catch (err: any) {
    logger.debug({ err: err?.message ?? String(err), tag: tagName }, "mapRegion: tag upsert failed (non-fatal)");
  }
}

// --- Retired region names (the sweep's evidence) ---

/** A region name Polaris itself retired, and therefore may strip the tag for. */
export interface RetiredRegionName {
  name: string;
  /** The region that carried it. Kept for the audit trail, not for matching. */
  regionId: string;
  retiredAt: string;
  reason: "rename" | "delete";
}

async function loadRetired(db: RegionDb = prisma): Promise<RetiredRegionName[]> {
  const row = await db.setting.findUnique({
    where: { key: RETIRED_SETTING_KEY },
    select: { value: true },
  });
  const val = row?.value as unknown;
  if (!Array.isArray(val)) return [];
  // A malformed entry is dropped rather than thrown on: this list exists to
  // clean up after a failure, so it must not become a second failure.
  return (val as Partial<RetiredRegionName>[]).filter(
    (r): r is RetiredRegionName => !!r && typeof r.name === "string" && r.name.trim().length > 0,
  );
}

async function persistRetired(rows: RetiredRegionName[], db: RegionDb = prisma): Promise<void> {
  await db.setting.upsert({
    where: { key: RETIRED_SETTING_KEY },
    update: { value: rows as any },
    create: { key: RETIRED_SETTING_KEY, value: rows as any },
  });
}

/**
 * Record that a name is out of use. MUST be called with `db` inside the caller's
 * `withRegionBlobLock` transaction — the point of this row is that it is written
 * atomically with the blob edit that retired the name, so a tag rotation that
 * dies immediately afterwards still leaves the evidence behind.
 */
async function recordRetiredName(
  db: RegionDb,
  name: string,
  regionId: string,
  reason: RetiredRegionName["reason"],
): Promise<void> {
  const rows = await loadRetired(db);
  const lower = name.trim().toLowerCase();
  if (rows.some((r) => r.name.trim().toLowerCase() === lower)) return;
  rows.push({ name, regionId, retiredAt: new Date().toISOString(), reason });
  await persistRetired(rows, db);
}

async function deleteTagRegistry(name: string): Promise<void> {
  const tagName = regionTag(name);
  try {
    await prisma.tag.deleteMany({ where: { name: tagName } });
  } catch (err: any) {
    logger.debug({ err: err?.message ?? String(err), tag: tagName }, "mapRegion: tag delete failed (non-fatal)");
  }
}

// --- Membership computation ---

interface TopologyMeta {
  role?: "fortigate" | "fortiswitch" | "fortiap";
  controllerFortigate?: string | null;
  controllerSerial?: string | null;
}

function readTopology(raw: unknown): TopologyMeta {
  if (raw && typeof raw === "object") return raw as TopologyMeta;
  return {};
}

export interface RegionMembership {
  /** Asset IDs that should carry the region tag. */
  assetIds: Set<string>;
  /** Subnet IDs that should carry it — those served by an enclosed gate. */
  subnetIds: Set<string>;
}

/**
 * Compute what should currently carry the given region's tag: every firewall
 * whose pin is inside the polygon, every FortiSwitch / FortiAP whose
 * `fortinetTopology.controllerFortigate` matches one of those firewalls, every
 * subnet those firewalls serve, and every asset addressed out of one of those
 * subnets.
 */
async function computeMembership(region: MapRegion): Promise<RegionMembership> {
  const firewalls = await prisma.asset.findMany({
    where: {
      assetType: "firewall",
      latitude: { not: null },
      longitude: { not: null },
    },
    select: { id: true, hostname: true, serialNumber: true, fortinetTopology: true, latitude: true, longitude: true },
  });

  const enclosedFirewalls: Array<{ id: string; keys: string[]; serial: string | null }> = [];
  for (const fw of firewalls) {
    const lat = fw.latitude as unknown as number | null;
    const lng = fw.longitude as unknown as number | null;
    if (lat == null || lng == null) continue;
    if (pointInPolygon([lat, lng], region.polygon)) {
      // Every name this gate can be known by in a child's stamp or in
      // Subnet.fortigateDevice — serial, its FortiManager device name, and its
      // configured hostname. Matching on hostname ALONE (the pre-2026-08
      // behavior) silently dropped every switch/AP and every subnet-propagated
      // asset behind a gate whose FMG device name differs from its hostname.
      // See utils/fortinetParentKey.ts.
      enclosedFirewalls.push({
        id: fw.id,
        serial: fw.serialNumber,
        keys: controllerIdentityKeys({
          hostname: fw.hostname,
          serialNumber: fw.serialNumber,
          deviceName: readFirewallDeviceName(fw.fortinetTopology),
        }),
      });
    }
  }

  const memberIds = new Set<string>(enclosedFirewalls.map((f) => f.id));
  const enclosedKeys = new Set<string>(enclosedFirewalls.flatMap((f) => f.keys));
  const enclosedSerials = new Set<string>(
    enclosedFirewalls.map((f) => (f.serial || "").trim()).filter((s) => s.length > 0),
  );
  if (enclosedKeys.size === 0) return { assetIds: memberIds, subnetIds: new Set<string>() };

  const infra = await prisma.asset.findMany({
    where: {
      assetType: { in: ["switch", "access_point"] },
    },
    select: { id: true, fortinetTopology: true },
  });
  for (const a of infra) {
    const topo = readTopology(a.fortinetTopology);
    const ctrlSerial = (topo.controllerSerial || "").trim();
    if (ctrlSerial && enclosedSerials.has(ctrlSerial)) { memberIds.add(a.id); continue; }
    const ctrl = (topo.controllerFortigate || "").trim();
    if (ctrl && enclosedKeys.has(ctrl)) memberIds.add(a.id);
  }

  // Subnet propagation: the subnets an enclosed firewall serves inherit the
  // region themselves, and so does any asset whose IP falls inside one. The
  // subnet half is what gives the IPAM Networks list a region to filter on; the
  // asset half is how servers / workstations / standalone assets — which have
  // no coordinates — get a region.
  //
  // `Subnet.fortigateDevice` holds the discovery-time device NAME (FMG's name,
  // or the standalone gate's), NOT the gate's configured hostname — so the
  // pre-2026-08 `in: enclosedHostnames` comparison matched nothing on installs
  // where the two differ, and no non-Fortinet asset ever inherited a region.
  // `enclosedKeys` includes the device name.
  const regionSubnets = await prisma.subnet.findMany({
    where: { fortigateDevice: { in: Array.from(enclosedKeys) } },
    select: { id: true, cidr: true },
  });
  const subnetIds = new Set<string>(regionSubnets.map((s) => s.id));
  if (regionSubnets.length > 0) {
    const ipAssets = await prisma.asset.findMany({
      where: { ipAddress: { not: null } },
      select: { id: true, ipAddress: true },
    });
    // Parse each subnet once, not once per asset: this loop is every
    // IP-carrying asset in the fleet, per region. IPv4 only (Netmask) — IPv6
    // assets simply match nothing.
    const inRegionSubnet = buildCidrMatcher(regionSubnets.map((s) => s.cidr));
    for (const a of ipAssets) {
      if (memberIds.has(a.id)) continue;
      const ip = (a.ipAddress || "").split("/")[0].trim();
      if (ip && inRegionSubnet(ip)) memberIds.add(a.id);
    }
  }
  return { assetIds: memberIds, subnetIds };
}

// --- Tag mutation primitives ---

/**
 * Add the tag to the named assets, skipping the ones that already carry it.
 *
 * **Chunked at 50 like every other tag mutator here.** Steady state this writes
 * almost nothing — the skip makes a re-run a no-op — but the two cases that
 * matter are the two that touch the whole membership at once: the first apply
 * of a newly drawn region, and the add half of a RENAME, where the old tag has
 * just been stripped and so not one member carries the new one. On a
 * ~1,500-asset region that was a single transaction of ~1,500 updates.
 */
async function addTagToAssets(assetIds: string[], tag: string): Promise<number> {
  if (assetIds.length === 0) return 0;
  const rows = await prisma.asset.findMany({
    where: { id: { in: assetIds } },
    select: { id: true, tags: true },
  });
  const updates: { id: string; tags: string[] }[] = [];
  for (const row of rows) {
    const tags = Array.isArray(row.tags) ? row.tags : [];
    if (tags.includes(tag)) continue;
    updates.push({ id: row.id, tags: [...tags, tag] });
  }
  for (const c of chunk50(updates)) {
    await prisma.$transaction(
      c.map((u) => prisma.asset.update({ where: { id: u.id }, data: { tags: u.tags } })),
    );
  }
  return updates.length;
}

async function addTagToSubnets(subnetIds: string[], tag: string): Promise<number> {
  if (subnetIds.length === 0) return 0;
  const rows = await prisma.subnet.findMany({
    where: { id: { in: subnetIds } },
    select: { id: true, tags: true },
  });
  const updates: { id: string; tags: string[] }[] = [];
  for (const row of rows) {
    const tags = Array.isArray(row.tags) ? row.tags : [];
    if (tags.includes(tag)) continue;
    updates.push({ id: row.id, tags: [...tags, tag] });
  }
  for (const c of chunk50(updates)) {
    await prisma.$transaction(
      c.map((u) => prisma.subnet.update({ where: { id: u.id }, data: { tags: u.tags } })),
    );
  }
  return updates.length;
}

/**
 * Strip the tag from EVERY subnet carrying it — the rename / delete path, where
 * the tag string itself is going away. Chunked like its drift-path sibling: see
 * `removeTagFromAllAssets` for why.
 */
async function removeTagFromAllSubnets(tag: string): Promise<number> {
  const rows = await prisma.subnet.findMany({
    where: { tags: { has: tag } },
    select: { id: true, tags: true },
  });
  if (rows.length === 0) return 0;
  for (const c of chunk50(rows)) {
    await prisma.$transaction(
      c.map((row) => {
        const tags = Array.isArray(row.tags) ? row.tags : [];
        return prisma.subnet.update({
          where: { id: row.id },
          data: { tags: tags.filter((t) => t !== tag) },
        });
      }),
    );
  }
  return rows.length;
}

/**
 * Strip the tag from EVERY asset carrying it — the rename / delete path.
 *
 * **Chunked at 50, like `removeTagFromAssets` below.** This used to build ONE
 * `$transaction` holding an update per matching row, which is fine for the
 * region sizes the feature was written against and not fine for a real fleet: a
 * prod rename of a region covering ~1,100 assets threw here, and because the
 * caller (`applyRename`) runs AFTER `updateRegion` has already committed the
 * renamed blob, the failure left 1,492 assets and 114 subnets carrying a tag
 * naming no region — invisible to every reconcile, since the provenance rows
 * are keyed by region id and the id had not changed. Cleaning it up took SQL.
 *
 * Chunking trades all-or-nothing for progress: a failure part-way now leaves
 * SOME rows stripped. That is the better failure — a partial strip is the same
 * shape of mess a partial rename already was, and it converges, whereas the
 * unchunked version reliably did nothing at all at the size where it mattered.
 */
async function removeTagFromAllAssets(tag: string): Promise<number> {
  const rows = await prisma.asset.findMany({
    where: { tags: { has: tag } },
    select: { id: true, tags: true },
  });
  if (rows.length === 0) return 0;
  for (const c of chunk50(rows)) {
    await prisma.$transaction(
      c.map((row) => {
        const tags = Array.isArray(row.tags) ? row.tags : [];
        return prisma.asset.update({
          where: { id: row.id },
          data: { tags: tags.filter((t) => t !== tag) },
        });
      }),
    );
  }
  return rows.length;
}

/**
 * Strip the tag from the NAMED assets only — the drift path. Unlike
 * `removeTagFromAllAssets` (rename / delete, where every copy of the old tag is
 * going away) this is scoped to ids the caller has already confirmed carry a
 * provenance row, so a hand-applied copy elsewhere is untouched.
 */
async function removeTagFromAssets(assetIds: string[], tag: string): Promise<number> {
  if (assetIds.length === 0) return 0;
  const rows = await prisma.asset.findMany({
    where: { id: { in: assetIds }, tags: { has: tag } },
    select: { id: true, tags: true },
  });
  if (rows.length === 0) return 0;
  for (const chunk of chunk50(rows)) {
    await prisma.$transaction(
      chunk.map((row) => {
        const tags = Array.isArray(row.tags) ? row.tags : [];
        return prisma.asset.update({
          where: { id: row.id },
          data: { tags: tags.filter((t) => t !== tag) },
        });
      }),
    );
  }
  return rows.length;
}

/** Subnet half of `removeTagFromAssets`. */
async function removeTagFromSubnets(subnetIds: string[], tag: string): Promise<number> {
  if (subnetIds.length === 0) return 0;
  const rows = await prisma.subnet.findMany({
    where: { id: { in: subnetIds }, tags: { has: tag } },
    select: { id: true, tags: true },
  });
  if (rows.length === 0) return 0;
  for (const chunk of chunk50(rows)) {
    await prisma.$transaction(
      chunk.map((row) => {
        const tags = Array.isArray(row.tags) ? row.tags : [];
        return prisma.subnet.update({
          where: { id: row.id },
          data: { tags: tags.filter((t) => t !== tag) },
        });
      }),
    );
  }
  return rows.length;
}

function chunk50<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += 50) out.push(rows.slice(i, i + 50));
  return out;
}

// --- Provenance (RegionTagAssignment) ---

/**
 * Diff what a region should currently cover against what this service last
 * recorded itself as having tagged. Pure — the whole re-evaluation decision in
 * one testable function.
 *
 * `toRemove` is deliberately derived from PROVENANCE rather than from "every
 * row carrying the tag": a target that holds the tag with no provenance row was
 * tagged by an operator (or predates provenance) and must survive.
 */
export function diffRegionMembership(
  expected: Iterable<string>,
  provenance: Iterable<string>,
): { toAdd: string[]; toRemove: string[] } {
  const want = new Set(expected);
  const have = new Set(provenance);
  const toAdd: string[] = [];
  const toRemove: string[] = [];
  for (const id of want) if (!have.has(id)) toAdd.push(id);
  for (const id of have) if (!want.has(id)) toRemove.push(id);
  return { toAdd, toRemove };
}

interface RegionProvenance {
  assetIds: Set<string>;
  subnetIds: Set<string>;
}

async function loadProvenance(regionId: string): Promise<RegionProvenance> {
  const rows = await prisma.regionTagAssignment.findMany({
    where: { regionId },
    select: { targetType: true, targetId: true },
  });
  const assetIds = new Set<string>();
  const subnetIds = new Set<string>();
  for (const r of rows) {
    if (r.targetType === "subnet") subnetIds.add(r.targetId);
    else assetIds.add(r.targetId);
  }
  return { assetIds, subnetIds };
}

async function recordProvenance(
  regionId: string,
  targetType: "asset" | "subnet",
  targetIds: string[],
): Promise<void> {
  if (targetIds.length === 0) return;
  for (const chunk of chunk50(targetIds)) {
    await prisma.regionTagAssignment.createMany({
      data: chunk.map((targetId) => ({ regionId, targetType, targetId })),
      skipDuplicates: true,
    });
  }
}

async function dropProvenance(
  regionId: string,
  targetType: "asset" | "subnet",
  targetIds: string[],
): Promise<void> {
  if (targetIds.length === 0) return;
  for (const chunk of chunk50(targetIds)) {
    await prisma.regionTagAssignment.deleteMany({
      where: { regionId, targetType, targetId: { in: chunk } },
    });
  }
}

async function dropAllProvenance(regionId: string): Promise<void> {
  await prisma.regionTagAssignment.deleteMany({ where: { regionId } });
}

// --- Derived nesting levels ---

/** A region decorated with its DERIVED place in the containment forest. */
export interface MapRegionWithLevel extends MapRegion {
  /** 1 = contains no other region. May have gaps on an uneven tree. */
  level: number;
  /** 0 = top-level. Always gap-free — route on this, not on `level`. */
  depth: number;
  parentId: string | null;
  childIds: string[];
  /** Outermost first (root → parent). */
  ancestorIds: string[];
}

/**
 * The hierarchy is DERIVED on read and cached per blob version — never written
 * into the `mapRegions` blob. A persisted level would be a second source of
 * truth that a restore, a backup import or a hand-edited Setting could silently
 * desynchronize, and the drift would be invisible because nothing would
 * recompute to compare. See `src/utils/regionHierarchy.ts`.
 *
 * Keyed on `Setting.updatedAt`, so a stale entry is unreachable even before the
 * TTL fires — the TTL is only a memory bound. `persistAll` invalidates.
 */
const REGION_HIERARCHY_TTL_MS = 5 * 60_000;
const _hierarchyCache = createTtlCache<{ regions: MapRegion[]; hierarchy: RegionHierarchy }>({
  ttlMs: REGION_HIERARCHY_TTL_MS,
  maxEntries: 4,
});

/** Drop the cached containment forest. Called by every write via `persistAll`. */
export function invalidateRegionHierarchy(): void {
  _hierarchyCache.invalidate();
}

/** The region list plus its containment forest, cached per blob version. */
export async function getRegionHierarchy(): Promise<{ regions: MapRegion[]; hierarchy: RegionHierarchy }> {
  const { regions, version } = await loadAllWithVersion();
  return _hierarchyCache.getOrCompute(version, async () => ({
    regions,
    hierarchy: buildRegionHierarchy(regions.map((r) => ({ id: r.id, polygon: r.polygon }))),
  }));
}

/**
 * Name-sorted regions decorated with their derived level/depth/parent.
 *
 * A SEPARATE function from `listRegions`, deliberately: `reconcileMapRegions`
 * and `notificationRuleService.listScopeOptions` both call `listRegions`, and if
 * the plain read path returned decorated objects then any future code that
 * round-tripped one back through `persistAll` would write derived fields into
 * the blob — the exact failure deriving-on-read exists to prevent.
 */
export async function listRegionsWithLevels(): Promise<MapRegionWithLevel[]> {
  const { regions, hierarchy } = await getRegionHierarchy();
  return regions
    .map((r) => {
      const node = hierarchy.byId[r.id];
      return {
        ...r,
        level: node?.level ?? 1,
        depth: node?.depth ?? 0,
        parentId: node?.parentId ?? null,
        childIds: node?.childIds ?? [],
        ancestorIds: node?.ancestorIds ?? [],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Which regions' levels MOVED between two hierarchies. Pure.
 *
 * Exists because editing one polygon can re-level an entire ancestor chain —
 * changing who gets paged for regions the operator never touched. Without an
 * audit trail built from this, that change is completely invisible.
 */
export function diffRegionLevels(
  before: RegionHierarchy,
  after: RegionHierarchy,
): Array<{ regionId: string; from: number | null; to: number | null }> {
  const out: Array<{ regionId: string; from: number | null; to: number | null }> = [];
  const ids = new Set([...Object.keys(before.byId), ...Object.keys(after.byId)]);
  for (const id of Array.from(ids).sort()) {
    const from = before.byId[id]?.level ?? null;
    const to = after.byId[id]?.level ?? null;
    if (from !== to) out.push({ regionId: id, from, to });
  }
  return out;
}

// --- Public API ---

export async function listRegions(): Promise<MapRegion[]> {
  const all = await loadAll();
  return all.slice().sort((a, b) => a.name.localeCompare(b.name));
}

export async function getRegion(id: string): Promise<MapRegion | null> {
  const all = await loadAll();
  return all.find((r) => r.id === id) ?? null;
}

export async function createRegion(input: SaveRegionInput): Promise<MapRegion> {
  // Shape validation needs no lock and should reject before we queue behind
  // another writer.
  const name = validateName(input.name);
  const polygon = validatePolygon(input.polygon);
  const color = input.color !== undefined ? validateColor(input.color) : randomTagColor();

  // The duplicate-name check and the append are one atomic read-modify-write:
  // unlocked, two concurrent creates both read the array without the other's
  // row, and the second write discards the first region entirely.
  const created = await withRegionBlobLock(async (db) => {
    const all = await loadAll(db);
    if (all.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      throw new AppError(409, `A region named "${name}" already exists`);
    }
    const now = new Date().toISOString();
    const row: MapRegion = {
      id: randomUUID(),
      name,
      polygon,
      color,
      createdBy: input.actor ?? null,
      createdAt: now,
      updatedAt: now,
    };
    all.push(row);
    await persistAll(all, db);
    return row;
  });

  // Best-effort registry mirroring, deliberately OUTSIDE the lock: it writes a
  // different table, swallows its own failures, and holding the blob lock
  // across it would serialize every region write behind a Tag upsert.
  await upsertTagRegistry(name);
  return created;
}

export async function updateRegion(
  id: string,
  input: SaveRegionInput,
): Promise<{ region: MapRegion; previousName: string; renamed: boolean; polygonChanged: boolean }> {
  // THE lost-update site. Everything from the read to the write is one atomic
  // section: the map's edit mode saves every changed polygon at once via
  // Promise.all, so unlocked, N concurrent PUTs each read the array before the
  // others wrote and only the last one's edit survived — while every request
  // returned 200 and the UI said "N regions saved".
  const result = await withRegionBlobLock(async (db) => {
    const all = await loadAll(db);
    const idx = all.findIndex((r) => r.id === id);
    if (idx === -1) throw new AppError(404, `Region ${id} not found`);
    const existing = all[idx]!;

    const name = input.name !== undefined ? validateName(input.name) : existing.name;
    const polygon = input.polygon !== undefined ? validatePolygon(input.polygon) : existing.polygon;
    const color = input.color !== undefined ? validateColor(input.color) : existing.color;

    const renamed = name.toLowerCase() !== existing.name.toLowerCase();
    if (renamed && all.some((r, i) => i !== idx && r.name.toLowerCase() === name.toLowerCase())) {
      throw new AppError(409, `A region named "${name}" already exists`);
    }

    const polygonChanged =
      input.polygon !== undefined && JSON.stringify(polygon) !== JSON.stringify(existing.polygon);

    const updated: MapRegion = {
      ...existing,
      name,
      polygon,
      color,
      updatedAt: new Date().toISOString(),
    };
    all[idx] = updated;
    await persistAll(all, db);
    // Inside the lock, in the same transaction as the rename itself: the whole
    // value of this row is that it is already committed when `applyRename`
    // starts, so a rotation that throws leaves the old name provably retired
    // rather than merely absent. See RETIRED_SETTING_KEY.
    if (renamed) await recordRetiredName(db, existing.name, existing.id, "rename");
    return { region: updated, previousName: existing.name, renamed, polygonChanged };
  });

  // Registry mirroring stays outside the lock — see createRegion.
  if (result.renamed) {
    await deleteTagRegistry(result.previousName);
    await upsertTagRegistry(result.region.name);
  }

  return result;
}

export async function deleteRegion(id: string): Promise<MapRegion> {
  // Same read-modify-write, same lock. Unlocked, a delete that overlaps an edit
  // to a DIFFERENT region resurrects the deleted one or discards the edit,
  // depending on which write lands second.
  const removed = await withRegionBlobLock(async (db) => {
    const all = await loadAll(db);
    const idx = all.findIndex((r) => r.id === id);
    if (idx === -1) throw new AppError(404, `Region ${id} not found`);
    const row = all[idx]!;
    await persistAll(all.slice(0, idx).concat(all.slice(idx + 1)), db);
    // Same reasoning as the rename: committed with the delete, before
    // `applyDelete` gets a chance to fail half-way through the strip.
    await recordRetiredName(db, row.name, row.id, "delete");
    return row;
  });
  await deleteTagRegistry(removed.name);
  return removed;
}

// --- Reconciler ---

/**
 * Strip the old name's tag from every asset, then add-pass current membership.
 * Called inline from the rename branch of updateRegion (after persist).
 */
export async function applyRename(
  region: MapRegion,
  previousName: string,
): Promise<ReconcileSummary> {
  const oldTag = regionTag(previousName);
  const removed = await removeTagFromAllAssets(oldTag);
  const subnetsRemoved = await removeTagFromAllSubnets(oldTag);
  // Provenance is keyed by region id, not by tag name, so it survives the
  // rename untouched -- and the sync's add pass is idempotent against the
  // tags[] array rather than against provenance, so every current member picks
  // up the NEW tag string even though its provenance row already exists.
  const synced = await applyOneRegion(region);
  return {
    regionId: region.id,
    added: synced.added,
    removed: removed + synced.removed,
    assetsTouched: removed + synced.assetsTouched,
    subnetsAdded: synced.subnetsAdded,
    subnetsRemoved: subnetsRemoved + synced.subnetsRemoved,
    subnetsTouched: subnetsRemoved + synced.subnetsTouched,
  };
}

/**
 * Strip the region's tag from every asset. Called from the DELETE path before
 * the final reconcile (which then doesn't need to add anything for this id).
 */
export async function applyDelete(region: MapRegion): Promise<ReconcileSummary> {
  const tag = regionTag(region.name);
  const removed = await removeTagFromAllAssets(tag);
  const subnetsRemoved = await removeTagFromAllSubnets(tag);
  // The region is gone, so every pair we recorded for it is meaningless -- drop
  // them rather than leaving rows no future region id could ever match.
  await dropAllProvenance(region.id);
  return {
    regionId: region.id,
    added: 0,
    removed,
    assetsTouched: removed,
    subnetsAdded: 0,
    subnetsRemoved,
    subnetsTouched: subnetsRemoved,
  };
}

/**
 * Re-evaluate one region: tag its current members AND strip the tag from
 * targets that have drifted out of it since we tagged them. Used after create,
 * after a polygon edit, by the periodic job, and at the end of discovery.
 *
 * The strip half is bounded by provenance -- see `diffRegionMembership`. A
 * target we never tagged is never stripped, so the add pass is what earns the
 * right to remove later.
 *
 * Note what running on the discovery-end hook implies: membership is read from
 * whatever coordinates and controller stamps discovery has just finished
 * writing. A gate whose pin is transiently absent takes its whole subtree out
 * of the region for that pass and back in on the next one, which surfaces as
 * tag churn rather than as a wrong steady state.
 */
export async function applyOneRegion(region: MapRegion): Promise<ReconcileSummary> {
  const tag = regionTag(region.name);
  const members = await computeMembership(region);
  const prov = await loadProvenance(region.id);

  const assets = diffRegionMembership(members.assetIds, prov.assetIds);
  const subnets = diffRegionMembership(members.subnetIds, prov.subnetIds);

  // Add the tag first, then record provenance -- a crash between the two leaves
  // a tagged target with no provenance row, which reads as operator-owned. The
  // reverse order would record a tag we never wrote and strip it next pass.
  const added = await addTagToAssets(Array.from(members.assetIds), tag);
  await recordProvenance(region.id, "asset", Array.from(members.assetIds));
  const subnetsAdded = await addTagToSubnets(Array.from(members.subnetIds), tag);
  await recordProvenance(region.id, "subnet", Array.from(members.subnetIds));

  const removed = await removeTagFromAssets(assets.toRemove, tag);
  await dropProvenance(region.id, "asset", assets.toRemove);
  const subnetsRemoved = await removeTagFromSubnets(subnets.toRemove, tag);
  await dropProvenance(region.id, "subnet", subnets.toRemove);

  return {
    regionId: region.id,
    added,
    removed,
    assetsTouched: added + removed,
    subnetsAdded,
    subnetsRemoved,
    subnetsTouched: subnetsAdded + subnetsRemoved,
  };
}

/**
 * Full re-evaluation pass over every region -- adds current members and strips
 * the ones that have moved out (provenance-bounded, so hand-applied tags and
 * tags predating provenance survive). Renames and deletes keep their dedicated
 * CRUD paths for the wholesale tag rotation.
 *
 * Used by the periodic job and by the discovery-end hook. One region failing
 * must not stop the rest: a region whose membership query throws is logged and
 * skipped, leaving its tags exactly as they were.
 */
/**
 * Refuse an asset write that ADDS a `region:<name>` tag naming no current
 * region. Throws `AppError(400)` listing the offending tags.
 *
 * Deliberately a diff, not a blanket ban on the prefix. Two things have to stay
 * true at once:
 *
 *   - **An existing region tag must round-trip.** The asset edit modal PUTs the
 *     whole `tags` array back, region tags included, so refusing the prefix
 *     outright would make every asset in a region unsaveable.
 *   - **Hand-applying a LIVE region's tag stays legal.** Tagging a device the
 *     polygon does not cover is documented behavior that survives every
 *     reconcile (the add direction is authoritative only for members) — so the
 *     test is "does a region answer to this name", not "did the map put it here".
 *
 * What it blocks is the third case: inventing `region:Narnia`. That string is
 * unmaintained by anything, renders in the picker as though it were real, and
 * is indistinguishable from a tag stranded by a half-applied rename — the
 * ambiguity business rule 54 has to design around. The registry guard in
 * `serverSettings.ts` closes the same door on the `Tag` catalogue.
 *
 * **No DB read on the common path**: a write that adds no region tag at all —
 * which is nearly all of them, including every bulk edit that does not touch
 * regions — returns before `listRegions()`.
 */
export async function assertAddedRegionTagsNameARegion(
  previousTags: readonly string[],
  nextTags: readonly string[],
): Promise<void> {
  const before = new Set(previousTags.map((t) => t.trim().toLowerCase()));
  const added = nextTags.filter((t) => {
    const k = t.trim().toLowerCase();
    return k.startsWith(TAG_PREFIX) && !before.has(k);
  });
  if (added.length === 0) return;

  const live = new Set((await listRegions()).map((r) => regionTag(r.name).trim().toLowerCase()));
  const unknown = added.filter((t) => !live.has(t.trim().toLowerCase()));
  if (unknown.length === 0) return;

  throw new AppError(
    400,
    `${unknown.map((t) => `"${t}"`).join(", ")} ` +
      `${unknown.length === 1 ? "names no map region" : "name no map region"}. ` +
      `The "${TAG_PREFIX}" prefix belongs to the Device Map — draw the region there first, ` +
      `or use a tag name without that prefix.`,
  );
}

/** What the retired-name sweep did on one pass. */
export interface RetiredTagSweep extends Record<string, unknown> {
  /** Retired names that still had a tag out there, and no longer do. */
  namesSwept: string[];
  assetTagsStripped: number;
  subnetTagsStripped: number;
  /**
   * Retired names dropped WITHOUT stripping, because a region answers to that
   * name again — the "deleted and redrawn under the same name" case, which the
   * delete route already treats as the likely intent behind a redraw.
   */
  namesReclaimed: string[];
}

/**
 * Strip `region:<name>` for every name Polaris recorded as retired, then forget
 * the name.
 *
 * This is the ONLY path that removes a region tag naming no current region, and
 * it is bounded by the retired-name list rather than by "the tag matches no
 * region" — see RETIRED_SETTING_KEY for why that distinction is the whole
 * design, and business rule 54 for the contract.
 *
 * Ordering: the strips run OUTSIDE the blob lock (they are the thousands-of-rows
 * half and must not hold a lock every region write needs), and only the
 * bookkeeping rewrite takes it — re-reading the list inside the transaction, so
 * a rename that retired a name while this pass was stripping is not discarded.
 * A name whose strip throws STAYS on the list: an unswept name dropped from it
 * is unreachable garbage again, which is the bug this exists to end.
 */
export async function sweepRetiredRegionTags(): Promise<RetiredTagSweep> {
  const result: RetiredTagSweep = {
    namesSwept: [],
    assetTagsStripped: 0,
    subnetTagsStripped: 0,
    namesReclaimed: [],
  };
  const retired = await loadRetired();
  if (retired.length === 0) return result;

  const live = new Set((await listRegions()).map((r) => r.name.trim().toLowerCase()));
  /** Names this pass has finished with, lower-cased — dropped from the list below. */
  const done = new Set<string>();

  for (const row of retired) {
    const lower = row.name.trim().toLowerCase();
    if (live.has(lower)) {
      result.namesReclaimed.push(row.name);
      done.add(lower);
      continue;
    }
    try {
      const tag = regionTag(row.name);
      const assets = await removeTagFromAllAssets(tag);
      const subnets = await removeTagFromAllSubnets(tag);
      result.assetTagsStripped += assets;
      result.subnetTagsStripped += subnets;
      if (assets > 0 || subnets > 0) result.namesSwept.push(row.name);
      // Idempotent: the CRUD paths already drop the registry row, but a delete
      // that died after the blob write would not have.
      await deleteTagRegistry(row.name);
      done.add(lower);
    } catch (err: any) {
      logger.warn(
        { err: err?.message ?? String(err), region: row.name, regionId: row.regionId },
        "mapRegion: retired-name sweep failed for one name (non-fatal, will retry)",
      );
    }
  }

  if (done.size > 0) {
    await withRegionBlobLock(async (db) => {
      const current = await loadRetired(db);
      await persistRetired(
        current.filter((r) => !done.has(r.name.trim().toLowerCase())),
        db,
      );
    });
  }
  return result;
}

export async function reconcileMapRegions(): Promise<ReconcileSummary> {
  const regions = await listRegions();
  let added = 0;
  let removed = 0;
  let touched = 0;
  let subnetsAdded = 0;
  let subnetsRemoved = 0;
  let subnetsTouched = 0;
  for (const region of regions) {
    try {
      const summary = await applyOneRegion(region);
      added += summary.added;
      removed += summary.removed;
      touched += summary.assetsTouched;
      subnetsAdded += summary.subnetsAdded;
      subnetsRemoved += summary.subnetsRemoved;
      subnetsTouched += summary.subnetsTouched;
    } catch (err: any) {
      logger.warn(
        { err: err?.message ?? String(err), regionId: region.id, region: region.name },
        "mapRegion: reconcile failed for one region (non-fatal)",
      );
    }
  }
  // After the per-region passes, never instead of them: a region that failed
  // above is still live, so its name is not on the retired list and the sweep
  // cannot touch it. Its own failure must not cost the sweep either.
  let retiredTagSweep: RetiredTagSweep | undefined;
  try {
    retiredTagSweep = await sweepRetiredRegionTags();
  } catch (err: any) {
    logger.warn(
      { err: err?.message ?? String(err) },
      "mapRegion: retired-name sweep failed (non-fatal)",
    );
  }
  return {
    added,
    removed,
    assetsTouched: touched,
    subnetsAdded,
    subnetsRemoved,
    subnetsTouched,
    ...(retiredTagSweep ? { retiredTagSweep } : {}),
  };
}

/** What the firewall-geometry pass of the map-save review did. */
export interface FirewallTagReview extends Record<string, unknown> {
  /** `region:` tags stripped from pinned gates sitting outside the named polygon. */
  firewallTagsStripped: number;
  /** Gates that lost at least one tag. */
  firewallsTouched: number;
}

/**
 * Strip `region:<name>` tags from coordinate-carrying FIREWALLS whose pin is
 * outside that region's polygon — regardless of provenance.
 *
 * This is deliberately stronger than the reconcile's provenance-bounded strip,
 * and deliberately narrower: it runs only from the map-save review (see the
 * module header), and it only ever judges a FIREWALL WITH COORDINATES against a
 * region that still EXISTS. Everything else keeps the documented protections —
 * a hand-tagged printer, a gate with no pin, and a `region:` tag naming no
 * current region are all left exactly as they are. For a pinned gate the
 * polygon already implies the tag in the add direction (a hand-removed tag is
 * re-added every pass), so a tag the polygon does NOT imply is stale by the
 * same authority, whether or not this service recorded applying it.
 */
export async function stripOutOfRegionFirewallTags(regions: MapRegion[]): Promise<FirewallTagReview> {
  const byTag = new Map<string, MapRegion>();
  for (const r of regions) byTag.set(regionTag(r.name), r);
  if (byTag.size === 0) return { firewallTagsStripped: 0, firewallsTouched: 0 };

  const gates = await prisma.asset.findMany({
    where: {
      assetType: "firewall",
      latitude: { not: null },
      longitude: { not: null },
    },
    select: { id: true, tags: true, latitude: true, longitude: true },
  });

  const updates: { id: string; tags: string[] }[] = [];
  const dropsByRegion = new Map<string, string[]>();
  let stripped = 0;
  for (const gate of gates) {
    const lat = gate.latitude as unknown as number | null;
    const lng = gate.longitude as unknown as number | null;
    if (lat == null || lng == null) continue;
    const tags = Array.isArray(gate.tags) ? gate.tags : [];
    const keep: string[] = [];
    for (const t of tags) {
      const region = t.startsWith(TAG_PREFIX) ? byTag.get(t) : undefined;
      if (region && !pointInPolygon([lat, lng], region.polygon)) {
        stripped++;
        const ids = dropsByRegion.get(region.id) ?? [];
        ids.push(gate.id);
        dropsByRegion.set(region.id, ids);
        continue;
      }
      keep.push(t);
    }
    if (keep.length !== tags.length) updates.push({ id: gate.id, tags: keep });
  }

  for (const c of chunk50(updates)) {
    await prisma.$transaction(
      c.map((u) => prisma.asset.update({ where: { id: u.id }, data: { tags: u.tags } })),
    );
  }
  // A provenance row for a stripped pair is now a lie ("we tagged this and it
  // is still a member") — drop it so the next reconcile doesn't count the gate
  // as drifted a second time.
  for (const [regionId, ids] of dropsByRegion) {
    await dropProvenance(regionId, "asset", ids);
  }

  return { firewallTagsStripped: stripped, firewallsTouched: updates.length };
}

/** Combined summary of the map-save review — reconcile plus the gate pass. */
export interface MapSaveReviewSummary extends ReconcileSummary, FirewallTagReview {}

/**
 * The Device Map "Save Regions" review: the standard provenance-bounded
 * reconcile over every region (add current members, strip recorded drift),
 * then the geometry-authoritative gate pass above. Reconcile runs FIRST so the
 * gate pass only ever sees tags provenance-bounding chose to leave behind —
 * the two never double-count a removal.
 */
export async function reviewRegionTagsForMapSave(): Promise<MapSaveReviewSummary> {
  const reconciled = await reconcileMapRegions();
  const gates = await stripOutOfRegionFirewallTags(await listRegions());
  return { ...reconciled, ...gates };
}

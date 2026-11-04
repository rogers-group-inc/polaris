/**
 * src/services/autoMonitorStorageService.ts
 *
 * "Auto-Monitor Storage" feature for the AD / Entra ID integrations. The
 * storage-mount analog of autoMonitorInterfacesService: lets an operator
 * pre-select which storage mounts on every discovered workstation / server
 * get pinned for fast-cadence re-walk — i.e. added to Asset.monitoredStorage —
 * instead of pinning each mount by hand on the asset's System tab.
 *
 * The selection is stored as JSON inside Integration.config under each
 * per-class block (workstationMonitor / serverMonitor) as a multi-block union;
 * the resolved pin set is the UNION across whichever blocks are present.
 * Missing key = block off; `null` selection = whole feature off.
 *
 *   byNames    : explicit mountPaths the operator picked from an aggregated list
 *   byPatterns : pattern strings; regex=false treats them as shell wildcards
 *                (* and ?), regex=true treats them as raw anchor-free regex
 *   all        : pin every observed mount on every device of the class. Storage
 *                offers this convenience (interfaces does not) because mount
 *                counts per device are small — "pin every disk" is a common ask
 *                on servers, where a firewall's hundreds of interfaces are not.
 *
 * Resolution always happens against each asset's latest AssetStorageSample
 * rows (mountPath only — the one dimension storage samples carry). These
 * devices only produce storage samples once the Polaris Agent is deployed and
 * reporting, so the picker is empty until then and the apply pass simply pins
 * whatever exists now. The apply pass is strictly additive: it never strips
 * existing pins. Asset.monitoredStorage is operator-owned and removing items
 * from it on every discovery would surprise anyone who pinned one by hand.
 *
 * Pattern compilation (`compilePattern` / wildcard vs regex) is shared with the
 * interfaces service rather than duplicated.
 */

import { chunkArray } from "../utils/chunk.js";
import { prisma } from "../db.js";
import { compilePattern } from "./autoMonitorInterfacesService.js";

// ─── Public types ───────────────────────────────────────────────────────────

interface StorageByNamesBlock   { names: string[] }
interface StorageByPatternsBlock { patterns: string[]; regex: boolean }
interface StorageAllBlock        { all: true }

export type AutoMonitorStorageSelection = {
  byNames?:    StorageByNamesBlock;
  byPatterns?: StorageByPatternsBlock;
  all?:        StorageAllBlock;
} | null;

// Reuses AutoMonitorClass' workstation/server members (plus vCenter's
// virtual_machine class — VM guest mounts are agent-fed exactly like the
// directory classes). Fortinet classes are not valid here; the resolver/apply
// functions take a narrowed type.
export type StorageClass = "workstation" | "server" | "virtual_machine";

/** Minimal mount shape consumed by the resolver. */
export interface ResolverMount {
  mountPath: string;
}

const CLASS_TO_ASSET_TYPE: Record<StorageClass, string> = {
  workstation: "workstation",
  server: "server",
  // vCenter VM class — klass name kept, assets are typed "server" (see the
  // matching note in autoMonitorInterfacesService.CLASS_TO_ASSET_TYPE).
  virtual_machine: "server",
};

// ─── Pure resolver ──────────────────────────────────────────────────────────

/**
 * Returns the set of mountPaths a multi-block selection would pin on one asset.
 * Pure: no DB, no I/O. The set is the UNION across whichever blocks are
 * present; an empty / null selection (or empty mounts) produces zero pins.
 * Caller does the union with the asset's existing Asset.monitoredStorage.
 */
export function resolvePinnedStorage(
  selection: AutoMonitorStorageSelection,
  mounts: ResolverMount[],
): string[] {
  if (!selection) return [];
  if (!mounts || mounts.length === 0) return [];

  const picked = new Set<string>();

  // All — pin every observed mount.
  if (selection.all && selection.all.all === true) {
    for (const m of mounts) picked.add(m.mountPath);
  }

  // By name — explicit mountPaths.
  if (selection.byNames && selection.byNames.names.length > 0) {
    const want = new Set(selection.byNames.names);
    for (const m of mounts) if (want.has(m.mountPath)) picked.add(m.mountPath);
  }

  // By pattern — wildcards or regex per the block's `regex` flag.
  if (selection.byPatterns && selection.byPatterns.patterns.length > 0) {
    const regexes = selection.byPatterns.patterns.map((p) => compilePattern(p, selection.byPatterns!.regex));
    for (const m of mounts) if (regexes.some((r) => r.test(m.mountPath))) picked.add(m.mountPath);
  }

  return Array.from(picked);
}

// ─── DB-bound: latest mounts per asset ───────────────────────────────────────

/**
 * Latest mountPath per asset from asset_storage_samples, bounded to a 72h
 * window. The time bound is essential: an unbounded DISTINCT ON would walk the
 * entire active hypertable chunk per (assetId, mountPath) pair — the same
 * disaster pattern loadLatestInterfaces guards against. 72h tolerates the long
 * end of the storage cadence (up to 24h) plus a couple missed scrapes; a device
 * that hasn't reported in 3 days drops from the "By name" checklist, which is
 * the right behavior. The (assetId, mountPath, timestamp) index covers it.
 *
 * Exported for massPinService (the Assets-page Mass Pinning section), which
 * needs the same mount inventory for an arbitrary asset-id set.
 */
export async function loadLatestStorage(assetIds: string[]): Promise<Map<string, ResolverMount[]>> {
  const out = new Map<string, ResolverMount[]>();
  if (assetIds.length === 0) return out;
  const rows = await prisma.$queryRaw<Array<{ assetId: string; mountPath: string }>>`
    SELECT DISTINCT ON ("assetId", "mountPath")
      "assetId", "mountPath"
    FROM asset_storage_samples
    WHERE "assetId" = ANY(${assetIds}::text[])
      AND "timestamp" > (NOW() AT TIME ZONE 'UTC') - INTERVAL '72 hours'
    ORDER BY "assetId", "mountPath", "timestamp" DESC
  `;
  for (const r of rows) {
    if (!out.has(r.assetId)) out.set(r.assetId, []);
    out.get(r.assetId)!.push({ mountPath: r.mountPath });
  }
  return out;
}

// ─── Aggregate (powers the "By name" checklist) ──────────────────────────────

export interface StorageAggregateRow {
  mountPath: string;
  deviceCount: number;
  devices: Array<{ assetId: string; hostname: string | null; ipAddress: string | null }>;
}

/**
 * Aggregate every mount seen across the integration's assets of one class,
 * grouped by mountPath. Powers the "By name" checklist.
 */
export async function getStorageAggregate(
  integrationId: string,
  klass: StorageClass,
): Promise<StorageAggregateRow[]> {
  const assetType = CLASS_TO_ASSET_TYPE[klass];
  const assets = await prisma.asset.findMany({
    where: { discoveredByIntegrationId: integrationId, assetType: assetType as any },
    select: { id: true, hostname: true, ipAddress: true },
  });
  if (assets.length === 0) return [];
  const byAssetId = new Map(assets.map((a) => [a.id, a]));
  const mountsByAsset = await loadLatestStorage(assets.map((a) => a.id));

  const byMount = new Map<string, StorageAggregateRow>();
  for (const [assetId, mounts] of mountsByAsset) {
    const asset = byAssetId.get(assetId);
    if (!asset) continue;
    for (const m of mounts) {
      let row = byMount.get(m.mountPath);
      if (!row) {
        row = { mountPath: m.mountPath, deviceCount: 0, devices: [] };
        byMount.set(m.mountPath, row);
      }
      row.deviceCount += 1;
      row.devices.push({ assetId, hostname: asset.hostname, ipAddress: asset.ipAddress });
    }
  }

  return Array.from(byMount.values()).sort((a, b) => {
    if (b.deviceCount !== a.deviceCount) return b.deviceCount - a.deviceCount;
    return a.mountPath.localeCompare(b.mountPath);
  });
}

// ─── Precomputed aggregate cache ─────────────────────────────────────────────
// Mirror of autoMonitorInterfacesService's cache: recomputed at the tail of every
// successful discovery run and stashed on Integration.storageAggregateCache so the
// edit modal's mount-path checklist loads instantly. Storage auto-monitor is
// AD/Entra-only, so the only classes that carry a cache are workstation/server.

/** Which storage classes each integration type carries (drives the cache build). */
const STORAGE_CLASSES_BY_TYPE: Record<string, StorageClass[]> = {
  entraid:         ["workstation", "server"],
  activedirectory: ["workstation", "server"],
  windowsserver:   ["workstation", "server"],
  azurearc:        ["workstation", "server"],
  // VMs only — ESXi datastore capacity is the VcenterDatastore table, not
  // the per-asset storage stream.
  vcenter:         ["virtual_machine"],
};

interface CachedStorageRow {
  mountPath: string;
  deviceCount: number;
}

export interface StorageAggregateCacheEntry {
  computedAt: string; // ISO8601
  rows: CachedStorageRow[];
}

/** Map keyed by StorageClass; the persisted shape of Integration.storageAggregateCache. */
type StorageAggregateCache = Record<string, StorageAggregateCacheEntry>;

/**
 * Recompute the mount-path aggregate for every storage class this integration
 * carries and persist it to Integration.storageAggregateCache. Best-effort —
 * Fortinet integration types have no storage classes and are a no-op.
 */
export async function computeAndCacheStorageAggregate(
  integrationId: string,
  integrationType: string,
  computedAtIso?: string,
): Promise<void> {
  const classes = STORAGE_CLASSES_BY_TYPE[integrationType];
  if (!classes) return;
  const computedAt = computedAtIso ?? new Date().toISOString();
  const cache: StorageAggregateCache = {};
  for (const klass of classes) {
    const rows = await getStorageAggregate(integrationId, klass);
    cache[klass] = {
      computedAt,
      rows: rows.map((r) => ({ mountPath: r.mountPath, deviceCount: r.deviceCount })),
    };
  }
  await prisma.integration.update({
    where: { id: integrationId },
    data: { storageAggregateCache: cache as any },
  });
}

/**
 * Read the precomputed mount aggregate for one class. Null when absent so the
 * route can fall back to a live compute (before the first post-feature discovery).
 */
export async function getCachedStorageAggregate(
  integrationId: string,
  klass: StorageClass,
): Promise<StorageAggregateCacheEntry | null> {
  const integ = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { storageAggregateCache: true },
  });
  const cache = (integ?.storageAggregateCache ?? null) as StorageAggregateCache | null;
  return cache?.[klass] ?? null;
}

// ─── Preview (does not write) ────────────────────────────────────────────────

export interface StoragePreviewResult {
  deviceCount: number;
  mountCount: number;
  perDeviceMax: number;
  sampleDevices: Array<{ hostname: string | null; pinNames: string[] }>;
}

/**
 * Preview what `selection` would pin if applied right now. Does not write.
 * `mountCount` is the sum of pin lengths — what this selection alone would
 * produce, not unioned with existing manual pins.
 */
export async function previewAutoMonitorStorageForClass(
  integrationId: string,
  klass: StorageClass,
  selection: AutoMonitorStorageSelection,
): Promise<StoragePreviewResult> {
  const empty: StoragePreviewResult = { deviceCount: 0, mountCount: 0, perDeviceMax: 0, sampleDevices: [] };
  if (!selection) return empty;
  const assetType = CLASS_TO_ASSET_TYPE[klass];
  const assets = await prisma.asset.findMany({
    where: { discoveredByIntegrationId: integrationId, assetType: assetType as any },
    select: { id: true, hostname: true },
  });
  if (assets.length === 0) return empty;
  const mountsByAsset = await loadLatestStorage(assets.map((a) => a.id));

  let deviceCount = 0;
  let mountCount = 0;
  let perDeviceMax = 0;
  const matched: Array<{ hostname: string | null; pinNames: string[] }> = [];
  for (const a of assets) {
    const pin = resolvePinnedStorage(selection, mountsByAsset.get(a.id) ?? []);
    if (pin.length === 0) continue;
    deviceCount += 1;
    mountCount += pin.length;
    if (pin.length > perDeviceMax) perDeviceMax = pin.length;
    matched.push({ hostname: a.hostname, pinNames: pin });
  }
  matched.sort((x, y) => (x.hostname || "").localeCompare(y.hostname || ""));
  return { deviceCount, mountCount, perDeviceMax, sampleDevices: matched.slice(0, 5) };
}

// ─── Apply (writes Asset.monitoredStorage) ───────────────────────────────────

export interface StorageApplyResult {
  devices: number;
  mountsAdded: number;
  perDeviceMax: number;
  sampleDevices: Array<{ assetId: string; hostname: string | null; pinNames: string[] }>;
}

/**
 * Apply `selection` to every asset of `klass` discovered by `integrationId`.
 * Strictly additive: pin = union(existing, computed); we never strip. Skips
 * the write when nothing would change so back-to-back discoveries stay quiet.
 *
 * Mirrors applyAutoMonitorForClass: two-phase (compute in memory, then chunked
 * Promise.allSettled in batches of 50) so the per-asset prisma.update calls
 * don't serialize the modal / discovery tick on big fleets. Idempotent — a
 * half-landed batch yields the same final set as a full one on re-run.
 */
export async function applyAutoMonitorStorageForClass(
  integrationId: string,
  klass: StorageClass,
  selection: AutoMonitorStorageSelection,
  _actor?: string,
): Promise<StorageApplyResult> {
  const empty: StorageApplyResult = { devices: 0, mountsAdded: 0, perDeviceMax: 0, sampleDevices: [] };
  if (!selection) return empty;
  const assetType = CLASS_TO_ASSET_TYPE[klass];
  const assets = await prisma.asset.findMany({
    where: { discoveredByIntegrationId: integrationId, assetType: assetType as any },
    select: { id: true, hostname: true, monitoredStorage: true },
  });
  if (assets.length === 0) return empty;
  const mountsByAsset = await loadLatestStorage(assets.map((a) => a.id));

  interface PendingUpdate {
    assetId: string;
    hostname: string | null;
    fresh: string[];
    unionedNext: string[];
  }
  const pending: PendingUpdate[] = [];
  let perDeviceMax = 0;
  for (const a of assets) {
    const computed = resolvePinnedStorage(selection, mountsByAsset.get(a.id) ?? []);
    if (computed.length === 0) continue;
    const existing = new Set(a.monitoredStorage);
    const fresh = computed.filter((n) => !existing.has(n));
    if (fresh.length === 0) continue;
    const unioned = [...a.monitoredStorage, ...fresh];
    if (unioned.length > perDeviceMax) perDeviceMax = unioned.length;
    pending.push({ assetId: a.id, hostname: a.hostname, fresh, unionedNext: unioned });
  }
  if (pending.length === 0) return empty;

  const BATCH_SIZE = 50;
  let devices = 0;
  let mountsAdded = 0;
  for (const chunk of chunkArray(pending, BATCH_SIZE)) {
    const results = await Promise.allSettled(
      chunk.map((p) =>
        prisma.asset.update({
          where: { id: p.assetId },
          data:  { monitoredStorage: p.unionedNext },
        }),
      ),
    );
    for (let k = 0; k < results.length; k++) {
      const r = results[k];
      const p = chunk[k];
      if (!r || !p) continue;
      if (r.status === "fulfilled") {
        devices += 1;
        mountsAdded += p.fresh.length;
      }
    }
  }

  const sampleDevices: StorageApplyResult["sampleDevices"] = pending.slice(0, 5).map((p) => ({
    assetId: p.assetId,
    hostname: p.hostname,
    pinNames: p.fresh,
  }));

  return { devices, mountsAdded, perDeviceMax, sampleDevices };
}

/**
 * src/services/massPinService.ts
 *
 * Backend for the Assets page's "Mass Pinning" tab (Settings modal): a manual
 * way to pin AND unpin fast-cadence monitoring targets — interfaces (incl.
 * FortiGate IPsec tunnels) and storage mounts — across many assets at once.
 * The operator filters devices with the automations condition-tree vocabulary,
 * loads the matched assets' inventory aggregated by name, stages pin/unpin
 * edits client-side, and applies them in one bulk request.
 *
 * Contrast with the integration auto-monitor apply passes
 * (autoMonitorInterfacesService / autoMonitorStorageService), which are
 * STRICTLY ADDITIVE by design — they run unattended on every discovery, so
 * stripping there would fight hand-pins forever. This surface is different:
 * every change is explicit operator intent on a specific (asset, name) pair,
 * so subtraction is safe here and only here.
 *
 * Two invariants carry the write path:
 *
 *  - DELTAS, not final arrays. The client sends {assetId, name, field}
 *    pin/unpin entries and the server read-modify-writes each asset's current
 *    arrays. A whole-array replace (the PUT /assets/:id shape) would clobber a
 *    concurrent hand-pin of an UNRELATED name on the same asset; the delta
 *    merge makes last-writer-wins apply only to the same (asset, name).
 *
 *  - The 64-per-array cap (mirrors UpdateAssetSchema in routes/assets.ts — an
 *    accidental select-all on a 200-port chassis can't saturate the device
 *    every probe interval) is re-enforced per asset: an overflowing asset is
 *    SKIPPED whole with a reason in the response, never a batch-wide 400 —
 *    one chassis must not veto pins on 400 other switches.
 *
 * Deliberate non-actions on unpin (nothing to clean up):
 *  - Alert state: interface/tunnel/storage triggers all gate on the pin set
 *    (interfaceIsPinned / tunnelIsPinned / storageIsPinned), so readings stop
 *    and the engine's clearVanishedStates sweep closes any firing rows — which
 *    is what makes a bulk unpin here safe without an alert-cleanup path of its
 *    own. Storage was the exception until 2026-09; it no longer is.
 *  - monitorOverrideService recompute: it reads only `monitored`, never pins.
 *  - recordOperatorPinChanges: process/service pins only.
 */

import { chunkArray } from "../utils/chunk.js";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { loadLatestInterfaces } from "./autoMonitorInterfacesService.js";
import { loadLatestStorage } from "./autoMonitorStorageService.js";

// ─── Public types ───────────────────────────────────────────────────────────

export type MassPinFacet = "interfaces" | "storage";

/**
 * Which Asset array a delta targets. "interfaces" → monitoredInterfaces,
 * "ipsecTunnels" → monitoredIpsecTunnels, "storage" → monitoredStorage.
 * The client learns a row's field from the inventory response's
 * `isIpsecTunnel` flag (same provenance splitPinsByProvenance uses).
 */
export type PinField = "interfaces" | "ipsecTunnels" | "storage";

/**
 * Refuse the full inventory above this many matched assets rather than
 * truncating: the tri-state semantics ("pinned on ALL matched devices") are
 * only honest over the complete set, and a silently-cut device list would
 * make a "pin on all" click miss devices the operator believed were covered.
 */
export const MASS_PIN_MAX_ASSETS = 1000;

/** Total pin+unpin deltas accepted per apply call. */
export const MASS_PIN_MAX_DELTAS = 20000;

/**
 * Mirrors the per-array cap in routes/assets.ts UpdateAssetSchema. Keep the
 * two in lockstep — this one exists because the bulk path never goes through
 * that zod schema.
 */
export const MASS_PIN_ARRAY_CAP = 64;

export interface PinInventoryDevice {
  /** Index into PinInventory.assets — hostnames/IPs are encoded once, not per row. */
  a: number;
  pinned: boolean;
}

export interface PinInventoryRow {
  /** ifName or mountPath. */
  name: string;
  /** Interfaces facet only; null for storage rows and unknown ifTypes. */
  ifType: string | null;
  /** True for synthetic IPsec tunnel rows — pins route to monitoredIpsecTunnels. */
  isIpsecTunnel: boolean;
  deviceCount: number;
  devices: PinInventoryDevice[];
}

export interface PinInventory {
  facet: MassPinFacet;
  /** Every matched asset, whether or not it reported any inventory. */
  assets: Array<{ id: string; hostname: string | null; ipAddress: string | null }>;
  /** Grouped by name, deviceCount desc then name asc. */
  rows: PinInventoryRow[];
}

/** One item of an asset's inventory, normalized across the two facets. */
export interface InventoryItem {
  name: string;
  ifType?: string | null;
  isIpsecTunnel?: boolean;
}

export interface MassPinAssetState {
  id: string;
  hostname: string | null;
  ipAddress: string | null;
  monitoredInterfaces: string[];
  monitoredStorage: string[];
  monitoredIpsecTunnels: string[];
}

// ─── Pure: inventory aggregation ─────────────────────────────────────────────

/** Which pin array answers "is this item pinned on this asset?". */
function pinnedIn(asset: MassPinAssetState, item: InventoryItem, facet: MassPinFacet): boolean {
  if (facet === "storage") return asset.monitoredStorage.includes(item.name);
  if (item.isIpsecTunnel) return asset.monitoredIpsecTunnels.includes(item.name);
  return asset.monitoredInterfaces.includes(item.name);
}

/**
 * Group per-asset inventory items by name and stamp each device entry's
 * current pinned state from the provenance-correct array. Pure: no DB, no I/O.
 *
 * Assets with no items still appear in `assets[]` (the client renders the
 * matched count from it), they just contribute to no rows — a device whose
 * inventory is stale (>72h loader bound) is deliberately absent from the
 * checklist, since pinning a name on a device that stopped reporting it
 * would be a write nothing ever reads.
 */
export function buildPinInventory(
  assets: MassPinAssetState[],
  itemsByAsset: Map<string, InventoryItem[]>,
  facet: MassPinFacet,
): PinInventory {
  const indexById = new Map<string, number>();
  const outAssets: PinInventory["assets"] = assets.map((a, i) => {
    indexById.set(a.id, i);
    return { id: a.id, hostname: a.hostname, ipAddress: a.ipAddress };
  });

  const byName = new Map<string, PinInventoryRow>();
  for (const a of assets) {
    const items = itemsByAsset.get(a.id);
    if (!items || items.length === 0) continue;
    const idx = indexById.get(a.id)!;
    // A name should appear once per asset (both loaders dedupe), but guard
    // anyway — a duplicate device entry would double-count the tri-state math.
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.name)) continue;
      seen.add(item.name);
      let row = byName.get(item.name);
      if (!row) {
        row = {
          name: item.name,
          ifType: item.ifType ?? null,
          isIpsecTunnel: item.isIpsecTunnel === true,
          deviceCount: 0,
          devices: [],
        };
        byName.set(item.name, row);
      }
      // Prefer a non-null ifType when one shows up later (getInterfaceAggregate
      // precedent), and let ANY tunnel sighting mark the row — provenance must
      // be sticky or the client would route the pin to the wrong field.
      if (row.ifType === null && item.ifType != null) row.ifType = item.ifType;
      if (item.isIpsecTunnel === true) row.isIpsecTunnel = true;
      row.deviceCount += 1;
      row.devices.push({ a: idx, pinned: pinnedIn(a, item, facet) });
    }
  }

  const rows = Array.from(byName.values()).sort((x, y) => {
    if (y.deviceCount !== x.deviceCount) return y.deviceCount - x.deviceCount;
    return x.name.localeCompare(y.name);
  });

  return { facet, assets: outAssets, rows };
}

// ─── DB: inventory for an arbitrary asset-id set ─────────────────────────────

/**
 * Load the matched assets + their facet inventory and aggregate. Interfaces
 * ride the current-state AssetInterface table (72h lastSeen bound) with IPsec
 * tunnels merged in when any matched asset is a firewall; storage rides the
 * 72h DISTINCT ON over asset_storage_samples. Both via the exported
 * auto-monitor loaders so the staleness contract can't drift between the
 * integration pickers and this one.
 */
export async function getPinInventoryForAssets(
  assetIds: string[],
  facet: MassPinFacet,
): Promise<PinInventory> {
  if (assetIds.length === 0) return { facet, assets: [], rows: [] };
  const assets = await prisma.asset.findMany({
    where: { id: { in: assetIds } },
    select: {
      id: true, hostname: true, ipAddress: true, assetType: true,
      monitoredInterfaces: true, monitoredStorage: true, monitoredIpsecTunnels: true,
    },
    orderBy: { hostname: "asc" },
  });
  const ids = assets.map((a) => a.id);

  const itemsByAsset = new Map<string, InventoryItem[]>();
  if (facet === "interfaces") {
    const includeTunnels = assets.some((a) => String(a.assetType) === "firewall");
    const ifacesByAsset = await loadLatestInterfaces(ids, includeTunnels);
    for (const [assetId, ifaces] of ifacesByAsset) {
      itemsByAsset.set(assetId, ifaces
        // Dead-parent tunnels are unpinnable in the auto-monitor resolver for a
        // reason (the underlay can't carry them) — hide them here too.
        .filter((i) => i.parentDownNoIp !== true)
        .map((i) => ({ name: i.ifName, ifType: i.ifType, isIpsecTunnel: i.isIpsecTunnel === true })));
    }
  } else {
    const mountsByAsset = await loadLatestStorage(ids);
    for (const [assetId, mounts] of mountsByAsset) {
      itemsByAsset.set(assetId, mounts.map((m) => ({ name: m.mountPath })));
    }
  }

  return buildPinInventory(assets as MassPinAssetState[], itemsByAsset, facet);
}

// ─── Pure: apply one asset's deltas ──────────────────────────────────────────

export interface PinDelta {
  assetId: string;
  name: string;
  field: PinField;
}

export interface MassPinChanges {
  pin: PinDelta[];
  unpin: PinDelta[];
}

export interface FinalPinArrays {
  changed: boolean;
  added: number;
  removed: number;
  /** Non-null when a final array would exceed MASS_PIN_ARRAY_CAP — caller skips the asset. */
  capField: PinField | null;
  data: {
    monitoredInterfaces: string[];
    monitoredStorage: string[];
    monitoredIpsecTunnels: string[];
  };
}

/**
 * Apply one asset's pin/unpin deltas to its current arrays. Pure.
 *
 * - Pins dedupe against the existing array (re-pinning is a no-op, not a
 *   duplicate entry) and trust the client-sent field — the client got the
 *   row's provenance from this server's own inventory response, the same
 *   trust level PUT /assets/:id extends to its verbatim arrays.
 * - Unpins of EITHER interface-family field remove the name from BOTH
 *   monitoredInterfaces and monitoredIpsecTunnels: provenance can drift
 *   between the inventory fetch and the apply (a tunnel re-classified by a
 *   fresher scrape), and "stop fast-polling this name" is what the operator
 *   meant either way. Storage unpins touch only monitoredStorage.
 * - capField: any final array over MASS_PIN_ARRAY_CAP marks the whole asset
 *   for skipping — no partial field writes, so the asset's arrays stay
 *   mutually consistent.
 */
export function computeFinalPinArrays(
  current: { monitoredInterfaces: string[]; monitoredStorage: string[]; monitoredIpsecTunnels: string[] },
  pins: Array<{ name: string; field: PinField }>,
  unpins: Array<{ name: string; field: PinField }>,
): FinalPinArrays {
  const ifaces = new Set(current.monitoredInterfaces);
  const storage = new Set(current.monitoredStorage);
  const tunnels = new Set(current.monitoredIpsecTunnels);
  let added = 0;
  let removed = 0;

  const setFor = (field: PinField) =>
    field === "storage" ? storage : field === "ipsecTunnels" ? tunnels : ifaces;

  // Unpins first so a contradictory pin+unpin of the same name nets to the
  // pin (explicit intent to have it pinned wins over the removal half).
  for (const u of unpins) {
    if (u.field === "storage") {
      if (storage.delete(u.name)) removed += 1;
    } else {
      const a = ifaces.delete(u.name);
      const b = tunnels.delete(u.name);
      if (a || b) removed += 1;
    }
  }
  for (const p of pins) {
    const set = setFor(p.field);
    if (!set.has(p.name)) {
      set.add(p.name);
      added += 1;
    }
  }

  let capField: PinField | null = null;
  if (ifaces.size > MASS_PIN_ARRAY_CAP) capField = "interfaces";
  else if (tunnels.size > MASS_PIN_ARRAY_CAP) capField = "ipsecTunnels";
  else if (storage.size > MASS_PIN_ARRAY_CAP) capField = "storage";

  const data = {
    monitoredInterfaces: Array.from(ifaces),
    monitoredStorage: Array.from(storage),
    monitoredIpsecTunnels: Array.from(tunnels),
  };
  const changed =
    added > 0 || removed > 0 ||
    data.monitoredInterfaces.length !== current.monitoredInterfaces.length ||
    data.monitoredStorage.length !== current.monitoredStorage.length ||
    data.monitoredIpsecTunnels.length !== current.monitoredIpsecTunnels.length;

  return { changed, added, removed, capField, data };
}

// ─── DB: bulk apply ──────────────────────────────────────────────────────────

export interface MassPinResult {
  updatedAssets: number;
  pinsAdded: number;
  pinsRemoved: number;
  skipped: Array<{ assetId: string; reason: string }>;
}

/**
 * Apply staged pin/unpin deltas across many assets. Chunked
 * Promise.allSettled writes (the applyAutoMonitorForClass pattern) — per-asset
 * arrays differ so updateMany can't apply, and one failed write must not
 * block the rest. One audit Event for the whole batch (asset.updated's
 * trackFields don't cover pin arrays, so this gets its own action).
 */
export async function applyMassPins(changes: MassPinChanges, actor: string): Promise<MassPinResult> {
  const totalDeltas = changes.pin.length + changes.unpin.length;
  if (totalDeltas === 0) throw new AppError(400, "No pin changes supplied");
  if (totalDeltas > MASS_PIN_MAX_DELTAS) {
    throw new AppError(400, `Too many pin changes (${totalDeltas} > ${MASS_PIN_MAX_DELTAS})`);
  }

  const byAsset = new Map<string, { pins: PinDelta[]; unpins: PinDelta[] }>();
  const bucket = (assetId: string) => {
    let b = byAsset.get(assetId);
    if (!b) { b = { pins: [], unpins: [] }; byAsset.set(assetId, b); }
    return b;
  };
  for (const p of changes.pin) bucket(p.assetId).pins.push(p);
  for (const u of changes.unpin) bucket(u.assetId).unpins.push(u);

  if (byAsset.size > MASS_PIN_MAX_ASSETS) {
    throw new AppError(400, `Too many assets in one apply (${byAsset.size} > ${MASS_PIN_MAX_ASSETS})`);
  }

  const assetIds = Array.from(byAsset.keys());
  const assets = await prisma.asset.findMany({
    where: { id: { in: assetIds } },
    select: { id: true, monitoredInterfaces: true, monitoredStorage: true, monitoredIpsecTunnels: true },
  });
  const foundIds = new Set(assets.map((a) => a.id));

  const skipped: MassPinResult["skipped"] = [];
  for (const id of assetIds) {
    if (!foundIds.has(id)) skipped.push({ assetId: id, reason: "Asset not found" });
  }

  interface PendingUpdate {
    assetId: string;
    added: number;
    removed: number;
    data: FinalPinArrays["data"];
  }
  const pending: PendingUpdate[] = [];
  for (const a of assets) {
    const b = byAsset.get(a.id)!;
    const result = computeFinalPinArrays(a, b.pins, b.unpins);
    if (result.capField !== null) {
      skipped.push({
        assetId: a.id,
        reason: `Pin cap exceeded (${MASS_PIN_ARRAY_CAP} max for ${result.capField})`,
      });
      continue;
    }
    if (!result.changed) continue;
    pending.push({ assetId: a.id, added: result.added, removed: result.removed, data: result.data });
  }

  const BATCH_SIZE = 50;
  let updatedAssets = 0;
  let pinsAdded = 0;
  let pinsRemoved = 0;
  for (const chunk of chunkArray(pending, BATCH_SIZE)) {
    const results = await Promise.allSettled(
      chunk.map((p) =>
        prisma.asset.update({
          where: { id: p.assetId },
          data: {
            monitoredInterfaces: p.data.monitoredInterfaces,
            monitoredStorage: p.data.monitoredStorage,
            monitoredIpsecTunnels: p.data.monitoredIpsecTunnels,
          },
        }),
      ),
    );
    for (let k = 0; k < results.length; k++) {
      const r = results[k];
      const p = chunk[k];
      if (!r || !p) continue;
      if (r.status === "fulfilled") {
        updatedAssets += 1;
        pinsAdded += p.added;
        pinsRemoved += p.removed;
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        skipped.push({ assetId: p.assetId, reason: msg });
      }
    }
  }

  await logEvent({
    action: "asset.pins.bulk_updated",
    resourceType: "asset",
    actor,
    message:
      `Mass pinning: +${pinsAdded} pin(s) / -${pinsRemoved} unpin(s) across ${updatedAssets} asset(s)` +
      (skipped.length ? `; ${skipped.length} skipped` : ""),
    details: { pinsAdded, pinsRemoved, updatedAssets, skipped },
  });

  return { updatedAssets, pinsAdded, pinsRemoved, skipped };
}

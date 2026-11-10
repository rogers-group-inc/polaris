/**
 * src/services/notifications/assetDetail.ts — the per-tick asset-detail and dependency-blame caches (CQ-B063, moved verbatim
 * from notificationEngine.ts): the asset row an alert names, loaded once per tick, and the
 * business rule 78 blame walk's shared switch / gate rows. clearAssetDetailCache renews both.
 */

import { prisma } from "../../db.js";
// Business rule 78 — who silenced a dependency-suppressed device, for the
// alert a down automation raises about it anyway.
import { newBlameLoadCache, type BlameLoadCache } from "../dependencyTreeService.js";
import { type AssetTemplateDetail } from "../../utils/notificationTemplate.js";

// Per-tick asset-detail cache: fed by the per-fire lookups (composition /
// escalation / {asset.*} tokens) and the event-tail's tag reads, so a batch
// touching the same asset fetches once. Cleared each evaluate tick.
export const ASSET_DETAIL_SELECT = {
  // `id` backs {asset.link}; lastSeenSwitch/lastSeenAp back
  // {asset.connectedSwitch}/{asset.connectedAp} — precomputed scalars on the
  // asset row (discovery + persistWirelessStations maintain them), so the
  // alert email can say WHERE the device hangs for the cost of nothing.
  id: true,
  hostname: true, ipAddress: true, macAddress: true, assetType: true, status: true,
  location: true, learnedLocation: true, description: true, manufacturer: true, model: true,
  serialNumber: true, os: true, osVersion: true, department: true, assignedTo: true,
  tags: true, dependencySuppressed: true, lastSeenSwitch: true, lastSeenAp: true,
  // The event/change tail's trigger gate (assetCanTrigger) reads it off this
  // same row rather than paying a second point read per matched event.
  monitored: true,
  // The last column scopeMatchesAsset needs that the template fields don't
  // already cover, so the event tail can test a device filter (business rule
  // 46) against the row it primed for the alert text.
  discoveredByIntegrationId: true,
  // {asset.managedBy} — the owning integration's type + name, and the
  // controller FortiGate a managed switch/AP is labelled with: one joined row
  // and one small JSON blob per asset, fetched with the rest of the detail
  // (and cached per tick with it).
  discoveredByIntegration: { select: { type: true, name: true } },
  fortinetTopology: true,
} as const;

/** Also a `ScopeAsset`: the event tail evaluates device filters against it, and
 *  `relationLeafHits` is where decorateRelationLeafHits stamps the SQL-resolved
 *  verdict for a relation-backed leaf. */
export type AssetDetailRow = AssetTemplateDetail & {
  hostname: string | null; status: string; tags: string[]; dependencySuppressed: boolean; monitored: boolean;
  // Optional on AssetTemplateDetail (a template context may have no asset at
  // all); always selected here, and required by ScopeAsset/RelationDecoratable.
  id: string; assetType: string | null;
  discoveredByIntegrationId: string | null;
  relationLeafHits?: ReadonlyMap<string, boolean>;
};

export const _assetDetailCache = new Map<string, AssetDetailRow | null>();

// Business rule 78 — the blame walk's per-tick cache: every dependency-down
// fire in one tick shares the switch/gate rows it loads. Renewed with the
// asset-detail cache; a stale chain would name a device that has since come
// back.
export let _blameCache: BlameLoadCache = newBlameLoadCache();

export function clearAssetDetailCache(): void {
  _assetDetailCache.clear();
  _blameCache = newBlameLoadCache();
}

export async function assetDetail(assetId: string): Promise<AssetDetailRow | null> {
  if (_assetDetailCache.has(assetId)) return _assetDetailCache.get(assetId)!;
  const a = await prisma.asset.findUnique({ where: { id: assetId }, select: ASSET_DETAIL_SELECT });
  const row = a ? { ...a, status: String(a.status) } : null;
  _assetDetailCache.set(assetId, row);
  return row;
}

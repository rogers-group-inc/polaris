/**
 * src/services/discovery/syncSteps.ts
 *
 * Two steps the inventory syncs that own a source kind outright — vCenter
 * (`syncVcenterDevices`), the workload sync (Unraid / TrueNAS / Proxmox,
 * `syncWorkloadDevices`) and the Generic API feed (`syncGenericApiDevices`) —
 * each carried a copy of (CQ-B036):
 *
 *   - `loadAssetsForSync` — the once-per-run asset preload: a tight select of
 *     the columns every sync's loop, the material-field snapshot, the conflict
 *     snapshot, buildMonitoredSweep and clampAcquiredToLastSeen read, plus the
 *     MAC side-table rows shaped into `macAddresses`. A sync adds the columns
 *     only it reads. Never the unprojected load: at 2000 assets every JSON blob
 *     column is memory and serialization cost on every run.
 *
 *   - `decommissionUnclaimedAssets` — the tail of each sync's missing-record
 *     sweep: of the assets whose source rows the sweep just deleted, those no
 *     other discovery source still claims (enrichment kinds don't count — they
 *     describe a device, they do not say it exists) are decommissioned:
 *     maintenance windows force-closed first (`releaseAssetsForDecommission`,
 *     so the 30 s reconcile cannot flip the status back), then status, then
 *     one Event per asset. Rule 70: the Generic API feed passes
 *     `ownedOnly`, so it decommissions only what it owns or nothing owns.
 *
 * The guard that refuses a sweep when too much vanished at once
 * (`absenceExceedsGuard`) and the source-row deletion stay with each sync:
 * what counts as "gone" differs per sync.
 */
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { logEvent } from "../eventLogService.js";
import { releaseAssetsForDecommission } from "../maintenanceScheduleService.js";
import { ENRICHMENT_SOURCE_KINDS } from "../../utils/assetProjection.js";
import { MAC_ROW_SELECT, shapeMacRows } from "../../utils/macAddresses.js";

const SYNC_ASSET_SELECT = {
  id: true, hostname: true, hostnameOverride: true, assetType: true, status: true,
  monitored: true, monitorOverride: true, acquiredAt: true, lastSeen: true,
  tags: true, discoveredByIntegrationId: true, dnsName: true, ipAddress: true,
  os: true, osVersion: true, serialNumber: true, manufacturer: true, model: true,
  learnedLocation: true, notes: true, assignedTo: true, macAddress: true,
  macAddressRows: { select: MAC_ROW_SELECT },
} satisfies Prisma.AssetSelect;

/**
 * Load every asset once for a sync run — the shared columns plus `extra` —
 * with `macAddresses` hydrated from the MAC side table, and an id index.
 */
export async function loadAssetsForSync(
  extra: Prisma.AssetSelect = {},
): Promise<{ allAssets: any[]; assetById: Map<string, any> }> {
  const rows = await prisma.asset.findMany({ select: { ...SYNC_ASSET_SELECT, ...extra } });
  const allAssets = rows.map((a: any) => ({ ...a, macAddresses: shapeMacRows(a.macAddressRows) }));
  return { allAssets, assetById: new Map<string, any>(allAssets.map((a) => [a.id, a])) };
}

export interface DecommissionUnclaimedOptions {
  now: Date;
  actor?: string;
  integrationId: string;
  integrationName: string;
  /** Event action, e.g. `asset.vcenter.decommissioned`. */
  action: string;
  /** `details.reason` on the Event, e.g. `missing-from-vcenter-inventory`. */
  reason: string;
  /** The noun the Event message opens with ("VM", "ESXi host"); none = the bare quoted name. */
  noun?: (assetType: string | null) => string;
  /** Rule 70: decommission only assets this integration owns, or nothing owns. */
  ownedOnly?: boolean;
}

/**
 * Decommission the candidates no other discovery source still claims. Returns
 * the decommissioned assets' display names (hostname, else IP, else id) and
 * how many candidates were kept because another source still claims them.
 */
export async function decommissionUnclaimedAssets(
  candidateIds: readonly string[],
  opts: DecommissionUnclaimedOptions,
): Promise<{ decommissioned: string[]; keptCount: number }> {
  const ids = [...new Set(candidateIds)];
  if (ids.length === 0) return { decommissioned: [], keptCount: 0 };
  const remaining = await prisma.assetSource.findMany({
    where: { assetId: { in: ids }, sourceKind: { notIn: [...ENRICHMENT_SOURCE_KINDS] } },
    select: { assetId: true },
  });
  const stillClaimed = new Set(remaining.map((r) => r.assetId));
  const orphanIds = ids.filter((id) => !stillClaimed.has(id));
  const keptCount = ids.length - orphanIds.length;
  if (orphanIds.length === 0) return { decommissioned: [], keptCount };

  const { now, actor, integrationId, integrationName } = opts;
  const orphans = await prisma.asset.findMany({
    // Maintenance-window assets ARE judged here: absence from the inventory
    // is configuration truth, not a reachability signal.
    where: {
      id: { in: orphanIds },
      status: { not: "decommissioned" },
      ...(opts.ownedOnly ? { OR: [{ discoveredByIntegrationId: integrationId }, { discoveredByIntegrationId: null }] } : {}),
    },
    select: { id: true, hostname: true, ipAddress: true, assetType: true },
  });
  if (orphans.length === 0) return { decommissioned: [], keptCount };

  const orphanAssetIds = orphans.map((a) => a.id);
  await releaseAssetsForDecommission(orphanAssetIds, {
    at: now, actor, statusChangedBy: integrationName, reason: `no longer present in "${integrationName}"`,
  });
  await prisma.asset.updateMany({
    where: { id: { in: orphanAssetIds } },
    data: { status: "decommissioned", statusChangedAt: now, statusChangedBy: integrationName },
  });
  const decommissioned: string[] = [];
  for (const a of orphans) {
    const name = a.hostname || a.ipAddress || a.id;
    decommissioned.push(name);
    const lead = opts.noun ? `${opts.noun(a.assetType)} ` : "";
    logEvent({
      action: opts.action,
      resourceType: "asset",
      resourceId: a.id,
      resourceName: name,
      actor,
      message: `${lead}"${name}" decommissioned — no longer present in "${integrationName}", and no other discovery source claims it`,
      details: { reason: opts.reason, integrationId, integrationName },
    });
  }
  return { decommissioned, keptCount };
}

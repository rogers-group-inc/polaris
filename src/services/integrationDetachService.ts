/**
 * src/services/integrationDetachService.ts — what deleting an integration
 * does to everything it discovered (business rule 160).
 *
 * `DELETE /integrations/:id` used to delete the row and leave the rest to the
 * schema, whose answer for almost every reference is `onDelete: SetNull`. But
 * every clean-up sweep Polaris has is keyed on the integration id — so the
 * moment that id was nulled, what the integration had written fell out of
 * every sweep for good (2026-11-11 orphan audit):
 *
 *   - its `AssetSource` rows kept their `observed` blobs and kept feeding
 *     `projectAssetFromSources`, so a dead vCenter or Arc row went on
 *     outranking live sources for hostname, OS and serial; and they still
 *     counted as "claimed by a source", so the asset could never be
 *     auto-decommissioned by any other integration's absence sweep;
 *   - `azure:` tags stayed on its assets, where operators are blocked from
 *     editing them and only an Arc run ever strips them;
 *   - hypervisor placement edges (VM → host) stayed frozen at the last sync,
 *     still suppressing alerts for a topology nothing was refreshing;
 *   - a FortiGate's sightings and the integration's discovery-run row stayed;
 *   - DHCP reservations it had pushed stayed on the device with `pushedTo`
 *     nulled, so a later release in Polaris was local-only and nothing said so.
 *
 * Operator decisions (2026-11-11): the assets and networks STAY — a deleted
 * integration must not take the inventory with it — but they are detached
 * cleanly, and the delete dialog offers to decommission the assets that no
 * other source still reports. Pushed DHCP entries are left on the device and
 * written to Events, entry by entry, so there is a record of what is out there.
 *
 * `previewIntegrationDetach` is the dialog's numbers. `detachIntegration` runs
 * BEFORE `prisma.integration.delete`, while the integration id still finds its
 * rows. Neither deletes the integration itself.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { chunkArray } from "../utils/chunk.js";
import { ENRICHMENT_SOURCE_KINDS } from "../utils/assetProjection.js";
import { isAzureTag } from "../utils/tagNormalize.js";
import { logEvent } from "./eventLogService.js";
import { syncAzureTagRegistry } from "./tagAssignmentService.js";
import { releaseAssetsForDecommission } from "./maintenanceScheduleService.js";
import { releaseInfraReservationsForAssets } from "./reservationService.js";
import { recomputeDependencyTree } from "./dependencyTreeService.js";

const ID_CHUNK = 500;
/** Entries named in one Event's details; the message always carries the count. */
const DHCP_EVENT_LIST_CAP = 500;

/** Integration type → the `AssetDependencyParent.source` its sync writes. */
const PLACEMENT_SOURCE_BY_TYPE: Readonly<Record<string, string>> = {
  vcenter: "vcenter",
  unraid: "unraid",
  truenas: "truenas",
  proxmox: "proxmox",
};

interface IntegrationRef {
  id: string;
  name: string;
  type: string;
}

export interface IntegrationDetachPreview {
  /** Assets carrying at least one source row from this integration. */
  sourcedAssets: number;
  /** Of those, the ones nothing else reports — what the tick-box would decommission. */
  soleSourceAssets: number;
  /** Of THOSE, how many are being monitored right now. */
  soleSourceMonitored: number;
  /** Networks this integration discovered (they stay, as manual networks). */
  networks: number;
  /** DHCP reservations pushed to a device through this integration. */
  pushedReservations: number;
  /** Assets carrying an `azure:` tag from this (Azure Arc) integration. */
  azureTaggedAssets: number;
}

/** The assets a source row of this integration sits on. */
async function sourcedAssetIds(integrationId: string): Promise<string[]> {
  const rows = await prisma.assetSource.findMany({
    where: { integrationId },
    select: { assetId: true },
    distinct: ["assetId"],
  });
  return rows.map((r) => r.assetId);
}

/**
 * Of `assetIds`, the ones this integration is the only reporter of: no other
 * non-enrichment source row (a manual one counts — an operator made that
 * record), not already decommissioned, and owned by this integration or by
 * nothing. Ownership decides, as in every absence sweep (rule 70): an asset
 * another integration owns only loses this integration's row.
 */
async function soleSourceAssets(integrationId: string, assetIds: readonly string[]) {
  const out: { id: string; hostname: string | null; ipAddress: string | null; assetType: string; monitored: boolean }[] = [];
  for (const chunk of chunkArray(assetIds, ID_CHUNK)) {
    const others = await prisma.assetSource.findMany({
      where: {
        assetId: { in: chunk },
        sourceKind: { notIn: [...ENRICHMENT_SOURCE_KINDS] },
        // Spelled out, not `NOT: { integrationId }`: in SQL `NULL <> x` is
        // unknown, so that form silently drops every row with no integration
        // — the operator's own `manual` row and the Polaris Agent's among them
        // — and an asset an operator made by hand reads as "nothing else
        // reports it".
        OR: [{ integrationId: null }, { integrationId: { not: integrationId } }],
      },
      select: { assetId: true },
      distinct: ["assetId"],
    });
    const claimed = new Set(others.map((r) => r.assetId));
    const unclaimed = chunk.filter((id) => !claimed.has(id));
    if (unclaimed.length === 0) continue;
    out.push(...await prisma.asset.findMany({
      where: {
        id: { in: unclaimed },
        status: { not: "decommissioned" },
        OR: [{ discoveredByIntegrationId: integrationId }, { discoveredByIntegrationId: null }],
      },
      select: { id: true, hostname: true, ipAddress: true, assetType: true, monitored: true },
    }));
  }
  return out;
}

export async function previewIntegrationDetach(integration: IntegrationRef): Promise<IntegrationDetachPreview> {
  const ids = await sourcedAssetIds(integration.id);
  const [sole, networks, pushedReservations, azureTaggedAssets] = await Promise.all([
    soleSourceAssets(integration.id, ids),
    prisma.subnet.count({ where: { discoveredBy: integration.id } }),
    prisma.reservation.count({ where: { pushedToId: integration.id } }),
    integration.type === "azurearc" ? countAzureTagged(ids) : Promise.resolve(0),
  ]);
  return {
    sourcedAssets: ids.length,
    soleSourceAssets: sole.length,
    soleSourceMonitored: sole.filter((a) => a.monitored).length,
    networks,
    pushedReservations,
    azureTaggedAssets,
  };
}

async function azureTagged(assetIds: readonly string[]): Promise<{ id: string; tags: string[] }[]> {
  const out: { id: string; tags: string[] }[] = [];
  for (const chunk of chunkArray(assetIds, ID_CHUNK)) {
    const rows = await prisma.asset.findMany({ where: { id: { in: chunk }, tags: { isEmpty: false } }, select: { id: true, tags: true } });
    out.push(...rows.filter((a) => a.tags.some(isAzureTag)));
  }
  return out;
}

async function countAzureTagged(assetIds: readonly string[]): Promise<number> {
  return (await azureTagged(assetIds)).length;
}

export interface IntegrationDetachResult {
  sourceRows: number;
  detachedAssets: number;
  decommissioned: number;
  azureTagsStripped: number;
  sightings: number;
  placementEdges: number;
  networks: number;
  dhcpEntriesLeft: number;
}

/**
 * Detach everything `integration` discovered. Call BEFORE deleting the
 * integration row. `decommission` retires the assets nothing else reports.
 *
 * Order matters: the sole-source set is read before the source rows go; the
 * rows go before the decommission so a later absence sweep sees the truth.
 * A failure in any step throws — the caller has not deleted the integration
 * yet, so the operator can try again with everything still addressable.
 *
 * Scale: every read and write is chunked by 500 asset ids and batched; a
 * 2000-VM vCenter is four chunks. It runs once, on an operator's click.
 */
export async function detachIntegration(
  integration: IntegrationRef,
  opts: { decommission: boolean; actor?: string },
): Promise<IntegrationDetachResult> {
  const { id, name, type } = integration;
  const actor = opts.actor;
  const now = new Date();
  const assetIds = await sourcedAssetIds(id);
  const sole = opts.decommission ? await soleSourceAssets(id, assetIds) : [];

  // ── Pushed DHCP entries: left on the device, and on the record (B-D2) ────
  const pushed = await prisma.reservation.findMany({
    where: { pushedToId: id },
    select: {
      id: true, ipAddress: true, macAddress: true, hostname: true, pushStatus: true, pushedScopeId: true, pushedEntryId: true,
      subnet: { select: { cidr: true, name: true, fortigateDevice: true } },
    },
    orderBy: { ipAddress: "asc" },
  });
  if (pushed.length > 0) {
    await logEvent({
      action: "integration.dhcp_entries_left",
      resourceType: "integration",
      resourceId: id,
      resourceName: name,
      actor,
      level: "warning",
      message: `${pushed.length} DHCP reservation${pushed.length === 1 ? "" : "s"} pushed through "${name}" ${pushed.length === 1 ? "was" : "were"} left on the device when the integration was deleted. Polaris can no longer change or remove ${pushed.length === 1 ? "it" : "them"}; releasing the reservation in Polaris will not touch the device.`,
      details: {
        count: pushed.length,
        listed: Math.min(pushed.length, DHCP_EVENT_LIST_CAP),
        entries: pushed.slice(0, DHCP_EVENT_LIST_CAP).map((r) => ({
          ip: r.ipAddress, mac: r.macAddress, hostname: r.hostname,
          network: r.subnet?.cidr ?? null, networkName: r.subnet?.name ?? null, device: r.subnet?.fortigateDevice ?? null,
          scopeId: r.pushedScopeId, entryId: r.pushedEntryId, pushStatus: r.pushStatus,
        })),
      },
    });
  }

  // ── azure: tags (Arc only). Read before the source rows go. ───────────────
  let azureTagsStripped = 0;
  if (type === "azurearc") {
    const tagged = await azureTagged(assetIds);
    for (const chunk of chunkArray(tagged, 100)) {
      await prisma.$transaction(chunk.map((a) =>
        prisma.asset.update({ where: { id: a.id }, data: { tags: a.tags.filter((t) => !isAzureTag(t)) } })));
    }
    azureTagsStripped = tagged.length;
  }

  // ── Placement edges this hypervisor wrote ────────────────────────────────
  let placementEdges = 0;
  const placementSource = PLACEMENT_SOURCE_BY_TYPE[type];
  if (placementSource) {
    for (const chunk of chunkArray(assetIds, ID_CHUNK)) {
      placementEdges += (await prisma.assetDependencyParent.deleteMany({
        where: { source: placementSource, OR: [{ assetId: { in: chunk } }, { parentAssetId: { in: chunk } }] },
      })).count;
    }
  }

  // ── Its own rows: sources, sightings, the discovery-run record ───────────
  const [sources, sightings] = await prisma.$transaction([
    prisma.assetSource.deleteMany({ where: { integrationId: id } }),
    prisma.assetFortigateSighting.deleteMany({ where: { integrationId: id } }),
    prisma.discoveryRun.deleteMany({ where: { integrationId: id, status: { in: ["completed", "aborted", "error"] } } }),
  ]);
  const networks = await prisma.subnet.count({ where: { discoveredBy: id } });

  // ── Decommission what nothing else reports, when asked (B-D1) ────────────
  let decommissioned = 0;
  if (sole.length > 0) {
    const ids = sole.map((a) => a.id);
    const reason = `its only source, the integration "${name}", was deleted`;
    const infra = sole.filter((a) => a.assetType === "switch" || a.assetType === "access_point").map((a) => a.id);
    if (infra.length > 0) await releaseInfraReservationsForAssets(infra, { reason: "asset decommissioned", actor });
    await releaseAssetsForDecommission(ids, { at: now, actor, statusChangedBy: actor ?? name, reason });
    for (const chunk of chunkArray(ids, ID_CHUNK)) {
      decommissioned += (await prisma.asset.updateMany({
        where: { id: { in: chunk }, status: { not: "decommissioned" } },
        data: { status: "decommissioned", statusChangedAt: now, statusChangedBy: actor ?? name },
      })).count;
    }
    await Promise.all(sole.map((a) => {
      const label = a.hostname || a.ipAddress || a.id;
      return logEvent({
        action: "asset.integration_deleted.decommissioned",
        resourceType: "asset",
        resourceId: a.id,
        resourceName: label,
        actor,
        message: `"${label}" decommissioned — ${reason}, and no other discovery source reports it`,
        details: { reason: "integration-deleted", integrationId: id, integrationName: name },
      });
    }));
  }

  // The registry row for an azure: tag no asset carries any more goes too, and
  // the computed dependency tree is rebuilt without the edges that left. Both
  // are best-effort follow-ups: the detach itself is already complete.
  if (azureTagsStripped > 0) void syncAzureTagRegistry().catch((err) => logger.warn({ err }, "azure tag registry sync failed after an integration detach"));
  if (placementEdges > 0 || decommissioned > 0) void recomputeDependencyTree().catch((err) => logger.warn({ err }, "dependency tree recompute failed after an integration detach"));

  return {
    sourceRows: sources.count,
    detachedAssets: assetIds.length,
    decommissioned,
    azureTagsStripped,
    sightings: sightings.count,
    placementEdges,
    networks,
    dhcpEntriesLeft: pushed.length,
  };
}

/** "detached 412 assets (38 decommissioned); 6 DHCP entries left on the device" — for the Event. Pure. */
export function detachSummary(r: IntegrationDetachResult): string {
  const parts: string[] = [];
  if (r.detachedAssets > 0) {
    parts.push(`${r.detachedAssets} asset${r.detachedAssets === 1 ? "" : "s"} detached` +
      (r.decommissioned > 0 ? ` (${r.decommissioned} decommissioned)` : ""));
  }
  if (r.networks > 0) parts.push(`${r.networks} network${r.networks === 1 ? "" : "s"} kept as manual`);
  if (r.azureTagsStripped > 0) parts.push(`azure: tags removed from ${r.azureTagsStripped} asset${r.azureTagsStripped === 1 ? "" : "s"}`);
  if (r.placementEdges > 0) parts.push(`${r.placementEdges} placement link${r.placementEdges === 1 ? "" : "s"} removed`);
  if (r.dhcpEntriesLeft > 0) parts.push(`${r.dhcpEntriesLeft} DHCP entr${r.dhcpEntriesLeft === 1 ? "y" : "ies"} left on the device`);
  return parts.join("; ");
}

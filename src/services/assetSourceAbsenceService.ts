/**
 * src/services/assetSourceAbsenceService.ts — business rule 200: a source that
 * no longer finds its device says so on the Sources tab.
 *
 * Two shapes, chosen so that NOTHING but the Sources tab changes behaviour:
 *
 *  - A sweep that today LEAVES the row in place (an opt-in directory / Generic
 *    API sweep switched off, or the FortiGate roster sweeps, which decommission
 *    without touching source rows) stamps `AssetSource.missingSince`. The row
 *    still counts everywhere it counted before — projection, claims, matching —
 *    exactly as it did when it lingered silently.
 *  - A sweep that today DELETES the row (directory sweep on, vCenter, Unraid /
 *    TrueNAS / Proxmox, Generic API on) still deletes it, after copying it to
 *    `AssetSourceRetired`. Nothing reads that table but the Sources tab, so
 *    every "does something still claim this asset?" answer is unchanged.
 *
 * A row the source sees again has its stamp cleared (`clearSourcesMissing`,
 * or the upserts that write `missingSince: null`); a retired copy is hidden
 * while a live row with its identity exists and replaced if it goes again.
 */

import { prisma } from "../db.js";
import { chunkArray } from "../utils/chunk.js";

const CHUNK = 500;

/** Stamp `missingSince` on rows not already stamped. Returns how many were newly stamped. */
export async function markSourcesMissing(ids: readonly string[], at: Date): Promise<number> {
  let n = 0;
  for (const chunk of chunkArray([...new Set(ids)], CHUNK)) {
    const r = await prisma.assetSource.updateMany({
      where: { id: { in: chunk }, missingSince: null },
      data: { missingSince: at },
    });
    n += r.count;
  }
  return n;
}

/** Clear `missingSince` on rows the source has seen again. */
export async function clearSourcesMissing(ids: readonly string[]): Promise<number> {
  let n = 0;
  for (const chunk of chunkArray([...new Set(ids)], CHUNK)) {
    const r = await prisma.assetSource.updateMany({
      where: { id: { in: chunk }, missingSince: { not: null } },
      data: { missingSince: null },
    });
    n += r.count;
  }
  return n;
}

/**
 * Stamp the source rows of `kinds` on these assets — the FortiGate roster
 * sweeps know the ASSET they decommissioned, not the row.
 */
export async function markAssetSourcesMissing(
  assetIds: readonly string[],
  kinds: readonly string[],
  integrationId: string,
  at: Date,
): Promise<number> {
  let n = 0;
  for (const chunk of chunkArray([...new Set(assetIds)], CHUNK)) {
    const r = await prisma.assetSource.updateMany({
      where: { assetId: { in: chunk }, sourceKind: { in: [...kinds] }, integrationId, missingSince: null },
      data: { missingSince: at },
    });
    n += r.count;
  }
  return n;
}

/**
 * Delete these live source rows, keeping a last-known copy of each in
 * `AssetSourceRetired` (one per identity — an older copy is replaced). The
 * copy and the delete commit together per chunk.
 */
export async function retireSourceRows(ids: readonly string[], at: Date): Promise<number> {
  let n = 0;
  for (const chunk of chunkArray([...new Set(ids)], CHUNK)) {
    n += await prisma.$transaction(async (tx) => {
      const rows = await tx.assetSource.findMany({
        where: { id: { in: chunk } },
        select: {
          id: true, assetId: true, sourceKind: true, externalId: true, integrationId: true,
          observed: true, syncedAt: true, firstSeen: true, lastSeen: true, missingSince: true,
        },
      });
      if (rows.length === 0) return 0;
      await tx.assetSourceRetired.deleteMany({
        where: { OR: rows.map((r) => ({ sourceKind: r.sourceKind, externalId: r.externalId })) },
      });
      await tx.assetSourceRetired.createMany({
        data: rows.map((r) => ({
          assetId: r.assetId,
          sourceKind: r.sourceKind,
          externalId: r.externalId,
          integrationId: r.integrationId,
          observed: (r.observed ?? {}) as any,
          syncedAt: r.syncedAt,
          firstSeen: r.firstSeen,
          lastSeen: r.lastSeen,
          missingSince: r.missingSince ?? at,
        })),
      });
      const del = await tx.assetSource.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      return del.count;
    });
  }
  return n;
}

/**
 * The retired copies to show on one asset's Sources tab: those with no live
 * row of the same identity anywhere (the device came back — on this asset or
 * another — so the copy no longer describes anything).
 */
export async function listShownRetiredSources(assetId: string) {
  const retired = await prisma.assetSourceRetired.findMany({
    where: { assetId },
    include: { integration: { select: { id: true, name: true, type: true } } },
  });
  if (retired.length === 0) return [];
  const live = await prisma.assetSource.findMany({
    where: { OR: retired.map((r) => ({ sourceKind: r.sourceKind, externalId: r.externalId })) },
    select: { sourceKind: true, externalId: true },
  });
  const liveKeys = new Set(live.map((l) => `${l.sourceKind}\u0000${l.externalId}`));
  return retired.filter((r) => !liveKeys.has(`${r.sourceKind}\u0000${r.externalId}`));
}

/**
 * src/jobs/backfillInterfaceInventory.ts
 *
 * One-shot startup job: seed the CURRENT-STATE interface inventory
 * (`asset_interfaces`) from each asset's most recent full system-info snapshot
 * in `asset_interface_samples`.
 *
 * WHY IT'S NEEDED. `persistInterfaces` populates an asset the next time its
 * full system-info pass runs — but that cadence is `pollInterval`-linked and
 * can be as long as 24 hours. Without a backfill, an install that upgrades
 * would have assets whose System tab, topology edges and auto-monitor pin
 * picker read an empty table for up to a day once those readers cut over. The
 * data to avoid that is already on disk; this just copies it across.
 *
 * SAFE TO SKIP DATA. Only assets with a `lastSystemInfoAt` anchor are
 * considered, and only rows at exactly that timestamp — the same equality match
 * the System tab used before the cutover, so the seeded set is precisely what
 * the UI was already rendering. An asset with no anchor (never scraped) simply
 * waits for its first pass, which is correct.
 *
 * CREATE-ONLY. Assets that already have inventory rows are skipped rather than
 * overwritten: by the time this runs a live scrape may already have written
 * fresher state, and a stale snapshot must never clobber it. That also makes
 * the job idempotent independent of its marker.
 *
 * Import this from src/app.ts to activate.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { hasRunMarker, stampRunMarker } from "./_runOnce.js";
import { persistInterfaceRows } from "../services/interfaceInventoryService.js";

/** Marker key — once shipped this must never change. */
const MARKER_KEY = "backfillInterfaceInventoryAt";

/** Assets per batch. Keeps the working set small on a 2000-asset fleet. */
const ASSET_BATCH = 100;

export async function backfillInterfaceInventory(): Promise<void> {
  if (await hasRunMarker(MARKER_KEY)) return;

  const startedAt = Date.now();
  let assetsSeeded = 0;
  let rowsSeeded = 0;
  let assetsSkipped = 0;

  try {
    // Only assets that have actually completed a full system-info pass.
    const candidates = await prisma.asset.findMany({
      where: { lastSystemInfoAt: { not: null } },
      select: { id: true, lastSystemInfoAt: true },
    });

    for (let i = 0; i < candidates.length; i += ASSET_BATCH) {
      const batch = candidates.slice(i, i + ASSET_BATCH);

      // Skip anything a live scrape already populated — fresher than this.
      const alreadyPopulated = new Set(
        (
          await prisma.assetInterface.findMany({
            where: { assetId: { in: batch.map((a) => a.id) } },
            select: { assetId: true },
            distinct: ["assetId"],
          })
        ).map((r) => r.assetId),
      );

      for (const asset of batch) {
        if (alreadyPopulated.has(asset.id)) { assetsSkipped++; continue; }
        const anchor = asset.lastSystemInfoAt;
        if (!anchor) continue;

        // Exactly the query the System tab used pre-cutover.
        const samples = await prisma.assetInterfaceSample.findMany({
          where: { assetId: asset.id, timestamp: anchor },
          orderBy: { ifName: "asc" },
        });
        if (samples.length === 0) continue;

        await persistInterfaceRows(
          asset.id,
          samples.map((s) => ({
            ifName:         s.ifName,
            adminStatus:    s.adminStatus,
            operStatus:     s.operStatus,
            speedBps:       s.speedBps,
            duplex:         s.duplex,
            ipAddress:      s.ipAddress,
            macAddress:     s.macAddress,
            inOctets:       s.inOctets,
            outOctets:      s.outOctets,
            inErrors:       s.inErrors,
            outErrors:      s.outErrors,
            ifType:         s.ifType,
            ifParent:       s.ifParent,
            vlanId:         s.vlanId,
            nativeVlan:     s.nativeVlan,
            taggedVlans:    s.taggedVlans,
            trunksAllVlans: s.trunksAllVlans,
            alias:          s.alias,
            description:    s.description,
            addressingMode: s.addressingMode,
            poeStatus:      s.poeStatus,
            poeClass:       s.poeClass,
          })),
          // lastSeen is the snapshot's own time, not now — a row seeded from a
          // three-hour-old scrape must not claim to be current.
          anchor,
        );
        assetsSeeded++;
        rowsSeeded += samples.length;
      }
    }

    await stampRunMarker(MARKER_KEY, { assetsSeeded, rowsSeeded, assetsSkipped });
    logger.info(
      { assetsSeeded, rowsSeeded, assetsSkipped, elapsedMs: Date.now() - startedAt },
      "interface inventory backfill complete",
    );
  } catch (err) {
    // Never fatal: the next full system-info pass populates the table anyway,
    // and the marker is deliberately NOT stamped so a later boot retries.
    logger.error({ err, assetsSeeded, rowsSeeded }, "interface inventory backfill failed");
  }
}

backfillInterfaceInventory();

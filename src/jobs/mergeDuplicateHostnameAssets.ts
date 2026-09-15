/**
 * src/jobs/mergeDuplicateHostnameAssets.ts
 *
 * Periodic safety-net cleanup for accumulated duplicate-hostname Asset rows
 * (also runs once at boot). Discovery re-creates these continuously, so a
 * boot-only pass left them piling up between restarts on a long-lived prod
 * host — see the INTERVAL_MS note below the schedule.
 *
 * Several discovery pathways create separate Asset rows for the same physical
 * device when no overlapping identifier was available at the time:
 *
 *   - **Workstation ghosts** — FortiGate device-inventory creates one
 *     "fortigate-endpoint" Asset per distinct MAC sighting. A device with
 *     wired + WiFi NICs ends up with two endpoint rows sharing a hostname
 *     but no MAC. Entra/Intune later cross-links one of them by Ethernet MAC;
 *     the other lives on as a hostname-only duplicate.
 *   - **Phase-1 backfill leftovers** — assets with only a "manual" source row
 *     (the backfill placeholder) that should have been swept by the real
 *     discovery on first contact, but weren't (the inline sweep covers
 *     specific shapes; some early-shipped configurations slipped through).
 *   - **Infrastructure ghosts** — managed FortiSwitch/FortiAP/FortiGate
 *     discovered by serial, while its mgmt MAC was independently learned via
 *     DHCP/ARP and created a sibling "fortigate-endpoint" asset. The companion
 *     `mergeFortiswitchEndpointGhosts` job handles the specific case where
 *     the switch's MAC is still NULL; once `baseMac` capture stamps it (post
 *     -baseMac landing), the existing job's filter no longer matches but
 *     the duplicate row persists. This job catches those. Firewalls now stamp
 *     ALL of their physical interface MACs at discovery time (from
 *     `/api/v2/cmdb/system/interface`), so new firewall ghosts are prevented at
 *     the source regardless of which interface a peer sighted — but pre-existing
 *     firewall duplicates (and the rare case of the interface query failing a
 *     cycle) still converge here.
 *
 * Each cycle of every discovery loop re-raises a "Sibling hostname collision"
 * Conflict against the un-cross-linked sibling — operator queue pressure
 * without operator action resolving the underlying duplication. Accepting
 * one cycle's conflict absorbs ONE ghost (the previous canonical, via
 * acceptAssetConflict's ghost-absorption block) but leaves the OTHER ghosts
 * untouched, so the queue refills on the next discovery cycle.
 *
 * This job walks every `lower(hostname)` group with ≥2 Asset rows, picks the
 * canonical by source-kind priority, and transfers/merges every sibling into
 * the canonical inside a single transaction.
 *
 * Canonical-pick priority (lower number wins; same number → most-recent
 * `lastSeen` then most-recent `updatedAt`):
 *
 *   1 — entra / intune / ad / polaris-agent  (identity-tagged)
 *   2 — fortiswitch                          (managed switch)
 *   3 — fortiap                              (managed AP)
 *   4 — fortigate-firewall                   (managed firewall)
 *   5 — fortigate-endpoint                   (DHCP-discovered endpoint)
 *   6 — manual                               (Phase-1 backfill placeholder)
 *   7 — no source rows                       (orphan)
 *
 * Tie-safety: if two rows are tied at the same tier AND both have non-null
 * primary MACs that DON'T MATCH, the group is skipped (genuine "two
 * different devices sharing a hostname"). Logged at warn with the asset
 * ids so an operator can decide.
 *
 * Side-table transfer (delete-on-conflict for unique violations):
 *   - AssetMacAddress      — unique on (assetId, mac)
 *   - AssetAssociatedIp    — unique on (assetId, ip)
 *   - AssetIpHistory       — unique on (assetId, ip)
 *   - AssetFortigateSighting — unique on (assetId, fortigateDevice)
 *
 * Cascade-deletes when the ghost is removed (no transfer needed):
 *   - AssetSource (the canonical's sources are authoritative; next discovery
 *     re-observes anything still live)
 *   - AssetLldpNeighbor + AssetWirelessStation
 *   - AssetInterfaceOverride (operator-set comments — rare on a ghost; this
 *     job documents the loss in the log line; preserving them would require
 *     transferring with conflict-handling on (assetId, ifName))
 *   - Conflict (pending conflicts pointing at the ghost cascade-clear, so
 *     the queue empties naturally on next discovery)
 *   - AssetDependencyParent (both sides; the 60s dependencyReconciler tick
 *     recomputes from authoritative topology data)
 *
 * NOT cascade-deleted (no FK anymore — migration 20260615000000): every
 * AssetXxxSample / *Hourly / *Daily time-series + AssetCustomWidgetSample +
 * AssetStateSample.
 * Those tables are TimescaleDB hypertables; a cascade DELETE matching rows in a
 * compressed chunk would decompress it into multi-GB of un-truncatable heap
 * bloat (prod incident 2026-06-08). The ghost's sample rows are simply left
 * orphaned (assetId points at the deleted ghost, never queried) and age out via
 * drop_chunks on the normal retention schedule — same net effect as the old
 * cascade (the ghost's history isn't transferred to the canonical), just
 * compression-safe. Almost always empty anyway (ghosts are usually unmonitored
 * workstation/endpoint duplicates).
 *
 * Scalar-field absorption onto the canonical (only when the canonical's
 * field is empty/null and the ghost has a value): macAddress, ipAddress,
 * serialNumber, manufacturer, model, os, osVersion, assignedTo, notes,
 * acquiredAt, lastSeen, learnedLocation — plus assetType, where the `other`
 * catch-all counts as empty so a ghost's specific type fills it. Mirrors
 * `acceptAssetConflict`'s ghost-absorption block. Tags are union-merged.
 *
 * Dry-run mode: set `POLARIS_GHOST_MERGE_DRY_RUN=1` to log every decision
 * without writing. Use on the first deploy to review the per-group choices,
 * then unset the env var and let the next restart actually merge.
 *
 * Idempotent: re-running with no env var finds zero candidates once
 * convergent. No marker; the query itself is the converge check.
 *
 * Pairs with the existing `mergeFortiswitchEndpointGhosts` job (which handles
 * the now-narrow case of NULL-MAC FortiSwitches) and Phase 11 of
 * `syncDhcpSubnets` (the projection apply pass that prevents inline drift
 * from creating new duplicates going forward).
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { logEvent } from "../services/eventLogService.js";
import { runInstrumentedJob } from "./_metrics.js";
import {
  decideDuplicateHostnameGroup,
  mergeDuplicateHostnameGhost,
  type DuplicateHostnameAssetRow,
} from "../services/assetGhostMergeService.js";

// The canonical-pick policy (source-tier table + MAC tie-safety) and the
// per-ghost merge transaction moved to assetGhostMergeService (2026-08
// audit) so they're unit-testable and reachable from other surfaces. This
// job owns the schedule, the duplicate-group query, dry-run, and logging.
type AssetRow = DuplicateHostnameAssetRow;

// Periodic safety-net interval. The job runs once at boot AND on this cadence
// because discovery re-creates duplicate-hostname rows continuously (e.g. the
// same device DHCP-discovered by several FortiGates), and production is
// long-lived (restarted only on in-app updates) — a boot-only pass let
// duplicates accumulate between restarts. Idempotent + scale-aware, so re-runs
// are cheap once convergent.
const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function mergeDuplicateHostnameAssets(): Promise<void> {
  try {
    await runInstrumentedJob("mergeDuplicateHostnameAssets", async () => {
      const dryRun = process.env.POLARIS_GHOST_MERGE_DRY_RUN === "1";

      // Find every hostname appearing on >1 Asset row. Capped at the
      // realistic upper bound — even at thousands-of-assets fleets the
      // duplicate-hostname set is small (the prod sample showed 99).
      // Operator-pinned hostnames ("hostnameOverride") are excluded on both
      // sides: a pin that happens to collide with another asset's hostname is
      // operator intent (two genuinely different devices), not a discovery
      // ghost — merging on it would absorb a real device.
      // The grouping query hands back the ids it already grouped, so the
      // hydrating read below is keyed on the primary key.
      //
      // It used to return only the hostnames, and the read then matched them
      // with `OR: hosts.map(h => ({ hostname: { equals: h, mode: "insensitive" }}))`
      // — up to 2000 OR'd ILIKEs, which no hostname index can serve (the old
      // comment's "hostname is indexed" is true and irrelevant: `ILIKE`
      // doesn't use it), so Postgres seq-scanned the table and ran 2000
      // pattern comparisons per row, 48 times a day, and worst exactly when
      // the fleet is most duplicated.
      const dupHosts = await prisma.$queryRaw<{ host: string; ids: string[] }[]>`
        SELECT lower(hostname) AS host, array_agg(id) AS ids
        FROM assets
        WHERE hostname IS NOT NULL
          AND "hostnameOverride" IS NULL
        GROUP BY lower(hostname)
        HAVING count(*) > 1
        LIMIT 2000
      `;
      if (dupHosts.length === 0) return;

      const dupIds = dupHosts.flatMap((d) => d.ids);
      const rows: AssetRow[] = await prisma.asset.findMany({
        where: {
          id: { in: dupIds },
          // Mirror the SQL exclusion — a pinned asset must be neither ghost
          // nor canonical. Redundant with the grouping query's own filter,
          // kept so the read states its own invariant.
          hostnameOverride: null,
        },
        select: {
          id: true,
          hostname: true,
          ipAddress: true,
          macAddress: true,
          serialNumber: true,
          manufacturer: true,
          model: true,
          assetType: true,
          os: true,
          osVersion: true,
          assignedTo: true,
          notes: true,
          learnedLocation: true,
          acquiredAt: true,
          lastSeen: true,
          lastSeenSource: true,
          monitored: true,
          updatedAt: true,
          tags: true,
          sources: { select: { sourceKind: true } },
        },
      });

      const groups = new Map<string, AssetRow[]>();
      for (const r of rows) {
        const key = (r.hostname ?? "").toLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
      }

      let groupsScanned = 0;
      let groupsMerged = 0;
      let ghostsAbsorbed = 0;
      let groupsSkippedAmbiguous = 0;
      let groupsSkippedSingleton = 0;

      for (const [host, members] of groups) {
        if (members.length < 2) {
          groupsSkippedSingleton++;
          continue;
        }
        groupsScanned++;

        const decision = decideDuplicateHostnameGroup(members);
        if (decision.kind === "skip") {
          groupsSkippedAmbiguous++;
          logger.warn(
            {
              host,
              reason: decision.reason,
              assetIds: members.map((m) => m.id),
            },
            "duplicate-hostname-merge: skipping (operator review)",
          );
          continue;
        }

        const { canonical, ghosts, tiers } = decision;
        if (dryRun) {
          logger.info(
            {
              host,
              tiers,
              canonicalId: canonical.id,
              canonicalSources: canonical.sources.map((s) => s.sourceKind),
              ghostIds: ghosts.map((g) => g.id),
              ghostSources: ghosts.map((g) => g.sources.map((s) => s.sourceKind)),
              dryRun: true,
            },
            "duplicate-hostname-merge: WOULD merge (dry-run)",
          );
          continue;
        }

        try {
          for (const ghost of ghosts) {
            await mergeDuplicateHostnameGhost(canonical, ghost);
            ghostsAbsorbed++;
          }
          groupsMerged++;
          logger.info(
            {
              host,
              tiers,
              canonicalId: canonical.id,
              absorbedIds: ghosts.map((g) => g.id),
            },
            "duplicate-hostname-merge: merged",
          );
          await logEvent({
            action: "asset.duplicate_merged",
            resourceType: "asset",
            resourceId: canonical.id,
            resourceName: canonical.hostname ?? undefined,
            level: "info",
            message: `Duplicate-hostname cleanup — absorbed ${ghosts.length} sibling${ghosts.length === 1 ? "" : "s"} into ${canonical.hostname || canonical.id}`,
            details: {
              host,
              tiers,
              canonicalId: canonical.id,
              absorbedIds: ghosts.map((g) => g.id),
              absorbedSources: ghosts.map((g) => g.sources.map((s) => s.sourceKind)),
            },
          });
        } catch (err) {
          logger.warn(
            { err, host, canonicalId: canonical.id, ghostIds: ghosts.map((g) => g.id) },
            "duplicate-hostname-merge: failed (will retry next boot)",
          );
        }
      }

      if (groupsScanned > 0) {
        logger.info(
          {
            dryRun,
            groupsScanned,
            groupsMerged,
            ghostsAbsorbed,
            groupsSkippedAmbiguous,
            groupsSkippedSingleton,
          },
          dryRun
            ? "duplicate-hostname-merge dry-run complete"
            : "duplicate-hostname-merge complete",
        );
      }
    });
  } catch (err) {
    logger.error({ err }, "mergeDuplicateHostnameAssets failed (will retry next cycle)");
  }
}

mergeDuplicateHostnameAssets();
setInterval(mergeDuplicateHostnameAssets, INTERVAL_MS);


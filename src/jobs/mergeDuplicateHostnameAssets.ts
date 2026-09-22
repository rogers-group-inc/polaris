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
 * This job runs TWO passes, each walking groups of ≥2 Asset rows, picking the
 * canonical by source-kind priority and merging every sibling into it inside
 * a single transaction per sibling.
 *
 *   1. **Serial** (`normalizeSerialKey`) — the stronger identity, so it goes
 *      first. Two rows carrying one real serial are one device, which is the
 *      same conclusion business rule 83's `duplicate-serial` card reaches;
 *      this pass just stops waiting for someone to click it. It reuses that
 *      rule's `isUsableSerial` + `MAX_PLAUSIBLE_DUPLICATES` filtering, and
 *      skips both the `hostnameOverride` exclusion and the MAC tie-break,
 *      neither of which applies once a serial has settled identity.
 *   2. **Hostname** (`lower(hostname)`) — re-queried after the serial pass,
 *      so anything it already merged is gone. Endpoint assets never get a
 *      serial, so this remains the ONLY pass that can reach a MAC-less
 *      workstation ghost — the case this job was originally written for.
 *      Do not delete it in favour of the serial pass.
 *
 * The prod case that prompted the serial pass (2026-09-22): one FortiSwitch
 * recorded twice, same serial / MAC / IP / hostname, the older row holding no
 * AssetSource at all because `AssetSource` is unique on
 * `(sourceKind, externalId)` and externalId for a fortiswitch IS the serial —
 * so the newer asset's source row was re-bound off the older one, orphaning
 * it. Both rows stayed monitored, and the device was polled twice per cycle.
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
  decideDuplicateSerialGroup,
  mergeDuplicateHostnameGhost,
  type DuplicateHostnameAssetRow,
} from "../services/assetGhostMergeService.js";
// Serial usability + the vendor-default cap are business rule 83's, reused so
// the merge pass and the `duplicate-serial` conflict card can never disagree
// about which serials identify hardware.
import { MAX_PLAUSIBLE_DUPLICATES } from "../services/duplicateSerialConflictService.js";
// Business rule 84 moved the "is this string an identity?" test to its own
// util so every WRITE point can run it; the service still re-exports it, but
// the util is the canonical home and what new callers should import.
import { isUsableSerial } from "../utils/serialNumber.js";
import { normalizeSerialKey } from "../utils/fortinetParentKey.js";

/** The row shape both passes hydrate — must satisfy DuplicateHostnameAssetRow. */
const ASSET_MERGE_SELECT = {
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
} as const;

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

      // ── Pass 1 of 2: SERIAL ────────────────────────────────────────────
      // Runs first because a serial is the stronger identity. Two rows
      // carrying one real serial are one device, full stop — so this pass
      // needs neither the hostname pass's `hostnameOverride` exclusion (that
      // guards against two genuinely different devices sharing a name, which
      // a serial rules out) nor its MAC tie-break. What it does need is the
      // rule 83 filtering, reused rather than re-derived: `isUsableSerial`
      // rejects SMBIOS placeholders and repeated-character strings, and
      // MAX_PLAUSIBLE_DUPLICATES treats a serial shared by more assets than
      // any one device could be as a vendor default rather than a pile of
      // duplicates.
      //
      // The SQL is a coarse prefilter only: the authoritative regrouping is
      // done in JS with `normalizeSerialKey`, the same helper the discovery
      // asset index and the rule 83 sweep key on, so nothing depends on
      // Postgres `btrim` and JS `trim()` agreeing about exotic whitespace.
      // `status` is a Postgres enum, so the exclusion casts to text —
      // omitting the cast is the bug rule 83 shipped with.
      const serialStats = { groupsScanned: 0, groupsMerged: 0, ghostsAbsorbed: 0, groupsSkippedVendor: 0 };
      const dupSerials = await prisma.$queryRaw<{ ids: string[] }[]>`
        SELECT array_agg(id) AS ids
        FROM assets
        WHERE "serialNumber" IS NOT NULL
          AND btrim("serialNumber") <> ''
          AND status::text NOT IN ('decommissioned', 'disabled')
        GROUP BY upper(btrim("serialNumber"))
        HAVING count(*) > 1
        LIMIT 2000
      `;

      if (dupSerials.length > 0) {
        const serialRows: AssetRow[] = await prisma.asset.findMany({
          where: { id: { in: dupSerials.flatMap((d) => d.ids) } },
          select: ASSET_MERGE_SELECT,
        });

        const bySerial = new Map<string, AssetRow[]>();
        for (const r of serialRows) {
          if (!isUsableSerial(r.serialNumber)) continue;
          const key = normalizeSerialKey(r.serialNumber);
          if (!key) continue;
          const list = bySerial.get(key);
          if (list) list.push(r);
          else bySerial.set(key, [r]);
        }

        for (const [serial, members] of bySerial) {
          if (members.length < 2) continue;
          if (members.length > MAX_PLAUSIBLE_DUPLICATES) {
            serialStats.groupsSkippedVendor++;
            logger.debug(
              { serial, count: members.length },
              "duplicate-serial-merge: ignoring a serial shared by more assets than one device could be",
            );
            continue;
          }
          serialStats.groupsScanned++;

          const decision = decideDuplicateSerialGroup(members);
          if (decision.kind === "skip") continue; // not reachable today; keeps the union honest
          const { canonical, ghosts, tiers } = decision;

          if (dryRun) {
            logger.info(
              { serial, tiers, canonicalId: canonical.id, ghostIds: ghosts.map((g) => g.id), dryRun: true },
              "duplicate-serial-merge: WOULD merge (dry-run)",
            );
            continue;
          }

          try {
            for (const ghost of ghosts) {
              await mergeDuplicateHostnameGhost(canonical, ghost);
              serialStats.ghostsAbsorbed++;
            }
            serialStats.groupsMerged++;
            logger.info(
              { serial, tiers, canonicalId: canonical.id, absorbedIds: ghosts.map((g) => g.id) },
              "duplicate-serial-merge: merged",
            );
            await logEvent({
              action: "asset.duplicate_merged",
              resourceType: "asset",
              resourceId: canonical.id,
              resourceName: canonical.hostname ?? undefined,
              level: "info",
              message: `Duplicate-serial cleanup — absorbed ${ghosts.length} record${ghosts.length === 1 ? "" : "s"} of serial ${serial} into ${canonical.hostname || canonical.id}`,
              details: {
                matchedOn: "serial",
                serial,
                tiers,
                canonicalId: canonical.id,
                absorbedIds: ghosts.map((g) => g.id),
                absorbedSources: ghosts.map((g) => g.sources.map((s) => s.sourceKind)),
              },
            });
          } catch (err) {
            logger.warn(
              { err, serial, canonicalId: canonical.id, ghostIds: ghosts.map((g) => g.id) },
              "duplicate-serial-merge: failed (will retry next cycle)",
            );
          }
        }
      }

      // ── Pass 2 of 2: HOSTNAME ──────────────────────────────────────────
      // Re-queried from scratch below, so rows the serial pass just deleted
      // are already gone. This pass still earns its place: endpoint assets
      // carry no serial at all, so MAC-less workstation ghosts — the case
      // this job was written for — are reachable only by hostname.
      //
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
        select: ASSET_MERGE_SELECT,
      });

      const groups = new Map<string, AssetRow[]>();
      for (const r of rows) {
        const key = (r.hostname ?? "").toLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
      }

      let groupsScanned = serialStats.groupsScanned;
      let groupsMerged = serialStats.groupsMerged;
      let ghostsAbsorbed = serialStats.ghostsAbsorbed;
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
            // Totals span both passes; the bySerial* fields break out the
            // serial half so a jump in one pass is attributable.
            groupsScanned,
            groupsMerged,
            ghostsAbsorbed,
            groupsSkippedAmbiguous,
            groupsSkippedSingleton,
            bySerialGroupsScanned: serialStats.groupsScanned,
            bySerialGroupsMerged: serialStats.groupsMerged,
            bySerialGhostsAbsorbed: serialStats.ghostsAbsorbed,
            bySerialSkippedVendorDefault: serialStats.groupsSkippedVendor,
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


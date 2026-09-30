/**
 * src/services/assetGhostMergeService.ts
 *
 * Merge a duplicate "fortigate-endpoint" ghost Asset into its canonical
 * infrastructure asset (managed FortiSwitch / FortiAP / firewall).
 *
 * The ghost pattern: a managed device's management interface pulls a DHCP
 * lease from its FortiGate, so the gate's DHCP / ARP / device-inventory
 * pathway learns the MAC independently and creates a separate endpoint
 * Asset (hostname = the device serial, sourceKind = "fortigate-endpoint").
 * Once the real infrastructure asset exists, discovery's serial match
 * resolves it FIRST every cycle, so the adoption fallbacks (MAC / hostname)
 * never run against the ghost — it is permanently shielded from the inline
 * dedup and just keeps getting freshened by the lease pathway.
 *
 * Callers: the inline ghost sweep in the FortiSwitch / FortiAP discovery
 * loops (`syncDhcpSubnets` in src/services/discovery/discoveryEngine.ts) and the
 * one-shot `mergeFortiswitchEndpointGhosts` startup job.
 *
 * Distinct from `assetMergeService.mergeAssets` (the operator-driven merge)
 * on purpose: that path RE-BINDS the ghost's AssetSource rows onto the
 * survivor (its ghosts carry genuinely different discovery sources) and
 * unions tags. An endpoint ghost's sources are stale placeholders that must
 * be DELETED — re-binding would staple a fortigate-endpoint / orphaned
 * manual source onto the infrastructure asset — and its
 * "device-inventory" tags would mislabel a switch. The low-level side-table
 * transfer is shared (`transferAssetSideTables`).
 *
 * What merging does (single transaction):
 *   - transfers AssetMacAddress / AssetAssociatedIp / AssetIpHistory /
 *     AssetFortigateSighting rows ghost → canonical (delete-on-conflict
 *     for unique violations — the canonical's row wins)
 *   - deletes the ghost's AssetSource rows (placeholders by definition —
 *     eligibility requires no authoritative source; see below)
 *   - stamps the ghost's primary MAC onto the canonical when the canonical
 *     has none
 *   - carries `monitored = true` over when the ghost was monitored and the
 *     canonical isn't (endpoint ghosts are never auto-monitored, so a
 *     monitored ghost reflects an explicit operator choice); the caller's
 *     post-transaction `recomputeMonitorOverrideForAssets` run keeps the
 *     override bit faithful to that carried-over intent
 *   - deletes the ghost row. Sample hypertables carry no FK to Asset
 *     (migration 20260615000000) so the ghost's samples are left orphaned
 *     and age out via drop_chunks — never row-deleted (compressed-chunk
 *     bloat, prod incident 2026-06-08).
 */

import { prisma } from "../db.js";
import { transferAssetSideTables } from "./assetMergeService.js";
import { recomputeMonitorOverrideForAssets } from "./monitorOverrideService.js";
import { macHexKeyOrNull } from "../utils/mac.js";
import { bumpLastSeen } from "../utils/assetInvariants.js";
import { isGenericAssetType } from "../utils/assetTypes.js";

/**
 * Source kinds that mark an asset as having its own authoritative identity.
 * An asset carrying ANY of these is NOT a mergeable ghost — only pure
 * endpoint placeholders (fortigate-endpoint, plus at most the empty
 * "manual" row an operator edit stamps) qualify.
 */
const AUTHORITATIVE_SOURCE_KINDS: ReadonlySet<string> = new Set([
  "entra",
  "intune",
  "ad",
  "polaris-agent",
  "fortigate-firewall",
  "fortiswitch",
  "fortiap",
]);

/**
 * Pure eligibility check over an asset's AssetSource kinds: mergeable when
 * the asset has fortigate-endpoint provenance and no authoritative source.
 */
export function isMergeableGhostSourceKinds(kinds: string[]): boolean {
  if (!kinds.includes("fortigate-endpoint")) return false;
  return !kinds.some((k) => AUTHORITATIVE_SOURCE_KINDS.has(k));
}

/** DB-backed eligibility check for a single asset id. */
export async function isMergeableEndpointGhost(assetId: string): Promise<boolean> {
  const rows = await prisma.assetSource.findMany({
    where: { assetId },
    select: { sourceKind: true },
  });
  return isMergeableGhostSourceKinds(rows.map((r) => r.sourceKind));
}

export interface GhostMergeResult {
  /** MAC stamped onto the canonical (null when it already had one / ghost had none). */
  adoptedMac: string | null;
  /** True when the ghost's monitored=true was carried onto the canonical. */
  transferredMonitored: boolean;
}

/**
 * Merge `ghostId` into `canonicalId` and delete the ghost. Caller is
 * responsible for eligibility (isMergeableEndpointGhost) — this function
 * assumes the ghost is a placeholder and its sources are disposable.
 */
export async function mergeEndpointGhostIntoAsset(
  canonicalId: string,
  ghostId: string,
): Promise<GhostMergeResult> {
  const result = await prisma.$transaction(async (tx) => {
    const canonical = await tx.asset.findUniqueOrThrow({
      where: { id: canonicalId },
      select: { macAddress: true, monitored: true },
    });
    const ghost = await tx.asset.findUniqueOrThrow({
      where: { id: ghostId },
      select: { macAddress: true, monitored: true },
    });

    // Side tables (AssetMacAddress / AssetAssociatedIp / AssetIpHistory /
    // AssetFortigateSighting) — unique per (assetId, key): re-point
    // non-conflicting rows, delete conflicting ones (the canonical wins).
    await transferAssetSideTables(tx, ghostId, canonicalId);

    // Source rows on the ghost are all placeholders superseded by the
    // canonical's authoritative sources — drop them. Cannot re-point:
    // AssetSource is uniquely keyed on (sourceKind, externalId), and any
    // conflict would mean the canonical already has a row for that source.
    await tx.assetSource.deleteMany({ where: { assetId: ghostId } });

    const canonicalUpdate: Record<string, unknown> = {};
    const adoptedMac = !canonical.macAddress && ghost.macAddress ? ghost.macAddress : null;
    if (adoptedMac) canonicalUpdate.macAddress = adoptedMac;
    const transferredMonitored = ghost.monitored === true && canonical.monitored !== true;
    if (transferredMonitored) canonicalUpdate.monitored = true;
    if (Object.keys(canonicalUpdate).length > 0) {
      await tx.asset.update({ where: { id: canonicalId }, data: canonicalUpdate });
    }

    // Delete the ghost. Relational side tables not transferred above
    // (AssetLldpNeighbor, dependency edges, conflicts, overrides) cascade;
    // sample hypertables have no FK and their orphaned rows age out via
    // drop_chunks (see header comment).
    await tx.asset.delete({ where: { id: ghostId } });

    return { adoptedMac, transferredMonitored };
  });

  // Keep monitorOverride faithful after carrying operator monitoring intent
  // over — same post-write hook the operator asset-write paths use.
  if (result.transferredMonitored) {
    try {
      await recomputeMonitorOverrideForAssets(prisma, [canonicalId]);
    } catch {
      // Best-effort — an override recompute failure must not undo the merge.
    }
  }

  return result;
}

// ─── Duplicate-hostname merge (the mergeDuplicateHostnameAssets job) ────────
//
// Policy + executor for the periodic duplicate-hostname sweep. The job
// (src/jobs/mergeDuplicateHostnameAssets.ts — see its header for the full
// ghost taxonomy, cascade/orphan semantics, and dry-run workflow) finds the
// lower(hostname) groups and drives logging/cadence; the canonical-pick
// policy and the merge transaction live here so they're testable and
// reachable from other surfaces.

/** Canonical-pick priority (lower wins). See the job header for rationale. */
type SourceTier = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const KIND_TIER: Record<string, SourceTier> = {
  entra: 1,
  intune: 1,
  ad: 1,
  "polaris-agent": 1,
  fortiswitch: 2,
  fortiap: 3,
  "fortigate-firewall": 4,
  "fortigate-endpoint": 5,
  manual: 6,
};

export interface DuplicateHostnameAssetRow {
  id: string;
  hostname: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  assetType: string | null;
  os: string | null;
  osVersion: string | null;
  assignedTo: string | null;
  notes: string | null;
  learnedLocation: string | null;
  acquiredAt: Date | null;
  lastSeen: Date | null;
  lastSeenSource: string | null;
  monitored: boolean;
  updatedAt: Date;
  tags: string[];
  sources: { sourceKind: string }[];
}

function tierForAsset(sourceKinds: string[]): SourceTier {
  if (sourceKinds.length === 0) return 7;
  let best: SourceTier = 7;
  for (const k of sourceKinds) {
    const t = (KIND_TIER[k] ?? 7) as SourceTier;
    if (t < best) best = t;
  }
  return best;
}

// Shared bare-hex matching key — rejects the all-zero MAC so two unrelated
// ghosts can't group into one merge candidate on 00:00:00:00:00:00.
const normMac = macHexKeyOrNull;

/**
 * Order a group best-canonical-first: source tier, then most-recent lastSeen,
 * then most-recent updatedAt. Shared by the hostname and serial passes so the
 * two can never disagree about which row of a group should survive.
 */
function rankBySourceTier(rows: DuplicateHostnameAssetRow[]) {
  const decorated = rows.map((r) => ({
    row: r,
    tier: tierForAsset(r.sources.map((s) => s.sourceKind)),
  }));
  decorated.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const at = a.row.lastSeen?.getTime() ?? 0;
    const bt = b.row.lastSeen?.getTime() ?? 0;
    if (at !== bt) return bt - at;
    return b.row.updatedAt.getTime() - a.row.updatedAt.getTime();
  });
  return decorated;
}

export type DuplicateGroupDecision =
  | { kind: "merge"; canonical: DuplicateHostnameAssetRow; ghosts: DuplicateHostnameAssetRow[]; tiers: number[] }
  | { kind: "skip"; reason: string };

/**
 * Pick the canonical row of a duplicate-hostname group by source-kind tier
 * (ties broken by most-recent lastSeen, then updatedAt). Tie-safety: a
 * same-tier sibling whose non-null MAC disagrees with the canonical's is a
 * genuine second device — the whole group is skipped for operator review.
 */
export function decideDuplicateHostnameGroup(rows: DuplicateHostnameAssetRow[]): DuplicateGroupDecision {
  const decorated = rankBySourceTier(rows);
  const canonical = decorated[0];
  const rest = decorated.slice(1);

  const cMac = normMac(canonical.row.macAddress);
  for (const g of rest) {
    if (g.tier !== canonical.tier) continue;
    const gMac = normMac(g.row.macAddress);
    if (cMac && gMac && cMac !== gMac) {
      return {
        kind: "skip",
        reason: `tied tier ${canonical.tier} with conflicting MACs (${cMac} vs ${gMac})`,
      };
    }
  }

  return {
    kind: "merge",
    canonical: canonical.row,
    ghosts: rest.map((d) => d.row),
    tiers: [canonical.tier, ...rest.map((d) => d.tier)],
  };
}

/**
 * Pick the canonical row of a duplicate-SERIAL group. Same tier ordering as
 * the hostname pass, and deliberately WITHOUT its MAC tie-safety.
 *
 * That guard exists because a shared hostname has an innocent explanation —
 * two genuinely different devices named the same — so conflicting MACs at a
 * tied tier mean "don't guess". A shared serial has no such explanation: the
 * only innocent case is that the string is not really a serial, which
 * `isUsableSerial` and the vendor-default cap filter out BEFORE a group is
 * formed. Whatever survives those is one device recorded twice, which is the
 * same conclusion business rule 83's `duplicate-serial` card reaches when it
 * offers a merge as its only action. Two MACs on one chassis is ordinary
 * (a switch's baseMac beside a DHCP-learned mgmt MAC) and must not block it.
 *
 * Callers must therefore have filtered the group through `isUsableSerial` +
 * `MAX_PLAUSIBLE_DUPLICATES` first — this function trusts the grouping.
 */
export function decideDuplicateSerialGroup(rows: DuplicateHostnameAssetRow[]): DuplicateGroupDecision {
  const decorated = rankBySourceTier(rows);
  return {
    kind: "merge",
    canonical: decorated[0].row,
    ghosts: decorated.slice(1).map((d) => d.row),
    tiers: decorated.map((d) => d.tier),
  };
}

/**
 * Absorb one duplicate-hostname ghost into its canonical, in one transaction:
 * side-table transfer (shared delete-on-conflict helper), null-fill scalar
 * absorption + tag union (mirrors acceptAssetConflict), lastSeen adoption
 * through bumpLastSeen (business-rule-12 gates apply; unlabeled ghost
 * sightings are treated as discovery-origin), then the ghost cascade-delete
 * (sample hypertables have no FK and orphan by design — see the job header).
 */
export async function mergeDuplicateHostnameGhost(
  canonical: DuplicateHostnameAssetRow,
  ghost: DuplicateHostnameAssetRow,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await transferAssetSideTables(tx, ghost.id, canonical.id);

    const update: Record<string, unknown> = {};
    if (!canonical.macAddress && ghost.macAddress) update.macAddress = ghost.macAddress;
    if (!canonical.ipAddress && ghost.ipAddress) update.ipAddress = ghost.ipAddress;
    if (!canonical.serialNumber && ghost.serialNumber) update.serialNumber = ghost.serialNumber;
    if (!canonical.manufacturer && ghost.manufacturer) update.manufacturer = ghost.manufacturer;
    if (!canonical.model && ghost.model) update.model = ghost.model;
    // Type: the `other` catch-all counts as empty, so a canonical still filed
    // as "other" takes the ghost's specific type (mirrors acceptAssetConflict
    // and assetMergeService.fieldIsEmpty). Never the other way round.
    if (isGenericAssetType(canonical.assetType) && !isGenericAssetType(ghost.assetType)) {
      update.assetType = ghost.assetType;
    }
    if (!canonical.os && ghost.os) update.os = ghost.os;
    if (!canonical.osVersion && ghost.osVersion) update.osVersion = ghost.osVersion;
    if (!canonical.assignedTo && ghost.assignedTo) update.assignedTo = ghost.assignedTo;
    if (!canonical.notes && ghost.notes) update.notes = ghost.notes;
    if (!canonical.learnedLocation && ghost.learnedLocation)
      update.learnedLocation = ghost.learnedLocation;
    if (!canonical.acquiredAt && ghost.acquiredAt) update.acquiredAt = ghost.acquiredAt;
    if (ghost.lastSeen) {
      bumpLastSeen(update, canonical, ghost.lastSeen, ghost.lastSeenSource ?? "discovery");
    }
    const cTags = new Set(canonical.tags);
    const merged = [...canonical.tags];
    for (const t of ghost.tags) {
      if (!cTags.has(t)) {
        merged.push(t);
        cTags.add(t);
      }
    }
    if (merged.length > canonical.tags.length) update.tags = merged;

    if (Object.keys(update).length > 0) {
      await tx.asset.update({ where: { id: canonical.id }, data: update });
    }

    await tx.asset.delete({ where: { id: ghost.id } });
  });
}

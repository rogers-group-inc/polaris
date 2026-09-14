/**
 * src/services/regionHierarchyService.ts
 *
 * The alert-routing view of region nesting: given the region tags a TRIGGERING
 * asset carries, which regions sit at level 1 (the device's own, most specific),
 * level 2 (the division containing it), and so on.
 *
 * ── Levels here are ASSET-RELATIVE, and that is the whole point ──────────────
 *
 * A globally-numbered level cannot answer this question consistently. Levels
 * count outward from the leaves, so on an uneven tree they have GAPS: a division
 * holding one bare leaf region and one 3-deep chain is L4, with children at L1
 * and L3 and no L2 beneath it. Asking for "the asset's L2 regions" by filtering
 * the snapshot on `level === 2` would then reach NOBODY for a device in the bare
 * leaf, while reaching a mid-chain region for a device in the other branch —
 * the same automation paging a division manager for one alert and a local tech
 * for the next.
 *
 * So level 1 is resolved as "the innermost region(s) the asset is in" and each
 * higher level is one step OUT along the containment edges. Contiguous by
 * construction.
 *
 * ── Seed from the snapshot, then walk the EDGES ──────────────────────────────
 *
 * The walk outward deliberately does NOT require the parent's name to be in the
 * asset's tag snapshot. `mapRegionService.computeMembership` tags each region
 * independently, so a containing division's tag is only present once the
 * reconciler has run and the enclosure is exact — and an escalation must not
 * fall silent because a tag is one reconcile behind.
 *
 * ── An ORPHANED tag makes the whole ranking unsafe ───────────────────────────
 *
 * The seed is the snapshot ∩ catalogue, so a tag naming no region used to be
 * dropped and the ranking computed over whatever was left. That is not merely
 * "contributes nothing": dropping the LEAF promotes its container to level 1,
 * and the automation silently pages the division instead of the site. It cannot
 * be detected from the outside either — the tag still renders on the asset, the
 * alert still delivers, and only the tier is wrong.
 *
 * So an unrecognized tag now makes this function ABSTAIN for every level
 * (business rule 58). Nothing else about the alert changes: the other recipient
 * arms still resolve, and the caller logs which tag stranded the ranking.
 *
 * Kept out of `mapRegionService` on purpose: that file owns tag reconciliation
 * and is imported by jobs; this is the thin read used on the alerting path.
 */

import { getRegionHierarchy } from "./mapRegionService.js";
// From the leaf util, NOT from notificationService (which re-exports it):
// notificationService imports notificationRuleService, which imports this
// module, so importing it from there would close a runtime cycle.
import { stripRegionPrefix } from "../utils/tagNormalize.js";
// The ceiling lives in notificationTypes with the recipient schemas that
// enforce it — this module reads it rather than owning a second copy.
import { MAX_DEVICE_REGION_LEVELS } from "./notificationTypes.js";

export { MAX_DEVICE_REGION_LEVELS };

export interface RegionLevelEntry {
  /** The region's name as stored, for matching against a user's region tags. */
  name: string;
  /** The immediate container's name, or null for a top-level region. */
  parentName: string | null;
  /** The GLOBAL derived level — for display only; routing uses the walk. */
  level: number;
}

export interface RegionLevelIndex {
  /** Keyed by the normalized name (prefix-stripped, lower-cased). */
  byName: Map<string, RegionLevelEntry>;
  /** The deepest nesting in the catalogue — 1 when nothing is nested. */
  maxLevel: number;
}

/** Match `normalizeNeedle` in notificationRecipientService: asset tags carry the
 *  `region:` prefix, user tags do not, and both compare case-insensitively. */
function key(name: string): string {
  return stripRegionPrefix(String(name ?? "")).trim().toLowerCase();
}

/**
 * Build the name → {parent, level} index.
 *
 * Deliberately NOT wrapped in a second TTL cache. `getRegionHierarchy` is
 * already memoized per `Setting.updatedAt`, so the only cost here is one
 * indexed `findUnique` — and paying that is what makes a region edit visible
 * immediately in the monitor process, which a 60s TTL would delay. Callers on a
 * fan-out path memoize the RESULT for the duration of one notification instead
 * (see `expandDeliveries`), so a rule with three notify actions resolves it once
 * and a rule that never opts in pays nothing.
 */
export async function regionLevelIndex(): Promise<RegionLevelIndex> {
  const { regions, hierarchy } = await getRegionHierarchy();
  const nameById = new Map(regions.map((r) => [r.id, r.name]));
  const byName = new Map<string, RegionLevelEntry>();
  for (const r of regions) {
    const node = hierarchy.byId[r.id];
    byName.set(key(r.name), {
      name: r.name,
      parentName: node?.parentId ? nameById.get(node.parentId) ?? null : null,
      level: node?.level ?? 1,
    });
  }
  return { byName, maxLevel: hierarchy.maxLevel || 1 };
}

/** Is `candidateKey` an ancestor of any region in `present`? */
function isAncestorOfAny(candidateKey: string, present: RegionLevelEntry[], index: RegionLevelIndex): boolean {
  for (const entry of present) {
    let cursor = entry.parentName ? key(entry.parentName) : null;
    let hops = 0;
    while (cursor && hops++ <= MAX_DEVICE_REGION_LEVELS) {
      if (cursor === candidateKey) return true;
      const parent = index.byName.get(cursor);
      cursor = parent?.parentName ? key(parent.parentName) : null;
    }
  }
  return false;
}

/**
 * The asset's region tags that name no region in the CURRENT catalogue.
 *
 * Hand-typed, or — the case that actually happens — left behind by a region
 * renamed or deleted without its tag rotation completing (business rule 54;
 * prod carried 1,492 such tags under two dead names). Returned in the caller's
 * own spelling so a log line names the string an operator can search for.
 *
 * Pure and exported because it is the REASON `deviceRegionsAtLevels` abstains,
 * and a silent abstention is the failure mode this whole pair exists to end.
 */
export function orphanedRegionTags(
  assetRegionNames: string[] | undefined,
  index: RegionLevelIndex,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of assetRegionNames ?? []) {
    const k = key(raw);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (!index.byName.has(k)) out.push(String(raw));
  }
  return out;
}

/**
 * The region NAMES to route to, for a device carrying `assetRegionNames`, at the
 * requested asset-relative `levels` (1 = the device's own innermost region).
 *
 * Returns bare names, the form `resolveUsersByRegions` matches on.
 *
 * ABSTAINS ENTIRELY — `[]` for every level — when any tag names no region in the
 * catalogue (business rule 58). An unrecognized tag cannot be placed in the
 * containment forest, so nothing can establish which of the remaining tags is
 * innermost; ranking the rest promotes a container to L1 and pages the wrong
 * tier. Callers log `orphanedRegionTags` rather than treating `[]` as "nobody
 * matched".
 */
export function deviceRegionsAtLevels(
  assetRegionNames: string[] | undefined,
  levels: number[] | undefined,
  index: RegionLevelIndex,
): string[] {
  const wanted = new Set(
    (levels ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= MAX_DEVICE_REGION_LEVELS),
  );
  if (wanted.size === 0) return [];

  // Business rule 58 — abstain rather than rank a snapshot we cannot place.
  // Checked BEFORE the seed below, because the seed is exactly the step that
  // would swallow the unrecognized tag and hand back a confidently wrong leaf.
  if (orphanedRegionTags(assetRegionNames, index).length > 0) return [];

  // Snapshot ∩ catalogue, deduped.
  const present: RegionLevelEntry[] = [];
  const seenPresent = new Set<string>();
  for (const raw of assetRegionNames ?? []) {
    const k = key(raw);
    if (!k || seenPresent.has(k)) continue;
    const entry = index.byName.get(k);
    if (entry) {
      seenPresent.add(k);
      present.push(entry);
    }
  }
  if (present.length === 0) return [];

  // Level 1 = the INNERMOST regions the asset is in: those that are not an
  // ancestor of another region it also carries. An asset is tagged with its own
  // region AND (once reconciled) every region containing it, so without this
  // the division would be indistinguishable from the leaf.
  let current = present.filter((e) => !isAncestorOfAny(key(e.name), present, index));
  if (current.length === 0) current = present; // defensive: a containment cycle can't happen

  const out: string[] = [];
  const emitted = new Set<string>();
  const deepest = Math.max(...wanted);
  for (let level = 1; level <= deepest && current.length > 0; level++) {
    if (wanted.has(level)) {
      for (const e of current) {
        const k = key(e.name);
        if (!emitted.has(k)) {
          emitted.add(k);
          out.push(e.name);
        }
      }
    }
    // Step one container outward, deduping where two siblings share a parent.
    const next: RegionLevelEntry[] = [];
    const seenNext = new Set<string>();
    for (const e of current) {
      const pk = e.parentName ? key(e.parentName) : null;
      if (!pk || seenNext.has(pk)) continue;
      const parent = index.byName.get(pk);
      if (parent) {
        seenNext.add(pk);
        next.push(parent);
      }
    }
    current = next;
  }
  return out;
}

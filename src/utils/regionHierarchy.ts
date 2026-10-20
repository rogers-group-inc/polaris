/**
 * src/utils/regionHierarchy.ts
 *
 * Derives the map-region containment FOREST and a level per region from polygon
 * nesting. Pure, no DB, no I/O. The one operator input is `nestUnderId`, which
 * can only choose WHICH real container is a region's parent (when several
 * contain it) — never nest a region under one that does not contain it.
 *
 * Why derived rather than a flag an operator sets: a region "is" a division
 * because it contains other regions, so a stored level is a second source of
 * truth that a restore, a backup import or a hand-edited Setting can silently
 * desynchronize — and the drift would be invisible, because nothing would
 * recompute to compare.
 *
 * Input is `{id, polygon, nestUnderId?}` only — no names, no colors. The presenter joins those
 * back on. That keeps this file trivially testable and stops it drifting into a
 * service.
 *
 * ── depth vs level: BOTH are here, and they are not interchangeable ──────────
 *
 * `depth` counts from the outermost ring inward (0 = top-level) and is always
 * gap-free. `level` counts from the leaves outward (1 = a region containing
 * nothing) and CAN have gaps: a parent holding one bare leaf and one 3-deep
 * chain is L4, with children at L1 and L3 and no L2 anywhere beneath it.
 *
 * So `level` is what an operator reads — it is their mental model, and it is
 * what the region tree displays — while `depth` / `ancestorIds` is what code
 * should route on. **Never compute a routing target with `level + 1`
 * arithmetic**: on an uneven tree that lands on a level that does not exist and
 * silently reaches nobody. Walk `ancestorIds` instead, which is contiguous by
 * construction.
 */

import type { LatLng } from "./geo.js";
import {
  bboxesIntersect,
  COORD_EPS,
  isSimpleRing,
  makeWorkBudget,
  normalizeRing,
  polygonAreaAbs,
  polygonBbox,
  polygonContainsPolygon,
  ringsProperlyCross,
  SIMPLE_RING_MAX_VERTICES,
  type Bbox,
  type WorkBudget,
} from "./geoPolygon.js";

/** Above this region count the forest is not computed at all — see `truncated`. */
export const MAX_HIERARCHY_REGIONS = 500;

/** Ancestor-walk ceiling. Defense in depth: containment is provably acyclic. */
export const MAX_DEPTH = 32;

/**
 * How a region's level follows from its children's.
 *
 * Two readings exist because the operator's wording ("as soon as a polygon
 * contains more than 1 smaller polygon it is upgraded") and the requirement
 * that drives the feature (route front-line staff to a region and managers to
 * its container) disagree about a container holding exactly ONE region.
 */
export type LevelRule = (childLevels: number[]) => number;

/**
 * ANY container is strictly above its children. This is the default, because it
 * is the only reading where `level` implies containment rank — which is exactly
 * what "operators get the leaf, managers get the container" needs.
 *
 * Cost of this reading: a redundant wrapper someone draws around a single
 * division inflates every level above it by one.
 */
export const levelByDepth: LevelRule = (childLevels) =>
  childLevels.length > 0 ? Math.max(...childLevels) + 1 : 1;

/**
 * The operator's literal wording: a region is promoted only when it holds TWO
 * OR MORE regions at the same top child level.
 *
 * Kept, tested and selectable — but not the default, because it puts a
 * single-child wrapper at the SAME level as its child. Two nested regions both
 * reading L1 means level can no longer tell a front-line region from its
 * manager wrapper, and "the manager is one level up" stops being expressible
 * for that branch.
 */
export const levelByBranchingCount: LevelRule = (childLevels) => {
  if (childLevels.length === 0) return 1;
  const top = Math.max(...childLevels);
  const countAtTop = childLevels.filter((l) => l === top).length;
  return countAtTop >= 2 ? top + 1 : top;
};

export const DEFAULT_LEVEL_RULE: LevelRule = levelByDepth;

export interface RegionNode {
  id: string;
  /**
   * The immediate parent: the region's `nestUnderId` when that region really
   * contains it, otherwise the SMALLEST container. Null for a top-level region.
   */
  parentId: string | null;
  /**
   * Every region whose polygon contains this one, smallest first — the parents
   * an operator may choose between (`nestUnderId`). Empty for a region nothing
   * contains.
   */
  containerIds: string[];
  childIds: string[];
  /** Outermost first (root → parent). Empty for a top-level region. */
  ancestorIds: string[];
  /** 0 = top-level. Always gap-free. */
  depth: number;
  /** 1 = contains nothing. May have gaps across an uneven tree — see the header. */
  level: number;
  descendantCount: number;
}

export type RegionHierarchyWarningKind =
  | "overlap"
  | "duplicate"
  | "degenerate"
  | "self-intersecting"
  | "ambiguous-parent"
  | "approximate"
  | "cap-exceeded"
  | "nest-ignored";

export interface RegionHierarchyWarning {
  kind: RegionHierarchyWarningKind;
  regionId: string;
  /** The other region in a pairwise finding (overlap, duplicate). */
  otherRegionId?: string;
  message: string;
}

export interface RegionHierarchy {
  byId: Record<string, RegionNode>;
  /** Top-level region ids, largest first. */
  rootIds: string[];
  maxLevel: number;
  warnings: RegionHierarchyWarning[];
  /** True when the region count exceeded the cap and no nesting was computed. */
  truncated: boolean;
}

export interface RegionInput {
  id: string;
  polygon: LatLng[];
  /**
   * The operator's chosen parent among the regions that CONTAIN this one (the
   * Regions panel's drag-to-nest). Honoured only while that region's polygon
   * still contains this one — geometry stays the authority, so a preference
   * can pick between real containers but never invent a nesting. Otherwise
   * ignored (with a `nest-ignored` warning) and the smallest container wins.
   */
  nestUnderId?: string | null;
}

export interface BuildOptions {
  levelRule?: LevelRule;
  maxRegions?: number;
  budget?: WorkBudget;
}

interface Prepared {
  id: string;
  ring: LatLng[];
  bbox: Bbox;
  area: number;
}

/** Do two boxes describe the same rectangle? Distinguishes a genuine duplicate
 *  region from two regions that merely happen to enclose the same area. */
function sameBbox(a: Bbox, b: Bbox, eps: number = COORD_EPS): boolean {
  return (
    Math.abs(a.minLat - b.minLat) <= eps &&
    Math.abs(a.minLng - b.minLng) <= eps &&
    Math.abs(a.maxLat - b.maxLat) <= eps &&
    Math.abs(a.maxLng - b.maxLng) <= eps
  );
}

function flatHierarchy(regions: RegionInput[], warnings: RegionHierarchyWarning[], truncated: boolean): RegionHierarchy {
  const byId: Record<string, RegionNode> = {};
  for (const r of regions) {
    byId[r.id] = {
      id: r.id,
      parentId: null,
      childIds: [],
      containerIds: [],
      ancestorIds: [],
      depth: 0,
      level: 1,
      descendantCount: 0,
    };
  }
  return {
    byId,
    rootIds: regions.map((r) => r.id),
    maxLevel: regions.length > 0 ? 1 : 0,
    warnings,
    truncated,
  };
}

/**
 * Build the containment forest.
 *
 * Candidate pairs are iterated in area-descending (then id) order and each
 * unordered pair is tested exactly ONCE, with the larger ring as the candidate
 * container — a strictly-contained ring always has strictly smaller area, so
 * the other direction cannot be containment. That ordering is also what makes a
 * budget-degraded result deterministic.
 */
export function buildRegionHierarchy(regions: RegionInput[], opts: BuildOptions = {}): RegionHierarchy {
  const levelRule = opts.levelRule ?? DEFAULT_LEVEL_RULE;
  const maxRegions = opts.maxRegions ?? MAX_HIERARCHY_REGIONS;
  const warnings: RegionHierarchyWarning[] = [];

  if (regions.length === 0) return flatHierarchy(regions, warnings, false);

  if (regions.length > maxRegions) {
    warnings.push({
      kind: "cap-exceeded",
      regionId: "",
      message: `${regions.length} regions exceeds the ${maxRegions}-region nesting cap; levels were not computed`,
    });
    return flatHierarchy(regions, warnings, true);
  }

  const budget = opts.budget ?? makeWorkBudget();

  // Precompute once per region rather than per candidate pair.
  const prepared: Prepared[] = regions.map((r) => {
    const ring = normalizeRing(r.polygon);
    return { id: r.id, ring, bbox: polygonBbox(ring), area: polygonAreaAbs(ring) };
  });

  for (const p of prepared) {
    // Independent findings, deliberately NOT else-if: a symmetric bow tie has a
    // shoelace area that cancels to ~0, so it is both degenerate AND
    // self-intersecting, and the crossing is the more actionable of the two.
    if (p.ring.length < 3 || p.area <= 0) {
      warnings.push({
        kind: "degenerate",
        regionId: p.id,
        message: "Polygon has no area, so it can never contain another region",
      });
    }
    if (p.ring.length >= 3 && p.ring.length <= SIMPLE_RING_MAX_VERTICES && !isSimpleRing(p.ring)) {
      // Placed normally anyway: silently orphaning an operator's children
      // because they dragged a vertex across an edge is worse than a warning
      // they can see and fix.
      warnings.push({
        kind: "self-intersecting",
        regionId: p.id,
        message: "Polygon crosses itself; nesting for it may not be what you expect",
      });
    }
  }

  // Area desc, then id, so the whole build is input-order-insensitive.
  prepared.sort((a, b) => (b.area - a.area) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const containers = new Map<string, string[]>(); // child id → ids that contain it
  for (const p of prepared) containers.set(p.id, []);

  for (let i = 0; i < prepared.length; i++) {
    const outer = prepared[i]!;
    for (let j = i + 1; j < prepared.length; j++) {
      const inner = prepared[j]!;
      const rel = polygonContainsPolygon(outer.ring, inner.ring, {
        budget,
        outerBbox: outer.bbox,
        innerBbox: inner.bbox,
        outerArea: outer.area,
        innerArea: inner.area,
      });

      if (rel === "contains") {
        containers.get(inner.id)!.push(outer.id);
      } else if (rel === "approximate") {
        containers.get(inner.id)!.push(outer.id);
        warnings.push({
          kind: "approximate",
          regionId: inner.id,
          otherRegionId: outer.id,
          message: "Nesting was decided from bounding boxes because the geometry budget ran out",
        });
      } else if (rel === "equal-area" || rel === "overlaps") {
        // Neither is the other's parent. Which FINDING to report needs real
        // geometry, for two separate reasons:
        //
        //  - `equal-area` short-circuits before any geometric test, so on its
        //    own it cannot tell a genuine duplicate from two same-sized regions
        //    in different states (which must produce no warning at all) or from
        //    two same-sized regions that partly overlap.
        //  - `overlaps` only means "the bboxes met and it is not containment",
        //    which includes shapes that never actually touch — a child sitting
        //    in a concave parent's notch. A false overlap warning on every
        //    notch would train operators to ignore the real ones.
        //
        // A real edge crossing is the one signal worth reporting as overlap;
        // otherwise a shared bounding box plus no crossing means a duplicate.
        if (bboxesIntersect(outer.bbox, inner.bbox)) {
          const crosses = ringsProperlyCross(outer.ring, inner.ring, budget);
          if (crosses === true) {
            warnings.push({
              kind: "overlap",
              regionId: inner.id,
              otherRegionId: outer.id,
              message: "Regions partly overlap, so neither contains the other and both stay top-level",
            });
          } else if (rel === "equal-area" && sameBbox(outer.bbox, inner.bbox)) {
            warnings.push({
              kind: "duplicate",
              regionId: inner.id,
              otherRegionId: outer.id,
              message: "Two regions cover the same area, so neither can contain the other",
            });
          }
        }
      }
    }
  }

  // Immediate parent = the smallest container. Equal-area containers are
  // impossible here (they'd have compared "equal-area"), but a tie is still
  // handled rather than left to sort stability.
  const areaById = new Map(prepared.map((p) => [p.id, p.area]));
  const nestUnderById = new Map(regions.map((r) => [r.id, r.nestUnderId ?? null]));
  const byId: Record<string, RegionNode> = {};
  for (const p of prepared) {
    const list = containers.get(p.id)!;
    // Smallest first (then id), so containerIds[0] is the default parent.
    const containerIds = [...list].sort(
      (a, b) => (areaById.get(a)! - areaById.get(b)!) || (a < b ? -1 : a > b ? 1 : 0),
    );
    let parentId: string | null = null;
    const nestUnder = nestUnderById.get(p.id) ?? null;
    if (nestUnder && list.includes(nestUnder)) {
      // The operator's pick among real containers. No tie warning: the
      // ambiguity it would report is exactly what the pick resolved.
      parentId = nestUnder;
    } else if (nestUnder && areaById.has(nestUnder)) {
      // A pick that no longer contains it (a polygon was redrawn). Kept in
      // the blob — it applies again if the geometry comes back — but said out
      // loud, since the tree the operator arranged is not the one in force.
      warnings.push({
        kind: "nest-ignored",
        regionId: p.id,
        otherRegionId: nestUnder,
        message: "Chosen parent no longer contains this region, so the smallest containing region was used",
      });
    }
    if (parentId === null && list.length > 0) {
      let best = list[0]!;
      let tied = false;
      for (const cand of list.slice(1)) {
        const ca = areaById.get(cand)!;
        const ba = areaById.get(best)!;
        if (ca < ba) {
          best = cand;
          tied = false;
        } else if (ca === ba && cand !== best) {
          tied = true;
          if (cand < best) best = cand; // lowest id, so the choice is stable
        }
      }
      parentId = best;
      if (tied) {
        warnings.push({
          kind: "ambiguous-parent",
          regionId: p.id,
          otherRegionId: best,
          message: "Several containing regions are the same size; the lowest id was used as the parent",
        });
      }
    }
    byId[p.id] = {
      id: p.id,
      parentId,
      childIds: [],
      containerIds,
      ancestorIds: [],
      depth: 0,
      level: 1,
      descendantCount: 0,
    };
  }

  // childIds in the same area-desc order as `prepared`.
  for (const p of prepared) {
    const node = byId[p.id]!;
    if (node.parentId) byId[node.parentId]!.childIds.push(p.id);
  }

  const rootIds = prepared.filter((p) => !byId[p.id]!.parentId).map((p) => p.id);

  // ancestorIds + depth, walking up with a hard ceiling.
  for (const p of prepared) {
    const node = byId[p.id]!;
    const chain: string[] = [];
    const seen = new Set<string>([p.id]);
    let cur = node.parentId;
    while (cur && chain.length < MAX_DEPTH) {
      if (seen.has(cur)) break; // provably unreachable; not worth risking a hang
      seen.add(cur);
      chain.push(cur);
      cur = byId[cur]!.parentId;
    }
    chain.reverse(); // root → parent
    node.ancestorIds = chain;
    node.depth = chain.length;
  }

  // level: deepest first, so a node's children are already resolved.
  const byDepthDesc = [...prepared].sort((a, b) => byId[b.id]!.depth - byId[a.id]!.depth);
  for (const p of byDepthDesc) {
    const node = byId[p.id]!;
    node.level = levelRule(node.childIds.map((c) => byId[c]!.level));
    node.descendantCount = node.childIds.reduce(
      (sum, c) => sum + 1 + byId[c]!.descendantCount,
      0,
    );
  }

  let maxLevel = 0;
  for (const p of prepared) maxLevel = Math.max(maxLevel, byId[p.id]!.level);

  return { byId, rootIds, maxLevel, warnings, truncated: false };
}

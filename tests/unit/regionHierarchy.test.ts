/**
 * tests/unit/regionHierarchy.test.ts
 *
 * Derived region levels. Three cases here are load-bearing rather than routine:
 *
 *  - the single-child wrapper, pinned under BOTH level rules, so the decision
 *    behind `DEFAULT_LEVEL_RULE` is documented in executable form;
 *  - uneven nesting, which is the whole reason `RegionNode` carries `depth`
 *    alongside `level` — `level` has gaps there and routing must not use it;
 *  - input-order insensitivity, because the region blob has no stable order and
 *    a hierarchy that shifted between two reads would re-tier who gets paged.
 */

import { describe, it, expect } from "vitest";
import {
  buildRegionHierarchy,
  levelByBranchingCount,
  levelByDepth,
  MAX_HIERARCHY_REGIONS,
  type RegionInput,
} from "../../src/utils/regionHierarchy.js";
import { makeWorkBudget } from "../../src/utils/geoPolygon.js";
import type { LatLng } from "../../src/utils/geo.js";

function square(minLat: number, minLng: number, size: number): LatLng[] {
  return [
    [minLat, minLng],
    [minLat, minLng + size],
    [minLat + size, minLng + size],
    [minLat + size, minLng],
  ];
}

function region(id: string, minLat: number, minLng: number, size: number): RegionInput {
  return { id, polygon: square(minLat, minLng, size) };
}

/** Grandparent ⊃ parent ⊃ child, concentric. */
const NESTED_3: RegionInput[] = [
  region("state", 30, -90, 12),
  region("division", 33, -87, 6),
  region("city", 35, -85, 2),
];

describe("level rules", () => {
  it("levelByDepth promotes any container", () => {
    expect(levelByDepth([])).toBe(1);
    expect(levelByDepth([1])).toBe(2);
    expect(levelByDepth([1, 1])).toBe(2);
    expect(levelByDepth([1, 3])).toBe(4);
  });

  it("levelByBranchingCount promotes only on 2+ children at the top child level", () => {
    expect(levelByBranchingCount([])).toBe(1);
    expect(levelByBranchingCount([1])).toBe(1); // the collision this rule accepts
    expect(levelByBranchingCount([1, 1])).toBe(2);
    expect(levelByBranchingCount([1, 3])).toBe(3); // only one child at level 3
    expect(levelByBranchingCount([3, 3])).toBe(4);
  });
});

describe("buildRegionHierarchy — nesting", () => {
  it("derives levels, depths and ancestors for a 3-deep chain", () => {
    const h = buildRegionHierarchy(NESTED_3);
    expect(h.truncated).toBe(false);
    expect(h.rootIds).toEqual(["state"]);
    expect(h.maxLevel).toBe(3);

    expect(h.byId["city"]).toMatchObject({ parentId: "division", level: 1, depth: 2, descendantCount: 0 });
    expect(h.byId["division"]).toMatchObject({ parentId: "state", level: 2, depth: 1, descendantCount: 1 });
    expect(h.byId["state"]).toMatchObject({ parentId: null, level: 3, depth: 0, descendantCount: 2 });

    // Outermost first.
    expect(h.byId["city"]!.ancestorIds).toEqual(["state", "division"]);
    expect(h.byId["division"]!.ancestorIds).toEqual(["state"]);
    expect(h.byId["state"]!.ancestorIds).toEqual([]);
  });

  it("picks the SMALLEST container as the immediate parent, not just any container", () => {
    // "city" is inside both "division" and "state"; only division is its parent.
    const h = buildRegionHierarchy(NESTED_3);
    expect(h.byId["city"]!.parentId).toBe("division");
    expect(h.byId["division"]!.childIds).toEqual(["city"]);
    expect(h.byId["state"]!.childIds).toEqual(["division"]);
  });

  it("makes two siblings in one parent an L2 under both rules", () => {
    const regions = [
      region("south", 30, -90, 10),
      region("nashville", 32, -88, 2),
      region("memphis", 36, -84, 2),
    ];
    for (const levelRule of [levelByDepth, levelByBranchingCount]) {
      const h = buildRegionHierarchy(regions, { levelRule });
      expect(h.byId["south"]!.level).toBe(2);
      expect(h.byId["nashville"]!.level).toBe(1);
      expect(h.byId["memphis"]!.level).toBe(1);
      expect(h.byId["south"]!.childIds).toHaveLength(2);
    }
  });

  it("a SINGLE-child wrapper is L2 by default and L1 under the branching rule", () => {
    // The decision behind DEFAULT_LEVEL_RULE, in executable form. Under the
    // branching rule the wrapper collides with its own child at L1, which is
    // why it is not the default.
    const regions = [region("south", 30, -90, 10), region("nashville", 32, -88, 2)];

    const byDepth = buildRegionHierarchy(regions, { levelRule: levelByDepth });
    expect(byDepth.byId["south"]!.level).toBe(2);
    expect(byDepth.byId["nashville"]!.level).toBe(1);

    const byBranching = buildRegionHierarchy(regions, { levelRule: levelByBranchingCount });
    expect(byBranching.byId["south"]!.level).toBe(1);
    expect(byBranching.byId["nashville"]!.level).toBe(1);
    // Still genuinely nested either way — only the LABEL differs.
    expect(byBranching.byId["nashville"]!.parentId).toBe("south");
    expect(byBranching.byId["nashville"]!.depth).toBe(1);
  });

  it("UNEVEN nesting leaves gaps in level while depth stays contiguous", () => {
    // "south" holds a bare leaf and a 3-deep chain, so it is L4 with children
    // at L1 and L3 -- there is no L2 anywhere beneath it. This is exactly why
    // routing walks ancestorIds instead of doing level+1 arithmetic.
    const regions = [
      region("south", 0, 0, 40),
      region("bare-leaf", 1, 1, 2),
      region("mid", 10, 10, 20),
      region("inner", 12, 12, 10),
      region("innermost", 14, 14, 4),
    ];
    const h = buildRegionHierarchy(regions);

    expect(h.byId["south"]!.level).toBe(4);
    expect(h.byId["bare-leaf"]!.level).toBe(1);
    expect(h.byId["mid"]!.level).toBe(3);
    expect(h.byId["inner"]!.level).toBe(2);
    expect(h.byId["innermost"]!.level).toBe(1);

    // No region beneath "south" reports level 2 except via the chain branch...
    const levelsUnderSouth = ["bare-leaf", "mid", "inner", "innermost"].map((id) => h.byId[id]!.level);
    expect(levelsUnderSouth.sort()).toEqual([1, 1, 2, 3]);

    // ...while depth is gap-free from the root down each branch.
    expect(h.byId["bare-leaf"]!.depth).toBe(1);
    expect(h.byId["mid"]!.depth).toBe(1);
    expect(h.byId["inner"]!.depth).toBe(2);
    expect(h.byId["innermost"]!.depth).toBe(3);
    expect(h.byId["innermost"]!.ancestorIds).toEqual(["south", "mid", "inner"]);
  });

  it("is insensitive to input order", () => {
    const forward = buildRegionHierarchy(NESTED_3);
    const reversed = buildRegionHierarchy([...NESTED_3].reverse());
    expect(reversed).toEqual(forward);
  });

  it("lists every container, smallest first", () => {
    const h = buildRegionHierarchy(NESTED_3);
    expect(h.byId["city"]!.containerIds).toEqual(["division", "state"]);
    expect(h.byId["division"]!.containerIds).toEqual(["state"]);
    expect(h.byId["state"]!.containerIds).toEqual([]);
  });
});

describe("buildRegionHierarchy — nestUnderId (drag-to-nest)", () => {
  it("honours a chosen parent that really contains the region, and re-levels", () => {
    const input = NESTED_3.map((r) => (r.id === "city" ? { ...r, nestUnderId: "state" } : r));
    const h = buildRegionHierarchy(input);
    expect(h.byId["city"]!.parentId).toBe("state");
    expect(h.byId["city"]!.depth).toBe(1);
    expect(h.byId["city"]!.ancestorIds).toEqual(["state"]);
    // division lost its only child: L2 → L1; state still holds two L1s → L2.
    expect(h.byId["division"]!.level).toBe(1);
    expect(h.byId["state"]!.level).toBe(2);
    expect(h.byId["state"]!.childIds.sort()).toEqual(["city", "division"]);
    expect(h.warnings).toEqual([]);
  });

  it("ignores a chosen parent that does NOT contain the region, with a warning", () => {
    const input: RegionInput[] = [
      ...NESTED_3.map((r) => (r.id === "city" ? { ...r, nestUnderId: "elsewhere" } : r)),
      region("elsewhere", 0, 0, 5),
    ];
    const h = buildRegionHierarchy(input);
    expect(h.byId["city"]!.parentId).toBe("division");
    expect(h.warnings).toEqual([expect.objectContaining({ kind: "nest-ignored", regionId: "city", otherRegionId: "elsewhere" })]);
  });

  it("silently ignores a chosen parent that no longer exists", () => {
    const input = NESTED_3.map((r) => (r.id === "city" ? { ...r, nestUnderId: "gone" } : r));
    const h = buildRegionHierarchy(input);
    expect(h.byId["city"]!.parentId).toBe("division");
    expect(h.warnings).toEqual([]);
  });
});

describe("buildRegionHierarchy — degenerate and hostile input", () => {
  it("returns an empty hierarchy for no regions", () => {
    const h = buildRegionHierarchy([]);
    expect(h.rootIds).toEqual([]);
    expect(h.maxLevel).toBe(0);
    expect(h.warnings).toEqual([]);
  });

  it("leaves two identical polygons as siblings and warns", () => {
    const regions = [region("a", 10, 10, 5), region("b", 10, 10, 5)];
    const h = buildRegionHierarchy(regions);
    expect(h.byId["a"]!.parentId).toBeNull();
    expect(h.byId["b"]!.parentId).toBeNull();
    expect(h.rootIds).toHaveLength(2);
    expect(h.warnings.map((w) => w.kind)).toContain("duplicate");
  });

  it("says NOTHING about two same-sized regions that are nowhere near each other", () => {
    // Equal area short-circuits the geometry, so without a bbox check every
    // pair of same-sized regions in the fleet would be flagged a duplicate.
    const regions = [region("east", 0, 0, 5), region("west", 40, 40, 5)];
    const h = buildRegionHierarchy(regions);
    expect(h.warnings).toEqual([]);
    expect(h.rootIds).toHaveLength(2);
  });

  it("reports OVERLAP, not duplicate, for two same-sized regions that partly overlap", () => {
    const regions = [region("a", 0, 0, 10), region("b", 5, 5, 10)];
    const h = buildRegionHierarchy(regions);
    expect(h.warnings.map((w) => w.kind)).toEqual(["overlap"]);
  });

  it("warns on partial overlap and keeps both regions top-level", () => {
    const regions = [region("a", 0, 0, 10), region("b", 5, 5, 10)];
    const h = buildRegionHierarchy(regions);
    expect(h.byId["a"]!.parentId).toBeNull();
    expect(h.byId["b"]!.parentId).toBeNull();
    const overlap = h.warnings.find((w) => w.kind === "overlap");
    expect(overlap).toBeTruthy();
    expect([overlap!.regionId, overlap!.otherRegionId].sort()).toEqual(["a", "b"]);
  });

  it("does NOT warn about overlap for a child sitting in a concave parent's notch", () => {
    // The bboxes meet but the rings never cross. A warning here would fire on
    // every notch and train operators to ignore the real ones.
    const cParent: RegionInput = {
      id: "c",
      polygon: [
        [0, 0],
        [0, 4],
        [1, 4],
        [1, 2],
        [3, 2],
        [3, 4],
        [4, 4],
        [4, 0],
      ],
    };
    const inNotch: RegionInput = {
      id: "notch",
      polygon: [
        [1.5, 2.5],
        [1.5, 3.5],
        [2.5, 3.5],
        [2.5, 2.5],
      ],
    };
    const h = buildRegionHierarchy([cParent, inNotch]);
    expect(h.warnings.filter((w) => w.kind === "overlap")).toEqual([]);
    expect(h.byId["notch"]!.parentId).toBeNull();
  });

  it("flags a zero-area region and never makes it a parent", () => {
    const line: RegionInput = { id: "line", polygon: [[0, 0], [0, 5], [0, 10]] };
    const h = buildRegionHierarchy([line, region("inside", 1, 1, 2)]);
    expect(h.warnings.some((w) => w.kind === "degenerate" && w.regionId === "line")).toBe(true);
    for (const id of Object.keys(h.byId)) expect(h.byId[id]!.parentId).not.toBe("line");
  });

  it("flags a self-intersecting ring but still places it", () => {
    const bowTie: RegionInput = { id: "bow", polygon: [[0, 0], [4, 4], [0, 4], [4, 0]] };
    const h = buildRegionHierarchy([bowTie]);
    expect(h.warnings.some((w) => w.kind === "self-intersecting" && w.regionId === "bow")).toBe(true);
    expect(h.byId["bow"]).toBeTruthy();
    expect(h.byId["bow"]!.level).toBe(1);
  });

  it("goes flat with a cap-exceeded warning above the region cap", () => {
    const many: RegionInput[] = [];
    for (let i = 0; i < MAX_HIERARCHY_REGIONS + 1; i++) many.push(region("r" + i, i * 0.001, 0, 0.0005));
    const h = buildRegionHierarchy(many);
    expect(h.truncated).toBe(true);
    expect(h.maxLevel).toBe(1);
    expect(h.rootIds).toHaveLength(many.length);
    expect(h.warnings.map((w) => w.kind)).toEqual(["cap-exceeded"]);
  });

  it("degrades to bbox nesting with an approximate warning when the budget runs out", () => {
    const h = buildRegionHierarchy(NESTED_3, { budget: makeWorkBudget(1) });
    expect(h.warnings.some((w) => w.kind === "approximate")).toBe(true);
    // Still produced a usable forest rather than throwing or hanging.
    expect(h.byId["city"]!.parentId).toBe("division");
  });

  it("respects a caller-supplied maxRegions", () => {
    const h = buildRegionHierarchy(NESTED_3, { maxRegions: 2 });
    expect(h.truncated).toBe(true);
  });
});

describe("buildRegionHierarchy — scale", () => {
  it("builds 200 regions of 200 vertices within a generous bound", () => {
    // A guard against an O(N^2 * V^2) regression, not a benchmark.
    const regions: RegionInput[] = [];
    for (let i = 0; i < 200; i++) {
      const ring: LatLng[] = [];
      const cx = (i % 20) * 2;
      const cy = Math.floor(i / 20) * 2;
      for (let v = 0; v < 200; v++) {
        const t = (v / 200) * Math.PI * 2;
        ring.push([cy + Math.sin(t) * 0.4, cx + Math.cos(t) * 0.4]);
      }
      regions.push({ id: "r" + i, polygon: ring });
    }
    const started = process.hrtime.bigint();
    const h = buildRegionHierarchy(regions);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(h.truncated).toBe(false);
    expect(ms).toBeLessThan(4000);
  });
});

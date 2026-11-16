/**
 * tests/unit/regionHierarchyService.test.ts — CQ-T010 own suite for
 * src/services/regionHierarchyService.ts (business rules 54 / 58).
 *
 * tests/unit/regionLevelRouting.test.ts already walks the asset-relative
 * levels over a hand-built index. This suite adds `regionLevelIndex` (built
 * from a mocked `mapRegionService.getRegionHierarchy`), the key normalization
 * (prefix + case + whitespace), the level-argument guards, the rule 58
 * abstention through `orphanedRegionTags`, and the hop ceiling of the
 * "Level 1 excludes containers the asset also carries" check.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

const hier = vi.hoisted(() => ({ getRegionHierarchy: vi.fn() }));
vi.mock("../../src/services/mapRegionService.js", () => ({ getRegionHierarchy: hier.getRegionHierarchy }));

import {
  regionLevelIndex,
  deviceRegionsAtLevels,
  orphanedRegionTags,
  MAX_DEVICE_REGION_LEVELS,
  type RegionLevelIndex,
} from "../../src/services/regionHierarchyService.js";

type Node = { parentId: string | null; level: number };

function catalogue(regions: Array<{ id: string; name: string; parentId?: string | null; level?: number }>, maxLevel: number) {
  const byId: Record<string, Node> = {};
  for (const r of regions) byId[r.id] = { parentId: r.parentId ?? null, level: r.level ?? 1 };
  hier.getRegionHierarchy.mockResolvedValue({
    regions: regions.map((r) => ({ id: r.id, name: r.name })),
    hierarchy: { byId, maxLevel },
  });
}

/** Build an index straight from `name → parentName` (level is display-only). */
function index(pairs: Array<[string, string | null]>): RegionLevelIndex {
  return {
    byName: new Map(pairs.map(([name, parentName]) => [name.toLowerCase(), { name, parentName, level: 1 }])),
    maxLevel: pairs.length,
  };
}

/** A straight chain R0 ⊃ R1 ⊃ … ⊃ R(n-1); R(n-1) is the leaf. */
function chain(n: number): RegionLevelIndex {
  const pairs: Array<[string, string | null]> = [];
  for (let i = 0; i < n; i++) pairs.push([`R${i}`, i === 0 ? null : `R${i - 1}`]);
  return index(pairs);
}

beforeEach(() => {
  hier.getRegionHierarchy.mockReset();
});

describe("MAX_DEVICE_REGION_LEVELS", () => {
  it("is re-exported from notificationTypes (one ceiling, not a second copy)", async () => {
    const nt = await import("../../src/services/notificationTypes.js");
    expect(MAX_DEVICE_REGION_LEVELS).toBe(nt.MAX_DEVICE_REGION_LEVELS);
    expect(MAX_DEVICE_REGION_LEVELS).toBeGreaterThanOrEqual(1);
  });
});

describe("regionLevelIndex", () => {
  it("keys by the lower-cased name and resolves each region's parent NAME and global level", async () => {
    catalogue([
      { id: "s", name: "South", level: 3 },
      { id: "m", name: "Memphis", parentId: "s", level: 2 },
      { id: "b", name: "Bartlett", parentId: "m", level: 1 },
    ], 3);
    const ix = await regionLevelIndex();
    expect(ix.maxLevel).toBe(3);
    expect(ix.byName.get("south")).toEqual({ name: "South", parentName: null, level: 3 });
    expect(ix.byName.get("memphis")).toEqual({ name: "Memphis", parentName: "South", level: 2 });
    expect(ix.byName.get("bartlett")).toEqual({ name: "Bartlett", parentName: "Memphis", level: 1 });
  });

  it("strips a region: prefix and trailing whitespace from the stored name's key", async () => {
    catalogue([{ id: "x", name: "Region:Nashville " }, { id: "y", name: " Memphis" }], 1);
    const ix = await regionLevelIndex();
    expect([...ix.byName.keys()]).toEqual(["nashville", "memphis"]);
  });

  it("strips the prefix BEFORE trimming, so a leading-space prefix survives in the key", async () => {
    // Asset tags are trimmed on write, so this shape should not occur; pinned
    // so a reorder of strip/trim is a visible change.
    catalogue([{ id: "x", name: " region:Nashville" }], 1);
    const ix = await regionLevelIndex();
    expect([...ix.byName.keys()]).toEqual(["region:nashville"]);
  });

  it("a region missing from the hierarchy reads as top-level at level 1", async () => {
    hier.getRegionHierarchy.mockResolvedValue({ regions: [{ id: "x", name: "Orphan" }], hierarchy: { byId: {}, maxLevel: 0 } });
    const ix = await regionLevelIndex();
    expect(ix.byName.get("orphan")).toEqual({ name: "Orphan", parentName: null, level: 1 });
  });

  it("a parent id naming no region reads as no parent", async () => {
    catalogue([{ id: "x", name: "Child", parentId: "deleted" }], 2);
    const ix = await regionLevelIndex();
    expect(ix.byName.get("child")!.parentName).toBeNull();
  });

  it("maxLevel is at least 1 (an empty catalogue reports 0 from the hierarchy)", async () => {
    catalogue([], 0);
    const ix = await regionLevelIndex();
    expect(ix.maxLevel).toBe(1);
    expect(ix.byName.size).toBe(0);
  });

  it("reads the hierarchy every call — no second cache here", async () => {
    catalogue([{ id: "a", name: "A" }], 1);
    await regionLevelIndex();
    await regionLevelIndex();
    expect(hier.getRegionHierarchy).toHaveBeenCalledTimes(2);
  });
});

const IX = index([
  ["South", null],
  ["Nashville", "South"],
  ["Memphis", "South"],
  ["Bartlett", "Memphis"],
  ["Elsewhere", null],
]);

describe("orphanedRegionTags", () => {
  it("returns the tags naming no region, in the caller's spelling", () => {
    expect(orphanedRegionTags(["region:Nashville", "region:Old-Site", "Gone"], IX)).toEqual(["region:Old-Site", "Gone"]);
  });

  it("matches case-, prefix- and whitespace-blind", () => {
    expect(orphanedRegionTags(["REGION:nashville ", " south", "Region:MEMPHIS"], IX)).toEqual([]);
  });

  it("reports an orphan once however it is spelled, and ignores blanks", () => {
    expect(orphanedRegionTags(["Gone", "gone", "region:GONE", "", "region:"], IX)).toEqual(["Gone"]);
  });

  it("is empty for undefined / empty input", () => {
    expect(orphanedRegionTags(undefined, IX)).toEqual([]);
    expect(orphanedRegionTags([], IX)).toEqual([]);
  });
});

describe("deviceRegionsAtLevels — argument guards", () => {
  it("returns [] for no levels, undefined levels, or only out-of-range / non-integer levels", () => {
    expect(deviceRegionsAtLevels(["Nashville"], [], IX)).toEqual([]);
    expect(deviceRegionsAtLevels(["Nashville"], undefined, IX)).toEqual([]);
    expect(deviceRegionsAtLevels(["Nashville"], [0, -1, 1.5, MAX_DEVICE_REGION_LEVELS + 1, Number.NaN], IX)).toEqual([]);
  });

  it("ignores the invalid levels beside a valid one", () => {
    expect(deviceRegionsAtLevels(["Nashville", "South"], [0, 2, 99], IX)).toEqual(["South"]);
  });

  it("returns [] for an asset with no region tags", () => {
    expect(deviceRegionsAtLevels(undefined, [1], IX)).toEqual([]);
    expect(deviceRegionsAtLevels([], [1], IX)).toEqual([]);
    expect(deviceRegionsAtLevels(["", "region:"], [1], IX)).toEqual([]);
  });
});

describe("deviceRegionsAtLevels — routing", () => {
  it("matches the asset's prefixed, odd-cased tags and returns the STORED names", () => {
    expect(deviceRegionsAtLevels(["region:NASHVILLE", "region:south"], [1, 2], IX)).toEqual(["Nashville", "South"]);
  });

  it("a duplicated tag is counted once", () => {
    expect(deviceRegionsAtLevels(["Bartlett", "bartlett", "region:Bartlett"], [1], IX)).toEqual(["Bartlett"]);
  });

  it("walks the containment edges when the container's tag is not in the snapshot", () => {
    expect(deviceRegionsAtLevels(["Bartlett"], [2, 3], IX)).toEqual(["Memphis", "South"]);
  });

  it("a level beyond the root reaches nobody", () => {
    expect(deviceRegionsAtLevels(["Nashville"], [3], IX)).toEqual([]);
  });

  it("two unrelated leaves are both level 1; their shared parent appears once at level 2", () => {
    expect(deviceRegionsAtLevels(["Nashville", "Bartlett"], [1], IX)).toEqual(["Nashville", "Bartlett"]);
    expect(deviceRegionsAtLevels(["Nashville", "Bartlett"], [2], IX)).toEqual(["South", "Memphis"]);
    expect(deviceRegionsAtLevels(["Nashville", "Memphis"], [2], IX)).toEqual(["South"]);
  });

  it("a region reached at two levels is emitted once, at the first", () => {
    // Nashville's L2 is South; Bartlett's L3 is South.
    expect(deviceRegionsAtLevels(["Nashville", "Bartlett"], [2, 3], IX)).toEqual(["South", "Memphis"]);
  });

  it("rule 58: one orphaned tag makes EVERY level abstain", () => {
    expect(deviceRegionsAtLevels(["Bartlett", "Memphis", "South", "Retired-Site"], [1, 2, 3], IX)).toEqual([]);
  });

  it("walks the full MAX_DEVICE_REGION_LEVELS levels on a chain that deep", () => {
    const ix = chain(MAX_DEVICE_REGION_LEVELS);
    const leaf = `R${MAX_DEVICE_REGION_LEVELS - 1}`;
    expect(deviceRegionsAtLevels([leaf], [MAX_DEVICE_REGION_LEVELS], ix)).toEqual(["R0"]);
  });

  it("a fully reconciled asset on a chain within the ceiling resolves L1 to the leaf", () => {
    const ix = chain(MAX_DEVICE_REGION_LEVELS + 1);
    const tags = Array.from({ length: MAX_DEVICE_REGION_LEVELS + 1 }, (_, i) => `R${i}`);
    expect(deviceRegionsAtLevels(tags, [1], ix)).toEqual([`R${MAX_DEVICE_REGION_LEVELS}`]);
  });

  it("a fully reconciled asset on a chain deeper than the ceiling still resolves L1 to the leaf (each hop is checked from its child)", () => {
    const n = MAX_DEVICE_REGION_LEVELS + 4;
    const ix = chain(n);
    const tags = Array.from({ length: n }, (_, i) => `R${i}`);
    expect(deviceRegionsAtLevels(tags, [1], ix)).toEqual([`R${n - 1}`]);
  });

  it("a carried container within the hop ceiling is excluded from level 1 even with the middle tags missing", () => {
    const n = MAX_DEVICE_REGION_LEVELS + 1;
    const ix = chain(n);
    expect(deviceRegionsAtLevels(["R0", `R${n - 1}`], [1], ix)).toEqual([`R${n - 1}`]);
  });

  // BUG: isAncestorOfAny stops its upward walk after MAX_DEVICE_REGION_LEVELS
  // + 1 hops, but region nesting (polygon containment, mapRegionService) has
  // no depth cap. On a chain R0 ⊃ R1 ⊃ … ⊃ R11, an asset whose snapshot holds
  // only the leaf R11 and the top R0 (the intermediate tags one reconcile
  // behind — the case the contract says the walk must tolerate) gets R0, 11
  // hops up, reported at level 1 beside the leaf: [1] → ["R0", "R11"].
  // Expected ["R11"]: level 1 excludes every container the asset carries.
  it.fails("level 1 excludes a carried container more than MAX_DEVICE_REGION_LEVELS hops above the leaf", () => {
    const n = MAX_DEVICE_REGION_LEVELS + 4;
    const ix = chain(n);
    expect(deviceRegionsAtLevels(["R0", `R${n - 1}`], [1], ix)).toEqual([`R${n - 1}`]);
  });
});

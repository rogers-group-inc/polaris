/**
 * tests/unit/regionLevelRouting.test.ts
 *
 * `deviceRegionsAtLevels` — which regions an alert routes to at each
 * ASSET-RELATIVE level (1 = the device's own innermost region, 2 = the division
 * containing it, …).
 *
 * The two cases that justify the whole design:
 *
 *  - UNEVEN NESTING. Global levels have gaps, so a device in a shallow branch
 *    and a device in a deep one would resolve "L2" to different KINDS of thing
 *    — or to nobody. Asset-relative ranking is contiguous for both.
 *  - A PARENT MISSING FROM THE SNAPSHOT. Region tags are applied per region by
 *    the reconciler, so a containing division's tag can be one pass behind. The
 *    walk follows containment EDGES, not the snapshot, so an escalation still
 *    finds the manager.
 */

import { describe, it, expect } from "vitest";
import {
  deviceRegionsAtLevels,
  orphanedRegionTags,
  MAX_DEVICE_REGION_LEVELS,
  type RegionLevelIndex,
} from "../../src/services/regionHierarchyService.js";

/** Build an index from `name -> parentName` pairs. `level` is display-only here. */
function index(pairs: Array<[string, string | null]>): RegionLevelIndex {
  const byName = new Map(
    pairs.map(([name, parentName]) => [name.toLowerCase(), { name, parentName, level: 1 }]),
  );
  return { byName, maxLevel: pairs.length };
}

/** South ⊃ { Nashville, Memphis ⊃ Bartlett }; Elsewhere is unrelated. */
const IX = index([
  ["South", null],
  ["Nashville", "South"],
  ["Memphis", "South"],
  ["Bartlett", "Memphis"],
  ["Elsewhere", null],
]);

describe("deviceRegionsAtLevels", () => {
  it("resolves L1 to the device's own innermost region, not the division", () => {
    // A reconciled asset carries BOTH tags; the leaf is the specific one.
    expect(deviceRegionsAtLevels(["Nashville", "South"], [1], IX)).toEqual(["Nashville"]);
  });

  it("resolves L2 to the region one step out", () => {
    expect(deviceRegionsAtLevels(["Nashville", "South"], [2], IX)).toEqual(["South"]);
  });

  it("walks several levels out", () => {
    expect(deviceRegionsAtLevels(["Bartlett", "Memphis", "South"], [1], IX)).toEqual(["Bartlett"]);
    expect(deviceRegionsAtLevels(["Bartlett", "Memphis", "South"], [2], IX)).toEqual(["Memphis"]);
    expect(deviceRegionsAtLevels(["Bartlett", "Memphis", "South"], [3], IX)).toEqual(["South"]);
  });

  it("returns several levels at once, deduped", () => {
    expect(deviceRegionsAtLevels(["Bartlett"], [1, 2, 3], IX)).toEqual(["Bartlett", "Memphis", "South"]);
  });

  it("finds the parent even when the parent's tag is MISSING from the snapshot", () => {
    // The reconciler tags each region independently, so a division's tag can be
    // one pass behind. Routing follows the containment edges instead.
    expect(deviceRegionsAtLevels(["Nashville"], [2], IX)).toEqual(["South"]);
    expect(deviceRegionsAtLevels(["Bartlett"], [3], IX)).toEqual(["South"]);
  });

  it("handles UNEVEN nesting contiguously for both branches", () => {
    // Nashville is a bare leaf of South; Bartlett is two deep. Global levels
    // would be South=3, Memphis=2, Nashville=1, Bartlett=1 — so a device in
    // Nashville has no global L2 at all. Asset-relative, both branches have one.
    expect(deviceRegionsAtLevels(["Nashville"], [2], IX)).toEqual(["South"]);
    expect(deviceRegionsAtLevels(["Bartlett"], [2], IX)).toEqual(["Memphis"]);
    // ...and neither branch silently resolves to nothing.
    expect(deviceRegionsAtLevels(["Nashville"], [2], IX).length).toBeGreaterThan(0);
    expect(deviceRegionsAtLevels(["Bartlett"], [2], IX).length).toBeGreaterThan(0);
  });

  it("stops at the top rather than wrapping or repeating", () => {
    expect(deviceRegionsAtLevels(["Nashville"], [3], IX)).toEqual([]);
    expect(deviceRegionsAtLevels(["South"], [2], IX)).toEqual([]);
  });

  it("accepts a `region:`-prefixed snapshot and matches case-insensitively", () => {
    expect(deviceRegionsAtLevels(["region:nashville"], [2], IX)).toEqual(["South"]);
    expect(deviceRegionsAtLevels(["NASHVILLE"], [1], IX)).toEqual(["Nashville"]);
  });

  it("returns the STORED casing, which is what user region tags are matched against", () => {
    expect(deviceRegionsAtLevels(["region:SOUTH"], [1], IX)).toEqual(["South"]);
  });

  it("handles a device in two unrelated regions by returning both branches", () => {
    expect(deviceRegionsAtLevels(["Nashville", "Elsewhere"], [1], IX).sort()).toEqual(["Elsewhere", "Nashville"]);
    // Elsewhere is top-level, so only Nashville's branch has a level 2.
    expect(deviceRegionsAtLevels(["Nashville", "Elsewhere"], [2], IX)).toEqual(["South"]);
  });

  it("dedupes when two sibling regions share one parent", () => {
    expect(deviceRegionsAtLevels(["Nashville", "Memphis"], [2], IX)).toEqual(["South"]);
  });

  it("ABSTAINS when any tag is outside the catalogue, rather than ranking the rest", () => {
    // Business rule 58, and the incident behind it. Before this, the orphaned
    // leaf was dropped and the ranking computed over what remained — so
    // ["South", "Atlantis"] resolved L1 to "South" and the automation paged the
    // DIVISION while the site's own people heard nothing. Prod ran that way on
    // 3,587 assets under a dead region name.
    expect(deviceRegionsAtLevels(["Atlantis"], [1], IX)).toEqual([]);
    expect(deviceRegionsAtLevels(["South", "Atlantis"], [1], IX)).toEqual([]);
    expect(deviceRegionsAtLevels(["Atlantis", "Nashville"], [1], IX)).toEqual([]);
    // Every level, not just the one the leaf would have occupied.
    expect(deviceRegionsAtLevels(["Atlantis", "Nashville"], [1, 2, 3], IX)).toEqual([]);
  });

  it("still resolves normally when every tag is in the catalogue", () => {
    // The abstention must not cost the ordinary case anything.
    expect(deviceRegionsAtLevels(["Nashville", "South"], [1], IX)).toEqual(["Nashville"]);
  });

  it("returns nothing for empty or absent input", () => {
    expect(deviceRegionsAtLevels([], [1], IX)).toEqual([]);
    expect(deviceRegionsAtLevels(undefined, [1], IX)).toEqual([]);
    expect(deviceRegionsAtLevels(["Nashville"], [], IX)).toEqual([]);
    expect(deviceRegionsAtLevels(["Nashville"], undefined, IX)).toEqual([]);
  });

  it("ignores levels outside the supported range instead of throwing", () => {
    expect(deviceRegionsAtLevels(["Nashville"], [0, -3, 1.5], IX)).toEqual([]);
    expect(deviceRegionsAtLevels(["Nashville"], [MAX_DEVICE_REGION_LEVELS + 1], IX)).toEqual([]);
  });

  it("does not loop forever if the catalogue somehow describes a cycle", () => {
    const cyclic = index([["A", "B"], ["B", "A"]]);
    // Both are 'ancestors' of each other, so the innermost filter finds nothing
    // and falls back to the present set rather than hanging or throwing.
    expect(() => deviceRegionsAtLevels(["A"], [1, 2, 3], cyclic)).not.toThrow();
  });

  it("treats a duplicated snapshot tag once", () => {
    expect(deviceRegionsAtLevels(["Nashville", "region:Nashville", "NASHVILLE"], [1], IX)).toEqual(["Nashville"]);
  });
});

describe("orphanedRegionTags", () => {
  it("names the tags that match no region", () => {
    expect(orphanedRegionTags(["Nashville", "Atlantis"], IX)).toEqual(["Atlantis"]);
  });

  it("is empty when every tag is in the catalogue", () => {
    expect(orphanedRegionTags(["Nashville", "South"], IX)).toEqual([]);
    expect(orphanedRegionTags([], IX)).toEqual([]);
    expect(orphanedRegionTags(undefined, IX)).toEqual([]);
  });

  it("matches the prefix/case rules the rest of region routing uses", () => {
    expect(orphanedRegionTags(["region:NASHVILLE"], IX)).toEqual([]);
  });

  it("reports the operator's own spelling, so a log line is searchable", () => {
    // The caller prints this into a warning; normalizing it would hand the
    // operator a string that appears nowhere in their data.
    expect(orphanedRegionTags(["region:Middle Tenneessee"], IX)).toEqual(["region:Middle Tenneessee"]);
  });

  it("reports each distinct tag once", () => {
    expect(orphanedRegionTags(["Atlantis", "ATLANTIS", "region:Atlantis"], IX)).toEqual(["Atlantis"]);
  });
});

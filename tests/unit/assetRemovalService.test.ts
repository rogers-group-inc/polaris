/**
 * tests/unit/assetRemovalService.test.ts — business rule 156, the pure half:
 * how a list of asset ids is re-pointed or pruned, and when pruning must be
 * refused because an empty list would mean "every device".
 *
 * The database half is tests/integration/assetRemoval.test.ts.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));
vi.mock("../../src/services/appMapDiscoveryService.js", () => ({ getConfig: vi.fn(), saveConfig: vi.fn() }));

import { repointIdList, pruneIdList, pruneMayWiden, afterAssetsDeleted, afterAssetMerged } from "../../src/services/assetRemovalService.js";
import { scanVisibleTo } from "../../src/services/networkScanService.js";

describe("repointIdList", () => {
  it("replaces the absorbed id with the survivor's, in place", () => {
    expect(repointIdList(["a", "ghost", "b"], "ghost", "keep")).toEqual(["a", "keep", "b"]);
  });
  it("does not list the survivor twice when both were pinned", () => {
    expect(repointIdList(["keep", "a", "ghost"], "ghost", "keep")).toEqual(["keep", "a"]);
    expect(repointIdList(["ghost", "keep"], "ghost", "keep")).toEqual(["keep"]);
  });
  it("leaves a list that never named the absorbed id alone", () => {
    expect(repointIdList(["a", "b"], "ghost", "keep")).toEqual(["a", "b"]);
  });
});

describe("pruneIdList", () => {
  it("drops every deleted id and keeps the order of the rest", () => {
    expect(pruneIdList(["a", "x", "b", "y"], new Set(["x", "y"]))).toEqual(["a", "b"]);
    expect(pruneIdList(["x"], new Set(["x"]))).toEqual([]);
  });
});

describe("pruneMayWiden — an empty list can mean 'everything'", () => {
  it("is true only when pruning would empty a list that had something in it", () => {
    expect(pruneMayWiden(["x"], new Set(["x"]))).toBe(true);
    expect(pruneMayWiden(["x", "y"], new Set(["x", "y", "z"]))).toBe(true);
    expect(pruneMayWiden(["x", "a"], new Set(["x"]))).toBe(false);
    // Already empty: nothing to widen.
    expect(pruneMayWiden([], new Set(["x"]))).toBe(false);
  });
});

describe("the entry points with nothing to do", () => {
  it("touch nothing for an empty delete or a self-merge", async () => {
    expect(await afterAssetsDeleted([])).toMatchObject({ pathChecks: 0, stateRows: 0 });
    expect(await afterAssetMerged("a", "a")).toMatchObject({ pathChecks: 0, stateRows: 0 });
    expect(await afterAssetMerged("", "a")).toMatchObject({ pathChecks: 0 });
  });
  it("never throw — a failed clean-up is logged, the delete already happened", async () => {
    // The mocked prisma has no models, so the first read throws.
    expect(await afterAssetsDeleted(["a"])).toBeNull();
    expect(await afterAssetMerged("a", "b")).toBeNull();
  });
});

describe("rule 156(d): a private Discovery with no owner", () => {
  const orphan = { ownerId: null, visibility: "private" };
  const someoneElses = { ownerId: "u2", visibility: "private" };

  it("is visible to nobody without the housekeeping level — as before", () => {
    expect(scanVisibleTo(orphan, "u1")).toBe(false);
    expect(scanVisibleTo(orphan, null)).toBe(false);
  });
  it("is visible to the housekeeping level, so it can be republished or deleted", () => {
    expect(scanVisibleTo(orphan, "u1", true)).toBe(true);
    expect(scanVisibleTo(orphan, null, true)).toBe(true);
  });
  it("never opens a private Discovery that still has an owner", () => {
    expect(scanVisibleTo(someoneElses, "u1", true)).toBe(false);
    expect(scanVisibleTo(someoneElses, "u2", false)).toBe(true);
  });
});

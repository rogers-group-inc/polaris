/**
 * tests/unit/mapRegionTagPrefixGuard.test.ts
 *
 * `assertAddedRegionTagsNameARegion` — the asset-write half of reserving the
 * `region:` prefix (the registry half is `assertNotRegionPrefix` in
 * serverSettings.ts, covered by tests/integration/tagFilterRoutes.test.ts).
 *
 * It is a DIFF rather than a ban on the prefix, and the three cases it has to
 * tell apart are what these tests are about:
 *
 *   - A region tag already on the row is untouched. The asset edit modal PUTs
 *     the whole `tags` array back, so banning the prefix outright would make
 *     every asset in a region unsaveable — the most obvious way to get this
 *     wrong, and invisible until someone edits a tagged device.
 *   - ADDING a live region's tag by hand stays legal. Tagging a device the
 *     polygon does not cover is documented behavior that survives every
 *     reconcile, so the test is "does a region answer to this name", not "did
 *     the map put it here".
 *   - Adding a tag naming NO region is refused. That string is maintained by
 *     nothing, renders like a real region tag, and is indistinguishable from
 *     one stranded by a half-applied rename — the ambiguity business rule 54
 *     has to design around.
 *
 * The last test pins the scale property: a write that adds no region tag must
 * not read the region blob at all. Bulk edit is N of these, one per row.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const store = {
  regions: [] as unknown[],
};

const settingFindUnique = vi.fn(async () => ({
  value: store.regions.map((r) => ({ ...(r as object) })),
  updatedAt: new Date("2026-09-14T00:00:00Z"),
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: { findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    subnet: { findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    setting: { findUnique: settingFindUnique, upsert: vi.fn(async () => ({})) },
    tag: { upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 0 })) },
    regionTagAssignment: {
      findMany: vi.fn(async () => []),
      createMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: vi.fn(async (arg: any) => (typeof arg === "function" ? arg({}) : Promise.all(arg))),
  },
}));

const { assertAddedRegionTagsNameARegion } = await import("../../src/services/mapRegionService.js");

const REGION = {
  id: "region-1",
  name: "Middle Tennessee",
  polygon: [[40.65, -74.08], [40.65, -73.93], [40.8, -73.93]],
  color: "#4fc3f7",
  createdBy: "test",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

beforeEach(() => {
  store.regions = [REGION];
  vi.clearAllMocks();
});

describe("assertAddedRegionTagsNameARegion", () => {
  it("lets an existing region tag round-trip, even when it names no region", async () => {
    // THE case that would break every asset edit if this were a blanket ban:
    // a device carrying a tag stranded by a half-applied rename must still be
    // saveable. Cleaning that tag up is the sweep's job, not the edit form's.
    await expect(
      assertAddedRegionTagsNameARegion(
        ["region:Eastern Middle Tennessee", "role:app"],
        ["region:Eastern Middle Tennessee", "role:db"],
      ),
    ).resolves.toBeUndefined();
  });

  it("allows hand-applying a LIVE region's tag to a device the polygon misses", async () => {
    await expect(
      assertAddedRegionTagsNameARegion([], ["region:Middle Tennessee"]),
    ).resolves.toBeUndefined();
  });

  it("matches a live region case-insensitively", async () => {
    await expect(
      assertAddedRegionTagsNameARegion([], ["REGION:middle tennessee"]),
    ).resolves.toBeUndefined();
  });

  it("refuses a newly added tag naming no region", async () => {
    await expect(
      assertAddedRegionTagsNameARegion(["role:app"], ["role:app", "region:Narnia"]),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("names every offending tag in the message", async () => {
    await expect(
      assertAddedRegionTagsNameARegion([], ["region:Narnia", "region:Gondor", "role:app"]),
    ).rejects.toThrow(/"region:Narnia", "region:Gondor"/);
  });

  it("refuses the unknown one while a live one in the same write is fine", async () => {
    await expect(
      assertAddedRegionTagsNameARegion([], ["region:Middle Tennessee", "region:Narnia"]),
    ).rejects.toThrow(/Narnia/);
  });

  it("ignores a region tag being REMOVED", async () => {
    await expect(
      assertAddedRegionTagsNameARegion(["region:Narnia", "role:app"], ["role:app"]),
    ).resolves.toBeUndefined();
  });

  it("does not read the region blob when no region tag was added", async () => {
    // The scale property: nearly every asset write, and every bulk edit that
    // does not touch regions, must cost zero extra queries.
    await assertAddedRegionTagsNameARegion(["role:app"], ["role:app", "site:nash", "owner:ops"]);
    expect(settingFindUnique).not.toHaveBeenCalled();
  });

  it("does not read the region blob when the only region tag was already there", async () => {
    await assertAddedRegionTagsNameARegion(["region:Middle Tennessee"], ["region:Middle Tennessee", "role:db"]);
    expect(settingFindUnique).not.toHaveBeenCalled();
  });
});

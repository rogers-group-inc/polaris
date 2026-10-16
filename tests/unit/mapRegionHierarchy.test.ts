/**
 * tests/unit/mapRegionHierarchy.test.ts
 *
 * The service half of derived region levels: the decorated read projection, the
 * version-keyed cache, and the level-shift diff that backs the audit trail.
 *
 * The load-bearing assertion is "the blob never gains derived fields". Levels
 * are derived precisely so there is ONE source of truth; a write path that
 * round-tripped a decorated object back through persistAll would put a stale
 * `level` into the Setting where nothing recomputes to contradict it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

interface SettingRow {
  key: string;
  value: unknown;
  updatedAt: Date;
}

const store = {
  settings: [] as SettingRow[],
  /** Bumped on every upsert so each write produces a distinct version stamp. */
  clock: 0,
};

function nextDate(): Date {
  store.clock += 1000;
  return new Date(Date.UTC(2026, 7, 25, 0, 0, 0, 0) + store.clock);
}

const settingFindUnique = vi.fn(async (args: any) => {
  const row = store.settings.find((s) => s.key === args.where.key);
  return row ? { ...row } : null;
});

// Declared up front so $transaction's interactive form can hand the same stub
// back as the transaction client.
const prismaStub: any = {};

vi.mock("../../src/db.js", () => {
  Object.assign(prismaStub, {
    setting: {
      findUnique: settingFindUnique,
      upsert: vi.fn(async (args: any) => {
        const existing = store.settings.find((s) => s.key === args.where.key);
        if (existing) {
          existing.value = args.update.value;
          existing.updatedAt = nextDate();
          return { ...existing };
        }
        const row: SettingRow = { key: args.create.key, value: args.create.value, updatedAt: nextDate() };
        store.settings.push(row);
        return { ...row };
      }),
    },
    // Region CRUD touches the tag registry and (via applyOneRegion, which these
    // tests never call) assets/subnets. Stubbed to no-ops.
    tag: { upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 0 })) },
    asset: { findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    subnet: { findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    regionTagAssignment: {
      findMany: vi.fn(async () => []),
      createMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    // Both $transaction shapes, because the region writers use the INTERACTIVE
    // callback form (to hold a pg_advisory_xact_lock across the blob's
    // read-modify-write) while other callers pass an array of promises. A mock
    // that only understood one silently broke the other.
    //
    // Note what this fake canNOT verify: the advisory lock itself is a real
    // database behaviour, so the serialization guarantee is covered by
    // tests/integration/mapRegionConcurrentWrites.test.ts, not here.
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prismaStub) : Promise.all(arg),
    ),
  });
  return { prisma: prismaStub };
});

const {
  createRegion,
  deleteRegion,
  diffRegionLevels,
  getRegionHierarchy,
  invalidateRegionHierarchy,
  listRegions,
  listRegionsWithLevels,
  setRegionNesting,
  updateRegion,
} = await import("../../src/services/mapRegionService.js");

const { buildRegionHierarchy } = await import("../../src/utils/regionHierarchy.js");

function square(minLat: number, minLng: number, size: number): Array<[number, number]> {
  return [
    [minLat, minLng],
    [minLat, minLng + size],
    [minLat + size, minLng + size],
    [minLat + size, minLng],
  ];
}

/** Concentric: South ⊃ Nashville, plus a disjoint sibling. */
async function seedNested() {
  await createRegion({ name: "South", polygon: square(30, -95, 20), actor: "test" });
  await createRegion({ name: "Nashville", polygon: square(35, -88, 2), actor: "test" });
  await createRegion({ name: "Elsewhere", polygon: square(60, 10, 3), actor: "test" });
}

beforeEach(() => {
  store.settings.length = 0;
  store.clock = 0;
  settingFindUnique.mockClear();
  invalidateRegionHierarchy();
});

describe("listRegionsWithLevels", () => {
  it("decorates each region with its derived level, depth, parent and ancestors", async () => {
    await seedNested();
    const rows = await listRegionsWithLevels();
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

    expect(byName["Nashville"]).toMatchObject({ level: 1, depth: 1, childIds: [] });
    expect(byName["South"]).toMatchObject({ level: 2, depth: 0, parentId: null });
    expect(byName["Elsewhere"]).toMatchObject({ level: 1, depth: 0, parentId: null });

    expect(byName["Nashville"]!.parentId).toBe(byName["South"]!.id);
    expect(byName["Nashville"]!.ancestorIds).toEqual([byName["South"]!.id]);
    expect(byName["South"]!.childIds).toEqual([byName["Nashville"]!.id]);
  });

  it("stays name-sorted, like listRegions", async () => {
    await seedNested();
    const names = (await listRegionsWithLevels()).map((r) => r.name);
    expect(names).toEqual(["Elsewhere", "Nashville", "South"]);
  });

  it("returns an empty list when no regions exist", async () => {
    expect(await listRegionsWithLevels()).toEqual([]);
  });
});

describe("listRegions stays undecorated", () => {
  it("does not carry level/depth/parentId", async () => {
    await seedNested();
    const rows = await listRegions();
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).not.toHaveProperty("level");
      expect(r).not.toHaveProperty("depth");
      expect(r).not.toHaveProperty("parentId");
    }
  });
});

describe("the persisted blob never gains derived fields", () => {
  it("keeps exactly the MapRegion keys after a decorated read then a write", async () => {
    await seedNested();
    // Read the decorated projection first — if anything downstream ever fed one
    // of these objects back into a write, this is the sequence that would do it.
    const decorated = await listRegionsWithLevels();
    expect(decorated[0]).toHaveProperty("level");

    const south = decorated.find((r) => r.name === "South")!;
    await updateRegion(south.id, { name: "South Division" });

    const blob = store.settings.find((s) => s.key === "mapRegions")!.value as Array<Record<string, unknown>>;
    const expected = ["id", "name", "polygon", "color", "createdBy", "createdAt", "updatedAt"].sort();
    for (const row of blob) {
      expect(Object.keys(row).sort()).toEqual(expected);
    }
  });
});

describe("hierarchy cache", () => {
  it("reuses one build while the blob is unchanged", async () => {
    await seedNested();
    const a = await getRegionHierarchy();
    const b = await getRegionHierarchy();
    // Same object identity — the geometry was not rebuilt.
    expect(b.hierarchy).toBe(a.hierarchy);
  });

  it("still reads the version on every call, so another process's write is seen", async () => {
    // Polaris runs split-role (web / monitor / discovery are separate
    // processes with separate memory), so a region edited in the web process
    // must not leave a monitor process serving stale levels. The cheap indexed
    // findUnique per call is the price of that; only the geometry build is
    // memoized.
    await seedNested();
    settingFindUnique.mockClear();
    await getRegionHierarchy();
    await getRegionHierarchy();
    expect(settingFindUnique.mock.calls.length).toBe(2);
  });

  it("reflects new geometry after a polygon edit", async () => {
    await seedNested();
    const before = await listRegionsWithLevels();
    const nashville = before.find((r) => r.name === "Nashville")!;
    expect(nashville.level).toBe(1);
    expect(nashville.parentId).toBeTruthy();

    // Move Nashville right out of South.
    await updateRegion(nashville.id, { polygon: square(70, 70, 2) });

    const after = await listRegionsWithLevels();
    const moved = after.find((r) => r.name === "Nashville")!;
    const south = after.find((r) => r.name === "South")!;
    expect(moved.parentId).toBeNull();
    expect(south.level).toBe(1); // no longer contains anything
    expect(south.childIds).toEqual([]);
  });

  it("reflects a deletion", async () => {
    await seedNested();
    const rows = await listRegionsWithLevels();
    const nashville = rows.find((r) => r.name === "Nashville")!;
    await deleteRegion(nashville.id);
    const after = await listRegionsWithLevels();
    expect(after.map((r) => r.name)).toEqual(["Elsewhere", "South"]);
    expect(after.find((r) => r.name === "South")!.level).toBe(1);
  });
});

describe("diffRegionLevels", () => {
  const h = (spec: Array<{ id: string; polygon: Array<[number, number]> }>) =>
    buildRegionHierarchy(spec);

  it("reports nothing when levels are unchanged", () => {
    const a = h([{ id: "x", polygon: square(0, 0, 5) }]);
    const b = h([{ id: "x", polygon: square(0, 0, 5) }]);
    expect(diffRegionLevels(a, b)).toEqual([]);
  });

  it("reports a region whose level moved because a DIFFERENT region was drawn", () => {
    // "outer" is L1 alone, and becomes L2 once a region is drawn inside it —
    // an edit to the child changes the parent's level, which is precisely the
    // silent re-tiering the audit Event exists to surface.
    const before = h([{ id: "outer", polygon: square(0, 0, 20) }]);
    const after = h([
      { id: "outer", polygon: square(0, 0, 20) },
      { id: "inner", polygon: square(5, 5, 2) },
    ]);
    expect(diffRegionLevels(before, after)).toEqual([
      { regionId: "inner", from: null, to: 1 },
      { regionId: "outer", from: 1, to: 2 },
    ]);
  });

  it("reports a removed region as a move to null", () => {
    const before = h([{ id: "gone", polygon: square(0, 0, 5) }]);
    const after = h([]);
    expect(diffRegionLevels(before, after)).toEqual([{ regionId: "gone", from: 1, to: null }]);
  });

  it("is ordered by region id so the audit detail is stable", () => {
    const before = h([]);
    const after = h([
      { id: "zeta", polygon: square(0, 0, 5) },
      { id: "alpha", polygon: square(50, 50, 5) },
    ]);
    expect(diffRegionLevels(before, after).map((d) => d.regionId)).toEqual(["alpha", "zeta"]);
  });
});

describe("setRegionNesting (drag-to-nest)", () => {
  /** South ⊃ Middle ⊃ Nashville, plus a disjoint Elsewhere. */
  async function seedChain() {
    const south = await createRegion({ name: "South", polygon: square(30, -95, 20), actor: "test" });
    const middle = await createRegion({ name: "Middle", polygon: square(34, -89, 5), actor: "test" });
    const nash = await createRegion({ name: "Nashville", polygon: square(35, -88, 2), actor: "test" });
    const elsewhere = await createRegion({ name: "Elsewhere", polygon: square(60, 10, 3), actor: "test" });
    return { south, middle, nash, elsewhere };
  }

  it("nests a region under a larger container that really contains it, and re-levels", async () => {
    const { south, middle, nash } = await seedChain();
    const out = await setRegionNesting(nash.id, south.id);
    expect(out).toMatchObject({ previousParentId: middle.id, parentId: south.id });
    expect(out.region.nestUnderId).toBe(south.id);

    const byName = Object.fromEntries((await listRegionsWithLevels()).map((r) => [r.name, r]));
    expect(byName["Nashville"]!.parentId).toBe(south.id);
    expect(byName["Middle"]!.level).toBe(1);
    expect(byName["Nashville"]!.containerIds).toEqual([middle.id, south.id]);
  });

  it("refuses a region whose polygon does not contain it", async () => {
    const { nash, elsewhere } = await seedChain();
    await expect(setRegionNesting(nash.id, elsewhere.id)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(setRegionNesting(nash.id, nash.id)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(setRegionNesting(nash.id, "missing")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("stores null when the pick is the smallest container, or when reset to automatic", async () => {
    const { south, middle, nash } = await seedChain();
    await setRegionNesting(nash.id, south.id);
    const back = await setRegionNesting(nash.id, middle.id);
    expect(back.region.nestUnderId).toBeNull();
    await setRegionNesting(nash.id, south.id);
    const reset = await setRegionNesting(nash.id, null);
    expect(reset.region.nestUnderId).toBeNull();
    expect(reset.parentId).toBe(middle.id);
  });

  it("clears picks naming a deleted region", async () => {
    const { south, nash } = await seedChain();
    await setRegionNesting(nash.id, south.id);
    await deleteRegion(south.id);
    const blob = store.settings.find((s) => s.key === "mapRegions")!.value as Array<Record<string, unknown>>;
    expect(blob.find((r) => r.id === nash.id)!.nestUnderId).toBeNull();
  });
});

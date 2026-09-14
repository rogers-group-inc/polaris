/**
 * tests/unit/mapRegionRetiredSweep.test.ts
 *
 * Business rule 52: a `region:<name>` tag is stripped when no region answers to
 * that name AND Polaris recorded retiring it.
 *
 * The second half is the whole design, and it is what these tests are mostly
 * about. Before the retired-name list existed, a rename or delete whose tag
 * rotation died part-way left tags that NOTHING could ever remove: the reconcile
 * strips only pairs `RegionTagAssignment` recorded, provenance is keyed by
 * region id (a rename does not change it, a delete drops it outright), and
 * `stripOutOfRegionFirewallTags` deliberately leaves a tag naming no current
 * region alone. Prod wore that twice in 2026-09 and it took hand-written SQL.
 *
 * The obvious fix — "strip every `region:` tag matching no region" — is the one
 * this must NOT do. `PUT /assets/:id` writes `tags` as given, so an operator can
 * hand-apply `region:Narnia` to a printer, and the documented contract is that
 * manual attachments survive every reconciler forever. Bounding the sweep by
 * names Polaris itself retired keeps both promises at once.
 *
 * Covered:
 *   - A rename records the old name, so the sweep finishes a rotation that died.
 *   - A delete records the name the same way.
 *   - A tag naming a name nobody retired is NEVER swept (the printer).
 *   - A name redrawn as a live region is reclaimed, not stripped.
 *   - The name is forgotten once swept — the second pass is a no-op.
 *   - A retired name whose strip throws STAYS on the list for the next pass.
 *   - The list is re-read under the lock, so a rename racing the sweep survives.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

interface AssetRow {
  id: string;
  hostname: string | null;
  serialNumber: string | null;
  assetType: string;
  latitude: number | null;
  longitude: number | null;
  ipAddress: string | null;
  fortinetTopology: unknown;
  tags: string[];
}
interface SubnetRow { id: string; cidr: string; fortigateDevice: string | null; tags: string[] }

const store = {
  assets: [] as AssetRow[],
  subnets: [] as SubnetRow[],
  prov: [] as { regionId: string; targetType: string; targetId: string }[],
  /** Both JSON blobs this service owns, keyed exactly as Setting rows are. */
  settings: new Map<string, unknown>(),
  /** Set to a name to make its asset strip throw, simulating a mid-sweep failure. */
  failAssetUpdateFor: null as string | null,
  /** Runs inside the blob lock, once — the hook for the racing-writer test. */
  onLock: null as (() => void) | null,
};

function matches(row: any, where: Record<string, any> | undefined): boolean {
  for (const [field, cond] of Object.entries(where ?? {})) {
    const v = row[field];
    if (cond === null || typeof cond === "string" || typeof cond === "number") {
      if (v !== cond) return false;
    } else if (cond && typeof cond === "object") {
      if ("in" in cond) {
        if (!(cond.in as any[]).includes(v)) return false;
      } else if ("not" in cond) {
        if (cond.not === null ? v == null : v === cond.not) return false;
      } else if ("has" in cond) {
        if (!Array.isArray(v) || !v.includes(cond.has)) return false;
      } else {
        throw new Error(`unsupported where condition on ${field}: ${JSON.stringify(cond)}`);
      }
    } else {
      throw new Error(`unsupported where on ${field}`);
    }
  }
  return true;
}

function table<T extends { id: string; tags: string[] }>(rows: () => T[], kind: "asset" | "subnet") {
  return {
    findMany: vi.fn(async (args: any = {}) => rows().filter((r) => matches(r, args?.where)).map((r) => ({ ...r }))),
    update: vi.fn(async (args: any) => {
      const row = rows().find((r) => r.id === args.where.id);
      if (!row) throw new Error("row not found");
      if (kind === "asset" && store.failAssetUpdateFor && row.tags.includes(store.failAssetUpdateFor)) {
        throw new Error("simulated write failure");
      }
      Object.assign(row, args.data);
      return { ...row };
    }),
  };
}

const settingTable = {
  findUnique: vi.fn(async (args: any) => {
    const key = args?.where?.key;
    if (!store.settings.has(key)) return null;
    return { value: store.settings.get(key), updatedAt: new Date("2026-09-14T00:00:00Z") };
  }),
  upsert: vi.fn(async (args: any) => {
    const key = args?.where?.key;
    const value = args?.update?.value ?? args?.create?.value;
    store.settings.set(key, JSON.parse(JSON.stringify(value)));
    return { key, value };
  }),
};

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: table(() => store.assets, "asset"),
    subnet: table(() => store.subnets, "subnet"),
    setting: settingTable,
    tag: { upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 0 })) },
    regionTagAssignment: {
      findMany: vi.fn(async (args: any = {}) =>
        store.prov.filter((r) => matches(r, args?.where)).map((r) => ({ ...r })),
      ),
      createMany: vi.fn(async (args: any) => {
        for (const row of args.data) {
          const dup = store.prov.some(
            (p) => p.regionId === row.regionId && p.targetType === row.targetType && p.targetId === row.targetId,
          );
          if (!dup) store.prov.push({ ...row });
        }
        return { count: args.data.length };
      }),
      deleteMany: vi.fn(async (args: any = {}) => {
        const before = store.prov.length;
        store.prov = store.prov.filter((r) => !matches(r, args?.where));
        return { count: before - store.prov.length };
      }),
    },
    // Both shapes: the array form the tag mutators use, and the callback form
    // `withRegionBlobLock` uses. The callback form fires `onLock` so a test can
    // model another writer landing between the sweep's read and its write.
    $transaction: vi.fn(async (arg: any) => {
      if (typeof arg === "function") {
        const tx = { setting: settingTable, $executeRaw: async () => 0 };
        if (store.onLock) {
          const hook = store.onLock;
          store.onLock = null;
          hook();
        }
        return arg(tx);
      }
      return Promise.all(arg);
    }),
  },
}));

import type { MapRegion } from "../../src/services/mapRegionService.js";

const { sweepRetiredRegionTags, updateRegion, deleteRegion } = await import(
  "../../src/services/mapRegionService.js"
);

const POLYGON: Array<[number, number]> = [
  [40.65, -74.08],
  [40.65, -73.93],
  [40.80, -73.93],
  [40.80, -74.08],
];

const REGION: MapRegion = {
  id: "region-1",
  name: "Middle Tennessee",
  polygon: POLYGON,
  color: "#4fc3f7",
  createdBy: "test",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const RETIRED_KEY = "mapRegionRetiredNames";
const REGIONS_KEY = "mapRegions";

function retiredNames(): string[] {
  const rows = (store.settings.get(RETIRED_KEY) as { name: string }[] | undefined) ?? [];
  return rows.map((r) => r.name);
}

/** One un-pinned server, so nothing is a member of any polygon by geometry. */
function seedAsset(id: string, tags: string[]): void {
  store.assets.push({
    id,
    hostname: id,
    serialNumber: null,
    assetType: "server",
    latitude: null,
    longitude: null,
    ipAddress: null,
    fortinetTopology: null,
    tags: [...tags],
  });
}

beforeEach(() => {
  store.assets = [];
  store.subnets = [];
  store.prov = [];
  store.settings = new Map<string, unknown>();
  store.failAssetUpdateFor = null;
  store.onLock = null;
  vi.clearAllMocks();
});

describe("a rename or delete retires the name it gave up", () => {
  it("records the old name on a rename, before any tag rotation runs", async () => {
    store.settings.set(REGIONS_KEY, [REGION]);

    await updateRegion(REGION.id, { name: "Middle Tenneessee", polygon: POLYGON });

    // `updateRegion` does NOT rotate tags — the route calls applyRename after
    // it. So this is the state a rotation that never ran would leave behind.
    expect(retiredNames()).toEqual(["Middle Tennessee"]);
  });

  it("records the name on a delete", async () => {
    store.settings.set(REGIONS_KEY, [REGION]);

    await deleteRegion(REGION.id);

    expect(retiredNames()).toEqual(["Middle Tennessee"]);
  });

  it("does not record a polygon-only edit", async () => {
    store.settings.set(REGIONS_KEY, [REGION]);

    await updateRegion(REGION.id, { polygon: [[1, 1], [1, 2], [2, 2]] as Array<[number, number]> });

    expect(retiredNames()).toEqual([]);
  });
});

describe("sweepRetiredRegionTags", () => {
  it("finishes a rename whose tag rotation died", async () => {
    // The prod shape: blob renamed, tags never rotated.
    store.settings.set(REGIONS_KEY, [{ ...REGION, name: "Middle Tenneessee" }]);
    store.settings.set(RETIRED_KEY, [
      { name: "Middle Tennessee", regionId: REGION.id, retiredAt: "2026-09-13T00:00:00Z", reason: "rename" },
    ]);
    seedAsset("srv-1", ["region:Middle Tennessee", "role:app"]);
    seedAsset("srv-2", ["region:Middle Tennessee", "region:Middle Tenneessee"]);
    store.subnets.push({ id: "net-1", cidr: "10.1.0.0/24", fortigateDevice: null, tags: ["region:Middle Tennessee"] });

    const sweep = await sweepRetiredRegionTags();

    expect(sweep.namesSwept).toEqual(["Middle Tennessee"]);
    expect(sweep.assetTagsStripped).toBe(2);
    expect(sweep.subnetTagsStripped).toBe(1);
    // The dead tag is gone; everything else on the row survived, including the
    // live region tag the reconcile put there.
    expect(store.assets[0]!.tags).toEqual(["role:app"]);
    expect(store.assets[1]!.tags).toEqual(["region:Middle Tenneessee"]);
    expect(store.subnets[0]!.tags).toEqual([]);
    // And the name is forgotten, so the next pass has nothing to do.
    expect(retiredNames()).toEqual([]);
  });

  it("never touches a region tag nobody retired", async () => {
    // The hand-applied case the older invariant protects: an operator typed
    // `region:Narnia` onto a printer and no region ever had that name.
    store.settings.set(REGIONS_KEY, [REGION]);
    store.settings.set(RETIRED_KEY, []);
    seedAsset("printer-1", ["region:Narnia"]);

    const sweep = await sweepRetiredRegionTags();

    expect(sweep.namesSwept).toEqual([]);
    expect(sweep.assetTagsStripped).toBe(0);
    expect(store.assets[0]!.tags).toEqual(["region:Narnia"]);
  });

  it("reclaims a name that has been redrawn rather than stripping it", async () => {
    // Deleted and drawn again under the same name — the delete route already
    // treats that as the likely intent, and the tags still mean something.
    store.settings.set(REGIONS_KEY, [REGION]);
    store.settings.set(RETIRED_KEY, [
      { name: "Middle Tennessee", regionId: "region-old", retiredAt: "2026-09-13T00:00:00Z", reason: "delete" },
    ]);
    seedAsset("srv-1", ["region:Middle Tennessee"]);

    const sweep = await sweepRetiredRegionTags();

    expect(sweep.namesReclaimed).toEqual(["Middle Tennessee"]);
    expect(sweep.namesSwept).toEqual([]);
    expect(store.assets[0]!.tags).toEqual(["region:Middle Tennessee"]);
    expect(retiredNames()).toEqual([]);
  });

  it("matches the live-region check case-insensitively", async () => {
    store.settings.set(REGIONS_KEY, [{ ...REGION, name: "middle tennessee" }]);
    store.settings.set(RETIRED_KEY, [
      { name: "Middle Tennessee", regionId: "region-old", retiredAt: "2026-09-13T00:00:00Z", reason: "delete" },
    ]);
    seedAsset("srv-1", ["region:Middle Tennessee"]);

    const sweep = await sweepRetiredRegionTags();

    expect(sweep.namesReclaimed).toEqual(["Middle Tennessee"]);
    expect(store.assets[0]!.tags).toEqual(["region:Middle Tennessee"]);
  });

  it("keeps a retired name whose strip failed, so the next pass retries it", async () => {
    store.settings.set(REGIONS_KEY, []);
    store.settings.set(RETIRED_KEY, [
      { name: "Middle Tennessee", regionId: REGION.id, retiredAt: "2026-09-13T00:00:00Z", reason: "rename" },
      { name: "Eastern Middle Tennessee", regionId: "region-2", retiredAt: "2026-09-13T00:00:00Z", reason: "rename" },
    ]);
    seedAsset("srv-1", ["region:Middle Tennessee"]);
    seedAsset("srv-2", ["region:Eastern Middle Tennessee"]);
    store.failAssetUpdateFor = "region:Middle Tennessee";

    const sweep = await sweepRetiredRegionTags();

    // The healthy name is done and forgotten; the failed one is still listed.
    expect(sweep.namesSwept).toEqual(["Eastern Middle Tennessee"]);
    expect(retiredNames()).toEqual(["Middle Tennessee"]);
    expect(store.assets[0]!.tags).toEqual(["region:Middle Tennessee"]);
    expect(store.assets[1]!.tags).toEqual([]);
  });

  it("does not discard a name retired while the sweep was running", async () => {
    // The lost-update shape rule 20a is about, applied to this blob: the sweep
    // read the list, a rename appended to it, and the sweep must not write its
    // stale copy back over that.
    store.settings.set(REGIONS_KEY, []);
    store.settings.set(RETIRED_KEY, [
      { name: "Middle Tennessee", regionId: REGION.id, retiredAt: "2026-09-13T00:00:00Z", reason: "rename" },
    ]);
    seedAsset("srv-1", ["region:Middle Tennessee"]);
    store.onLock = () => {
      store.settings.set(RETIRED_KEY, [
        ...(store.settings.get(RETIRED_KEY) as unknown[]),
        { name: "Arkansas", regionId: "region-9", retiredAt: "2026-09-14T00:00:00Z", reason: "delete" },
      ]);
    };

    const sweep = await sweepRetiredRegionTags();

    expect(sweep.namesSwept).toEqual(["Middle Tennessee"]);
    // Swept name dropped, the newcomer kept for the next pass.
    expect(retiredNames()).toEqual(["Arkansas"]);
  });

  it("is a no-op with nothing retired", async () => {
    store.settings.set(REGIONS_KEY, [REGION]);
    seedAsset("srv-1", ["region:Middle Tennessee"]);

    const sweep = await sweepRetiredRegionTags();

    expect(sweep).toEqual({
      namesSwept: [],
      assetTagsStripped: 0,
      subnetTagsStripped: 0,
      namesReclaimed: [],
    });
    expect(store.assets[0]!.tags).toEqual(["region:Middle Tennessee"]);
  });
});

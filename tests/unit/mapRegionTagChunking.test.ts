/**
 * tests/unit/mapRegionTagChunking.test.ts
 *
 * Every region tag mutator writes in chunks of 50.
 *
 * This is a SCALE regression test, not a behavior one — the tags end up in the
 * same place either way, which is exactly why the bug survived review. The four
 * mutators used to issue one `$transaction` holding an update per matching row,
 * and two of them are reached with the WHOLE membership at once:
 *
 *   - `removeTagFromAllAssets` / `removeTagFromAllSubnets` — the rename and
 *     delete paths, where the tag string itself is going away.
 *   - `addTagToAssets` / `addTagToSubnets` — the first apply of a new region,
 *     and the add half of a rename (the old tag has just been stripped, so not
 *     one member carries the new one yet).
 *
 * On prod in 2026-09 a rename of a ~1,100-asset region threw in that single
 * transaction. Because `applyRename` runs AFTER `updateRegion` has committed the
 * renamed blob, the failure stranded 1,492 asset tags and 114 subnet tags under
 * names no region answered to — and a tag naming no current region is invisible
 * to the provenance-bounded reconcile, so nothing ever cleaned them up. It took
 * hand-written SQL against the production database.
 *
 * The assertion is on transaction COUNT rather than on the tags, so it fails if
 * someone collapses the chunking back into one call while the end state stays
 * correct. 130 rows is deliberately not a multiple of 50: it pins the remainder
 * chunk too (3 calls, not 2).
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
interface ProvRow { regionId: string; targetType: string; targetId: string }

const store = {
  assets: [] as AssetRow[],
  subnets: [] as SubnetRow[],
  prov: [] as ProvRow[],
};

/** The `where` shapes mapRegionService actually uses; anything else throws. */
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

function table<T extends { id: string }>(rows: () => T[]) {
  return {
    findMany: vi.fn(async (args: any = {}) => rows().filter((r) => matches(r, args?.where)).map((r) => ({ ...r }))),
    update: vi.fn(async (args: any) => {
      const row = rows().find((r) => r.id === args.where.id);
      if (!row) throw new Error("row not found");
      Object.assign(row, args.data);
      return { ...row };
    }),
  };
}

/**
 * Records the SIZE of every batch handed to `$transaction`, which is the whole
 * point of this file — `Promise.all` would run an unchunked batch just fine.
 */
const txSizes: number[] = [];

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: table(() => store.assets),
    subnet: table(() => store.subnets),
    setting: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
    },
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
    $transaction: vi.fn(async (ops: any[]) => {
      txSizes.push(ops.length);
      return Promise.all(ops);
    }),
  },
}));

import type { MapRegion } from "../../src/services/mapRegionService.js";

const { applyOneRegion, applyDelete } = await import("../../src/services/mapRegionService.js");

const POLYGON: Array<[number, number]> = [
  [40.65, -74.08],
  [40.65, -73.93],
  [40.80, -73.93],
  [40.80, -74.08],
];
const INSIDE: [number, number] = [40.71, -74.01];

const REGION: MapRegion = {
  id: "region-1",
  name: "Ashfield",
  polygon: POLYGON,
  color: "#4fc3f7",
  createdBy: "test",
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
};
const TAG = "region:Ashfield";

/** 130 pinned gates inside the polygon — every one of them a member. */
function seedGates(count: number, tags: string[]): void {
  store.assets = [];
  for (let i = 0; i < count; i++) {
    store.assets.push({
      id: `gate-${i}`,
      hostname: `fgt-${i}`,
      serialNumber: `FGT${String(i).padStart(4, "0")}`,
      assetType: "firewall",
      latitude: INSIDE[0],
      longitude: INSIDE[1],
      ipAddress: null,
      fortinetTopology: { role: "fortigate", deviceName: `FGT-DEV-${i}` },
      tags: [...tags],
    });
  }
}

beforeEach(() => {
  store.assets = [];
  store.subnets = [];
  store.prov = [];
  txSizes.length = 0;
  vi.clearAllMocks();
});

describe("region tag mutators chunk at 50", () => {
  it("splits the add pass across chunks and leaves no member untagged", async () => {
    seedGates(130, []);

    const summary = await applyOneRegion(REGION);

    expect(summary.added).toBe(130);
    expect(txSizes).toEqual([50, 50, 30]);
    expect(store.assets.every((a) => a.tags.includes(TAG))).toBe(true);
  });

  it("splits the wholesale strip across chunks and leaves no tag behind", async () => {
    // The delete / rename shape: every row already carries the tag.
    seedGates(130, [TAG]);

    const summary = await applyDelete(REGION);

    expect(summary.removed).toBe(130);
    expect(txSizes).toEqual([50, 50, 30]);
    expect(store.assets.some((a) => a.tags.includes(TAG))).toBe(false);
  });

  it("does not open a transaction when there is nothing to write", async () => {
    // The steady-state reconcile: every member already carries the tag, so the
    // add pass has no updates to make. An empty `$transaction([])` per pass
    // would be a wasted round trip on the 6-hour job for every region.
    seedGates(130, [TAG]);
    store.prov = store.assets.map((a) => ({ regionId: REGION.id, targetType: "asset", targetId: a.id }));

    const summary = await applyOneRegion(REGION);

    expect(summary.added).toBe(0);
    expect(summary.removed).toBe(0);
    expect(txSizes).toEqual([]);
  });

  it("strips a partial tag set without touching rows that never carried it", async () => {
    // A remainder-only batch, and proof the chunking reads from the FILTERED
    // row set rather than from the whole fleet.
    seedGates(130, []);
    for (let i = 0; i < 12; i++) store.assets[i]!.tags = [TAG];

    const summary = await applyDelete(REGION);

    expect(summary.removed).toBe(12);
    expect(txSizes).toEqual([12]);
  });
});

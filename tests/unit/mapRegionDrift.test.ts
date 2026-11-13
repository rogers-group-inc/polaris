/**
 * tests/unit/mapRegionDrift.test.ts
 *
 * Map-region tags are RE-EVALUATED, not just added: a device that has moved out
 * of a polygon (re-pinned gate, switch repointed to another controller, subnet
 * re-served by a different gate) loses its `region:<name>` tag on the next
 * reconcile. The strip is bounded by the `RegionTagAssignment` provenance rows
 * so a hand-applied tag is never destroyed.
 *
 * `tests/integration/mapRegionSubnetTags.test.ts` covers the same service
 * against a real database, but that file skips when DATABASE_URL is unreachable
 * — and this is the behavior that deletes rows' tags, so it gets a test that
 * always runs. The prisma mock below is a small in-memory store rather than
 * per-call stubs, because one `applyOneRegion` pass issues a dozen reads whose
 * ORDER is an implementation detail this test shouldn't pin.
 *
 * Covered:
 *   - diffRegionMembership: the pure add/remove decision, including that a
 *     removal comes from provenance rather than from "carries the tag".
 *   - A gate that moves out of the polygon loses the tag; so do the switch it
 *     controls and the asset addressed out of the subnet it serves.
 *   - A hand-applied region tag (no provenance row) survives every pass.
 *   - A subnet re-served by an out-of-region gate loses the tag.
 *   - The add pass is idempotent and records provenance exactly once.
 *   - applyDelete clears provenance so a later region can't inherit it.
 *   - stripOutOfRegionFirewallTags (the map-save gate pass): a pinned gate
 *     outside the polygon loses the tag WITHOUT a provenance row (the
 *     pre-provenance stale-tag case), its provenance row is dropped when one
 *     exists, and the documented protections hold — in-polygon gates,
 *     non-firewalls, unpinned gates, and tags naming no current region are
 *     never touched.
 *   - reviewRegionTagsForMapSave composes the two passes without double
 *     counting and is a clean no-op on a fleet whose tags match the map.
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
  /** The mapRegions Setting blob — lets reviewRegionTagsForMapSave load regions. */
  regions: [] as unknown[],
};

/**
 * Evaluate the handful of Prisma `where` shapes mapRegionService actually uses.
 * Anything else throws rather than silently matching everything — a filter this
 * fake doesn't understand would make the test pass for the wrong reason.
 */
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

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: table(() => store.assets),
    subnet: table(() => store.subnets),
    // Rule 169(b): a rename / delete also looks for the tag on IP blocks.
    ipBlock: { findMany: async () => [], update: async () => ({}) },
    setting: {
      findUnique: vi.fn(async () =>
        store.regions.length > 0
          ? { value: store.regions.map((r) => ({ ...(r as object) })), updatedAt: new Date("2026-08-26T00:00:00Z") }
          : null,
      ),
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
    $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
  },
}));

import type { MapRegion } from "../../src/services/mapRegionService.js";

const {
  diffRegionMembership,
  applyOneRegion,
  applyDelete,
  stripOutOfRegionFirewallTags,
  reviewRegionTagsForMapSave,
} = await import("../../src/services/mapRegionService.js");

// A square around (40.71, -74.01). "Inside" sits at the centre; "outside" is a
// whole degree away, well clear of the edge.
const POLYGON: Array<[number, number]> = [
  [40.65, -74.08],
  [40.65, -73.93],
  [40.80, -73.93],
  [40.80, -74.08],
];
const INSIDE: [number, number] = [40.71, -74.01];
const OUTSIDE: [number, number] = [33.75, -84.39];

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

const DEVICE_NAME = "FGT-ASHFIELD";

function seed(): void {
  store.assets = [
    {
      id: "gate",
      hostname: "fgt-ashf-01",
      serialNumber: "FGT0001",
      assetType: "firewall",
      latitude: INSIDE[0],
      longitude: INSIDE[1],
      ipAddress: null,
      fortinetTopology: { role: "fortigate", deviceName: DEVICE_NAME },
      tags: [],
    },
    {
      id: "switch",
      hostname: "sw-ashf-01",
      serialNumber: "S1240001",
      assetType: "switch",
      latitude: null,
      longitude: null,
      ipAddress: null,
      fortinetTopology: { role: "fortiswitch", controllerSerial: "FGT0001", controllerFortigate: DEVICE_NAME },
      tags: [],
    },
    {
      id: "server",
      hostname: "srv-ashf-01",
      serialNumber: null,
      assetType: "server",
      latitude: null,
      longitude: null,
      ipAddress: "10.88.1.20",
      fortinetTopology: null,
      tags: [],
    },
  ];
  store.subnets = [{ id: "sub", cidr: "10.88.1.0/24", fortigateDevice: DEVICE_NAME, tags: ["operator-set"] }];
  store.prov = [];
  store.regions = [];
}

const tagsOf = (id: string) => store.assets.find((a) => a.id === id)!.tags;
const subnetTags = () => store.subnets[0]!.tags;
const provIds = () => store.prov.map((p) => `${p.targetType}:${p.targetId}`).sort();

/** Re-pin the gate outside the polygon — the "device moved" event. */
function moveGateOut(): void {
  const gate = store.assets.find((a) => a.id === "gate")!;
  gate.latitude = OUTSIDE[0];
  gate.longitude = OUTSIDE[1];
}

describe("diffRegionMembership", () => {
  it("adds what is expected but unrecorded, removes what is recorded but no longer expected", () => {
    const d = diffRegionMembership(["a", "b", "c"], ["b", "c", "d"]);
    expect(d.toAdd).toEqual(["a"]);
    expect(d.toRemove).toEqual(["d"]);
  });

  it("removes nothing when provenance is empty, however many targets carry the tag", () => {
    // The load-bearing property: a target we never recorded is operator-owned.
    expect(diffRegionMembership([], [])).toEqual({ toAdd: [], toRemove: [] });
    expect(diffRegionMembership(["a"], []).toRemove).toEqual([]);
  });

  it("is a no-op when the two sets agree", () => {
    const d = diffRegionMembership(["a", "b"], ["b", "a"]);
    expect(d.toAdd).toEqual([]);
    expect(d.toRemove).toEqual([]);
  });

  it("accepts Sets as well as arrays", () => {
    const d = diffRegionMembership(new Set(["a"]), new Set(["b"]));
    expect(d).toEqual({ toAdd: ["a"], toRemove: ["b"] });
  });
});

describe("applyOneRegion — add pass", () => {
  beforeEach(seed);

  it("tags the gate, its managed switch, the subnet it serves, and an asset in that subnet", async () => {
    const summary = await applyOneRegion(REGION);
    expect(summary.added).toBe(3);
    expect(summary.subnetsAdded).toBe(1);
    expect(tagsOf("gate")).toContain(TAG);
    expect(tagsOf("switch")).toContain(TAG);
    expect(tagsOf("server")).toContain(TAG);
    expect(subnetTags()).toEqual(["operator-set", TAG]);
  });

  it("records one provenance row per tagged target and is idempotent", async () => {
    await applyOneRegion(REGION);
    const first = provIds();
    expect(first).toEqual(["asset:gate", "asset:server", "asset:switch", "subnet:sub"]);

    const second = await applyOneRegion(REGION);
    expect(second.added).toBe(0);
    expect(second.removed).toBe(0);
    expect(second.subnetsAdded).toBe(0);
    expect(provIds()).toEqual(first);
    expect(tagsOf("gate").filter((t) => t === TAG)).toHaveLength(1);
  });
});

describe("applyOneRegion — drift", () => {
  beforeEach(seed);

  it("strips the tag from the whole subtree once the gate is re-pinned outside", async () => {
    await applyOneRegion(REGION);
    moveGateOut();

    const summary = await applyOneRegion(REGION);
    expect(summary.removed).toBe(3);
    expect(summary.subnetsRemoved).toBe(1);
    expect(tagsOf("gate")).not.toContain(TAG);
    expect(tagsOf("switch")).not.toContain(TAG);
    expect(tagsOf("server")).not.toContain(TAG);
    // The operator's own subnet tag is untouched by the region strip.
    expect(subnetTags()).toEqual(["operator-set"]);
    expect(provIds()).toEqual([]);
  });

  it("strips a switch repointed to a controller outside the region, leaving the gate alone", async () => {
    await applyOneRegion(REGION);
    const sw = store.assets.find((a) => a.id === "switch")!;
    sw.fortinetTopology = { role: "fortiswitch", controllerSerial: "FGT9999", controllerFortigate: "FGT-ATLANTA" };

    const summary = await applyOneRegion(REGION);
    expect(summary.removed).toBe(1);
    expect(tagsOf("switch")).not.toContain(TAG);
    expect(tagsOf("gate")).toContain(TAG);
    expect(provIds()).toEqual(["asset:gate", "asset:server", "subnet:sub"]);
  });

  it("strips a subnet re-served by an out-of-region gate, and the asset addressed out of it", async () => {
    await applyOneRegion(REGION);
    store.subnets[0]!.fortigateDevice = "FGT-ATLANTA";

    const summary = await applyOneRegion(REGION);
    expect(summary.subnetsRemoved).toBe(1);
    expect(subnetTags()).toEqual(["operator-set"]);
    // The server had no coordinates and no controller stamp — the subnet was
    // its only route into the region, so it drops out with it.
    expect(summary.removed).toBe(1);
    expect(tagsOf("server")).not.toContain(TAG);
  });

  it("never strips a hand-applied region tag (no provenance row)", async () => {
    // An operator tags a non-geolocated device by hand — the documented manual
    // attachment case. It has no provenance row, so it is not ours to remove.
    store.assets.push({
      id: "manual",
      hostname: "printer-ashf",
      serialNumber: null,
      assetType: "printer",
      latitude: null,
      longitude: null,
      ipAddress: "192.0.2.7",
      fortinetTopology: null,
      tags: [TAG],
    });

    await applyOneRegion(REGION);
    expect(tagsOf("manual")).toEqual([TAG]);

    moveGateOut();
    const summary = await applyOneRegion(REGION);
    expect(summary.removed).toBe(3); // gate, switch, server — not the printer
    expect(tagsOf("manual")).toEqual([TAG]);
  });

  it("re-adds the tag when the device moves back in", async () => {
    await applyOneRegion(REGION);
    moveGateOut();
    await applyOneRegion(REGION);

    const gate = store.assets.find((a) => a.id === "gate")!;
    gate.latitude = INSIDE[0];
    gate.longitude = INSIDE[1];
    const summary = await applyOneRegion(REGION);
    expect(summary.added).toBe(3);
    expect(tagsOf("gate")).toContain(TAG);
    expect(provIds()).toContain("asset:gate");
  });
});

describe("applyDelete", () => {
  beforeEach(seed);

  it("strips every copy of the tag and clears the region's provenance", async () => {
    await applyOneRegion(REGION);
    const summary = await applyDelete(REGION);
    expect(summary.removed).toBe(3);
    expect(summary.subnetsRemoved).toBe(1);
    expect(store.prov).toEqual([]);
    expect(tagsOf("gate")).not.toContain(TAG);
    expect(subnetTags()).toEqual(["operator-set"]);
  });
});

describe("stripOutOfRegionFirewallTags — the map-save gate pass", () => {
  beforeEach(seed);

  it("strips the tag from a pinned gate outside the polygon even with NO provenance row", async () => {
    // The pre-provenance world: the tag exists, RegionTagAssignment doesn't.
    moveGateOut();
    const gate = store.assets.find((a) => a.id === "gate")!;
    gate.tags = [TAG, "operator-note"];

    const summary = await stripOutOfRegionFirewallTags([REGION]);
    expect(summary.firewallTagsStripped).toBe(1);
    expect(summary.firewallsTouched).toBe(1);
    // Only the region tag goes; the operator's other tags are untouched.
    expect(tagsOf("gate")).toEqual(["operator-note"]);
  });

  it("drops the provenance row for a stripped pair", async () => {
    await applyOneRegion(REGION);
    moveGateOut();

    // Called directly (not through the reconcile), so the provenance row is
    // still standing when the gate pass strips the tag.
    const summary = await stripOutOfRegionFirewallTags([REGION]);
    expect(summary.firewallTagsStripped).toBe(1);
    expect(tagsOf("gate")).not.toContain(TAG);
    expect(provIds()).not.toContain("asset:gate");
  });

  it("keeps the tag on a gate inside the polygon", async () => {
    const gate = store.assets.find((a) => a.id === "gate")!;
    gate.tags = [TAG];
    const summary = await stripOutOfRegionFirewallTags([REGION]);
    expect(summary.firewallTagsStripped).toBe(0);
    expect(tagsOf("gate")).toEqual([TAG]);
  });

  it("never touches non-firewalls, unpinned gates, or tags naming no current region", async () => {
    moveGateOut();
    const gate = store.assets.find((a) => a.id === "gate")!;
    // "region:Retired" matches no current region — not ours to judge.
    gate.tags = ["region:Retired", TAG];
    // The documented hand-tag case: a non-geolocated device an operator tagged.
    store.assets.push({
      id: "manual",
      hostname: "printer-ashf",
      serialNumber: null,
      assetType: "printer",
      latitude: null,
      longitude: null,
      ipAddress: null,
      fortinetTopology: null,
      tags: [TAG],
    });
    // A gate with no pin can't be judged geometrically.
    store.assets.push({
      id: "unpinned-gate",
      hostname: "fgt-nowhere",
      serialNumber: "FGT0002",
      assetType: "firewall",
      latitude: null,
      longitude: null,
      ipAddress: null,
      fortinetTopology: { role: "fortigate" },
      tags: [TAG],
    });

    const summary = await stripOutOfRegionFirewallTags([REGION]);
    expect(summary.firewallTagsStripped).toBe(1);
    expect(tagsOf("gate")).toEqual(["region:Retired"]);
    expect(tagsOf("manual")).toEqual([TAG]);
    expect(tagsOf("unpinned-gate")).toEqual([TAG]);
  });
});

describe("reviewRegionTagsForMapSave", () => {
  beforeEach(seed);

  it("strips a pre-provenance stale gate tag the reconcile half cannot touch", async () => {
    store.regions = [REGION];
    moveGateOut();
    const gate = store.assets.find((a) => a.id === "gate")!;
    gate.tags = [TAG]; // no provenance row — the reconcile must leave it alone

    const summary = await reviewRegionTagsForMapSave();
    expect(summary.removed).toBe(0); // provenance-bounded half found nothing
    expect(summary.firewallTagsStripped).toBe(1);
    expect(tagsOf("gate")).toEqual([]);
  });

  it("does not double-count a provenance-tracked drift the reconcile already stripped", async () => {
    store.regions = [REGION];
    await reviewRegionTagsForMapSave(); // tags + records the in-region fleet
    moveGateOut();

    const summary = await reviewRegionTagsForMapSave();
    expect(summary.removed).toBe(3); // gate + switch + server, via provenance
    expect(summary.firewallTagsStripped).toBe(0); // nothing left for the gate pass
    expect(tagsOf("gate")).not.toContain(TAG);
  });

  it("is a clean no-op on a fleet whose tags match the map", async () => {
    store.regions = [REGION];
    const first = await reviewRegionTagsForMapSave();
    expect(first.added).toBe(3);
    expect(first.subnetsAdded).toBe(1);

    const second = await reviewRegionTagsForMapSave();
    expect(second.added).toBe(0);
    expect(second.removed).toBe(0);
    expect(second.subnetsRemoved).toBe(0);
    expect(second.firewallTagsStripped).toBe(0);
  });
});

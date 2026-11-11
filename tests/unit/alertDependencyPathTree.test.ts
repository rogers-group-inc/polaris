/**
 * tests/unit/alertDependencyPathTree.test.ts — the dependency-path diagram in
 * an alert email reads location codes through the device's site's region
 * tree (business rule 153), as the Device Map does: `ra:rack1` alone draws
 * inside its room and building. A site with no tree, or a device no site
 * places, keeps its codes as written.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { assets, sites } = vi.hoisted(() => ({
  assets: [
    { id: "sw", hostname: "SW-1", location: null, description: "ra:rack1", fortinetTopology: null, lastSeenSwitch: null, status: "active", monitorStatus: "down", dependencySuppressed: false },
    { id: "plc", hostname: "PLC-7", location: null, description: "jb:JB-3", fortinetTopology: null, lastSeenSwitch: "SW-1/port9", status: "active", monitorStatus: "down", dependencySuppressed: true },
  ],
  sites: new Map<string, string | null>(),
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: { findMany: vi.fn(async () => assets) },
    assetLldpNeighbor: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("../../src/services/regionTreeService.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/services/regionTreeService.js")>();
  return {
    ...real,
    siteForAsset: vi.fn(async (id: string) => sites.get(id) ?? null),
    loadRegionIndex: vi.fn(async (siteId: string) =>
      real.buildRegionIndex(siteId === "site-1"
        ? [
            { id: "b", kind: "building", name: "Shop", parentId: null },
            { id: "r", kind: "room", name: "Closet", parentId: "b" },
            { id: "k", kind: "rack", name: "rack1", parentId: "r" },
          ]
        : [])),
  };
});

import { loadDependencyPath } from "../../src/services/alertDependencyPathService.js";

const alert = {
  assetId: "plc",
  assetHostname: "PLC-7",
  dependencyDown: true,
  dependencyBlame: { chain: [{ id: "sw", hostname: "SW-1", reason: "down" }], hops: 1 },
  testRun: false,
};
const codesOf = async () => {
  const spec = await loadDependencyPath(alert);
  return spec!.entries.flatMap((e) => (e.kind === "node" ? [[e.node.hostname, e.node.codes]] : []));
};

beforeEach(() => sites.clear());

describe("dependency path through the region tree", () => {
  it("expands a short code to its chain on the device's site", async () => {
    sites.set("sw", "site-1");
    sites.set("plc", "site-1");
    const [sw, plc] = await codesOf();
    expect(sw[1]).toMatchObject({ building: "Shop", room: "Closet", rack: "rack1" });
    // A junction box the tree doesn't know is named, so it stays as written.
    expect(plc[1]).toMatchObject({ building: null, junctionBox: "JB-3" });
  });

  it("keeps codes as written when no site places the device or its tree is empty", async () => {
    sites.set("sw", "site-empty");
    const [sw, plc] = await codesOf();
    expect(sw[1]).toMatchObject({ building: null, rack: "rack1" });
    expect(plc[1]).toMatchObject({ junctionBox: "JB-3" });
  });
});

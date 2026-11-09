/**
 * tests/unit/searchAssetFilter.test.ts — the global search gear's asset
 * filter (`SearchAssetFilter` in src/services/searchService.ts).
 *
 * Pinned: an absent field narrows nothing (the API's and the phone's search
 * are unchanged), an empty list matches nothing, the filter reaches every
 * asset lookup the search makes — including the Device Map group and the
 * side-table joins — and a thumbprint match is exempt from it.
 *
 * The database is mocked; what is pinned is the `where` each lookup is given.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    $queryRaw: vi.fn(async () => []),
    assetIpsecConnection: { findMany: vi.fn(async () => []) },
    ipBlock: { findMany: vi.fn(async () => []) },
    subnet: { findMany: vi.fn(async () => []) },
    reservation: { findMany: vi.fn(async () => []) },
    asset: { findMany: vi.fn(async (_args?: any): Promise<any[]> => []) },
    assetSource: { findMany: vi.fn(async () => []) },
    assetMacAddress: { findMany: vi.fn(async () => []) },
    assetAssociatedIp: { findMany: vi.fn(async () => []) },
    assetIpHistory: { findMany: vi.fn(async () => []) },
    assetFortigateSighting: { findMany: vi.fn(async () => []) },
    assetDependencyParent: { findMany: vi.fn(async () => []) },
  },
  pins: vi.fn(async () => [] as unknown[]),
}));
vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/applicationMapService.js", () => ({ resolveIpsToAssets: vi.fn(async () => new Map()) }));
vi.mock("../../src/services/notificationService.js", () => ({ activeAlertSummaryByAsset: vi.fn(async () => new Map()) }));
vi.mock("../../src/services/discoveredHostnameService.js", () => ({ findAssetIdsByDiscoveredHostname: vi.fn(async () => new Map()) }));
vi.mock("../../src/services/agentHostPinService.js", () => ({ findAssetsByPinFingerprint: h.pins }));

import { searchAll, assetFilterWhere } from "../../src/services/searchService.js";

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.asset.findMany.mockImplementation(async () => []);
  h.pins.mockImplementation(async () => []);
});

describe("assetFilterWhere", () => {
  it("narrows nothing when no field is given", () => {
    expect(assetFilterWhere({})).toEqual({});
  });

  it("narrows nothing when both monitored and unmonitored are wanted", () => {
    expect(assetFilterWhere({ monitored: [true, false] })).toEqual({});
  });

  it("narrows to one side of monitored", () => {
    expect(assetFilterWhere({ monitored: [false] })).toEqual({ monitored: false });
    expect(assetFilterWhere({ monitored: [true] })).toEqual({ monitored: true });
  });

  it("an empty list is the empty set, not 'no filter'", () => {
    // `OR: []` is Prisma's match-nothing.
    expect(assetFilterWhere({ monitored: [], statuses: [] })).toEqual({
      OR: [], status: { in: [] },
    });
  });

  it("narrows to the chosen device states", () => {
    expect(assetFilterWhere({ statuses: ["active", "maintenance"] })).toEqual({
      status: { in: ["active", "maintenance"] },
    });
  });
});

describe("searchAll — the asset filter reaches every asset lookup", () => {
  const FILTER = { monitored: [true], statuses: ["active", "maintenance"] as ("active" | "maintenance")[] };
  const WHERE = { monitored: true, status: { in: ["active", "maintenance"] } };

  it("the column scan of both the Assets and the Device Map groups", async () => {
    await searchAll("core-sw", undefined, FILTER);
    const wheres = h.prisma.asset.findMany.mock.calls.map((c: any[]) => c[0].where);
    const scans = wheres.filter((w: any) => w.AND);
    expect(scans).toHaveLength(2);
    for (const w of scans) expect(w).toMatchObject(WHERE);
    expect(scans.some((w: any) => w.assetType === "firewall")).toBe(true);
  });

  it("the source, MAC, IP and IP-history joins", async () => {
    await searchAll("10.1.1", undefined, FILTER);
    for (const m of [h.prisma.assetSource, h.prisma.assetMacAddress, h.prisma.assetAssociatedIp, h.prisma.assetIpHistory]) {
      for (const c of m.findMany.mock.calls as any[][]) expect(c[0].where.asset).toMatchObject(WHERE);
    }
  });

  it("leaves every lookup unfiltered when no filter is passed", async () => {
    await searchAll("core-sw");
    const wheres = h.prisma.asset.findMany.mock.calls.map((c: any[]) => c[0].where);
    for (const w of wheres) {
      expect(w.monitored).toBeUndefined();
      expect(w.status).toBeUndefined();
    }
  });

  it("the tag scope returns nothing without querying when a list is empty", async () => {
    const res = await searchAll("tag:plant", undefined, { statuses: [] });
    expect(res.assets).toEqual([]);
    // Blocks + subnets still scan by tag; the asset scan never runs.
    expect(h.prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("a thumbprint match is exempt — archived pins belong to decommissioned assets", async () => {
    h.pins.mockImplementation(async () => [{ assetId: "A1", kind: "ssh", host: "srv", port: 22, archived: true }]);
    h.prisma.asset.findMany.mockImplementation(async (args: any) =>
      args?.where?.id?.in?.includes("A1") && !args.where.status
        ? [{ id: "A1", hostname: "old-srv", ipAddress: null, macAddress: null, assetTag: null, assetType: "server",
             manufacturer: null, model: null, monitored: false, monitorStatus: null, status: "decommissioned" }]
        : []);
    const res = await searchAll("SHA256:abcdef", { blocks: true, subnets: true, reservations: true, assets: true, sites: true, pins: true }, FILTER);
    expect(res.assets.map((a) => a.id)).toEqual(["A1"]);
  });
});

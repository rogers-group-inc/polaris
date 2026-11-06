/**
 * tests/unit/mapSitesService.test.ts — the Device Map's site reads
 * (services/mapSitesService.ts, lifted out of routes/map.ts by CQ-B044).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  asset: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
  subnet: { groupBy: vi.fn() },
}));
const topo = vi.hoisted(() => ({
  fetchRecentSampleStats: vi.fn(),
  monitorStatusToHealth: vi.fn((s: string | null) => (s === "down" ? "down" : "up")),
  buildSiteEndpointAttribution: vi.fn(),
  attributeEndpointToSiteSwitch: vi.fn(),
  portOfLastSeenSwitch: vi.fn(() => "port7"),
}));
const downAck = vi.hoisted(() => vi.fn());

vi.mock("../../src/db.js", () => ({ prisma: db }));
vi.mock("../../src/services/topologyGraphService.js", () => topo);
vi.mock("../../src/services/nocDashboardService.js", () => ({ downAlertAcknowledgedByAsset: downAck }));

const svc = await import("../../src/services/mapSitesService.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listMapSites", () => {
  it("adds subnet count, health, sample counts and down-alert acknowledgement per site", async () => {
    db.asset.findMany.mockResolvedValue([
      { id: "g1", hostname: "HQ", monitored: true, monitorStatus: "down", createdBy: "a", tags: [] },
      { id: "g2", hostname: "BR", monitored: false, monitorStatus: null, createdBy: null, tags: [] },
    ]);
    topo.fetchRecentSampleStats.mockResolvedValue(new Map([["g1", { samples: 10, failures: 4 }]]));
    downAck.mockResolvedValue(new Map([["g1", true]]));
    db.subnet.groupBy.mockResolvedValue([{ fortigateDevice: "HQ", _count: { _all: 3 } }]);

    const out = await svc.listMapSites([]);
    expect(topo.fetchRecentSampleStats).toHaveBeenCalledWith(["g1"]);
    expect(downAck).toHaveBeenCalledWith(["g1"]);
    expect(out[0]).toMatchObject({
      id: "g1", subnetCount: 3, monitorHealth: "down", monitorRecentSamples: 10, monitorRecentFailures: 4, alertAcknowledged: true,
    });
    expect(out[1]).toMatchObject({ id: "g2", subnetCount: 0, monitorHealth: null, monitorRecentSamples: 0 });
    expect(out[1]).not.toHaveProperty("alertAcknowledged");
  });

  it("narrows to region:<name> tags when names are given", async () => {
    db.asset.findMany.mockResolvedValue([]);
    topo.fetchRecentSampleStats.mockResolvedValue(new Map());
    downAck.mockResolvedValue(new Map());
    await svc.listMapSites(["East", "West"]);
    expect(db.asset.findMany.mock.calls[0][0].where.tags).toEqual({ hasSome: ["region:East", "region:West"] });
    expect(db.subnet.groupBy).not.toHaveBeenCalled();
  });
});

describe("getSiteLayoutOwner", () => {
  it("reads only the fields rule 141 (e) judges on", async () => {
    db.asset.findUnique.mockResolvedValue({ createdBy: "a", tags: ["x"] });
    expect(await svc.getSiteLayoutOwner("g1")).toEqual({ createdBy: "a", tags: ["x"] });
    expect(db.asset.findUnique).toHaveBeenCalledWith({ where: { id: "g1" }, select: { createdBy: true, tags: true } });
  });
});

describe("searchSiteEndpoints", () => {
  it("404s when the id is not a live firewall", async () => {
    db.asset.findFirst.mockResolvedValue({ id: "s1", assetType: "switch", hostname: "SW", serialNumber: null, fortinetTopology: null });
    await expect(svc.searchSiteEndpoints("s1", "pc")).rejects.toMatchObject({ httpStatus: 404 });
    db.asset.findFirst.mockResolvedValue(null);
    await expect(svc.searchSiteEndpoints("x", "pc")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("returns no results when the site's switches attribute nothing", async () => {
    db.asset.findFirst.mockResolvedValue({ id: "g1", assetType: "firewall", hostname: "HQ", serialNumber: "FG1", fortinetTopology: null });
    db.asset.findMany.mockResolvedValue([]);
    topo.buildSiteEndpointAttribution.mockResolvedValue({ whereOr: [], edgeSelect: {} });
    expect(await svc.searchSiteEndpoints("g1", "pc")).toEqual({ q: "pc", results: [] });
  });

  it("names the resolved switch and port on each hit", async () => {
    db.asset.findFirst.mockResolvedValue({ id: "g1", assetType: "firewall", hostname: "HQ", serialNumber: "FG1", fortinetTopology: null });
    db.asset.findMany
      .mockResolvedValueOnce([{ id: "sw1", hostname: "IDF-1" }])
      .mockResolvedValueOnce([{ id: "e1", hostname: "PC1", ipAddress: "10.0.0.5", macAddress: null, assetType: "workstation", assignedTo: null, lastSeenSwitch: "IDF-1/port7", lastSeen: null }]);
    topo.buildSiteEndpointAttribution.mockResolvedValue({ whereOr: [{ id: "x" }], edgeSelect: {} });
    topo.attributeEndpointToSiteSwitch.mockReturnValue("sw1");
    const out = await svc.searchSiteEndpoints("g1", "pc");
    expect(out.results[0]).toMatchObject({ id: "e1", switchId: "sw1", switchHostname: "IDF-1", port: "port7" });
  });
});

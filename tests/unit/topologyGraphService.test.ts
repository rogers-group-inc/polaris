/**
 * tests/unit/topologyGraphService.test.ts — own suite for the Device Map
 * graph builder (CQ-T010).
 *
 * Complements, does not repeat:
 *   - topologyEndpointAttribution.test.ts — attributeEndpointToSiteSwitch, portOfLastSeenSwitch
 *   - topologyLldpSwitchLinks / topologyLastKnownLinks — lldpOnlySwitchLinks
 *   - topologyMeshLinkDetail — meshLinkDetail, latestOpticsByPort
 *   - topologyPhysicalLabels — isLogicalInterfaceName, physicalLabelHalf
 *   - seedTopologyFromExport — the full buildSiteTopology round trip through
 *     the renderer (links, ports, speeds, boxes of an exported site)
 *
 * Unreached until now: buildSiteEndpointAttribution (rule 91: only a
 * fleet-unique switch name may attribute by lastSeenSwitch prefix),
 * monitorStatusToHealth, fetchRecentSampleStats (the fixed 10-sample traffic
 * light, response-time probes only), and buildSiteTopology's own contracts:
 * the 404, sibling lookup by the controller STAMP (serial / FMG device name /
 * hostname — never hostname alone), the FG→switch and AP edges with the
 * FortiGate fallback, endpoints attributed to a site switch, and the rule 153 /
 * 168 location resolution with its conflict list.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/deviceIconService.js", async (orig) => ({
  ...(await orig<object>()),
  loadIconResolutionCache: vi.fn(async () => ({})),
  resolveIconUrl: vi.fn(() => null),
}));
vi.mock("../../src/services/interfaceTopologyService.js", async (orig) => ({
  ...(await orig<object>()),
  inferInterfaceTopology: vi.fn(async () => ({ edges: [], remoteAssets: new Map(), darkAssetIds: new Set() })),
}));
vi.mock("../../src/services/fibreChannelService.js", async (orig) => ({
  ...(await orig<object>()),
  getFcLoginsForSwitches: vi.fn(async () => []),
}));
vi.mock("../../src/services/topologyLayoutService.js", async (orig) => ({
  ...(await orig<object>()),
  getLayoutsForSite: vi.fn(async () => ({ flat: { view: "flat" } })),
}));
vi.mock("../../src/services/regionTreeService.js", async (orig) => {
  const real = await orig<typeof import("../../src/services/regionTreeService.js")>();
  return { ...real, loadRegionIndex: vi.fn(async () => real.buildRegionIndex([])) };
});

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  buildSiteEndpointAttribution,
  monitorStatusToHealth,
  fetchRecentSampleStats,
  buildSiteTopology,
} from "../../src/services/topologyGraphService.js";

let siblings: any[];
let endpoints: any[];
let standbys: any[];
let uniqueHosts: string[];

beforeEach(() => {
  resetDbStub();
  siblings = [];
  endpoints = [];
  standbys = [];
  uniqueHosts = [];
  for (const m of [
    "assetApRadio", "assetHardwareSensorSample", "assetInterface", "assetLldpNeighbor",
    "assetMclagPeer", "assetMonitorSample", "assetWirelessStation", "subnet",
  ]) stubbed((prisma as any)[m].findMany).mockResolvedValue([]);
  stubbed(prisma.asset.findMany).mockImplementation(async ({ where }: any = {}) => {
    if (Array.isArray(where?.OR) && where.OR.some((c: any) => c.assetType === "switch")) return siblings;
    if (where?.assetType?.notIn) return endpoints;
    if (where?.assetType === "firewall") return standbys;
    return [];
  });
  stubbed(prisma.$queryRaw).mockImplementation(async (strings: TemplateStringsArray) =>
    strings.join("?").includes("HAVING COUNT(*) = 1") ? uniqueHosts.map((host) => ({ host })) : []);
});

// ─── pure-ish exports ───────────────────────────────────────────────────────

describe("monitorStatusToHealth", () => {
  it("maps the monitor state machine onto the map's traffic light, passive its own colour", () => {
    expect(monitorStatusToHealth("up")).toBe("up");
    expect(monitorStatusToHealth("warning")).toBe("degraded");
    expect(monitorStatusToHealth("recovering")).toBe("degraded");
    expect(monitorStatusToHealth("down")).toBe("down");
    expect(monitorStatusToHealth("passive")).toBe("passive");
    expect(monitorStatusToHealth("pending")).toBe("unknown");
    expect(monitorStatusToHealth(null)).toBe("unknown");
  });
});

describe("fetchRecentSampleStats", () => {
  const samples = (ok: boolean[]) => ok.map((success) => ({ success }));

  it("reads the last 10 response-time samples only — never the loss sweep's rows", async () => {
    stubbed(prisma.assetMonitorSample.findMany).mockResolvedValue([]);
    await fetchRecentSampleStats(["a1"]);
    expect(stubbed(prisma.assetMonitorSample.findMany).mock.calls[0][0]).toMatchObject({
      where: { assetId: "a1", OR: [{ probeKind: null }, { probeKind: "primary" }] },
      orderBy: { timestamp: "desc" },
      take: 10,
    });
  });

  it("grades the window: all failed of 10 is down, any failure degraded, none up, nothing unknown", async () => {
    stubbed(prisma.assetMonitorSample.findMany).mockImplementation(async ({ where }: any) => ({
      down: samples(Array(10).fill(false)),
      short: samples([false, false, false]), // < 10 all failed — not enough to say down
      lossy: samples([true, false, true, true]),
      up: samples([true, true]),
      none: [],
    } as Record<string, unknown>)[where.assetId]);
    const out = await fetchRecentSampleStats(["down", "short", "lossy", "up", "none"]);
    expect(out.get("down")).toEqual({ samples: 10, failures: 10, health: "down" });
    expect(out.get("short")!.health).toBe("degraded");
    expect(out.get("lossy")).toEqual({ samples: 4, failures: 1, health: "degraded" });
    expect(out.get("up")!.health).toBe("up");
    expect(out.get("none")).toEqual({ samples: 0, failures: 0, health: "unknown" });
  });
});

describe("buildSiteEndpointAttribution (rule 91)", () => {
  it("trusts a lastSeenSwitch prefix only for a name unique among switches fleet-wide", async () => {
    uniqueHosts = ["core-sw"]; // "IDF-1" exists at several sites
    const a = await buildSiteEndpointAttribution([
      { id: "s1", hostname: "Core-SW" },
      { id: "s2", hostname: "IDF-1" },
      { id: "s3", hostname: null },
    ]);
    expect(a.siteSwitchIds).toEqual(["s1", "s2", "s3"]);
    expect(a.uniqueHostnames).toEqual(["Core-SW"]);
    expect([...a.switchIdByUniqueHost]).toEqual([["core-sw", "s1"]]);
    expect(a.whereOr).toEqual([
      { dependencyParents: { some: { parentAssetId: { in: ["s1", "s2", "s3"] }, source: "endpoint", detectedVia: "switch-port" } } },
      { lastSeenSwitch: { startsWith: "Core-SW/" } },
    ]);
    // The uniqueness query is asked about the lower-cased names, once each.
    expect(stubbed(prisma.$queryRaw).mock.calls[0][1]).toEqual(["core-sw", "idf-1"]);
  });

  it("two site switches sharing one unique name do not both claim it", async () => {
    uniqueHosts = ["dup"];
    const a = await buildSiteEndpointAttribution([{ id: "x", hostname: "dup" }, { id: "y", hostname: "DUP" }]);
    expect([...a.switchIdByUniqueHost]).toEqual([["dup", "x"]]);
    expect(a.uniqueHostnames).toEqual(["dup"]);
  });

  it("asks nothing and can place nothing with no switches", async () => {
    const a = await buildSiteEndpointAttribution([]);
    expect(a.whereOr).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

// ─── buildSiteTopology ──────────────────────────────────────────────────────

const FG = {
  id: "fg", hostname: "HQ-FW", serialNumber: "FG100FTK0001", manufacturer: "Fortinet", model: "FG-100F",
  ipAddress: "10.0.0.1", status: "active", lastSeen: null, latitude: 1, longitude: 2, assetType: "firewall",
  fortinetTopology: { role: "fortigate", deviceName: "FMG-HQ" }, monitored: false, dependencyLayer: null,
  dependencySuppressed: false, notes: "f:9 operator notes never place a device", description: null,
};

function sw(id: string, hostname: string, topo: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    id, hostname, serialNumber: `S-${id}`, manufacturer: "Fortinet", model: "FS-148F", ipAddress: null,
    status: "active", assetType: "switch", fortinetTopology: { controllerFortigate: "FMG-HQ", uplinkInterface: "fortilink", ...topo },
    learnedLocation: null, lastSeen: null, monitored: true, monitorStatus: "up", dependencyLayer: null,
    dependencySuppressed: false, notes: null, description: null, ...over,
  };
}
function ap(id: string, hostname: string, topo: Record<string, unknown> = {}) {
  return { ...sw(id, hostname, topo), assetType: "access_point", model: "FAP-231F" };
}

describe("buildSiteTopology", () => {
  it("404s an id that is not a live FortiGate", async () => {
    stubbed(prisma.asset.findFirst).mockResolvedValue(null);
    await expect(buildSiteTopology("x")).rejects.toMatchObject({ httpStatus: 404, message: "FortiGate not found" });
    stubbed(prisma.asset.findFirst).mockResolvedValue({ ...FG, assetType: "switch" });
    await expect(buildSiteTopology("x")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("a lone gate is a one-node graph carrying its saved layouts", async () => {
    stubbed(prisma.asset.findFirst).mockResolvedValue(FG);
    const t = await buildSiteTopology("fg");
    expect(t.fortigate).toMatchObject({ id: "fg", hostname: "HQ-FW", monitored: false, monitorHealth: null, location: null });
    expect(t.switches).toEqual([]);
    expect(t.aps).toEqual([]);
    expect(t.edges).toEqual([]);
    expect(t.endpoints).toEqual([]);
    expect(t.savedLayouts).toEqual({ flat: { view: "flat" } });
    expect(t.regionCount).toBe(0);
    expect(t.regionConflicts).toEqual([]);
  });

  it("finds its children by the controller stamp — serial, FMG device name and hostname", async () => {
    stubbed(prisma.asset.findFirst).mockResolvedValue(FG);
    await buildSiteTopology("fg");
    const siblingQuery = stubbed(prisma.asset.findMany).mock.calls.find((c) => Array.isArray(c[0]?.where?.OR))![0];
    const stamps = JSON.stringify(siblingQuery.where.AND);
    expect(stamps).toContain("FG100FTK0001");
    expect(stamps).toContain("FMG-HQ");
    expect(stamps).toContain("HQ-FW");
  });

  it("draws FG→switch from controller data, AP→switch from MAC learning, and an unpaired AP to the gate", async () => {
    stubbed(prisma.asset.findFirst).mockResolvedValue(FG);
    siblings = [
      sw("s1", "IDF-1", { uplinkPhysicalPort: "port52" }),
      ap("a1", "AP-1", { parentSwitch: "IDF-1", parentPort: "port8" }),
      ap("a2", "AP-2"),
      ap("a3", "AP-3", { parentSwitch: "IDF-1", parentPort: "port9", meshUplink: "mesh" }),
    ];
    const t = await buildSiteTopology("fg");
    const pairs = t.edges.map((e: any) => [e.source, e.target, e.label]);
    expect(pairs).toEqual(expect.arrayContaining([
      ["fg", "s1", "unknown ↔ port52"],
      ["s1", "a1", "port8 ↔ lan1"],
      ["fg", "a2", "unknown ↔ lan1"],
      // A mesh leaf's wired peer is not its uplink: it falls back to the gate.
      ["fg", "a3", "unknown ↔ lan1"],
    ]));
    expect(t.aps.find((a: any) => a.id === "a1")).toMatchObject({ peerSwitchId: "s1", peerPort: "port8" });
    expect(t.switches[0]).toMatchObject({ monitorHealth: "up", uplinkPhysicalPort: "port52" });
  });

  it("hangs endpoints off the switch their edge (or a unique name) places them on", async () => {
    stubbed(prisma.asset.findFirst).mockResolvedValue(FG);
    siblings = [sw("s1", "Core-SW")];
    uniqueHosts = ["core-sw"];
    endpoints = [
      { id: "e1", hostname: "pc1", ipAddress: "10.0.0.50", macAddress: "aa", assetType: "workstation", assignedTo: null,
        lastSeenSwitch: "Core-SW/port3", lastSeen: null, status: "active", monitored: true, monitorStatus: "down",
        description: null, manufacturer: null, model: null, dependencyParents: [] },
      { id: "e2", hostname: "elsewhere", ipAddress: null, macAddress: null, assetType: "printer", assignedTo: null,
        lastSeenSwitch: "IDF-9/port1", lastSeen: null, status: "active", monitored: false, monitorStatus: null,
        description: null, manufacturer: null, model: null, dependencyParents: [] },
    ];
    const t = await buildSiteTopology("fg");
    expect(t.endpoints).toEqual([expect.objectContaining({ id: "e1", switchId: "s1", port: "port3", monitorHealth: "down" })]);
    expect(t.endpointsTruncated).toBe(false);
    expect(t.switches[0].endpoints.map((e: any) => e.id)).toEqual(["e1"]);
  });

  it("reads location from Asset.description, else the device description — never the notes", async () => {
    stubbed(prisma.asset.findFirst).mockResolvedValue({ ...FG, description: "b:HQ f:2" });
    siblings = [
      sw("s1", "IDF-1", { deviceDescription: "b:HQ f:3 r:IDF" }),
      sw("s2", "IDF-2", { deviceDescription: "b:HQ f:3" }, { description: "b:Annex f:1" }),
    ];
    const t = await buildSiteTopology("fg");
    expect(t.fortigate.location).toMatchObject({ building: "HQ", floor: "2" });
    expect(t.switches[0].location).toMatchObject({ building: "HQ", floor: "3", room: "IDF" });
    expect(t.switches[1].location).toMatchObject({ building: "Annex", floor: "1" });
    // Stamped on by the rule 153 resolve pass, outside the as-written payload type.
    expect((t.switches[0] as { locationStatus?: string }).locationStatus).toBe("asWritten"); // an empty region tree changes nothing
  });

  it("lists an old text floor with the number to use (rule 168)", async () => {
    stubbed(prisma.asset.findFirst).mockResolvedValue(FG);
    siblings = [sw("s1", "IDF-1", { deviceDescription: "b:HQ f:Ground" })];
    const t = await buildSiteTopology("fg");
    expect(t.regionConflicts).toEqual([
      expect.objectContaining({ id: "s1", hostname: "IDF-1", status: "textFloor", floorNumber: null }),
    ]);
  });

  it("asks the monitor samples for the gate only when it is monitored", async () => {
    stubbed(prisma.asset.findFirst).mockResolvedValue({ ...FG, monitored: true });
    stubbed(prisma.assetMonitorSample.findMany).mockResolvedValue(Array(10).fill({ success: false }));
    const t = await buildSiteTopology("fg");
    expect(t.fortigate).toMatchObject({ monitorHealth: "down", monitorRecentSamples: 10, monitorRecentFailures: 10 });
  });

  it("only lists the gate's subnets when it has a hostname to match them by", async () => {
    stubbed(prisma.asset.findFirst).mockResolvedValue(FG);
    stubbed(prisma.subnet.findMany).mockResolvedValue([{ id: "n1", cidr: "10.0.0.0/24" }]);
    expect((await buildSiteTopology("fg")).subnets).toEqual([{ id: "n1", cidr: "10.0.0.0/24" }]);
    expect(stubbed(prisma.subnet.findMany).mock.calls[0][0].where).toEqual({ fortigateDevice: "HQ-FW" });

    stubbed(prisma.asset.findFirst).mockResolvedValue({ ...FG, hostname: null });
    stubbed(prisma.subnet.findMany).mockClear();
    expect((await buildSiteTopology("fg")).subnets).toEqual([]);
    expect(prisma.subnet.findMany).not.toHaveBeenCalled();
  });
});

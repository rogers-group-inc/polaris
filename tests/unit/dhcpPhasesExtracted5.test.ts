/**
 * tests/unit/dhcpPhasesExtracted5.test.ts — syncDhcpSubnets Phases 2a, 10 and
 * 11, now modules under src/services/discovery/dhcp/ (CQ-B060 slice 6). The
 * pure Phase 2a roster decisions keep their own suites
 * (rosterFirewallReplaced, haStandbyRosterIdentity, syncSweepPhaseGate); this
 * file pins the phase bodies around them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const db = {
  assetFindMany: stubbed(prisma.asset.findMany),
  assetUpdateMany: stubbed(prisma.asset.updateMany),
  assetUpdate: stubbed(prisma.asset.update),
  sourceFindMany: stubbed(prisma.assetSource.findMany),
};

const m = vi.hoisted(() => ({
  logEvent: vi.fn(),
  releaseForDecommission: vi.fn(),
  releaseInfra: vi.fn(),
  project: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: m.logEvent }));
vi.mock("../../src/services/maintenanceScheduleService.js", () => ({ releaseAssetsForDecommission: m.releaseForDecommission }));
vi.mock("../../src/services/reservationService.js", () => ({ releaseInfraReservationsForAssets: m.releaseInfra }));
vi.mock("../../src/utils/assetProjection.js", () => ({ projectAssetFromSources: m.project }));

const { decommissionStaleFirewalls } = await import("../../src/services/discovery/dhcp/staleFirewalls.js");
const { stampEndpointSources, applyEndpointProjection } = await import("../../src/services/discovery/dhcp/endpointSources.js");

const NOW = "2026-11-10T12:00:00.000Z";
beforeEach(() => {
  resetDbStub();
  vi.clearAllMocks();
  db.assetUpdateMany.mockResolvedValue({ count: 0 });
  db.assetUpdate.mockResolvedValue({});
  db.sourceFindMany.mockResolvedValue([]);
});

function index(rows: Array<Record<string, any>>) {
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  return { findById: (id: string) => byId.get(id) };
}

describe("Phase 2a — stale FortiGate decommission + cascade", () => {
  const base = (over: Record<string, unknown> = {}) => ({
    integrationId: "i1", integrationName: "FMG", integrationLabel: "FortiManager", actor: "system", now: NOW,
    scopedRun: false,
    knownDeviceNamesLc: new Set(["site-a-fw"]), knownFirewallSerials: new Set(["FGT60FAAA0000001"]),
    haRosterPublished: new Set<string>(), clusterSerialsByDevice: new Map<string, Set<string>>(),
    assetIdx: index([]) as never, decommissionedSwitches: [] as string[], decommissionedAps: [] as string[],
    ...over,
  });
  const fw = (id: string, hostname: string, serial: string) => ({ id, hostname, serialNumber: serial, fortinetTopology: null });

  it("decommissions a gate gone from the roster and cascades to the switches and APs it controlled", async () => {
    const idxRows = [{ id: "fw1", status: "active" }, { id: "sw1", status: "active" }, { id: "ap1", status: "active" }];
    db.assetFindMany
      .mockResolvedValueOnce([fw("fw1", "GONE-FW", "FGT60FGONE000001"), fw("fw2", "SITE-A-FW", "FGT60FAAA0000001")])
      .mockResolvedValueOnce([
        { id: "sw1", hostname: "sw-1", serialNumber: "S1", assetType: "switch", fortinetTopology: { controllerFortigate: "gone-fw" } },
        { id: "ap1", hostname: "ap-1", serialNumber: "A1", assetType: "access_point", fortinetTopology: { controllerFortigate: "GONE-FW" } },
        { id: "sw2", hostname: "sw-2", serialNumber: "S2", assetType: "switch", fortinetTopology: { controllerFortigate: "SITE-A-FW" } },
      ]);
    const input = base({ assetIdx: index(idxRows) });
    await decommissionStaleFirewalls(input);

    expect(db.assetUpdateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: { id: { in: ["fw1"] } } }));
    expect(db.assetUpdateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: { in: ["sw1", "ap1"] } },
      data: { status: "decommissioned", statusChangedAt: new Date(NOW), statusChangedBy: "FortiManager" },
    }));
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "asset.fortigate.decommissioned", details: expect.objectContaining({ reason: "missing-from-roster" }) }));
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "asset.fortiswitch.decommissioned", details: expect.objectContaining({ reason: "controller-decommissioned" }) }));
    expect(m.releaseInfra).toHaveBeenCalledWith(["sw1", "ap1"], expect.anything());
    expect(input.decommissionedSwitches).toEqual(["sw-1"]);
    expect(input.decommissionedAps).toEqual(["ap-1"]);
    // The run's snapshot follows the flips, so the Phase 3 resurrection clause can see them.
    expect(idxRows.map((r) => r.status)).toEqual(["decommissioned", "decommissioned", "decommissioned"]);
  });

  it("retires a replaced chassis without cascading — its name now belongs to the new gate (rule 41(a))", async () => {
    db.assetFindMany
      .mockResolvedValueOnce([fw("old", "SITE-A-FW", "FGT60FOLD0000001")])
      .mockResolvedValueOnce([{ id: "sw1", hostname: "sw-1", serialNumber: "S1", assetType: "switch", fortinetTopology: { controllerFortigate: "SITE-A-FW" } }]);
    await decommissionStaleFirewalls(base({
      clusterSerialsByDevice: new Map([["site-a-fw", new Set(["FGT60FAAA0000001"])]]),
    }));
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ reason: "chassis-replaced", oldSerial: "FGT60FOLD0000001" }) }));
    expect(db.assetUpdateMany).toHaveBeenCalledTimes(1);
    // The cascade query runs, and the new gate's switch under that same name is left alone.
    expect(db.assetFindMany).toHaveBeenCalledTimes(2);
    expect(m.releaseInfra).not.toHaveBeenCalled();
  });

  it("on a scoped run judges only the scoped gate's firewalls, and acts only on a replaced chassis (rule 142)", async () => {
    db.assetFindMany.mockResolvedValueOnce([fw("fw1", "GONE-FW", "FGT60FGONE000001")]);
    await decommissionStaleFirewalls(base({ scopedRun: true, clusterSerialsByDevice: new Map([["gone-fw", new Set(["FGT60FGONE000001"])]]) }));
    expect(db.assetUpdateMany).not.toHaveBeenCalled();
    expect(m.logEvent).not.toHaveBeenCalled();
  });
});

describe("Phase 10 — fortigate-endpoint AssetSource flush", () => {
  const run = (over: Record<string, unknown> = {}) => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const state = {
      fortigateEndpointAssetIds: new Set(["e1", "e2", "nomac"]),
      fortigateEndpointDeviceByAsset: new Map([["e1", "FGT-PATH"]]),
      allSubnets: [{ cidr: "10.1.0.0/24", status: "active", fortigateDevice: "FGT-NET" }],
      assetIdx: index([
        { id: "e1", macAddress: "AA:AA:AA:AA:AA:01", ipAddress: "10.1.0.5", lastSeen: null },
        { id: "e2", macAddress: "AA:AA:AA:AA:AA:02", ipAddress: "192.0.2.9", lastSeen: null },
        { id: "nomac", macAddress: null, ipAddress: "10.1.0.7", lastSeen: null },
      ]) as never,
      integrationId: "i1", integrationName: "FMG", integrationType: "fortimanager", now: NOW,
      upsertFortigateEndpointSource: upsert, syncLog: vi.fn(),
      ...over,
    };
    return { state, upsert };
  };

  it("names the gate whose network holds the address, then the pathway's gate, then the row's prior one (rule 101(b))", async () => {
    db.sourceFindMany.mockResolvedValue([{ assetId: "e2", observed: { learnedLocation: "FGT-PRIOR" } }]);
    const { state, upsert } = run();
    const stamped = await stampEndpointSources(state);
    expect(stamped).toBe(2);
    const gateOf = (id: string) => upsert.mock.calls.find((c) => c[0] === id)?.[6];
    expect(gateOf("e1")).toBe("FGT-NET");
    expect(gateOf("e2")).toBe("FGT-PRIOR");
    expect(upsert.mock.calls.some((c) => c[0] === "nomac")).toBe(false);
    expect(upsert).toHaveBeenCalledWith("e1", "i1", expect.anything(), "fortimanager", new Date(NOW), "FMG", "FGT-NET");
  });

  it("counts and logs a failed upsert without throwing", async () => {
    const { state, upsert } = run();
    upsert.mockImplementation(async (id: string) => { if (id === "e1") throw new Error("boom"); });
    expect(await stampEndpointSources(state)).toBe(1);
    expect(state.syncLog).toHaveBeenCalledWith("error", "fortigate-endpoint AssetSource: stamped 1, 1 failed");
  });

  it("does nothing when the run touched no endpoint", async () => {
    const { state, upsert } = run({ fortigateEndpointAssetIds: new Set<string>() });
    expect(await stampEndpointSources(state)).toBe(0);
    expect(db.sourceFindMany).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("Phase 11 — projection apply pass", () => {
  const nothing = { hostname: null, os: null, osVersion: null, manufacturer: null, model: null, learnedLocation: null, ipAddress: null, serialNumber: null };
  const run = (rows: Array<Record<string, any>>) => ({
    fortigateEndpointAssetIds: new Set(rows.map((r) => r.id as string)),
    assetIdx: index(rows) as never, integrationType: "fortimanager",
    noteChangeBaseline: vi.fn(), syncLog: vi.fn(),
  });

  it("writes only the fields the projection disagrees with, baselining os / osVersion first", async () => {
    const asset = { id: "e1", hostname: "pc-1", os: "Windows", osVersion: "10.0", ipAddress: "10.1.0.5" };
    db.sourceFindMany.mockResolvedValue([{ assetId: "e1", sourceKind: "intune", inferred: false, observed: {}, lastSeen: null }]);
    m.project.mockReturnValue({ projected: { ...nothing, hostname: "pc-1", osVersion: "10.0.19045" } });
    const state = run([asset]);
    expect(await applyEndpointProjection(state)).toBe(1);
    expect(m.project).toHaveBeenCalledWith([{ sourceKind: "intune", inferred: false, observed: {}, lastSeen: null }]);
    expect(state.noteChangeBaseline).toHaveBeenCalledWith(asset, ["osVersion"]);
    expect(db.assetUpdate).toHaveBeenCalledWith({ where: { id: "e1" }, data: { osVersion: "10.0.19045" } });
    expect(asset.osVersion).toBe("10.0.19045");
  });

  it("an address correction re-tags ipSource; a primary-address pin keeps its address (rule 102)", async () => {
    m.project.mockReturnValue({ projected: { ...nothing, ipAddress: "10.1.0.99" } });
    await applyEndpointProjection(run([{ id: "free", ipAddress: "10.1.0.5" }, { id: "pinned", ipAddress: "10.1.0.6", primaryAddressIp: "10.1.0.6" }]));
    expect(db.assetUpdate).toHaveBeenCalledTimes(1);
    expect(db.assetUpdate).toHaveBeenCalledWith({ where: { id: "free" }, data: { ipAddress: "10.1.0.99", ipSource: "fortimanager:fortigate-endpoint" } });
  });

  it("an IP override the projection agrees with is staged so the pin can release", async () => {
    m.project.mockReturnValue({ projected: { ...nothing, ipAddress: "10.1.0.6" } });
    await applyEndpointProjection(run([{ id: "o1", ipAddress: "10.1.0.6", ipOverride: "10.1.0.6" }]));
    expect(db.assetUpdate).toHaveBeenCalledWith({ where: { id: "o1" }, data: { ipAddress: "10.1.0.6", ipSource: "fortimanager:fortigate-endpoint" } });
  });

  it("a quiet sync writes nothing", async () => {
    m.project.mockReturnValue({ projected: { ...nothing, hostname: "pc-1" } });
    const state = run([{ id: "e1", hostname: "pc-1" }]);
    expect(await applyEndpointProjection(state)).toBe(0);
    expect(db.assetUpdate).not.toHaveBeenCalled();
    expect(state.syncLog).not.toHaveBeenCalled();
  });
});

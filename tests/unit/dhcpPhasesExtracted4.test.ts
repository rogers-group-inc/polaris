/**
 * tests/unit/dhcpPhasesExtracted4.test.ts — syncDhcpSubnets Phases 2b and 7.5,
 * now modules under src/services/discovery/dhcp/ (CQ-B060 slice 5). The pure
 * Phase 2b decisions keep their own suite in syncSweepPhaseGate.test.ts; this
 * file pins the phase bodies around them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  logEvent: vi.fn(),
  releaseForDecommission: vi.fn(),
  releaseInfra: vi.fn(),
  reconcileAddresses: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({
  prisma: { asset: { findMany: m.findMany, updateMany: m.updateMany, update: m.update } },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: m.logEvent }));
vi.mock("../../src/services/maintenanceScheduleService.js", () => ({ releaseAssetsForDecommission: m.releaseForDecommission }));
vi.mock("../../src/services/reservationService.js", () => ({ releaseInfraReservationsForAssets: m.releaseInfra }));
vi.mock("../../src/services/assetAddressService.js", () => ({ reconcileDiscoveredAddresses: m.reconcileAddresses }));

const { decommissionStaleManagedDevices } = await import("../../src/services/discovery/dhcp/staleManagedDevices.js");
const { enrichFromSwitchMacAndArp } = await import("../../src/services/discovery/dhcp/switchArpEnrichment.js");
const { createDhcpClaimState } = await import("../../src/utils/dhcpClaimFreshness.js");

const NOW = "2026-11-10T12:00:00.000Z";
beforeEach(() => {
  vi.clearAllMocks();
  m.updateMany.mockResolvedValue({ count: 0 });
  m.update.mockResolvedValue({});
  m.reconcileAddresses.mockResolvedValue({ upserted: 0, pruned: 0 });
});

describe("Phase 2b — stale FortiSwitch / FortiAP decommission", () => {
  const base = (over: Record<string, unknown> = {}) => ({
    result: { devices: [{ name: "SITE-A-FW", serial: "FG100FTK20000001" }] } as never,
    integrationId: "i1", integrationName: "FMG", integrationLabel: "FortiManager", actor: "system", now: NOW,
    rosterJudgeable: true,
    knownDeviceNamesLc: new Set(["site-a-fw"]), knownFirewallSerials: new Set(["FG100FTK20000001"]),
    switchInventoriedDevices: new Set(["SITE-A-FW"]), apInventoriedDevices: new Set<string>(),
    seenSwitchSerials: new Set<string>(), seenApSerials: new Set<string>(),
    seenSwitchHostnamesByController: new Map<string, Set<string>>(), seenApHostnamesByController: new Map<string, Set<string>>(),
    cmdbSwitchSerialsByDevice: new Map<string, Set<string>>(), cmdbApSerialsByDevice: new Map<string, Set<string>>(),
    decommissionedSwitches: [] as string[], decommissionedAps: [] as string[],
    ...over,
  });
  const sw = (id: string, serial: string | null, topo: Record<string, unknown>, hostname = `sw-${id}`) =>
    ({ id, hostname, serialNumber: serial, assetType: "switch", fortinetTopology: topo, status: "active" });

  it("decommissions a switch its inventoried controller no longer reports, and releases its holds and address", async () => {
    m.findMany.mockResolvedValue([sw("a1", "S1", { controllerFortigate: "SITE-A-FW" })]);
    const input = base();
    await decommissionStaleManagedDevices(input);
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1"] } },
      data: { status: "decommissioned", statusChangedAt: new Date(NOW), statusChangedBy: "FortiManager" },
    });
    expect(m.releaseForDecommission).toHaveBeenCalledWith(["a1"], expect.objectContaining({ statusChangedBy: "FortiManager" }));
    expect(m.releaseInfra).toHaveBeenCalledWith(["a1"], expect.objectContaining({ actor: "system" }));
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "asset.fortiswitch.decommissioned",
      details: expect.objectContaining({ reason: "missing-from-controller", controllerFortigate: "SITE-A-FW" }),
    }));
    expect(input.decommissionedSwitches).toEqual(["sw-a1"]);
  });

  it("spares a switch whose serial was seen, or that its controller's CMDB still holds", async () => {
    m.findMany.mockResolvedValue([
      sw("a1", "S1", { controllerFortigate: "SITE-A-FW" }),
      sw("a2", "S2", { controllerFortigate: "SITE-A-FW" }),
    ]);
    await decommissionStaleManagedDevices(base({
      seenSwitchSerials: new Set(["S1"]),
      cmdbSwitchSerialsByDevice: new Map([["site-a-fw", new Set(["S2"])]]),
    }));
    expect(m.updateMany).not.toHaveBeenCalled();
    expect(m.logEvent).not.toHaveBeenCalled();
  });

  it("judges a switch under its gate's CURRENT name when the gate was renamed (rule 41(b))", async () => {
    m.findMany.mockResolvedValue([sw("a1", "S1", { controllerFortigate: "OLD-NAME", controllerSerial: "FG100FTK20000001" })]);
    await decommissionStaleManagedDevices(base());
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('controller "SITE-A-FW" (formerly "OLD-NAME")'),
      details: expect.objectContaining({ renamedFrom: "OLD-NAME" }),
    }));
  });

  it("decommissions an orphan only when the run read the whole roster and no gate reports it", async () => {
    const orphan = sw("a1", "S1", { controllerFortigate: "GONE-FW" });
    m.findMany.mockResolvedValue([orphan]);
    await decommissionStaleManagedDevices(base({ rosterJudgeable: false }));
    expect(m.updateMany).not.toHaveBeenCalled();

    m.findMany.mockResolvedValue([orphan]);
    await decommissionStaleManagedDevices(base({ seenSwitchSerials: new Set(["S1"]) }));
    expect(m.updateMany).not.toHaveBeenCalled();

    m.findMany.mockResolvedValue([orphan]);
    await decommissionStaleManagedDevices(base());
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ reason: "controller-not-in-roster", controllerFortigate: "GONE-FW" }),
    }));
    expect(m.updateMany).toHaveBeenCalledTimes(1);
  });

  it("records an AP under the FortiAP event and the AP list", async () => {
    m.findMany.mockResolvedValue([{ ...sw("p1", "AP1", { controllerFortigate: "SITE-A-FW" }, "ap-1"), assetType: "access_point" }]);
    const input = base({ switchInventoriedDevices: new Set<string>(), apInventoriedDevices: new Set(["SITE-A-FW"]) });
    await decommissionStaleManagedDevices(input);
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "asset.fortiap.decommissioned" }));
    expect(input.decommissionedAps).toEqual(["ap-1"]);
    expect(input.decommissionedSwitches).toEqual([]);
  });
});

describe("Phase 7.5 — FortiSwitch MAC table + FortiGate ARP enrichment", () => {
  type A = { id: string; assetType: string; ipAddress: string | null; lastSeenSwitch: string | null; learnedLocation?: string | null; macAddresses?: unknown };
  function index(assets: Array<A & { mac: string }>) {
    const byMac = new Map(assets.map((a) => [a.mac.toUpperCase(), a]));
    const byId = new Map(assets.map((a) => [a.id, a]));
    return {
      findByMac: (mac: string) => byMac.get(mac.toUpperCase()),
      findById: (id: string) => byId.get(id),
      reindex: vi.fn(),
    };
  }
  const run = (result: Record<string, unknown>, idx: ReturnType<typeof index>, extra: Record<string, unknown> = {}) => {
    const state = {
      result: result as never, now: NOW, assetIdx: idx as never, claims: createDhcpClaimState(),
      addressSightings: [] as any[], fortigateEndpointAssetIds: new Set<string>(),
      noteChangeBaseline: vi.fn(), noteEndpointGate: vi.fn(), syncLog: vi.fn(),
      ...extra,
    };
    return { state, done: enrichFromSwitchMacAndArp(state as never) };
  };

  it("stamps the endpoint's access port, not the trunk that also learned its MAC", async () => {
    const idx = index([
      { id: "pc", mac: "AA:AA:AA:AA:AA:01", assetType: "workstation", ipAddress: "10.1.0.5", lastSeenSwitch: null },
      { id: "pc2", mac: "AA:AA:AA:AA:AA:02", assetType: "workstation", ipAddress: "10.1.0.6", lastSeenSwitch: null },
    ]);
    const { state, done } = run({
      switchMacTable: [
        { mac: "aa:aa:aa:aa:aa:01", switchId: "SW1", portName: "trunk1", fortigateDevice: "FGT-A" },
        { mac: "aa:aa:aa:aa:aa:02", switchId: "SW1", portName: "trunk1", fortigateDevice: "FGT-A" },
        { mac: "aa:aa:aa:aa:aa:01", switchId: "SW2", portName: "port7", fortigateDevice: "FGT-A" },
        { mac: "aa:aa:aa:aa:aa:01", switchId: "SW1", portName: "fortilink", fortigateDevice: "FGT-A", isFortilinkPeer: true },
      ],
    }, idx);
    await done;
    expect(idx.findById("pc")!.lastSeenSwitch).toBe("SW2/port7");
    expect(m.update).toHaveBeenCalledWith({ where: { id: "pc" }, data: { lastSeenSwitch: "SW2/port7" } });
    expect(state.noteChangeBaseline).toHaveBeenCalledWith(idx.findById("pc"), ["lastSeenSwitch"]);
    expect(state.noteEndpointGate).toHaveBeenCalledWith("pc", "FGT-A");
    expect(state.fortigateEndpointAssetIds.has("pc")).toBe(true);
  });

  it("never stamps a managed switch or FortiGate from the MAC table", async () => {
    const idx = index([{ id: "fsw", mac: "BB:BB:BB:BB:BB:01", assetType: "switch", ipAddress: null, lastSeenSwitch: null }]);
    const { done } = run({ switchMacTable: [{ mac: "BB:BB:BB:BB:BB:01", switchId: "SW1", portName: "port1", fortigateDevice: "FGT-A" }] }, idx);
    await done;
    expect(m.update).not.toHaveBeenCalled();
  });

  it("ARP fills an EMPTY address and records every binding as a sighting, but never overwrites one with no ladder claim", async () => {
    const idx = index([
      { id: "empty", mac: "CC:CC:CC:CC:CC:01", assetType: "workstation", ipAddress: null, lastSeenSwitch: null },
      { id: "held", mac: "CC:CC:CC:CC:CC:02", assetType: "workstation", ipAddress: "10.1.0.20", lastSeenSwitch: null },
    ]);
    const { state, done } = run({
      arpTable: [
        { mac: "cc:cc:cc:cc:cc:01", ip: "10.1.0.10", fortigateDevice: "FGT-A" },
        { mac: "CC:CC:CC:CC:CC:02", ip: "10.1.0.21", fortigateDevice: "FGT-A" },
      ],
      arpQueriedDevices: ["FGT-A"],
    }, idx);
    await done;
    expect(idx.findById("empty")!.ipAddress).toBe("10.1.0.10");
    expect(m.update).toHaveBeenCalledWith({ where: { id: "empty" }, data: { ipAddress: "10.1.0.10", ipSource: "FGT-A:arp" } });
    expect(idx.findById("held")!.ipAddress).toBe("10.1.0.20");
    expect(state.addressSightings.map((s) => [s.assetId, s.mac, s.ip, s.source])).toEqual([
      ["empty", "CC:CC:CC:CC:CC:01", "10.1.0.10", "arp"],
      ["held", "CC:CC:CC:CC:CC:02", "10.1.0.21", "arp"],
    ]);
    expect(m.reconcileAddresses).toHaveBeenCalledWith(state.addressSightings, { dhcpDevices: [], inventoryDevices: [], arpDevices: ["FGT-A"] }, new Date(NOW));
  });

  it("reconciles the address list even with no MAC or ARP rows, when a gate's read succeeded", async () => {
    const { done } = run({ dhcpLeasesInventoriedDevices: ["FGT-A"] }, index([]));
    await done;
    expect(m.update).not.toHaveBeenCalled();
    expect(m.reconcileAddresses).toHaveBeenCalledWith([], { dhcpDevices: ["FGT-A"], inventoryDevices: [], arpDevices: [] }, new Date(NOW));
  });

  it("logs, rather than throws, when the address-list write fails", async () => {
    m.reconcileAddresses.mockRejectedValue(new Error("db down"));
    const { state, done } = run({ arpQueriedDevices: ["FGT-A"] }, index([]));
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to record per-MAC addresses: db down");
  });
});

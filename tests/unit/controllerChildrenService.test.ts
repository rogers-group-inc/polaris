/**
 * tests/unit/controllerChildrenService.test.ts
 *
 * A FortiGate's Wireless / MAC Table tabs: children found by the controller
 * stamp (serial, FMG device name, hostname — never hostname alone), live
 * children only, rows fetched in one IN query, and VLAN-less MAC rows filled
 * per switch from that switch's own access ports.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma, getVlanNamesForAsset } = vi.hoisted(() => ({
  prisma: {
    asset: { findUnique: vi.fn(), findMany: vi.fn() },
    assetWirelessStation: { findMany: vi.fn() },
    assetMacTableEntry: { findMany: vi.fn() },
    assetInterface: { findMany: vi.fn() },
  },
  getVlanNamesForAsset: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({ prisma }));
// The real readPortVlans / portVlansFor (they run on the mocked prisma above);
// only the gate's VLAN names are stubbed.
vi.mock("../../src/services/vlanNameService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/vlanNameService.js")>()),
  getVlanNamesForAsset,
}));

import {
  countControllerChildren,
  getControllerMacTable,
  getControllerWireless,
  listControllerChildren,
} from "../../src/services/controllerChildrenService.js";

const GATE = { hostname: "fw-site1", serialNumber: "FGT60F0001", fortinetTopology: { deviceName: "site1-fgt" } };

function child(id: string, hostname: string, assetType = "switch") {
  return { id, hostname, assetType, ipAddress: null, model: null, serialNumber: null, monitored: true, monitorStatus: "up", lastSystemInfoAt: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  getVlanNamesForAsset.mockResolvedValue({ "30": "Users_VL30" });
});

describe("listControllerChildren", () => {
  it("matches the controller stamp on serial, device name and hostname, live children only, sorted", async () => {
    prisma.asset.findUnique.mockResolvedValue(GATE);
    prisma.asset.findMany.mockResolvedValue([child("b", "sw-10"), child("a", "sw-2")]);
    const out = await listControllerChildren("GATE", "switch");
    expect(out.map((c) => c.hostname)).toEqual(["sw-2", "sw-10"]);
    const where = prisma.asset.findMany.mock.calls[0][0].where;
    expect(where.assetType).toEqual({ in: ["switch"] });
    expect(where.status.notIn).toContain("decommissioned");
    expect(where.AND[0].OR).toEqual([
      { fortinetTopology: { path: ["controllerSerial"], equals: "FGT60F0001" } },
      { fortinetTopology: { path: ["controllerFortigate"], equals: "site1-fgt" } },
      { fortinetTopology: { path: ["controllerFortigate"], equals: "fw-site1" } },
    ]);
  });

  it("404s an unknown gate", async () => {
    prisma.asset.findUnique.mockResolvedValue(null);
    await expect(listControllerChildren("NOPE", "switch")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("returns nothing, without querying, for a gate with no identity", async () => {
    prisma.asset.findUnique.mockResolvedValue({ hostname: null, serialNumber: null, fortinetTopology: null });
    expect(await listControllerChildren("GATE", "access_point")).toEqual([]);
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });
});

describe("countControllerChildren", () => {
  it("counts APs and switches from one query", async () => {
    prisma.asset.findUnique.mockResolvedValue(GATE);
    prisma.asset.findMany.mockResolvedValue([
      { assetType: "access_point" }, { assetType: "access_point" }, { assetType: "switch" },
    ]);
    expect(await countControllerChildren("GATE")).toEqual({ accessPoints: 2, switches: 1 });
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("getControllerWireless", () => {
  it("reads every AP's stations in one IN query", async () => {
    prisma.asset.findUnique.mockResolvedValue(GATE);
    prisma.asset.findMany.mockResolvedValue([child("ap1", "ap-1", "access_point"), child("ap2", "ap-2", "access_point")]);
    prisma.assetWirelessStation.findMany.mockResolvedValue([{ apAssetId: "ap1", staMacAddr: "AA:BB:CC:DD:EE:01" }]);
    const out = await getControllerWireless("GATE");
    expect(out.accessPoints).toHaveLength(2);
    expect(out.stations).toHaveLength(1);
    expect(prisma.assetWirelessStation.findMany.mock.calls[0][0].where).toEqual({ apAssetId: { in: ["ap1", "ap2"] } });
  });

  it("skips the station query when the gate controls no AP", async () => {
    prisma.asset.findUnique.mockResolvedValue(GATE);
    prisma.asset.findMany.mockResolvedValue([]);
    expect(await getControllerWireless("GATE")).toEqual({ accessPoints: [], stations: [] });
    expect(prisma.assetWirelessStation.findMany).not.toHaveBeenCalled();
  });
});

describe("getControllerMacTable", () => {
  it("tags each row with its switch and fills VLAN-less access-port rows per switch", async () => {
    prisma.asset.findUnique.mockResolvedValue(GATE);
    prisma.asset.findMany.mockResolvedValue([child("s1", "sw-1"), child("s2", "sw-2")]);
    prisma.assetMacTableEntry.findMany.mockResolvedValue([
      { assetId: "s1", macAddress: "AA:00:00:00:00:01", vlanId: null, basePort: 7, ifName: "port7", status: "learned", lastSeen: new Date(0), matchedAsset: null },
      { assetId: "s2", macAddress: "AA:00:00:00:00:02", vlanId: null, basePort: 7, ifName: "port7", status: "learned", lastSeen: new Date(0), matchedAsset: null },
    ]);
    // s1 reports a tagged dimension (port48 is a trunk), so its access port
    // fills; s2 reports none, so its row stays VLAN-less — the decision is
    // per switch, never across the merged set.
    prisma.assetInterface.findMany.mockResolvedValue([
      { assetId: "s1", ifName: "port7", nativeVlan: 30, taggedVlans: [], trunksAllVlans: false },
      { assetId: "s1", ifName: "port48", nativeVlan: 1, taggedVlans: [30], trunksAllVlans: false },
      { assetId: "s2", ifName: "port7", nativeVlan: 30, taggedVlans: [], trunksAllVlans: false },
    ]);
    const out = await getControllerMacTable("GATE");
    expect(out.vlanNames).toEqual({ "30": "Users_VL30" });
    expect(getVlanNamesForAsset).toHaveBeenCalledWith("GATE");
    const s1 = out.entries.find((e) => e.switchAssetId === "s1")!;
    const s2 = out.entries.find((e) => e.switchAssetId === "s2")!;
    expect(s1).toMatchObject({ vlanId: 30, vlanInferred: true });
    expect(s2).toMatchObject({ vlanId: null, vlanInferred: false });
    expect(s1).not.toHaveProperty("assetId");
    expect(prisma.assetMacTableEntry.findMany.mock.calls[0][0].where).toEqual({ assetId: { in: ["s1", "s2"] } });
    // Each port's configured VLANs, per switch, only for ports carrying entries
    // (s1's trunk port48 has none, so it is absent).
    expect(out.portVlans).toEqual({
      s1: { port7: { nativeVlan: 30, taggedVlans: [], trunksAllVlans: false } },
      s2: { port7: { nativeVlan: 30, taggedVlans: [], trunksAllVlans: false } },
    });
    expect(prisma.assetInterface.findMany).toHaveBeenCalledTimes(1);
  });

  it("skips the row and port queries when the gate controls no switch", async () => {
    prisma.asset.findUnique.mockResolvedValue(GATE);
    prisma.asset.findMany.mockResolvedValue([]);
    const out = await getControllerMacTable("GATE");
    expect(out.entries).toEqual([]);
    expect(prisma.assetMacTableEntry.findMany).not.toHaveBeenCalled();
    expect(prisma.assetInterface.findMany).not.toHaveBeenCalled();
  });
});

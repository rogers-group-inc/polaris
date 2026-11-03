/**
 * tests/unit/vlanNameService.test.ts
 *
 * VLAN names for the Interfaces / MAC Table pills: the asset's own VLAN
 * interfaces win, then its controller FortiGate's — resolved by the
 * controller stamp, never by hostname alone — and the MAC table's VLAN-less
 * rows are filled from their access port.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    asset: { findUnique: vi.fn(), findMany: vi.fn() },
    assetInterface: { findMany: vi.fn() },
  },
}));
vi.mock("../../src/db.js", () => ({ prisma }));

import { fillMacTableVlans, getVlanNamesForAsset, portVlansFor, readPortVlans } from "../../src/services/vlanNameService.js";

const GATE = { id: "GATE", hostname: "fw-site1", serialNumber: "FGT60F0001", assetType: "firewall", fortinetTopology: { deviceName: "site1-fgt" } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getVlanNamesForAsset", () => {
  it("names a switch's VLANs from its controller FortiGate, own rows first", async () => {
    prisma.asset.findUnique.mockResolvedValue({ fortinetTopology: { controllerSerial: "FGT60F0001", controllerFortigate: "site1-fgt" } });
    prisma.asset.findMany.mockResolvedValue([GATE]);
    prisma.assetInterface.findMany.mockImplementation(async ({ where }: any) =>
      where.assetId === "SW"
        ? [{ ifName: "mgmt_vl99", ifParent: "internal", vlanId: 99 }]
        : [
            { ifName: "Users_VL30", ifParent: "fortilink", vlanId: 30 },
            { ifName: "gate_vl99", ifParent: "fortilink", vlanId: 99 },
          ]);
    expect(await getVlanNamesForAsset("SW")).toEqual({ "99": "mgmt_vl99", "30": "Users_VL30" });
    // The gate lookup is constrained to firewalls.
    expect(prisma.asset.findMany.mock.calls[0][0].where.assetType).toBe("firewall");
  });

  it("reads only its own rows when it has no controller stamp", async () => {
    prisma.asset.findUnique.mockResolvedValue({ fortinetTopology: null });
    prisma.assetInterface.findMany.mockResolvedValue([{ ifName: "Users_VL30", ifParent: "fortilink", vlanId: 30 }]);
    expect(await getVlanNamesForAsset("FW")).toEqual({ "30": "Users_VL30" });
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });

  it("returns nothing for an unknown asset", async () => {
    prisma.asset.findUnique.mockResolvedValue(null);
    prisma.assetInterface.findMany.mockResolvedValue([]);
    expect(await getVlanNamesForAsset("NOPE")).toEqual({});
  });
});

describe("fillMacTableVlans", () => {
  it("fills access-port rows and skips the port query when nothing needs it", async () => {
    prisma.assetInterface.findMany.mockResolvedValue([
      { assetId: "SW", ifName: "port1", nativeVlan: 30, taggedVlans: [], trunksAllVlans: false },
      { assetId: "SW", ifName: "port24", nativeVlan: 1, taggedVlans: [30], trunksAllVlans: false },
    ]);
    const out = await fillMacTableVlans("SW", [
      { macAddress: "AA:BB:CC:00:00:01", ifName: "port1", vlanId: null },
      { macAddress: "AA:BB:CC:00:00:02", ifName: "port24", vlanId: null },
    ]);
    expect(out.map((e) => [e.vlanId, e.vlanInferred])).toEqual([[30, true], [null, false]]);

    prisma.assetInterface.findMany.mockClear();
    const reported = await fillMacTableVlans("SW", [{ macAddress: "AA:BB:CC:00:00:03", ifName: "port1", vlanId: 40 }]);
    expect(reported[0]).toMatchObject({ vlanId: 40, vlanInferred: false });
    expect(prisma.assetInterface.findMany).not.toHaveBeenCalled();
  });

  it("uses preloaded ports instead of querying", async () => {
    const ports = new Map([["port1", { nativeVlan: 30, taggedVlans: [], trunksAllVlans: false }],
      ["port24", { nativeVlan: 1, taggedVlans: [30], trunksAllVlans: false }]]);
    const out = await fillMacTableVlans("SW", [{ macAddress: "AA:BB:CC:00:00:01", ifName: "port1", vlanId: null }], ports);
    expect(out[0]).toMatchObject({ vlanId: 30, vlanInferred: true });
    expect(prisma.assetInterface.findMany).not.toHaveBeenCalled();
  });
});

describe("readPortVlans", () => {
  it("groups every port by asset from one IN query", async () => {
    prisma.assetInterface.findMany.mockResolvedValue([
      { assetId: "S1", ifName: "port1", nativeVlan: 30, taggedVlans: null, trunksAllVlans: false },
      { assetId: "S2", ifName: "port48", nativeVlan: 1, taggedVlans: [30, 40], trunksAllVlans: true },
    ]);
    const out = await readPortVlans(["S1", "S2"]);
    expect(prisma.assetInterface.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.assetInterface.findMany.mock.calls[0][0].where).toEqual({ assetId: { in: ["S1", "S2"] } });
    expect(out.get("S1")!.get("port1")).toEqual({ nativeVlan: 30, taggedVlans: [], trunksAllVlans: false });
    expect(out.get("S2")!.get("port48")).toEqual({ nativeVlan: 1, taggedVlans: [30, 40], trunksAllVlans: true });
  });

  it("skips the query for no assets", async () => {
    expect((await readPortVlans([])).size).toBe(0);
    expect(prisma.assetInterface.findMany).not.toHaveBeenCalled();
  });
});

describe("portVlansFor", () => {
  const ports = new Map([
    ["port1", { nativeVlan: 30, taggedVlans: [], trunksAllVlans: false }],
    ["port2", { nativeVlan: null, taggedVlans: [], trunksAllVlans: false }],
    ["port48", { nativeVlan: 1, taggedVlans: [30, 40], trunksAllVlans: false }],
  ]);

  it("keeps only the named ports that state something", () => {
    expect(portVlansFor(ports, ["port1", "port2", "port48", null, "port9"])).toEqual({
      port1: { nativeVlan: 30, taggedVlans: [], trunksAllVlans: false },
      port48: { nativeVlan: 1, taggedVlans: [30, 40], trunksAllVlans: false },
    });
  });

  it("is empty with no port data", () => {
    expect(portVlansFor(undefined, ["port1"])).toEqual({});
  });
});

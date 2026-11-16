/**
 * tests/unit/staleMacDeviceStamps.test.ts — syncDhcpSubnets Phase 7b as its
 * own module (src/services/discovery/dhcp/staleMacDeviceStamps.ts →
 * clearStaleMacDeviceStamps).
 *
 * Contract: for each gate whose inventory succeeded this run, a MAC stamped
 * with that gate but not seen LOCALLY in its fresh inventory
 * (utils/inventoryLocality — a switch/AP port, or the gate's own ARP table)
 * loses its `device` stamp; gates that did not refresh are left alone; only
 * mutated assets are reconciled, and the in-memory rows are updated.
 * tests/unit/dhcpPhasesExtracted.test.ts pins the headline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ reconcileMacAddresses: vi.fn() }));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/macAddressService.js", () => ({ reconcileMacAddresses: m.reconcileMacAddresses }));

const { clearStaleMacDeviceStamps } = await import("../../src/services/discovery/dhcp/staleMacDeviceStamps.js");
const { buildArpMacDeviceIndex } = await import("../../src/utils/inventoryLocality.js");

const log = vi.fn();

type Asset = { id: string; macAddresses: unknown };
function run(result: Record<string, unknown>, assets: Asset[], arp: Array<{ fortigateDevice: string; mac: string }> = []) {
  return clearStaleMacDeviceStamps({
    result: result as never,
    assetIdx: { all: () => assets } as never,
    arpMacDeviceIndex: buildArpMacDeviceIndex(arp),
    syncLog: log,
  });
}

beforeEach(() => {
  log.mockReset();
  m.reconcileMacAddresses.mockReset().mockResolvedValue(undefined);
});

describe("clearStaleMacDeviceStamps", () => {
  it("does nothing when no gate's inventory refreshed", async () => {
    const a = { id: "a1", macAddresses: [{ mac: "AA:00:00:00:00:01", device: "FGT-A" }] };
    await run({}, [a]);
    await run({ inventoryDevices: [] }, [a]);
    expect(a.macAddresses).toEqual([{ mac: "AA:00:00:00:00:01", device: "FGT-A" }]);
    expect(m.reconcileMacAddresses).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("clears a stamp whose MAC the refreshed gate no longer reports, and reconciles that asset", async () => {
    const a = { id: "a1", macAddresses: [{ mac: "AA:00:00:00:00:01", device: "FGT-A", source: "fortigate" }] };
    await run({ inventoryDevices: ["FGT-A"], deviceInventory: [] }, [a]);
    expect(a.macAddresses).toEqual([{ mac: "AA:00:00:00:00:01", source: "fortigate" }]);
    expect(m.reconcileMacAddresses).toHaveBeenCalledWith("a1", a.macAddresses);
    expect(log).toHaveBeenCalledWith("info", "Cleared stale MAC device stamps on 1 asset(s) across 1 refreshed FortiGate(s)");
  });

  it("keeps a stamp seen on a switch/AP port, normalizing the inventory MAC (dashes, case)", async () => {
    const a = { id: "a1", macAddresses: [
      { mac: "AA:00:00:00:00:01", device: "FGT-A" },
      { mac: "AA:00:00:00:00:02", device: "FGT-A" },
    ] };
    await run({
      inventoryDevices: ["FGT-A"],
      deviceInventory: [
        { macAddress: "aa-00-00-00-00-01", device: "FGT-A", switchName: "SW-1" },
        { macAddress: "aa:00:00:00:00:02", device: "FGT-A", apName: "AP-1" },
      ],
    }, [a]);
    expect(a.macAddresses).toEqual([
      { mac: "AA:00:00:00:00:01", device: "FGT-A" },
      { mac: "AA:00:00:00:00:02", device: "FGT-A" },
    ]);
    expect(m.reconcileMacAddresses).not.toHaveBeenCalled();
  });

  it("keeps a stamp the gate's own ARP table backs, and clears one seen only as a relayed (non-local) row", async () => {
    const a = { id: "a1", macAddresses: [
      { mac: "AA:00:00:00:00:01", device: "FGT-A" },
      { mac: "AA:00:00:00:00:02", device: "FGT-A" },
    ] };
    await run(
      {
        inventoryDevices: ["FGT-A"],
        deviceInventory: [
          { macAddress: "AA:00:00:00:00:01", device: "FGT-A" },
          { macAddress: "AA:00:00:00:00:02", device: "FGT-A" },
        ],
      },
      [a],
      [{ fortigateDevice: "FGT-A", mac: "aa:00:00:00:00:01" }],
    );
    expect(a.macAddresses).toEqual([
      { mac: "AA:00:00:00:00:01", device: "FGT-A" },
      { mac: "AA:00:00:00:00:02" },
    ]);
  });

  it("a sighting on ANOTHER gate does not keep this gate's stamp", async () => {
    const a = { id: "a1", macAddresses: [{ mac: "AA:00:00:00:00:01", device: "FGT-A" }] };
    await run({
      inventoryDevices: ["FGT-A", "FGT-B"],
      deviceInventory: [{ macAddress: "AA:00:00:00:00:01", device: "FGT-B", switchName: "SW-B" }],
    }, [a]);
    expect(a.macAddresses).toEqual([{ mac: "AA:00:00:00:00:01" }]);
    expect(log).toHaveBeenCalledWith("info", "Cleared stale MAC device stamps on 1 asset(s) across 2 refreshed FortiGate(s)");
  });

  it("leaves stamps on gates that did not refresh, and unstamped entries, alone", async () => {
    const a = { id: "a1", macAddresses: [
      { mac: "AA:00:00:00:00:01", device: "FGT-B" },
      { mac: "AA:00:00:00:00:02" },
    ] };
    await run({ inventoryDevices: ["FGT-A"], deviceInventory: [] }, [a]);
    expect(a.macAddresses).toEqual([
      { mac: "AA:00:00:00:00:01", device: "FGT-B" },
      { mac: "AA:00:00:00:00:02" },
    ]);
    expect(m.reconcileMacAddresses).not.toHaveBeenCalled();
  });

  it("skips assets with no MAC list (missing, non-array or empty) and ignores inventory rows missing a MAC or gate", async () => {
    const assets = [
      { id: "none", macAddresses: undefined },
      { id: "obj", macAddresses: { mac: "AA:00:00:00:00:01", device: "FGT-A" } },
      { id: "empty", macAddresses: [] },
    ];
    await run({
      inventoryDevices: ["FGT-A"],
      deviceInventory: [{ macAddress: null, device: "FGT-A", switchName: "S" }, { macAddress: "AA:00:00:00:00:01", device: null, switchName: "S" }],
    }, assets);
    expect(m.reconcileMacAddresses).not.toHaveBeenCalled();
    expect(assets[1].macAddresses).toEqual({ mac: "AA:00:00:00:00:01", device: "FGT-A" });
  });

  it("reconciles only the mutated assets, once each", async () => {
    const a = { id: "a1", macAddresses: [{ mac: "AA:00:00:00:00:01", device: "FGT-A" }, { mac: "AA:00:00:00:00:02", device: "FGT-A" }] };
    const b = { id: "b1", macAddresses: [{ mac: "BB:00:00:00:00:01", device: "FGT-A" }] };
    const c = { id: "c1", macAddresses: [{ mac: "CC:00:00:00:00:01", device: "FGT-A" }] };
    await run({
      inventoryDevices: ["FGT-A"],
      deviceInventory: [{ macAddress: "CC:00:00:00:00:01", device: "FGT-A", switchName: "S" }],
    }, [a, b, c]);
    expect(m.reconcileMacAddresses.mock.calls.map((x) => x[0])).toEqual(["a1", "b1"]);
    expect(log).toHaveBeenCalledWith("info", "Cleared stale MAC device stamps on 2 asset(s) across 1 refreshed FortiGate(s)");
  });

  it("a failing reconcile does not throw out of the phase", async () => {
    m.reconcileMacAddresses.mockRejectedValue(new Error("deadlock"));
    const a = { id: "a1", macAddresses: [{ mac: "AA:00:00:00:00:01", device: "FGT-A" }] };
    await expect(run({ inventoryDevices: ["FGT-A"], deviceInventory: [] }, [a])).resolves.toBeUndefined();
  });
});

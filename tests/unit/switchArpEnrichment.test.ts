/**
 * tests/unit/switchArpEnrichment.test.ts — the own suite for
 * src/services/discovery/dhcp/switchArpEnrichment.ts (syncDhcpSubnets Phase 7.5, CQ-T010).
 *
 * Pins the switch-port attribution (lowest-rank port, FortiLink peers and
 * incomplete rows ignored, Fortinet switches / gates never stamped, one write
 * per change), the ARP claim on the shared address ladder (rule 101: the
 * standing address first, a sibling must strictly beat it, a reservation lifts
 * a sibling, only an address this run's ladder decided is overruled), the
 * conservative fill of an EMPTY address, the per-MAC address sightings and the
 * per-gate reconcile (rule 102), the one merged write per asset, and failure
 * isolation. The claim ladder (dhcpClaimFreshness) runs for real.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const m = vi.hoisted(() => ({ reconcile: vi.fn() }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/assetAddressService.js", () => ({ reconcileDiscoveredAddresses: m.reconcile }));

const { enrichFromSwitchMacAndArp } = await import("../../src/services/discovery/dhcp/switchArpEnrichment.js");
const { createDhcpClaimState, scoreAddressClaim } = await import("../../src/utils/dhcpClaimFreshness.js");

const db = { update: stubbed(prisma.asset.update) };
const NOW = "2026-11-14T08:00:00.000Z";
const NOW_MS = Date.parse(NOW);

beforeEach(() => {
  resetDbStub();
  m.reconcile.mockReset().mockResolvedValue({ upserted: 0, pruned: 0 });
  db.update.mockResolvedValue({});
});

type Row = Record<string, any>;
function asset(id: string, mac: string, over: Row = {}): Row {
  return { id, mac, assetType: "workstation", ipAddress: null, lastSeenSwitch: null, learnedLocation: null, macAddresses: [], ...over };
}
function index(assets: Row[]) {
  const byMac = new Map(assets.map((a) => [String(a.mac).toUpperCase().replace(/-/g, ":"), a]));
  const byId = new Map(assets.map((a) => [a.id as string, a]));
  return {
    findByMac: vi.fn((mac: string) => byMac.get(String(mac).toUpperCase().replace(/-/g, ":"))),
    findById: vi.fn((id: string) => byId.get(id)),
    reindex: vi.fn(),
  };
}
function run(result: Row, idx: ReturnType<typeof index>, over: Row = {}) {
  const state = {
    result: result as never, now: NOW, assetIdx: idx as never, claims: createDhcpClaimState(),
    addressSightings: [] as any[], fortigateEndpointAssetIds: new Set<string>(),
    noteChangeBaseline: vi.fn(), noteEndpointGate: vi.fn(), syncLog: vi.fn(),
    ...over,
  };
  return { state, done: enrichFromSwitchMacAndArp(state) };
}
const macRow = (mac: string, switchId: string, portName: string, over: Row = {}) => ({ mac, switchId, portName, fortigateDevice: "FGT-A", ...over });
const arp = (mac: string, ip: string, fortigateDevice: string | undefined = "FGT-A") => ({ mac, ip, fortigateDevice, interface: "lan" });
const offlineDetected = () => scoreAddressClaim({ kind: "device-inventory", current: false }, NOW_MS);
const heldLease = () => scoreAddressClaim({ kind: "dhcp-lease", current: true }, NOW_MS);

describe("enrichFromSwitchMacAndArp — nothing to do", () => {
  it("writes nothing and skips the reconcile when the run carried no rows and read no gate", async () => {
    const { state, done } = run({ switchMacTable: [], arpTable: [] }, index([]));
    await done;
    expect(db.update).not.toHaveBeenCalled();
    expect(m.reconcile).not.toHaveBeenCalled();
    expect(state.syncLog).not.toHaveBeenCalled();
  });
});

describe("enrichFromSwitchMacAndArp — switch-port attribution", () => {
  it("stamps the port with the fewest MACs (counted case-insensitively) and touches the endpoint's gate", async () => {
    const idx = index([asset("pc", "AA:00:00:00:00:01"), asset("pc2", "AA:00:00:00:00:02"), asset("pc3", "AA:00:00:00:00:03")]);
    const { state, done } = run({
      switchMacTable: [
        macRow("aa:00:00:00:00:01", "SW1", "trunk", { fortigateDevice: "FGT-T" }),
        macRow("AA:00:00:00:00:01", "SW1", "trunk", { fortigateDevice: "FGT-T" }), // same MAC, other case: still one
        macRow("aa:00:00:00:00:02", "SW1", "trunk"),
        macRow("aa:00:00:00:00:01", "SW2", "port7", { fortigateDevice: "FGT-B" }),
        macRow("aa:00:00:00:00:03", "SW2", "port9"),
        macRow("aa:00:00:00:00:03", "SW2", "port7"),
      ],
    }, idx);
    await done;
    // trunk: 2 MACs; port7: 2 MACs (01, 03); port9: 1 MAC.
    expect(idx.findById("pc")!.lastSeenSwitch).toBe("SW1/trunk"); // first of a tie sticks
    expect(idx.findById("pc3")!.lastSeenSwitch).toBe("SW2/port9");
    expect(state.noteEndpointGate).toHaveBeenCalledWith("pc", "FGT-T");
    expect(state.noteEndpointGate).toHaveBeenCalledWith("pc3", "FGT-A");
    expect([...state.fortigateEndpointAssetIds].sort()).toEqual(["pc", "pc2", "pc3"]);
    expect(db.update).toHaveBeenCalledWith({ where: { id: "pc3" }, data: { lastSeenSwitch: "SW2/port9" } });
    expect(state.syncLog).toHaveBeenCalledWith("info", "Enriched 3 asset(s) from FortiSwitch macmap + FortiGate ARP (switch-port + IP)");
  });

  it("ignores FortiLink peer rows and rows missing a MAC, switch or port", async () => {
    const idx = index([asset("pc", "AA:00:00:00:00:01")]);
    const { done } = run({
      switchMacTable: [
        macRow("aa:00:00:00:00:01", "SW1", "fortilink", { isFortilinkPeer: true }),
        macRow("aa:00:00:00:00:01", "", "port1"),
        macRow("aa:00:00:00:00:01", "SW1", ""),
        macRow("", "SW1", "port2"),
      ],
    }, idx);
    await done;
    expect(db.update).not.toHaveBeenCalled();
    expect(idx.findById("pc")!.lastSeenSwitch).toBeNull();
  });

  it("never stamps a managed switch or a FortiGate, and an unknown MAC is skipped", async () => {
    const idx = index([asset("fsw", "BB:00:00:00:00:01", { assetType: "switch" }), asset("fgt", "BB:00:00:00:00:02", { assetType: "firewall" })]);
    const { state, done } = run({
      switchMacTable: [macRow("BB:00:00:00:00:01", "SW1", "p1"), macRow("BB:00:00:00:00:02", "SW1", "p2"), macRow("BB:00:00:00:00:99", "SW1", "p3")],
    }, idx);
    await done;
    expect(db.update).not.toHaveBeenCalled();
    expect(state.fortigateEndpointAssetIds.size).toBe(0);
  });

  it("an unchanged port writes nothing but still counts as an endpoint touch", async () => {
    const idx = index([asset("pc", "AA:00:00:00:00:01", { lastSeenSwitch: "SW2/port7" })]);
    const { state, done } = run({ switchMacTable: [macRow("AA:00:00:00:00:01", "SW2", "port7")] }, idx);
    await done;
    expect(db.update).not.toHaveBeenCalled();
    expect(state.noteChangeBaseline).not.toHaveBeenCalled();
    expect(state.fortigateEndpointAssetIds.has("pc")).toBe(true);
    expect(state.noteEndpointGate).toHaveBeenCalledWith("pc", "FGT-A");
    expect(state.syncLog).not.toHaveBeenCalled();
  });

  it("a FortiAP gets the port stamp but is not an endpoint touch", async () => {
    const idx = index([asset("ap", "CC:00:00:00:00:01", { assetType: "access_point" })]);
    const { state, done } = run({ switchMacTable: [macRow("CC:00:00:00:00:01", "SW1", "port3", { fortigateDevice: "" })] }, idx);
    await done;
    expect(db.update).toHaveBeenCalledWith({ where: { id: "ap" }, data: { lastSeenSwitch: "SW1/port3" } });
    expect(state.noteChangeBaseline).toHaveBeenCalledWith(idx.findById("ap"), ["lastSeenSwitch"]);
    expect(state.fortigateEndpointAssetIds.size).toBe(0);
    expect(state.noteEndpointGate).not.toHaveBeenCalled();
  });
});

describe("enrichFromSwitchMacAndArp — ARP on the address ladder (rule 101)", () => {
  it("a sibling ARP address beats a weaker claim this run's ladder decided, and moves the asset", async () => {
    const pc = asset("pc", "AA:00:00:00:00:01", { ipAddress: "10.1.0.5" });
    const idx = index([pc]);
    const claims = createDhcpClaimState();
    claims.bestAddressClaimByAsset.set("pc", offlineDetected());
    const { state, done } = run({ arpTable: [arp("aa-00-00-00-00-01", "10.1.0.9", "FGT-B")] }, idx, { claims });
    await done;
    expect(pc).toMatchObject({ ipAddress: "10.1.0.9", learnedLocation: "FGT-B" });
    expect(db.update).toHaveBeenCalledWith({ where: { id: "pc" }, data: { ipAddress: "10.1.0.9", ipSource: "FGT-B:arp", learnedLocation: "FGT-B" } });
    expect(idx.reindex).toHaveBeenCalledWith(pc);
    expect(state.noteEndpointGate).toHaveBeenCalledWith("pc", "FGT-B");
    expect(state.fortigateEndpointAssetIds.has("pc")).toBe(true);
    expect(claims.bestAddressClaimByAsset.get("pc")![0]).toBe(2);
  });

  it("ARP for the standing address stakes its claim first, so an equal sibling leaves the asset where it is", async () => {
    const pc = asset("pc", "AA:00:00:00:00:01", { ipAddress: "10.1.0.5" });
    const claims = createDhcpClaimState();
    claims.bestAddressClaimByAsset.set("pc", offlineDetected());
    const { done } = run({ arpTable: [arp("AA:00:00:00:00:01", "10.1.0.9"), arp("AA:00:00:00:00:01", "10.1.0.5")] }, index([pc]), { claims });
    await done;
    expect(pc.ipAddress).toBe("10.1.0.5");
    expect(db.update).not.toHaveBeenCalled();
    expect(claims.bestAddressClaimByAsset.get("pc")![0]).toBe(2); // the confirmation was recorded
  });

  it("a DHCP reservation configured for the MAC at a sibling address lifts that sibling", async () => {
    const pc = asset("pc", "AA:00:00:00:00:01", { ipAddress: "10.1.0.5" });
    const claims = createDhcpClaimState();
    claims.bestAddressClaimByAsset.set("pc", offlineDetected());
    const { done } = run({
      arpTable: [arp("AA:00:00:00:00:01", "10.1.0.5"), arp("AA:00:00:00:00:01", "10.1.0.9")],
      dhcpEntries: [
        { type: "dhcp-reservation", macAddress: "aa-00-00-00-00-01", ipAddress: "10.1.0.9" },
        { type: "dhcp-lease", macAddress: "aa:00:00:00:00:01", ipAddress: "10.1.0.5" },
        { type: "dhcp-reservation", macAddress: null, ipAddress: "10.1.0.1" },
      ],
    }, index([pc]), { claims });
    await done;
    expect(pc.ipAddress).toBe("10.1.0.9");
  });

  it("never overrules an address the ladder did not decide this run (vCenter, an operator)", async () => {
    const pc = asset("pc", "AA:00:00:00:00:01", { ipAddress: "10.1.0.5" });
    const { state, done } = run({ arpTable: [arp("AA:00:00:00:00:01", "10.1.0.9")] }, index([pc]));
    await done;
    expect(pc.ipAddress).toBe("10.1.0.5");
    expect(db.update).not.toHaveBeenCalled();
    // The confirmation path never fired either — the asset's standing address had no ARP row.
    expect(state.claims.bestAddressClaimByAsset.has("pc")).toBe(false);
  });

  it("never beats a stronger claim (a held lease)", async () => {
    const pc = asset("pc", "AA:00:00:00:00:01", { ipAddress: "10.1.0.5" });
    const claims = createDhcpClaimState();
    claims.bestAddressClaimByAsset.set("pc", heldLease());
    const { done } = run({ arpTable: [arp("AA:00:00:00:00:01", "10.1.0.9")] }, index([pc]), { claims });
    await done;
    expect(pc.ipAddress).toBe("10.1.0.5");
    expect(claims.bestAddressClaimByAsset.get("pc")![0]).toBe(3);
  });
});

describe("enrichFromSwitchMacAndArp — empty-address fill and sightings (rule 102)", () => {
  it("fills an EMPTY address from the first ARP row, never overwrites it with a second, and records every binding", async () => {
    const pc = asset("pc", "AA:00:00:00:00:01");
    const idx = index([pc]);
    const { state, done } = run({
      arpTable: [arp("aa:00:00:00:00:01", "10.1.0.10"), arp("AA:00:00:00:00:01", "10.1.0.11", "FGT-B")],
      arpQueriedDevices: ["FGT-A", "FGT-B"],
    }, idx);
    await done;
    expect(pc.ipAddress).toBe("10.1.0.10");
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalledWith({ where: { id: "pc" }, data: { ipAddress: "10.1.0.10", ipSource: "FGT-A:arp" } });
    expect(idx.reindex).toHaveBeenCalledTimes(1);
    expect(state.noteEndpointGate).toHaveBeenCalledWith("pc", "FGT-A");
    expect(state.addressSightings).toEqual([
      { assetId: "pc", mac: "AA:00:00:00:00:01", ip: "10.1.0.10", source: "arp", device: "FGT-A", seenAt: new Date(NOW) },
      { assetId: "pc", mac: "AA:00:00:00:00:01", ip: "10.1.0.11", source: "arp", device: "FGT-B", seenAt: new Date(NOW) },
    ]);
    expect(m.reconcile).toHaveBeenCalledWith(state.addressSightings, { dhcpDevices: [], inventoryDevices: [], arpDevices: ["FGT-A", "FGT-B"] }, new Date(NOW));
  });

  it("records no sighting for Fortinet infra, an unknown MAC, or a row with no gate", async () => {
    const idx = index([
      asset("fsw", "BB:00:00:00:00:01", { assetType: "switch", ipAddress: "10.0.0.2" }),
      asset("pc", "AA:00:00:00:00:01", { ipAddress: "10.1.0.5" }),
    ]);
    const { state, done } = run({
      arpTable: [arp("BB:00:00:00:00:01", "10.0.0.2"), arp("DD:00:00:00:00:01", "10.1.0.77"), arp("AA:00:00:00:00:01", "10.1.0.5", "")],
    }, idx);
    await done;
    expect(state.addressSightings).toEqual([]);
    expect(db.update).not.toHaveBeenCalled();
    expect(m.reconcile).not.toHaveBeenCalled();
  });

  // Was a bug until 2026-11-14: rule 101(a) says "Fortinet infra is skipped on every pass", and the
  // ladder loop and the sightings loop both skip firewall / switch / access_point
  // — but the conservative empty-address fill does not. An HA standby FortiGate
  // carries ipAddress = null BY DESIGN (Phase 3 creates it with no IP); when its
  // MAC shows up in a gate's ARP table (e.g. a dedicated HA management port),
  // Phase 7.5 writes { ipAddress: "10.0.0.3", ipSource: "FGT-A:arp" } onto the
  // standby. Right: an infra asset with no address is left alone (no write).
  it("never fills an empty address on Fortinet infra (an HA standby's null IP is by design)", async () => {
    const standby = asset("sb", "00:09:0F:00:00:02", { assetType: "firewall", ipAddress: null });
    const { done } = run({ arpTable: [arp("00:09:0f:00:00:02", "10.0.0.3")] }, index([standby]));
    await done;
    expect(db.update).not.toHaveBeenCalled();
    expect(standby.ipAddress).toBeNull();
  });
});

describe("enrichFromSwitchMacAndArp — writes and the reconcile", () => {
  it("merges a port stamp and an address fill into ONE write per asset", async () => {
    const pc = asset("pc", "AA:00:00:00:00:01");
    const { state, done } = run({
      switchMacTable: [macRow("AA:00:00:00:00:01", "SW1", "port1")],
      arpTable: [arp("AA:00:00:00:00:01", "10.1.0.10")],
    }, index([pc]));
    await done;
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalledWith({ where: { id: "pc" }, data: { lastSeenSwitch: "SW1/port1", ipAddress: "10.1.0.10", ipSource: "FGT-A:arp" } });
    expect(state.syncLog).toHaveBeenCalledWith("info", "Enriched 1 asset(s) from FortiSwitch macmap + FortiGate ARP (switch-port + IP)");
  });

  it("counts only the writes that landed", async () => {
    db.update.mockImplementation(async ({ where }: any) => { if (where.id === "bad") throw new Error("locked"); return {}; });
    const { state, done } = run({
      switchMacTable: [macRow("AA:00:00:00:00:01", "SW1", "p1"), macRow("AA:00:00:00:00:02", "SW1", "p2")],
    }, index([asset("bad", "AA:00:00:00:00:01"), asset("good", "AA:00:00:00:00:02")]));
    await expect(done).resolves.toBeUndefined();
    expect(state.syncLog).toHaveBeenCalledWith("info", "Enriched 1 asset(s) from FortiSwitch macmap + FortiGate ARP (switch-port + IP)");
  });

  it("reconciles every gate a read succeeded on, even with no rows, and reports what changed", async () => {
    m.reconcile.mockResolvedValue({ upserted: 2, pruned: 1 });
    const { state, done } = run({ dhcpLeasesInventoriedDevices: ["FGT-A"], inventoryDevices: ["FGT-B"] }, index([]));
    await done;
    expect(m.reconcile).toHaveBeenCalledWith([], { dhcpDevices: ["FGT-A"], inventoryDevices: ["FGT-B"], arpDevices: [] }, new Date(NOW));
    expect(state.syncLog).toHaveBeenCalledWith("info", "Address list: 2 binding(s) recorded, 1 no longer reported removed");
  });

  it("reconciles sightings an earlier phase gathered, and logs (never throws) a failed reconcile", async () => {
    m.reconcile.mockRejectedValue(new Error("db down"));
    const prior = [{ assetId: "x", mac: "AA:00:00:00:00:09", ip: "10.1.0.9", source: "dhcp-lease", device: "FGT-A", seenAt: new Date(NOW) }];
    const { state, done } = run({}, index([]), { addressSightings: prior });
    await expect(done).resolves.toBeUndefined();
    expect(m.reconcile).toHaveBeenCalledWith(prior, { dhcpDevices: [], inventoryDevices: [], arpDevices: [] }, new Date(NOW));
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to record per-MAC addresses: db down");
  });
});

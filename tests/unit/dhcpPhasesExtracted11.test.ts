/**
 * tests/unit/dhcpPhasesExtracted11.test.ts — syncDhcpSubnets Phase 6, DHCP MAC
 * association, now src/services/discovery/dhcp/dhcpMacAssociation.ts (CQ-B060
 * slice 12). Pins the asset write a held lease produces, the address ladder's
 * strictly-better rule across two bindings, infra exemptions, the
 * reservation cross-update, the per-asset write merge and the auto-quarantine
 * fan-out. The ladder scoring itself has its own suite (dhcpClaimFreshness);
 * the whole pass against a real database: addressClaimRanking,
 * dhcpClaimRunScope, primaryAddress, endpointGateFromPrimaryIp.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const db = {
  assetUpdate: stubbed(prisma.asset.update),
  assetFindMany: stubbed(prisma.asset.findMany),
  assetFindUnique: stubbed(prisma.asset.findUnique),
  resUpdate: stubbed(prisma.reservation.update),
};

const m = vi.hoisted(() => ({
  reconcileMacs: vi.fn(),
  recordSightings: vi.fn(),
  quarantine: vi.fn(),
  verifyQuarantine: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/macAddressService.js", () => ({ reconcileMacAddresses: m.reconcileMacs }));
vi.mock("../../src/services/assetSightingService.js", () => ({ recordSightings: m.recordSightings }));
vi.mock("../../src/services/assetQuarantineService.js", () => ({ quarantineAsset: m.quarantine, verifyAssetQuarantine: m.verifyQuarantine }));

const { associateDhcpMacs } = await import("../../src/services/discovery/dhcp/dhcpMacAssociation.js");
const { createDhcpClaimState } = await import("../../src/utils/dhcpClaimFreshness.js");

const NOW = "2026-11-10T12:00:00.000Z";
const MAC = "AA:BB:CC:DD:EE:01";
beforeEach(() => {
  resetDbStub();
  vi.clearAllMocks();
  db.assetUpdate.mockResolvedValue({});
  db.resUpdate.mockResolvedValue({});
  db.assetFindMany.mockResolvedValue([]);
  m.recordSightings.mockResolvedValue(undefined);
});

/** A run index that matches by MAC only (rule 91(f): no hostname rung on this path). */
function index(assets: Array<Record<string, any>>) {
  const byMac = new Map(assets.map((a) => [String(a.macAddress).toUpperCase(), a]));
  return {
    findByEntryWithRung: (mac?: string) => {
      const a = mac ? byMac.get(mac.toUpperCase().replace(/-/g, ":")) : undefined;
      return a ? { asset: a, rung: "mac" as const } : undefined;
    },
    reindex: vi.fn(),
  };
}

const asset = (over: Record<string, unknown> = {}) => ({
  id: "a1", macAddress: MAC, macAddresses: [], hostname: "pc-1", ipAddress: "10.1.0.4", status: "active", assetType: "workstation",
  lastSeen: null, fortinetTopology: null,
  // The pin columns every preloaded row carries (assetWritePrune treats a missing one as pinned).
  ipOverride: null, ipBlankPinned: false, primaryAddressIp: null, hostnameOverride: null,
  ...over,
});
const lease = (over: Record<string, unknown> = {}) => ({
  macAddress: MAC.toLowerCase(), ipAddress: "10.1.0.5", type: "dhcp-lease", device: "FGT-A", seenLeased: true,
  expireTime: Math.floor(Date.parse(NOW) / 1000) + 3600, hostname: "pc-1", ...over,
});

function run(entries: unknown[], assets: Array<Record<string, any>>, over: Record<string, unknown> = {}) {
  const claims = createDhcpClaimState();
  const state = {
    result: { dhcpEntries: entries, deviceInventory: [] } as never,
    activeResMap: new Map<string, any>(), assetIdx: index(assets) as never, claims,
    arpMacDeviceIndex: new Set<string>(), bestGateClaimMsByAsset: claims.bestGateClaimMsByAsset,
    addressSightings: [] as any[], fortigateEndpointAssetIds: new Set<string>(), now: NOW,
    findSubnetForIp: (ip: string) => (ip.startsWith("10.1.") ? { id: "net1", cidr: "10.1.0.0/24", name: "LAN" } : undefined),
    reservationKey: (s: string, ip: string) => `${s}|${ip}`,
    noteEndpointGate: vi.fn(), hostnameAdoptRefused: () => false, noteHostnameAdoptRefused: vi.fn(),
    integrationId: "i1", integrationType: "fortimanager", integrationLabel: "FortiManager", syncLog: vi.fn(),
    ...over,
  };
  return { state, done: associateDhcpMacs(state as never) };
}

describe("Phase 6 — a held lease on an endpoint", () => {
  it("moves the address, names the gate, bumps Last Seen, and records the MAC, sighting and address-list row", async () => {
    const a = asset();
    const { state, done } = run([lease()], [a]);
    await done;
    const data = db.assetUpdate.mock.calls[0][0].data;
    expect(data).toMatchObject({ ipAddress: "10.1.0.5", ipSource: "FGT-A", learnedLocation: "FGT-A", lastSeenSource: "dhcp-lease" });
    // The primary MAC and status are what the row already holds: not re-sent
    // (utils/assetWritePrune.ts — each would have fired the db.ts hook chain).
    expect(data).not.toHaveProperty("macAddress");
    expect(data).not.toHaveProperty("status");
    expect(data.lastSeen).toEqual(new Date(NOW));
    expect(m.reconcileMacs).toHaveBeenCalledWith("a1", [expect.objectContaining({ mac: MAC, source: "dhcp-lease", subnetCidr: "10.1.0.0/24", subnetName: "LAN" })]);
    expect(a.ipAddress).toBe("10.1.0.5"); // the run index follows
    expect(state.noteEndpointGate).toHaveBeenCalledWith("a1", "FGT-A");
    expect(state.fortigateEndpointAssetIds.has("a1")).toBe(true);
    expect(state.addressSightings).toEqual([expect.objectContaining({ assetId: "a1", ip: "10.1.0.5", source: "dhcp-lease", device: "FGT-A" })]);
    expect(m.recordSightings).toHaveBeenCalledWith([expect.objectContaining({ assetId: "a1", fortigateDevice: "FGT-A", source: "dhcp_lease" })]);
  });

  it("defers Last Seen to Phase 7 when the detected-device table also covers the MAC", async () => {
    await run([lease()], [asset()], { result: { dhcpEntries: [lease()], deviceInventory: [{ macAddress: MAC, device: "FGT-A" }] } }).done;
    expect(db.assetUpdate.mock.calls[0][0].data.lastSeen).toBeUndefined();
  });

  it("two bindings for one card: the reservation outranks the lease, and the asset gets ONE merged write", async () => {
    const a = asset();
    await run([lease(), lease({ ipAddress: "10.1.0.9", type: "dhcp-reservation" })], [a]).done;
    expect(db.assetUpdate).toHaveBeenCalledTimes(1);
    expect(db.assetUpdate.mock.calls[0][0].data.ipAddress).toBe("10.1.0.9");
    expect(a.ipAddress).toBe("10.1.0.9");
  });

  it("skips an all-zero MAC, an IPv6 binding (rule 125) and an unmatched MAC", async () => {
    await run([
      lease({ macAddress: "00:00:00:00:00:00" }),
      lease({ ipAddress: "2001:db8::5" }),
      lease({ macAddress: "11:22:33:44:55:66" }),
    ], [asset()]).done;
    expect(db.assetUpdate).not.toHaveBeenCalled();
    expect(m.recordSightings).not.toHaveBeenCalled();
  });
});

describe("Phase 6 — unchanged rows (utils/assetWritePrune.ts)", () => {
  it("a lease for an asset already at that address with that MAC writes only presence", async () => {
    const a = asset({ ipAddress: "10.1.0.5", ipSource: "FGT-A", learnedLocation: "FGT-A" });
    await run([lease()], [a]).done;
    const data = db.assetUpdate.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual(["lastSeen", "lastSeenSource"].sort());
  });

  it("a later entry equal to the STORED value still wins over an earlier one (pruned against the pre-phase row)", async () => {
    // Stored: 10.1.0.4 from FGT-A. A lease moves it, then a reservation on the
    // same card brings it back — the merged write must say 10.1.0.4, so it is
    // dropped as unchanged rather than leaving the lease's address.
    const a = asset({ ipAddress: "10.1.0.4", ipSource: "FGT-A", learnedLocation: "FGT-A" });
    await run([lease(), lease({ ipAddress: "10.1.0.4", type: "dhcp-reservation" })], [a]).done;
    const data = db.assetUpdate.mock.calls[0]?.[0]?.data ?? {};
    expect(data.ipAddress).toBeUndefined();
    expect(a.ipAddress).toBe("10.1.0.4");
  });
});

describe("Phase 6 — infrastructure and reservations", () => {
  it("never re-addresses a switch / FortiGate, nor bumps a Fortinet-owned device's Last Seen", async () => {
    const sw = asset({ assetType: "switch", fortinetTopology: { role: "fortiswitch" } });
    const { state, done } = run([lease()], [sw]);
    await done;
    // Nothing the switch row does not already hold, so no asset write at all —
    // the MAC side table is still reconciled.
    expect(db.assetUpdate).not.toHaveBeenCalled();
    expect(m.reconcileMacs).toHaveBeenCalledWith("a1", expect.any(Array));
    expect(state.fortigateEndpointAssetIds.size).toBe(0);
    expect(state.addressSightings).toEqual([]);
  });

  it("cross-updates the reservation at the address: hostname, owner on a MAC change, MAC unless Polaris pushed it", async () => {
    const res = { id: "r1", hostname: "old", owner: "dhcp-lease", macAddress: "11:22:33:44:55:66" };
    const pushed = { id: "r2", hostname: "pc-2", owner: "x", macAddress: "11:22:33:44:55:77", pushedToId: "i1" };
    const a2 = asset({ id: "a2", macAddress: "AA:BB:CC:DD:EE:02", hostname: "pc-2", assignedTo: "jdoe" });
    await run(
      [lease(), lease({ macAddress: "aa:bb:cc:dd:ee:02", ipAddress: "10.1.0.6" })],
      [asset({ assignedTo: "jdoe" }), a2],
      { activeResMap: new Map<string, any>([["net1|10.1.0.5", res], ["net1|10.1.0.6", pushed]]) },
    ).done;
    expect(db.resUpdate).toHaveBeenCalledWith({ where: { id: "r1" }, data: { hostname: "pc-1", owner: "jdoe", macAddress: MAC } });
    expect(db.resUpdate).toHaveBeenCalledWith({ where: { id: "r2" }, data: { owner: "jdoe" } });
  });
});

describe("Phase 6 — auto-quarantine fan-out", () => {
  it("extends a quarantined asset to a gate it is newly seen on, and only verifies one already covered", async () => {
    db.assetFindMany.mockResolvedValue([{ id: "a1" }]);
    db.assetFindUnique.mockResolvedValue({ id: "a1", status: "quarantined", quarantineTargets: [{ fortigateDevice: "FGT-A", status: "synced" }] });
    m.verifyQuarantine.mockResolvedValue({ driftDetected: true, targets: [{ fortigateDevice: "FGT-A", status: "drift" }] });
    await run([lease(), lease({ device: "FGT-B", ipAddress: "10.1.0.7" })], [asset({ status: "quarantined" })]).done;
    expect(m.verifyQuarantine).toHaveBeenCalledWith("a1");
    expect(db.assetUpdate).toHaveBeenCalledWith({ where: { id: "a1" }, data: { quarantineTargets: [{ fortigateDevice: "FGT-A", status: "drift" }] } });
    expect(m.quarantine).toHaveBeenCalledWith({ assetId: "a1", actor: "system:auto-quarantine" });
  });

  it("a failed sighting flush is logged and the quarantine pass still runs", async () => {
    m.recordSightings.mockRejectedValue(new Error("db"));
    const { state, done } = run([lease()], [asset()]);
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to flush 1 asset sighting(s): db");
    expect(db.assetFindMany).toHaveBeenCalled();
  });
});

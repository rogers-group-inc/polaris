/**
 * tests/unit/dhcpMacAssociation.test.ts — the own suite for
 * src/services/discovery/dhcp/dhcpMacAssociation.ts (syncDhcpSubnets Phase 6,
 * CQ-T010). dhcpPhasesExtracted11 pins the headline paths; this file pins the
 * rest of the contract:
 *
 *   - rule 12: presence only through bumpLastSeen — never on a monitored asset,
 *     never backwards, never on Fortinet-owned infra, deferred to Phase 7 when
 *     the detected-device table covers the MAC, and only from a HELD binding;
 *   - rule 16: a live lease never pulls a maintenance asset back to active;
 *   - rule 101: the shared run-scoped ladder — wired beats Wi-Fi, a gate whose
 *     own LOCAL detected-device row corroborates the lease beats one that does
 *     not, an earlier gate's stronger claim holds;
 *   - rule 102: only a held binding on an endpoint goes on the address list;
 *   - rule 91(b): a refused hostname-only match records an unverified MAC and
 *     nothing location- or identity-shaped;
 *   - the reservation cross-update's owner-preservation and pushed-row rules,
 *     write failures, the IP-history batch and the auto-quarantine pass.
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
  refreshIpHistory: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/macAddressService.js", () => ({ reconcileMacAddresses: m.reconcileMacs }));
vi.mock("../../src/services/assetSightingService.js", () => ({ recordSightings: m.recordSightings }));
vi.mock("../../src/services/assetQuarantineService.js", () => ({ quarantineAsset: m.quarantine, verifyAssetQuarantine: m.verifyQuarantine }));
vi.mock("../../src/services/assetIpHistoryService.js", () => ({ refreshIpHistoryLastSeen: m.refreshIpHistory }));

const { associateDhcpMacs } = await import("../../src/services/discovery/dhcp/dhcpMacAssociation.js");
const { createDhcpClaimState } = await import("../../src/utils/dhcpClaimFreshness.js");
const { buildArpMacDeviceIndex } = await import("../../src/utils/inventoryLocality.js");
const { UNVERIFIED_HOSTNAME_MAC_SOURCE } = await import("../../src/utils/macAddresses.js");

const NOW = "2026-11-10T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const MAC = "AA:BB:CC:DD:EE:01";
const MAC2 = "AA:BB:CC:DD:EE:02";

beforeEach(() => {
  resetDbStub();
  vi.clearAllMocks();
  db.assetUpdate.mockResolvedValue({});
  db.resUpdate.mockResolvedValue({});
  db.assetFindMany.mockResolvedValue([]);
  m.recordSightings.mockResolvedValue(undefined);
  m.reconcileMacs.mockResolvedValue(undefined);
  m.refreshIpHistory.mockResolvedValue(undefined);
});

/** Matches by any MAC the asset lists (primary or macAddresses), like the real MAC rung. */
function index(assets: Array<Record<string, any>>, rung: "mac" | "hostname" = "mac") {
  return {
    findByEntryWithRung: (mac?: string) => {
      const norm = mac ? mac.toUpperCase().replace(/-/g, ":") : "";
      const a = assets.find((x) => x.macAddress === norm || (x.macAddresses ?? []).some((e: any) => e.mac === norm));
      return a ? { asset: a, rung } : undefined;
    },
    reindex: vi.fn(),
  };
}

const asset = (over: Record<string, unknown> = {}): Record<string, any> => ({
  id: "a1", macAddress: MAC, macAddresses: [], hostname: "pc-1", ipAddress: "10.1.0.4", ipSource: "FGT-A", learnedLocation: "FGT-A",
  status: "active", assetType: "workstation", lastSeen: null, lastSeenSource: null, fortinetTopology: null, monitored: false,
  ipOverride: null, ipBlankPinned: false, primaryAddressIp: null, hostnameOverride: null,
  ...over,
});
const lease = (over: Record<string, unknown> = {}) => ({
  macAddress: MAC.toLowerCase(), ipAddress: "10.1.0.5", type: "dhcp-lease", device: "FGT-A", seenLeased: true,
  expireTime: Math.floor(NOW_MS / 1000) + 3600, hostname: "pc-1", interfaceName: "port1", ...over,
});
const invRow = (over: Record<string, unknown> = {}) => ({
  device: "FGT-A", macAddress: MAC, ipAddress: "10.1.0.5", hostname: "pc-1", os: "", osVersion: "", hardwareVendor: "",
  interfaceName: "port1", switchName: "SW1", switchPort: "3", apName: "", user: "", isOnline: true, lastSeen: NOW, ...over,
});

function run(
  entries: unknown[],
  assets: Array<Record<string, any>>,
  over: Record<string, unknown> = {},
  deviceInventory: unknown[] = [],
) {
  const claims = (over.claims as ReturnType<typeof createDhcpClaimState>) ?? createDhcpClaimState();
  const state = {
    result: { dhcpEntries: entries, deviceInventory } as never,
    activeResMap: new Map<string, any>(), assetIdx: index(assets) as never, claims,
    arpMacDeviceIndex: buildArpMacDeviceIndex([]), bestGateClaimMsByAsset: claims.bestGateClaimMsByAsset,
    addressSightings: [] as any[], fortigateEndpointAssetIds: new Set<string>(), now: NOW,
    findSubnetForIp: (ip: string) => (ip.startsWith("10.1.") ? { id: "net1", cidr: "10.1.0.0/24", name: "LAN" } : undefined),
    reservationKey: (s: string, ip: string) => `${s}|${ip}`,
    noteEndpointGate: vi.fn(), hostnameAdoptRefused: vi.fn(() => false), noteHostnameAdoptRefused: vi.fn(),
    integrationId: "i1", integrationType: "fortigate", integrationLabel: "FortiGate Lab", syncLog: vi.fn(),
    ...over,
  };
  return { state, done: associateDhcpMacs(state as never) };
}
const written = (i = 0) => db.assetUpdate.mock.calls[i]?.[0]?.data ?? {};

describe("Phase 6 — nothing to do", () => {
  it("returns without a write when the run has no DHCP entries", async () => {
    await run([], [asset()]).done;
    await associateDhcpMacs({ ...(run([], []).state as any), result: { dhcpEntries: undefined } });
    expect(db.assetUpdate).not.toHaveBeenCalled();
    expect(m.reconcileMacs).not.toHaveBeenCalled();
  });

  it("skips an entry with no MAC or no address", async () => {
    await run([lease({ macAddress: "" }), lease({ ipAddress: "" })], [asset()]).done;
    expect(m.reconcileMacs).not.toHaveBeenCalled();
  });
});

describe("Phase 6 — presence (rule 12) and status (rules 10 / 16)", () => {
  it("does not bump Last Seen on a monitored asset — polling owns its presence", async () => {
    await run([lease()], [asset({ monitored: true })]).done;
    expect(written()).not.toHaveProperty("lastSeen");
  });

  it("never moves Last Seen backwards", async () => {
    await run([lease()], [asset({ lastSeen: new Date(NOW_MS + 60_000) })]).done;
    expect(written()).not.toHaveProperty("lastSeen");
  });

  it("an unheld reservation is configuration, not presence: no Last Seen, no status, no address-list row", async () => {
    const { state, done } = run([lease({ type: "dhcp-reservation", seenLeased: false })], [asset({ status: "storage" })]);
    await done;
    expect(written()).not.toHaveProperty("lastSeen");
    expect(written()).not.toHaveProperty("status");
    expect(state.addressSightings).toEqual([]);
  });

  it("still lets an unheld reservation stake the address when nothing else claims it", async () => {
    await run([lease({ type: "dhcp-reservation", seenLeased: false })], [asset()]).done;
    expect(written().ipAddress).toBe("10.1.0.5");
  });

  it("revives a decommissioned asset on a held lease, stamping who and when", async () => {
    const a = asset({ status: "decommissioned" });
    await run([lease()], [a]).done;
    expect(written()).toMatchObject({ status: "active", statusChangedAt: new Date(NOW), statusChangedBy: "FortiGate Lab" });
    expect(a.status).toBe("active");
  });

  it("re-stamps an active asset's status without a status-change stamp (then prunes it as unchanged)", async () => {
    await run([lease()], [asset()]).done;
    expect(written()).not.toHaveProperty("statusChangedAt");
  });

  it("never pulls a maintenance asset back to active on one held lease", async () => {
    await run([lease()], [asset({ status: "maintenance" })]).done;
    expect(written()).not.toHaveProperty("status");
  });

  // Was a bug until 2026-11-13: the phase set `asset.status = "active"` in memory on
  // ANY lease presence, including for a maintenance asset whose DB write was
  // just guarded (line 313). The next held binding for the same asset (a
  // second gate, or a second card) then sees status "active", stages
  // `status: "active"`, and the per-asset merge carries it into the write — the
  // pre-phase baseline says "maintenance", so the prune keeps it and discovery
  // ends the operator's maintenance window early (rule 16: discovery never
  // writes status over a maintenance asset). Fix: guard the in-memory mirror
  // the same way, `if (leasePresence && asset.status !== "maintenance")`.
  it("never pulls a maintenance asset back to active on a second held lease for it", async () => {
    await run([lease(), lease({ device: "FGT-B", ipAddress: "10.1.0.7" })], [asset({ status: "maintenance" })]).done;
    expect(written()).not.toHaveProperty("status");
  });

  it("does not bump a Fortinet-owned firewall from a client sighting, nor re-address it", async () => {
    await run([lease()], [asset({ assetType: "firewall", fortinetTopology: { role: "fortigate" } })]).done;
    expect(written()).not.toHaveProperty("lastSeen");
    expect(written()).not.toHaveProperty("ipAddress");
  });

  it("an operator-typed switch (no topology stamp) keeps the presence bump but not the address", async () => {
    const { state, done } = run([lease()], [asset({ assetType: "switch" })]);
    await done;
    expect(written().lastSeen).toEqual(new Date(NOW));
    expect(written()).not.toHaveProperty("ipAddress");
    // Infra still records a gateway sighting (the quarantine / gateway-attribution feed).
    expect(m.recordSightings).toHaveBeenCalledWith([expect.objectContaining({ assetId: "a1", fortigateDevice: "FGT-A" })]);
    expect(state.fortigateEndpointAssetIds.size).toBe(0);
  });

  it("defers presence to Phase 7 when inventory lists the MAC in any spelling", async () => {
    await run([lease()], [asset()], {}, [invRow({ macAddress: "aa-bb-cc-dd-ee-01", switchName: "" })]).done;
    expect(written()).not.toHaveProperty("lastSeen");
  });
});

describe("Phase 6 — the address ladder (rule 101)", () => {
  it("a later wired lease (switch-attributed by the gate's detected-device row) beats an earlier Wi-Fi lease", async () => {
    const a = asset({ macAddresses: [{ mac: MAC, lastSeen: NOW, source: "dhcp-lease" }, { mac: MAC2, lastSeen: NOW, source: "dhcp-lease" }] });
    await run([
      lease({ macAddress: MAC2, ipAddress: "10.1.0.20", ssid: "Corp-WiFi" }),
      lease({ ipAddress: "10.1.0.21" }),
    ], [a], {}, [invRow({ ipAddress: "10.1.0.21", lastSeen: "2026-11-01T00:00:00Z", isOnline: false })]).done;
    expect(written().ipAddress).toBe("10.1.0.21");
  });

  it("the gate whose own local detected-device row saw the client recently beats one that did not", async () => {
    const { state, done } = run(
      [lease({ device: "FGT-A", ipAddress: "10.1.0.5" }), lease({ device: "FGT-B", ipAddress: "10.1.0.9" })],
      [asset()], {}, [invRow({ device: "FGT-B", ipAddress: "10.1.0.9" })],
    );
    await done;
    expect(written()).toMatchObject({ ipAddress: "10.1.0.9", ipSource: "FGT-B", learnedLocation: "FGT-B" });
    expect(state.noteEndpointGate).toHaveBeenLastCalledWith("a1", "FGT-B");
  });

  it("a non-local (ZTNA-relayed) detected-device row corroborates nothing", async () => {
    await run(
      [lease({ device: "FGT-A", ipAddress: "10.1.0.5" }), lease({ device: "FGT-B", ipAddress: "10.1.0.9" })],
      [asset()], {}, [invRow({ device: "FGT-B", switchName: "", apName: "" })],
    ).done;
    expect(written().ipAddress).toBe("10.1.0.5");
  });

  it("an equal later claim keeps the first", async () => {
    await run([lease({ device: "FGT-A", ipAddress: "10.1.0.5" }), lease({ device: "FGT-B", ipAddress: "10.1.0.9" })], [asset()]).done;
    expect(written().ipAddress).toBe("10.1.0.5");
  });

  it("an earlier gate's stronger claim in the shared run state holds", async () => {
    const claims = createDhcpClaimState();
    claims.bestAddressClaimByAsset.set("a1", [9, 1, 2, 1, NOW_MS, 0]);
    const { state, done } = run([lease()], [asset()], { claims });
    await done;
    expect(written()).not.toHaveProperty("ipAddress");
    expect(state.noteEndpointGate).not.toHaveBeenCalled();
    // The losing entry still contributes its MAC row, presence and sighting.
    expect(written().lastSeen).toEqual(new Date(NOW));
    expect(m.recordSightings).toHaveBeenCalled();
  });

  it("an entry with no gate stages the integration type as the source and no location", async () => {
    const { state, done } = run([lease({ device: "" })], [asset({ learnedLocation: null })]);
    await done;
    expect(written()).toMatchObject({ ipAddress: "10.1.0.5", ipSource: "fortigate" });
    expect(written()).not.toHaveProperty("learnedLocation");
    expect(m.recordSightings).not.toHaveBeenCalled();
    expect(state.addressSightings).toEqual([]);
  });

  it("names the gate's freshness: now for a held lease, the inventory sighting for an unheld one, else 0", async () => {
    const held = run([lease()], [asset()]);
    await held.done;
    expect(held.state.bestGateClaimMsByAsset.get("a1")).toBe(NOW_MS);

    const seen = "2026-11-10T11:30:00.000Z";
    const unheld = run([lease({ type: "dhcp-reservation", seenLeased: false })], [asset()], {}, [invRow({ isOnline: false, lastSeen: seen })]);
    await unheld.done;
    expect(unheld.state.bestGateClaimMsByAsset.get("a1")).toBe(Date.parse(seen));

    const bare = run([lease({ type: "dhcp-reservation", seenLeased: false })], [asset()]);
    await bare.done;
    expect(bare.state.bestGateClaimMsByAsset.get("a1")).toBe(0);
  });
});

describe("Phase 6 — the MAC list", () => {
  it("refreshes an existing entry's time, source and network", async () => {
    const a = asset({ macAddresses: [{ mac: MAC, lastSeen: "2026-01-01T00:00:00Z", source: "arp" }] });
    await run([lease({ type: "dhcp-reservation" })], [a]).done;
    expect(m.reconcileMacs).toHaveBeenCalledWith("a1", [{ mac: MAC, lastSeen: NOW, source: "dhcp-reservation", subnetCidr: "10.1.0.0/24", subnetName: "LAN" }]);
  });

  it("never relabels a hardware-truth entry, and keeps it primary over a fresher sighting", async () => {
    const a = asset({
      macAddress: MAC,
      macAddresses: [{ mac: MAC, lastSeen: "2026-01-01T00:00:00Z", source: "intune-ethernet" }, { mac: MAC2, lastSeen: "2026-01-01T00:00:00Z", source: "arp" }],
    });
    await run([lease({ macAddress: MAC2 })], [a]).done;
    const macs = m.reconcileMacs.mock.calls[0][1];
    expect(macs.find((e: any) => e.mac === MAC).source).toBe("intune-ethernet");
    expect(a.macAddress).toBe(MAC);
  });

  it("leaves the network off a new entry outside every known network", async () => {
    await run([lease({ ipAddress: "192.168.1.5" })], [asset({ macAddresses: [] })]).done;
    expect(m.reconcileMacs.mock.calls[0][1][0]).toEqual({ mac: MAC, lastSeen: NOW, source: "dhcp-lease" });
  });

  it("one asset seen on two gates gets one write and one reconcile with the cumulative list", async () => {
    const a = asset({ macAddresses: [{ mac: MAC2, lastSeen: NOW, source: "arp" }] });
    await run([lease(), lease({ macAddress: MAC2, device: "FGT-B", ipAddress: "10.1.0.9" })], [a]).done;
    expect(db.assetUpdate).toHaveBeenCalledTimes(1);
    expect(m.reconcileMacs).toHaveBeenCalledTimes(1);
    expect(m.reconcileMacs.mock.calls[0][1].map((e: any) => e.mac).sort()).toEqual([MAC, MAC2]);
  });
});

describe("Phase 6 — a refused hostname-only match (rule 91(b))", () => {
  it("records the MAC as unverified, keeps the primary, and writes nothing location- or identity-shaped", async () => {
    const a = asset({ macAddress: "11:22:33:44:55:66", macAddresses: [], assignedTo: "jdoe", monitored: true });
    const res = { id: "r1", hostname: "pc-1", owner: "someone", macAddress: "99:99:99:99:99:99" };
    const { state, done } = run([lease()], [a], {
      assetIdx: { findByEntryWithRung: () => ({ asset: a, rung: "hostname" }), reindex: vi.fn() },
      hostnameAdoptRefused: vi.fn(() => true),
      activeResMap: new Map([["net1|10.1.0.5", res]]),
    });
    await done;
    expect(state.noteHostnameAdoptRefused).toHaveBeenCalledWith(a, MAC, "10.1.0.5", "pc-1", "dhcp-lease", "FGT-A");
    expect(m.reconcileMacs.mock.calls[0][1]).toEqual([expect.objectContaining({ mac: MAC, source: UNVERIFIED_HOSTNAME_MAC_SOURCE })]);
    expect(written()).not.toHaveProperty("ipAddress");
    expect(written()).not.toHaveProperty("learnedLocation");
    expect(written()).not.toHaveProperty("macAddress");
    expect(a.macAddress).toBe("11:22:33:44:55:66");
    expect(state.addressSightings).toEqual([]);
    expect(state.fortigateEndpointAssetIds.size).toBe(0);
    expect(state.noteEndpointGate).not.toHaveBeenCalled();
    expect(state.claims.bestAddressClaimByAsset.has("a1")).toBe(false);
    expect(m.recordSightings).not.toHaveBeenCalled();
    // The reservation keeps its owner (the lease holder is not shown to be the asset's device).
    expect(db.resUpdate).toHaveBeenCalledWith({ where: { id: "r1" }, data: { macAddress: MAC } });
  });

  it("does not launder an existing unverified entry into an ordinary one", async () => {
    const a = asset({ macAddress: "11:22:33:44:55:66", macAddresses: [{ mac: MAC, lastSeen: "2026-01-01T00:00:00Z", source: UNVERIFIED_HOSTNAME_MAC_SOURCE }] });
    await run([lease()], [a], { hostnameAdoptRefused: vi.fn(() => true) }).done;
    expect(m.reconcileMacs.mock.calls[0][1][0].source).toBe(UNVERIFIED_HOSTNAME_MAC_SOURCE);
  });
});

describe("Phase 6 — reservation cross-update", () => {
  const withRes = (res: Record<string, unknown>, a = asset({ assignedTo: "jdoe" })) =>
    run([lease()], [a], { activeResMap: new Map([["net1|10.1.0.5", res]]) });

  it("writes nothing for a reservation that already matches", async () => {
    await withRes({ id: "r1", hostname: "pc-1", owner: "x", macAddress: "aa-bb-cc-dd-ee-01" }).done;
    expect(db.resUpdate).not.toHaveBeenCalled();
  });

  it("keeps a Polaris-set owner while the MAC is unchanged, but follows the hostname", async () => {
    await withRes({ id: "r1", hostname: "old-name", owner: "operator-choice", macAddress: MAC }).done;
    expect(db.resUpdate).toHaveBeenCalledWith({ where: { id: "r1" }, data: { hostname: "pc-1" } });
  });

  it("fills the MAC (and owner) on a legacy row that had none", async () => {
    const res = { id: "r1", hostname: "pc-1", owner: null, macAddress: null };
    await withRes(res).done;
    expect(db.resUpdate).toHaveBeenCalledWith({ where: { id: "r1" }, data: { owner: "jdoe", macAddress: MAC } });
    expect(res).toMatchObject({ owner: "jdoe", macAddress: MAC });
  });

  it("does not rewrite the MAC of a row with a push status (Phase 7.7 owns pushed rows)", async () => {
    await withRes({ id: "r1", hostname: "pc-1", owner: "jdoe", macAddress: MAC2, pushStatus: "pending" }).done;
    expect(db.resUpdate).not.toHaveBeenCalled();
  });

  it("stamps no owner for an asset nobody is assigned to, and no hostname for an unnamed asset", async () => {
    await withRes({ id: "r1", hostname: "x", owner: "y", macAddress: MAC2 }, asset({ hostname: null })).done;
    expect(db.resUpdate).toHaveBeenCalledWith({ where: { id: "r1" }, data: { macAddress: MAC } });
  });

  it("does nothing for an address in no known network", async () => {
    await run([lease({ ipAddress: "192.168.1.5" })], [asset()], { activeResMap: new Map([["net1|192.168.1.5", { id: "r1" }]]) }).done;
    expect(db.resUpdate).not.toHaveBeenCalled();
  });
});

describe("Phase 6 — writes", () => {
  it("logs a failed asset write with the address it staged", async () => {
    db.assetUpdate.mockRejectedValue(new Error("deadlock"));
    const { state, done } = run([lease()], [asset()]);
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to update asset MAC/IP for asset a1 (10.1.0.5): deadlock");
    // The MAC reconcile rides behind the write and is skipped with it.
    expect(m.reconcileMacs).not.toHaveBeenCalled();
  });

  it("says 'no ip staged' when the failed write carried none", async () => {
    db.assetUpdate.mockRejectedValue(new Error("x"));
    const sw = asset({ assetType: "switch" });
    const { state, done } = run([lease()], [sw]);
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to update asset MAC/IP for asset a1 (no ip staged): x");
  });

  it("refreshes IP history in one batch for an address the write dropped as unchanged", async () => {
    await run([lease()], [asset({ ipAddress: "10.1.0.5" })]).done;
    expect(written()).not.toHaveProperty("ipAddress");
    expect(m.refreshIpHistory).toHaveBeenCalledWith([{ assetId: "a1", ip: "10.1.0.5", source: "FGT-A" }]);
  });

  it("keeps staging the address on a pinned asset (the db.ts guard owns the pin)", async () => {
    await run([lease()], [asset({ ipAddress: "10.1.0.5", ipOverride: "10.1.0.5" })]).done;
    expect(written().ipAddress).toBe("10.1.0.5");
    expect(m.refreshIpHistory).not.toHaveBeenCalled();
  });

  it("reindexes the asset after each entry so later lookups see the change", async () => {
    const { state, done } = run([lease()], [asset()]);
    await done;
    expect((state.assetIdx as any).reindex).toHaveBeenCalledWith(expect.objectContaining({ id: "a1", ipAddress: "10.1.0.5" }));
  });

  it("labels a reservation sighting dhcp_reservation and names it by the asset's standing address when it has no hostname", async () => {
    await run([lease({ type: "dhcp-reservation" })], [asset({ hostname: null })]).done;
    expect(m.recordSightings).toHaveBeenCalledWith([expect.objectContaining({
      source: "dhcp_reservation", integrationId: "i1", ipAddress: "10.1.0.5", assetHostname: "10.1.0.4",
    })]);
  });
});

describe("Phase 6 — auto-quarantine", () => {
  it("screens with one read and quarantines on each new gate once per (asset, gate)", async () => {
    db.assetFindMany.mockResolvedValue([{ id: "a1" }]);
    db.assetFindUnique.mockResolvedValue({ id: "a1", status: "quarantined", quarantineTargets: [{ fortigateDevice: "FGT-A", status: "failed" }] });
    m.quarantine.mockResolvedValue({});
    await run([lease(), lease({ ipAddress: "10.1.0.6" })], [asset({ status: "quarantined" })]).done;
    expect(db.assetFindMany).toHaveBeenCalledWith({ where: { id: { in: ["a1"] }, status: "quarantined" }, select: { id: true } });
    expect(m.quarantine).toHaveBeenCalledTimes(1);
    expect(m.verifyQuarantine).not.toHaveBeenCalled();
  });

  it("does not re-read assets the screen says are not quarantined", async () => {
    await run([lease()], [asset()]).done;
    expect(db.assetFindUnique).not.toHaveBeenCalled();
    expect(m.quarantine).not.toHaveBeenCalled();
  });

  it("skips an asset released from quarantine between the screen and the re-read", async () => {
    db.assetFindMany.mockResolvedValue([{ id: "a1" }]);
    db.assetFindUnique.mockResolvedValue({ id: "a1", status: "active", quarantineTargets: [] });
    await run([lease()], [asset()]).done;
    expect(m.quarantine).not.toHaveBeenCalled();
  });

  it("verifies a covered gate and writes nothing when there is no drift", async () => {
    db.assetFindMany.mockResolvedValue([{ id: "a1" }]);
    db.assetFindUnique.mockResolvedValue({ id: "a1", status: "quarantined", quarantineTargets: [{ fortigateDevice: "FGT-A", status: "synced" }] });
    m.verifyQuarantine.mockResolvedValue({ driftDetected: false, targets: [] });
    await run([lease()], [asset({ status: "quarantined", ipAddress: "10.1.0.5" })]).done;
    expect(m.verifyQuarantine).toHaveBeenCalledWith("a1");
    expect(db.assetUpdate.mock.calls.some((c) => "quarantineTargets" in c[0].data)).toBe(false);
  });

  it("logs and skips the pass when the screen read fails", async () => {
    db.assetFindMany.mockRejectedValue(new Error("db"));
    const { state, done } = run([lease()], [asset()]);
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Auto-quarantine pre-read failed, skipping the pass: db");
    expect(db.assetFindUnique).not.toHaveBeenCalled();
  });

  it("logs a per-pair failure and carries on", async () => {
    db.assetFindMany.mockResolvedValue([{ id: "a1" }]);
    db.assetFindUnique.mockResolvedValue({ id: "a1", status: "quarantined", quarantineTargets: [] });
    m.quarantine.mockRejectedValueOnce(new Error("gate down")).mockResolvedValueOnce({});
    const { state, done } = run([lease(), lease({ device: "FGT-B", ipAddress: "10.1.0.7" })], [asset({ status: "quarantined" })]);
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Auto-quarantine check failed for asset a1 on FGT-A: gate down");
    expect(m.quarantine).toHaveBeenCalledTimes(2);
  });
});

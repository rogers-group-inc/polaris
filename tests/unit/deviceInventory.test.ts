/**
 * tests/unit/deviceInventory.test.ts — the own suite for
 * src/services/discovery/dhcp/deviceInventory.ts (syncDhcpSubnets Phase 7,
 * CQ-T010). dhcpPhasesExtracted10 pins the create path's headline cases; this
 * file pins the UPDATE path and the create path's edges:
 *
 *   - rule 12: presence is the gate's own per-client last_seen (now only for an
 *     online row), only through bumpLastSeen — never on a monitored asset,
 *     never backwards, never on Fortinet-owned infra — and a remembered-but-
 *     offline row never resurrects a decommissioned asset;
 *   - locality: only a row with switch / AP / same-gate ARP evidence may write
 *     the address, the learned location, the MAC's gate or the endpoint gate;
 *   - rule 101: the row competes on the shared ladder — an untrusted (ARP-
 *     contradicted or multi-homed) row fills a blank address but never moves
 *     one, and loses to a held reservation;
 *   - rule 102: only an online local row goes on the address list;
 *   - rule 91(b): a refused hostname-only match keeps presence and records an
 *     unverified MAC, and nothing else;
 *   - the deferred flush: one merged write per asset, failures logged per row.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const db = {
  create: stubbed(prisma.asset.create),
  update: stubbed(prisma.asset.update),
};

const m = vi.hoisted(() => ({
  logCreated: vi.fn(),
  logUpdated: vi.fn(),
  reconcileMacs: vi.fn(),
  planSuffixes: vi.fn(),
  refreshIpHistory: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", () => ({ logDiscoveryAssetCreated: m.logCreated, logDiscoveryAssetUpdated: m.logUpdated }));
vi.mock("../../src/services/macAddressService.js", () => ({ reconcileMacAddresses: m.reconcileMacs }));
vi.mock("../../src/services/hostnameMacSuffixService.js", () => ({ planHostnameMacSuffixes: m.planSuffixes }));
vi.mock("../../src/services/assetIpHistoryService.js", () => ({ refreshIpHistoryLastSeen: m.refreshIpHistory }));

const { syncDeviceInventory } = await import("../../src/services/discovery/dhcp/deviceInventory.js");
const { createDhcpClaimState, scoreAddressClaim } = await import("../../src/utils/dhcpClaimFreshness.js");
const { buildArpMacDeviceIndex, buildArpIpsByMacDevice } = await import("../../src/utils/inventoryLocality.js");
const { UNVERIFIED_HOSTNAME_MAC_SOURCE } = await import("../../src/utils/macAddresses.js");

const NOW = "2026-11-10T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const EARLIER = "2026-11-10T09:00:00.000Z";
const MAC = "AA:BB:CC:DD:EE:01";
const MAC2 = "AA:BB:CC:DD:EE:02";

let nextId = 0;
beforeEach(() => {
  resetDbStub();
  vi.clearAllMocks();
  nextId = 0;
  db.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: `new${++nextId}`, ...data }));
  db.update.mockResolvedValue({});
  m.planSuffixes.mockResolvedValue([]);
  m.reconcileMacs.mockResolvedValue(undefined);
  m.refreshIpHistory.mockResolvedValue(undefined);
});

/** A run index whose MAC rung finds the listed assets (any MAC on their list), with the real add/findById/reindex shape. */
function index(assets: Array<Record<string, any>>, rung: "mac" | "hostname" = "mac") {
  const rows = new Map<string, any>(assets.map((a) => [a.id, a]));
  return {
    rows,
    findByEntryWithRung: vi.fn((mac?: string) => {
      const norm = mac ? mac.toUpperCase().replace(/-/g, ":") : "";
      const a = [...rows.values()].find((x) => norm && (x.macAddress === norm || (x.macAddresses ?? []).some((e: any) => e.mac === norm)));
      return a ? { asset: a, rung } : undefined;
    }),
    findById: (id: string) => rows.get(id),
    add: (a: any) => rows.set(a.id, a),
    reindex: vi.fn(),
  };
}

const asset = (over: Record<string, unknown> = {}): Record<string, any> => ({
  id: "a1", hostname: "pc-1", macAddress: MAC, macAddresses: [{ mac: MAC, lastSeen: EARLIER, source: "dhcp-lease" }],
  ipAddress: "10.1.0.4", ipSource: "FGT-A", learnedLocation: "FGT-A", assetType: "workstation", status: "active",
  os: "Windows", osVersion: "11", manufacturer: "Dell", lastSeen: new Date(EARLIER), lastSeenSource: "dhcp-lease",
  lastSeenSwitch: null, lastSeenAp: null, associatedUsers: [], fortinetTopology: null, monitored: false,
  ipOverride: null, ipBlankPinned: false, primaryAddressIp: null, hostnameOverride: null,
  ...over,
});
const inv = (over: Record<string, unknown> = {}) => ({
  device: "FGT-A", macAddress: MAC.toLowerCase(), ipAddress: "10.1.0.40", hostname: "pc-1", os: "Windows", osVersion: "11 24H2",
  hardwareVendor: "Dell", interfaceName: "port1", switchName: "SW1", switchPort: "7", apName: "", user: "",
  isOnline: true, lastSeen: EARLIER, ...over,
});

function run(
  rows: unknown[],
  assets: Array<Record<string, any>> = [],
  over: Record<string, unknown> = {},
  resultOver: Record<string, unknown> = {},
) {
  const arpTable = (resultOver.arpTable as unknown[]) ?? [];
  const claims = (over.claims as ReturnType<typeof createDhcpClaimState>) ?? createDhcpClaimState();
  const state = {
    result: { dhcpEntries: [], arpTable, deviceInventory: rows, ...resultOver } as never,
    assetIdx: index(assets) as never,
    allReservationsRaw: [] as Array<{ hostname: string | null; ipAddress: string | null }>,
    claims,
    arpMacDeviceIndex: buildArpMacDeviceIndex(arpTable as never),
    arpIpsByMacDevice: buildArpIpsByMacDevice(arpTable as never),
    bestGateClaimMsByAsset: claims.bestGateClaimMsByAsset,
    addressSightings: [] as any[], fortigateEndpointAssetIds: new Set<string>(), inventoryAssets: [] as string[], now: NOW,
    noteChangeBaseline: vi.fn(), noteEndpointGate: vi.fn(),
    hostnameAdoptRefused: vi.fn(() => false), noteHostnameAdoptRefused: vi.fn(),
    inferInventoryAssetType: vi.fn(() => "other"),
    integrationId: "i1", integrationName: "Lab FGT", integrationType: "fortigate", integrationLabel: "FortiGate Lab",
    actor: "system", syncLog: vi.fn(),
    ...over,
  };
  return { state, done: syncDeviceInventory(state as never) };
}
const written = (i = 0) => db.update.mock.calls[i]?.[0]?.data ?? {};

describe("Phase 7 — nothing to do", () => {
  it("returns without I/O for a missing or empty inventory", async () => {
    await run([]).done;
    await run(undefined as never).done;
    expect(db.create).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("looks an asset up by MAC and hostname, never by its (recycled) address", async () => {
    const { state, done } = run([inv()]);
    await done;
    expect((state.assetIdx as any).findByEntryWithRung).toHaveBeenCalledWith(
      MAC.toLowerCase(), "pc-1", "10.1.0.40", { allowIpFallback: false, serialHostname: true, allowHostname: false },
    );
  });
});

describe("Phase 7 — presence on an existing asset (rule 12)", () => {
  it("an online local row moves the address, names the gate and stamps now, in one deferred write", async () => {
    const a = asset();
    const { state, done } = run([inv()], [a]);
    await done;
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.update.mock.calls[0][0].where).toEqual({ id: "a1" });
    expect(written()).toMatchObject({
      ipAddress: "10.1.0.40", ipSource: "FGT-A", lastSeen: new Date(NOW), lastSeenSource: "device-inventory",
      osVersion: "11 24H2", lastSeenSwitch: "SW1/port7",
    });
    expect(state.addressSightings).toEqual([{
      assetId: "a1", mac: MAC, ip: "10.1.0.40", source: "device-inventory", device: "FGT-A", medium: "wired", seenAt: new Date(NOW),
    }]);
    expect(state.noteEndpointGate).toHaveBeenCalledWith("a1", "FGT-A");
    expect(state.bestGateClaimMsByAsset.get("a1")).toBe(NOW_MS);
    expect(state.fortigateEndpointAssetIds.has("a1")).toBe(true);
    expect(state.inventoryAssets).toEqual(["pc-1 (updated)"]);
    expect(a.ipAddress).toBe("10.1.0.40"); // the run index follows
    expect((state.assetIdx as any).reindex).toHaveBeenCalledWith(a);
  });

  it("an offline row stamps the gate's own last_seen, not the run time, and adds no address-list row", async () => {
    const seen = "2026-11-10T11:00:00.000Z";
    const { state, done } = run([inv({ isOnline: false, lastSeen: seen })], [asset()]);
    await done;
    expect(written().lastSeen).toEqual(new Date(seen));
    expect(state.addressSightings).toEqual([]);
  });

  it("an offline row older than the stored Last Seen does not move it backwards", async () => {
    await run([inv({ isOnline: false, lastSeen: "2026-11-01T00:00:00Z" })], [asset()]).done;
    expect(written()).not.toHaveProperty("lastSeen");
  });

  it("does not bump a monitored asset — polling owns its presence", async () => {
    await run([inv()], [asset({ monitored: true })]).done;
    expect(written()).not.toHaveProperty("lastSeen");
  });

  it("an unparseable last_seen on an offline row bumps nothing", async () => {
    const { done } = run([inv({ isOnline: false, lastSeen: "garbage" })], [asset()]);
    await done;
    expect(written()).not.toHaveProperty("lastSeen");
  });

  it("revives a decommissioned asset only when the row is online right now", async () => {
    await run([inv()], [asset({ status: "decommissioned" })]).done;
    expect(written()).toMatchObject({ status: "active", statusChangedAt: new Date(NOW), statusChangedBy: "FortiGate Lab" });
  });

  it("a remembered-but-offline row never undoes a decommission", async () => {
    await run([inv({ isOnline: false, lastSeen: NOW })], [asset({ status: "decommissioned" })]).done;
    expect(written()).not.toHaveProperty("status");
  });

  it("never touches a maintenance asset's status", async () => {
    await run([inv()], [asset({ status: "maintenance" })]).done;
    expect(written()).not.toHaveProperty("status");
  });
});

describe("Phase 7 — Fortinet infrastructure", () => {
  it("a Fortinet-owned AP takes no presence, address or OS from a client-side sighting", async () => {
    const ap = asset({ assetType: "access_point", os: "FortiAP", osVersion: "7.4.5", fortinetTopology: { role: "fortiap" } });
    const { state, done } = run([inv({ os: "FortiAP", osVersion: "7.4.5 Build 0734" })], [ap]);
    await done;
    expect(written()).not.toHaveProperty("lastSeen");
    expect(written()).not.toHaveProperty("ipAddress");
    expect(written()).not.toHaveProperty("osVersion");
    expect(state.fortigateEndpointAssetIds.size).toBe(0);
    expect(state.noteEndpointGate).not.toHaveBeenCalled();
    expect(state.addressSightings).toEqual([]);
  });

  it("an operator-typed firewall (no topology stamp) keeps the presence bump but never the address or OS", async () => {
    await run([inv()], [asset({ assetType: "firewall", os: null })]).done;
    expect(written().lastSeen).toEqual(new Date(NOW));
    expect(written()).not.toHaveProperty("ipAddress");
    expect(written()).not.toHaveProperty("os");
    expect(written()).not.toHaveProperty("osVersion");
  });
});

describe("Phase 7 — locality (ZTNA relays)", () => {
  it("a row with no local evidence records presence and fingerprints but no address, location or gate", async () => {
    const a = asset({ os: null, learnedLocation: null });
    const { state, done } = run([inv({ switchName: "", switchPort: "" })], [a]);
    await done;
    expect(written()).toMatchObject({ lastSeen: new Date(NOW), os: "Windows" });
    expect(written()).not.toHaveProperty("ipAddress");
    expect(written()).not.toHaveProperty("learnedLocation");
    expect(state.addressSightings).toEqual([]);
    expect(state.noteEndpointGate).not.toHaveBeenCalled();
    expect(m.reconcileMacs.mock.calls[0][1].find((e: any) => e.mac === MAC)).not.toHaveProperty("device");
  });

  it("same-gate ARP evidence makes the row local", async () => {
    const { state, done } = run(
      [inv({ switchName: "", switchPort: "" })], [asset()], {},
      { arpTable: [{ mac: MAC, ip: "10.1.0.40", fortigateDevice: "fgt-a" }] },
    );
    await done;
    expect(written().ipAddress).toBe("10.1.0.40");
    expect(state.noteEndpointGate).toHaveBeenCalledWith("a1", "FGT-A");
  });

  it("a FortiAP-attributed row is local and its claim is wireless", async () => {
    const { state, done } = run([inv({ switchName: "", switchPort: "", apName: "AP-LOBBY" })], [asset()]);
    await done;
    expect(written()).toMatchObject({ ipAddress: "10.1.0.40", lastSeenAp: "AP-LOBBY" });
    expect(state.addressSightings[0].medium).toBe("wireless");
  });

  it("a switch with no port is recorded by name alone", async () => {
    await run([inv({ switchPort: "" })], [asset()]).done;
    expect(written().lastSeenSwitch).toBe("SW1");
  });
});

describe("Phase 7 — the address ladder (rule 101)", () => {
  it("an ARP-contradicted row does not move an asset off its address", async () => {
    await run([inv()], [asset()], {}, { arpTable: [{ mac: MAC, ip: "10.1.0.99", fortigateDevice: "FGT-A" }] }).done;
    expect(written()).not.toHaveProperty("ipAddress");
    expect(written()).not.toHaveProperty("ipSource");
  });

  it("an ARP-contradicted row may still fill a blank address", async () => {
    await run([inv()], [asset({ ipAddress: null })], {}, { arpTable: [{ mac: MAC, ip: "10.1.0.99", fortigateDevice: "FGT-A" }] }).done;
    expect(written().ipAddress).toBe("10.1.0.40");
  });

  it("a row whose MAC the gate's ARP table has on several addresses is untrusted too", async () => {
    await run([inv()], [asset()], {}, {
      arpTable: [
        { mac: MAC, ip: "10.1.0.40", fortigateDevice: "FGT-A" },
        { mac: MAC, ip: "10.1.0.41", fortigateDevice: "FGT-A" },
      ],
    }).done;
    expect(written()).not.toHaveProperty("ipAddress");
  });

  it("an offline row loses to a held reservation Phase 6 already staked", async () => {
    const claims = createDhcpClaimState();
    claims.bestAddressClaimByAsset.set("a1", scoreAddressClaim({ kind: "dhcp-reservation", current: true }, NOW_MS));
    await run([inv({ isOnline: false, lastSeen: NOW })], [asset()], { claims }).done;
    expect(written()).not.toHaveProperty("ipAddress");
  });

  it("an online row outranks a held lease and records its own claim", async () => {
    const claims = createDhcpClaimState();
    claims.bestAddressClaimByAsset.set("a1", scoreAddressClaim({ kind: "dhcp-lease", current: true }, NOW_MS));
    await run([inv()], [asset()], { claims }).done;
    expect(written().ipAddress).toBe("10.1.0.40");
    expect(claims.bestAddressClaimByAsset.get("a1")![0]).toBe(4);
  });

  it("an agreeing online row stakes its claim without restaging the address", async () => {
    const claims = createDhcpClaimState();
    await run([inv({ ipAddress: "10.1.0.4" })], [asset()], { claims }).done;
    expect(written()).not.toHaveProperty("ipAddress");
    expect(claims.bestAddressClaimByAsset.has("a1")).toBe(true);
  });

  it("restages an address equal to the pin so the db.ts guard can release it, and mirrors the release in memory", async () => {
    const a = asset({ ipAddress: "10.1.0.40", ipOverride: "10.1.0.40" });
    await run([inv()], [a]).done;
    expect(written().ipAddress).toBe("10.1.0.40");
    expect(a.ipOverride).toBeNull();
  });

  it("falls back to the integration type as the source when the row names no gate", async () => {
    await run([inv({ device: "" })], [asset()]).done;
    // No gate → the row cannot be local by ARP, but the switch attribution still makes it local.
    expect(written()).toMatchObject({ ipAddress: "10.1.0.40", ipSource: "fortigate" });
  });
});

describe("Phase 7 — fingerprints and users", () => {
  it("fills OS and manufacturer only when blank, always refreshes the OS version, and notes the change baseline", async () => {
    const a = asset({ os: null, manufacturer: null });
    const { state, done } = run([inv()], [a]);
    await done;
    expect(written()).toMatchObject({ os: "Windows", manufacturer: "Dell", osVersion: "11 24H2" });
    expect(state.noteChangeBaseline).toHaveBeenCalledWith(a, ["os", "osVersion", "lastSeenSwitch"]);
  });

  it("never overwrites an OS or manufacturer the asset already has", async () => {
    await run([inv({ os: "Linux", hardwareVendor: "Acme" })], [asset()]).done;
    expect(written()).not.toHaveProperty("os");
    expect(written()).not.toHaveProperty("manufacturer");
  });

  it("fills a blank learned location from a local row even when the address claim loses", async () => {
    const claims = createDhcpClaimState();
    claims.bestAddressClaimByAsset.set("a1", [9, 9, 9, 9, 9, 9]);
    await run([inv()], [asset({ learnedLocation: null })], { claims }).done;
    expect(written()).toMatchObject({ learnedLocation: "FGT-A" });
    expect(written()).not.toHaveProperty("ipAddress");
  });

  it("refreshes an existing DOMAIN\\user sighting and re-sorts the list newest first", async () => {
    const a = asset({ associatedUsers: [
      { user: "other", lastSeen: "2026-11-05T00:00:00.000Z", source: "intune" },
      { user: "jdoe", domain: "CORP", lastSeen: "2026-11-01T00:00:00.000Z", source: "intune" },
    ] });
    await run([inv({ user: "CORP\\jdoe" })], [a]).done;
    expect(written().associatedUsers).toEqual([
      { user: "jdoe", domain: "CORP", lastSeen: NOW, source: "device-inventory" },
      { user: "other", lastSeen: "2026-11-05T00:00:00.000Z", source: "intune" },
    ]);
  });

  it("adds a new user beside the existing ones", async () => {
    const a = asset({ associatedUsers: [{ user: "other", lastSeen: "2026-11-05T00:00:00.000Z", source: "intune" }] });
    await run([inv({ user: "CORP\\jdoe" })], [a]).done;
    expect(written().associatedUsers.map((u: any) => u.user)).toEqual(["jdoe", "other"]);
  });

  // Was a bug until 2026-11-13: the phase copied associatedUsers with a SHALLOW spread,
  // then 338-339 mutate the matched entry in place — which is also the entry
  // inside existingAsset.associatedUsers. pruneUnchangedAssetFields (line 393)
  // then compares the staged list against that already-mutated array, finds
  // them equal whenever the order did not change, and DROPS the write. So the
  // commonest case — a device whose one known user is sighted again — never
  // persists the refreshed lastSeen / source: stored stays Nov 1 / "intune"
  // run after run. Fix: clone the entries before mutating
  // (`(existingAsset.associatedUsers as any[]).map((u) => ({ ...u }))`).
  it("persists the refresh of a device's only known user", async () => {
    const a = asset({ associatedUsers: [{ user: "jdoe", domain: "CORP", lastSeen: "2026-11-01T00:00:00.000Z", source: "intune" }] });
    await run([inv({ user: "CORP\\jdoe" })], [a]).done;
    expect(written().associatedUsers).toEqual([{ user: "jdoe", domain: "CORP", lastSeen: NOW, source: "device-inventory" }]);
  });

  it("records a bare username with no domain", async () => {
    await run([inv({ user: "kiosk" })], [asset()]).done;
    expect(written().associatedUsers).toEqual([{ user: "kiosk", domain: undefined, lastSeen: NOW, source: "device-inventory" }]);
  });
});

describe("Phase 7 — the MAC list", () => {
  it("leaves the MAC list to Phase 6 when the DHCP table covers the MAC", async () => {
    await run([inv()], [asset()], {}, { dhcpEntries: [{ macAddress: "aa-bb-cc-dd-ee-01", ipAddress: "10.1.0.40" }] }).done;
    expect(m.reconcileMacs).not.toHaveBeenCalled();
    expect(written()).not.toHaveProperty("macAddress");
  });

  it("advances an entry's time to the evidence, relabels a sighting and stamps the local gate", async () => {
    await run([inv({ isOnline: false, lastSeen: "2026-11-10T11:00:00.000Z" })], [asset()]).done;
    expect(m.reconcileMacs).toHaveBeenCalledWith("a1", [{ mac: MAC, lastSeen: "2026-11-10T11:00:00.000Z", source: "device-inventory", device: "FGT-A" }]);
  });

  it("never moves an entry's time backwards", async () => {
    const a = asset({ macAddresses: [{ mac: MAC, lastSeen: "2026-11-10T11:30:00.000Z", source: "dhcp-lease" }] });
    await run([inv({ isOnline: false, lastSeen: "2026-11-10T11:00:00.000Z" })], [a]).done;
    expect(m.reconcileMacs.mock.calls[0][1][0].lastSeen).toBe("2026-11-10T11:30:00.000Z");
  });

  it("never relabels a hardware-truth entry, which stays primary over a fresher sighting", async () => {
    const a = asset({
      macAddress: MAC2,
      macAddresses: [{ mac: MAC2, lastSeen: "2026-01-01T00:00:00.000Z", source: "intune-ethernet" }, { mac: MAC, lastSeen: EARLIER, source: "arp" }],
    });
    await run([inv()], [a]).done;
    const list = m.reconcileMacs.mock.calls[0][1];
    expect(list.find((e: any) => e.mac === MAC2).source).toBe("intune-ethernet");
    expect(list.find((e: any) => e.mac === MAC).source).toBe("device-inventory");
    expect(a.macAddress).toBe(MAC2);
  });

  it("an unchanged device whose only change is its MAC entry still reconciles and counts as touched", async () => {
    // Monitored (no presence write) and every fingerprint equal: the write prunes to nothing.
    const a = asset({ monitored: true, osVersion: "11 24H2", lastSeenSwitch: "SW1/port7", ipAddress: "10.1.0.40" });
    const { state, done } = run([inv()], [a]);
    await done;
    expect(db.update).not.toHaveBeenCalled();
    expect(m.reconcileMacs).toHaveBeenCalledTimes(1);
    expect(state.inventoryAssets).toEqual(["pc-1 (updated)"]);
    // An agreeing address is never staged in the first place, so there is no IP history to refresh.
    expect(m.refreshIpHistory).not.toHaveBeenCalled();
  });
});

describe("Phase 7 — a refused hostname-only match (rule 91(b))", () => {
  it("keeps presence, records the MAC unverified, and writes nothing location- or identity-shaped", async () => {
    const a = asset({ macAddress: MAC2, macAddresses: [{ mac: MAC2, lastSeen: EARLIER, source: "intune-ethernet" }], os: null, assetType: "other" });
    const idx = index([a], "hostname");
    idx.findByEntryWithRung.mockImplementation(() => ({ asset: a, rung: "hostname" }));
    const { state, done } = run([inv({ user: "CORP\\x" })], [a], { assetIdx: idx, hostnameAdoptRefused: vi.fn(() => true) });
    await done;
    expect(state.noteHostnameAdoptRefused).toHaveBeenCalledWith(a, MAC, "10.1.0.40", "pc-1", "device-inventory", "FGT-A");
    expect(written().lastSeen).toEqual(new Date(NOW));
    for (const k of ["ipAddress", "ipSource", "learnedLocation", "os", "osVersion", "assetType", "manufacturer", "lastSeenSwitch", "associatedUsers", "macAddress"]) {
      expect(written()).not.toHaveProperty(k);
    }
    expect(state.inferInventoryAssetType).not.toHaveBeenCalled();
    const entry = m.reconcileMacs.mock.calls[0][1].find((e: any) => e.mac === MAC);
    expect(entry).toEqual({ mac: MAC, lastSeen: NOW, source: UNVERIFIED_HOSTNAME_MAC_SOURCE });
    expect(state.addressSightings).toEqual([]);
    expect(state.fortigateEndpointAssetIds.size).toBe(0);
    expect(state.noteEndpointGate).not.toHaveBeenCalled();
    expect(state.claims.bestAddressClaimByAsset.has("a1")).toBe(false);
  });
});

describe("Phase 7 — several gates sighting one client", () => {
  it("merges into ONE write per asset, later keys winning, and counts it once", async () => {
    const a = asset({ learnedLocation: null });
    const { state, done } = run([
      inv({ device: "FGT-A", isOnline: false, lastSeen: "2026-11-10T10:00:00.000Z" }),
      inv({ device: "FGT-B", ipAddress: "10.1.0.41" }),
    ], [a]);
    await done;
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(written()).toMatchObject({ ipAddress: "10.1.0.41", ipSource: "FGT-B", learnedLocation: "FGT-B", lastSeen: new Date(NOW) });
    expect(state.inventoryAssets).toEqual(["pc-1 (updated)"]);
    expect(m.reconcileMacs).toHaveBeenCalledTimes(1);
    expect(state.noteEndpointGate).toHaveBeenLastCalledWith("a1", "FGT-B");
  });

  it("a staler local row does not take the endpoint gate from a fresher one", async () => {
    const { state, done } = run([
      inv({ device: "FGT-B" }),
      inv({ device: "FGT-A", isOnline: false, lastSeen: "2026-11-10T10:00:00.000Z" }),
    ], [asset()]);
    await done;
    expect(state.noteEndpointGate.mock.calls).toEqual([["a1", "FGT-B"]]);
  });

  it("a row no fresher than Phase 6's lease naming leaves the gate as named", async () => {
    const claims = createDhcpClaimState();
    claims.bestGateClaimMsByAsset.set("a1", NOW_MS);
    const { state, done } = run([inv()], [asset()], { claims });
    await done;
    expect(state.noteEndpointGate).not.toHaveBeenCalled();
  });
});

describe("Phase 7 — failures", () => {
  it("logs a failed flush per asset without its '(updated)' suffix, and keeps it out of the summary", async () => {
    db.update.mockRejectedValue(new Error("deadlock"));
    const { state, done } = run([inv()], [asset()]);
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to update inventory asset pc-1: deadlock");
    expect(state.inventoryAssets).toEqual([]);
  });

  it("logs an in-memory failure for the row and carries on with the next", async () => {
    const a = asset();
    const b = asset({ id: "b1", hostname: "pc-2", macAddress: MAC2, macAddresses: [] });
    const idx = index([a, b]);
    idx.reindex.mockImplementationOnce(() => { throw new Error("index corrupt"); });
    const { state, done } = run([inv(), inv({ macAddress: MAC2, hostname: "pc-2" })], [a, b], { assetIdx: idx });
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to update inventory asset pc-1: index corrupt");
    expect(db.update.mock.calls.map((c) => c[0].where.id)).toEqual(expect.arrayContaining(["b1"]));
  });

  it("logs a rename that failed and keeps the in-memory name", async () => {
    m.planSuffixes.mockResolvedValue([{ id: "new1", from: "pc-9", to: "pc-9-dd-ee-09" }]);
    db.update.mockRejectedValue(new Error("unique"));
    const { state, done } = run([inv({ macAddress: "aa:bb:cc:dd:ee:09", hostname: "pc-9" })]);
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to rename pc-9 to pc-9-dd-ee-09: unique");
    expect((state.assetIdx as any).findById("new1").hostname).toBe("pc-9");
    expect(m.logUpdated).not.toHaveBeenCalled();
  });

  it("logs a successful rename batch once", async () => {
    m.planSuffixes.mockResolvedValue([{ id: "new1", from: "pc-9", to: "pc-9-dd-ee-09" }]);
    const { state, done } = run([inv({ macAddress: "aa:bb:cc:dd:ee:09", hostname: "pc-9" })]);
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("info", "Named 1 asset(s) apart by MAC: pc-9-dd-ee-09");
  });

  it("does not ask for MAC-suffix names when no created asset has a hostname", async () => {
    await run([inv({ macAddress: "aa:bb:cc:dd:ee:09", hostname: "" })]).done;
    expect(m.planSuffixes).not.toHaveBeenCalled();
  });
});

describe("Phase 7 — create-path edges", () => {
  it("an offline row creates the asset with the gate's last_seen and no address-list row, but still names the gate", async () => {
    const seen = "2026-11-10T11:00:00.000Z";
    const { state, done } = run([inv({ isOnline: false, lastSeen: seen })]);
    await done;
    expect(db.create.mock.calls[0][0].data).toMatchObject({ lastSeen: new Date(seen), lastSeenSource: "device-inventory" });
    expect(state.addressSightings).toEqual([]);
    expect(state.bestGateClaimMsByAsset.get("new1")).toBe(Date.parse(seen));
    expect(state.noteEndpointGate).toHaveBeenCalledWith("new1", "FGT-A");
  });

  it("an unparseable last_seen creates with no Last Seen and stamps the MAC row with the run time", async () => {
    await run([inv({ isOnline: false, lastSeen: "garbage" })]).done;
    const data = db.create.mock.calls[0][0].data;
    expect(data.lastSeen).toBeNull();
    expect(data).not.toHaveProperty("lastSeenSource");
    expect(data.macAddressRows.create[0]).toMatchObject({ mac: MAC, lastSeen: new Date(NOW), source: "device-inventory" });
  });

  it("a row with no MAC never creates an asset", async () => {
    await run([inv({ macAddress: "" })]).done;
    expect(db.create).not.toHaveBeenCalled();
  });

  it("an all-zero MAC never creates an asset", async () => {
    await run([inv({ macAddress: "00:00:00:00:00:00" })]).done;
    expect(db.create).not.toHaveBeenCalled();
  });

  it("an IPv6 DHCP lease is never the fallback address of a new asset (rule 125)", async () => {
    await run([inv({ ipAddress: "" })], [], {}, { dhcpEntries: [{ macAddress: MAC, ipAddress: "2001:db8::40" }] }).done;
    expect(db.create).not.toHaveBeenCalled();
  });

  it("a device the rules type as a firewall is created but is not a fortigate-endpoint", async () => {
    const { state, done } = run([inv()], [], { inferInventoryAssetType: vi.fn(() => "firewall") });
    await done;
    expect(db.create).toHaveBeenCalledTimes(1);
    expect(state.fortigateEndpointAssetIds.size).toBe(0);
    expect(state.noteEndpointGate).not.toHaveBeenCalled();
  });

  it("a second row for a created device updates it instead of creating a duplicate", async () => {
    await run([inv(), inv({ device: "FGT-B", ipAddress: "10.1.0.41" })]).done;
    expect(db.create).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.update.mock.calls[0][0].where).toEqual({ id: "new1" });
  });
});

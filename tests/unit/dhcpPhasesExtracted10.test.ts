/**
 * tests/unit/dhcpPhasesExtracted10.test.ts — syncDhcpSubnets Phase 7, the
 * detected-device inventory, now src/services/discovery/dhcp/deviceInventory.ts
 * (CQ-B060 slice 11). Pins the create path and its address fallbacks, the
 * locality gate on what a created asset may record, and the MAC-suffix
 * rename. The update path — deferred flush, two sightings of one asset, the
 * address ladder — is pinned against a real database by deviceInventoryFlush,
 * addressClaimRanking, hostnameMacSuffix and hostnameAdoptGuard.
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
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", () => ({ logDiscoveryAssetCreated: m.logCreated, logDiscoveryAssetUpdated: m.logUpdated }));
vi.mock("../../src/services/macAddressService.js", () => ({ reconcileMacAddresses: m.reconcileMacs }));
vi.mock("../../src/services/hostnameMacSuffixService.js", () => ({ planHostnameMacSuffixes: m.planSuffixes }));

const { syncDeviceInventory } = await import("../../src/services/discovery/dhcp/deviceInventory.js");
const { createDhcpClaimState } = await import("../../src/utils/dhcpClaimFreshness.js");
const { buildArpMacDeviceIndex, buildArpIpsByMacDevice } = await import("../../src/utils/inventoryLocality.js");

const NOW = "2026-11-10T12:00:00.000Z";
const MAC = "AA:BB:CC:DD:EE:01";
let nextId = 0;
beforeEach(() => {
  resetDbStub();
  vi.clearAllMocks();
  nextId = 0;
  db.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: `a${++nextId}`, ...data }));
  db.update.mockResolvedValue({});
  m.planSuffixes.mockResolvedValue([]);
});

/** An empty run index: no entry matches, so every row takes the create path. */
function index() {
  const rows = new Map<string, any>();
  return {
    rows,
    findByEntryWithRung: () => undefined,
    findById: (id: string) => rows.get(id),
    add: (a: any) => rows.set(a.id, a),
    reindex: vi.fn(),
  };
}

function run(resultOver: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const arpTable = (resultOver.arpTable as unknown[]) ?? [];
  const claims = createDhcpClaimState();
  const state = {
    result: { dhcpEntries: [], arpTable, ...resultOver } as never,
    assetIdx: index() as never,
    allReservationsRaw: [] as Array<{ hostname: string | null; ipAddress: string | null }>,
    claims,
    arpMacDeviceIndex: buildArpMacDeviceIndex(arpTable as never),
    arpIpsByMacDevice: buildArpIpsByMacDevice(arpTable as never),
    bestGateClaimMsByAsset: claims.bestGateClaimMsByAsset,
    addressSightings: [] as any[], fortigateEndpointAssetIds: new Set<string>(), inventoryAssets: [] as string[], now: NOW,
    noteChangeBaseline: vi.fn(), noteEndpointGate: vi.fn(),
    hostnameAdoptRefused: () => false, noteHostnameAdoptRefused: vi.fn(),
    inferAssetTypeFromOs: (os: string | null | undefined) => (os && /windows/i.test(os) ? "workstation" : "other"),
    integrationId: "i1", integrationName: "FMG", integrationType: "fortimanager", integrationLabel: "FortiManager",
    actor: "system", syncLog: vi.fn(),
    ...over,
  };
  return { state, done: syncDeviceInventory(state as never) };
}
const inv = (over: Record<string, unknown> = {}) => ({
  macAddress: MAC.toLowerCase(), ipAddress: "10.1.0.40", hostname: "pc-40", device: "FGT-A", os: "Windows", isOnline: true,
  lastSeen: Math.floor(Date.parse(NOW) / 1000), switchName: "SW1", switchPort: 7,
  ...over,
});

describe("Phase 7 — creating an asset from a detected device", () => {
  it("creates it with the row's facts, its switch port, and a local gate as its location", async () => {
    const { state, done } = run({ deviceInventory: [inv({ hardwareVendor: "Dell", user: "CORP\\jdoe" })] });
    await done;
    const data = db.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      ipAddress: "10.1.0.40", ipSource: "FGT-A", macAddress: MAC, hostname: "pc-40", manufacturer: "Dell",
      assetType: "workstation", status: "active", learnedLocation: "FGT-A", lastSeenSwitch: "SW1/port7",
      lastSeenSource: "device-inventory", tags: ["device-inventory", "auto-discovered"],
    });
    expect(data.associatedUsers).toEqual([{ user: "jdoe", domain: "CORP", lastSeen: NOW, source: "device-inventory" }]);
    expect(state.inventoryAssets).toEqual(["pc-40"]);
    expect(state.fortigateEndpointAssetIds.has("a1")).toBe(true);
    expect(state.noteEndpointGate).toHaveBeenCalledWith("a1", "FGT-A");
    expect(state.addressSightings).toEqual([expect.objectContaining({ assetId: "a1", mac: MAC, ip: "10.1.0.40", source: "device-inventory", device: "FGT-A" })]);
    expect(m.logCreated).toHaveBeenCalledWith("a1", "pc-40", expect.objectContaining({ sourceKind: "fortigate-endpoint" }));
  });

  it("a row with no local evidence (no switch / AP, no ARP on that gate) records no location, gate or address", async () => {
    const { state, done } = run({ deviceInventory: [inv({ switchName: null, switchPort: null })] });
    await done;
    expect(db.create.mock.calls[0][0].data).toMatchObject({ ipSource: "fortimanager", learnedLocation: null });
    expect(state.noteEndpointGate).not.toHaveBeenCalled();
    expect(state.addressSightings).toEqual([]);
  });

  it("the same row is local when the gate's ARP table binds the MAC", async () => {
    const { state, done } = run({
      deviceInventory: [inv({ switchName: null, switchPort: null })],
      arpTable: [{ mac: MAC, ip: "10.1.0.40", fortigateDevice: "FGT-A" }],
    });
    await done;
    expect(db.create.mock.calls[0][0].data.learnedLocation).toBe("FGT-A");
    expect(state.noteEndpointGate).toHaveBeenCalledWith("a1", "FGT-A");
  });

  it("an address-less row takes its DHCP lease's address, else a reservation's by hostname, else is skipped", async () => {
    const { done } = run(
      {
        deviceInventory: [
          inv({ ipAddress: "", macAddress: "aa:bb:cc:dd:ee:02", hostname: "by-dhcp" }),
          inv({ ipAddress: "", macAddress: "aa:bb:cc:dd:ee:03", hostname: "By-Res" }),
          inv({ ipAddress: "", macAddress: "aa:bb:cc:dd:ee:04", hostname: "nowhere" }),
        ],
        dhcpEntries: [{ macAddress: "aa-bb-cc-dd-ee-02", ipAddress: "10.1.0.52" }],
      },
      { allReservationsRaw: [{ hostname: "by-res", ipAddress: "10.1.0.53" }, { hostname: "nowhere", ipAddress: "2001:db8::9" }] },
    );
    await done;
    expect(db.create.mock.calls.map((c) => [c[0].data.hostname, c[0].data.ipAddress])).toEqual([["by-dhcp", "10.1.0.52"], ["By-Res", "10.1.0.53"]]);
  });

  it("a row with neither MAC nor address is ignored", async () => {
    await run({ deviceInventory: [inv({ macAddress: null, ipAddress: null })] }).done;
    expect(db.create).not.toHaveBeenCalled();
  });

  it("a failed create is logged and the rest of the run continues", async () => {
    db.create.mockRejectedValueOnce(new Error("unique"));
    const { state, done } = run({ deviceInventory: [inv(), inv({ macAddress: "aa:bb:cc:dd:ee:09", hostname: "pc-9" })] });
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to create inventory asset pc-40: unique");
    expect(db.create).toHaveBeenCalledTimes(2);
    expect(state.inventoryAssets).toEqual(["pc-9"]);
  });
});

describe("Phase 7 — naming created assets apart (rule 91(i))", () => {
  it("renames a created asset whose name another live asset carries, in the DB and the run index", async () => {
    m.planSuffixes.mockResolvedValue([{ id: "a1", from: "pc-40", to: "pc-40-dd-ee-01" }]);
    const { state, done } = run({ deviceInventory: [inv()] });
    await done;
    expect(m.planSuffixes).toHaveBeenCalledWith([{ id: "a1", hostname: "pc-40" }]);
    expect(db.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { hostname: "pc-40-dd-ee-01" } });
    expect((state.assetIdx as any).findById("a1").hostname).toBe("pc-40-dd-ee-01");
    expect(m.logUpdated).toHaveBeenCalledWith({ hostname: "pc-40" }, { hostname: "pc-40-dd-ee-01" }, "a1", "pc-40-dd-ee-01", expect.anything());
  });

  it("a naming failure is logged, never thrown", async () => {
    m.planSuffixes.mockRejectedValue(new Error("db gone"));
    const { state, done } = run({ deviceInventory: [inv()] });
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Hostname MAC-suffix naming failed: db gone");
  });
});

/**
 * tests/unit/assetAddressService.test.ts — the own suite for
 * src/services/assetAddressService.ts (CQ-T010).
 *
 * Business rule 102: discovery's half of an asset's address list — one row per
 * (asset, IP) with the MAC it is bound to, current-state per gate and per kind,
 * never overwriting a manual or interface-scrape row. 102(a): ONE asset's DHCP
 * rows are brought in line with IPAM when it is opened. 102(b): a released
 * binding leaves the asset whose MAC list names it — and only that one (the
 * rule 139 refusal for a MAC two assets list) — moving its primary address by
 * rule 103(b)'s picker unless a pin, infra, or a device-written row keeps it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const m = vi.hoisted(() => ({ bestListedAddress: vi.fn() }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/primaryAddressService.js", () => ({ bestListedAddress: m.bestListedAddress }));

import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import type { AddressSighting, AddressReadScope } from "../../src/services/assetAddressService.js";
const {
  DISCOVERED_ADDRESS_SOURCES,
  collapseSightings,
  prunableSourcesFor,
  reconcileDiscoveredAddresses,
  judgeDhcpAddressAgainstIpam,
  reconcileAddressesWithIpam,
  judgeReleasedAddress,
  detachReleasedAddress,
  shapeAssociatedIps,
  ASSOCIATED_IP_SELECT,
  _resetAgeSweepForTests,
} = await import("../../src/services/assetAddressService.js");

const db = {
  exec: stubbed(prisma.$executeRawUnsafe),
  aipFindMany: stubbed(prisma.assetAssociatedIp.findMany),
  aipDeleteMany: stubbed(prisma.assetAssociatedIp.deleteMany),
  aipUpdate: stubbed(prisma.assetAssociatedIp.update),
  subnetFindMany: stubbed(prisma.subnet.findMany),
  resFindMany: stubbed(prisma.reservation.findMany),
  assetFindUnique: stubbed(prisma.asset.findUnique),
  assetFindMany: stubbed(prisma.asset.findMany),
  assetUpdate: stubbed(prisma.asset.update),
  macFindMany: stubbed(prisma.assetMacAddress.findMany),
  $transaction: stubbed(prisma.$transaction),
};

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  m.bestListedAddress.mockReset();
  _resetAgeSweepForTests();
  db.exec.mockResolvedValue(0);
  db.aipFindMany.mockResolvedValue([]);
  db.aipDeleteMany.mockResolvedValue({ count: 0 });
  db.aipUpdate.mockResolvedValue({});
  db.subnetFindMany.mockResolvedValue([]);
  db.resFindMany.mockResolvedValue([]);
  db.assetUpdate.mockResolvedValue({});
});

const T0 = new Date("2026-11-10T12:00:00Z");
const T1 = new Date("2026-11-10T12:05:00Z");
const s = (over: Partial<AddressSighting> = {}): AddressSighting => ({
  assetId: "a1", mac: "AA:BB:CC:DD:EE:01", ip: "10.1.0.5", source: "dhcp-lease", device: "FGT-A", seenAt: T0, ...over,
});
const scope = (over: Partial<AddressReadScope> = {}): AddressReadScope => ({
  dhcpDevices: [], inventoryDevices: [], arpDevices: [], ...over,
});

// ─── collapseSightings ──────────────────────────────────────────────────────

describe("collapseSightings", () => {
  it("keeps one row per (asset, ip) and leaves distinct ones alone", () => {
    const out = collapseSightings([s(), s({ ip: "10.1.0.6" }), s({ assetId: "a2" })]);
    expect(out).toHaveLength(3);
  });

  it("lets the strongest source name the row: inventory > reservation > lease > arp", () => {
    expect(collapseSightings([s({ source: "arp" }), s({ source: "dhcp-lease" })])[0].source).toBe("dhcp-lease");
    expect(collapseSightings([s({ source: "dhcp-lease" }), s({ source: "dhcp-reservation" })])[0].source).toBe("dhcp-reservation");
    expect(collapseSightings([s({ source: "dhcp-reservation" }), s({ source: "device-inventory" })])[0].source).toBe("device-inventory");
    expect(collapseSightings([s({ source: "device-inventory" }), s({ source: "arp" })])[0].source).toBe("device-inventory");
  });

  it("takes the stronger sighting's MAC and gate along with its source", () => {
    const out = collapseSightings([s({ source: "arp", device: "FGT-B", mac: "11:11:11:11:11:11" }), s({ source: "device-inventory" })]);
    expect(out[0]).toMatchObject({ device: "FGT-A", mac: "AA:BB:CC:DD:EE:01" });
  });

  it("keeps the first sighting on an equal source", () => {
    const out = collapseSightings([s({ device: "FGT-A" }), s({ device: "FGT-B" })]);
    expect(out[0].device).toBe("FGT-A");
  });

  it("stands the freshest evidence time whichever sighting wins", () => {
    expect(collapseSightings([s({ source: "device-inventory", seenAt: T0 }), s({ source: "arp", seenAt: T1 })])[0].seenAt).toEqual(T1);
    expect(collapseSightings([s({ seenAt: T1 }), s({ seenAt: T0 })])[0].seenAt).toEqual(T1);
  });

  it("lets a known medium beat an unknown or missing one", () => {
    expect(collapseSightings([s({ medium: "wired" }), s({ source: "device-inventory", medium: "unknown" })])[0].medium).toBe("wired");
    expect(collapseSightings([s({ source: "device-inventory" }), s({ medium: "wireless" })])[0].medium).toBe("wireless");
  });

  it("never replaces a known medium with another sighting's", () => {
    expect(collapseSightings([s({ medium: "wired" }), s({ medium: "wireless" })])[0].medium).toBe("wired");
  });

  it("drops sightings missing an asset, MAC, IP or gate", () => {
    expect(collapseSightings([s({ assetId: "" }), s({ mac: "" }), s({ ip: "" }), s({ device: "" })])).toEqual([]);
  });

  it("does not mutate its input", () => {
    const first = s({ source: "arp" });
    collapseSightings([first, s({ source: "device-inventory", seenAt: T1 })]);
    expect(first).toEqual(s({ source: "arp" }));
  });
});

// ─── prunableSourcesFor ─────────────────────────────────────────────────────

describe("prunableSourcesFor", () => {
  it("maps each successful read to the kinds it covers", () => {
    const sc = scope({ dhcpDevices: ["A"], inventoryDevices: ["A", "B"], arpDevices: ["C"] });
    expect(prunableSourcesFor("A", sc)).toEqual(["dhcp-lease", "dhcp-reservation", "device-inventory"]);
    expect(prunableSourcesFor("B", sc)).toEqual(["device-inventory"]);
    expect(prunableSourcesFor("C", sc)).toEqual(["arp"]);
    expect(prunableSourcesFor("Z", sc)).toEqual([]);
  });
});

// ─── reconcileDiscoveredAddresses ───────────────────────────────────────────

describe("reconcileDiscoveredAddresses — upsert", () => {
  it("writes one bulk upsert with the collapsed rows, in (asset, ip) order", async () => {
    const out = await reconcileDiscoveredAddresses(
      [s({ assetId: "b", ip: "10.1.0.9" }), s({ assetId: "a", ip: "10.1.0.7", medium: "wired" }), s({ assetId: "a", ip: "10.1.0.7", source: "arp" })],
      scope(), T0,
    );
    expect(out.upserted).toBe(2);
    expect(db.exec).toHaveBeenCalledTimes(1);
    const [sql, ...params] = db.exec.mock.calls[0];
    expect(params).toEqual([
      "a", "10.1.0.7", "dhcp-lease", "AA:BB:CC:DD:EE:01", "FGT-A", "wired", T0.toISOString(), T0.toISOString(),
      "b", "10.1.0.9", "dhcp-lease", "AA:BB:CC:DD:EE:01", "FGT-A", null, T0.toISOString(), T0.toISOString(),
    ]);
    expect(sql).toContain(`ON CONFLICT ("assetId", "ip") DO UPDATE`);
  });

  it("only overwrites a row discovery owns; a manual / system-info row only gains a missing MAC", async () => {
    await reconcileDiscoveredAddresses([s()], scope(), T0);
    const sql = db.exec.mock.calls[0][0] as string;
    const discovered = DISCOVERED_ADDRESS_SOURCES.map((x) => `'${x}'`).join(", ");
    expect(sql).toContain(`"source"   = CASE WHEN "asset_associated_ips"."source" IN (${discovered}) THEN EXCLUDED."source" ELSE "asset_associated_ips"."source" END`);
    expect(sql).toContain(`COALESCE("asset_associated_ips"."mac", EXCLUDED."mac")`);
    expect(sql).toContain(`GREATEST("asset_associated_ips"."lastSeen", EXCLUDED."lastSeen")`);
  });

  it("stores an unknown medium as null", async () => {
    await reconcileDiscoveredAddresses([s({ medium: "unknown" })], scope(), T0);
    expect(db.exec.mock.calls[0][6]).toBeNull();
  });

  it("chunks the upsert at 500 rows", async () => {
    const many = Array.from({ length: 501 }, (_, i) => s({ ip: `10.1.${Math.floor(i / 250)}.${i % 250}` }));
    const out = await reconcileDiscoveredAddresses(many, scope(), T0);
    expect(db.exec).toHaveBeenCalledTimes(2);
    expect(out.upserted).toBe(501);
  });

  it("writes nothing for an empty pass", async () => {
    _resetAgeSweepForTests();
    const out = await reconcileDiscoveredAddresses([], scope(), new Date(0));
    expect(db.exec).not.toHaveBeenCalled();
    expect(out).toEqual({ upserted: 0, pruned: 0 });
  });

  it("retries a deadlocked upsert", async () => {
    vi.useFakeTimers();
    try {
      db.exec.mockRejectedValueOnce(Object.assign(new Error("deadlock"), { code: "40P01" })).mockResolvedValueOnce(1);
      const p = reconcileDiscoveredAddresses([s()], scope(), new Date(0));
      await vi.runAllTimersAsync();
      await expect(p).resolves.toMatchObject({ upserted: 1 });
      expect(db.exec).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces any other upsert error", async () => {
    db.exec.mockRejectedValue(new Error("syntax"));
    await expect(reconcileDiscoveredAddresses([s()], scope(), T0)).rejects.toThrow("syntax");
  });
});

describe("reconcileDiscoveredAddresses — prune per gate and kind", () => {
  it("deletes the read gate's rows of the read kinds it no longer reports, keeping what it still does", async () => {
    db.aipFindMany.mockResolvedValue([
      { id: "keep", assetId: "a1", ip: "10.1.0.5" },
      { id: "gone", assetId: "a1", ip: "10.1.0.8" },
    ]);
    db.aipDeleteMany.mockResolvedValue({ count: 1 });
    const out = await reconcileDiscoveredAddresses([s()], scope({ dhcpDevices: ["FGT-A"] }), new Date(0));
    expect(db.aipFindMany).toHaveBeenCalledWith({
      where: { device: "FGT-A", source: { in: ["dhcp-lease", "dhcp-reservation"] } },
      select: { id: true, assetId: true, ip: true },
    });
    expect(db.aipDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["gone"] } } });
    expect(out.pruned).toBe(1);
  });

  it("scopes the prune to the kinds whose read succeeded — a failed ARP read keeps ARP rows", async () => {
    await reconcileDiscoveredAddresses([], scope({ dhcpDevices: ["FGT-A"], arpDevices: ["FGT-B"] }), new Date(0));
    const wheres = db.aipFindMany.mock.calls.map((c) => c[0].where);
    expect(wheres).toEqual([
      { device: "FGT-A", source: { in: ["dhcp-lease", "dhcp-reservation"] } },
      { device: "FGT-B", source: { in: ["arp"] } },
    ]);
  });

  it("a binding another gate reports does not save this gate's stale row", async () => {
    db.aipFindMany.mockResolvedValue([{ id: "x", assetId: "a1", ip: "10.1.0.5" }]);
    await reconcileDiscoveredAddresses([s({ device: "FGT-B" })], scope({ dhcpDevices: ["FGT-A"] }), new Date(0));
    expect(db.aipDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["x"] } } });
  });

  it("issues no delete when nothing is stale", async () => {
    db.aipFindMany.mockResolvedValue([{ id: "keep", assetId: "a1", ip: "10.1.0.5" }]);
    await reconcileDiscoveredAddresses([s()], scope({ dhcpDevices: ["FGT-A"] }), new Date(0));
    expect(db.aipDeleteMany).not.toHaveBeenCalled();
  });

  it("deletes stale rows in chunks of 1000", async () => {
    db.aipFindMany.mockResolvedValue(Array.from({ length: 1001 }, (_, i) => ({ id: `r${i}`, assetId: "a9", ip: `x${i}` })));
    db.aipDeleteMany.mockImplementation(async ({ where }: any) => ({ count: where.id.in.length }));
    const out = await reconcileDiscoveredAddresses([], scope({ arpDevices: ["FGT-A"] }), new Date(0));
    expect(db.aipDeleteMany).toHaveBeenCalledTimes(2);
    expect(out.pruned).toBe(1001);
  });
});

describe("reconcileDiscoveredAddresses — age sweep", () => {
  it("sweeps discovered rows no gate has re-reported for 30 days, at most once an hour", async () => {
    db.aipDeleteMany.mockResolvedValue({ count: 3 });
    const now = new Date("2026-11-10T12:00:00Z");
    const first = await reconcileDiscoveredAddresses([], scope(), now);
    expect(first.pruned).toBe(3);
    expect(db.aipDeleteMany).toHaveBeenCalledWith({
      where: {
        source: { in: ["dhcp-lease", "dhcp-reservation", "device-inventory", "arp"] },
        lastSeen: { lt: new Date(now.getTime() - 30 * 24 * 3600 * 1000) },
      },
    });
    await reconcileDiscoveredAddresses([], scope(), new Date(now.getTime() + 59 * 60 * 1000));
    expect(db.aipDeleteMany).toHaveBeenCalledTimes(1);
    await reconcileDiscoveredAddresses([], scope(), new Date(now.getTime() + 60 * 60 * 1000));
    expect(db.aipDeleteMany).toHaveBeenCalledTimes(2);
  });
});

// ─── judgeDhcpAddressAgainstIpam (102(a), pure) ─────────────────────────────

describe("judgeDhcpAddressAgainstIpam", () => {
  const row = (over: Partial<{ mac: string | null; source: string }> = {}) => ({ mac: "AA:BB:CC:DD:EE:01", source: "dhcp-lease", ...over });
  const res = (over: Partial<{ macAddress: string | null; sourceType: string; pushStatus: string | null }> = {}) =>
    ({ macAddress: "aa-bb-cc-dd-ee-01", sourceType: "dhcp_lease", pushStatus: null, ...over });

  it("keeps the row when IPAM holds no network on that gate for it", () => {
    expect(judgeDhcpAddressAgainstIpam(row(), false, null)).toEqual({ action: "keep" });
  });

  it("removes it when IPAM has no active entry at the address (released)", () => {
    expect(judgeDhcpAddressAgainstIpam(row(), true, null)).toEqual({ action: "remove", reason: "no active IPAM entry at this address" });
  });

  it("removes it when IPAM assigns the address to another MAC, naming it", () => {
    expect(judgeDhcpAddressAgainstIpam(row(), true, res({ macAddress: "11-22-33-44-55-66" })))
      .toEqual({ action: "remove", reason: "IPAM assigns this address to 11:22:33:44:55:66" });
  });

  it("compares MACs across spellings", () => {
    expect(judgeDhcpAddressAgainstIpam(row(), true, res())).toEqual({ action: "keep" });
  });

  it("does not judge a MAC it cannot compare (either side blank or all-zero)", () => {
    expect(judgeDhcpAddressAgainstIpam(row({ mac: null }), true, res({ macAddress: "11:22:33:44:55:66" })).action).toBe("keep");
    expect(judgeDhcpAddressAgainstIpam(row(), true, res({ macAddress: "00:00:00:00:00:00" })).action).toBe("keep");
  });

  it("relabels a lease row IPAM records as a reservation, and the reverse", () => {
    expect(judgeDhcpAddressAgainstIpam(row(), true, res({ sourceType: "dhcp_reservation" })))
      .toEqual({ action: "relabel", source: "dhcp-reservation" });
    expect(judgeDhcpAddressAgainstIpam(row({ source: "dhcp-reservation" }), true, res()))
      .toEqual({ action: "relabel", source: "dhcp-lease" });
  });

  it("treats a synced Polaris push as a reservation", () => {
    expect(judgeDhcpAddressAgainstIpam(row(), true, res({ sourceType: "manual", pushStatus: "synced" })))
      .toEqual({ action: "relabel", source: "dhcp-reservation" });
  });

  it("keeps the kind under an operator-owned row that was never pushed", () => {
    expect(judgeDhcpAddressAgainstIpam(row(), true, res({ sourceType: "manual" }))).toEqual({ action: "keep" });
  });
});

// ─── reconcileAddressesWithIpam (102(a)) ────────────────────────────────────

describe("reconcileAddressesWithIpam", () => {
  const aip = (over: Record<string, unknown> = {}) => ({ id: "x1", ip: "10.1.0.5", mac: "AA:BB:CC:DD:EE:01", source: "dhcp-lease", device: "FGT-A", ...over });

  it("reads only the asset's DHCP rows and stops when none names a gate", async () => {
    db.aipFindMany.mockResolvedValue([aip({ device: null })]);
    expect(await reconcileAddressesWithIpam("a1")).toEqual({ removed: [], relabelled: 0 });
    expect(db.aipFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { assetId: "a1", source: { in: ["dhcp-lease", "dhcp-reservation"] } } }));
    expect(db.subnetFindMany).not.toHaveBeenCalled();
  });

  it("keeps a row outside every network on its gate, without a reservation read", async () => {
    db.aipFindMany.mockResolvedValue([aip()]);
    db.subnetFindMany.mockResolvedValue([{ id: "s1", cidr: "10.9.0.0/24", fortigateDevice: "FGT-A" }]);
    expect(await reconcileAddressesWithIpam("a1")).toEqual({ removed: [], relabelled: 0 });
    expect(db.resFindMany).not.toHaveBeenCalled();
  });

  it("scopes networks per gate: the same RFC1918 network behind another gate does not count", async () => {
    db.aipFindMany.mockResolvedValue([aip()]);
    db.subnetFindMany.mockResolvedValue([{ id: "sB", cidr: "10.1.0.0/24", fortigateDevice: "FGT-B" }]);
    expect((await reconcileAddressesWithIpam("a1")).removed).toEqual([]);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("removes a released binding, relabels a re-kinded one, and logs one event", async () => {
    db.aipFindMany.mockResolvedValue([aip(), aip({ id: "x2", ip: "10.1.0.6" })]);
    db.subnetFindMany.mockResolvedValue([
      { id: "s16", cidr: "10.1.0.0/16", fortigateDevice: "FGT-A" },
      { id: "s24", cidr: "10.1.0.0/24", fortigateDevice: "FGT-A" },
    ]);
    db.resFindMany.mockResolvedValue([
      { subnetId: "s24", ipAddress: "10.1.0.6", macAddress: "AA:BB:CC:DD:EE:01", sourceType: "dhcp_reservation", pushStatus: null },
    ]);
    db.assetFindUnique.mockResolvedValue({ hostname: "pc-1", ipAddress: "10.1.0.6" });
    const out = await reconcileAddressesWithIpam("a1", "alice");
    expect(out).toEqual({
      removed: [{ ip: "10.1.0.5", mac: "AA:BB:CC:DD:EE:01", device: "FGT-A", reason: "no active IPAM entry at this address" }],
      relabelled: 1,
    });
    // The most specific network on the gate is the one IPAM is asked about.
    expect(db.resFindMany.mock.calls[0][0].where).toMatchObject({ subnetId: { in: ["s24"] }, status: "active" });
    expect(db.aipDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["x1"] } } });
    expect(db.aipUpdate).toHaveBeenCalledWith({ where: { id: "x2" }, data: { source: "dhcp-reservation" } });
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "asset.addresses_ipam_reconciled", resourceType: "asset", resourceId: "a1", resourceName: "pc-1", actor: "alice",
      message: `Removed 1 DHCP address from asset "pc-1" that IPAM no longer records: 10.1.0.5`,
    });
  });

  it("pluralises the message and falls back to the address, then the id, for the name", async () => {
    db.aipFindMany.mockResolvedValue([aip(), aip({ id: "x2", ip: "10.1.0.6" })]);
    db.subnetFindMany.mockResolvedValue([{ id: "s24", cidr: "10.1.0.0/24", fortigateDevice: "FGT-A" }]);
    db.assetFindUnique.mockResolvedValue(null);
    await reconcileAddressesWithIpam("a1");
    expect(eventLog.logEvent.mock.calls[0][0].message).toBe(`Removed 2 DHCP addresses from asset "a1" that IPAM no longer records: 10.1.0.5, 10.1.0.6`);
  });

  it("a relabel alone writes but logs no event", async () => {
    db.aipFindMany.mockResolvedValue([aip()]);
    db.subnetFindMany.mockResolvedValue([{ id: "s24", cidr: "10.1.0.0/24", fortigateDevice: "FGT-A" }]);
    db.resFindMany.mockResolvedValue([{ subnetId: "s24", ipAddress: "10.1.0.5", macAddress: null, sourceType: "dhcp_reservation", pushStatus: null }]);
    expect(await reconcileAddressesWithIpam("a1")).toEqual({ removed: [], relabelled: 1 });
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("writes nothing when every row agrees with IPAM", async () => {
    db.aipFindMany.mockResolvedValue([aip()]);
    db.subnetFindMany.mockResolvedValue([{ id: "s24", cidr: "10.1.0.0/24", fortigateDevice: "FGT-A" }]);
    db.resFindMany.mockResolvedValue([{ subnetId: "s24", ipAddress: "10.1.0.5", macAddress: "AA:BB:CC:DD:EE:01", sourceType: "dhcp_lease", pushStatus: null }]);
    await reconcileAddressesWithIpam("a1");
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

// ─── judgeReleasedAddress (102(b), pure) ────────────────────────────────────

describe("judgeReleasedAddress", () => {
  const a = (over: Record<string, unknown> = {}) => ({
    ipAddress: "10.1.0.5", assetType: "workstation", ipOverride: null, ipBlankPinned: false, primaryAddressMac: null, ...over,
  } as Parameters<typeof judgeReleasedAddress>[0]);

  it("moves an unpinned endpoint off its released primary address", () => {
    expect(judgeReleasedAddress(a(), "10.1.0.5", [])).toEqual({ action: "move" });
  });
  it("keeps it when the address was not its primary", () => {
    expect(judgeReleasedAddress(a(), "10.1.0.9", [])).toEqual({ action: "keep", reason: "not-primary" });
  });
  it.each([
    ["a typed override", { ipOverride: "10.1.0.5" }],
    ["a blank pin", { ipBlankPinned: true }],
    ["a card pin", { primaryAddressMac: "AA:BB:CC:DD:EE:01" }],
  ])("keeps it under %s", (_l, over) => {
    expect(judgeReleasedAddress(a(over), "10.1.0.5", [])).toEqual({ action: "keep", reason: "pinned" });
  });
  it.each(["firewall", "switch", "access_point"])("keeps a %s's management address", (assetType) => {
    expect(judgeReleasedAddress(a({ assetType }), "10.1.0.5", [])).toEqual({ action: "keep", reason: "infra" });
  });
  it("keeps it when the device itself or an operator still reports the address", () => {
    expect(judgeReleasedAddress(a(), "10.1.0.5", ["monitor-system-info"])).toEqual({ action: "keep", reason: "device-reports-it" });
  });
  it("checks the pin before infra and infra before remaining rows", () => {
    expect(judgeReleasedAddress(a({ assetType: "switch", ipOverride: "x" }), "10.1.0.5", ["manual"]).action === "keep").toBe(true);
    expect(judgeReleasedAddress(a({ assetType: "switch", ipOverride: "x" }), "10.1.0.5", ["manual"])).toMatchObject({ reason: "pinned" });
    expect(judgeReleasedAddress(a({ assetType: "switch" }), "10.1.0.5", ["manual"])).toMatchObject({ reason: "infra" });
  });
});

// ─── detachReleasedAddress (102(b)) ─────────────────────────────────────────

describe("detachReleasedAddress", () => {
  const owner = (over: Record<string, unknown> = {}) => ({
    id: "a1", hostname: "pc-1", ipAddress: "10.1.0.5", ipSource: "FGT-A", assetType: "workstation",
    ipOverride: null, ipBlankPinned: false, primaryAddressMac: null,
    associatedIpRows: [
      { ip: "10.1.0.5", source: "dhcp-reservation", device: "FGT-A" },
      { ip: "10.1.0.5", source: "arp", device: "FGT-A" },
      { ip: "10.2.0.9", source: "dhcp-lease", device: "FGT-B" },
    ],
    ...over,
  });
  const input = (over: Record<string, unknown> = {}) => ({ ip: "10.1.0.5", gate: "FGT-A", macAddress: "aa-bb-cc-dd-ee-01", actor: "alice", ...over });

  it.each([null, "", "not-a-mac", "00:00:00:00:00:00"])("detaches nothing for an unusable MAC (%s)", async (mac) => {
    expect(await detachReleasedAddress(input({ macAddress: mac }))).toEqual([]);
    expect(db.macFindMany).not.toHaveBeenCalled();
  });

  it("looks the MAC up on single-MAC rows only, normalised", async () => {
    db.macFindMany.mockResolvedValue([]);
    await detachReleasedAddress(input());
    expect(db.macFindMany).toHaveBeenCalledWith({ where: { mac: "AA:BB:CC:DD:EE:01", macEnd: null }, select: { assetId: true } });
  });

  it("detaches nothing when no asset or two assets list the MAC (the rule 139 refusal)", async () => {
    db.macFindMany.mockResolvedValue([]);
    expect(await detachReleasedAddress(input())).toEqual([]);
    db.macFindMany.mockResolvedValue([{ assetId: "a1" }, { assetId: "a2" }]);
    expect(await detachReleasedAddress(input())).toEqual([]);
    expect(db.assetFindMany).not.toHaveBeenCalled();
  });

  it("counts one asset listing the MAC twice as one owner, and asks only for it carrying the address", async () => {
    db.macFindMany.mockResolvedValue([{ assetId: "a1" }, { assetId: "a1" }]);
    db.assetFindMany.mockResolvedValue([]);
    await detachReleasedAddress(input());
    expect(db.assetFindMany.mock.calls[0][0].where).toEqual({
      id: "a1",
      OR: [
        { ipAddress: "10.1.0.5" },
        { associatedIpRows: { some: { ip: "10.1.0.5", device: "FGT-A", source: { in: ["dhcp-lease", "dhcp-reservation", "device-inventory", "arp"] } } } },
      ],
    });
  });

  it("removes the discovered rows at the address and moves the primary to the best listed one", async () => {
    db.macFindMany.mockResolvedValue([{ assetId: "a1" }]);
    db.assetFindMany.mockResolvedValue([owner()]);
    db.aipDeleteMany.mockResolvedValue({ count: 2 });
    m.bestListedAddress.mockResolvedValue({ ip: "10.2.0.9", evidenceScore: 3 });
    const out = await detachReleasedAddress(input());
    expect(out).toEqual([{ assetId: "a1", hostname: "pc-1", removedRows: 2, movedTo: "10.2.0.9" }]);
    expect(db.aipDeleteMany).toHaveBeenCalledWith({
      where: { assetId: "a1", ip: "10.1.0.5", source: { in: ["dhcp-lease", "dhcp-reservation", "device-inventory", "arp"] } },
    });
    expect(m.bestListedAddress).toHaveBeenCalledWith("a1", ["10.2.0.9"], null);
    expect(db.assetUpdate).toHaveBeenCalledWith({ where: { id: "a1" }, data: { ipAddress: "10.2.0.9", ipSource: "FGT-B" } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "asset.address_released", resourceType: "asset", resourceId: "a1", resourceName: "pc-1", actor: "alice",
      details: { ip: "10.1.0.5", gate: "FGT-A", mac: "AA:BB:CC:DD:EE:01", removedRows: 2, movedTo: "10.2.0.9", previousIpSource: "FGT-A" },
    });
    expect(eventLog.logEvent.mock.calls[0][0].message).toContain("moved to 10.2.0.9");
  });

  it("clears the address when nothing else is listed", async () => {
    db.macFindMany.mockResolvedValue([{ assetId: "a1" }]);
    db.assetFindMany.mockResolvedValue([owner({ associatedIpRows: [{ ip: "10.1.0.5", source: "dhcp-lease", device: "FGT-A" }] })]);
    db.aipDeleteMany.mockResolvedValue({ count: 1 });
    m.bestListedAddress.mockResolvedValue(null);
    const out = await detachReleasedAddress(input());
    expect(out[0].movedTo).toBeNull();
    expect(db.assetUpdate).toHaveBeenCalledWith({ where: { id: "a1" }, data: { ipAddress: null, ipSource: null } });
    expect(eventLog.logEvent.mock.calls[0][0].message).toContain("no other address is listed");
  });

  it("labels the new address 'discovery' when its row names no gate", async () => {
    db.macFindMany.mockResolvedValue([{ assetId: "a1" }]);
    db.assetFindMany.mockResolvedValue([owner({ associatedIpRows: [{ ip: "10.3.0.1", source: "manual", device: null }] })]);
    m.bestListedAddress.mockResolvedValue({ ip: "10.3.0.1", evidenceScore: 1 });
    await detachReleasedAddress(input());
    expect(db.assetUpdate.mock.calls[0][0].data).toEqual({ ipAddress: "10.3.0.1", ipSource: "discovery" });
  });

  it("keeps a pinned asset's address but still removes the discovered rows, saying why in the event", async () => {
    db.macFindMany.mockResolvedValue([{ assetId: "a1" }]);
    db.assetFindMany.mockResolvedValue([owner({ ipOverride: "10.1.0.5" })]);
    db.aipDeleteMany.mockResolvedValue({ count: 2 });
    const out = await detachReleasedAddress(input());
    expect(out).toEqual([{ assetId: "a1", hostname: "pc-1", removedRows: 2 }]);
    expect(db.assetUpdate).not.toHaveBeenCalled();
    expect(eventLog.logEvent.mock.calls[0][0].details).toMatchObject({ kept: "pinned" });
    expect(eventLog.logEvent.mock.calls[0][0].message).toBe(`Released DHCP binding 10.1.0.5 on "FGT-A" removed from the address list of "pc-1"`);
  });

  it("keeps the address when the device's own interface table still reports it", async () => {
    db.macFindMany.mockResolvedValue([{ assetId: "a1" }]);
    db.assetFindMany.mockResolvedValue([owner({ associatedIpRows: [
      { ip: "10.1.0.5", source: "dhcp-lease", device: "FGT-A" },
      { ip: "10.1.0.5", source: "monitor-system-info", device: null },
    ] })]);
    db.aipDeleteMany.mockResolvedValue({ count: 1 });
    await detachReleasedAddress(input());
    expect(db.assetUpdate).not.toHaveBeenCalled();
    expect(eventLog.logEvent.mock.calls[0][0].details).toMatchObject({ kept: "device-reports-it" });
  });

  it("writes and logs nothing when there was nothing to remove and the address stays", async () => {
    db.macFindMany.mockResolvedValue([{ assetId: "a1" }]);
    db.assetFindMany.mockResolvedValue([owner({ ipAddress: "10.9.9.9", associatedIpRows: [] })]);
    db.aipDeleteMany.mockResolvedValue({ count: 0 });
    expect(await detachReleasedAddress(input())).toEqual([]);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

// ─── shapeAssociatedIps ─────────────────────────────────────────────────────

describe("shapeAssociatedIps", () => {
  const base = {
    ip: "10.1.0.5", source: "arp", interfaceName: null, mac: null, interfaceRole: null, device: null, medium: null,
    ptrName: null, ptrTtl: null, ptrFetchedAt: null, lastSeen: T1, firstSeen: T0,
  };

  it("returns [] for a missing list", () => {
    expect(shapeAssociatedIps(null)).toEqual([]);
    expect(shapeAssociatedIps(undefined)).toEqual([]);
  });

  it("omits empty optionals and always stamps the two times as ISO strings", () => {
    expect(shapeAssociatedIps([base])).toEqual([{ ip: "10.1.0.5", source: "arp", lastSeen: T1.toISOString(), firstSeen: T0.toISOString() }]);
  });

  it("carries every populated field, a zero TTL included", () => {
    const out = shapeAssociatedIps([{
      ...base, interfaceName: "eth0", mac: "AA:BB:CC:DD:EE:01", interfaceRole: "primary", device: "FGT-A", medium: "wired",
      ptrName: "pc.corp", ptrTtl: 0, ptrFetchedAt: T0,
    }]);
    expect(out[0]).toEqual({
      ip: "10.1.0.5", source: "arp", interfaceName: "eth0", mac: "AA:BB:CC:DD:EE:01", interfaceRole: "primary",
      device: "FGT-A", medium: "wired", ptrName: "pc.corp", ptrTtl: 0, ptrFetchedAt: T0.toISOString(),
      lastSeen: T1.toISOString(), firstSeen: T0.toISOString(),
    });
  });

  it("ASSOCIATED_IP_SELECT selects every column the shaper reads", () => {
    expect(Object.keys(ASSOCIATED_IP_SELECT).sort()).toEqual(Object.keys(base).sort());
  });
});

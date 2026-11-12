/**
 * tests/unit/ipUpstreamChainService.test.ts — the two database-driven entry
 * points of src/services/ipUpstreamChainService.ts, on the shared _dbStub:
 * `resolveOwningGateContexts` (the ONE "which gate owns this address"
 * resolver, business rules 41 / 54 / 55) and the sweep
 * `resolveIpUpstreamForMaclessAssets` (rule 45 as amended, rule 40's claim
 * freshness, rule 26's two-MACs-is-no-answer).
 *
 * Complements tests/unit/ipUpstreamChain.test.ts (claimIsFresh, pickArpMac,
 * pickBestSwitchPort, labels), tests/unit/ipamOwningGateUpstream.test.ts
 * (macKey, partitionAdoptableMacs, resolveEndpointParent's IPAM tier) and
 * tests/integration/ipUpstreamChain.test.ts (the sweep against a real DB).
 * Covered here without a database: serial-before-name gate resolution and
 * the "gate has no Asset row" case; the sweep's stale-claim count, owning-gate
 * ARP scoping, ambiguous counting, lowest-cardinality port stamp, AP by MAC
 * and by the station's own address, stamp-only-on-change, MAC adoption vs
 * collisions, sorted batched update, Events after the commit (the roam one
 * only while wanted), and the MAC side-table write that may fail without
 * undoing anything.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

const h = vi.hoisted(() => ({
  buildIpContexts: vi.fn(),
  reconcileMacAddresses: vi.fn(async () => undefined),
  roamsWanted: vi.fn(async () => true),
}));
vi.mock("../../src/services/subnetService.js", () => ({ buildIpContexts: h.buildIpContexts }));
vi.mock("../../src/services/macAddressService.js", () => ({ reconcileMacAddresses: h.reconcileMacAddresses }));
vi.mock("../../src/services/notificationChangeEvents.js", () => ({ wirelessRoamEventsWanted: h.roamsWanted }));
vi.mock("../../src/utils/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { resolveOwningGateContexts, resolveIpUpstreamForMaclessAssets, type MaclessClaimRow } from "../../src/services/ipUpstreamChainService.js";

const NOW = new Date("2026-06-10T12:00:00Z");
const HOUR = 3_600_000;
const recent = new Date(NOW.getTime() - HOUR);

function claim(id: string, ip: string, extra: Partial<MaclessClaimRow> = {}): MaclessClaimRow {
  return { id, hostname: `host-${id}`, ip, ipSource: "discovery", ipOverride: null, lastSeen: recent, ipLastSeen: recent, lastSeenSwitch: null, lastSeenAp: null, ...extra };
}

interface World {
  claims: MaclessClaimRow[];
  contexts?: Record<string, { subnetId: string; subnetCidr: string }>;
  subnets?: Array<{ id: string; fortigateDevice: string | null; fortigateSerial: string | null }>;
  firewalls?: Array<Record<string, unknown>>;
  arp?: Array<{ assetId: string; ipAddress: string; macAddress: string; lastSeen: Date }>;
  fdb?: Array<{ assetId: string; macAddress: string; ifName: string | null; lastSeen: Date }>;
  cardinality?: Array<{ assetId: string; ifName: string; _count: { _all: number } }>;
  stations?: Array<{ apAssetId: string; staMacAddr: string; staIpAddr: string | null; lastSeen: Date }>;
  names?: Record<string, string>;
  heldMacs?: string[];
}

function install(w: World): void {
  stubbed(prisma.$queryRaw).mockResolvedValue(w.claims);
  h.buildIpContexts.mockImplementation(async (ips: string[]) => {
    const m = new Map<string, { subnetId: string; subnetCidr: string }>();
    for (const ip of ips) if (w.contexts?.[ip]) m.set(ip, w.contexts[ip]);
    return m;
  });
  stubbed(prisma.subnet.findMany).mockResolvedValue(w.subnets ?? []);
  stubbed(prisma.asset.findMany).mockImplementation(async ({ where }: { where: Record<string, any> }) => {
    if (where.assetType === "firewall") return w.firewalls ?? [];
    if (where.macAddress) return (w.heldMacs ?? []).filter((m) => where.macAddress.in.includes(m)).map((macAddress) => ({ macAddress }));
    if (where.id) return (where.id.in as string[]).filter((id) => w.names?.[id]).map((id) => ({ id, hostname: w.names![id] }));
    return [];
  });
  stubbed(prisma.assetArpEntry.findMany).mockImplementation(async ({ where }: { where: any }) =>
    (w.arp ?? []).filter((r) => where.ipAddress.in.includes(r.ipAddress) && r.lastSeen >= where.lastSeen.gte));
  stubbed(prisma.assetMacTableEntry.findMany).mockImplementation(async ({ where }: { where: any }) =>
    (w.fdb ?? []).filter((r) => where.macAddress.in.includes(r.macAddress) && r.lastSeen >= where.lastSeen.gte));
  stubbed(prisma.assetMacTableEntry.groupBy).mockResolvedValue(w.cardinality ?? []);
  stubbed(prisma.assetWirelessStation.findMany).mockImplementation(async ({ where }: { where: any }) =>
    (w.stations ?? []).filter((s) => s.lastSeen >= where.lastSeen.gte && (where.OR as any[]).some((o) =>
      (o.staMacAddr && o.staMacAddr.in.includes(s.staMacAddr)) || (o.staIpAddr && o.staIpAddr.in.includes(s.staIpAddr)))));
}

const updates = () => vi.mocked(prisma.asset.update).mock.calls.map((c) => c[0] as { where: { id: string }; data: Record<string, unknown> });
const events = () => eventLog.logEventsBatch.mock.calls.flatMap((c) => c[0]);

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  h.buildIpContexts.mockReset();
  h.reconcileMacAddresses.mockReset().mockResolvedValue(undefined);
  h.roamsWanted.mockReset().mockResolvedValue(true);
});

describe("resolveOwningGateContexts", () => {
  it("returns an empty map for no addresses without querying", async () => {
    expect((await resolveOwningGateContexts([])).size).toBe(0);
    expect(h.buildIpContexts).not.toHaveBeenCalled();
  });

  it("returns an empty map when no address sits in a known network", async () => {
    install({ claims: [] });
    expect((await resolveOwningGateContexts(["10.9.9.9"])).size).toBe(0);
    expect(prisma.subnet.findMany).not.toHaveBeenCalled();
  });

  it("rule 41: resolves the subnet's gate by chassis serial before FortiManager device name", async () => {
    install({
      claims: [],
      contexts: { "10.0.0.5": { subnetId: "s1", subnetCidr: "10.0.0.0/24" } },
      subnets: [{ id: "s1", fortigateSerial: "FGT-SERIAL", fortigateDevice: "HQ" }],
      firewalls: [
        { id: "by-name", hostname: "x", serialNumber: "OTHER", assetType: "firewall", fortinetTopology: { deviceName: "HQ" } },
        { id: "by-serial", hostname: "y", serialNumber: "FGT-SERIAL", assetType: "firewall", fortinetTopology: null },
      ],
    });
    const out = await resolveOwningGateContexts(["10.0.0.5"]);
    expect(out.get("10.0.0.5")).toEqual({ subnetId: "s1", subnetCidr: "10.0.0.0/24", gateAssetId: "by-serial" });
  });

  it("falls back to the FMG device name, never to a hostname-only match of a different firewall", async () => {
    install({
      claims: [],
      contexts: { "10.0.0.5": { subnetId: "s1", subnetCidr: "10.0.0.0/24" } },
      subnets: [{ id: "s1", fortigateSerial: null, fortigateDevice: "HQ" }],
      firewalls: [{ id: "gate", hostname: "hq-fw-01", serialNumber: "S", assetType: "firewall", fortinetTopology: { deviceName: "HQ" } }],
    });
    expect((await resolveOwningGateContexts(["10.0.0.5"])).get("10.0.0.5")?.gateAssetId).toBe("gate");
  });

  it("keeps the subnet when its gate has no Asset row (gateAssetId null)", async () => {
    install({
      claims: [],
      contexts: { "10.0.0.5": { subnetId: "s1", subnetCidr: "10.0.0.0/24" } },
      subnets: [{ id: "s1", fortigateSerial: "UNKNOWN", fortigateDevice: null }],
      firewalls: [],
    });
    expect((await resolveOwningGateContexts(["10.0.0.5", "192.168.1.1"]))).toEqual(new Map([["10.0.0.5", { subnetId: "s1", subnetCidr: "10.0.0.0/24", gateAssetId: null }]]));
  });
});

describe("resolveIpUpstreamForMaclessAssets", () => {
  const gateWorld = (over: Partial<World>): World => ({
    claims: [],
    contexts: { "10.0.0.5": { subnetId: "s1", subnetCidr: "10.0.0.0/24" }, "10.0.0.6": { subnetId: "s1", subnetCidr: "10.0.0.0/24" } },
    subnets: [{ id: "s1", fortigateSerial: "G1", fortigateDevice: null }],
    firewalls: [{ id: "gate1", hostname: "g1", serialNumber: "G1", assetType: "firewall", fortinetTopology: null }],
    names: { sw1: "SW-ACCESS", sw2: "SW-CORE", ap1: "AP-LOBBY", ap2: "AP-HALL" },
    ...over,
  });

  it("counts stale claims and stops when nothing is fresh", async () => {
    install({ claims: [claim("a", "10.0.0.5", { lastSeen: new Date("2026-01-01T00:00:00Z"), ipLastSeen: new Date("2026-01-01T00:00:00Z") })] });
    const r = await resolveIpUpstreamForMaclessAssets(NOW);
    expect(r).toMatchObject({ candidates: 0, staleClaims: 1, resolvedMac: 0 });
    expect(prisma.assetArpEntry.findMany).not.toHaveBeenCalled();
  });

  it("an operator-pinned claim never goes stale (rule 40)", async () => {
    install(gateWorld({ claims: [claim("a", "10.0.0.5", { ipOverride: "10.0.0.5", lastSeen: null, ipLastSeen: null })] }));
    expect((await resolveIpUpstreamForMaclessAssets(NOW)).candidates).toBe(1);
  });

  it("walks IP → owning gate's ARP → MAC → lowest-cardinality port, adopts the MAC, and audits after the commit", async () => {
    install(gateWorld({
      claims: [claim("a", "10.0.0.5")],
      arp: [
        { assetId: "gate1", ipAddress: "10.0.0.5", macAddress: "AA:BB:CC:00:00:01", lastSeen: recent },
        { assetId: "other-gate", ipAddress: "10.0.0.5", macAddress: "DE:AD:00:00:00:01", lastSeen: recent }, // overlapping RFC1918 elsewhere
      ],
      fdb: [
        { assetId: "sw2", macAddress: "AA:BB:CC:00:00:01", ifName: "port48", lastSeen: recent },
        { assetId: "sw1", macAddress: "AA:BB:CC:00:00:01", ifName: "port3", lastSeen: recent },
      ],
      cardinality: [
        { assetId: "sw2", ifName: "port48", _count: { _all: 50 } },
        { assetId: "sw1", ifName: "port3", _count: { _all: 1 } },
      ],
    }));
    const r = await resolveIpUpstreamForMaclessAssets(NOW);
    expect(r).toMatchObject({ candidates: 1, resolvedMac: 1, ambiguous: 0, switchStamps: 1, apStamps: 0, macAdopted: 1, macCollisions: 0 });
    expect(updates()).toEqual([{ where: { id: "a" }, data: { lastSeenSwitch: "SW-ACCESS/port3", macAddress: "AA:BB:CC:00:00:01" } }]);
    expect(events().map((e) => e.action)).toEqual(["asset.switch_port.changed", "asset.mac.adopted"]);
    expect(events()[0]).toMatchObject({ actor: "system:upstream-chain", resourceId: "a" });
    expect(h.reconcileMacAddresses).toHaveBeenCalledWith("a", [{ mac: "AA:BB:CC:00:00:01", source: "ip-upstream-arp", lastSeen: NOW.toISOString() }]);
  });

  it("rule 26: two MACs at one address on the owning gate is counted ambiguous and nothing is stamped", async () => {
    install(gateWorld({
      claims: [claim("a", "10.0.0.5")],
      arp: [
        { assetId: "gate1", ipAddress: "10.0.0.5", macAddress: "AA:00:00:00:00:01", lastSeen: recent },
        { assetId: "gate1", ipAddress: "10.0.0.5", macAddress: "AA:00:00:00:00:02", lastSeen: recent },
      ],
    }));
    const r = await resolveIpUpstreamForMaclessAssets(NOW);
    expect(r).toMatchObject({ ambiguous: 1, resolvedMac: 0 });
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it("with no owning gate, two gates answering is the overlap case — ambiguous", async () => {
    install({
      claims: [claim("a", "172.16.0.5")],
      arp: [
        { assetId: "g1", ipAddress: "172.16.0.5", macAddress: "AA:00:00:00:00:01", lastSeen: recent },
        { assetId: "g2", ipAddress: "172.16.0.5", macAddress: "AA:00:00:00:00:01", lastSeen: recent },
      ],
    });
    expect((await resolveIpUpstreamForMaclessAssets(NOW)).ambiguous).toBe(1);
  });

  it("ignores ARP evidence older than 24 h", async () => {
    install(gateWorld({
      claims: [claim("a", "10.0.0.5")],
      arp: [{ assetId: "gate1", ipAddress: "10.0.0.5", macAddress: "AA:00:00:00:00:01", lastSeen: new Date(NOW.getTime() - 25 * HOUR) }],
    }));
    const r = await resolveIpUpstreamForMaclessAssets(NOW);
    expect(r.resolvedMac).toBe(0);
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it("rule 45: a MAC another asset already holds is not adopted, but the switch stamp still lands", async () => {
    install(gateWorld({
      claims: [claim("a", "10.0.0.5")],
      arp: [{ assetId: "gate1", ipAddress: "10.0.0.5", macAddress: "AA:00:00:00:00:01", lastSeen: recent }],
      fdb: [{ assetId: "sw1", macAddress: "AA:00:00:00:00:01", ifName: "port3", lastSeen: recent }],
      heldMacs: ["AA:00:00:00:00:01"],
    }));
    const r = await resolveIpUpstreamForMaclessAssets(NOW);
    expect(r).toMatchObject({ macAdopted: 0, macCollisions: 1, switchStamps: 1 });
    expect(updates()[0].data).toEqual({ lastSeenSwitch: "SW-ACCESS/port3" });
    expect(h.reconcileMacAddresses).not.toHaveBeenCalled();
  });

  it("rule 45: two candidates resolving to one MAC in a pass adopt neither", async () => {
    install(gateWorld({
      claims: [claim("a", "10.0.0.5"), claim("b", "10.0.0.5")],
      arp: [{ assetId: "gate1", ipAddress: "10.0.0.5", macAddress: "AA:00:00:00:00:01", lastSeen: recent }],
    }));
    const r = await resolveIpUpstreamForMaclessAssets(NOW);
    expect(r).toMatchObject({ resolvedMac: 2, macAdopted: 0, macCollisions: 2 });
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it("stamps only on change (case-insensitive) and never clears", async () => {
    install(gateWorld({
      claims: [claim("a", "10.0.0.5", { lastSeenSwitch: "sw-access/PORT3" })],
      arp: [{ assetId: "gate1", ipAddress: "10.0.0.5", macAddress: "AA:00:00:00:00:01", lastSeen: recent }],
      fdb: [{ assetId: "sw1", macAddress: "AA:00:00:00:00:01", ifName: "port3", lastSeen: recent }],
      heldMacs: ["AA:00:00:00:00:01"],
    }));
    const r = await resolveIpUpstreamForMaclessAssets(NOW);
    expect(r.switchStamps).toBe(0);
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it("stamps the AP of the freshest station row for the resolved MAC", async () => {
    install(gateWorld({
      claims: [claim("a", "10.0.0.5", { lastSeenAp: "AP-HALL" })],
      arp: [{ assetId: "gate1", ipAddress: "10.0.0.5", macAddress: "AA:00:00:00:00:01", lastSeen: recent }],
      stations: [
        { apAssetId: "ap2", staMacAddr: "AA:00:00:00:00:01", staIpAddr: null, lastSeen: new Date(NOW.getTime() - 3 * HOUR) },
        { apAssetId: "ap1", staMacAddr: "AA:00:00:00:00:01", staIpAddr: null, lastSeen: recent },
      ],
      heldMacs: ["AA:00:00:00:00:01"],
    }));
    const r = await resolveIpUpstreamForMaclessAssets(NOW);
    expect(r.apStamps).toBe(1);
    expect(updates()[0].data).toEqual({ lastSeenAp: "AP-LOBBY" });
    expect(events()).toEqual([expect.objectContaining({ action: "asset.wireless_ap.changed" })]);
  });

  it("with no MAC, takes the AP from the station's own address only when ONE station carries it", async () => {
    install({
      claims: [claim("a", "10.1.0.5"), claim("b", "10.1.0.6")],
      stations: [
        { apAssetId: "ap1", staMacAddr: "11:00:00:00:00:01", staIpAddr: "10.1.0.5", lastSeen: recent },
        { apAssetId: "ap1", staMacAddr: "11:00:00:00:00:02", staIpAddr: "10.1.0.6", lastSeen: recent },
        { apAssetId: "ap2", staMacAddr: "11:00:00:00:00:03", staIpAddr: "10.1.0.6", lastSeen: recent },
      ],
      names: { ap1: "AP-LOBBY", ap2: "AP-HALL" },
    });
    await resolveIpUpstreamForMaclessAssets(NOW);
    expect(updates()).toEqual([{ where: { id: "a" }, data: { lastSeenAp: "AP-LOBBY" } }]);
  });

  it("the roam Event is written only while an automation wants it; the stamp is unconditional", async () => {
    h.roamsWanted.mockResolvedValue(false);
    install({
      claims: [claim("a", "10.1.0.5")],
      stations: [{ apAssetId: "ap1", staMacAddr: "11:00:00:00:00:01", staIpAddr: "10.1.0.5", lastSeen: recent }],
      names: { ap1: "AP-LOBBY" },
    });
    const r = await resolveIpUpstreamForMaclessAssets(NOW);
    expect(r.apStamps).toBe(1);
    expect(prisma.asset.update).toHaveBeenCalledTimes(1);
    expect(events()).toEqual([]);
  });

  it("updates in asset-id order inside one transaction (the deadlock fix)", async () => {
    install({
      claims: [claim("z", "10.1.0.7"), claim("m", "10.1.0.5")],
      stations: [
        { apAssetId: "ap1", staMacAddr: "11:00:00:00:00:01", staIpAddr: "10.1.0.5", lastSeen: recent },
        { apAssetId: "ap1", staMacAddr: "11:00:00:00:00:02", staIpAddr: "10.1.0.7", lastSeen: recent },
      ],
      names: { ap1: "AP-LOBBY" },
    });
    await resolveIpUpstreamForMaclessAssets(NOW);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(updates().map((u) => u.where.id)).toEqual(["m", "z"]);
  });

  it("a failed MAC side-table write does not undo the adoption or throw", async () => {
    h.reconcileMacAddresses.mockRejectedValue(new Error("db down"));
    install(gateWorld({
      claims: [claim("a", "10.0.0.5")],
      arp: [{ assetId: "gate1", ipAddress: "10.0.0.5", macAddress: "AA:00:00:00:00:01", lastSeen: recent }],
    }));
    const r = await resolveIpUpstreamForMaclessAssets(NOW);
    expect(r.macAdopted).toBe(1);
    expect(updates()[0].data).toEqual({ macAddress: "AA:00:00:00:00:01" });
  });

  it("names the switch only when the switch has a hostname", async () => {
    install(gateWorld({
      claims: [claim("a", "10.0.0.5")],
      arp: [{ assetId: "gate1", ipAddress: "10.0.0.5", macAddress: "AA:00:00:00:00:01", lastSeen: recent }],
      fdb: [{ assetId: "nameless", macAddress: "AA:00:00:00:00:01", ifName: "port1", lastSeen: recent }],
      heldMacs: ["AA:00:00:00:00:01"],
    }));
    const r = await resolveIpUpstreamForMaclessAssets(NOW);
    expect(r.switchStamps).toBe(0);
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });
});

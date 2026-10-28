/**
 * tests/unit/assistantAssetDetail.test.ts
 *
 * Business rule 95 for the two slide-in tools, without a database:
 *   - asset_details reads the sections asked for, applies each section's
 *     second key the way the tab's route does (VIPs need reservations,
 *     contacts need contacts, gate sightings need assetsQuarantine), never
 *     selects the agent's enrollment / bearer secrets, and always asks for
 *     the automation SUMMARY (a full row can carry api_call headers);
 *   - a section that fails answers its own error while the others still answer;
 *   - get_network reads the panel's own page (getSubnetIps), leaves out who
 *     holds an address for a role without reservations read and the asset
 *     link for one without assets read, and hands back candidates when a CIDR
 *     sits in two blocks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    asset: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    subnet: { findMany: vi.fn() },
    reservation: { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    managedAgent: { findUnique: vi.fn() },
    assetMclagPeer: { findMany: vi.fn(async () => []) },
    assetPhysicalEntity: { findMany: vi.fn(async () => []) },
    assetStorageSample: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    assetHardwareSensorSample: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    assetSource: { findMany: vi.fn(async () => []) },
  },
  upstream: vi.fn(async () => ({ switch: null })),
  vips: vi.fn(async () => ({ vips: [] })),
  contacts: vi.fn(async () => []),
  sightings: vi.fn(async () => []),
  notifications: vi.fn(async () => ({ active: [], matchingRules: [] })),
  subnetIps: vi.fn(),
  nextFree: vi.fn(async () => ["10.0.0.9"]),
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/assetUpstreamService.js", () => ({ resolveAssetUpstream: h.upstream }));
vi.mock("../../src/services/assetVipService.js", () => ({ resolveAssetVips: h.vips }));
vi.mock("../../src/services/contactService.js", () => ({ resolveContactsForAsset: h.contacts }));
vi.mock("../../src/services/assetSightingService.js", () => ({ getSightingsForAsset: h.sightings }));
vi.mock("../../src/services/agentHostPinService.js", () => ({ hostPinsForAsset: vi.fn(async () => null) }));
vi.mock("../../src/services/notificationService.js", () => ({ getAssetNotifications: h.notifications, listNotifications: vi.fn() }));
vi.mock("../../src/services/firmwareUpgradeService.js", () => ({
  getUpgradeAvailability: vi.fn(async () => { throw new Error("no firmware engine"); }),
  listRunsForAsset: vi.fn(async () => []),
}));
vi.mock("../../src/services/rebootService.js", () => ({
  getRebootAvailability: vi.fn(async () => ({ state: "unsupported", available: false })),
  listRebootRunsForAsset: vi.fn(async () => []),
}));
vi.mock("../../src/services/subnetService.js", () => ({ getSubnetIps: h.subnetIps }));
vi.mock("../../src/services/reservationService.js", () => ({ findNextAvailableIps: h.nextFree }));
vi.mock("../../src/services/monitoringService.js", () => ({ resolveMonitorSettingsWithProvenance: vi.fn() }));
vi.mock("../../src/services/downDetectionService.js", () => ({ describeDownDetectionFor: vi.fn(), recoveryPollsFor: vi.fn() }));

import { runAssistantTool } from "../../src/services/assistantToolService.js";

const reqWith = (perms: Record<string, string>) => ({ session: { userId: "u1", roleSnapshot: { permissions: perms } } }) as any;
const details = async (perms: Record<string, string>, sections: string[]) =>
  (await runAssistantTool("asset_details", JSON.stringify({ hostname: "sw1", sections }), { req: reqWith(perms), maxRows: 50 })).data as any;

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.asset.findFirst.mockResolvedValue({ id: "a1", hostname: "sw1", assetType: "switch" });
});

describe("asset_details", () => {
  it("refuses an unknown section as an argument error", async () => {
    const r = await runAssistantTool("asset_details", JSON.stringify({ id: "a1", sections: ["snmp_walk"] }), { req: reqWith({ assets: "read" }), maxRows: 50 });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.data)).toMatch(/Invalid arguments/);
  });

  it("connections: VIPs and contacts need their own keys, as their routes do", async () => {
    const without = await details({ assets: "read" }, ["connections"]);
    expect(without.connections.vips.error).toMatch(/Not permitted/);
    expect(without.connections.contacts.error).toMatch(/Not permitted/);
    expect(h.vips).not.toHaveBeenCalled();
    expect(h.contacts).not.toHaveBeenCalled();
    // The upstream firewall half reads gate sightings and the IPAM fallback reads networks.
    expect(h.upstream).toHaveBeenCalledWith("a1", { includeFirewall: false, includeSubnetGate: false });

    await details({ assets: "read", reservations: "read", contacts: "read", assetsQuarantine: "read", subnets: "read" }, ["connections"]);
    expect(h.vips).toHaveBeenCalledWith("a1");
    expect(h.contacts).toHaveBeenCalledWith("a1");
    expect(h.upstream).toHaveBeenLastCalledWith("a1", { includeFirewall: true, includeSubnetGate: true });
  });

  it("sources: gate sightings need assetsQuarantine", async () => {
    const r = await details({ assets: "read" }, ["sources"]);
    expect(r.sources.gateSightings.error).toMatch(/Not permitted/);
    expect(h.sightings).not.toHaveBeenCalled();
  });

  it("lifecycle never selects the agent's enrollment or bearer secrets, and a failing card does not sink the section", async () => {
    h.prisma.managedAgent.findUnique.mockResolvedValue({ agentVersion: "1.2.3" });
    const r = await details({ assets: "read" }, ["lifecycle"]);
    const select = h.prisma.managedAgent.findUnique.mock.calls[0][0].select;
    expect(Object.keys(select)).not.toEqual(expect.arrayContaining(["bearerHash"]));
    for (const k of Object.keys(select)) expect(k).not.toMatch(/Hash|Token|Prefix|Fingerprint/);
    expect(r.lifecycle.agent).toEqual({ agentVersion: "1.2.3" });
    expect(r.lifecycle.firmware).toEqual({ error: "no firmware engine" });
    expect(r.lifecycle.reboot.state).toBe("unsupported");
  });

  it("alerts asks for the automation summary even for a role that reads automations", async () => {
    await details({ assets: "read", automationManagement: "read" }, ["alerts"]);
    expect(h.notifications).toHaveBeenCalledWith("a1", { fullRules: false });
  });

  it("reads several sections in one call", async () => {
    const r = await details({ assets: "read" }, ["hardware", "alerts"]);
    expect(r).toMatchObject({ found: true, id: "a1", hostname: "sw1" });
    expect(r.hardware).toBeDefined();
    expect(r.alerts).toBeDefined();
  });

  it("an unknown device is found: false, with no section read", async () => {
    h.prisma.asset.findFirst.mockResolvedValue(null);
    expect(await details({ assets: "read" }, ["hardware"])).toEqual({ found: false });
    expect(h.prisma.assetPhysicalEntity.findMany).not.toHaveBeenCalled();
  });
});

describe("get_network", () => {
  const subnet = {
    id: "s1", cidr: "10.0.0.0/29", name: "Lab", purpose: null, status: "available", vlan: 20, tags: [],
    fortigateDevice: "FGT1", fortigateInterface: "lab", fortigateVlanParent: "internal", lastDiscoveredAt: null,
    createdBy: null, createdAt: new Date("2026-01-01T00:00:00Z"), block: { name: "Lab block", cidr: "10.0.0.0/16" },
    integration: { name: "FMG", type: "fortimanager" },
  };
  const page = {
    subnet: {}, ipv6: false, totalIps: 8, page: 1, pageSize: 32,
    ips: [
      { address: "10.0.0.0", type: "network", reservation: null, assetId: null, assetHostname: null },
      { address: "10.0.0.2", type: "host", assetId: "a2", assetHostname: "printer",
        reservation: { status: "active", hostname: "printer", owner: "ops", macAddress: "AA:BB:CC:00:11:22", sourceType: "dhcp_reservation", dhcpBinding: "reserved", notes: "2nd floor" } },
      { address: "10.0.0.3", type: "host", reservation: null, assetId: null, assetHostname: null },
    ],
  };
  const run = async (perms: Record<string, string>, args: Record<string, unknown> = { cidr: "10.0.0.0/29" }) =>
    (await runAssistantTool("get_network", JSON.stringify(args), { req: reqWith(perms), maxRows: 50 })).data as any;

  beforeEach(() => {
    h.prisma.subnet.findMany.mockResolvedValue([subnet]);
    h.prisma.reservation.groupBy.mockResolvedValue([{ sourceType: "dhcp_reservation", _count: { _all: 1 } }]);
    h.prisma.reservation.count.mockResolvedValue(0);
    h.subnetIps.mockResolvedValue(page);
  });

  it("reads the panel's page and whole-network counts; used addresses only by default", async () => {
    const r = await run({ subnets: "read", reservations: "read", assets: "read" });
    // The page follows the integration's row cap (50 here), floored at 32 and capped at 256.
    expect(h.subnetIps).toHaveBeenCalledWith("s1", 1, 50);
    expect(r).toMatchObject({ found: true, cidr: "10.0.0.0/29", vlan: 20, fortigateVlanParent: "internal", discoveredBy: "FMG (fortimanager)" });
    expect(r.utilization).toMatchObject({ reserved: 1, usableHosts: 6, free: 5, byKind: { dhcp_reservation: 1 } });
    expect(r.firstFree).toEqual(["10.0.0.9"]);
    // A /29 with one held has 5 free: asking for 10 would be refused outright.
    expect(h.nextFree).toHaveBeenCalledWith("s1", 5, false);
    expect(r.addresses.rows).toEqual([{
      address: "10.0.0.2", status: "active", hostname: "printer", owner: "ops", macAddress: "AA:BB:CC:00:11:22",
      sourceType: "dhcp_reservation", dhcpBinding: "reserved", notes: "2nd floor", assetId: "a2", assetHostname: "printer",
    }]);
  });

  it("usedOnly:false keeps the free and network addresses", async () => {
    const r = await run({ subnets: "read", reservations: "read" }, { cidr: "10.0.0.0/29", usedOnly: false });
    expect(r.addresses.rows.map((x: any) => x.address)).toEqual(["10.0.0.0", "10.0.0.2", "10.0.0.3"]);
    expect(r.addresses.rows[0]).toMatchObject({ type: "network", free: true });
  });

  it("without reservations read, who holds an address is left out; without assets read, the asset link is", async () => {
    const r = await run({ subnets: "read" });
    expect(r.addresses.rows).toEqual([{ address: "10.0.0.2", held: true }]);
    expect(r.addresses.note).toMatch(/reservations/);
  });

  it("a CIDR in two blocks comes back as candidates, with no page read", async () => {
    h.prisma.subnet.findMany.mockResolvedValue([subnet, { ...subnet, id: "s2", block: { name: "Other", cidr: "10.0.0.0/8" } }]);
    const r = await run({ subnets: "read" });
    expect(r).toMatchObject({ found: false, ambiguous: true });
    expect(r.candidates.map((c: any) => c.id)).toEqual(["s1", "s2"]);
    expect(h.subnetIps).not.toHaveBeenCalled();
  });
});

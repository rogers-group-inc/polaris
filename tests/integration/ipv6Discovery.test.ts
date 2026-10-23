/**
 * tests/integration/ipv6Discovery.test.ts — business rule 125 end to end.
 *
 * A dual-stack gate's discovery result through the real `syncDhcpSubnets`:
 * its DHCPv6 scope and router-advertised prefix become IPv6 networks, its
 * interface address, DHCPv6 lease and a SLAAC client's observed address land
 * in them — and none of it moves the asset off the IPv4 address monitoring
 * polls. Then the reservation side: a manual IPv6 reservation in a discovered
 * network on a push-enabled integration is stored canonically, is not pushed
 * (FortiOS has no DHCPv6 reservations), and supersedes the observed row.
 *
 * RFC 5737 / RFC 3849 addresses. Skips cleanly without a reachable DATABASE_URL.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { setIpv6Enabled, _resetIpv6GateForTests } from "../../src/services/ipv6GateService.js";
import { syncDhcpSubnets } from "../../src/services/discovery/discoveryEngine.js";
import { createReservation } from "../../src/services/reservationService.js";

const d = dbDescribe;
const NAME = "ipv6-discovery-test";
const GATE = "V6-TEST-GW";
const MAC = "AA:BB:CC:00:66:01";
const V4_BLOCK = "198.51.100.0/24";
const V6_BLOCK = "2001:db8:6600::/48";
const V4_IP = "198.51.100.10";
const DHCP6_NET = "2001:db8:6600:a::/64";
const RA_NET = "2001:db8:6600:b::/64";
let integrationId = "";
let assetId = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  // IPv6 is a whole-install switch (business rule 128), decided from the host,
  // and CI runners have no IPv6: switch it on for this suite.
  await setIpv6Enabled(true, "test");
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.setting.deleteMany({ where: { key: "ipv6Config" } });
  _resetIpv6GateForTests();
  await prisma.$disconnect();
});

async function cleanup(): Promise<void> {
  await prisma.ipBlock.deleteMany({ where: { cidr: { in: [V4_BLOCK, V6_BLOCK] } } });
  const owned = await prisma.assetMacAddress.findMany({ where: { mac: MAC }, select: { assetId: true } });
  const ids = [...new Set(owned.map((m) => m.assetId))];
  if (ids.length) await prisma.asset.deleteMany({ where: { id: { in: ids } } });
  await prisma.asset.deleteMany({ where: { OR: [{ macAddress: MAC }, { hostname: { startsWith: "V6-TEST" } }] } });
  const intgs = await prisma.integration.findMany({ where: { name: NAME }, select: { id: true } });
  if (intgs.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: intgs.map((i) => i.id) } } });
    await prisma.integration.deleteMany({ where: { id: { in: intgs.map((i) => i.id) } } });
  }
}

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const intg = await prisma.integration.create({
    data: { type: "fortigate", name: NAME, config: { pushReservations: true }, enabled: true },
  });
  integrationId = intg.id;
  await prisma.ipBlock.create({ data: { name: "v6 test v4", cidr: V4_BLOCK, ipVersion: "v4" } });
  await prisma.ipBlock.create({ data: { name: "v6 test v6", cidr: V6_BLOCK, ipVersion: "v6" } });
  const a = await prisma.asset.create({
    data: { hostname: "V6-TEST-LAPTOP", ipAddress: V4_IP, macAddress: MAC, assetType: "workstation", status: "active" },
  });
  assetId = a.id;
});

function result() {
  return {
    subnets: [
      { cidr: "198.51.100.0/24", name: "lan", fortigateDevice: GATE, dhcpServerId: "1" },
      { cidr: DHCP6_NET, name: "lan", fortigateDevice: GATE, dhcpServerId: "dhcp6-1", origin: "dhcp6" },
      { cidr: RA_NET, name: "guest", fortigateDevice: GATE, dhcpServerId: "ra-guest", origin: "ra" },
    ],
    devices: [],
    interfaceIps: [{ device: GATE, interfaceName: "lan", ipAddress: "2001:db8:6600:a::1", role: "interface" }],
    dhcpEntries: [
      { device: GATE, interfaceName: "lan", ipAddress: V4_IP, macAddress: MAC, hostname: "V6-TEST-LAPTOP", type: "dhcp-lease", seenLeased: true, expireTime: Math.floor(Date.now() / 1000) + 3600 },
      { device: GATE, interfaceName: "lan", ipAddress: "2001:db8:6600:a::10", macAddress: MAC, hostname: "V6-TEST-LAPTOP", type: "dhcp-lease", seenLeased: true, expireTime: Math.floor(Date.now() / 1000) + 3600 },
    ],
    deviceInventory: [{
      device: GATE, macAddress: MAC, ipAddress: V4_IP, hostname: "V6-TEST-LAPTOP", os: "", osVersion: "", hardwareVendor: "",
      interfaceName: "guest", switchName: "", switchPort: "", apName: "", user: "", isOnline: true,
      lastSeen: new Date().toISOString(), ipv6Address: "2001:db8:6600:b::20",
    }],
    inventoryDevices: [GATE],
    knownDeviceNames: [GATE], knownDeviceSerials: [],
    fortiSwitches: [], fortiAps: [], vips: [],
    switchMacTable: [], arpTable: [], arpQueriedDevices: [],
    cmdbSwitchSerials: [], cmdbApSerials: [],
    switchInventoriedDevices: [], apInventoriedDevices: [], vipInventoriedDevices: [],
    dhcpReservationsInventoriedDevices: [], dhcpLeasesInventoriedDevices: [GATE],
  } as any;
}

const sync = () => syncDhcpSubnets(integrationId, NAME, "fortigate", result(), "tester", "skip-deprecation");

async function v6Rows() {
  return prisma.reservation.findMany({
    where: { status: "active", subnet: { cidr: { in: [DHCP6_NET, RA_NET] } } },
    select: { id: true, ipAddress: true, sourceType: true, expiresAt: true, macAddress: true, hostname: true },
    orderBy: { ipAddress: "asc" },
  });
}

d("IPv6 discovery into IPAM (business rule 125)", () => {
  it("creates the IPv6 networks named by what served them", async () => {
    await sync();
    const subnets = await prisma.subnet.findMany({ where: { cidr: { in: [DHCP6_NET, RA_NET] } }, select: { cidr: true, name: true } });
    expect(subnets.map((s) => [s.cidr, s.name]).sort()).toEqual([
      [DHCP6_NET, `DHCPv6: lan (${GATE})`],
      [RA_NET, `IPv6 RA: guest (${GATE})`],
    ]);
  });

  it("records the interface address, the DHCPv6 lease and the observed SLAAC address", async () => {
    const before = Date.now();
    await sync();
    const rows = await v6Rows();
    expect(rows.map((r) => [r.ipAddress, r.sourceType])).toEqual([
      ["2001:db8:6600:a::1", "interface_ip"],
      ["2001:db8:6600:a::10", "dhcp_lease"],
      ["2001:db8:6600:b::20", "observed"],
    ]);
    const observed = rows.find((r) => r.sourceType === "observed")!;
    expect(observed.macAddress).toBe(MAC);
    expect(observed.hostname).toBe("V6-TEST-LAPTOP");
    const ttl = observed.expiresAt!.getTime() - before;
    expect(ttl).toBeGreaterThan(23 * 3600_000);
    expect(ttl).toBeLessThanOrEqual(24 * 3600_000 + 60_000);
  });

  it("never moves the asset off the IPv4 address monitoring polls", async () => {
    await sync();
    const a = await prisma.asset.findUniqueOrThrow({ where: { id: assetId }, select: { ipAddress: true } });
    expect(a.ipAddress).toBe(V4_IP);
  });

  it("refreshes the observed row in place on the next run", async () => {
    await sync();
    const first = (await v6Rows()).find((r) => r.sourceType === "observed")!;
    await prisma.reservation.update({ where: { id: first.id }, data: { expiresAt: new Date(Date.now() + 3600_000) } });
    await sync();
    const again = (await v6Rows()).filter((r) => r.sourceType === "observed");
    expect(again).toHaveLength(1);
    expect(again[0].id).toBe(first.id);
    expect(again[0].expiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
  });

  it("stores a manual IPv6 reservation canonically, does not push it, and supersedes the observed row", async () => {
    await sync();
    const subnet = await prisma.subnet.findFirstOrThrow({ where: { cidr: RA_NET } });
    const res = await createReservation({
      subnetId: subnet.id, ipAddress: "2001:DB8:6600:B:0::20", hostname: "V6-TEST-PINNED", createdBy: "tester",
    } as any);
    expect(res.ipAddress).toBe("2001:db8:6600:b::20");
    expect(res.sourceType).toBe("manual");
    expect(res.pushStatus ?? null).toBeNull();
    expect(res.pushedToId ?? null).toBeNull();
    const active = (await v6Rows()).filter((r) => r.ipAddress === "2001:db8:6600:b::20");
    expect(active).toHaveLength(1);
    expect(active[0].sourceType).toBe("manual");
  });
});

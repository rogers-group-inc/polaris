/**
 * tests/integration/endpointGateFromPrimaryIp.test.ts
 *
 * Business rule 101(b) through the real `syncDhcpSubnets`: an endpoint's
 * last-seen FortiGate (`Asset.learnedLocation`, via the fortigate-endpoint
 * blob) is the gate whose network holds its primary address.
 *
 * The shape that broke it: the lease — and so the address — comes from gate A,
 * while the MAC is also learned on a FortiSwitch port of gate B. Switch-port
 * attribution named the endpoint gate unconditionally and ran after the DHCP
 * pass, so the asset read "gate B" while monitored on an address only gate A
 * serves. With no IPAM network holding the address, the pathway's answer
 * stands, as before.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncDhcpSubnets } from "../../src/services/discovery/discoveryEngine.js";

const d = dbDescribe;
const MAC = "AA:BB:CC:00:5D:01";
const HOST = "EPGATE-1";
const GATE_A = "EPGATE-A-GW";
const GATE_B = "EPGATE-B-GW";
const BLOCK = "10.83.0.0/16";
const CIDR_A = "10.83.1.0/24";
const IP = "10.83.1.10";
const NAME = "endpoint-gate-test";
let integrationId = "";

async function cleanup(): Promise<void> {
  const owned = await prisma.assetMacAddress.findMany({ where: { mac: MAC }, select: { assetId: true } });
  const ids = [...new Set(owned.map((m) => m.assetId))];
  if (ids.length) await prisma.asset.deleteMany({ where: { id: { in: ids } } });
  await prisma.asset.deleteMany({ where: { OR: [{ macAddress: MAC }, { hostname: { contains: "EPGATE", mode: "insensitive" } }] } });
  const intgs = await prisma.integration.findMany({ where: { name: NAME }, select: { id: true } });
  if (intgs.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: intgs.map((i) => i.id) } } });
    await prisma.integration.deleteMany({ where: { id: { in: intgs.map((i) => i.id) } } });
  }
  await prisma.ipBlock.deleteMany({ where: { cidr: BLOCK } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  integrationId = (await prisma.integration.create({
    data: { type: "fortimanager", name: NAME, config: {}, enabled: true },
  })).id;
});

function result() {
  return {
    subnets: [], devices: [], interfaceIps: [],
    dhcpEntries: [{
      device: GATE_A, interfaceName: "internal", ipAddress: IP, macAddress: MAC, hostname: HOST,
      type: "dhcp-lease" as const, seenLeased: true,
    }],
    deviceInventory: [], inventoryDevices: [],
    knownDeviceNames: [GATE_A, GATE_B], knownDeviceSerials: [],
    fortiSwitches: [], fortiAps: [], vips: [],
    switchMacTable: [{ mac: MAC, switchId: "EPGATE-SW1", portName: "port7", fortigateDevice: GATE_B, isFortilinkPeer: false }],
    arpTable: [], arpQueriedDevices: [],
    cmdbSwitchSerials: [], cmdbApSerials: [],
    switchInventoriedDevices: [], apInventoriedDevices: [], vipInventoriedDevices: [],
    dhcpReservationsInventoriedDevices: [], dhcpLeasesInventoriedDevices: [],
  } as any;
}

async function seed(withSubnet: boolean): Promise<string> {
  if (withSubnet) {
    const block = await prisma.ipBlock.create({ data: { name: NAME, cidr: BLOCK, ipVersion: "v4" } });
    await prisma.subnet.create({ data: { blockId: block.id, cidr: CIDR_A, name: NAME, fortigateDevice: GATE_A } });
  }
  return (await prisma.asset.create({
    data: {
      hostname: HOST, macAddress: MAC, assetType: "workstation", status: "active",
      macAddressRows: { create: [{ mac: MAC, source: "dhcp_lease", lastSeen: new Date() }] },
    },
  })).id;
}

const sync = () =>
  syncDhcpSubnets(integrationId, NAME, "fortimanager", result(), "tester", "full");

const read = (id: string) => prisma.asset.findUnique({ where: { id }, select: { ipAddress: true, learnedLocation: true } });

d("an endpoint's gate follows its primary address (business rule 101(b))", () => {
  it("names the gate whose network holds the primary address, not the switch's controller", async () => {
    const id = await seed(true);
    await sync();
    expect(await read(id)).toEqual({ ipAddress: IP, learnedLocation: GATE_A });
  });

  it("keeps the pathway's gate when no IPAM network holds the address", async () => {
    const id = await seed(false);
    await sync();
    const after = await read(id);
    expect(after?.ipAddress).toBe(IP);
    expect(after?.learnedLocation).toBe(GATE_B);
  });
});

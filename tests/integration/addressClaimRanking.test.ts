/**
 * tests/integration/addressClaimRanking.test.ts
 *
 * Business rule 101 through the real `syncDhcpSubnets`: the DHCP pass and the
 * detected-device pass rank their claims on ONE ladder (utils/dhcpClaimFreshness),
 * so an online detected-device row speaks for the address over every DHCP
 * binding, a held reservation beats a leftover lease, and a wired card beats a
 * wireless one.
 *
 * The motivating case (prod, 2026-10-10): a plant HMI with an Intune-reported
 * Ethernet card and Wi-Fi card. The gate's detected-device table had it online
 * on a FortiSwitch port at its reserved address, but the asset showed an
 * unexpired Wi-Fi lease from a different subnet — the DHCP pass ranked the
 * reservation below the lease (reservations scored 0 on expireTime), and the
 * detected-device pass never got a vote because a DHCP entry existed for the MAC.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncDhcpSubnets } from "../../src/services/discovery/discoveryEngine.js";

const d = dbDescribe;
const ETH = "AA:BB:CC:01:01:40";
const WIFI = "AA:BB:CC:01:01:95";
const HOST = "ADDR-RANK-HMI";
const GATE = "ADDR-RANK-GW";
const IP_RESERVED = "10.91.25.235";
const IP_WIFI_LEASE = "10.91.6.23";
let integrationId = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

async function cleanup(): Promise<void> {
  const macs = [ETH, WIFI];
  const owned = await prisma.assetMacAddress.findMany({ where: { mac: { in: macs } }, select: { assetId: true } });
  const ids = [...new Set(owned.map((m) => m.assetId))];
  if (ids.length) await prisma.asset.deleteMany({ where: { id: { in: ids } } });
  await prisma.asset.deleteMany({
    where: { OR: [{ macAddress: { in: macs } }, { hostname: { contains: "ADDR-RANK", mode: "insensitive" } }] },
  });
  const intgs = await prisma.integration.findMany({ where: { name: "addr-rank-test" }, select: { id: true } });
  if (intgs.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: intgs.map((i) => i.id) } } });
    await prisma.integration.deleteMany({ where: { id: { in: intgs.map((i) => i.id) } } });
  }
}

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const intg = await prisma.integration.create({
    data: { type: "fortimanager", name: "addr-rank-test", config: {}, enabled: true },
  });
  integrationId = intg.id;
});

/** The HMI as Intune knows it: one Ethernet card, one Wi-Fi card. */
async function seedHmi(ipAddress = IP_WIFI_LEASE): Promise<string> {
  const seen = new Date();
  const a = await prisma.asset.create({
    data: {
      hostname: HOST, macAddress: ETH, assetType: "workstation", status: "active", ipAddress, ipSource: GATE,
      macAddressRows: {
        create: [
          { mac: ETH, source: "intune-ethernet", lastSeen: seen, firstSeen: seen },
          { mac: WIFI, source: "intune-wifi", lastSeen: seen, firstSeen: seen },
        ],
      },
    },
  });
  return a.id;
}

function dhcp(over: Record<string, unknown>) {
  return {
    device: GATE, interfaceName: "internal", hostname: HOST, type: "dhcp-lease" as const, seenLeased: true,
    ...over,
  };
}

function inv(over: Record<string, unknown>) {
  return {
    device: GATE, hostname: HOST, os: "Windows", osVersion: "", hardwareVendor: "", interfaceName: "internal",
    switchName: "", switchPort: "", apName: "", user: "", isOnline: true,
    lastSeen: new Date().toISOString(),
    ...over,
  };
}

function resultWith(dhcpEntries: any[], deviceInventory: any[], arpTable: any[] = []) {
  return {
    subnets: [], devices: [], interfaceIps: [],
    dhcpEntries, deviceInventory,
    inventoryDevices: deviceInventory.length ? [GATE] : [],
    knownDeviceNames: [GATE], knownDeviceSerials: [],
    fortiSwitches: [], fortiAps: [], vips: [],
    switchMacTable: [], arpTable, arpQueriedDevices: arpTable.length ? [GATE] : [],
  } as any;
}

const run = (dhcpEntries: any[], deviceInventory: any[] = [], arpTable: any[] = []) =>
  syncDhcpSubnets(integrationId, "addr-rank-test", "fortimanager", resultWith(dhcpEntries, deviceInventory, arpTable), "tester", "full");

const readIp = (id: string) =>
  prisma.asset.findUnique({ where: { id }, select: { ipAddress: true, ipSource: true, learnedLocation: true } });

d("address claim ranking (business rule 101)", () => {
  it("the HMI: an online wired detected-device row beats the Wi-Fi card's leftover lease", async () => {
    const id = await seedHmi();
    await run(
      [
        dhcp({ macAddress: WIFI, ipAddress: IP_WIFI_LEASE, accessPoint: "AP-1", ssid: "Plant", expireTime: 2_000_000_000 }),
        dhcp({ macAddress: ETH, ipAddress: IP_RESERVED, type: "dhcp-reservation" }),
      ],
      [inv({ macAddress: ETH, ipAddress: IP_RESERVED, switchName: "SW-EHOUSE", switchPort: "3" })],
    );
    const after = await readIp(id);
    expect(after?.ipAddress).toBe(IP_RESERVED);
    expect(after?.ipSource).toBe(GATE);
  });

  it("an online detected-device row takes the address even when a held lease exists for the SAME MAC", async () => {
    // The pre-101 `handledByDhcp` gate: any DHCP entry for the MAC silenced the
    // detected-device IP entirely.
    const id = await seedHmi();
    await run(
      [dhcp({ macAddress: ETH, ipAddress: IP_WIFI_LEASE, expireTime: 2_000_000_000 })],
      [inv({ macAddress: ETH, ipAddress: IP_RESERVED, switchName: "SW-EHOUSE" })],
    );
    expect((await readIp(id))?.ipAddress).toBe(IP_RESERVED);
  });

  it("with no detected-device row, a held reservation beats a held leftover lease", async () => {
    const id = await seedHmi();
    await run([
      dhcp({ macAddress: ETH, ipAddress: IP_WIFI_LEASE, expireTime: 2_000_000_000 }),
      dhcp({ macAddress: ETH, ipAddress: IP_RESERVED, type: "dhcp-reservation" }),
    ]);
    expect((await readIp(id))?.ipAddress).toBe(IP_RESERVED);
  });

  it("with no detected-device row, the Ethernet card's lease beats the Wi-Fi card's (Intune adapter type)", async () => {
    const id = await seedHmi(IP_RESERVED);
    await run([
      dhcp({ macAddress: WIFI, ipAddress: IP_WIFI_LEASE, expireTime: 2_000_000_000 }),
      dhcp({ macAddress: ETH, ipAddress: IP_RESERVED, expireTime: 1_900_000_000 }),
    ]);
    expect((await readIp(id))?.ipAddress).toBe(IP_RESERVED);
  });

  it("a remembered-but-offline detected-device row does not override a held lease", async () => {
    const id = await seedHmi(IP_RESERVED);
    await run(
      [dhcp({ macAddress: ETH, ipAddress: IP_RESERVED, expireTime: 2_000_000_000 })],
      [inv({
        macAddress: ETH, ipAddress: IP_WIFI_LEASE, switchName: "SW-OLD", isOnline: false,
        lastSeen: new Date(Date.now() - 4 * 86_400_000).toISOString(),
      })],
    );
    expect((await readIp(id))?.ipAddress).toBe(IP_RESERVED);
  });

  it("a ZTNA-relayed row (no switch/AP attribution, no ARP) never claims the address", async () => {
    const id = await seedHmi(IP_RESERVED);
    await run(
      [dhcp({ macAddress: ETH, ipAddress: IP_RESERVED, expireTime: 2_000_000_000 })],
      [inv({ macAddress: ETH, ipAddress: "10.200.0.5" })],
    );
    expect((await readIp(id))?.ipAddress).toBe(IP_RESERVED);
  });

  it("an ARP binding on the same gate makes a detected-device row local", async () => {
    const id = await seedHmi();
    await run(
      [dhcp({ macAddress: ETH, ipAddress: IP_WIFI_LEASE, expireTime: 2_000_000_000 })],
      [inv({ macAddress: ETH, ipAddress: IP_RESERVED })],
      [{ fortigateDevice: GATE, ip: IP_RESERVED, mac: ETH, interface: "internal" }],
    );
    expect((await readIp(id))?.ipAddress).toBe(IP_RESERVED);
  });
});

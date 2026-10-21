/**
 * tests/integration/serialHostnameMatch.test.ts
 *
 * Business rule 91(c) through the real `syncDhcpSubnets`. A managed
 * FortiSwitch's mgmt port takes a DHCP lease from its gate, and the gate's
 * detected-device inventory reports it with the switch SERIAL as hostname.
 * With no MAC on the switch record, Phase 7 found nothing by MAC or hostname
 * (the switch is hostnamed by its switch-id) and created a second,
 * "fortigate-endpoint" asset on the switch's own management address — raising
 * a duplicate-IP card until the next run's ghost sweep absorbed it.
 *
 * Now the row resolves to the switch when its address is the switch's
 * recorded address; the MAC lands on the switch and nothing is created. A row
 * on any other address is still only a name claim (rule 91(b)) and keeps the
 * old behaviour.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncDhcpSubnets } from "../../src/services/discovery/discoveryEngine.js";

const d = dbDescribe;
const SERIAL = "S108FFTV9103C001";
const SWITCH_NAME = "SN91C-108F-7";
const GATE = "SN91C-61F-1";
const MGMT_MAC = "48:3A:02:91:0C:54";
const MGMT_IP = "10.91.193.130";
const OTHER_IP = "10.91.193.200";
const INTEGRATION = "sn91c-test";
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
  const owned = await prisma.assetMacAddress.findMany({ where: { mac: MGMT_MAC }, select: { assetId: true } });
  const named = await prisma.asset.findMany({
    where: { OR: [{ macAddress: MGMT_MAC }, { hostname: { in: [SERIAL, SWITCH_NAME] } }, { serialNumber: SERIAL }] },
    select: { id: true },
  });
  const ids = [...new Set([...owned.map((m) => m.assetId), ...named.map((a) => a.id)])];
  if (ids.length) await prisma.asset.deleteMany({ where: { id: { in: ids } } });
  const intgs = await prisma.integration.findMany({ where: { name: INTEGRATION }, select: { id: true } });
  if (intgs.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: intgs.map((i) => i.id) } } });
    await prisma.integration.deleteMany({ where: { id: { in: intgs.map((i) => i.id) } } });
  }
}

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const intg = await prisma.integration.create({
    data: { type: "fortimanager", name: INTEGRATION, config: {}, enabled: true },
  });
  integrationId = intg.id;
});

/** The switch as FortiSwitch discovery left it: serial, mgmt IP, topology, no MAC. */
async function seedSwitch(): Promise<string> {
  const a = await prisma.asset.create({
    data: {
      hostname: SWITCH_NAME, serialNumber: SERIAL, assetType: "switch", status: "active", monitored: true,
      ipAddress: MGMT_IP, ipSource: GATE, manufacturer: "Fortinet",
      fortinetTopology: { role: "fortiswitch", controllerFortigate: GATE, uplinkInterface: "fortilink" },
    },
  });
  return a.id;
}

function inv(over: Record<string, unknown>) {
  return {
    device: GATE, hostname: SERIAL, macAddress: MGMT_MAC, ipAddress: MGMT_IP,
    os: "FortiSwitch OS", osVersion: "", hardwareVendor: "Fortinet", interfaceName: "fortilink",
    switchName: "", switchPort: "", apName: "", user: "", isOnline: true,
    lastSeen: new Date().toISOString(),
    ...over,
  };
}

function resultWith(deviceInventory: any[]) {
  return {
    subnets: [], devices: [], interfaceIps: [],
    dhcpEntries: [], deviceInventory,
    inventoryDevices: [GATE],
    knownDeviceNames: [GATE], knownDeviceSerials: [],
    fortiSwitches: [], fortiAps: [], vips: [],
    switchMacTable: [], arpTable: [], arpQueriedDevices: [],
  } as any;
}

const run = (deviceInventory: any[]) =>
  syncDhcpSubnets(integrationId, INTEGRATION, "fortimanager", resultWith(deviceInventory), "tester", "full");

const assetsNamedSerial = () => prisma.asset.findMany({ where: { hostname: SERIAL }, select: { id: true } });

d("serial-hostnamed detected-device rows (business rule 91(c))", () => {
  it("a row on the switch's mgmt address updates the switch and creates no endpoint asset", async () => {
    const id = await seedSwitch();
    await run([inv({})]);

    expect(await assetsNamedSerial()).toHaveLength(0);
    const sw = await prisma.asset.findUnique({
      where: { id },
      select: { hostname: true, ipAddress: true, assetType: true, os: true, macAddressRows: { select: { mac: true } } },
    });
    // The switch keeps what its own discovery owns — name, address, type —
    // and gains the mgmt MAC, so later rows match it by MAC.
    expect(sw?.hostname).toBe(SWITCH_NAME);
    expect(sw?.ipAddress).toBe(MGMT_IP);
    expect(sw?.assetType).toBe("switch");
    expect(sw?.os).toBeNull();
    expect(sw?.macAddressRows.map((r) => r.mac)).toContain(MGMT_MAC);
  });

  it("a second run still creates nothing (the MAC now matches)", async () => {
    await seedSwitch();
    await run([inv({})]);
    await run([inv({})]);
    expect(await assetsNamedSerial()).toHaveLength(0);
  });

  it("a row on another address is only a name claim: the switch gains nothing", async () => {
    const id = await seedSwitch();
    await run([inv({ ipAddress: OTHER_IP })]);

    const sw = await prisma.asset.findUnique({
      where: { id },
      select: { ipAddress: true, macAddressRows: { select: { mac: true } } },
    });
    expect(sw?.ipAddress).toBe(MGMT_IP);
    expect(sw?.macAddressRows.map((r) => r.mac)).not.toContain(MGMT_MAC);
  });
});

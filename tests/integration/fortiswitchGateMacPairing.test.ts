/**
 * tests/integration/fortiswitchGateMacPairing.test.ts
 *
 * Business rule 91(g) through the real `syncDhcpSubnets`. FortiOS reports no
 * MAC for a managed FortiSwitch, while the gate's device inventory lists the
 * switch's own management traffic as a client — its MAC, its `connecting_from`
 * address and its switch-id as the hostname. With the hostname rung gone
 * (91(f)) nothing paired the two, so every run left a FortiSwitch asset with
 * no MAC beside a "fortigate-endpoint" twin holding the switch's MAC.
 *
 * Now the switch takes the MAC its OWN controller sees at `connecting_from`,
 * and the twin is absorbed — including when both records already exist (the
 * twin must be looked up BEFORE the switch is reindexed under that MAC).
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncDhcpSubnets } from "../../src/services/discovery/discoveryEngine.js";

const d = dbDescribe;
const SERIAL = "S148FFTF91G00001";
const SWITCH_ID = "SW91G-148F-1";
const GATE = "SW91G-61F-1";
const OTHER_GATE = "SW91G-61F-2";
const MAC = "D4:B4:C0:91:0A:01";
const IP = "172.31.91.129";
const INTEGRATION = "sw91g-test";
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
  const owned = await prisma.assetMacAddress.findMany({ where: { mac: MAC }, select: { assetId: true } });
  const named = await prisma.asset.findMany({
    where: { OR: [{ macAddress: MAC }, { hostname: { in: [SERIAL, SWITCH_ID] } }, { serialNumber: SERIAL }] },
    select: { id: true },
  });
  const ids = [...new Set([...owned.map((m) => m.assetId), ...named.map((a) => a.id)])];
  if (ids.length) await prisma.asset.deleteMany({ where: { id: { in: ids } } });
  await prisma.reservation.deleteMany({ where: { ipAddress: IP, hostname: SWITCH_ID } });
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

// The inventory row the gate reports for the switch's own management traffic
// — what minted the endpoint twin in prod (OS "FortiSwitch OS", no switch port).
const seen = (device = GATE) => ({
  device, hostname: SWITCH_ID, macAddress: MAC, ipAddress: IP,
  os: "FortiSwitch OS", osVersion: "7.6.8 Build 1164", hardwareVendor: "Fortinet", interfaceName: "fortilink",
  switchName: "", switchPort: "", apName: "", user: "", isOnline: true,
  lastSeen: new Date().toISOString(),
});

const sw = (over: Record<string, unknown> = {}) => ({
  device: GATE, deviceSerial: "FGT61FTK91G00001", name: SWITCH_ID, serial: SERIAL,
  ipAddress: IP, fgtInterface: "fortilink", osVersion: "S148FF-v7.6.8-build1164,260709 (GA)",
  state: "Authorized", connected: true, description: null,
  ...over,
});

function resultWith(deviceInventory: any[], fortiSwitches: any[]) {
  return {
    subnets: [], devices: [], interfaceIps: [],
    dhcpEntries: [], deviceInventory,
    inventoryDevices: [GATE],
    knownDeviceNames: [GATE, OTHER_GATE], knownDeviceSerials: [],
    fortiSwitches, fortiAps: [], vips: [],
    switchMacTable: [], arpTable: [], arpQueriedDevices: [],
    cmdbSwitchSerials: [], cmdbApSerials: [],
    switchInventoriedDevices: [], apInventoriedDevices: [],
    dhcpLeasesInventoriedDevices: [GATE, OTHER_GATE],
  } as any;
}

const run = (deviceInventory: any[], fortiSwitches: any[]) =>
  syncDhcpSubnets(integrationId, INTEGRATION, "fortimanager", resultWith(deviceInventory, fortiSwitches), "tester", "skip-deprecation");

const deviceAssets = () => prisma.asset.findMany({
  where: { OR: [{ serialNumber: SERIAL }, { hostname: { in: [SERIAL, SWITCH_ID] } }, { macAddressRows: { some: { mac: MAC } } }] },
  select: { id: true, serialNumber: true, macAddress: true, assetType: true, sources: { select: { sourceKind: true } } },
});

d("FortiSwitch management MAC from its own gate (business rule 91(g))", { timeout: 60_000 }, () => {
  it("absorbs a twin that already exists beside a MAC-less switch", async () => {
    // Prod's state: the switch was discovered with no MAC, then the gate's
    // inventory row minted the twin. Build exactly that: switch alone first
    // (no gate evidence), then the inventory row alone.
    await run([], [sw()]);
    await run([seen()], []);
    expect((await deviceAssets()).length).toBe(2);

    // The fixed run sees both: the switch takes the gate's MAC and the twin goes.
    await run([seen()], [sw()]);
    const after = await deviceAssets();
    expect(after).toHaveLength(1);
    expect(after[0].serialNumber).toBe(SERIAL);
    expect(after[0].assetType).toBe("switch");
    expect(after[0].macAddress).toBe(MAC);
    expect(after[0].sources.map((s) => s.sourceKind)).toContain("fortiswitch");
    expect(after[0].sources.map((s) => s.sourceKind)).not.toContain("fortigate-endpoint");
  });

  it("never mints the twin when both are seen in one run, and stays one asset", async () => {
    await run([seen()], [sw()]);
    await run([seen()], [sw()]);
    const after = await deviceAssets();
    expect(after).toHaveLength(1);
    expect(after[0].macAddress).toBe(MAC);
  });

  it("records the gate's MAC as the fortiswitch source's baseMac", async () => {
    await run([seen()], [sw()]);
    const src = await prisma.assetSource.findFirst({
      where: { sourceKind: "fortiswitch", externalId: SERIAL },
      select: { observed: true },
    });
    expect((src?.observed as Record<string, unknown> | null)?.baseMac).toBe(MAC);
  });

  it("never pairs through ANOTHER gate's sighting of the same address", async () => {
    await run([seen(OTHER_GATE)], [sw()]);
    const after = await deviceAssets();
    expect(after).toHaveLength(2);
    expect(after.find((a) => a.serialNumber === SERIAL)?.macAddress ?? null).toBeNull();
  });
});

/**
 * tests/integration/fortiapUnauthorizedPairing.test.ts
 *
 * Business rule 91(e) through the real `syncDhcpSubnets`. An UNAUTHORIZED
 * FortiAP (controller state "discovered") reports no base MAC and is named by
 * its serial, while the gate's detected-device inventory knows the same box
 * by its own hostname and wired MAC (it sits on its static factory default,
 * so there is often no lease at all). Neither the MAC rung, the serial-hostname rung nor
 * the serial ghost merge could pair them, so every run left two assets: the
 * FortiAP and a "fortigate-endpoint" for the same device.
 *
 * Now the AP is paired with the MAC its OWN controller sees on its reported
 * address, and the endpoint placeholder is absorbed. The asset lands in
 * storage while the AP waits for authorization, and goes active once it is
 * authorized.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncDhcpSubnets } from "../../src/services/discovery/discoveryEngine.js";

const d = dbDescribe;
const SERIAL = "FP234FTF91E00001";
const AP_HOST = "FAP91E-234F-1";
const GATE = "FAP91E-61F-1";
const OTHER_GATE = "FAP91E-61F-2";
const MAC = "80:80:2C:91:0E:01";
// The FortiAP factory default — behind many gates at once.
const IP = "192.168.1.2";
const INTEGRATION = "fap91e-test";
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
    where: { OR: [{ macAddress: MAC }, { hostname: { in: [SERIAL, AP_HOST] } }, { serialNumber: SERIAL }] },
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

// The detected-device row the gate reports for the AP's wired port — what
// minted the endpoint placeholder in prod.
const seen = (device = GATE) => ({
  device, hostname: AP_HOST, macAddress: MAC, ipAddress: IP,
  os: "FortiAP OS", osVersion: "7.4.6 Build 0771", hardwareVendor: "Fortinet", interfaceName: "internal",
  switchName: "", switchPort: "", apName: "", user: "", isOnline: true,
  lastSeen: new Date().toISOString(),
});

const ap = (over: Record<string, unknown> = {}) => ({
  device: GATE, deviceSerial: "FGT61FTK91E00001", name: SERIAL, serial: SERIAL, model: "FortiAP-234F",
  ipAddress: IP, baseMac: "", status: "connecting", authorizationState: "discovered", profile: "",
  osVersion: "", meshUplink: "ethernet",
  ...over,
});

function resultWith(deviceInventory: any[], fortiAps: any[]) {
  return {
    subnets: [], devices: [], interfaceIps: [],
    dhcpEntries: [], deviceInventory,
    inventoryDevices: [GATE],
    knownDeviceNames: [GATE, OTHER_GATE], knownDeviceSerials: [],
    fortiSwitches: [], fortiAps, vips: [],
    switchMacTable: [], arpTable: [], arpQueriedDevices: [],
    cmdbSwitchSerials: [], cmdbApSerials: [],
    switchInventoriedDevices: [], apInventoriedDevices: [],
    dhcpLeasesInventoriedDevices: [GATE, OTHER_GATE],
  } as any;
}

const run = (deviceInventory: any[], fortiAps: any[]) =>
  syncDhcpSubnets(integrationId, INTEGRATION, "fortimanager", resultWith(deviceInventory, fortiAps), "tester", "skip-deprecation");

const deviceAssets = () => prisma.asset.findMany({
  where: { OR: [{ serialNumber: SERIAL }, { hostname: { in: [SERIAL, AP_HOST] } }, { macAddressRows: { some: { mac: MAC } } }] },
  select: { id: true, serialNumber: true, status: true, monitored: true, assetType: true, sources: { select: { sourceKind: true } } },
});

d("unauthorized FortiAP pairing and storage (business rule 91(e))", { timeout: 60_000 }, () => {
  it("absorbs the endpoint placeholder the gate's inventory minted, and lands in storage", async () => {
    // Run 1: only the detected-device row — the endpoint placeholder appears.
    await run([seen()], []);
    expect((await deviceAssets()).length).toBe(1);

    // Run 2: the unauthorized AP shows up with no base MAC.
    await run([seen()], [ap()]);
    const after = await deviceAssets();
    expect(after).toHaveLength(1);
    expect(after[0].serialNumber).toBe(SERIAL);
    expect(after[0].assetType).toBe("access_point");
    expect(after[0].status).toBe("storage");
    expect(after[0].monitored).toBe(false);
    expect(after[0].sources.map((s) => s.sourceKind)).toContain("fortiap");
  });

  it("a fresh run with both at once leaves one asset", async () => {
    await run([seen()], [ap()]);
    await run([seen()], [ap()]);
    const after = await deviceAssets();
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("storage");
  });

  it("goes active once the controller authorizes it", async () => {
    await run([seen()], [ap()]);
    await run([seen()], [ap({ authorizationState: "authorized", status: "online" })]);
    const after = await deviceAssets();
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("active");
  });

  it("an operator-set status is left alone", async () => {
    await run([seen()], [ap()]);
    const [a] = await deviceAssets();
    await prisma.asset.update({ where: { id: a.id }, data: { status: "disabled" } });
    await run([seen()], [ap({ authorizationState: "authorized", status: "online" })]);
    expect((await prisma.asset.findUnique({ where: { id: a.id }, select: { status: true } }))?.status).toBe("disabled");
  });

  it("never pairs through ANOTHER gate's sighting on the same factory-default address", async () => {
    await run([seen(OTHER_GATE)], []);
    await run([seen(OTHER_GATE)], [ap()]);
    const after = await deviceAssets();
    expect(after).toHaveLength(2);
  });
});

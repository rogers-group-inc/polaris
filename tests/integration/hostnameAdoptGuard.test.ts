/**
 * tests/integration/hostnameAdoptGuard.test.ts
 *
 * Business rule 91(b) (re-scan F2) through the real `syncDhcpSubnets`. A DHCP
 * client picks its own hostname (option 12), so anyone holding a lease on a
 * discovered FortiGate could name themselves after a monitored server: Phase 6
 * matched the asset by hostname alone, stapled the claimant's MAC on as the
 * primary, and moved the asset's ipAddress to the claimant's lease — after
 * which the monitor probed the claimant with the server's stored credentials.
 *
 * Protected (monitored, or any credential attached) + hostname-only → the MAC
 * is kept as an unverified sighting, the address and primary MAC stay put, and
 * one warning Event is written. Unprotected assets and MAC matches keep the
 * historical behaviour.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncDhcpSubnets } from "../../src/services/discovery/discoveryEngine.js";
import { UNVERIFIED_HOSTNAME_MAC_SOURCE } from "../../src/utils/macAddresses.js";

const d = dbDescribe;
const REAL = "AA:BB:CC:91:0B:01";
const CLAIMANT = "AA:BB:CC:91:0B:EE";
const HOST = "HN-ADOPT-SRV01";
const GATE = "HN-ADOPT-GW";
const IP_REAL = "10.91.191.10";
const IP_CLAIMANT = "10.91.191.200";
const ACTION = "discovery.hostname_adopt_refused";
const CRED_NAME = "hn-adopt-test-cred";
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
  const macs = [REAL, CLAIMANT];
  const owned = await prisma.assetMacAddress.findMany({ where: { mac: { in: macs } }, select: { assetId: true } });
  const named = await prisma.asset.findMany({
    where: { OR: [{ macAddress: { in: macs } }, { hostname: { contains: "HN-ADOPT", mode: "insensitive" } }] },
    select: { id: true },
  });
  const ids = [...new Set([...owned.map((m) => m.assetId), ...named.map((a) => a.id)])];
  if (ids.length) {
    await prisma.event.deleteMany({ where: { action: ACTION, resourceId: { in: ids } } });
    await prisma.asset.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.credential.deleteMany({ where: { name: CRED_NAME } });
  const intgs = await prisma.integration.findMany({ where: { name: "hn-adopt-test" }, select: { id: true } });
  if (intgs.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: intgs.map((i) => i.id) } } });
    await prisma.integration.deleteMany({ where: { id: { in: intgs.map((i) => i.id) } } });
  }
}

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const intg = await prisma.integration.create({
    data: { type: "fortimanager", name: "hn-adopt-test", config: {}, enabled: true },
  });
  integrationId = intg.id;
});

/** The server as Polaris knows it: one MAC (a lease sighting), one address. */
async function seedServer(monitored: boolean): Promise<string> {
  const seen = new Date(Date.now() - 3_600_000);
  const a = await prisma.asset.create({
    data: {
      hostname: HOST, macAddress: REAL, assetType: "server", status: "active", monitored,
      ipAddress: IP_REAL, ipSource: GATE, learnedLocation: GATE, os: "Rocky Linux",
      macAddressRows: { create: [{ mac: REAL, source: "dhcp-lease", lastSeen: seen, firstSeen: seen }] },
    },
  });
  return a.id;
}

function lease(over: Record<string, unknown>) {
  return {
    device: GATE, interfaceName: "internal", hostname: HOST, type: "dhcp-lease" as const, seenLeased: true,
    expireTime: Math.floor(Date.now() / 1000) + 86_400,
    ...over,
  };
}

function inv(over: Record<string, unknown>) {
  return {
    device: GATE, hostname: HOST, os: "Windows", osVersion: "11", hardwareVendor: "Evil Corp", interfaceName: "internal",
    switchName: "SW-ROGUE", switchPort: "7", apName: "", user: "", isOnline: true,
    lastSeen: new Date().toISOString(),
    ...over,
  };
}

function resultWith(dhcpEntries: any[], deviceInventory: any[] = []) {
  return {
    subnets: [], devices: [], interfaceIps: [],
    dhcpEntries, deviceInventory,
    inventoryDevices: deviceInventory.length ? [GATE] : [],
    knownDeviceNames: [GATE], knownDeviceSerials: [],
    fortiSwitches: [], fortiAps: [], vips: [],
    switchMacTable: [], arpTable: [], arpQueriedDevices: [],
  } as any;
}

const run = (dhcpEntries: any[], deviceInventory: any[] = []) =>
  syncDhcpSubnets(integrationId, "hn-adopt-test", "fortimanager", resultWith(dhcpEntries, deviceInventory), "tester", "full");

const readAsset = (id: string) =>
  prisma.asset.findUnique({
    where: { id },
    select: {
      ipAddress: true, ipSource: true, learnedLocation: true, macAddress: true, os: true, manufacturer: true,
      lastSeenSwitch: true, macAddressRows: { select: { mac: true, source: true } },
    },
  });

const refusals = (id: string) =>
  prisma.event.findMany({ where: { action: ACTION, resourceId: id }, select: { level: true, message: true, details: true, resourceType: true, resourceName: true } });

d("hostname-only adoption on protected assets (business rule 91(b))", () => {
  it("monitored asset + hostname-only lease: address and primary MAC unchanged, MAC kept unverified, one warning", async () => {
    const id = await seedServer(true);
    await run([lease({ macAddress: CLAIMANT, ipAddress: IP_CLAIMANT })]);

    const after = await readAsset(id);
    expect(after?.ipAddress).toBe(IP_REAL);
    expect(after?.ipSource).toBe(GATE);
    expect(after?.learnedLocation).toBe(GATE);
    expect(after?.macAddress).toBe(REAL);
    const claimantRow = after?.macAddressRows.find((r) => r.mac === CLAIMANT);
    expect(claimantRow?.source).toBe(UNVERIFIED_HOSTNAME_MAC_SOURCE);
    expect(after?.macAddressRows.find((r) => r.mac === REAL)).toBeTruthy();

    const events = await refusals(id);
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe("warning");
    expect(events[0].resourceType).toBe("asset");
    expect(events[0].resourceName).toBe(HOST);
    expect(events[0].message).toContain(HOST);
    expect(events[0].message).toContain(CLAIMANT);
    expect(events[0].message).toContain(IP_CLAIMANT);
    expect(events[0].message).toContain("hn-adopt-test");
    expect(events[0].details).toMatchObject({ mac: CLAIMANT, ip: IP_CLAIMANT, hostname: HOST, source: "dhcp-lease" });
  });

  it("the recorded MAC is not identity: a second run is refused again, never re-addresses", async () => {
    const id = await seedServer(true);
    await run([lease({ macAddress: CLAIMANT, ipAddress: IP_CLAIMANT })]);
    await run([lease({ macAddress: CLAIMANT, ipAddress: IP_CLAIMANT })]);
    const after = await readAsset(id);
    expect(after?.ipAddress).toBe(IP_REAL);
    expect(after?.macAddress).toBe(REAL);
    expect(after?.macAddressRows.find((r) => r.mac === CLAIMANT)?.source).toBe(UNVERIFIED_HOSTNAME_MAC_SOURCE);
    // One per (asset, MAC) per run — two runs, two warnings.
    expect(await refusals(id)).toHaveLength(2);
  });

  it("asset with a credential but not monitored is protected too", async () => {
    const id = await seedServer(false);
    const cred = await prisma.credential.create({ data: { name: CRED_NAME, type: "ssh", config: {} } });
    await prisma.asset.update({ where: { id }, data: { processesCredentialId: cred.id } });
    await run([lease({ macAddress: CLAIMANT, ipAddress: IP_CLAIMANT })]);
    const after = await readAsset(id);
    expect(after?.ipAddress).toBe(IP_REAL);
    expect(after?.macAddress).toBe(REAL);
    expect(await refusals(id)).toHaveLength(1);
  });

  it("device-inventory path: hostname-only row moves nothing on a protected asset; lease + row give ONE warning", async () => {
    const id = await seedServer(true);
    await run(
      [lease({ macAddress: CLAIMANT, ipAddress: IP_CLAIMANT })],
      [inv({ macAddress: CLAIMANT, ipAddress: IP_CLAIMANT })],
    );
    const after = await readAsset(id);
    expect(after?.ipAddress).toBe(IP_REAL);
    expect(after?.learnedLocation).toBe(GATE);
    expect(after?.macAddress).toBe(REAL);
    expect(after?.os).toBe("Rocky Linux");
    expect(after?.manufacturer).toBeNull();
    expect(after?.lastSeenSwitch).toBeNull();
    expect(await refusals(id)).toHaveLength(1);
  });

  it("device-inventory only (no lease): MAC recorded unverified, address unchanged", async () => {
    const id = await seedServer(true);
    await run([], [inv({ macAddress: CLAIMANT, ipAddress: IP_CLAIMANT })]);
    const after = await readAsset(id);
    expect(after?.ipAddress).toBe(IP_REAL);
    expect(after?.macAddress).toBe(REAL);
    expect(after?.macAddressRows.find((r) => r.mac === CLAIMANT)?.source).toBe(UNVERIFIED_HOSTNAME_MAC_SOURCE);
    const events = await refusals(id);
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({ source: "device-inventory", mac: CLAIMANT });
  });

  it("unprotected asset + hostname-only lease: today's behaviour — the address moves", async () => {
    const id = await seedServer(false);
    await run([lease({ macAddress: CLAIMANT, ipAddress: IP_CLAIMANT })]);
    const after = await readAsset(id);
    expect(after?.ipAddress).toBe(IP_CLAIMANT);
    expect(after?.macAddress).toBe(CLAIMANT);
    expect(after?.macAddressRows.find((r) => r.mac === CLAIMANT)?.source).toBe("dhcp-lease");
    expect(await refusals(id)).toHaveLength(0);
  });

  it("protected asset + MAC match: unchanged behaviour — the address may move", async () => {
    const id = await seedServer(true);
    await run([lease({ macAddress: REAL, ipAddress: IP_CLAIMANT })]);
    const after = await readAsset(id);
    expect(after?.ipAddress).toBe(IP_CLAIMANT);
    expect(after?.macAddress).toBe(REAL);
    expect(await refusals(id)).toHaveLength(0);
  });
});

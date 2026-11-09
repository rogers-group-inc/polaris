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
 * 91(b) answered that for protected assets (monitored, or a credential
 * attached) by keeping the claimant's MAC as an unverified sighting. Rule 91(f)
 * (2026-11-04) goes further: Phases 6 and 7 no longer match on a hostname at
 * all, for ANY asset — whole product lines send one DHCP hostname ("iPhone",
 * "espressif"), and the rung was fusing them into a single asset holding a
 * hundred MACs. A lease whose MAC no asset knows touches nothing; a
 * detected-device row with that MAC becomes its own asset. MAC matches are
 * unchanged.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncDhcpSubnets } from "../../src/services/discovery/discoveryEngine.js";

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

const assetsNamed = () =>
  prisma.asset.findMany({ where: { hostname: HOST }, select: { id: true, macAddress: true, ipAddress: true } });

// The name and its MAC-suffixed forms (rule 91(i) names same-named devices apart).
const assetsInFamily = () =>
  prisma.asset.findMany({ where: { hostname: { startsWith: HOST } }, select: { id: true, hostname: true, macAddress: true, ipAddress: true } });

d("a DHCP hostname is never a match (business rules 91(b), 91(f))", () => {
  it("monitored asset + hostname-only lease: nothing on the asset changes, no MAC row, no warning", async () => {
    const id = await seedServer(true);
    await run([lease({ macAddress: CLAIMANT, ipAddress: IP_CLAIMANT })]);

    const after = await readAsset(id);
    expect(after?.ipAddress).toBe(IP_REAL);
    expect(after?.ipSource).toBe(GATE);
    expect(after?.learnedLocation).toBe(GATE);
    expect(after?.macAddress).toBe(REAL);
    expect(after?.macAddressRows.map((r) => r.mac)).toEqual([REAL]);
    expect(await refusals(id)).toHaveLength(0);
  });

  it("asset with a credential but not monitored: nothing changes either", async () => {
    const id = await seedServer(false);
    const cred = await prisma.credential.create({ data: { name: CRED_NAME, type: "ssh", config: {} } });
    await prisma.asset.update({ where: { id }, data: { processesCredentialId: cred.id } });
    await run([lease({ macAddress: CLAIMANT, ipAddress: IP_CLAIMANT })]);
    const after = await readAsset(id);
    expect(after?.ipAddress).toBe(IP_REAL);
    expect(after?.macAddress).toBe(REAL);
    expect(after?.macAddressRows.map((r) => r.mac)).toEqual([REAL]);
  });

  it("UNPROTECTED asset + hostname-only lease: the address no longer moves (rule 91(f))", async () => {
    const id = await seedServer(false);
    await run([lease({ macAddress: CLAIMANT, ipAddress: IP_CLAIMANT })]);
    const after = await readAsset(id);
    expect(after?.ipAddress).toBe(IP_REAL);
    expect(after?.macAddress).toBe(REAL);
    expect(after?.macAddressRows.map((r) => r.mac)).toEqual([REAL]);
  });

  it("device-inventory row with an unknown MAC becomes its own asset, not the named one's", async () => {
    const id = await seedServer(false);
    await run(
      [lease({ macAddress: CLAIMANT, ipAddress: IP_CLAIMANT })],
      [inv({ macAddress: CLAIMANT, ipAddress: IP_CLAIMANT })],
    );
    const after = await readAsset(id);
    expect(after?.ipAddress).toBe(IP_REAL);
    expect(after?.macAddress).toBe(REAL);
    expect(after?.os).toBe("Rocky Linux");
    expect(after?.manufacturer).toBeNull();
    expect(after?.lastSeenSwitch).toBeNull();
    expect(after?.macAddressRows.map((r) => r.mac)).toEqual([REAL]);

    // The server has no discovery source, so it keeps its name; the new
    // device is named apart by MAC (rule 91(i)).
    const named = await assetsNamed();
    expect(named.map((a) => a.id)).toEqual([id]);
    const family = await assetsInFamily();
    expect(family).toHaveLength(2);
    const other = family.find((a) => a.id !== id);
    expect(other?.hostname).toBe(`${HOST}-910BEE`);
    expect(other?.macAddress).toBe(CLAIMANT);
    expect(other?.ipAddress).toBe(IP_CLAIMANT);
  });

  it("many devices sending one hostname stay many assets across runs", async () => {
    await seedServer(false);
    const macs = ["AA:BB:CC:91:0F:01", "AA:BB:CC:91:0F:02", "AA:BB:CC:91:0F:03"];
    const rows = macs.map((m, i) => inv({ macAddress: m, ipAddress: `10.91.191.${50 + i}` }));
    await run([], rows);
    await run([], rows);
    const family = await assetsInFamily();
    expect(family).toHaveLength(1 + macs.length);
    expect(new Set(family.map((a) => a.macAddress))).toEqual(new Set([REAL, ...macs]));
    // Rule 91(i): each new device carries its MAC; the second run renames nothing.
    expect(new Set(family.map((a) => a.hostname))).toEqual(new Set([HOST, `${HOST}-910F01`, `${HOST}-910F02`, `${HOST}-910F03`]));
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

/**
 * tests/integration/hostnameMacSuffix.test.ts
 *
 * Business rule 91(i) through the real `syncDhcpSubnets`: when Phase 7
 * creates an asset whose name another live asset already carries, every
 * bare-named member of that family whose name discovery gave it becomes
 * `<name>-<last 3 MAC octets>` — and the name survives Phase 10 / 11 (the
 * fortigate-endpoint source echoes the in-memory row) and the next run.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncDhcpSubnets } from "../../src/services/discovery/discoveryEngine.js";

const d = dbDescribe;
const HOST = "HN-SFX-PHONE";
const GATE = "HN-SFX-GW";
const MAC_A = "AA:BB:CC:91:1A:01";
const MAC_B = "AA:BB:CC:91:1B:02";
const MAC_C = "AA:BB:CC:91:1C:03";
const INTEGRATION = "hn-sfx-test";
let integrationId = "";

async function cleanup(): Promise<void> {
  const assets = await prisma.asset.findMany({
    where: { OR: [{ hostname: { startsWith: "HN-SFX", mode: "insensitive" } }, { macAddress: { in: [MAC_A, MAC_B, MAC_C] } }] },
    select: { id: true },
  });
  if (assets.length) await prisma.asset.deleteMany({ where: { id: { in: assets.map((a) => a.id) } } });
  const intgs = await prisma.integration.findMany({ where: { name: INTEGRATION }, select: { id: true } });
  if (intgs.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: intgs.map((i) => i.id) } } });
    await prisma.integration.deleteMany({ where: { id: { in: intgs.map((i) => i.id) } } });
  }
}

beforeAll(async () => { if (dbReachable) await prisma.$connect(); });
afterAll(async () => { if (!dbReachable) return; await cleanup(); await prisma.$disconnect(); });
beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const intg = await prisma.integration.create({ data: { type: "fortimanager", name: INTEGRATION, config: {}, enabled: true } });
  integrationId = intg.id;
});

function inv(mac: string, ip: string) {
  return {
    device: GATE, hostname: HOST, macAddress: mac, ipAddress: ip, os: "iOS", osVersion: "18", hardwareVendor: "Apple",
    interfaceName: "internal", switchName: "", switchPort: "", apName: "", user: "", isOnline: true,
    lastSeen: new Date().toISOString(),
  };
}

const run = (deviceInventory: any[]) =>
  syncDhcpSubnets(integrationId, INTEGRATION, "fortimanager", {
    subnets: [], devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory,
    inventoryDevices: deviceInventory.length ? [GATE] : [],
    knownDeviceNames: [GATE], knownDeviceSerials: [],
    fortiSwitches: [], fortiAps: [], vips: [], switchMacTable: [], arpTable: [], arpQueriedDevices: [],
  } as any, "tester", "full");

const names = async () =>
  (await prisma.asset.findMany({ where: { hostname: { startsWith: HOST } }, select: { macAddress: true, hostname: true } }))
    .reduce<Record<string, string | null>>((acc, a) => { acc[a.macAddress!] = a.hostname; return acc; }, {});

d("devices that share a discovered name are named apart by MAC (business rule 91(i))", () => {
  it("one device keeps the bare name", async () => {
    await run([inv(MAC_A, "10.91.192.11")]);
    expect(await names()).toEqual({ [MAC_A]: HOST });
  });

  it("a second device renames both — and the names survive the same run's source stamp and the next run", async () => {
    await run([inv(MAC_A, "10.91.192.11")]);
    // The first device is seen again in the run that discovers the second, so
    // Phase 10 re-stamps its fortigate-endpoint source from the in-memory row.
    await run([inv(MAC_A, "10.91.192.11"), inv(MAC_B, "10.91.192.12")]);
    expect(await names()).toEqual({ [MAC_A]: `${HOST}-911A01`, [MAC_B]: `${HOST}-911B02` });

    const src = await prisma.assetSource.findFirst({ where: { sourceKind: "fortigate-endpoint", externalId: MAC_A }, select: { observed: true } });
    expect((src?.observed as any)?.hostname).toBe(`${HOST}-911A01`);

    await run([inv(MAC_A, "10.91.192.11"), inv(MAC_B, "10.91.192.12")]);
    expect(await names()).toEqual({ [MAC_A]: `${HOST}-911A01`, [MAC_B]: `${HOST}-911B02` });

    const ev = await prisma.event.findFirst({ where: { action: "asset.discovery_updated", resourceName: `${HOST}-911A01` } });
    expect(ev).not.toBeNull();
  });

  it("three new devices in one run are each named apart", async () => {
    await run([inv(MAC_A, "10.91.192.11"), inv(MAC_B, "10.91.192.12"), inv(MAC_C, "10.91.192.13")]);
    expect(await names()).toEqual({ [MAC_A]: `${HOST}-911A01`, [MAC_B]: `${HOST}-911B02`, [MAC_C]: `${HOST}-911C03` });
  });

  it("a third device joins the suffixed family", async () => {
    await run([inv(MAC_A, "10.91.192.11"), inv(MAC_B, "10.91.192.12")]);
    await run([inv(MAC_C, "10.91.192.13")]);
    expect(await names()).toEqual({ [MAC_A]: `${HOST}-911A01`, [MAC_B]: `${HOST}-911B02`, [MAC_C]: `${HOST}-911C03` });
  });

  it("an operator's rename is never touched, but the new device is still named apart", async () => {
    await run([inv(MAC_A, "10.91.192.11")]);
    const a = await prisma.asset.findFirstOrThrow({ where: { macAddress: MAC_A }, select: { id: true } });
    await prisma.asset.update({ where: { id: a.id }, data: { hostname: HOST, hostnameOverride: HOST } });
    await run([inv(MAC_B, "10.91.192.12")]);
    expect(await names()).toEqual({ [MAC_A]: HOST, [MAC_B]: `${HOST}-911B02` });
  });

  it("a hand-made asset with the name keeps it", async () => {
    await prisma.asset.create({ data: { hostname: HOST, macAddress: MAC_A, assetType: "workstation", status: "active", ipAddress: "10.91.192.11" } });
    await run([inv(MAC_B, "10.91.192.12")]);
    expect(await names()).toEqual({ [MAC_A]: HOST, [MAC_B]: `${HOST}-911B02` });
  });
});

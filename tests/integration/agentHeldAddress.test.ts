/**
 * tests/integration/agentHeldAddress.test.ts
 *
 * Business rule 195 through the real `syncDhcpSubnets`: an asset whose own
 * agent confirms the address it connects from keeps that address through a
 * FortiGate discovery run. The DHCP / detected-device / ARP ladder (rule 101)
 * still records its sightings but stages no ipAddress for the asset, and the
 * end-of-run projection writes the agent's address, labelled as the agent's.
 *
 * The motivating case (prod, 2026-11-19): a plant HMI whose Ethernet card is
 * on a static address the gate holds no binding for, and whose Wi-Fi card
 * holds a lease. The agent connects from the Ethernet address; the asset
 * showed the Wi-Fi lease.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncDhcpSubnets } from "../../src/services/discovery/discoveryEngine.js";

const d = dbDescribe;
const ETH = "AA:BB:CC:01:95:40";
const WIFI = "AA:BB:CC:01:95:6E";
const HOST = "AGENT-HELD-HMI";
const GATE = "AGENT-HELD-GW";
const IP_ETH = "10.95.175.193";
const IP_WIFI = "10.95.174.134";
const IP_WIFI_ALT = "10.95.174.200";
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
    where: { OR: [{ macAddress: { in: macs } }, { hostname: { contains: "AGENT-HELD", mode: "insensitive" } }] },
  });
  const intgs = await prisma.integration.findMany({ where: { name: "agent-held-test" }, select: { id: true } });
  if (intgs.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: intgs.map((i) => i.id) } } });
    await prisma.integration.deleteMany({ where: { id: { in: intgs.map((i) => i.id) } } });
  }
}

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const intg = await prisma.integration.create({
    data: { type: "fortimanager", name: "agent-held-test", config: {}, enabled: true },
  });
  integrationId = intg.id;
});

/** The HMI on its agent's address, with the agent's source row. */
async function seedHmi(opts: { agentLastSeen?: Date; confirmedIp?: string | null; ipAddress?: string } = {}): Promise<string> {
  const seen = new Date();
  const a = await prisma.asset.create({
    data: {
      hostname: HOST, macAddress: ETH, assetType: "workstation", status: "active",
      ipAddress: opts.ipAddress ?? IP_ETH, ipSource: "polaris-agent",
      macAddressRows: {
        create: [
          { mac: ETH, source: "intune-ethernet", lastSeen: seen, firstSeen: seen },
          { mac: WIFI, source: "intune-wifi", lastSeen: seen, firstSeen: seen },
        ],
      },
    },
  });
  const agentSeen = opts.agentLastSeen ?? seen;
  await prisma.assetSource.create({
    data: {
      assetId: a.id, sourceKind: "polaris-agent", externalId: `agent-${a.id}`, inferred: false,
      observed: {
        hostname: HOST, primaryIp: IP_ETH,
        ...(opts.confirmedIp === null ? {} : { confirmedIp: opts.confirmedIp ?? IP_ETH }),
      },
      firstSeen: agentSeen, lastSeen: agentSeen, syncedAt: agentSeen,
    },
  });
  return a.id;
}

const wifiLease = (ip = IP_WIFI) => ({
  device: GATE, interfaceName: "internal", hostname: HOST, type: "dhcp-lease" as const, seenLeased: true,
  macAddress: WIFI, ipAddress: ip, accessPoint: "AP-1", ssid: "plant",
});

const wifiOnline = (ip = IP_WIFI) => ({
  device: GATE, hostname: HOST, os: "Windows", osVersion: "", hardwareVendor: "", interfaceName: "internal",
  switchName: "", switchPort: "", apName: "AP-1", user: "", isOnline: true,
  lastSeen: new Date().toISOString(), macAddress: WIFI, ipAddress: ip,
});

function resultWith(dhcpEntries: any[], deviceInventory: any[] = [], arpTable: any[] = []) {
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
  syncDhcpSubnets(integrationId, "agent-held-test", "fortimanager", resultWith(dhcpEntries, deviceInventory, arpTable), "tester", "full");

const readIp = (id: string) =>
  prisma.asset.findUnique({ where: { id }, select: { ipAddress: true, ipSource: true } });

/**
 * The end-of-run projection would put the agent's address back even if the
 * ladder had moved it, so the final ipAddress alone cannot show a flap. A
 * staged primary write leaves an AssetIpHistory row carrying its ipSource
 * (fire-and-forget in src/db.ts, hence the short settle); none may name the gate.
 */
async function gatePrimaryWrites(id: string): Promise<string[]> {
  await new Promise((r) => setTimeout(r, 300));
  const rows = await prisma.assetIpHistory.findMany({ where: { assetId: id }, select: { ip: true, source: true } });
  return rows.filter((r) => (r.source ?? "").includes(GATE)).map((r) => r.ip);
}

d("the agent's confirmed address holds through discovery (business rule 195)", () => {
  it("the HMI: a held Wi-Fi lease does not move the asset off its agent's address", async () => {
    const id = await seedHmi();
    await run([wifiLease()]);
    expect(await readIp(id)).toMatchObject({ ipAddress: IP_ETH });
    expect(await gatePrimaryWrites(id)).toEqual([]);
    // The sighting still lands on the address list.
    const rows = await prisma.assetAssociatedIp.findMany({ where: { assetId: id }, select: { ip: true } });
    expect(rows.map((r) => r.ip)).toContain(IP_WIFI);
  });

  it("an online detected-device row and an ARP binding do not move it either", async () => {
    const id = await seedHmi();
    await run([wifiLease()], [wifiOnline()], [{ mac: WIFI, ip: IP_WIFI_ALT, fortigateDevice: GATE }]);
    expect(await readIp(id)).toMatchObject({ ipAddress: IP_ETH });
    expect(await gatePrimaryWrites(id)).toEqual([]);
  });

  it("an asset on the gate's address is moved to the agent's by the run's projection", async () => {
    const id = await seedHmi({ ipAddress: IP_WIFI });
    await run([wifiLease()]);
    expect(await readIp(id)).toEqual({ ipAddress: IP_ETH, ipSource: "polaris-agent" });
  });

  it("no confirmed address: the ladder decides, as before", async () => {
    const id = await seedHmi({ confirmedIp: null });
    await run([wifiLease()]);
    expect(await readIp(id)).toMatchObject({ ipAddress: IP_WIFI });
  });

  it("an agent silent for over 24 h hands the address back to the ladder", async () => {
    const id = await seedHmi({ agentLastSeen: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    await run([wifiLease()]);
    expect(await readIp(id)).toMatchObject({ ipAddress: IP_WIFI });
  });
});

/**
 * tests/integration/deviceInventoryFlush.test.ts
 *
 * Phase 7 (device inventory) defers its per-sighting asset.update and MAC
 * reconcile to a flush at the end of the phase, keeping every in-memory
 * effect inline. deviceInventory is the largest row set in a run — every DHCP
 * client across every gate — and it used to pay an update plus a two-query
 * MAC reconcile per sighting, serially.
 *
 * The hazard that shape must survive is TWO SIGHTINGS OF ONE ASSET in a single
 * run (several gates reporting the same client, which is routine): the second
 * row's update is computed from the in-memory object the first row already
 * mutated, so replaying both must land the same final row the inline writes
 * did — and must NOT mint a duplicate asset. That is only observable through
 * the real function against a real database, so this drives syncDhcpSubnets
 * with a DiscoveryResult carrying nothing but inventory.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncDhcpSubnets } from "../../src/services/discovery/discoveryEngine.js";

const d = dbDescribe;
const MAC_A = "AA:BB:CC:00:00:01";
const MAC_B = "AA:BB:CC:00:00:02";
const HOST = "INV-FLUSH-1";
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
  const macs = [MAC_A, MAC_B];
  const owned = await prisma.assetMacAddress.findMany({ where: { mac: { in: macs } }, select: { assetId: true } });
  const ids = [...new Set(owned.map((m) => m.assetId))];
  if (ids.length) await prisma.asset.deleteMany({ where: { id: { in: ids } } });
  await prisma.asset.deleteMany({ where: { OR: [{ macAddress: { in: macs } }, { hostname: { contains: "INV-FLUSH", mode: "insensitive" } }] } });
  const intgs = await prisma.integration.findMany({ where: { name: "inv-flush-test" }, select: { id: true } });
  if (intgs.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: intgs.map((i) => i.id) } } });
    await prisma.integration.deleteMany({ where: { id: { in: intgs.map((i) => i.id) } } });
  }
}

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const intg = await prisma.integration.create({
    data: { type: "fortimanager", name: "inv-flush-test", config: {}, enabled: true },
  });
  integrationId = intg.id;
});

function inv(over: Record<string, unknown> = {}) {
  return {
    device: "GATE-1",
    macAddress: MAC_A,
    ipAddress: "10.80.0.10",
    hostname: HOST,
    os: "Windows",
    osVersion: "",
    hardwareVendor: "Dell",
    interfaceName: "internal",
    switchName: "",
    switchPort: "",
    apName: "",
    user: "",
    isOnline: true,
    lastSeen: new Date("2026-09-01T10:00:00Z").toISOString(),
    ...over,
  };
}

/** A DiscoveryResult carrying inventory and nothing else. */
function resultWith(deviceInventory: any[]) {
  return {
    subnets: [], devices: [], interfaceIps: [], dhcpEntries: [],
    deviceInventory,
    inventoryDevices: ["GATE-1", "GATE-2"],
    knownDeviceNames: ["GATE-1", "GATE-2"],
    knownDeviceSerials: [],
    fortiSwitches: [], fortiAps: [], vips: [],
    macTable: [], arpEntries: [],
  } as any;
}

const run = (deviceInventory: any[]) =>
  syncDhcpSubnets(integrationId, "inv-flush-test", "fortimanager", resultWith(deviceInventory), "tester", "full");

const assetsForMac = (mac: string) =>
  prisma.asset.findMany({ where: { macAddress: mac }, select: { id: true, hostname: true, os: true, ipAddress: true } });

d("Phase 7 device-inventory deferred flush", () => {
  it("creates one asset from a sighting and persists it", async () => {
    await run([inv()]);
    const rows = await assetsForMac(MAC_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hostname).toBe(HOST);
    expect(rows[0]!.ipAddress).toBe("10.80.0.10");
  });

  it("two gates sighting ONE client land one asset, not a duplicate", async () => {
    // Same MAC from two gates in the same run — the create path is inline
    // precisely so the second sighting resolves to the asset the first made.
    await run([
      inv({ device: "GATE-1" }),
      inv({ device: "GATE-2", ipAddress: "10.80.0.11", lastSeen: new Date("2026-09-01T12:00:00Z").toISOString() }),
    ]);
    const rows = await assetsForMac(MAC_A);
    expect(rows).toHaveLength(1);
  });

  it("the freshest LOCAL sighting's IP wins, and the deferred update actually lands", async () => {
    // An existing asset updated twice in one run: the second row's update is
    // computed from the in-memory object the first already mutated, so the
    // flush must leave the fresher value — this is the case the deferral
    // could plausibly get wrong.
    //
    // Two fixture details the ranking depends on, both of them real semantics:
    // switchName makes the sighting LOCAL (inventorySightingIsLocal: behind a
    // managed switch or AP, else it needs ARP corroboration) — without it the
    // IP is deliberately not written, see the next test. And isOnline:false is
    // what makes lastSeen matter at all, because an ONLINE row is stamped
    // `now` whatever its lastSeen says. Remembered-but-offline rows from two
    // gates is precisely the case the freshness ranking exists for: the site a
    // laptop left keeps its old entry.
    const existing = await prisma.asset.create({
      data: { hostname: HOST, macAddress: MAC_A, assetType: "workstation", status: "active", ipAddress: "10.80.0.1" },
    });
    await run([
      inv({ device: "GATE-1", switchName: "SW-1", isOnline: false, ipAddress: "10.80.0.20", lastSeen: new Date("2026-09-01T10:00:00Z").toISOString() }),
      inv({ device: "GATE-2", switchName: "SW-2", isOnline: false, ipAddress: "10.80.0.21", lastSeen: new Date("2026-09-01T18:00:00Z").toISOString() }),
    ]);
    const after = await prisma.asset.findUnique({ where: { id: existing.id }, select: { ipAddress: true, os: true } });
    expect(after?.ipAddress).toBe("10.80.0.21");
    // A scalar the inventory supplies proves the deferred write landed at all.
    expect(after?.os).toBe("Windows");
  });

  it("a NON-local sighting still updates the asset but never claims its address", async () => {
    // No switch/AP name and no ARP corroboration = possibly ZTNA-relayed, so
    // the device is real (os still lands) but must not be said to sit behind
    // this gate. Pinned here because the deferral rewrote the branch that
    // stages both kinds of field.
    const existing = await prisma.asset.create({
      data: { hostname: HOST, macAddress: MAC_A, assetType: "workstation", status: "active", ipAddress: "10.80.0.1" },
    });
    await run([inv({ ipAddress: "10.80.0.99", os: "Linux" })]);
    const after = await prisma.asset.findUnique({ where: { id: existing.id }, select: { ipAddress: true, os: true } });
    expect(after?.ipAddress).toBe("10.80.0.1");
    expect(after?.os).toBe("Linux");
  });

  it("a sighting that AGREES with an operator IP override releases the pin and audits it", async () => {
    // While pinned, ipAddress already equals ipOverride — the equality gate
    // used to skip the write, so the db.ts guard never saw the matching IP
    // and the override never self-cleared.
    const existing = await prisma.asset.create({
      data: {
        hostname: HOST, macAddress: MAC_A, assetType: "workstation", status: "active",
        ipAddress: "10.80.0.50", ipOverride: "10.80.0.50", ipSource: "manual",
      },
    });
    await run([inv({ switchName: "SW-1", ipAddress: "10.80.0.50" })]);
    const after = await prisma.asset.findUnique({ where: { id: existing.id }, select: { ipAddress: true, ipOverride: true } });
    expect(after?.ipAddress).toBe("10.80.0.50");
    expect(after?.ipOverride).toBeNull();
    // The release Event is written by a fire-and-forget follow-up.
    let events = 0;
    for (let i = 0; i < 40 && events === 0; i++) {
      events = await prisma.event.count({ where: { action: "asset.ip_override.released", resourceId: existing.id } });
      if (events === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(events).toBe(1);
    await prisma.event.deleteMany({ where: { resourceId: existing.id } });
  });

  it("a sighting that DISAGREES with an operator IP override keeps the pin", async () => {
    const existing = await prisma.asset.create({
      data: {
        hostname: HOST, macAddress: MAC_A, assetType: "workstation", status: "active",
        ipAddress: "10.80.0.50", ipOverride: "10.80.0.50", ipSource: "manual",
      },
    });
    await run([inv({ switchName: "SW-1", ipAddress: "10.80.0.51" })]);
    const after = await prisma.asset.findUnique({ where: { id: existing.id }, select: { ipAddress: true, ipOverride: true } });
    expect(after?.ipAddress).toBe("10.80.0.50");
    expect(after?.ipOverride).toBe("10.80.0.50");
  });

  it("reconciles the MAC side table once per asset, keeping the last list", async () => {
    await run([inv(), inv({ device: "GATE-2" })]);
    const rows = await assetsForMac(MAC_A);
    expect(rows).toHaveLength(1);
    const macs = await prisma.assetMacAddress.findMany({
      where: { assetId: rows[0]!.id }, select: { mac: true },
    });
    // One row for the one MAC — a per-sighting reconcile replaying an earlier
    // list is what would drop or duplicate entries here.
    expect(macs.map((m) => m.mac)).toEqual([MAC_A]);
  });

  it("keeps distinct clients distinct", async () => {
    await run([inv(), inv({ macAddress: MAC_B, ipAddress: "10.80.0.30", hostname: "INV-FLUSH-2" })]);
    expect(await assetsForMac(MAC_A)).toHaveLength(1);
    expect(await assetsForMac(MAC_B)).toHaveLength(1);
  });
});

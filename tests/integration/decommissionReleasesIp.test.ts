/**
 * tests/integration/decommissionReleasesIp.test.ts
 *
 * Business rule 40(k) end to end against a real database: a decommissioned
 * asset holds no address. The src/db.ts extension clears the primary address
 * on the write that decommissions — through update, updateMany and upsert —
 * keeps it in AssetIpHistory, records an `asset.ip_released` Event, and drops
 * a discovery write that re-stages an address on the retired row. Skips
 * cleanly when DATABASE_URL is unreachable; see tests/integration/_helpers.ts.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";

const d = dbDescribe;
const HOST_PREFIX = "decomm-release-test-";
// TEST-NET-2 — never a real fleet address.
const IP = "198.51.100.61";
const IP2 = "198.51.100.62";

async function wipe() {
  const ids = (await prisma.asset.findMany({ where: { hostname: { startsWith: HOST_PREFIX } }, select: { id: true } })).map((a) => a.id);
  if (ids.length) await prisma.event.deleteMany({ where: { assetId: { in: ids } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST_PREFIX } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  try { await wipe(); } catch { /* noop */ }
  try { await prisma.$disconnect(); } catch { /* noop */ }
});

beforeEach(async () => {
  if (!dbReachable) return;
  await wipe();
});

async function makeSwitch(suffix: string, ip: string) {
  return prisma.asset.create({
    data: {
      hostname: `${HOST_PREFIX}${suffix}`,
      assetType: "switch",
      status: "active",
      ipAddress: ip,
      ipSource: "fortimanager",
      ipOverride: ip,
      lastSeen: new Date(),
    },
  });
}

/** recordIpHistory on create is fire-and-forget; wait for its row. */
async function waitForHistory(assetId: string, ip: string) {
  for (let i = 0; i < 50; i++) {
    const row = await prisma.assetIpHistory.findUnique({ where: { assetId_ip: { assetId, ip } } });
    if (row) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

d("rule 40(k) — decommissioning releases the address", () => {
  it("update: clears the address and pins, keeps the history row, records an event", async () => {
    const sw = await makeSwitch("update", IP);
    const before = await waitForHistory(sw.id, IP);
    expect(before).not.toBeNull();

    await prisma.asset.update({
      where: { id: sw.id },
      data: { status: "decommissioned", statusChangedBy: "alice" },
    });

    const row = await prisma.asset.findUniqueOrThrow({ where: { id: sw.id } });
    expect(row.ipAddress).toBeNull();
    expect(row.ipOverride).toBeNull();
    expect(row.ipSource).toBeNull();

    const hist = await prisma.assetIpHistory.findUnique({ where: { assetId_ip: { assetId: sw.id, ip: IP } } });
    expect(hist).not.toBeNull();
    expect(hist!.firstSeen.getTime()).toBe(before!.firstSeen.getTime());

    const ev = await prisma.event.findFirst({ where: { assetId: sw.id, action: "asset.ip_released" } });
    expect(ev?.actor).toBe("alice");
    expect((ev?.details as Record<string, unknown>)?.previousIpAddress).toBe(IP);
  });

  it("history row is created when the address had none", async () => {
    const sw = await makeSwitch("nohist", IP);
    await waitForHistory(sw.id, IP);
    await prisma.assetIpHistory.deleteMany({ where: { assetId: sw.id } });

    await prisma.asset.update({ where: { id: sw.id }, data: { status: "decommissioned" } });

    const hist = await prisma.assetIpHistory.findUnique({ where: { assetId_ip: { assetId: sw.id, ip: IP } } });
    expect(hist?.source).toBe("fortimanager");
  });

  it("updateMany: a decommission sweep releases every row it transitions", async () => {
    const a = await makeSwitch("many-a", IP);
    const b = await makeSwitch("many-b", IP2);
    await prisma.asset.updateMany({
      where: { id: { in: [a.id, b.id] }, status: { not: "decommissioned" } },
      data: { status: "decommissioned", statusChangedBy: "FMG" },
    });
    const rows = await prisma.asset.findMany({ where: { id: { in: [a.id, b.id] } }, select: { ipAddress: true } });
    expect(rows.every((r) => r.ipAddress === null)).toBe(true);
    const events = await prisma.event.count({ where: { assetId: { in: [a.id, b.id] }, action: "asset.ip_released" } });
    expect(events).toBe(2);
  });

  it("a discovery write re-staging an address on the decommissioned row is dropped; reactivating takes it", async () => {
    const sw = await makeSwitch("restage", IP);
    await prisma.asset.update({ where: { id: sw.id }, data: { status: "decommissioned" } });

    await prisma.asset.update({ where: { id: sw.id }, data: { ipAddress: IP, ipSource: "fortimanager" } });
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: sw.id } })).ipAddress).toBeNull();

    await prisma.asset.update({ where: { id: sw.id }, data: { status: "active", ipAddress: IP, ipSource: "fortimanager" } });
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: sw.id } })).ipAddress).toBe(IP);
  });

  it("re-saving an already-decommissioned asset writes no second event", async () => {
    const sw = await makeSwitch("resave", IP);
    await prisma.asset.update({ where: { id: sw.id }, data: { status: "decommissioned" } });
    await prisma.asset.update({ where: { id: sw.id }, data: { status: "decommissioned" } });
    const events = await prisma.event.count({ where: { assetId: sw.id, action: "asset.ip_released" } });
    expect(events).toBe(1);
  });

  it("an asset created decommissioned holds no address but keeps it in history", async () => {
    const sw = await prisma.asset.create({
      data: { hostname: `${HOST_PREFIX}created`, assetType: "switch", status: "decommissioned", ipAddress: IP, ipSource: "activedirectory" },
    });
    expect(sw.ipAddress).toBeNull();
    const hist = await waitForHistory(sw.id, IP);
    expect(hist?.source).toBe("activedirectory");
  });
});

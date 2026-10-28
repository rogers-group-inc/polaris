/**
 * tests/integration/serialHostnameGhostMerge.test.ts
 *
 * The serial-as-hostname pass of the mergeDuplicateHostnameAssets job
 * (`mergeSerialHostnameGhosts`), against a real database so the raw grouping
 * query runs. Prod 2026-10-28: FortiSwitch GAINESBOROPLANT-148F-1 sat beside a
 * "fortigate-endpoint" asset hostnamed its serial for days, because only a
 * discovery run that re-processed the switch could absorb it.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { mergeSerialHostnameGhosts } from "../../src/services/assetGhostMergeService.js";

const d = dbDescribe;
const SERIAL = "S148FFTF9128C001";
const SWITCH_NAME = "SHGM-148F-1";
const GHOST_MAC = "D4:B4:C0:91:28:4E";
const MGMT_IP = "10.91.28.129";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});

async function cleanup(): Promise<void> {
  await prisma.asset.deleteMany({
    where: { OR: [{ hostname: { in: [SERIAL, SWITCH_NAME] } }, { serialNumber: SERIAL }, { macAddress: GHOST_MAC }] },
  });
}

async function seedSwitch(over: { status?: "active" | "decommissioned" } = {}): Promise<string> {
  const a = await prisma.asset.create({
    data: {
      hostname: SWITCH_NAME, serialNumber: SERIAL, assetType: "switch", status: over.status ?? "active",
      ipAddress: MGMT_IP, manufacturer: "Fortinet",
    },
  });
  // Upsert, not create: the Asset create hook (db.ts → shadowWriteAssetSources)
  // derives this same (fortiswitch, serial) row fire-and-forget from a Fortinet
  // switch, so a plain create races it on the unique key.
  await prisma.assetSource.upsert({
    where: { sourceKind_externalId: { sourceKind: "fortiswitch", externalId: SERIAL } },
    create: { assetId: a.id, sourceKind: "fortiswitch", externalId: SERIAL, observed: { serial: SERIAL } },
    update: { assetId: a.id },
  });
  return a.id;
}

async function seedGhost(extraKind?: string): Promise<string> {
  const a = await prisma.asset.create({
    data: {
      hostname: SERIAL, macAddress: GHOST_MAC, ipAddress: MGMT_IP, assetType: "other", status: "active",
    },
  });
  await prisma.assetSource.create({
    data: { assetId: a.id, sourceKind: "fortigate-endpoint", externalId: GHOST_MAC, observed: {} },
  });
  if (extraKind) {
    await prisma.assetSource.create({
      data: { assetId: a.id, sourceKind: extraKind, externalId: `${extraKind}-${a.id}`, observed: {} },
    });
  }
  return a.id;
}

d("mergeSerialHostnameGhosts", () => {
  it("absorbs an endpoint asset named after a switch's serial and stamps its MAC on the switch", async () => {
    const switchId = await seedSwitch();
    const ghostId = await seedGhost();

    const stats = await mergeSerialHostnameGhosts();

    expect(stats.merged).toBe(1);
    expect(await prisma.asset.findUnique({ where: { id: ghostId } })).toBeNull();
    const sw = await prisma.asset.findUniqueOrThrow({ where: { id: switchId }, select: { hostname: true, macAddress: true } });
    expect(sw.hostname).toBe(SWITCH_NAME);
    expect(sw.macAddress).toBe(GHOST_MAC);
    const kinds = (await prisma.assetSource.findMany({ where: { assetId: switchId }, select: { sourceKind: true } }))
      .map((s) => s.sourceKind);
    expect(kinds).not.toContain("fortigate-endpoint");
    const ev = await prisma.event.findFirst({
      where: { action: "asset.duplicate_merged", resourceId: switchId },
      orderBy: { timestamp: "desc" },
    });
    expect(ev?.message).toContain(SERIAL);
  });

  it("is idempotent — a second run finds nothing", async () => {
    await seedSwitch();
    await seedGhost();
    await mergeSerialHostnameGhosts();
    const again = await mergeSerialHostnameGhosts();
    expect(again.merged).toBe(0);
  });

  it("dry-run decides but writes nothing", async () => {
    await seedSwitch();
    const ghostId = await seedGhost();
    const stats = await mergeSerialHostnameGhosts({ dryRun: true });
    expect(stats.merged).toBe(0);
    expect(await prisma.asset.findUnique({ where: { id: ghostId } })).not.toBeNull();
  });

  it("leaves a ghost with an authoritative source of its own alone", async () => {
    await seedSwitch();
    const ghostId = await seedGhost("entra");
    const stats = await mergeSerialHostnameGhosts();
    expect(stats.merged).toBe(0);
    expect(await prisma.asset.findUnique({ where: { id: ghostId } })).not.toBeNull();
  });

  it("does not merge into a decommissioned asset", async () => {
    await seedSwitch({ status: "decommissioned" });
    const ghostId = await seedGhost();
    await mergeSerialHostnameGhosts();
    expect(await prisma.asset.findUnique({ where: { id: ghostId } })).not.toBeNull();
  });
});

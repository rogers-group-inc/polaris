/**
 * tests/integration/chassisSwap.test.ts
 *
 * Business rule 41(a): one FortiGate swap is ONE decision. A gate serving
 * several subnets raises one chassis-replaced row per subnet; the bulk verbs
 * act on every pending row of an (old, new) serial pair, the nav badge counts
 * the pair once, and adopting can fold the old gate's asset into the new one.
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import { snapshotSubnet } from "../../src/services/subnetArchiveService.js";
import {
  raiseChassisReplacedConflict,
  adoptChassisSwap,
  rejectChassisSwap,
} from "../../src/services/subnetChassisConflictService.js";
import { countPendingConflicts } from "../../src/services/conflictResolutionService.js";

const d = dbDescribe;

// Synthetic serials — never paste real fleet serials into tests.
const OLD_SN = "FGT60FSWAPTEST01";
const NEW_SN = "FGT60FSWAPTEST02";
const HOST_PREFIX = "chassisswap-test-";
const CIDRS = ["10.78.1.0/24", "10.78.2.0/24", "10.78.3.0/24"];

async function wipe() {
  await prisma.conflict.deleteMany({ where: { entityType: "subnet" } });
  await prisma.archivedSubnet.deleteMany({ where: { cidr: { in: CIDRS } } });
  await prisma.subnet.deleteMany({ where: { cidr: { in: CIDRS } } });
  await prisma.ipBlock.deleteMany({ where: { cidr: "10.78.0.0/16" } });
  await prisma.assetControllerClaim.deleteMany({ where: { controllerKey: { in: [OLD_SN, NEW_SN] } } });
  await prisma.assetSource.deleteMany({ where: { externalId: { in: [OLD_SN, NEW_SN] } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST_PREFIX } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  try { await wipe(); } catch { /* noop */ }
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await wipe();
});

/** One gate, three subnets, swapped: three pending rows for one pair. */
async function seedSwap(): Promise<string[]> {
  const block = await prisma.ipBlock.create({
    data: { name: "Swap Test Block", cidr: "10.78.0.0/16", ipVersion: "v4" },
  });
  const subnetIds: string[] = [];
  for (const cidr of CIDRS) {
    const subnet = await prisma.subnet.create({
      data: { blockId: block.id, cidr, name: `lan ${cidr}`, status: "available", fortigateDevice: "swap-gate", fortigateSerial: OLD_SN },
    });
    const snap = await snapshotSubnet(subnet.id, { reason: "chassis-replaced", actor: null });
    await raiseChassisReplacedConflict({
      subnetId: subnet.id,
      cidr,
      blockId: block.id,
      oldSerial: OLD_SN,
      newSerial: NEW_SN,
      oldDeviceName: "swap-gate",
      newDeviceName: "swap-gate",
      archivedSubnetId: snap.archivedSubnetId,
    });
    subnetIds.push(subnet.id);
  }
  return subnetIds;
}

/** The two firewall assets discovery leaves behind after a same-name swap. */
async function seedGates() {
  const old = await prisma.asset.create({
    data: {
      hostname: `${HOST_PREFIX}gate`,
      assetType: "firewall",
      status: "decommissioned",
      serialNumber: OLD_SN,
      location: "Plant 7",
      notes: "Rack B, top shelf",
    },
  });
  const next = await prisma.asset.create({
    data: { hostname: `${HOST_PREFIX}gate`, assetType: "firewall", status: "active", serialNumber: NEW_SN },
  });
  await prisma.assetSource.createMany({
    data: [
      { assetId: old.id, sourceKind: "fortigate-firewall", externalId: OLD_SN, observed: {} },
      { assetId: next.id, sourceKind: "fortigate-firewall", externalId: NEW_SN, observed: {} },
    ],
  });
  await prisma.assetMacAddress.create({ data: { assetId: old.id, mac: "AA:BB:CC:78:00:01", source: "fortigate" } });
  // The old chassis's last roster read: it still "claims" the new gate's AP.
  const ap = await prisma.asset.create({
    data: { hostname: `${HOST_PREFIX}ap`, assetType: "access_point", status: "active", serialNumber: "FP231FSWAPTEST01" },
  });
  await prisma.assetControllerClaim.create({
    data: { assetId: ap.id, deviceSerial: "FP231FSWAPTEST01", sourceKind: "fortiap", controllerSerial: OLD_SN, controllerDevice: "swap-gate", controllerKey: OLD_SN },
  });
  return { oldId: old.id, newId: next.id };
}

d("chassis swap — one decision", () => {
  it("counts the swap's rows once on the nav badge", async () => {
    await seedSwap();
    expect(await prisma.conflict.count({ where: { entityType: "subnet", status: "pending" } })).toBe(3);
    expect(await countPendingConflicts(["subnet"])).toBe(1);
  });

  it("adopts every network of the swap in one call", async () => {
    const subnetIds = await seedSwap();
    const out = await adoptChassisSwap(OLD_SN.toLowerCase(), NEW_SN, { actor: "tester" });
    expect(out.adopted).toBe(3);
    expect(out.mergedAssetId).toBeNull();

    const subnets = await prisma.subnet.findMany({ where: { id: { in: subnetIds } }, select: { fortigateSerial: true } });
    expect(subnets.every((s) => s.fortigateSerial === NEW_SN)).toBe(true);
    expect(await prisma.conflict.count({ where: { entityType: "subnet", status: "pending" } })).toBe(0);
    expect(await prisma.conflict.count({ where: { entityType: "subnet", status: "accepted" } })).toBe(3);
  });

  it("merges the old gate into the new one and drops the dead chassis's identity", async () => {
    await seedSwap();
    const { oldId, newId } = await seedGates();
    const out = await adoptChassisSwap(OLD_SN, NEW_SN, { mergeOldAsset: true, actor: "tester" });

    expect(out.mergedAssetId).toBe(newId);
    expect(await prisma.asset.findUnique({ where: { id: oldId } })).toBeNull();
    const survivor = await prisma.asset.findUniqueOrThrow({ where: { id: newId } });
    expect(survivor.serialNumber).toBe(NEW_SN);
    expect(survivor.status).toBe("active");
    expect(survivor.location).toBe("Plant 7");
    expect(survivor.notes).toContain("Rack B");

    // The old chassis's source and MACs are not the new box's.
    const sources = await prisma.assetSource.findMany({ where: { assetId: newId, sourceKind: "fortigate-firewall" } });
    expect(sources.map((s) => s.externalId)).toEqual([NEW_SN]);
    expect(await prisma.assetMacAddress.count({ where: { assetId: newId, mac: "AA:BB:CC:78:00:01" } })).toBe(0);

    // Rule 83(c): the dead chassis no longer claims the AP.
    expect(out.removedClaims).toBe(1);
    expect(await prisma.assetControllerClaim.count({ where: { controllerKey: OLD_SN } })).toBe(0);
  });

  it("adopts without merging when the new gate has no asset yet, and says why", async () => {
    await seedSwap();
    const out = await adoptChassisSwap(OLD_SN, NEW_SN, { mergeOldAsset: true });
    expect(out.adopted).toBe(3);
    expect(out.mergeSkipped).toBe("old-asset-not-found");
  });

  it("dismisses every network of the swap, leaving each row as its dedup marker", async () => {
    await seedSwap();
    expect((await rejectChassisSwap(OLD_SN, NEW_SN, "tester")).rejected).toBe(3);
    expect(await prisma.conflict.count({ where: { entityType: "subnet", status: "rejected" } })).toBe(3);
  });

  it("refuses a pair with nothing pending", async () => {
    await expect(adoptChassisSwap(OLD_SN, NEW_SN)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(adoptChassisSwap(OLD_SN, OLD_SN)).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("routes: adopt + merge through the API, and the badge drops to zero", async () => {
    await seedSwap();
    await seedGates();
    const { agent, csrf } = await authedAgent(app);
    const before = await agent.get("/api/v1/conflicts/count");
    expect(before.body.count).toBeGreaterThanOrEqual(1);

    const res = await agent
      .post("/api/v1/conflicts/chassis-swap/adopt")
      .set("X-CSRF-Token", csrf)
      .send({ oldSerial: OLD_SN, newSerial: NEW_SN, mergeOldAsset: true });
    expect(res.status).toBe(200);
    expect(res.body.adopted).toBe(3);
    expect(res.body.mergedAssetId).toBeTruthy();

    const bad = await agent.post("/api/v1/conflicts/chassis-swap/reject").set("X-CSRF-Token", csrf).send({ oldSerial: OLD_SN });
    expect(bad.status).toBe(400);
  });
});

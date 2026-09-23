/**
 * tests/integration/serialConflicts.test.ts
 *
 * Covers the two serial Conflict flavours end to end against a real database
 * (business rule 83). Skips cleanly when DATABASE_URL is unreachable; see
 * tests/integration/_helpers.ts.
 *
 * Exercised:
 *   1. `serial-two-controllers` — two gates claiming one managed device raise
 *      ONE pending conflict carrying both claimants; a second pass refreshes
 *      rather than duplicating; the claim going stale auto-closes it.
 *   2. One gate claiming a device raises nothing, and an HA pair (two member
 *      serials resolving to one firewall asset) counts as one gate.
 *   3. `duplicate-serial` — two assets on one serial raise a conflict, and
 *      merging through the conflict verb absorbs one and closes it.
 *   4. Accept is refused for both flavours; reject dismisses and suppresses a
 *      re-raise of the same set.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import {
  reconcileSerialConflicts,
  recordControllerClaims,
  SERIAL_CLAIM_COLLISION_REASON,
  DUPLICATE_SERIAL_COLLISION_REASON,
  CLAIM_FRESH_DAYS,
} from "../../src/services/duplicateSerialConflictService.js";

const d = dbDescribe;
const HOST_PREFIX = "serialconf-test-";
const SW_SERIAL = "SERIALCONFTESTSW01";
const DUP_SERIAL = "SERIALCONFTESTDUP1";

async function wipe() {
  await prisma.conflict.deleteMany({
    where: { asset: { hostname: { startsWith: HOST_PREFIX } } },
  });
  await prisma.assetControllerClaim.deleteMany({
    where: { deviceSerial: { in: [SW_SERIAL] } },
  });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST_PREFIX } } });
  await prisma.assetSource.deleteMany({ where: { externalId: { startsWith: HOST_PREFIX } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
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

async function makeSwitch(): Promise<string> {
  const asset = await prisma.asset.create({
    data: {
      hostname: `${HOST_PREFIX}sw-01`,
      assetType: "switch",
      status: "active",
      serialNumber: SW_SERIAL,
    },
  });
  return asset.id;
}

/** Two firewall assets, each owning its own chassis serial through the
 *  `fortigate-firewall` AssetSource rows discovery writes. */
async function makeTwoGates(): Promise<{ a: string; b: string }> {
  const a = await prisma.asset.create({
    data: { hostname: `${HOST_PREFIX}fw-a`, assetType: "firewall", status: "active", serialNumber: `${HOST_PREFIX}FGA` },
  });
  const b = await prisma.asset.create({
    data: { hostname: `${HOST_PREFIX}fw-b`, assetType: "firewall", status: "active", serialNumber: `${HOST_PREFIX}FGB` },
  });
  await prisma.assetSource.createMany({
    data: [
      { assetId: a.id, sourceKind: "fortigate-firewall", externalId: `${HOST_PREFIX}FGA`, observed: {} },
      { assetId: b.id, sourceKind: "fortigate-firewall", externalId: `${HOST_PREFIX}FGB`, observed: {} },
    ],
  });
  return { a: a.id, b: b.id };
}

function pendingSerialClaimConflicts() {
  return prisma.conflict.findMany({
    where: {
      entityType: "asset",
      status: "pending",
      proposedAssetFields: { path: ["collisionReason"], equals: SERIAL_CLAIM_COLLISION_REASON },
    },
  });
}

function pendingDuplicateSerialConflicts() {
  return prisma.conflict.findMany({
    where: {
      entityType: "asset",
      status: "pending",
      proposedAssetFields: { path: ["collisionReason"], equals: DUPLICATE_SERIAL_COLLISION_REASON },
    },
  });
}

d("serial-two-controllers", () => {
  it("raises ONE conflict naming both gates, then refreshes rather than duplicating", async () => {
    const assetId = await makeSwitch();
    await makeTwoGates();
    await recordControllerClaims([
      { assetId, deviceSerial: SW_SERIAL, sourceKind: "fortiswitch", controllerSerial: `${HOST_PREFIX}FGA`, controllerDevice: "site-a-fw", integrationId: null },
      { assetId, deviceSerial: SW_SERIAL, sourceKind: "fortiswitch", controllerSerial: `${HOST_PREFIX}FGB`, controllerDevice: "site-b-fw", integrationId: null },
    ]);

    const first = await reconcileSerialConflicts();
    expect(first.contestedSerials).toBe(1);
    expect(first.raised).toBe(1);

    const open = await pendingSerialClaimConflicts();
    expect(open).toHaveLength(1);
    const proposed = open[0].proposedAssetFields as any;
    expect(proposed.deviceSerial).toBe(SW_SERIAL);
    expect(proposed.claimants).toHaveLength(2);
    expect(proposed.claimants.map((c: any) => c.controllerDevice).sort()).toEqual(["site-a-fw", "site-b-fw"]);
    // Each claimant resolved to its own firewall asset — that resolution is
    // what folds an HA pair, so it has to actually work against real rows.
    expect(proposed.claimants.every((c: any) => !!c.controllerAssetId)).toBe(true);
    expect(open[0].assetId).toBe(assetId);

    const second = await reconcileSerialConflicts();
    expect(second.raised).toBe(0);
    expect(second.refreshed).toBe(1);
    expect(await pendingSerialClaimConflicts()).toHaveLength(1);
  });

  it("raises nothing when only one gate claims the device", async () => {
    const assetId = await makeSwitch();
    await makeTwoGates();
    await recordControllerClaims([
      { assetId, deviceSerial: SW_SERIAL, sourceKind: "fortiswitch", controllerSerial: `${HOST_PREFIX}FGA`, controllerDevice: "site-a-fw", integrationId: null },
    ]);
    const result = await reconcileSerialConflicts();
    expect(result.contestedSerials).toBe(0);
    expect(await pendingSerialClaimConflicts()).toHaveLength(0);
  });

  it("treats an HA pair as ONE gate — both member serials resolve to one firewall asset", async () => {
    const assetId = await makeSwitch();
    const cluster = await prisma.asset.create({
      data: { hostname: `${HOST_PREFIX}fw-ha`, assetType: "firewall", status: "active", serialNumber: `${HOST_PREFIX}FGHA1` },
    });
    // Discovery writes one fortigate-firewall source row per CLUSTER MEMBER
    // against the cluster's single asset — this is what the fold relies on.
    await prisma.assetSource.createMany({
      data: [
        { assetId: cluster.id, sourceKind: "fortigate-firewall", externalId: `${HOST_PREFIX}FGHA1`, observed: {} },
        { assetId: cluster.id, sourceKind: "fortigate-firewall", externalId: `${HOST_PREFIX}FGHA2`, observed: {} },
      ],
    });
    await recordControllerClaims([
      { assetId, deviceSerial: SW_SERIAL, sourceKind: "fortiswitch", controllerSerial: `${HOST_PREFIX}FGHA1`, controllerDevice: "hq-fw", integrationId: null },
      { assetId, deviceSerial: SW_SERIAL, sourceKind: "fortiswitch", controllerSerial: `${HOST_PREFIX}FGHA2`, controllerDevice: "hq-fw-standby", integrationId: null },
    ]);

    const result = await reconcileSerialConflicts();
    expect(result.contestedSerials).toBe(0);
    expect(await pendingSerialClaimConflicts()).toHaveLength(0);
  });

  it("auto-closes when one gate stops re-asserting its claim (a completed move)", async () => {
    const assetId = await makeSwitch();
    await makeTwoGates();
    await recordControllerClaims([
      { assetId, deviceSerial: SW_SERIAL, sourceKind: "fortiswitch", controllerSerial: `${HOST_PREFIX}FGA`, controllerDevice: "site-a-fw", integrationId: null },
      { assetId, deviceSerial: SW_SERIAL, sourceKind: "fortiswitch", controllerSerial: `${HOST_PREFIX}FGB`, controllerDevice: "site-b-fw", integrationId: null },
    ]);
    await reconcileSerialConflicts();
    expect(await pendingSerialClaimConflicts()).toHaveLength(1);

    // The gate the device left stops reporting it: age its claim past the
    // freshness window rather than deleting it, which is what really happens.
    const stale = new Date(Date.now() - (CLAIM_FRESH_DAYS + 1) * 24 * 60 * 60 * 1000);
    await prisma.assetControllerClaim.updateMany({
      where: { deviceSerial: SW_SERIAL, controllerKey: `${HOST_PREFIX}FGA`.toUpperCase() },
      data: { lastSeen: stale },
    });

    const result = await reconcileSerialConflicts();
    expect(result.closed).toBeGreaterThanOrEqual(1);
    expect(await pendingSerialClaimConflicts()).toHaveLength(0);
    const closed = await prisma.conflict.findFirst({
      where: { assetId, proposedAssetFields: { path: ["collisionReason"], equals: SERIAL_CLAIM_COLLISION_REASON } },
      orderBy: { resolvedAt: "desc" },
    });
    expect(closed?.status).toBe("rejected");
    expect(closed?.resolvedBy).toBe("system:auto-resolved");
  });

  it("refuses Accept and suppresses a re-raise after Reject", async () => {
    const assetId = await makeSwitch();
    await makeTwoGates();
    await recordControllerClaims([
      { assetId, deviceSerial: SW_SERIAL, sourceKind: "fortiswitch", controllerSerial: `${HOST_PREFIX}FGA`, controllerDevice: "site-a-fw", integrationId: null },
      { assetId, deviceSerial: SW_SERIAL, sourceKind: "fortiswitch", controllerSerial: `${HOST_PREFIX}FGB`, controllerDevice: "site-b-fw", integrationId: null },
    ]);
    await reconcileSerialConflicts();
    const [conflict] = await pendingSerialClaimConflicts();
    const { agent, csrf } = await authedAgent(app);

    const accept = await agent
      .post(`/api/v1/conflicts/${conflict.id}/accept`)
      .set("X-CSRF-Token", csrf)
      .send({});
    expect(accept.status).toBe(400);

    const reject = await agent
      .post(`/api/v1/conflicts/${conflict.id}/reject`)
      .set("X-CSRF-Token", csrf)
      .send({});
    expect(reject.status).toBe(200);
    expect(await pendingSerialClaimConflicts()).toHaveLength(0);

    // Same two gates still arguing — the dismissal must hold.
    const after = await reconcileSerialConflicts();
    expect(after.suppressed).toBeGreaterThanOrEqual(1);
    expect(await pendingSerialClaimConflicts()).toHaveLength(0);
  });
});

d("duplicate-serial", () => {
  async function makeTwoRecords(): Promise<{ a: string; b: string }> {
    const a = await prisma.asset.create({
      data: { hostname: `${HOST_PREFIX}dup-a`, assetType: "server", status: "active", serialNumber: DUP_SERIAL },
    });
    const b = await prisma.asset.create({
      data: { hostname: `${HOST_PREFIX}dup-b`, assetType: "server", status: "active", serialNumber: DUP_SERIAL.toLowerCase() },
    });
    return { a: a.id, b: b.id };
  }

  it("raises one conflict for two records carrying one serial, case-insensitively", async () => {
    const { a, b } = await makeTwoRecords();
    const result = await reconcileSerialConflicts();
    expect(result.duplicateSerials).toBe(1);

    const open = await pendingDuplicateSerialConflicts();
    expect(open).toHaveLength(1);
    const proposed = open[0].proposedAssetFields as any;
    expect(proposed.serialNumber).toBe(DUP_SERIAL);
    expect(proposed.members.map((m: any) => m.assetId).sort()).toEqual([a, b].sort());
  });

  it("merges through the conflict verb: one record absorbed, conflict closed", async () => {
    const { a, b } = await makeTwoRecords();
    await reconcileSerialConflicts();
    const [conflict] = await pendingDuplicateSerialConflicts();
    const { agent, csrf } = await authedAgent(app);

    const res = await agent
      .post(`/api/v1/conflicts/${conflict.id}/merge`)
      .set("X-CSRF-Token", csrf)
      .send({ survivorAssetId: a, absorbAssetIds: [b] });
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(true);
    expect(res.body.absorbedAssetIds).toEqual([b]);

    expect(await prisma.asset.findUnique({ where: { id: b } })).toBeNull();
    expect(await prisma.asset.findUnique({ where: { id: a } })).not.toBeNull();
    const after = await prisma.conflict.findUnique({ where: { id: conflict.id } });
    expect(after?.status).toBe("accepted");
  });

  // "Review & merge..." on the card opens the asset Merge modal, which merges
  // through POST /assets/:id/merge rather than the conflict verb. That path
  // must close the card too — both directions, because the card is filed on
  // ONE member and merging that member away used to cascade-delete it.
  for (const direction of ["into the card's asset", "away from the card's asset"] as const) {
    it(`closes the card when merged through the asset Merge modal (${direction})`, async () => {
      const { a, b } = await makeTwoRecords();
      await reconcileSerialConflicts();
      const [conflict] = await pendingDuplicateSerialConflicts();
      const filedOn = conflict.assetId!;
      const other = filedOn === a ? b : a;
      const survivor = direction === "into the card's asset" ? filedOn : other;
      const absorbed = survivor === a ? b : a;
      const { agent, csrf } = await authedAgent(app);

      const res = await agent
        .post(`/api/v1/assets/${survivor}/merge`)
        .set("X-CSRF-Token", csrf)
        .send({ otherAssetId: absorbed, survivor: "this" });
      expect(res.status).toBe(200);
      expect(await prisma.asset.findUnique({ where: { id: absorbed } })).toBeNull();

      const after = await prisma.conflict.findUnique({ where: { id: conflict.id } });
      expect(after).not.toBeNull();
      expect(after?.status).toBe("accepted");
      expect(after?.assetId).toBe(survivor);
      expect(await pendingDuplicateSerialConflicts()).toHaveLength(0);
    });
  }

  it("does not raise for a placeholder serial", async () => {
    await prisma.asset.createMany({
      data: [
        { hostname: `${HOST_PREFIX}junk-a`, assetType: "server", status: "active", serialNumber: "To Be Filled By O.E.M." },
        { hostname: `${HOST_PREFIX}junk-b`, assetType: "server", status: "active", serialNumber: "to be filled by o.e.m." },
      ],
    });
    const result = await reconcileSerialConflicts();
    expect(result.duplicateSerials).toBe(0);
    expect(await pendingDuplicateSerialConflicts()).toHaveLength(0);
  });
});

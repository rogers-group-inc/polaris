/**
 * tests/integration/duplicateIpClear.test.ts
 *
 * Business rule 40(j) end to end against a real database: the duplicate-IP
 * card's "Clear" verb for an OFFLINE device, and the src/db.ts guard that lets
 * discovery fill the blank in. Skips cleanly when DATABASE_URL is unreachable;
 * see tests/integration/_helpers.ts.
 *
 * Exercised:
 *   1. POST /conflicts/:id/clear-ip blanks the member's address, records the
 *      blanked one in `ipCleared`, drops any pin, and closes the conflict.
 *   2. A discovery-shaped write re-staging the blanked address while the other
 *      device still holds it is dropped — the row stays blank.
 *   3. A discovery-shaped write staging a DIFFERENT address fills the blank
 *      and releases the hold.
 *   4. Once nothing else holds the blanked address, re-staging it is allowed.
 *   5. Saving the asset form with its (already blank) IP field does not
 *      re-project the contested address back onto the row.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import {
  reconcileDuplicateIpForAddresses,
  DUPLICATE_IP_COLLISION_REASON,
} from "../../src/services/duplicateIpConflictService.js";

const d = dbDescribe;
const HOST_PREFIX = "dupipclear-test-";
// TEST-NET-2 — never a real fleet address.
const IP = "198.51.100.40";
const NEW_IP = "198.51.100.77";

async function wipe() {
  await prisma.conflict.deleteMany({
    where: { asset: { hostname: { startsWith: HOST_PREFIX } } },
  });
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
  try { await prisma.$disconnect(); } catch { /* noop */ }
});

beforeEach(async () => {
  if (!dbReachable) return;
  await wipe();
});

/** An access point and an endpoint both discovered on IP, plus the card. */
async function raiseConflict(): Promise<{ apId: string; endpointId: string; conflictId: string }> {
  const ap = await prisma.asset.create({
    data: {
      hostname: `${HOST_PREFIX}ap`,
      assetType: "access_point",
      status: "active",
      ipAddress: IP,
      ipSource: "fortigate",
      lastSeen: new Date(),
      macAddress: "02:00:00:00:40:01",
    },
  });
  const endpoint = await prisma.asset.create({
    data: {
      hostname: `${HOST_PREFIX}endpoint`,
      assetType: "other",
      status: "active",
      ipAddress: IP,
      ipSource: "fortigate",
      lastSeen: new Date(),
      macAddress: "02:00:00:00:40:02",
    },
  });
  await reconcileDuplicateIpForAddresses([IP]);
  const conflict = await prisma.conflict.findFirst({
    where: {
      status: "pending",
      entityType: "asset",
      proposedAssetFields: { path: ["collisionReason"], equals: DUPLICATE_IP_COLLISION_REASON },
      asset: { hostname: { startsWith: HOST_PREFIX } },
    },
  });
  expect(conflict).toBeTruthy();
  return { apId: ap.id, endpointId: endpoint.id, conflictId: conflict!.id };
}

async function clearEndpoint(conflictId: string, endpointId: string) {
  const { agent, csrf } = await authedAgent(app);
  return agent
    .post(`/api/v1/conflicts/${conflictId}/clear-ip`)
    .set("X-CSRF-Token", csrf)
    .send({ assetId: endpointId });
}

d("duplicate-IP Clear verb (rule 40(j))", () => {
  it("blanks the member's address, remembers it, and closes the conflict", async () => {
    const { endpointId, conflictId } = await raiseConflict();
    const res = await clearEndpoint(conflictId, endpointId);
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(true);

    const row = await prisma.asset.findUnique({ where: { id: endpointId } });
    expect(row?.ipAddress).toBeNull();
    expect(row?.ipOverride).toBeNull();
    expect(row?.ipCleared).toBe(IP);

    const conflict = await prisma.conflict.findUnique({ where: { id: conflictId } });
    expect(conflict?.status).toBe("accepted");
  });

  it("refuses an asset that is not on the card", async () => {
    const { apId, conflictId } = await raiseConflict();
    const stranger = await prisma.asset.create({
      data: { hostname: `${HOST_PREFIX}stranger`, assetType: "other", status: "active" },
    });
    const res = await clearEndpoint(conflictId, stranger.id);
    expect(res.status).toBe(400);
    const ap = await prisma.asset.findUnique({ where: { id: apId } });
    expect(ap?.ipAddress).toBe(IP);
  });

  it("holds the blanked address off while the other device still records it", async () => {
    const { endpointId, conflictId } = await raiseConflict();
    await clearEndpoint(conflictId, endpointId);

    // The stale lease, re-reported by discovery.
    await prisma.asset.update({
      where: { id: endpointId },
      data: { ipAddress: IP, ipSource: "fortigate", lastSeen: new Date() },
    });
    const row = await prisma.asset.findUnique({ where: { id: endpointId } });
    expect(row?.ipAddress).toBeNull();
    expect(row?.ipCleared).toBe(IP);
  });

  it("fills the blank with a different discovered address and releases the hold", async () => {
    const { endpointId, conflictId } = await raiseConflict();
    await clearEndpoint(conflictId, endpointId);

    await prisma.asset.update({
      where: { id: endpointId },
      data: { ipAddress: NEW_IP, ipSource: "fortigate" },
    });
    const row = await prisma.asset.findUnique({ where: { id: endpointId } });
    expect(row?.ipAddress).toBe(NEW_IP);
    expect(row?.ipSource).toBe("fortigate");
    expect(row?.ipCleared).toBeNull();
  });

  it("lets the blanked address back once nothing else holds it", async () => {
    const { apId, endpointId, conflictId } = await raiseConflict();
    await clearEndpoint(conflictId, endpointId);
    await prisma.asset.update({ where: { id: apId }, data: { status: "decommissioned", monitored: false } });

    await prisma.asset.update({
      where: { id: endpointId },
      data: { ipAddress: IP, ipSource: "fortigate" },
    });
    const row = await prisma.asset.findUnique({ where: { id: endpointId } });
    expect(row?.ipAddress).toBe(IP);
    expect(row?.ipCleared).toBeNull();
  });

  it("an asset-form save with the blank IP field does not put the contested address back", async () => {
    const { endpointId, conflictId } = await raiseConflict();
    await clearEndpoint(conflictId, endpointId);

    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .put(`/api/v1/assets/${endpointId}`)
      .set("X-CSRF-Token", csrf)
      .send({ ipAddress: "", notes: "edited while offline" });
    expect(res.status).toBe(200);

    const row = await prisma.asset.findUnique({ where: { id: endpointId } });
    expect(row?.ipAddress).toBeNull();
    expect(row?.ipCleared).toBe(IP);
    expect(row?.notes).toBe("edited while offline");
  });

  it("an operator typing an address on the form ends the hold", async () => {
    const { endpointId, conflictId } = await raiseConflict();
    await clearEndpoint(conflictId, endpointId);

    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .put(`/api/v1/assets/${endpointId}`)
      .set("X-CSRF-Token", csrf)
      .send({ ipAddress: NEW_IP });
    expect(res.status).toBe(200);

    const row = await prisma.asset.findUnique({ where: { id: endpointId } });
    expect(row?.ipAddress).toBe(NEW_IP);
    expect(row?.ipCleared).toBeNull();
  });
});

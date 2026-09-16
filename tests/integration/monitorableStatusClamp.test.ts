/**
 * tests/integration/monitorableStatusClamp.test.ts
 *
 * "storage / decommissioned / disabled / quarantined assets cannot be
 * monitor-enabled" (business rule 10, widened 2026-08).
 *
 * Needs a real DB because the enforcement lives in the Prisma extension
 * (src/db.ts) rather than in a service: the point of putting it there is that
 * EVERY write path inherits it, and only an actual query exercises the two
 * halves —
 *   - clampMonitoredForStatus: the write stages an unmonitorable `status`.
 *   - enforceMonitorableStatus: the write stages `monitored: true` and NO
 *     status, so the guard has to read the row it is about to update. This is
 *     the shape of the operator toggle and the discovery monitored-sweep, and
 *     it is the half that did not exist pre-cutover.
 *
 * The route layer's explicit 409 (assertMonitorableStatus) is covered too —
 * the clamp is the backstop, but an operator who ticks the box deserves a
 * reason rather than a form that silently comes back unticked.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import { UNMONITORABLE_STATUSES } from "../../src/utils/assetInvariants.js";

const d = dbDescribe;

const HOST = "monitorable-clamp-test";

async function seedAsset(extra: Record<string, unknown> = {}): Promise<string> {
  const asset = await prisma.asset.create({
    data: {
      hostname: HOST,
      assetType: "server",
      status: "active",
      monitored: true,
      ...extra,
    } as never,
  });
  return asset.id;
}

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
});

d("clampMonitoredForStatus — the write stages the status", () => {
  for (const status of UNMONITORABLE_STATUSES) {
    it(`turns monitoring off when a monitored asset moves to ${status}`, async () => {
      const id = await seedAsset({ consecutiveFailures: 4 });
      await prisma.asset.update({ where: { id }, data: { status } as never });
      const row = await prisma.asset.findUnique({
        where: { id },
        select: { monitored: true, consecutiveFailures: true },
      });
      expect(row?.monitored).toBe(false);
      // The failure counter is reset with it: it counts missed polls, and
      // nothing is polling this asset any more.
      expect(row?.consecutiveFailures).toBe(0);
    });
  }

  it("leaves monitoring alone for maintenance — the window pauses polling, not intent", async () => {
    const id = await seedAsset();
    await prisma.asset.update({ where: { id }, data: { status: "maintenance" } as never });
    const row = await prisma.asset.findUnique({ where: { id }, select: { monitored: true } });
    expect(row?.monitored).toBe(true);
  });
});

d("enforceMonitorableStatus — the write stages monitored:true with no status", () => {
  for (const status of UNMONITORABLE_STATUSES) {
    it(`refuses to re-enable monitoring on a ${status} asset`, async () => {
      const id = await seedAsset({ status, monitored: false });
      await prisma.asset.update({ where: { id }, data: { monitored: true } as never });
      const row = await prisma.asset.findUnique({ where: { id }, select: { monitored: true } });
      expect(row?.monitored).toBe(false);
    });
  }

  it("allows it when the SAME write moves the status back to something monitorable", async () => {
    const id = await seedAsset({ status: "storage", monitored: false });
    await prisma.asset.update({
      where: { id },
      data: { status: "active", monitored: true } as never,
    });
    const row = await prisma.asset.findUnique({ where: { id }, select: { monitored: true } });
    expect(row?.monitored).toBe(true);
  });

  it("excludes unmonitorable rows from a bulk updateMany instead of rewriting them", async () => {
    const live = await seedAsset({ hostname: `${HOST}-live`, status: "active", monitored: false });
    const shelved = await seedAsset({ hostname: `${HOST}-shelved`, status: "storage", monitored: false });
    await prisma.asset.updateMany({
      where: { id: { in: [live, shelved] } },
      data: { monitored: true } as never,
    });
    const rows = await prisma.asset.findMany({
      where: { id: { in: [live, shelved] } },
      select: { id: true, monitored: true },
    });
    expect(rows.find((r) => r.id === live)?.monitored).toBe(true);
    expect(rows.find((r) => r.id === shelved)?.monitored).toBe(false);
  });
});

d("the operator write paths say WHY rather than silently clamping", () => {
  it("PUT /assets/:id refuses monitored:true on a storage asset", async () => {
    const id = await seedAsset({ status: "storage", monitored: false });
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .put(`/api/v1/assets/${id}`)
      .set("X-CSRF-Token", csrf)
      .send({ monitored: true });
    expect(res.status).toBe(409);
    expect(String(res.body?.error || res.text)).toMatch(/cannot be monitored/i);
  });

  it("PUT /assets/:id accepts it when the same save also fixes the status", async () => {
    const id = await seedAsset({ status: "storage", monitored: false });
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .put(`/api/v1/assets/${id}`)
      .set("X-CSRF-Token", csrf)
      .send({ status: "active", monitored: true });
    expect(res.status).toBe(200);
    expect(res.body.monitored).toBe(true);
  });

  it("POST /assets/bulk-monitor reports the skipped rows per id", async () => {
    const live = await seedAsset({ hostname: `${HOST}-live`, status: "active", monitored: false });
    const quarantined = await seedAsset({ hostname: `${HOST}-q`, status: "quarantined", monitored: false });
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .post("/api/v1/assets/bulk-monitor")
      .set("X-CSRF-Token", csrf)
      .send({ ids: [live, quarantined], monitored: true });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].id).toBe(quarantined);
    expect(String(res.body.errors[0].error)).toMatch(/cannot be monitored/i);
  });

  // The batch carries ONE credential id for every asset in it, so this guard is
  // a single query regardless of selection size. Without it the id reached
  // Postgres as an FK violation on the updateMany and the whole batch came back
  // as a bare 500.
  it("POST /assets/bulk-monitor 400s a credential id that names no credential", async () => {
    const live = await seedAsset({ hostname: `${HOST}-cred`, status: "active", monitored: false });
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .post("/api/v1/assets/bulk-monitor")
      .set("X-CSRF-Token", csrf)
      .send({
        ids: [live],
        monitored: true,
        monitorCredentialId: "00000000-0000-0000-0000-000000000002",
      });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/not found/i);
    // Nothing was written — the guard runs before the updateMany.
    const row = await prisma.asset.findUnique({ where: { id: live } });
    expect(row?.monitored).toBe(false);
  });
});

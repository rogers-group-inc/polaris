/**
 * tests/integration/floorNumbers.test.ts — floors are numbers (business rule 168).
 *
 *   - an asset save refuses a NEW text floor (f:Surface) but keeps an old one
 *     the edit didn't touch, so editing anything else on such a device saves;
 *   - a region-tree floor is a number plus an optional name, one number per
 *     building; an old text floor resolves through it and is listed under
 *     Devices to check with the number to use.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "floornum-test";
let fgId = "";
let swId = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  fgId = (await prisma.asset.create({ data: { hostname: `${PFX}-fg`, assetType: "firewall", status: "active", serialNumber: `${PFX}-FGSN` } })).id;
  swId = (await prisma.asset.create({
    data: { hostname: `${PFX}-sw`, assetType: "switch", status: "active", description: "Core b:Hoist f:Surface",
      fortinetTopology: { controllerSerial: `${PFX}-FGSN` } },
  })).id;
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.regionNode.deleteMany({ where: { siteId: fgId } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
});

d("floors are numbers (rule 168)", () => {
  it("an asset save refuses a new text floor and keeps an old one", async () => {
    const { agent, csrf } = await authedAgent(app);
    const keep = await agent.put(`/api/v1/assets/${swId}`).set("X-CSRF-Token", csrf).send({ description: "Uplink b:Hoist f:Surface" });
    expect(keep.status).toBe(200);
    const bad = await agent.put(`/api/v1/assets/${swId}`).set("X-CSRF-Token", csrf).send({ description: "Uplink b:Hoist f:Roof" });
    expect(bad.status).toBe(400);
    const ok = await agent.put(`/api/v1/assets/${swId}`).set("X-CSRF-Token", csrf).send({ description: "Uplink b:Hoist f:-1" });
    expect(ok.status).toBe(200);
    await prisma.asset.update({ where: { id: swId }, data: { description: "Core b:Hoist f:Surface" } });
  });

  it("a floor is a number plus a name; a text floor resolves to it and is listed to fix", async () => {
    const { agent, csrf } = await authedAgent(app);
    const b = await agent.post(`/api/v1/map/sites/${fgId}/regions`).set("X-CSRF-Token", csrf).send({ kind: "building", name: "Hoist" });
    expect(b.status).toBe(201);
    const noNumber = await agent.post(`/api/v1/map/sites/${fgId}/regions`).set("X-CSRF-Token", csrf)
      .send({ kind: "floor", name: "Surface", parentId: b.body.node.id });
    expect(noNumber.status).toBe(400);
    const f = await agent.post(`/api/v1/map/sites/${fgId}/regions`).set("X-CSRF-Token", csrf)
      .send({ kind: "floor", name: "Surface", level: 1, parentId: b.body.node.id });
    expect(f.status).toBe(201);
    expect(f.body.node).toMatchObject({ name: "Surface", level: 1 });
    const twin = await agent.post(`/api/v1/map/sites/${fgId}/regions`).set("X-CSRF-Token", csrf)
      .send({ kind: "floor", level: 1, parentId: b.body.node.id });
    expect(twin.status).toBe(409);
    const basement = await agent.post(`/api/v1/map/sites/${fgId}/regions`).set("X-CSRF-Token", csrf)
      .send({ kind: "floor", level: -1, parentId: b.body.node.id });
    expect(basement.body.node).toMatchObject({ name: "-1", level: -1 });

    const topo = (await agent.get(`/api/v1/map/sites/${fgId}/topology`)).body;
    const sw = topo.switches.find((s: { id: string }) => s.id === swId);
    expect(sw.location).toMatchObject({ building: "Hoist", floor: "1" });
    const listed = topo.regionConflicts.find((c: { id: string }) => c.id === swId);
    expect(listed).toMatchObject({ status: "textFloor", floorNumber: "1" });
  });
});

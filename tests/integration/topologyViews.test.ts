/**
 * tests/integration/topologyViews.test.ts
 *
 * Saved Device Map topology views (business rules 147-149):
 *   - GET /map/sites/:id/topology embeds `views` (the default materialised on
 *     first read), every node's `assetType`, and the site-wide `endpoints`;
 *   - view CRUD, gated deviceMap=write (a read-only caller is refused);
 *   - a mode change resets the view: layouts, image, polygons, racks gone;
 *   - background upload (PNG/JPEG/WebP only) and the authenticated GET;
 *   - the location-code commit (assets=write, per-asset results, Event).
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser, waitForEventCount } from "./_helpers.js";

const d = dbDescribe;
const PFX = "topoviews-test";
const PASSWORD = "topoviews-password-not-real";

let fgId = "";
let swId = "";
let epId = "";

/** A minimal valid PNG header (IHDR 64 x 48) — enough for magic + size sniffing. */
function tinyPng(): Buffer {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(64, 16);
  b.writeUInt32BE(48, 20);
  return b;
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  const fg = await prisma.asset.create({
    data: { hostname: `${PFX}-fg`, assetType: "firewall", status: "active", serialNumber: `${PFX}-FGSN` },
  });
  fgId = fg.id;
  const sw = await prisma.asset.create({
    data: {
      hostname: `${PFX}-sw1`,
      assetType: "switch",
      status: "active",
      description: "Core b:Old",
      fortinetTopology: { controllerSerial: `${PFX}-FGSN` },
    },
  });
  swId = sw.id;
  const ep = await prisma.asset.create({
    data: {
      hostname: `${PFX}-srv1`,
      assetType: "server",
      status: "active",
      lastSeenSwitch: `${PFX}-sw1/port7`,
      lastSeen: new Date(),
      description: "r:MCC",
    },
  });
  epId = ep.id;

  const roMatrix: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) roMatrix[key] = "read";
  const roRole = await prisma.role.create({ data: { name: `${PFX}-role-ro`, permissions: roMatrix } });
  await prisma.user.create({
    data: { username: `${PFX}-user-ro`, passwordHash: await hashPassword(PASSWORD), roleId: roRole.id, authProvider: "local" },
  });
});

async function loginAs(username: string): Promise<{ agent: request.Agent; csrf: string }> {
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const login = await agent.post("/api/v1/auth/login").send({ username, password: PASSWORD }).set("Content-Type", "application/json");
  expect(login.status).toBe(200);
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  return { agent, csrf };
}

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.user.deleteMany({ where: { username: { startsWith: `${PFX}-user` } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: `${PFX}-role-` } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.$disconnect();
});

d("topology views", () => {
  it("the topology GET embeds a materialised default view, assetType on nodes, and site endpoints", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/map/sites/${fgId}/topology`);
    expect(res.status).toBe(200);
    expect(res.body.views).toHaveLength(1);
    expect(res.body.views[0]).toMatchObject({ isDefault: true, mode: "layer2", layoutPrefix: "" });
    expect(res.body.views[0].shownTypes).toEqual(["firewall", "router", "switch", "access_point"]);
    expect(res.body.fortigate.assetType).toBe("firewall");
    expect(res.body.switches[0].assetType).toBe("switch");
    expect(res.body.endpointsTruncated).toBe(false);
    const ep = res.body.endpoints.find((e: any) => e.id === epId);
    expect(ep).toMatchObject({ assetType: "server", switchId: swId, port: "port7" });
    expect(ep.location.room).toBe("MCC");

    // A second read does not create a second default.
    const again = await agent.get(`/api/v1/map/sites/${fgId}/topology/views`);
    expect(again.body.filter((v: any) => v.isDefault)).toHaveLength(1);
  });

  it("creates a rack view seeded with one 42U rack; refuses a duplicate name and a read-only caller", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post(`/api/v1/map/sites/${fgId}/topology/views`).set("X-CSRF-Token", csrf)
      .send({ name: "MDF racks", mode: "rack" });
    expect(res.status).toBe(201);
    expect(res.body.racks).toHaveLength(1);
    expect(res.body.racks[0].units).toBe(42);
    expect(res.body.layoutPrefix).toBe(`v:${res.body.id}`);
    expect(await waitForEventCount("map.topology.view_created", 1, fgId)).toBeGreaterThanOrEqual(1);

    const dup = await agent.post(`/api/v1/map/sites/${fgId}/topology/views`).set("X-CSRF-Token", csrf)
      .send({ name: "MDF racks", mode: "layer2" });
    expect(dup.status).toBe(409);

    const ro = await loginAs(`${PFX}-user-ro`);
    const denied = await ro.agent.post(`/api/v1/map/sites/${fgId}/topology/views`).set("X-CSRF-Token", ro.csrf)
      .send({ name: "Nope", mode: "layer2" });
    expect(denied.status).toBe(403);
  });

  it("saves rack placements and rejects an overlap", async () => {
    const { agent, csrf } = await authedAgent(app);
    const views = (await agent.get(`/api/v1/map/sites/${fgId}/topology/views`)).body;
    const rack = views.find((v: any) => v.name === "MDF racks");
    const rackId = rack.racks[0].id;
    const ok = await agent.put(`/api/v1/map/sites/${fgId}/topology/views/${rack.id}`).set("X-CSRF-Token", csrf).send({
      rackPlacements: [
        { id: "p1", kind: "asset", assetId: swId, rackId, face: "front", startU: 40, heightU: 1 },
        { id: "cm1", kind: "cableManagement", rackId, face: "front", startU: 39, heightU: 1 },
      ],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.view.rackPlacements).toHaveLength(2);

    const overlap = await agent.put(`/api/v1/map/sites/${fgId}/topology/views/${rack.id}`).set("X-CSRF-Token", csrf).send({
      rackPlacements: [
        { id: "p1", kind: "asset", assetId: swId, rackId, face: "front", startU: 40, heightU: 2 },
        { id: "cm1", kind: "cableManagement", rackId, face: "front", startU: 41, heightU: 1 },
      ],
    });
    expect(overlap.status).toBe(400);

    // Shrinking the rack below an occupied U is refused.
    const shrink = await agent.put(`/api/v1/map/sites/${fgId}/topology/views/${rack.id}`).set("X-CSRF-Token", csrf)
      .send({ racks: [{ ...rack.racks[0], units: 24 }] });
    expect(shrink.status).toBe(400);
  });

  it("uploads a background, saves it on the view, and serves it to an authenticated reader", async () => {
    const { agent, csrf } = await authedAgent(app);
    const created = await agent.post(`/api/v1/map/sites/${fgId}/topology/views`).set("X-CSRF-Token", csrf)
      .send({ name: "Plant floor", mode: "topology" });
    const viewId = created.body.id;

    const notImage = await agent.post(`/api/v1/map/sites/${fgId}/topology/views/${viewId}/background`)
      .set("X-CSRF-Token", csrf).attach("file", Buffer.from("not an image"), "x.png");
    expect(notImage.status).toBe(400);

    const up = await agent.post(`/api/v1/map/sites/${fgId}/topology/views/${viewId}/background`)
      .set("X-CSRF-Token", csrf).attach("file", tinyPng(), "plan.png");
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ width: 64, height: 48, mimeType: "image/png" });

    const saved = await agent.put(`/api/v1/map/sites/${fgId}/topology/views/${viewId}`).set("X-CSRF-Token", csrf).send({
      background: { kind: "image", imageId: up.body.id },
      polygons: [{ id: "poly1", codes: { building: "Plant", floor: "1" }, points: [[0, 0], [30, 0], [30, 20]] }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.view.background).toEqual({ kind: "image", imageId: up.body.id, width: 64, height: 48 });

    const img = await agent.get(`/api/v1/map/sites/${fgId}/topology/background/${up.body.id}`);
    expect(img.status).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.headers["cache-control"]).toMatch(/private/);

    const anon = await request(app).get(`/api/v1/map/sites/${fgId}/topology/background/${up.body.id}`);
    expect(anon.status).toBe(401);
  });

  it("a mode change resets the view: layouts, image, polygons gone, racks seeded, Event written", async () => {
    const { agent, csrf } = await authedAgent(app);
    const views = (await agent.get(`/api/v1/map/sites/${fgId}/topology/views`)).body;
    const view = views.find((v: any) => v.name === "Plant floor");
    const put = await agent.put(`/api/v1/map/sites/${fgId}/topology/layout`).set("X-CSRF-Token", csrf)
      .send({ view: `v:${view.id}|topo`, positions: { [swId]: { x: 10, y: 10 } } });
    expect(put.status).toBe(200);

    const loss = await agent.get(`/api/v1/map/sites/${fgId}/topology/views/${view.id}/mode-change`);
    expect(loss.body).toMatchObject({ mode: "topology", placedDevices: 1, polygons: 1, hasImage: true });

    const changed = await agent.put(`/api/v1/map/sites/${fgId}/topology/views/${view.id}`).set("X-CSRF-Token", csrf)
      .send({ mode: "rack", polygons: [] });
    expect(changed.status).toBe(200);
    expect(changed.body.modeChange).toMatchObject({ from: "topology", to: "rack", layoutsCleared: 1, polygonsCleared: 1, imagesCleared: 1 });
    expect(changed.body.view).toMatchObject({ mode: "rack", background: null, polygons: [] });
    expect(changed.body.view.racks).toHaveLength(1);
    expect(await prisma.topologyLayout.count({ where: { siteId: fgId, view: `v:${view.id}|topo` } })).toBe(0);
    expect(await prisma.topologyBackgroundImage.count({ where: { viewId: view.id } })).toBe(0);
    expect(await waitForEventCount("map.topology.view_mode_changed", 1, fgId)).toBeGreaterThanOrEqual(1);
  });

  it("refuses to delete the default view; deleting another drops its layouts", async () => {
    const { agent, csrf } = await authedAgent(app);
    const views = (await agent.get(`/api/v1/map/sites/${fgId}/topology/views`)).body;
    const def = views.find((v: any) => v.isDefault);
    expect((await agent.delete(`/api/v1/map/sites/${fgId}/topology/views/${def.id}`).set("X-CSRF-Token", csrf)).status).toBe(400);

    const rack = views.find((v: any) => v.name === "MDF racks");
    await agent.put(`/api/v1/map/sites/${fgId}/topology/layout`).set("X-CSRF-Token", csrf)
      .send({ view: `v:${rack.id}`, positions: { [swId]: { x: 1, y: 2 } } });
    const del = await agent.delete(`/api/v1/map/sites/${fgId}/topology/views/${rack.id}`).set("X-CSRF-Token", csrf);
    expect(del.status).toBe(204);
    expect(await prisma.topologyLayout.count({ where: { siteId: fgId, view: { startsWith: `v:${rack.id}` } } })).toBe(0);
    // The default view's legacy keys are untouched by another view's delete.
    await agent.put(`/api/v1/map/sites/${fgId}/topology/layout`).set("X-CSRF-Token", csrf)
      .send({ view: "flat", positions: { [swId]: { x: 3, y: 4 } } });
    expect(await prisma.topologyLayout.count({ where: { siteId: fgId, view: "flat" } })).toBe(1);
  });

  it("commits location codes from polygon placements with per-asset results", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post(`/api/v1/map/sites/${fgId}/topology/location-codes`).set("X-CSRF-Token", csrf).send({
      changes: [
        { assetId: swId, codes: { building: "Plant", floor: "1" } },
        { assetId: "99999999-9999-4999-8999-999999999999", codes: { building: "Plant" } },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toEqual({ assetId: swId, status: "updated", description: "Core b:Plant f:1" });
    expect(res.body.results[1].status).toBe("refused");
    const sw = await prisma.asset.findUnique({ where: { id: swId }, select: { description: true } });
    expect(sw?.description).toBe("Core b:Plant f:1");
    expect(await waitForEventCount("asset.updated", 1, swId)).toBeGreaterThanOrEqual(1);

    // The same codes again change nothing.
    const again = await agent.post(`/api/v1/map/sites/${fgId}/topology/location-codes`).set("X-CSRF-Token", csrf)
      .send({ changes: [{ assetId: swId, codes: { building: "Plant", floor: "1" } }] });
    expect(again.body.results[0].status).toBe("unchanged");

    // Read-only callers lack assets=write.
    const ro = await loginAs(`${PFX}-user-ro`);
    const denied = await ro.agent.post(`/api/v1/map/sites/${fgId}/topology/location-codes`).set("X-CSRF-Token", ro.csrf)
      .send({ changes: [{ assetId: swId, codes: { building: "X" } }] });
    expect(denied.status).toBe(403);
  });
});

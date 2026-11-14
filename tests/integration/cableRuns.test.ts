/**
 * tests/integration/cableRuns.test.ts — cable runs (business rule 184)
 * against a real database: the routes, the trench rule, the `cableRuns` key's
 * rungs and write scope, and the migration's seeding of the key.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "cableruns-test";
const PASSWORD = "cableruns-password-not-real";
let siteId = "";

const POLE = {
  name: "Yard road pole line", medium: "fiber", placement: "electric_pole",
  points: [[-85.7001, 37.9801], [-85.7002, 37.9811], [-85.7015, 37.9812]], notes: "joint-use poles",
};

async function makeUser(suffix: string, perms: Record<string, string>): Promise<void> {
  const matrix: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) matrix[key] = "none";
  Object.assign(matrix, perms);
  const role = await prisma.role.create({ data: { name: `${PFX}-role-${suffix}`, permissions: matrix } });
  await prisma.user.create({
    data: { username: `${PFX}-user-${suffix}`, passwordHash: await hashPassword(PASSWORD), roleId: role.id, authProvider: "local" },
  });
}

async function loginAs(suffix: string): Promise<{ agent: request.Agent; csrf: string }> {
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const login = await agent.post("/api/v1/auth/login")
    .send({ username: `${PFX}-user-${suffix}`, password: PASSWORD }).set("Content-Type", "application/json");
  expect(login.status).toBe(200);
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  return { agent, csrf };
}

async function cleanup(): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
  await cleanup();
  const fg = await prisma.asset.create({ data: { hostname: `${PFX}-fg`, assetType: "firewall", status: "active" } });
  siteId = fg.id;
  await makeUser("maponly", { deviceMap: "fullwrite" });
  await makeUser("rw", { deviceMap: "read", cableRuns: "write" });
  await makeUser("full", { deviceMap: "read", cableRuns: "fullwrite" });
  await makeUser("ro", { deviceMap: "read", cableRuns: "read" });
});
afterAll(async () => { if (dbReachable) await cleanup(); });

d("cable runs (rule 184)", () => {
  it("draws, edits and deletes a pole run in one edit session each, with Events", async () => {
    const { agent, csrf } = await authedAgent(app);
    const created = await agent.put(`/api/v1/map/sites/${siteId}/cable-runs`).set("X-CSRF-Token", csrf).send({ upserts: [POLE] });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.runs).toHaveLength(1);
    const run = created.body.runs[0];
    expect(run).toMatchObject({ name: POLE.name, medium: "fiber", placement: "electric_pole", source: "drawn", syncStatus: "off" });
    expect(run.lengthM).toBeGreaterThan(200);

    const got = await agent.get(`/api/v1/map/sites/${siteId}/cable-runs`);
    expect(got.status).toBe(200);
    expect(got.body.canEditRuns).toBe(true);
    expect(got.body.runs.map((r: { id: string }) => r.id)).toEqual([run.id]);

    const edited = await agent.put(`/api/v1/map/sites/${siteId}/cable-runs`).set("X-CSRF-Token", csrf)
      .send({ upserts: [{ ...POLE, id: run.id, medium: "ethernet", placement: "telephone_pole", points: POLE.points.slice(0, 2) }] });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.runs[0]).toMatchObject({ medium: "ethernet", placement: "telephone_pole" });
    const row = await prisma.cableRun.findUnique({ where: { id: run.id } });
    expect(row!.version).toBe(2);
    expect(row!.syncStatus).toBe("off");

    const del = await agent.put(`/api/v1/map/sites/${siteId}/cable-runs`).set("X-CSRF-Token", csrf).send({ deletes: [run.id] });
    expect(del.status).toBe(200);
    expect(del.body.runs).toEqual([]);
    // Never sent to ArcGIS: deleted outright, no tombstone.
    expect(await prisma.cableRun.findUnique({ where: { id: run.id } })).toBeNull();

    const events = await prisma.event.findMany({ where: { resourceId: run.id }, select: { action: true } });
    expect(events.map((e) => e.action).sort()).toEqual(["cable_run.created", "cable_run.deleted", "cable_run.updated"]);
  });

  it("a run already sent to ArcGIS leaves a tombstone, and an edit sends it again", async () => {
    const { agent, csrf } = await authedAgent(app);
    const created = await agent.put(`/api/v1/map/sites/${siteId}/cable-runs`).set("X-CSRF-Token", csrf).send({ upserts: [POLE] });
    const id = created.body.runs[0].id as string;
    await prisma.cableRun.update({ where: { id }, data: { syncStatus: "synced", arcgisObjectId: 42 } });

    await agent.put(`/api/v1/map/sites/${siteId}/cable-runs`).set("X-CSRF-Token", csrf).send({ upserts: [{ ...POLE, id, name: "Renamed" }] });
    expect((await prisma.cableRun.findUnique({ where: { id } }))!.syncStatus).toBe("pending");

    const del = await agent.put(`/api/v1/map/sites/${siteId}/cable-runs`).set("X-CSRF-Token", csrf).send({ deletes: [id] });
    expect(del.body.runs).toEqual([]);
    const tomb = await prisma.cableRun.findUnique({ where: { id } });
    expect(tomb!.deletedAt).not.toBeNull();
    expect(tomb!.syncStatus).toBe("pending");
    await prisma.cableRun.delete({ where: { id } });
  });

  it("refuses a hand-drawn trench, grid coordinates, and another site's run", async () => {
    const { agent, csrf } = await authedAgent(app);
    const trench = await agent.put(`/api/v1/map/sites/${siteId}/cable-runs`).set("X-CSRF-Token", csrf)
      .send({ upserts: [{ ...POLE, placement: "trench" }] });
    expect(trench.status).toBe(400);
    expect(JSON.stringify(trench.body)).toMatch(/imported from a survey file/);

    const grid = await agent.put(`/api/v1/map/sites/${siteId}/cable-runs`).set("X-CSRF-Token", csrf)
      .send({ upserts: [{ ...POLE, points: [[1230486.35, 196527.88], [1230502.79, 196527.84]] }] });
    expect(grid.status).toBe(400);

    const other = await prisma.asset.create({ data: { hostname: `${PFX}-fg2`, assetType: "firewall", status: "active" } });
    const theirs = await prisma.cableRun.create({ data: { siteId: other.id, points: POLE.points, medium: "fiber", placement: "electric_pole" } });
    const cross = await agent.put(`/api/v1/map/sites/${siteId}/cable-runs`).set("X-CSRF-Token", csrf).send({ deletes: [theirs.id] });
    expect(cross.status).toBe(404);
    expect(await prisma.cableRun.findUnique({ where: { id: theirs.id } })).not.toBeNull();
  });

  it("is its own key: Device Map rights alone neither show nor draw runs", async () => {
    const { agent, csrf } = await loginAs("maponly");
    expect((await agent.get(`/api/v1/map/sites/${siteId}/cable-runs`)).status).toBe(403);
    expect((await agent.put(`/api/v1/map/sites/${siteId}/cable-runs`).set("X-CSRF-Token", csrf).send({ upserts: [POLE] })).status).toBe(403);
  });

  it("Read shows runs; Read-Write is limited to the caller's sites; Full Read-Write reaches any site", async () => {
    const ro = await loginAs("ro");
    const roGet = await ro.agent.get(`/api/v1/map/sites/${siteId}/cable-runs`);
    expect(roGet.status).toBe(200);
    expect(roGet.body.canEditRuns).toBe(false);
    expect((await ro.agent.put(`/api/v1/map/sites/${siteId}/cable-runs`).set("X-CSRF-Token", ro.csrf).send({ upserts: [POLE] })).status).toBe(403);

    // The site has no owner and no tags: Read-Write does not reach it.
    const rw = await loginAs("rw");
    expect((await rw.agent.get(`/api/v1/map/sites/${siteId}/cable-runs`)).body.canEditRuns).toBe(false);
    expect((await rw.agent.put(`/api/v1/map/sites/${siteId}/cable-runs`).set("X-CSRF-Token", rw.csrf).send({ upserts: [POLE] })).status).toBe(403);
    // …until the caller owns it.
    await prisma.asset.update({ where: { id: siteId }, data: { createdBy: `${PFX}-user-rw` } });
    const owned = await rw.agent.put(`/api/v1/map/sites/${siteId}/cable-runs`).set("X-CSRF-Token", rw.csrf).send({ upserts: [POLE] });
    expect(owned.status, JSON.stringify(owned.body)).toBe(200);
    await prisma.asset.update({ where: { id: siteId }, data: { createdBy: null } });

    const full = await loginAs("full");
    const anySite = await full.agent.put(`/api/v1/map/sites/${siteId}/cable-runs`).set("X-CSRF-Token", full.csrf).send({ upserts: [POLE] });
    expect(anySite.status, JSON.stringify(anySite.body)).toBe(200);
  });

  it("routes links through runs on the view gate; a deleted run leaves every link (rule 184(a))", async () => {
    const { agent, csrf } = await authedAgent(app);
    const made = await agent.put(`/api/v1/map/sites/${siteId}/cable-runs`).set("X-CSRF-Token", csrf)
      .send({ upserts: [{ ...POLE, name: "link-a" }, { ...POLE, name: "link-b" }] });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const a = made.body.runs.find((r: { name: string }) => r.name === "link-a").id;
    const b = made.body.runs.find((r: { name: string }) => r.name === "link-b").id;
    const stranger = "00000000-0000-4000-8000-000000000000";

    const set = await agent.put(`/api/v1/map/sites/${siteId}/cable-run-links`).set("X-CSRF-Token", csrf)
      .send({ links: { "lldp|sw1|sw2": [a, b, stranger], "lldp|sw2|sw3": [b] } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    // An id that is not a live run here is dropped, not an error.
    expect(set.body.links).toEqual({ "lldp|sw1|sw2": [a, b], "lldp|sw2|sw3": [b] });
    const got = await agent.get(`/api/v1/map/sites/${siteId}/cable-runs`);
    expect(got.body.links).toEqual(set.body.links);
    expect(await prisma.event.count({ where: { action: "cable_run_link.updated", resourceId: siteId } })).toBeGreaterThan(0);

    // Deleting run b takes it off both links; the one that rode only b goes straight.
    await agent.put(`/api/v1/map/sites/${siteId}/cable-runs`).set("X-CSRF-Token", csrf).send({ deletes: [b] });
    expect((await agent.get(`/api/v1/map/sites/${siteId}/cable-runs`)).body.links).toEqual({ "lldp|sw1|sw2": [a] });

    // An empty list makes a link straight again.
    const straight = await agent.put(`/api/v1/map/sites/${siteId}/cable-run-links`).set("X-CSRF-Token", csrf)
      .send({ links: { "lldp|sw1|sw2": [] } });
    expect(straight.body.links).toEqual({});
    // A malformed key is refused.
    expect((await agent.put(`/api/v1/map/sites/${siteId}/cable-run-links`).set("X-CSRF-Token", csrf)
      .send({ links: { "not-a-key": [a] } })).status).toBe(400);
  });

  it("routing links is the Device Map's write, not cableRuns'", async () => {
    // cableRuns fullwrite but Device Map read: no.
    const full = await loginAs("full");
    expect((await full.agent.put(`/api/v1/map/sites/${siteId}/cable-run-links`).set("X-CSRF-Token", full.csrf)
      .send({ links: {} })).status).toBe(403);
    // Device Map fullwrite alone: yes.
    const map = await loginAs("maponly");
    expect((await map.agent.put(`/api/v1/map/sites/${siteId}/cable-run-links`).set("X-CSRF-Token", map.csrf)
      .send({ links: {} })).status).toBe(200);
  });

  it("the migration seeded the key: admin full, readonly read, the other built-ins none", async () => {
    const roles = await prisma.role.findMany({ where: { name: { in: ["admin", "readonly", "networkadmin", "assetsadmin", "user"] } }, select: { name: true, permissions: true } });
    const level = Object.fromEntries(roles.map((r) => [r.name, (r.permissions as Record<string, string>).cableRuns]));
    expect(level).toMatchObject({ admin: "fullwrite", readonly: "read" });
    for (const n of ["networkadmin", "assetsadmin", "user"]) if (n in level) expect(level[n]).toBe("none");
  });
});

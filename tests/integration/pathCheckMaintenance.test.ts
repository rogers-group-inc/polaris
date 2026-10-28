/**
 * tests/integration/pathCheckMaintenance.test.ts — business rule 135:
 * maintenance for path checks, driven through the API an automation would use
 * (a role-bound bearer token) as well as a session.
 *
 *   - a path-check schedule is created on /maintenance-schedules with
 *     `pathCheckIds`; a now-active one pauses the check before the call returns
 *     (inline reconcile) and GET /path-checks reports it;
 *   - the pause is REAL at the two places a check runs: the definitions an agent
 *     is shipped (agentConfigChecks) and the server job's (serverCheckDefinitions)
 *     — Prisma relation filters a unit fake cannot vouch for;
 *   - ?target= narrows the list to one kind; a schedule mixing assets and checks,
 *     or naming an unknown check, is a 400;
 *   - POST /path-checks/:id/release ends it now and deletes a spent ad-hoc;
 *   - deleting a check drops it from its schedules;
 *   - gates: maintenanceManagement (a pathChecks-only token cannot schedule).
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import { createToken } from "../../src/services/apiTokenService.js";
import { createRole } from "../../src/services/roleService.js";
import { agentConfigChecks, serverCheckDefinitions, deleteCheck } from "../../src/services/pathCheckService.js";

const d = dbDescribe;
const NAME = "itest-pcmaint";
const MAINT_ROLE = `${NAME}-maint-role`;
const PATH_ONLY_ROLE = `${NAME}-path-role`;

let hostId = "";
let maintToken = "";
let pathOnlyToken = "";

async function cleanup(): Promise<void> {
  await prisma.maintenanceSchedule.deleteMany({ where: { name: { startsWith: NAME } } });
  await prisma.maintenanceSchedule.deleteMany({ where: { name: { startsWith: `Ad-hoc — ${NAME}` } } });
  await prisma.pathCheck.deleteMany({ where: { name: { startsWith: NAME } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await authedAgent(app);
  await prisma.apiToken.deleteMany({ where: { name: { in: [MAINT_ROLE, PATH_ONLY_ROLE] } } });
  await prisma.role.deleteMany({ where: { name: { in: [MAINT_ROLE, PATH_ONLY_ROLE] } } });
  await prisma.asset.deleteMany({ where: { hostname: `${NAME}-host` } });
  const host = await prisma.asset.create({
    data: { hostname: `${NAME}-host`, assetType: "server", status: "active", monitored: true } as never,
  });
  hostId = host.id;
  await prisma.managedAgent.create({
    data: {
      assetId: hostId, osPlatform: "linux", arch: "amd64", installStatus: "active", installedBy: "test",
      agentVersion: "0.23.0", serverCertFingerprint: "sha256:" + "f".repeat(64), additionalServerCertFingerprints: [],
      bearerPrefix: "pcmaint", bearerHash: "x",
    },
  });
  const maintRole = await createRole({ name: MAINT_ROLE, permissions: { maintenanceManagement: "write", pathChecks: "read" } });
  maintToken = (await createToken({ name: MAINT_ROLE, roleId: maintRole.id, createdBy: "integration-test" })).rawToken;
  const pathRole = await createRole({ name: PATH_ONLY_ROLE, permissions: { pathChecks: "write" } });
  pathOnlyToken = (await createToken({ name: PATH_ONLY_ROLE, roleId: pathRole.id, createdBy: "integration-test" })).rawToken;
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.asset.deleteMany({ where: { id: hostId } });
  await prisma.apiToken.deleteMany({ where: { name: { in: [MAINT_ROLE, PATH_ONLY_ROLE] } } });
  await prisma.role.deleteMany({ where: { name: { in: [MAINT_ROLE, PATH_ONLY_ROLE] } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});

function localIso(dt: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}`;
}
const inAnHour = () => localIso(new Date(Date.now() + 60 * 60 * 1000));
const activeOneshot = () => ({
  version: 1, kind: "oneshot",
  startAt: localIso(new Date(Date.now() - 60 * 60 * 1000)),
  endAt: inAnHour(),
});

/** An enabled check run by the seeded agent host AND the server. */
async function seedCheck(suffix: string) {
  const check = await prisma.pathCheck.create({
    data: {
      name: `${NAME}-${suffix}`, kind: "icmp", target: "10.99.0.1", runOnServer: true,
      traceroute: { enabled: false }, scope: {}, assetIds: [hostId], definitionSha256: suffix.padEnd(64, "0"),
    } as never,
  });
  await prisma.pathCheckSource.createMany({
    data: [{ checkId: check.id, assetId: hostId, explicit: true }, { checkId: check.id, assetId: null }] as never,
  });
  return check;
}

const bearer = (token: string) => ({
  get: (path: string) => request(app).get("/api/v1" + path).set("Authorization", `Bearer ${token}`),
  post: (path: string, body?: object) => request(app).post("/api/v1" + path).set("Authorization", `Bearer ${token}`).send(body ?? {}),
});

d("path-check maintenance over the API (business rule 135)", () => {
  it("a now-active schedule pauses the check on its agents and the server before the call returns", async () => {
    const check = await seedCheck("a");
    expect((await agentConfigChecks(hostId, "0.23.0")).map((c) => c.id)).toContain(check.id);
    expect((await serverCheckDefinitions()).map((c) => c.id)).toContain(check.id);

    const res = await bearer(maintToken).post("/maintenance-schedules", {
      name: `${NAME} patch window`, pathCheckIds: [check.id], schedule: activeOneshot(),
    });
    expect(res.status).toBe(201);
    expect(res.body.schedule.pathCheckIds).toEqual([check.id]);

    expect((await agentConfigChecks(hostId, "0.23.0")).map((c) => c.id)).not.toContain(check.id);
    expect((await serverCheckDefinitions()).map((c) => c.id)).not.toContain(check.id);

    const list = await bearer(maintToken).get("/path-checks");
    const row = list.body.checks.find((c: any) => c.id === check.id);
    expect(row.maintenance).toMatchObject({ inMaintenance: true, windows: [expect.objectContaining({ scheduleName: `${NAME} patch window` })] });
    expect(row.maintenance.windows[0].until).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

    const info = await bearer(maintToken).get(`/maintenance-schedules/path-checks/${check.id}`);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ inMaintenance: true, schedules: [expect.objectContaining({ activeNow: true, kind: "oneshot" })] });

    expect(await prisma.event.count({ where: { action: "path_check.maintenance_entered", resourceId: check.id } })).toBe(1);
  });

  it("?target narrows the list to one kind", async () => {
    const check = await seedCheck("b");
    await bearer(maintToken).post("/maintenance-schedules", { name: `${NAME} later`, pathCheckIds: [check.id], schedule: activeOneshot() });
    const pathList = await bearer(maintToken).get("/maintenance-schedules?target=pathChecks");
    const assetList = await bearer(maintToken).get("/maintenance-schedules?target=assets");
    expect(pathList.body.schedules.map((s: any) => s.name)).toContain(`${NAME} later`);
    expect(assetList.body.schedules.map((s: any) => s.name)).not.toContain(`${NAME} later`);
    expect((await bearer(maintToken).get("/maintenance-schedules?target=nope")).status).toBe(400);
  });

  it("refuses a schedule mixing assets and path checks, and an unknown check id", async () => {
    const check = await seedCheck("c");
    const mixed = await bearer(maintToken).post("/maintenance-schedules", {
      name: `${NAME} mixed`, assetIds: [hostId], pathCheckIds: [check.id], schedule: activeOneshot(),
    });
    expect(mixed.status).toBe(400);
    expect(mixed.body.error).toMatch(/not both/);
    const unknown = await bearer(maintToken).post("/maintenance-schedules", {
      name: `${NAME} typo`, pathCheckIds: ["00000000-0000-0000-0000-000000000000"], schedule: activeOneshot(),
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/Unknown path check/);
  });

  it("release ends an ad-hoc window now, deletes the spent schedule, and resumes the check", async () => {
    const check = await seedCheck("d");
    const created = await bearer(maintToken).post("/maintenance-schedules", {
      name: `Ad-hoc — ${NAME}-d`, pathCheckIds: [check.id],
      schedule: { version: 1, kind: "oneshot", startNow: true, endAt: inAnHour() },
    });
    expect(created.status).toBe(201);
    expect((await agentConfigChecks(hostId, "0.23.0")).map((c) => c.id)).not.toContain(check.id);

    const rel = await bearer(maintToken).post(`/maintenance-schedules/path-checks/${check.id}/release`);
    expect(rel.status).toBe(200);
    expect(rel.body).toEqual({ released: true });
    expect(await prisma.maintenanceSchedule.findUnique({ where: { id: created.body.schedule.id } })).toBeNull();
    expect(await prisma.pathCheckMaintenanceWindow.findFirst({ where: { pathCheckId: check.id } })).toMatchObject({ endReason: "operator" });
    expect((await agentConfigChecks(hostId, "0.23.0")).map((c) => c.id)).toContain(check.id);

    const again = await bearer(maintToken).post(`/maintenance-schedules/path-checks/${check.id}/release`);
    expect(again.body).toEqual({ released: false });
  });

  it("deleting a check drops it from its schedules, and deletes one left naming none", async () => {
    const a = await seedCheck("e1");
    const b = await seedCheck("e2");
    const both = await bearer(maintToken).post("/maintenance-schedules", { name: `${NAME} both`, pathCheckIds: [a.id, b.id], schedule: activeOneshot() });
    const only = await bearer(maintToken).post("/maintenance-schedules", { name: `${NAME} only`, pathCheckIds: [a.id], schedule: activeOneshot() });

    await deleteCheck(a.id, "integration-test");

    expect((await prisma.maintenanceSchedule.findUnique({ where: { id: both.body.schedule.id } }))?.pathCheckIds).toEqual([b.id]);
    expect(await prisma.maintenanceSchedule.findUnique({ where: { id: only.body.schedule.id } })).toBeNull();
  });

  it("is gated on maintenanceManagement — a pathChecks:write token can neither schedule nor release", async () => {
    const check = await seedCheck("f");
    const post = await bearer(pathOnlyToken).post("/maintenance-schedules", {
      name: `${NAME} denied`, pathCheckIds: [check.id], schedule: activeOneshot(),
    });
    expect(post.status).toBe(403);
    expect((await bearer(pathOnlyToken).post(`/maintenance-schedules/path-checks/${check.id}/release`)).status).toBe(403);
    expect((await bearer(pathOnlyToken).get(`/maintenance-schedules/path-checks/${check.id}`)).status).toBe(403);
  });
});

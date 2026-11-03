/**
 * tests/integration/savedDashboards.test.ts
 *
 * The /api/v1/saved-dashboards surface (Dashboard page → Dashboards ▾) and its
 * SECOND mount on the Dash wallboard listener:
 *   - create a private dashboard, list it back, layout round-trips
 *   - a SECOND user sees public ones but never someone else's private one
 *   - publishing needs savedDashboards:write — a readonly caller may keep a
 *     private dashboard but is 403 on a public one
 *   - re-saving the same name overwrites instead of duplicating
 *   - GET /:id answers 404 (not 403) for a dashboard the caller can't see
 *   - edit/delete are owner-only; an admin may delete someone else's
 *   - a malformed layout is rejected
 *   - the WALLBOARD mount lists PUBLIC rows only with no session, and every
 *     write verb 405s there
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { buildDashApp } from "../../src/dash/dashServer.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import type { DashSettings } from "../../src/services/dashSettingsService.js";
import type { DashRoleIdentity } from "../../src/services/dashRoleSnapshotService.js";

const d = dbDescribe;

const RO_USERNAME = "polaris-sd-readonly";
const RO_PASSWORD = "test-password-do-not-use-in-prod";

let admin: { agent: ReturnType<typeof request.agent>; csrf: string };
let readonly: { agent: ReturnType<typeof request.agent>; csrf: string };

const UUID_COL = "aaaaaaaa-0000-4000-8000-000000000001";
const UUID_W1 = "aaaaaaaa-0000-4000-8000-000000000002";

const LAYOUT = {
  columns: [
    { id: UUID_COL, width: 6, widgets: [{ id: UUID_W1, type: "statusSummary", height: 1, config: { range: "24h" } }] },
  ],
};

// The wallboard answers as the built-in readonly role — savedDashboards:read is
// what lets it load a published dashboard at all.
const READONLY_IDENTITY: DashRoleIdentity = {
  snapshot: {
    id: "role-readonly-id",
    name: "readonly",
    isProtected: true,
    permissions: { assets: "read", deviceMap: "read", savedDashboards: "read" },
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  regionTags: [],
};

function dashApp() {
  const settings: DashSettings = { enabled: true, ipScope: "rfc1918", allowedCidrs: [] };
  return buildDashApp({
    settingsProvider: async () => settings,
    identityProvider: async () => READONLY_IDENTITY,
  });
}

async function loginReadonly() {
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const resp = await agent
    .post("/api/v1/auth/login")
    .send({ username: RO_USERNAME, password: RO_PASSWORD })
    .set("Content-Type", "application/json");
  if (resp.status !== 200) throw new Error(`readonly login failed (${resp.status})`);
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  return { agent, csrf };
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  admin = await authedAgent(app);

  const roRole = await prisma.role.findUnique({ where: { name: "readonly" } });
  if (!roRole) throw new Error("built-in 'readonly' Role missing — run prisma migrate deploy on the test DB");
  await prisma.user.upsert({
    where:  { username: RO_USERNAME },
    update: { roleId: roRole.id },
    create: {
      username:     RO_USERNAME,
      passwordHash: await hashPassword(RO_PASSWORD),
      roleId:       roRole.id,
      authProvider: "local",
    },
  });
  readonly = await loginReadonly();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.savedDashboard.deleteMany();
  await prisma.user.deleteMany({ where: { username: RO_USERNAME } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.savedDashboard.deleteMany();
});

function post(who: typeof admin, body: unknown) {
  return who.agent.post("/api/v1/saved-dashboards").set("X-CSRF-Token", who.csrf).send(body as object);
}

d("saved dashboards — create + list", () => {
  it("round-trips a private dashboard for its owner", async () => {
    const created = await post(admin, { name: "  NOC   overview ", visibility: "private", layout: LAYOUT });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe("NOC overview");     // whitespace normalized on write
    expect(created.body.isOwner).toBe(true);
    expect(created.body.widgetCount).toBe(1);
    expect(created.body.layout).toEqual(LAYOUT);

    const list = await admin.agent.get("/api/v1/saved-dashboards");
    expect(list.status).toBe(200);
    expect(list.body.dashboards).toHaveLength(1);
    expect(list.body.dashboards[0].visibility).toBe("private");
  });

  it("re-saving the same name overwrites rather than duplicating", async () => {
    const first = await post(admin, { name: "Dupe", visibility: "private", layout: LAYOUT });
    const second = await post(admin, { name: "Dupe", visibility: "private", layout: { columns: [] } });
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.layout.columns).toEqual([]);
    expect(await prisma.savedDashboard.count()).toBe(1);
  });

  it("rejects a layout the canvas could not render", async () => {
    const bad = await post(admin, {
      name: "Bad", visibility: "private",
      layout: { columns: [{ id: UUID_COL, width: 5, widgets: [] }] },
    });
    expect(bad.status).toBe(400);
  });
});

d("saved dashboards — visibility", () => {
  it("shows public dashboards to other users and hides private ones", async () => {
    await post(admin, { name: "Private one", visibility: "private", layout: LAYOUT });
    await post(admin, { name: "Shared one", visibility: "public", layout: LAYOUT });

    const list = await readonly.agent.get("/api/v1/saved-dashboards");
    expect(list.status).toBe(200);
    expect(list.body.dashboards.map((x: any) => x.name)).toEqual(["Shared one"]);
    expect(list.body.dashboards[0].isOwner).toBe(false);
    expect(list.body.dashboards[0].ownerName).toBe("polaris-integration-tester");
  });

  it("lets a readonly caller keep a private dashboard but not publish one", async () => {
    const priv = await post(readonly, { name: "Mine", visibility: "private", layout: LAYOUT });
    expect(priv.status).toBe(201);

    const pub = await post(readonly, { name: "Everyones", visibility: "public", layout: LAYOUT });
    expect(pub.status).toBe(403);

    // ...and the admin never sees the readonly user's private dashboard.
    const list = await admin.agent.get("/api/v1/saved-dashboards");
    expect(list.body.dashboards).toHaveLength(0);
  });

  it("answers 404 — not 403 — for a dashboard the caller cannot see", async () => {
    const priv = await post(admin, { name: "Hidden", visibility: "private", layout: LAYOUT });
    const pub = await post(admin, { name: "Open", visibility: "public", layout: LAYOUT });

    const denied = await readonly.agent.get(`/api/v1/saved-dashboards/${priv.body.id}`);
    expect(denied.status).toBe(404);
    const allowed = await readonly.agent.get(`/api/v1/saved-dashboards/${pub.body.id}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.name).toBe("Open");
  });
});

d("saved dashboards — edit + delete", () => {
  it("is owner-only for edits", async () => {
    const created = await post(admin, { name: "Owned", visibility: "public", layout: LAYOUT });
    const resp = await readonly.agent
      .put(`/api/v1/saved-dashboards/${created.body.id}`)
      .set("X-CSRF-Token", readonly.csrf)
      .send({ name: "Hijacked", visibility: "public", layout: LAYOUT });
    expect(resp.status).toBe(403);
  });

  it("lets the owner rename and publish", async () => {
    const created = await post(admin, { name: "Before", visibility: "private", layout: LAYOUT });
    const resp = await admin.agent
      .put(`/api/v1/saved-dashboards/${created.body.id}`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ name: "After", visibility: "public", layout: LAYOUT });
    expect(resp.status).toBe(200);
    expect(resp.body.name).toBe("After");
    expect(resp.body.visibility).toBe("public");
  });

  it("lets the owner delete; a fullwrite holder deletes only an OWNERLESS one (rule 140)", async () => {
    const own = await post(readonly, { name: "RO own", visibility: "private", layout: LAYOUT });
    const delOwn = await readonly.agent
      .delete(`/api/v1/saved-dashboards/${own.body.id}`)
      .set("X-CSRF-Token", readonly.csrf);
    expect(delOwn.status).toBe(204);

    const other = await post(admin, { name: "Admin one", visibility: "public", layout: LAYOUT });
    const roDelete = await readonly.agent
      .delete(`/api/v1/saved-dashboards/${other.body.id}`)
      .set("X-CSRF-Token", readonly.csrf);
    expect(roDelete.status).toBe(403);

    const ro = await prisma.user.findUnique({ where: { username: RO_USERNAME } });
    const theirs = await prisma.savedDashboard.create({
      data: { name: "RO public", ownerId: ro!.id, ownerName: RO_USERNAME, visibility: "public", layout: LAYOUT },
    });
    const adminOnOwned = await admin.agent
      .delete(`/api/v1/saved-dashboards/${theirs.id}`)
      .set("X-CSRF-Token", admin.csrf);
    expect(adminOnOwned.status).toBe(403);

    await prisma.savedDashboard.update({ where: { id: theirs.id }, data: { ownerId: null } });
    const adminOnOwnerless = await admin.agent
      .delete(`/api/v1/saved-dashboards/${theirs.id}`)
      .set("X-CSRF-Token", admin.csrf);
    expect(adminOnOwnerless.status).toBe(204);
  });

  it("keeps a deleted user's public dashboard, orphaned rather than gone", async () => {
    const roRole = await prisma.role.findUnique({ where: { name: "readonly" } });
    const doomed = await prisma.user.create({
      data: {
        username:     "polaris-sd-doomed",
        passwordHash: await hashPassword(RO_PASSWORD),
        roleId:       roRole!.id,
        authProvider: "local",
      },
    });
    await prisma.savedDashboard.create({
      data: { name: "Left behind", ownerId: doomed.id, ownerName: doomed.username, visibility: "public", layout: LAYOUT },
    });
    await prisma.user.delete({ where: { id: doomed.id } });

    const row = await prisma.savedDashboard.findFirst({ where: { name: "Left behind" } });
    expect(row).toBeTruthy();
    expect(row!.ownerId).toBeNull();
    expect(row!.ownerName).toBe("polaris-sd-doomed");   // the surviving label

    // Still loadable by everyone, which is the point of SET NULL.
    const list = await admin.agent.get("/api/v1/saved-dashboards");
    expect(list.body.dashboards.map((x: any) => x.name)).toContain("Left behind");
  });
});

d("saved dashboards — the Dash wallboard mount", () => {
  it("serves PUBLIC dashboards to a session-less wallboard and hides private ones", async () => {
    await post(admin, { name: "Wallboard screen", visibility: "public", layout: LAYOUT });
    await post(admin, { name: "Not for the TV", visibility: "private", layout: LAYOUT });

    const list = await request(dashApp()).get("/dash/api/v1/saved-dashboards");
    expect(list.status).toBe(200);
    expect(list.body.dashboards.map((x: any) => x.name)).toEqual(["Wallboard screen"]);
    // Nothing is "owned" by a viewer with no account.
    expect(list.body.dashboards[0].isOwner).toBe(false);

    const one = await request(dashApp()).get(`/dash/api/v1/saved-dashboards/${list.body.dashboards[0].id}`);
    expect(one.status).toBe(200);
    expect(one.body.layout).toEqual(LAYOUT);
  });

  it("404s a private dashboard by id rather than admitting it exists", async () => {
    const priv = await post(admin, { name: "Not for the TV", visibility: "private", layout: LAYOUT });
    const resp = await request(dashApp()).get(`/dash/api/v1/saved-dashboards/${priv.body.id}`);
    expect(resp.status).toBe(404);
  });

  it("405s every write verb — a wallboard can never save a dashboard", async () => {
    const created = await post(admin, { name: "Wallboard screen", visibility: "public", layout: LAYOUT });
    const app2 = dashApp();
    const posted = await request(app2)
      .post("/dash/api/v1/saved-dashboards")
      .send({ name: "From the TV", visibility: "public", layout: LAYOUT });
    expect(posted.status).toBe(405);
    const deleted = await request(app2).delete(`/dash/api/v1/saved-dashboards/${created.body.id}`);
    expect(deleted.status).toBe(405);
    expect(await prisma.savedDashboard.count()).toBe(1);
  });
});

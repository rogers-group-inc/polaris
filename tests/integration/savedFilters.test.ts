/**
 * tests/integration/savedFilters.test.ts
 *
 * The /api/v1/saved-filters surface (Assets page → Filters ▾):
 *   - create a private preset, list it back, load-shaped payload round-trips
 *   - a SECOND user sees public presets but never someone else's private one
 *   - publishing needs assets:write — a readonly caller can keep a private
 *     preset but is 403 on a public one
 *   - re-saving the same name overwrites instead of duplicating
 *   - edit/delete are owner-only; fullwrite deletes only an OWNERLESS preset
 *     (business rule 140 — ownership and folders: savedFolderOwnership.test.ts)
 *   - unknown scope + malformed state are rejected
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

const RO_USERNAME = "polaris-sf-readonly";
const RO_PASSWORD = "test-password-do-not-use-in-prod";

let admin: { agent: ReturnType<typeof request.agent>; csrf: string };
let readonly: { agent: ReturnType<typeof request.agent>; csrf: string };

const STATE = {
  sfFilters: { assetType: ["firewall"], hostname: "nsh" },
  sortKey: "hostname",
  sortDir: "asc",
};

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
  await prisma.savedTableFilter.deleteMany();
  await prisma.user.deleteMany({ where: { username: RO_USERNAME } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.savedTableFilter.deleteMany();
});

function post(who: typeof admin, body: unknown) {
  return who.agent.post("/api/v1/saved-filters").set("X-CSRF-Token", who.csrf).send(body as object);
}

d("saved filters — create + list", () => {
  it("round-trips a private preset for its owner", async () => {
    const created = await post(admin, {
      scope: "assets", name: "  Edge   firewalls ", visibility: "private", state: STATE,
    });
    expect(created.status).toBe(201);
    // Name whitespace is normalized on write.
    expect(created.body.name).toBe("Edge firewalls");
    expect(created.body.isOwner).toBe(true);
    expect(created.body.state).toEqual(STATE);

    const list = await admin.agent.get("/api/v1/saved-filters?scope=assets");
    expect(list.status).toBe(200);
    expect(list.body.filters).toHaveLength(1);
    expect(list.body.filters[0].visibility).toBe("private");
  });

  it("re-saving the same name overwrites rather than duplicating", async () => {
    const first = await post(admin, { scope: "assets", name: "Dupe", visibility: "private", state: STATE });
    const second = await post(admin, {
      scope: "assets", name: "Dupe", visibility: "private",
      state: { sfFilters: { status: ["decommissioned"] } },
    });
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.state.sfFilters).toEqual({ status: ["decommissioned"] });
    expect(await prisma.savedTableFilter.count()).toBe(1);
  });

  it("rejects an unknown scope and a malformed state", async () => {
    const badScope = await post(admin, { scope: "subnets", name: "x", visibility: "private", state: STATE });
    expect(badScope.status).toBe(400);
    const badState = await post(admin, {
      scope: "assets", name: "x", visibility: "private", state: { sfFilters: { hostname: { op: "rm -rf" } } },
    });
    expect(badState.status).toBe(400);
  });
});

d("saved filters — visibility", () => {
  it("shows public presets to other users and hides private ones", async () => {
    await post(admin, { scope: "assets", name: "Private one", visibility: "private", state: STATE });
    await post(admin, { scope: "assets", name: "Shared one", visibility: "public", state: STATE });

    const list = await readonly.agent.get("/api/v1/saved-filters?scope=assets");
    expect(list.status).toBe(200);
    expect(list.body.filters.map((f: any) => f.name)).toEqual(["Shared one"]);
    expect(list.body.filters[0].isOwner).toBe(false);
    expect(list.body.filters[0].ownerName).toBe("polaris-integration-tester");
  });

  it("lets a readonly caller keep a private preset but not publish one", async () => {
    const priv = await post(readonly, { scope: "assets", name: "Mine", visibility: "private", state: STATE });
    expect(priv.status).toBe(201);

    const pub = await post(readonly, { scope: "assets", name: "Everyones", visibility: "public", state: STATE });
    expect(pub.status).toBe(403);

    // ...and the admin never sees the readonly user's private preset.
    const list = await admin.agent.get("/api/v1/saved-filters?scope=assets");
    expect(list.body.filters).toHaveLength(0);
  });
});

d("saved filters — edit + delete", () => {
  it("is owner-only for edits", async () => {
    const created = await post(admin, { scope: "assets", name: "Owned", visibility: "public", state: STATE });
    const resp = await readonly.agent
      .put(`/api/v1/saved-filters/${created.body.id}`)
      .set("X-CSRF-Token", readonly.csrf)
      .send({ scope: "assets", name: "Hijacked", visibility: "public", state: STATE });
    expect(resp.status).toBe(403);
  });

  it("lets the owner rename and change visibility", async () => {
    const created = await post(admin, { scope: "assets", name: "Before", visibility: "private", state: STATE });
    const resp = await admin.agent
      .put(`/api/v1/saved-filters/${created.body.id}`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ scope: "assets", name: "After", visibility: "public", state: STATE });
    expect(resp.status).toBe(200);
    expect(resp.body.name).toBe("After");
    expect(resp.body.visibility).toBe("public");
  });

  it("lets the owner delete; a fullwrite holder deletes only an OWNERLESS one (rule 140)", async () => {
    const own = await post(readonly, { scope: "assets", name: "RO own", visibility: "private", state: STATE });
    const delOwn = await readonly.agent
      .delete(`/api/v1/saved-filters/${own.body.id}`)
      .set("X-CSRF-Token", readonly.csrf);
    expect(delOwn.status).toBe(204);

    const other = await post(admin, { scope: "assets", name: "Admin one", visibility: "public", state: STATE });
    const roDelete = await readonly.agent
      .delete(`/api/v1/saved-filters/${other.body.id}`)
      .set("X-CSRF-Token", readonly.csrf);
    expect(roDelete.status).toBe(403);

    // Someone else's OWNED public preset: fullwrite no longer deletes it.
    const ro = await prisma.user.findUnique({ where: { username: RO_USERNAME } });
    const theirs = await prisma.savedTableFilter.create({
      data: { scope: "assets", name: "RO public", ownerId: ro!.id, ownerName: RO_USERNAME, visibility: "public", state: STATE },
    });
    const adminOnOwned = await admin.agent
      .delete(`/api/v1/saved-filters/${theirs.id}`)
      .set("X-CSRF-Token", admin.csrf);
    expect(adminOnOwned.status).toBe(403);

    // An OWNERLESS one is exactly what fullwrite is for.
    await prisma.savedTableFilter.update({ where: { id: theirs.id }, data: { ownerId: null } });
    const adminOnOwnerless = await admin.agent
      .delete(`/api/v1/saved-filters/${theirs.id}`)
      .set("X-CSRF-Token", admin.csrf);
    expect(adminOnOwnerless.status).toBe(204);
  });

  it("keeps a deleted user's public preset but drops their private one", async () => {
    const roRole = await prisma.role.findUnique({ where: { name: "readonly" } });
    const doomed = await prisma.user.create({
      data: {
        username:     "polaris-sf-doomed",
        passwordHash: await hashPassword(RO_PASSWORD),
        roleId:       roRole!.id,
        authProvider: "local",
      },
    });
    await prisma.savedTableFilter.createMany({
      data: [
        { scope: "assets", name: "Doomed private", ownerId: doomed.id, ownerName: doomed.username, visibility: "private", state: STATE },
        { scope: "assets", name: "Doomed public",  ownerId: doomed.id, ownerName: doomed.username, visibility: "public",  state: STATE },
      ],
    });

    const resp = await admin.agent
      .delete(`/api/v1/users/${doomed.id}`)
      .set("X-CSRF-Token", admin.csrf);
    expect(resp.status).toBe(204);

    const rows = await prisma.savedTableFilter.findMany();
    expect(rows.map((r) => r.name)).toEqual(["Doomed public"]);
    expect(rows[0].ownerId).toBeNull();
    expect(rows[0].ownerName).toBe("polaris-sf-doomed");
  });
});

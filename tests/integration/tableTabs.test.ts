/**
 * tests/integration/tableTabs.test.ts
 *
 * The /api/v1/me/table-tabs surface (Assets page tab strip):
 *   - empty layout before anything is saved; full-replace round-trip after
 *   - a tab's BASE filter round-trips, and its id/name drop without a snapshot
 *   - a tab's own FAVORITES round-trip; absent stays null, over-cap is refused
 *   - a tab's own COLUMN ORDER round-trips under the same null/[]/cap rules
 *   - tabs are STRICTLY per user — two users never see each other's
 *   - a readonly caller gets tabs (they only need read on the scope's key)
 *   - unknown scope + malformed tab payloads are rejected
 *   - deleting the user cascades their tabs away (unlike public saved filters)
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

const RO_USERNAME = "polaris-tabs-readonly";
const RO_PASSWORD = "test-password-do-not-use-in-prod";

let admin: { agent: ReturnType<typeof request.agent>; csrf: string };
let readonly: { agent: ReturnType<typeof request.agent>; csrf: string };

const STATE = { sfFilters: { assetType: ["firewall"] }, sortKey: "hostname", sortDir: "asc" };

function layout(tabs: unknown[], activeId: string) {
  return { tabs, activeId };
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
  await prisma.userTableTabs.deleteMany();
  await prisma.user.deleteMany({ where: { username: RO_USERNAME } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.userTableTabs.deleteMany();
});

function put(who: typeof admin, body: unknown) {
  return who.agent.put("/api/v1/me/table-tabs?scope=assets").set("X-CSRF-Token", who.csrf).send(body as object);
}

d("table tabs", () => {
  it("starts empty and round-trips a full-replace save", async () => {
    const empty = await admin.agent.get("/api/v1/me/table-tabs?scope=assets");
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ version: 1, tabs: [], activeId: "" });

    const saved = await put(admin, layout([
      { id: "t1", name: "All assets", state: {} },
      { id: "t2", name: "Firewalls", state: STATE, savedFilterId: "f1", savedFilterName: "Edge firewalls" },
    ], "t2"));
    expect(saved.status).toBe(200);
    expect(saved.body.activeId).toBe("t2");
    expect(saved.body.tabs).toHaveLength(2);
    expect(saved.body.tabs[1].state).toEqual(STATE);
    expect(saved.body.tabs[1].savedFilterName).toBe("Edge firewalls");

    const reread = await admin.agent.get("/api/v1/me/table-tabs?scope=assets");
    expect(reread.body.tabs.map((t: any) => t.name)).toEqual(["All assets", "Firewalls"]);

    // Full-replace, not merge.
    await put(admin, layout([{ id: "t9", name: "Only one", state: {} }], "t9"));
    const after = await admin.agent.get("/api/v1/me/table-tabs?scope=assets");
    expect(after.body.tabs.map((t: any) => t.id)).toEqual(["t9"]);
  });

  it("round-trips a tab's base filter, and drops a label with no snapshot", async () => {
    const saved = await put(admin, layout([
      { id: "t1", name: "Firewalls", state: STATE, defaultFilterId: "f1", defaultFilterName: "Edge firewalls", defaultState: STATE },
      // A label with nothing to reset to is normalized away rather than 400-ing
      // the whole strip — see sanitizeTabs.
      { id: "t2", name: "Orphan", state: {}, defaultFilterId: "f9", defaultFilterName: "Deleted" },
    ], "t1"));
    expect(saved.status).toBe(200);
    expect(saved.body.tabs[0].defaultFilterId).toBe("f1");
    expect(saved.body.tabs[0].defaultState).toEqual(STATE);
    expect(saved.body.tabs[1].defaultState).toBeNull();
    expect(saved.body.tabs[1].defaultFilterId).toBeNull();

    const reread = await admin.agent.get("/api/v1/me/table-tabs?scope=assets");
    expect(reread.body.tabs[0].defaultFilterName).toBe("Edge firewalls");

    // A base state is held to the same shape rules as the tab's own.
    const bad = await put(admin, layout([
      { id: "t1", name: "x", state: {}, defaultState: { sfFilters: { hostname: { op: "nope" } } } },
    ], "t1"));
    expect(bad.status).toBe(400);
  });

  it("round-trips each tab's own favorites, and refuses an over-cap list", async () => {
    const saved = await put(admin, layout([
      { id: "t1", name: "Firewalls", state: STATE, favoriteIds: ["a2", "a1", "a2"] },
      { id: "t2", name: "Switches", state: {}, favoriteIds: [] },
      // Absent stays NULL — that's what lets the client seed the tab once from
      // the legacy per-user localStorage set.
      { id: "t3", name: "Pre-feature", state: {} },
    ], "t1"));
    expect(saved.status).toBe(200);
    expect(saved.body.tabs[0].favoriteIds).toEqual(["a2", "a1"]);   // deduped, order kept
    expect(saved.body.tabs[1].favoriteIds).toEqual([]);
    expect(saved.body.tabs[2].favoriteIds).toBeNull();

    const reread = await admin.agent.get("/api/v1/me/table-tabs?scope=assets");
    expect(reread.body.tabs[0].favoriteIds).toEqual(["a2", "a1"]);

    const overCap = await put(admin, layout([
      { id: "t1", name: "Full", state: {}, favoriteIds: Array.from({ length: 501 }, (_, i) => `a${i}`) },
    ], "t1"));
    expect(overCap.status).toBe(400);
  });

  it("round-trips each tab's own column order, and refuses an over-cap list", async () => {
    const saved = await put(admin, layout([
      { id: "t1", name: "Firewalls", state: STATE, columnOrder: ["type", "hostname", "type"] },
      { id: "t2", name: "Switches", state: {}, columnOrder: [] },
      // Absent stays NULL — the client seeds it once from this browser's
      // stored table layout, exactly as it does for favorites.
      { id: "t3", name: "Pre-feature", state: {} },
    ], "t1"));
    expect(saved.status).toBe(200);
    expect(saved.body.tabs[0].columnOrder).toEqual(["type", "hostname"]);   // deduped, order kept
    expect(saved.body.tabs[1].columnOrder).toEqual([]);
    expect(saved.body.tabs[2].columnOrder).toBeNull();

    const reread = await admin.agent.get("/api/v1/me/table-tabs?scope=assets");
    expect(reread.body.tabs[0].columnOrder).toEqual(["type", "hostname"]);

    const overCap = await put(admin, layout([
      { id: "t1", name: "Wide", state: {}, columnOrder: Array.from({ length: 201 }, (_, i) => `c${i}`) },
    ], "t1"));
    expect(overCap.status).toBe(400);
  });

  it("keeps each user's tabs to themselves, and gives a readonly caller tabs of their own", async () => {
    await put(admin, layout([{ id: "a1", name: "Admin view", state: STATE }], "a1"));

    const roSave = await put(readonly, layout([{ id: "r1", name: "RO view", state: {} }], "r1"));
    expect(roSave.status).toBe(200);      // read on the scope key is enough

    const roGet = await readonly.agent.get("/api/v1/me/table-tabs?scope=assets");
    expect(roGet.body.tabs.map((t: any) => t.name)).toEqual(["RO view"]);
    const adminGet = await admin.agent.get("/api/v1/me/table-tabs?scope=assets");
    expect(adminGet.body.tabs.map((t: any) => t.name)).toEqual(["Admin view"]);
  });

  it("rejects an unknown scope and malformed tabs", async () => {
    const badScope = await admin.agent
      .put("/api/v1/me/table-tabs?scope=subnets")
      .set("X-CSRF-Token", admin.csrf)
      .send(layout([{ id: "t1", name: "x", state: {} }], "t1"));
    expect(badScope.status).toBe(400);

    expect((await put(admin, layout([{ id: "t1", name: "a", state: {} }, { id: "t1", name: "b", state: {} }], "t1"))).status).toBe(400);
    expect((await put(admin, layout([{ id: "t1", name: "  ", state: {} }], "t1"))).status).toBe(400);
    expect((await put(admin, layout([{ id: "t1", name: "x", state: { sfFilters: { hostname: { op: "nope" } } } }], "t1"))).status).toBe(400);
  });

  it("repairs a stale activeId rather than failing the save", async () => {
    const resp = await put(admin, layout([{ id: "t1", name: "One", state: {} }], "closed-in-another-window"));
    expect(resp.status).toBe(200);
    expect(resp.body.activeId).toBe("t1");
  });

  it("cascades away with the user", async () => {
    const roRole = await prisma.role.findUnique({ where: { name: "readonly" } });
    const doomed = await prisma.user.create({
      data: {
        username:     "polaris-tabs-doomed",
        passwordHash: await hashPassword(RO_PASSWORD),
        roleId:       roRole!.id,
        authProvider: "local",
      },
    });
    await prisma.userTableTabs.create({
      data: { userId: doomed.id, scope: "assets", tabs: { version: 1, tabs: [], activeId: "" } },
    });

    const resp = await admin.agent.delete(`/api/v1/users/${doomed.id}`).set("X-CSRF-Token", admin.csrf);
    expect(resp.status).toBe(204);
    expect(await prisma.userTableTabs.count({ where: { userId: doomed.id } })).toBe(0);
  });
});

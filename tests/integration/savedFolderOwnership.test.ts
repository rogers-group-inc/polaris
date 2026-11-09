/**
 * tests/integration/savedFolderOwnership.test.ts — business rule 140.
 *
 * Folders, role / region / ownerless ownership, Change owner and "Make private
 * to me", over the real routes, for saved filters AND saved dashboards (and the
 * Dash wallboard's view of folders):
 *   - a folder nests, refuses a cycle, and deleting it moves its contents up
 *   - an item whose folder the caller can't see comes back at the top level
 *   - a ROLE owner = every holder; a REGION owner = every user scoped to it
 *     (an unrestricted user is not one); nobody else manages, fullwrite included
 *   - Change owner validates its target; a disabled user can't own anything
 *   - Make private to me: the owner, or a fullwrite holder taking someone
 *     else's — recorded as saved_*.taken naming the previous owner
 *   - a region renamed carries its rows; a region deleted leaves them ownerless
 *   - the wallboard sees public folders only and cannot list accounts
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { buildDashApp } from "../../src/dash/dashServer.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import * as regions from "../../src/services/mapRegionService.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import type { DashSettings } from "../../src/services/dashSettingsService.js";
import type { DashRoleIdentity } from "../../src/services/dashRoleSnapshotService.js";

const d = dbDescribe;

const RO_USERNAME = "polaris-sfo-readonly";
const OTHER_USERNAME = "polaris-sfo-other";
const PASSWORD = "test-password-do-not-use-in-prod";
const REGION = "SFO Test Region";

type Who = { agent: ReturnType<typeof request.agent>; csrf: string };
let admin: Who;
let readonly: Who;
let roId = "";
let roRoleId = "";

const STATE = { sfFilters: { hostname: "nsh" }, sortKey: null, sortDir: null };
const LAYOUT = {
  columns: [
    {
      id: "aaaaaaaa-0000-4000-8000-0000000000a1",
      width: 6,
      widgets: [{ id: "aaaaaaaa-0000-4000-8000-0000000000a2", type: "statusSummary", height: 1, config: {} }],
    },
  ],
};

const READONLY_IDENTITY: DashRoleIdentity = {
  snapshot: {
    id: "role-readonly-id",
    name: "readonly",
    isProtected: true,
    permissions: { assets: "read", deviceMap: "read", savedDashboards: "read" },
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

function dashApp() {
  const settings: DashSettings = { enabled: true, ipScope: "rfc1918", allowedCidrs: [] };
  return buildDashApp({ settingsProvider: async () => settings, identityProvider: async () => READONLY_IDENTITY });
}

async function login(username: string): Promise<Who> {
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const resp = await agent.post("/api/v1/auth/login").send({ username, password: PASSWORD }).set("Content-Type", "application/json");
  if (resp.status !== 200) throw new Error(`login ${username} failed (${resp.status})`);
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  return { agent, csrf: (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "" };
}

const send = (who: Who, method: "post" | "put" | "patch" | "delete", url: string, body?: object) =>
  who.agent[method](url).set("X-CSRF-Token", who.csrf).send(body ?? {});

async function wipe() {
  await prisma.savedTableFilter.deleteMany();
  await prisma.savedDashboard.deleteMany();
  await prisma.savedFolder.deleteMany();
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  admin = await authedAgent(app);
  const roRole = await prisma.role.findUnique({ where: { name: "readonly" } });
  if (!roRole) throw new Error("built-in 'readonly' Role missing");
  roRoleId = roRole.id;
  const hash = await hashPassword(PASSWORD);
  const ro = await prisma.user.upsert({
    where: { username: RO_USERNAME },
    update: { roleId: roRole.id, regionTags: [], disabledAt: null },
    create: { username: RO_USERNAME, passwordHash: hash, roleId: roRole.id, authProvider: "local" },
  });
  roId = ro.id;
  await prisma.user.upsert({
    where: { username: OTHER_USERNAME },
    update: { roleId: roRole.id, disabledAt: null },
    create: { username: OTHER_USERNAME, passwordHash: hash, roleId: roRole.id, authProvider: "local" },
  });
  readonly = await login(RO_USERNAME);
});

afterAll(async () => {
  if (!dbReachable) return;
  await wipe();
  for (const r of await regions.listRegions()) {
    if (r.name.startsWith("SFO Test")) await regions.deleteRegion(r.id);
  }
  await prisma.user.deleteMany({ where: { username: { in: [RO_USERNAME, OTHER_USERNAME] } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await wipe();
  await prisma.user.update({ where: { id: roId }, data: { regionTags: [] } });
});

async function filterAsAdmin(name: string, visibility: "private" | "public" = "public", folderId?: string) {
  const r = await send(admin, "post", "/api/v1/saved-filters", { scope: "assets", name, visibility, state: STATE, folderId });
  expect(r.status).toBe(201);
  return r.body;
}

async function folderAsAdmin(name: string, visibility: "private" | "public" = "public", parentId?: string) {
  const r = await send(admin, "post", "/api/v1/saved-filters/folders", { scope: "assets", name, visibility, parentId });
  expect(r.status).toBe(201);
  return r.body;
}

d("saved folders — tree", () => {
  it("nests, files items, and lists both in one response", async () => {
    const top = await folderAsAdmin("Firewalls");
    const sub = await folderAsAdmin("HQ", "public", top.id);
    const f = await filterAsAdmin("HQ gates", "public", sub.id);

    const list = await admin.agent.get("/api/v1/saved-filters?scope=assets");
    expect(list.status).toBe(200);
    const byName = Object.fromEntries(list.body.folders.map((x: any) => [x.name, x]));
    expect(byName.HQ.parentId).toBe(top.id);
    expect(list.body.filters.find((x: any) => x.id === f.id).folderId).toBe(sub.id);
  });

  it("refuses a folder moved into its own subtree", async () => {
    const top = await folderAsAdmin("A");
    const sub = await folderAsAdmin("B", "public", top.id);
    const r = await send(admin, "patch", `/api/v1/saved-filters/folders/${top.id}/parent`, { parentId: sub.id });
    expect(r.status).toBe(400);
  });

  it("moves a deleted folder's contents up a level instead of deleting them", async () => {
    const top = await folderAsAdmin("Top");
    const mid = await folderAsAdmin("Mid", "public", top.id);
    const leaf = await folderAsAdmin("Leaf", "public", mid.id);
    const f = await filterAsAdmin("Inside", "public", mid.id);

    const r = await send(admin, "delete", `/api/v1/saved-filters/folders/${mid.id}`);
    expect(r.status).toBe(204);
    expect((await prisma.savedTableFilter.findUnique({ where: { id: f.id } }))!.folderId).toBe(top.id);
    expect((await prisma.savedFolder.findUnique({ where: { id: leaf.id } }))!.parentId).toBe(top.id);
  });

  it("drags a preset between folders and back to the top level", async () => {
    const a = await folderAsAdmin("A");
    const f = await filterAsAdmin("Mover");
    expect((await send(admin, "patch", `/api/v1/saved-filters/${f.id}/folder`, { folderId: a.id })).status).toBe(204);
    expect((await prisma.savedTableFilter.findUnique({ where: { id: f.id } }))!.folderId).toBe(a.id);
    expect((await send(admin, "patch", `/api/v1/saved-filters/${f.id}/folder`, { folderId: null })).status).toBe(204);
    expect((await prisma.savedTableFilter.findUnique({ where: { id: f.id } }))!.folderId).toBeNull();
  });

  it("shows a public item in a private folder at the TOP level to someone who can't see the folder", async () => {
    const hidden = await folderAsAdmin("Admin only", "private");
    const f = await filterAsAdmin("Shared inside", "public", hidden.id);
    const list = await readonly.agent.get("/api/v1/saved-filters?scope=assets");
    expect(list.body.folders.map((x: any) => x.id)).not.toContain(hidden.id);
    expect(list.body.filters.find((x: any) => x.id === f.id).folderId).toBeNull();
  });

  it("refuses a public folder from a caller without write", async () => {
    const r = await send(readonly, "post", "/api/v1/saved-filters/folders", { scope: "assets", name: "Nope", visibility: "public" });
    expect(r.status).toBe(403);
  });
});

d("saved folders — ownership", () => {
  it("only the owner deletes an owned PUBLIC folder — fullwrite included", async () => {
    const theirs = await prisma.savedFolder.create({
      data: { kind: "filter", scope: "assets", name: "RO public", ownerId: roId, ownerName: RO_USERNAME, visibility: "public" },
    });
    expect((await send(admin, "delete", `/api/v1/saved-filters/folders/${theirs.id}`)).status).toBe(403);
    expect((await send(readonly, "delete", `/api/v1/saved-filters/folders/${theirs.id}`)).status).toBe(204);
  });

  it("a ROLE owner is every holder of the role, and nobody else", async () => {
    const f = await filterAsAdmin("Team preset");
    const give = await send(admin, "post", `/api/v1/saved-filters/${f.id}/owner`, { owner: { kind: "role", roleId: roRoleId } });
    expect(give.status).toBe(200);
    expect(give.body.ownerKind).toBe("role");

    // The giver no longer owns it (and, holding another role, is not an owner).
    const adminRename = await send(admin, "put", `/api/v1/saved-filters/${f.id}`, { scope: "assets", name: "Hijack", visibility: "public", state: STATE });
    expect(adminRename.status).toBe(403);
    // A readonly holder manages it — but publishing still needs write.
    const roRename = await send(readonly, "put", `/api/v1/saved-filters/${f.id}`, { scope: "assets", name: "Renamed by team", visibility: "private", state: STATE });
    expect(roRename.status).toBe(200);
    expect(roRename.body.isOwner).toBe(true);
  });

  it("a REGION owner is every user scoped to it; an unrestricted user is not", async () => {
    await regions.createRegion({ name: REGION, polygon: [[0, 0], [0, 1], [1, 1]] as any });
    await prisma.user.update({ where: { id: roId }, data: { regionTags: [REGION] } });
    const f = await filterAsAdmin("Regional");
    const give = await send(admin, "post", `/api/v1/saved-filters/${f.id}/owner`, { owner: { kind: "region", region: REGION.toLowerCase() } });
    expect(give.status).toBe(200);
    expect(give.body.ownerRegion).toBe(REGION);   // the map's own spelling

    expect((await send(admin, "delete", `/api/v1/saved-filters/${f.id}`)).status).toBe(403);
    expect((await send(readonly, "delete", `/api/v1/saved-filters/${f.id}`)).status).toBe(204);
  });

  it("follows a region rename and goes ownerless when the region is deleted", async () => {
    const region = await regions.createRegion({ name: `${REGION} B`, polygon: [[0, 0], [0, 1], [1, 1]] as any });
    const f = await filterAsAdmin("Follows the region");
    await send(admin, "post", `/api/v1/saved-filters/${f.id}/owner`, { owner: { kind: "region", region: region.name } });

    const renamed = await send(admin, "put", `/api/v1/map/regions/${region.id}`, { name: `${REGION} C` });
    expect(renamed.status).toBe(200);
    expect((await prisma.savedTableFilter.findUnique({ where: { id: f.id } }))!.ownerRegion).toBe(`${REGION} C`);

    expect((await send(admin, "delete", `/api/v1/map/regions/${region.id}`)).status).toBe(204);
    const after = await prisma.savedTableFilter.findUnique({ where: { id: f.id } });
    expect(after!.ownerRegion).toBeNull();
    expect(after!.ownerName).toBe(`${REGION} C`);   // "was …"
    // Ownerless: now the fullwrite holder's to manage.
    expect((await send(admin, "delete", `/api/v1/saved-filters/${f.id}`)).status).toBe(204);
  });

  it("refuses a disabled user as the new owner", async () => {
    const other = await prisma.user.update({ where: { username: OTHER_USERNAME }, data: { disabledAt: new Date() } });
    const f = await filterAsAdmin("No taker");
    const r = await send(admin, "post", `/api/v1/saved-filters/${f.id}/owner`, { owner: { kind: "user", userId: other.id } });
    expect(r.status).toBe(400);
    const opts = await admin.agent.get("/api/v1/saved-filters/owner-options?scope=assets");
    expect(opts.body.users.map((u: any) => u.username)).not.toContain(OTHER_USERNAME);
    await prisma.user.update({ where: { id: other.id }, data: { disabledAt: null } });
  });

  it("gives a folder AND what is inside it when asked", async () => {
    const folder = await folderAsAdmin("Hand over");
    const inside = await filterAsAdmin("Inside it", "public", folder.id);
    const r = await send(admin, "post", `/api/v1/saved-filters/folders/${folder.id}/owner`, {
      owner: { kind: "user", userId: roId },
      includeContents: true,
    });
    expect(r.status).toBe(200);
    expect(r.body.moved.filters).toBe(1);
    expect((await prisma.savedTableFilter.findUnique({ where: { id: inside.id } }))!.ownerId).toBe(roId);
  });
});

d("saved folders — make private to me", () => {
  it("lets a fullwrite holder take someone else's public preset, and records it", async () => {
    const theirs = await prisma.savedTableFilter.create({
      data: { scope: "assets", name: "Theirs", ownerId: roId, ownerName: RO_USERNAME, visibility: "public", state: STATE },
    });
    const r = await send(admin, "post", `/api/v1/saved-filters/${theirs.id}/make-private`);
    expect(r.status).toBe(200);
    expect(r.body.visibility).toBe("private");
    expect(r.body.isOwner).toBe(true);

    // Gone from the previous owner's menu.
    const roList = await readonly.agent.get("/api/v1/saved-filters?scope=assets");
    expect(roList.body.filters.map((x: any) => x.id)).not.toContain(theirs.id);

    const ev = await prisma.event.findFirst({ where: { action: "saved_filter.taken", resourceId: theirs.id } });
    expect(ev).toBeTruthy();
    expect(ev!.message).toContain(RO_USERNAME);
  });

  it("refuses a non-owner without fullwrite", async () => {
    const mine = await filterAsAdmin("Admin's");
    expect((await send(readonly, "post", `/api/v1/saved-filters/${mine.id}/make-private`)).status).toBe(403);
  });
});

d("saved folders — dashboards and the wallboard", () => {
  it("files a dashboard, and the wallboard sees public folders only", async () => {
    const pub = await send(admin, "post", "/api/v1/saved-dashboards/folders", { name: "NOC", visibility: "public" });
    const priv = await send(admin, "post", "/api/v1/saved-dashboards/folders", { name: "Mine", visibility: "private" });
    expect(pub.status).toBe(201);
    const dash = await send(admin, "post", "/api/v1/saved-dashboards", { name: "Wall", visibility: "public", layout: LAYOUT, folderId: priv.body.id });
    expect(dash.status).toBe(201);

    const wall = await request(dashApp()).get("/dash/api/v1/saved-dashboards");
    expect(wall.status).toBe(200);
    expect(wall.body.folders.map((f: any) => f.name)).toEqual(["NOC"]);
    // Its folder is private, so the wallboard draws it at the top level.
    expect(wall.body.dashboards[0].folderId).toBeNull();
  });

  it("never lists accounts to the wallboard", async () => {
    const r = await request(dashApp()).get("/dash/api/v1/saved-dashboards/owner-options");
    expect(r.status).toBe(401);
  });

  it("only the owner deletes an owned public dashboard", async () => {
    const theirs = await prisma.savedDashboard.create({
      data: { name: "RO wall", ownerId: roId, ownerName: RO_USERNAME, visibility: "public", layout: LAYOUT },
    });
    expect((await send(admin, "delete", `/api/v1/saved-dashboards/${theirs.id}`)).status).toBe(403);
    const take = await send(admin, "post", `/api/v1/saved-dashboards/${theirs.id}/make-private`);
    expect(take.status).toBe(200);
    expect((await send(admin, "delete", `/api/v1/saved-dashboards/${theirs.id}`)).status).toBe(204);
  });
});

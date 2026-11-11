/**
 * tests/integration/userDisable.test.ts — business rule 140, the account half.
 *
 * POST /users/:id/disable and /enable:
 *   - a disabled account's live sessions end at once, and every sign-in is
 *     refused — after the password checked out, so a wrong password learns
 *     nothing — with an auth.login.disabled Event
 *   - its PRIVATE saved folders / filters / dashboards are deleted (a deleted
 *     private folder's contents move up), its PUBLIC ones become ownerless
 *   - the per-minute session recheck ends a session the disable route missed
 *   - you cannot disable yourself; enabling lets them back in with nothing
 *     returned; the preview counts what a disable would release
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { clearLockout } from "../../src/utils/loginLockout.js";
import { revalidateSessionUser } from "../../src/api/middleware/sessionRevalidate.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import {
  bumpRecipientIndex,
  resolveAllUsers,
  resolveRecipientUsersByIds,
  resolveUsersByRoles,
} from "../../src/services/notificationRecipientService.js";

const d = dbDescribe;

const USERNAME = "test-disable-target";
const PASSWORD = "Disable-Test-Passw0rd-2026!";
const STATE = { sfFilters: {}, sortKey: null, sortDir: null };
const LAYOUT = { columns: [] };

let userId = "";

async function signIn() {
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const res = await agent.post("/api/v1/auth/login").send({ username: USERNAME, password: PASSWORD });
  return { agent, res };
}

const signedIn = async (agent: ReturnType<typeof request.agent>) =>
  (await agent.get("/api/v1/auth/me")).body.authenticated === true;

async function cleanup() {
  await prisma.savedTableFilter.deleteMany();
  await prisma.savedDashboard.deleteMany();
  await prisma.savedFolder.deleteMany();
  await prisma.user.deleteMany({ where: { username: USERNAME } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  clearLockout(USERNAME);
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  clearLockout(USERNAME);
  const role = await prisma.role.findUnique({ where: { name: "readonly" } });
  userId = (
    await prisma.user.create({
      data: { username: USERNAME, passwordHash: await hashPassword(PASSWORD), roleId: role!.id, authProvider: "local" },
    })
  ).id;
});

d("disabling an account", () => {
  it("ends its sessions, refuses its sign-in, and releases its saved items", async () => {
    const mine = { ownerId: userId, ownerName: USERNAME };
    const privFolder = await prisma.savedFolder.create({
      data: { kind: "filter", scope: "assets", name: "Private folder", visibility: "private", ...mine },
    });
    // Someone else's public preset filed in the doomed private folder: it must
    // survive, moved to the top level.
    const admin = await prisma.user.findFirst({ where: { username: { not: USERNAME } }, orderBy: { createdAt: "asc" } });
    const bystander = await prisma.savedTableFilter.create({
      data: { scope: "assets", name: "Bystander", ownerId: admin!.id, ownerName: admin!.username, visibility: "public", state: STATE, folderId: privFolder.id },
    });
    await prisma.savedTableFilter.create({ data: { scope: "assets", name: "Mine private", visibility: "private", state: STATE, ...mine } });
    const pubDash = await prisma.savedDashboard.create({ data: { name: "Mine public", visibility: "public", layout: LAYOUT, ...mine } });

    const { agent, res } = await signIn();
    expect(res.status).toBe(200);
    expect(await signedIn(agent)).toBe(true);

    const adm = await authedAgent(app);
    const preview = await adm.agent.get(`/api/v1/users/${userId}/disable-preview`);
    expect(preview.body.deleted).toEqual({ folders: 1, filters: 1, dashboards: 0 });
    expect(preview.body.ownerless).toEqual({ folders: 0, filters: 0, dashboards: 1 });

    const dis = await adm.agent.post(`/api/v1/users/${userId}/disable`).set("X-CSRF-Token", adm.csrf).send({});
    expect(dis.status).toBe(200);

    // The live session is gone…
    expect(await signedIn(agent)).toBe(false);
    // …and a correct password is refused, with the reason.
    const again = await signIn();
    expect(again.res.status).toBe(403);
    expect(again.res.body.error || again.res.body.message).toMatch(/disabled/i);
    // A WRONG password learns nothing about the disable.
    const wrong = await request(app).post("/api/v1/auth/login").send({ username: USERNAME, password: "nope-nope-nope" });
    expect(wrong.status).toBe(401);

    expect(await prisma.savedFolder.count({ where: { id: privFolder.id } })).toBe(0);
    expect(await prisma.savedTableFilter.count({ where: { name: "Mine private" } })).toBe(0);
    expect((await prisma.savedTableFilter.findUnique({ where: { id: bystander.id } }))!.folderId).toBeNull();
    const orphan = await prisma.savedDashboard.findUnique({ where: { id: pubDash.id } });
    expect(orphan!.ownerId).toBeNull();
    expect(orphan!.ownerName).toBe(USERNAME);

    expect(await prisma.event.findFirst({ where: { action: "user.disabled", resourceId: userId } })).toBeTruthy();
    expect(await prisma.event.findFirst({ where: { action: "auth.login.disabled", resourceId: userId } })).toBeTruthy();
  });

  it("lets them back in when enabled, with nothing returned", async () => {
    await prisma.savedTableFilter.create({
      data: { scope: "assets", name: "Gone for good", ownerId: userId, ownerName: USERNAME, visibility: "private", state: STATE },
    });
    const adm = await authedAgent(app);
    expect((await adm.agent.post(`/api/v1/users/${userId}/disable`).set("X-CSRF-Token", adm.csrf).send({})).status).toBe(200);
    expect((await adm.agent.post(`/api/v1/users/${userId}/disable`).set("X-CSRF-Token", adm.csrf).send({})).status).toBe(409);
    expect((await adm.agent.post(`/api/v1/users/${userId}/enable`).set("X-CSRF-Token", adm.csrf).send({})).status).toBe(200);

    const { res } = await signIn();
    expect(res.status).toBe(200);
    expect(await prisma.savedTableFilter.count({ where: { name: "Gone for good" } })).toBe(0);
  });

  // Rule 140(a): a disabled account receives nothing. Before 2026-11-11 the
  // recipient index never read `disabledAt`, so a disabled user still matched
  // by role / region / tag / name and kept getting email and web push.
  it("stops being an alert recipient and loses its push devices; enabling brings the recipient back", async () => {
    const role = await prisma.role.findUnique({ where: { name: "readonly" } });
    await prisma.user.update({ where: { id: userId }, data: { email: "disable-target@example.test" } });
    await prisma.pushSubscription.create({
      data: { userId, endpoint: "https://push.example.test/disable-target", p256dh: "k", auth: "a" },
    });
    bumpRecipientIndex();
    const reached = async () => ({
      byId: (await resolveRecipientUsersByIds([userId])).length,
      byRole: (await resolveUsersByRoles([role!.id])).some((u) => u.id === userId),
      all: (await resolveAllUsers()).some((u) => u.id === userId),
    });
    expect(await reached()).toEqual({ byId: 1, byRole: true, all: true });

    const adm = await authedAgent(app);
    expect((await adm.agent.post(`/api/v1/users/${userId}/disable`).set("X-CSRF-Token", adm.csrf).send({})).status).toBe(200);

    // No bump here: the route must drop the cached index itself.
    expect(await reached()).toEqual({ byId: 0, byRole: false, all: false });
    expect(await prisma.pushSubscription.count({ where: { userId } })).toBe(0);
    const ev = await prisma.event.findFirst({ where: { action: "user.disabled", resourceId: userId }, orderBy: { timestamp: "desc" } });
    expect((ev!.details as { pushDevicesRemoved?: number }).pushDevicesRemoved).toBe(1);

    expect((await adm.agent.post(`/api/v1/users/${userId}/enable`).set("X-CSRF-Token", adm.csrf).send({})).status).toBe(200);
    expect(await reached()).toEqual({ byId: 1, byRole: true, all: true });
    // The device does not come back by itself — the browser re-subscribes (rule 39).
    expect(await prisma.pushSubscription.count({ where: { userId } })).toBe(0);
  });

  it("refuses to disable yourself", async () => {
    const adm = await authedAgent(app);
    const { username } = await ensureTestUser();
    const me = await prisma.user.findUnique({ where: { username } });
    const r = await adm.agent.post(`/api/v1/users/${me!.id}/disable`).set("X-CSRF-Token", adm.csrf).send({});
    expect(r.status).toBe(400);
  });

  it("the session recheck ends a session whose account was disabled behind its back", async () => {
    const session: any = {
      userId,
      roleId: "x",
      checkedAt: 0,
      regenerate(cb: () => void) { this.userId = undefined; cb(); },
    };
    await prisma.user.update({ where: { id: userId }, data: { disabledAt: new Date() } });
    await new Promise<void>((resolve) => revalidateSessionUser({ session } as any, {} as any, () => resolve()));
    expect(session.userId).toBeUndefined();
  });
});

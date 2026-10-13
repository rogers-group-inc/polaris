/**
 * tests/integration/rbacLeftovers.test.ts
 *
 * Business rule 114, end to end against a real database:
 *   (a) an alert group's script action needs Automation Scripts Read-Write
 *   (f) GET /utilization carries recent reservations only for reservations:read
 *   (g) roles:write grants only up to the caller's own level; an edit that
 *       leaves a stronger key alone is still allowed
 *   (h) api_call headers come back masked; a save that echoes the mask keeps
 *       the stored value; a changed url with a masked header is refused
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { SECRET_MASK } from "../../src/utils/secretMask.js";
import { dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "rbac114-test";
const PASSWORD = "rbac114-password-not-real";

function matrix(base: string, overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) out[key] = overrides[key] ?? base;
  return out;
}

async function createRoleUser(suffix: string, permissions: Record<string, string>): Promise<string> {
  const role = await prisma.role.create({ data: { name: PFX + "-role-" + suffix, permissions } });
  const username = PFX + "-user-" + suffix;
  await prisma.user.create({
    data: { username, passwordHash: await hashPassword(PASSWORD), roleId: role.id, authProvider: "local" },
  });
  return username;
}

type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
const sessions = new Map<string, Session>();

async function loginAs(username: string): Promise<Session> {
  const cached = sessions.get(username);
  if (cached) return cached;
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const resp = await agent.post("/api/v1/auth/login").send({ username, password: PASSWORD }).set("Content-Type", "application/json");
  if (resp.status !== 200) throw new Error("login as " + username + " failed (" + resp.status + "): " + JSON.stringify(resp.body));
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  if (!csrf) throw new Error("CSRF cookie not set after login");
  const s = { agent, csrf };
  sessions.set(username, s);
  return s;
}

let automationsUser = "";
let delegate = "";
let blocksReader = "";
let admin = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await prisma.alertGroup.deleteMany({ where: { name: { startsWith: PFX } } });
  automationsUser = await createRoleUser("auto", matrix("read", { automationManagement: "write" }));
  delegate = await createRoleUser("delegate", matrix("read", { roles: "write", assets: "write" }));
  blocksReader = await createRoleUser("blocks", matrix("none", { ipBlocks: "read" }));
  admin = await createRoleUser("admin", matrix("fullwrite"));
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.alertGroup.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.$disconnect();
});

d("alert groups (114(a), 114(h))", () => {
  it("refuses a script action without Automation Scripts Read-Write", async () => {
    const { agent, csrf } = await loginAs(automationsUser);
    const res = await agent.post("/api/v1/automations/groups").set("X-CSRF-Token", csrf).send({
      name: PFX + "-script", actions: [{ type: "script", scriptId: "anything", runOn: "server" }],
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/Automation Scripts/);
  });

  it("masks api_call headers, keeps the stored value on an echo, and refuses a masked header on a new url", async () => {
    const { agent, csrf } = await loginAs(automationsUser);
    const url = "https://hooks.example.com/rbac114";
    const created = await agent.post("/api/v1/automations/groups").set("X-CSRF-Token", csrf).send({
      name: PFX + "-api", actions: [{ type: "api_call", method: "POST", url, headers: { Authorization: "Bearer real-token" }, timeoutSec: 15 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id ?? created.body.group?.id;
    expect(JSON.stringify(created.body)).not.toContain("real-token");

    const got = await agent.get(`/api/v1/automations/groups/${id}`);
    const action = (got.body.group ?? got.body).actions[0];
    expect(action.headers.Authorization).toBe(SECRET_MASK);

    // Echo the masked form back with a rename: the stored token survives.
    const echoed = await agent.put(`/api/v1/automations/groups/${id}`).set("X-CSRF-Token", csrf).send({
      name: PFX + "-api-renamed", actions: [action],
    });
    expect(echoed.status, JSON.stringify(echoed.body)).toBe(200);
    const row = await prisma.alertGroup.findUnique({ where: { id } });
    expect((row!.actions as any)[0].headers.Authorization).toBe("Bearer real-token");

    // The same masked header aimed at another url has nothing to restore from.
    const moved = await agent.put(`/api/v1/automations/groups/${id}`).set("X-CSRF-Token", csrf).send({
      name: PFX + "-api-renamed", actions: [{ ...action, url: "https://collector.example.net/x" }],
    });
    expect(moved.status).toBe(400);
    expect(JSON.stringify(moved.body)).toMatch(/enter the header value again/);
  });
});

d("roles (114(g))", () => {
  it("refuses a role granting a key above the caller's own level", async () => {
    const { agent, csrf } = await loginAs(delegate);
    const res = await agent.post("/api/v1/roles").set("X-CSRF-Token", csrf).send({
      name: PFX + "-scripts", permissions: matrix("none", { automationScripts: "write" }),
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/automationScripts=write/);
  });

  it("allows a role within the caller's level", async () => {
    const { agent, csrf } = await loginAs(delegate);
    const res = await agent.post("/api/v1/roles").set("X-CSRF-Token", csrf).send({
      name: PFX + "-assets", permissions: matrix("none", { assets: "write" }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("allows editing a role that already holds a stronger key, as long as the edit does not raise one", async () => {
    const strong = await prisma.role.create({ data: { name: PFX + "-strong", permissions: matrix("none", { automationScripts: "write", assets: "read" }) } });
    const { agent, csrf } = await loginAs(delegate);
    const ok = await agent.put(`/api/v1/roles/${strong.id}`).set("X-CSRF-Token", csrf).send({
      permissions: matrix("none", { automationScripts: "write", assets: "write" }),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const raised = await agent.put(`/api/v1/roles/${strong.id}`).set("X-CSRF-Token", csrf).send({
      permissions: matrix("none", { automationScripts: "write", assets: "write", serverSettingsData: "write" }),
    });
    expect(raised.status).toBe(403);
  });
});

d("role grant review (114(i))", () => {
  it("only a caller who could grant the role's access may mark it reviewed; saving the role clears it too", async () => {
    const flagged = await prisma.role.create({
      data: { name: PFX + "-flagged", permissions: matrix("none", { automationScripts: "write" }), grantReviewNeeded: true },
    });
    const del = await loginAs(delegate);
    const refused = await del.agent.post(`/api/v1/roles/${flagged.id}/grant-review`).set("X-CSRF-Token", del.csrf);
    expect(refused.status).toBe(403);

    const adm = await loginAs(admin);
    const listed = await adm.agent.get("/api/v1/roles");
    expect((listed.body as Array<{ id: string; grantReviewNeeded: boolean }>).find((r) => r.id === flagged.id)?.grantReviewNeeded).toBe(true);
    const ok = await adm.agent.post(`/api/v1/roles/${flagged.id}/grant-review`).set("X-CSRF-Token", adm.csrf);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await prisma.role.findUnique({ where: { id: flagged.id } }))!.grantReviewNeeded).toBe(false);

    await prisma.role.update({ where: { id: flagged.id }, data: { grantReviewNeeded: true } });
    const saved = await adm.agent.put(`/api/v1/roles/${flagged.id}`).set("X-CSRF-Token", adm.csrf)
      .send({ permissions: matrix("none", { automationScripts: "write" }) });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await prisma.role.findUnique({ where: { id: flagged.id } }))!.grantReviewNeeded).toBe(false);
  });
});

d("utilization (114(f))", () => {
  it("omits recent reservations for a caller without reservations:read", async () => {
    const { agent } = await loginAs(blocksReader);
    const res = await agent.get("/api/v1/utilization");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("recentReservations");
  });
});

/**
 * tests/integration/rbacPhase11.test.ts — the RBAC gaps the 2026-10-13
 * re-scan found (phase 11): group mappings (F5/F65), demoting an
 * admin-equivalent role (F76), the `quarantined` status outside the
 * quarantine endpoints (F61), the tag-filter preview's device sample (F78),
 * a stored alert-group script reached by a membership / scope change (F56),
 * and row ownership surviving a deleted account (F85).
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import { ownershipTombstone } from "../../src/services/userOwnershipService.js";

const d = dbDescribe;
const PFX = "rbac11-test";
const PASSWORD = "rbac11-password-not-real";

function matrix(base: string, overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) out[key] = overrides[key] ?? base;
  return out;
}
async function createRole(suffix: string, permissions: Record<string, string>) {
  return prisma.role.create({ data: { name: PFX + "-role-" + suffix, permissions } });
}
async function createRoleUser(suffix: string, permissions: Record<string, string>): Promise<string> {
  const role = await createRole(suffix, permissions);
  const username = PFX + "-user-" + suffix;
  await prisma.user.create({ data: { username, passwordHash: await hashPassword(PASSWORD), roleId: role.id, authProvider: "local" } });
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
  if (resp.status !== 200) throw new Error("login as " + username + " failed (" + resp.status + ")");
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const s = { agent, csrf: (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "" };
  sessions.set(username, s);
  return s;
}

let admin = "";
let usersFull = "";
let rolesWriter = "";
let assetsWriter = "";
let settingsReader = "";
let automationsWriter = "";
let adminRoleId = "";
let lowRoleId = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await prisma.groupMapping.deleteMany({ where: { groupKey: { startsWith: PFX } } });
  await prisma.alertGroup.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  admin = await createRoleUser("admin", matrix("fullwrite"));
  usersFull = await createRoleUser("usersfull", matrix("read", { users: "fullwrite" }));
  rolesWriter = await createRoleUser("roles", matrix("read", { roles: "write" }));
  assetsWriter = await createRoleUser("assets", matrix("read", { assets: "write" }));
  settingsReader = await createRoleUser("settings", matrix("none", { serverSettingsSystem: "read" }));
  automationsWriter = await createRoleUser("autos", matrix("read", { automationManagement: "write" }));
  adminRoleId = (await createRole("adminish", matrix("fullwrite"))).id;
  lowRoleId = (await createRole("low", matrix("read"))).id;
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.groupMapping.deleteMany({ where: { groupKey: { startsWith: PFX } } });
  await prisma.alertGroup.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.credential.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.$disconnect();
});

d("group mappings — a mapping grants its role (F5/F65)", () => {
  it("refuses a Users Full RW caller mapping a group to an admin-equivalent role", async () => {
    const { agent, csrf } = await loginAs(usersFull);
    const res = await agent.post("/api/v1/group-mappings").set("X-CSRF-Token", csrf)
      .send({ provider: "oidc", groupKey: PFX + "-admins", roleId: adminRoleId });
    expect(res.status).toBe(403);
  });
  it("allows mapping to a role within the caller's access", async () => {
    const { agent, csrf } = await loginAs(usersFull);
    const res = await agent.post("/api/v1/group-mappings").set("X-CSRF-Token", csrf)
      .send({ provider: "oidc", groupKey: PFX + "-readers", roleId: lowRoleId });
    expect(res.status).toBe(201);
  });
  it("refuses retargeting or deleting an admin-equivalent mapping without admin-equivalence", async () => {
    const a = await loginAs(admin);
    const made = await a.agent.post("/api/v1/group-mappings").set("X-CSRF-Token", a.csrf)
      .send({ provider: "oidc", groupKey: PFX + "-real-admins", roleId: adminRoleId });
    expect(made.status).toBe(201);
    const u = await loginAs(usersFull);
    const moved = await u.agent.put(`/api/v1/group-mappings/${made.body.id}`).set("X-CSRF-Token", u.csrf).send({ groupKey: PFX + "-my-group" });
    expect(moved.status).toBe(403);
    const del = await u.agent.delete(`/api/v1/group-mappings/${made.body.id}`).set("X-CSRF-Token", u.csrf);
    expect(del.status).toBe(403);
  });
});

d("roles — taking admin-equivalence away (F76)", () => {
  it("refuses a Roles Read-Write caller demoting an admin-equivalent role", async () => {
    const { agent, csrf } = await loginAs(rolesWriter);
    const res = await agent.put(`/api/v1/roles/${adminRoleId}`).set("X-CSRF-Token", csrf).send({ permissions: matrix("read") });
    expect(res.status).toBe(403);
  });
});

d("assets — the quarantined status belongs to the quarantine endpoints (F61)", () => {
  it("refuses creating an asset already quarantined", async () => {
    const { agent, csrf } = await loginAs(assetsWriter);
    const res = await agent.post("/api/v1/assets").set("X-CSRF-Token", csrf)
      .send({ hostname: PFX + "-q", assetType: "workstation", status: "quarantined", ipAddress: "198.51.100.160" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/quarantine/i);
  });
});

d("tag filter preview — no device names without Assets read (F78)", () => {
  it("returns the count but an empty sample", async () => {
    await prisma.asset.create({ data: { hostname: PFX + "-preview", assetType: "server", status: "active", ipAddress: "198.51.100.161", monitored: false } as never });
    const { agent, csrf } = await loginAs(settingsReader);
    const res = await agent.post("/api/v1/server-settings/tags/preview-criteria").set("X-CSRF-Token", csrf)
      .send({ criteria: { version: 1, match: "all", rules: [{ field: "hostname", op: "exact", values: [PFX + "-preview"] }] } });
    expect(res.status).toBe(200);
    expect(res.body.sample).toEqual([]);
    expect(res.body.sampleHidden).toBe(true);
  });
  it("still names devices for a caller who may list assets", async () => {
    const { agent, csrf } = await loginAs(admin);
    const res = await agent.post("/api/v1/server-settings/tags/preview-criteria").set("X-CSRF-Token", csrf)
      .send({ criteria: { version: 1, match: "all", rules: [{ field: "hostname", op: "exact", values: [PFX + "-preview"] }] } });
    expect(res.status).toBe(200);
    expect(res.body.sampleHidden).toBeUndefined();
    expect(res.body.sample.length).toBeGreaterThan(0);
  });
});

d("alert groups — a stored script reached by a scope change (F56)", () => {
  it("refuses an Automation Management caller re-scoping a group that runs a script", async () => {
    const g = await prisma.alertGroup.create({
      data: { name: PFX + "-scripted", actions: [{ type: "script", scriptId: "00000000-0000-0000-0000-000000000000", runOn: "server" }] as never } as never,
    });
    const { agent, csrf } = await loginAs(automationsWriter);
    const res = await agent.put(`/api/v1/automations/groups/${g.id}`).set("X-CSRF-Token", csrf)
      .send({ name: PFX + "-scripted", scope: { allAssets: true } });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/Automation Scripts/);
  });
});

d("AI Assistant token regeneration — a grant like minting one (F9)", () => {
  it("refuses a caller without the provisioning grants", async () => {
    const botRole = await createRole("llm-bot", matrix("read"));
    const llm = await prisma.integration.create({
      data: { name: PFX + "-llm", type: "llm", enabled: false, config: { provider: "openai", host: "llm.corp.example", port: 443, useHttps: true, model: "m", roleId: botRole.id } as never } as never,
    });
    const user = await createRoleUser("tokens", matrix("read", { integrations: "write", apiTokens: "write" }));
    const { agent, csrf } = await loginAs(user);
    const res = await agent.post(`/api/v1/integrations/${llm.id}/llm/regenerate-token`).set("X-CSRF-Token", csrf).send({});
    expect(res.status).toBe(403);
    await prisma.integration.delete({ where: { id: llm.id } });
  });
});

d("deleting a user tombstones what they owned (F85)", () => {
  it("rewrites createdBy so a new account with the same name owns nothing", async () => {
    const name = PFX + "-leaver";
    const role = await createRole("leaver", matrix("read"));
    const leaver = await prisma.user.create({ data: { username: name, passwordHash: await hashPassword(PASSWORD), roleId: role.id, authProvider: "local" } });
    const cred = await prisma.credential.create({ data: { name: PFX + "-leaver-cred", type: "snmp", config: { version: "v2c", community: "x" } as never, createdBy: name } as never });
    const { agent, csrf } = await loginAs(admin);
    const res = await agent.delete(`/api/v1/users/${leaver.id}`).set("X-CSRF-Token", csrf);
    expect(res.status).toBe(204);
    const after = await prisma.credential.findUnique({ where: { id: cred.id } });
    expect(after!.createdBy).toBe(ownershipTombstone(name, leaver.id));
  });
  it("refuses a local username that could match a tombstone", async () => {
    const { agent, csrf } = await loginAs(admin);
    const res = await agent.post("/api/v1/users").set("X-CSRF-Token", csrf)
      .send({ username: "deleted:" + PFX + "-leaver#abcd1234", password: "Very-Long-Password-123!", roleId: lowRoleId });
    expect(res.status).toBe(400);
  });
});

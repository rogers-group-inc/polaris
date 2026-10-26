/**
 * tests/integration/rebootNoteRoutes.test.ts
 *
 * Business rule 115(d), end to end against a real database: the
 * "Require a reason for every reboot" switch (GET|PUT /server-settings/reboot,
 * serverSettingsSystem=write to change), the `noteRequired` an assets:write
 * user reads from GET /assets/:id/reboot without Server Settings access, the
 * strict reboot-now body, and a booking refused for a blank note while the
 * switch is on — judged before anything about the device.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { invalidateRebootSettingsCache, REBOOT_SETTING_KEY } from "../../src/services/rebootSettingsService.js";
import { dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "rb115d-test";
const PASSWORD = "rb115d-password-not-real";

function matrix(base: string, overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) out[key] = overrides[key] ?? base;
  return out;
}

async function createRoleUser(suffix: string, permissions: Record<string, string>): Promise<string> {
  const role = await prisma.role.create({ data: { name: PFX + "-role-" + suffix, permissions } });
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
  if (resp.status !== 200) throw new Error("login as " + username + " failed (" + resp.status + "): " + JSON.stringify(resp.body));
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  if (!csrf) throw new Error("CSRF cookie not set after login");
  const s = { agent, csrf };
  sessions.set(username, s);
  return s;
}

let settingsAdmin = "";
let rebooter = "";
let assetId = "";

async function resetSetting(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: REBOOT_SETTING_KEY } });
  invalidateRebootSettingsCache();
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await resetSetting();
  settingsAdmin = await createRoleUser("settings", matrix("read", { serverSettingsSystem: "write", assets: "write" }));
  // The person who reboots devices: assets:write, and no Server Settings at all.
  rebooter = await createRoleUser("rebooter", matrix("read", { serverSettingsSystem: "none", assets: "write" }));
  // Not rebootable (rule 115 refuses a printer) — what the tests below need
  // is which refusal comes FIRST.
  const asset = await prisma.asset.create({ data: { hostname: PFX + "-printer", assetType: "printer", status: "active" } });
  assetId = asset.id;
});

afterAll(async () => {
  if (!dbReachable) return;
  await resetSetting();
  await prisma.event.deleteMany({ where: { resourceName: REBOOT_SETTING_KEY, actor: { startsWith: PFX } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.$disconnect();
});

d("the reboot reason (rule 115(d))", () => {
  it("is optional until the switch is turned on, and only Server Settings write may turn it on", async () => {
    const admin = await loginAs(settingsAdmin);
    const before = await admin.agent.get("/api/v1/server-settings/reboot");
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ reboot: { requireNote: false } });

    const weak = await loginAs(rebooter);
    const denied = await weak.agent.put("/api/v1/server-settings/reboot").set("X-CSRF-Token", weak.csrf).send({ requireNote: true });
    expect(denied.status).toBe(403);

    const bad = await admin.agent.put("/api/v1/server-settings/reboot").set("X-CSRF-Token", admin.csrf).send({ requireNote: "yes" });
    expect(bad.status).toBe(400);

    const on = await admin.agent.put("/api/v1/server-settings/reboot").set("X-CSRF-Token", admin.csrf).send({ requireNote: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toEqual({ reboot: { requireNote: true } });
    const ev = await prisma.event.findFirst({ where: { action: "setting.reboot_updated", actor: settingsAdmin }, orderBy: { timestamp: "desc" } });
    expect(ev?.message).toMatch(/now required/);
  });

  it("tells a user who may reboot but cannot open Server Settings that a reason is required", async () => {
    const { agent } = await loginAs(rebooter);
    const res = await agent.get(`/api/v1/assets/${assetId}/reboot`);
    expect(res.status).toBe(200);
    expect(res.body.noteRequired).toBe(true);
  });

  it("accepts only a note on a reboot-now", async () => {
    const { agent, csrf } = await loginAs(rebooter);
    const res = await agent.post(`/api/v1/assets/${assetId}/reboot`).set("X-CSRF-Token", csrf).send({ force: true });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/takes only a note/);
  });

  it("refuses a booking with a blank reason while required, before anything about the device", async () => {
    const { agent, csrf } = await loginAs(rebooter);
    const when = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const blank = await agent.post(`/api/v1/assets/${assetId}/reboot/schedules`).set("X-CSRF-Token", csrf)
      .send({ scheduledFor: when, notifyEmails: ["noc@example.invalid"], note: "   " });
    expect(blank.status).toBe(400);
    expect(JSON.stringify(blank.body)).toMatch(/requires a reboot note/);

    const given = await agent.post(`/api/v1/assets/${assetId}/reboot/schedules`).set("X-CSRF-Token", csrf)
      .send({ scheduledFor: when, notifyEmails: ["noc@example.invalid"], note: "Paper jam firmware" });
    expect(given.status).toBe(400);
    expect(JSON.stringify(given.body)).not.toMatch(/reboot note/);
    expect(JSON.stringify(given.body)).toMatch(/Polaris can reboot/);
    expect(await prisma.rebootSchedule.count({ where: { assetId } })).toBe(0);
  });
});

/**
 * tests/integration/rebootAutomationAction.test.ts
 *
 * Business rule 115(c), end to end against a real database: an automation
 * (or alert group) carrying a `reboot` action saves only for a caller holding
 * assets:write — the grant that reboots a device by hand — and a reboot is
 * refused on the reset list. A memory-utilization trigger is the shape the
 * action exists for.
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

const d = dbDescribe;
const PFX = "rb115c-test";
const PASSWORD = "rb115c-password-not-real";

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

const reboot = { type: "reboot", when: "at", at: "02:00", notifyEmails: ["noc@example.invalid"], minGapHours: 24 };
const memRule = (name: string, extra: Record<string, unknown> = {}) => ({
  name: PFX + "-" + name,
  severity: "warning",
  trigger: { type: "asset_metric", metric: "memPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90, forDurationSec: 900 },
  scope: { allAssets: true },
  reset: { mode: "auto" },
  actions: [{ type: "event" }, reboot],
  ...extra,
});

let noReboot = "";
let canReboot = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await prisma.notificationRule.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.alertGroup.deleteMany({ where: { name: { startsWith: PFX } } });
  noReboot = await createRoleUser("noreboot", matrix("read", { automationManagement: "write" }));
  canReboot = await createRoleUser("reboot", matrix("read", { automationManagement: "write", assets: "write" }));
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.notificationRule.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.alertGroup.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.$disconnect();
});

d("the reboot automation action (115(c))", () => {
  it("refuses an automation with a reboot action from a caller without assets:write", async () => {
    const { agent, csrf } = await loginAs(noReboot);
    const res = await agent.post("/api/v1/automations").set("X-CSRF-Token", csrf).send(memRule("refused"));
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/reboot action requires Read-Write on Assets/);
  });

  it("saves it for a caller with assets:write, and reads it back intact", async () => {
    const { agent, csrf } = await loginAs(canReboot);
    const res = await agent.post("/api/v1/automations").set("X-CSRF-Token", csrf).send(memRule("saved"));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const stored = await prisma.notificationRule.findFirst({ where: { name: PFX + "-saved" }, select: { actions: true } });
    expect((stored!.actions as Array<{ type: string }>).find((a) => a.type === "reboot")).toEqual(reboot);
  });

  it("refuses a reboot on the reset list", async () => {
    const { agent, csrf } = await loginAs(canReboot);
    const res = await agent.post("/api/v1/automations").set("X-CSRF-Token", csrf).send(memRule("reset", { resetActions: [reboot] }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/cannot run when the alert recovers/);
  });

  it("gates an alert group's reboot action the same way", async () => {
    const weak = await loginAs(noReboot);
    const res = await weak.agent.post("/api/v1/automations/groups").set("X-CSRF-Token", weak.csrf).send({ name: PFX + "-group", actions: [reboot] });
    expect(res.status).toBe(403);
  });
});

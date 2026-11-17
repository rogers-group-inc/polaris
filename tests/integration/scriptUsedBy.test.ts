/**
 * tests/integration/scriptUsedBy.test.ts
 *
 * GET /api/v1/automations/scripts — the Scripts tab's "Used by" pills — against
 * a real database: each script carries `usedBy`, the automations and alert
 * groups whose actions run it (an escalation tier counts), only for a caller
 * who may read automations; a scripts-only reader gets the registry without it.
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
const PFX = "scriptusedby-test";
const PASSWORD = "scriptusedby-password-not-real";

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
async function loginAs(username: string) {
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const resp = await agent.post("/api/v1/auth/login").send({ username, password: PASSWORD }).set("Content-Type", "application/json");
  if (resp.status !== 200) throw new Error("login as " + username + " failed (" + resp.status + ")");
  return agent;
}

let usedId = "";
let unusedId = "";
let scriptsOnly = "";
let automationReader = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  const used = await prisma.automationScript.create({ data: { name: PFX + "-used", interpreter: "bash", body: "true", sha256: "0" } });
  const unused = await prisma.automationScript.create({ data: { name: PFX + "-unused", interpreter: "bash", body: "true", sha256: "0" } });
  usedId = used.id;
  unusedId = unused.id;
  const scriptAction = { type: "script", scriptId: usedId, runOn: "server" };
  await prisma.notificationRule.create({
    data: {
      name: PFX + "-direct", enabled: true, severity: "warning",
      trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" } as never,
      scope: {} as never, actions: [scriptAction] as never,
    },
  });
  // Only in an escalation tier, and disabled: still a user of the script.
  await prisma.notificationRule.create({
    data: {
      name: PFX + "-tier", enabled: false, severity: "warning",
      trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" } as never,
      scope: {} as never,
      actions: [{ type: "notify", channelId: "no-such-channel", escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 10, actions: [scriptAction] }] } }] as never,
    },
  });
  scriptsOnly = await createRoleUser("scripts", matrix("none", { automationScripts: "read" }));
  automationReader = await createRoleUser("both", matrix("none", { automationScripts: "read", automationManagement: "read" }));
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.notificationRule.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.automationScript.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.$disconnect();
});

d("GET /automations/scripts usedBy", () => {
  it("names every automation that runs the script, an escalation tier and a disabled one included", async () => {
    const res = await (await loginAs(automationReader)).get("/api/v1/automations/scripts");
    expect(res.status).toBe(200);
    const byId = new Map((res.body.scripts as Array<Record<string, any>>).map((s) => [s.id, s]));
    const users = (byId.get(usedId)!.usedBy as Array<Record<string, unknown>>).filter((u) => String(u.name).startsWith(PFX));
    expect(users.map((u) => [u.kind, u.name, u.enabled])).toEqual([
      ["automation", PFX + "-direct", true],
      ["automation", PFX + "-tier", false],
    ]);
    expect(byId.get(unusedId)!.usedBy).toEqual([]);
  });

  it("leaves usedBy out for a reader who may not see automations", async () => {
    const res = await (await loginAs(scriptsOnly)).get("/api/v1/automations/scripts");
    expect(res.status).toBe(200);
    const mine = (res.body.scripts as Array<Record<string, any>>).find((s) => s.id === usedId)!;
    expect(mine).toBeTruthy();
    expect(mine).not.toHaveProperty("usedBy");
  });
});

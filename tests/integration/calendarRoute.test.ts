/**
 * tests/integration/calendarRoute.test.ts
 *
 * GET /api/v1/calendar — the Events page's Calendar tab — against a real
 * database: the route is events:read, and each kind comes back only for a
 * caller holding that kind's own read key (maintenanceManagement for windows,
 * assets for reboots and firmware); a kind the caller may not read is null.
 * A booking and a reboot-now on one asset both land on the right day.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { formatLocalIsoMinute } from "../../src/utils/maintenanceRecurrence.js";
import { dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "opscal-test";
const PASSWORD = "opscal-password-not-real";

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

const day = (dt: Date) => formatLocalIsoMinute(dt).slice(0, 10);
let assetId = "";
let eventsOnly = "";
let assetsReader = "";
let everything = "";
let noEvents = "";
const bookedFor = new Date(Date.now() + 2 * 24 * 3_600_000);
const ranAt = new Date(Date.now() - 24 * 3_600_000);

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  const asset = await prisma.asset.create({ data: { hostname: PFX + "-fgt", assetType: "firewall", status: "active" } });
  assetId = asset.id;
  await prisma.rebootSchedule.create({ data: { assetId, scheduledFor: bookedFor, notifyEmails: ["noc@example.invalid"], createdBy: "automation:Memory over 90%" } });
  await prisma.rebootRun.create({ data: { assetId, method: "fortigate-rest", authority: "test", status: "succeeded", startedBy: "dmoore", startedAt: ranAt, finishedAt: new Date(ranAt.getTime() + 5 * 60_000) } });
  eventsOnly = await createRoleUser("events", matrix("none", { events: "read" }));
  assetsReader = await createRoleUser("assets", matrix("none", { events: "read", assets: "read" }));
  everything = await createRoleUser("all", matrix("none", { events: "read", assets: "read", maintenanceManagement: "read" }));
  noEvents = await createRoleUser("noevents", matrix("none", { assets: "read" }));
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.$disconnect();
});

d("GET /calendar", () => {
  const range = () => `/api/v1/calendar?from=${day(ranAt)}&to=${day(bookedFor)}`;

  it("needs events:read", async () => {
    const agent = await loginAs(noEvents);
    expect((await agent.get(range())).status).toBe(403);
  });

  it("gives an events-only caller no kinds at all — null, not empty", async () => {
    const res = await (await loginAs(eventsOnly)).get(range());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ maintenance: null, reboot: null, firmware: null });
  });

  it("gives an assets reader reboots and firmware, and no maintenance", async () => {
    const res = await (await loginAs(assetsReader)).get(range());
    expect(res.status).toBe(200);
    expect(res.body.maintenance).toBeNull();
    expect(Array.isArray(res.body.firmware)).toBe(true);
    const mine = (res.body.reboot as Array<Record<string, any>>).filter((i) => i.assetId === assetId);
    expect(mine).toHaveLength(2);
    const booking = mine.find((i) => i.booked)!;
    expect(booking).toMatchObject({ status: "pending", by: "automation:Memory over 90%", assetName: PFX + "-fgt", start: formatLocalIsoMinute(bookedFor) });
    const run = mine.find((i) => !i.booked)!;
    expect(run).toMatchObject({ status: "succeeded", by: "dmoore", start: formatLocalIsoMinute(ranAt) });
  });

  it("gives a caller with every key every kind", async () => {
    const res = await (await loginAs(everything)).get(range());
    expect(Array.isArray(res.body.maintenance)).toBe(true);
    expect(Array.isArray(res.body.reboot)).toBe(true);
  });

  it("refuses a malformed range", async () => {
    const res = await (await loginAs(everything)).get("/api/v1/calendar?from=yesterday&to=today");
    expect(res.status).toBe(400);
  });
});

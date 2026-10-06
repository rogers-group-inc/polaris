/**
 * tests/integration/firmwareSchedule.test.ts
 *
 * Route-level contract for scheduled firmware upgrades (business rule 93),
 * against a real database: who may book, change and cancel (assets:write; a
 * reader sees the booking on the card and may not touch it), the pending
 * booking riding the availability read, the database's own guarantees (one
 * pending booking per asset, never a booking nobody hears about), and the
 * job's tick firing a due booking through the REAL startFirmwareUpgrade —
 * whose last gate (the image file on disk) refuses it here, which is exactly
 * the refused-and-recorded path, with no device and no socket.
 *
 * Runs only with a reachable DATABASE_URL (dbDescribe). Every row this suite
 * makes is removed at the end.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { runDueSchedules } from "../../src/services/firmwareScheduleService.js";
import { dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "fwsched-test";
const PASSWORD = "fwsched-password-not-real";
const MFR = "Fortinet";
const MODEL = "FortiSwitch S108FF fwsched";

function matrix(base: string, overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) out[key] = overrides[key] ?? base;
  return out;
}

async function createRoleUser(suffix: string, permissions: Record<string, string>, email: string | null): Promise<string> {
  const role = await prisma.role.create({ data: { name: PFX + "-role-" + suffix, permissions } });
  const username = PFX + "-user-" + suffix;
  await prisma.user.create({ data: { username, email, passwordHash: await hashPassword(PASSWORD), roleId: role.id, authProvider: "local" } });
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
  if (resp.status !== 200) throw new Error(`login failed for ${username}: ${resp.status} ${JSON.stringify(resp.body)}`);
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  if (!csrf) throw new Error("CSRF cookie not set after login");
  const s = { agent, csrf };
  sessions.set(username, s);
  return s;
}

let readerU: string, flasherU: string;
let assetId: string, imageId: string, credId: string;

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

d("scheduled firmware upgrade routes", () => {
  beforeAll(async () => {
    if (!dbReachable) return;
    await ensureTestUser();
    readerU  = await createRoleUser("reader",  matrix("read"), null);
    flasherU = await createRoleUser("flasher", matrix("read", { assets: "write" }), "Flasher@Example.com");
    // Unmonitored: the health gate has nothing to refuse, so the fire-time
    // refusal below comes from the image file, the start's last gate.
    const a = await prisma.asset.create({
      data: { hostname: "fwsched-sw1", assetType: "switch", model: MODEL, serialNumber: "S108FFTF23009991", manufacturer: MFR, ipAddress: "192.0.2.91", osVersion: "7.4.3 build0542", monitored: false },
    });
    assetId = a.id;
    const img = await prisma.firmwareImage.create({
      data: {
        manufacturer: MFR, assetType: "switch", model: MODEL, platform: "S108FF", versionMajor: 7, versionMinor: 6, versionPatch: 8, build: 1164,
        versionLabel: "7.6.8 build1164", parsedFrom: "header", role: "primary", filename: "fwsched.out", sizeBytes: 2048,
        sha256: "fwsched-" + Date.now(), storagePath: "fwsched-missing.out",
      },
    });
    imageId = img.id;
    const cred = await prisma.credential.create({ data: { name: PFX + "-login", type: "http", config: { authMode: "form", username: "admin", password: "pw" }, createdBy: flasherU } });
    credId = cred.id;
    await prisma.firmwareCredentialBinding.create({ data: { manufacturer: MFR, assetType: "switch", model: MODEL, credentialId: credId } });
  });

  afterAll(async () => {
    if (!dbReachable) return;
    await prisma.firmwareUpgradeSchedule.deleteMany({ where: { assetId } });
    await prisma.firmwareUpgradeRun.deleteMany({ where: { assetId } });
    await prisma.firmwareCredentialBinding.deleteMany({ where: { manufacturer: MFR, model: MODEL } });
    await prisma.firmwareImage.deleteMany({ where: { id: imageId } });
    await prisma.asset.deleteMany({ where: { id: assetId } });
    await prisma.credential.deleteMany({ where: { name: PFX + "-login" } });
    await prisma.event.deleteMany({ where: { resourceId: assetId } });
    await prisma.user.deleteMany({ where: { username: { startsWith: PFX + "-user-" } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: PFX + "-role-" } } });
  });

  it("book at assets:write (the reader is refused), see it on the card, change it, cancel it", async () => {
    const reader = await loginAs(readerU);
    const flasher = await loginAs(flasherU);
    const base = `/api/v1/assets/${assetId}/firmware-upgrade`;

    expect((await reader.agent.post(`${base}/schedules`).set("X-CSRF-Token", reader.csrf).send({ imageId, scheduledFor: inHours(5), notifyEmails: ["a@example.com"] })).status).toBe(403);

    const defaults = await flasher.agent.get(`${base}/schedules/defaults`);
    expect(defaults.status).toBe(200);
    expect(defaults.body.notifyEmails).toEqual(["flasher@example.com"]);

    // A time in the past, an empty list, a bad address — each a 400 naming why.
    expect((await flasher.agent.post(`${base}/schedules`).set("X-CSRF-Token", flasher.csrf).send({ imageId, scheduledFor: inHours(-1), notifyEmails: ["a@example.com"] })).body.error).toMatch(/at least a minute/);
    expect((await flasher.agent.post(`${base}/schedules`).set("X-CSRF-Token", flasher.csrf).send({ imageId, scheduledFor: inHours(5), notifyEmails: [] })).body.error).toMatch(/at least one email/);
    expect((await flasher.agent.post(`${base}/schedules`).set("X-CSRF-Token", flasher.csrf).send({ imageId, scheduledFor: inHours(5), notifyEmails: ["nope"] })).body.error).toMatch(/not an email address/);
    // A naive local time with no offset is ambiguous across zones — refused.
    expect((await flasher.agent.post(`${base}/schedules`).set("X-CSRF-Token", flasher.csrf).send({ imageId, scheduledFor: "2030-01-01T02:00", notifyEmails: ["a@example.com"] })).status).toBe(400);

    const created = await flasher.agent.post(`${base}/schedules`).set("X-CSRF-Token", flasher.csrf).send({ imageId, scheduledFor: inHours(5), notifyEmails: ["flasher@example.com", "NOC@example.com"] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sid = created.body.schedule.id;
    expect(created.body.schedule).toMatchObject({ status: "pending", toVersion: "7.6.8 build1164", notifyEmails: ["flasher@example.com", "noc@example.com"], createdBy: flasherU });
    // The device has an address and is unmonitored: nothing blocks it right now.
    expect(created.body.schedule.warnings).toEqual([]);

    const dup = await flasher.agent.post(`${base}/schedules`).set("X-CSRF-Token", flasher.csrf).send({ imageId, scheduledFor: inHours(6), notifyEmails: ["a@example.com"] });
    expect(dup.status).toBe(409);

    // The card's one read carries the booking; a reader sees it.
    const card = await reader.agent.get(base);
    expect(card.status).toBe(200);
    expect(card.body.schedule).toMatchObject({ id: sid, status: "pending" });

    expect((await reader.agent.patch(`${base}/schedules/${sid}`).set("X-CSRF-Token", reader.csrf).send({ scheduledFor: inHours(7) })).status).toBe(403);
    const moved = await flasher.agent.patch(`${base}/schedules/${sid}`).set("X-CSRF-Token", flasher.csrf).send({ scheduledFor: inHours(7) });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(new Date(moved.body.schedule.scheduledFor).getTime()).toBeGreaterThan(Date.now() + 6.5 * 3_600_000);

    expect((await reader.agent.delete(`${base}/schedules/${sid}`).set("X-CSRF-Token", reader.csrf)).status).toBe(403);
    const cancelled = await flasher.agent.delete(`${base}/schedules/${sid}`).set("X-CSRF-Token", flasher.csrf);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.schedule).toMatchObject({ status: "cancelled", cancelledBy: flasherU });
    expect((await flasher.agent.delete(`${base}/schedules/${sid}`).set("X-CSRF-Token", flasher.csrf)).status).toBe(409);
    expect((await reader.agent.get(base)).body.schedule).toBeNull();

    const list = await reader.agent.get(`${base}/schedules`);
    expect(list.body.schedules.map((s: { status: string }) => s.status)).toEqual(["cancelled"]);

    const actions = (await prisma.event.findMany({ where: { resourceId: assetId }, select: { action: true } })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["firmware.upgrade_scheduled", "firmware.upgrade_rescheduled", "firmware.upgrade_schedule_cancelled"]));
  });

  it("the database refuses a second pending booking and a booking with nobody to tell", async () => {
    const base = { assetId, imageId, toVersion: "7.6.8 build1164", scheduledFor: new Date(Date.now() + 3_600_000), createdBy: "test" };
    const first = await prisma.firmwareUpgradeSchedule.create({ data: { ...base, notifyEmails: ["a@example.com"] } });
    await expect(prisma.firmwareUpgradeSchedule.create({ data: { ...base, notifyEmails: ["a@example.com"] } })).rejects.toMatchObject({ code: "P2002" });
    await expect(prisma.firmwareUpgradeSchedule.create({ data: { ...base, status: "cancelled", notifyEmails: [] } })).rejects.toThrow();
    // A cancelled one beside a pending one is fine — history accumulates.
    await prisma.firmwareUpgradeSchedule.create({ data: { ...base, status: "cancelled", notifyEmails: ["a@example.com"] } });
    await prisma.firmwareUpgradeSchedule.deleteMany({ where: { assetId } });
    expect(first.status).toBe("pending");
  });

  it("the job's tick fires a due booking through the real start; its refusal is recorded, logged, and reported", async () => {
    const s = await prisma.firmwareUpgradeSchedule.create({
      data: { assetId, imageId, toVersion: "7.6.8 build1164", scheduledFor: new Date(Date.now() - 30_000), notifyEmails: ["flasher@example.com"], createdBy: flasherU },
    });
    const res = await runDueSchedules(new Date());
    expect(res.refused).toBeGreaterThanOrEqual(1);
    const after = await prisma.firmwareUpgradeSchedule.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.status).toBe("refused");
    expect(after.error).toMatch(/missing from disk/);
    expect(after.firedAt).toBeInstanceOf(Date);
    expect(after.notifiedAt).toBeInstanceOf(Date);
    // No run was created: the refusal came before the run row.
    expect(await prisma.firmwareUpgradeRun.count({ where: { assetId } })).toBe(0);
    const ev = await prisma.event.findFirst({ where: { resourceId: assetId, action: "firmware.upgrade_schedule_refused" } });
    expect(ev?.message).toMatch(/was not started/);
    // A second tick does nothing more with it.
    await runDueSchedules(new Date());
    expect((await prisma.firmwareUpgradeSchedule.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("refused");
  });

  it("deleting the asset takes its bookings with it", async () => {
    const tmp = await prisma.asset.create({ data: { hostname: "fwsched-tmp", assetType: "switch", manufacturer: MFR } });
    await prisma.firmwareUpgradeSchedule.create({ data: { assetId: tmp.id, imageId, toVersion: "x", scheduledFor: new Date(Date.now() + 3_600_000), notifyEmails: ["a@example.com"], createdBy: "test" } });
    await prisma.asset.delete({ where: { id: tmp.id } });
    expect(await prisma.firmwareUpgradeSchedule.count({ where: { assetId: tmp.id } })).toBe(0);
  });
});

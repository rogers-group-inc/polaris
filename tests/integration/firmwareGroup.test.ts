/**
 * tests/integration/firmwareGroup.test.ts
 *
 * Route-level contract for GROUP firmware upgrades (business rule 122),
 * against a real database:
 *   - who may read the grouping / book / cancel (assets:read vs assets:write);
 *   - the sources read splits a selection by controlling FortiGate;
 *   - the plan orders deepest first from asset_dependency_parents and drops a
 *     device already on its primary image;
 *   - booking supersedes a pending single-device booking only when the
 *     operator confirmed it, and a single-device booking is then refused;
 *   - one pending / running group per FortiGate (service 409 + partial unique);
 *   - the job's tick runs a due group through the REAL startFirmwareUpgrade,
 *     whose last gate (the image file on disk) refuses the switch — so it
 *     fails, the FortiGate above it is skipped as upstream, and the group
 *     completes. No device and no socket.
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
import { runDueGroupSchedules } from "../../src/services/firmwareGroupService.js";
import { dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "fwgroup-test";
const PASSWORD = "fwgroup-password-not-real";
const MFR = "Fortinet";

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
const ids: Record<string, string> = {};
const imageIds: string[] = [];
let credId: string;

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const BASE = "/api/v1/assets/firmware-groups";

d("group firmware upgrade routes", () => {
  beforeAll(async () => {
    if (!dbReachable) return;
    await ensureTestUser();
    readerU  = await createRoleUser("reader",  matrix("read"), null);
    flasherU = await createRoleUser("flasher", matrix("read", { assets: "write" }), "Flasher@Example.com");

    // Unmonitored: the live health gate has nothing to refuse, so the job's
    // refusal below comes from the image file, the start's last gate.
    const mk = (hostname: string, assetType: string, serialNumber: string, osVersion: string, fortinetTopology: object) =>
      prisma.asset.create({ data: { hostname, assetType, serialNumber, manufacturer: MFR, ipAddress: "192.0.2." + (Object.keys(ids).length + 120), osVersion, monitored: false, fortinetTopology } });
    ids.gateA = (await mk("fwgroup-gateA", "firewall", "FG60FTK0FWG00001", "7.4.5 build2702", { role: "fortigate", deviceName: "fwgroup-gateA" })).id;
    ids.gateB = (await mk("fwgroup-gateB", "firewall", "FG60FTK0FWG00002", "7.4.5 build2702", { role: "fortigate", deviceName: "fwgroup-gateB" })).id;
    ids.sw1 = (await mk("fwgroup-sw1", "switch", "S108FFTF2300FWG1", "7.4.3 build0542", { role: "fortiswitch", controllerSerial: "FG60FTK0FWG00001" })).id;
    ids.sw2 = (await mk("fwgroup-sw2", "switch", "S108FFTF2300FWG2", "7.6.8 build1164", { role: "fortiswitch", controllerSerial: "FG60FTK0FWG00001" })).id;
    ids.swB = (await mk("fwgroup-swB", "switch", "S108FFTF2300FWG3", "7.4.3 build0542", { role: "fortiswitch", controllerSerial: "FG60FTK0FWG00002" })).id;
    ids.ap1 = (await mk("fwgroup-ap1", "access_point", "FP231FTF2000FWG1", "7.4.0 build0600", { role: "fortiap", controllerSerial: "FG60FTK0FWG00001" })).id;

    await prisma.assetDependencyParent.createMany({
      data: [
        { assetId: ids.ap1, parentAssetId: ids.sw1, source: "computed", detectedVia: "lldp" },
        { assetId: ids.sw1, parentAssetId: ids.gateA, source: "computed", detectedVia: "controller" },
        { assetId: ids.sw2, parentAssetId: ids.gateA, source: "computed", detectedVia: "controller" },
        { assetId: ids.swB, parentAssetId: ids.gateB, source: "computed", detectedVia: "controller" },
      ],
    });

    const img = (assetType: string, model: string, platform: string, v: [number, number, number, number], label: string) =>
      prisma.firmwareImage.create({
        data: {
          manufacturer: MFR, assetType, model, platform, versionMajor: v[0], versionMinor: v[1], versionPatch: v[2], build: v[3],
          versionLabel: label, parsedFrom: "header", role: "primary", filename: `${PFX}-${platform}.out`, sizeBytes: 2048,
          sha256: `${PFX}-${platform}-${Date.now()}`, storagePath: `${PFX}-missing.out`,
        },
      });
    imageIds.push((await img("switch", "FortiSwitch S108FF fwgroup", "S108FF", [7, 6, 8, 1164], "7.6.8 build1164")).id);
    imageIds.push((await img("firewall", "FortiGate 60F fwgroup", "FG60FT", [7, 6, 4, 3596], "7.6.4 build3596")).id);
    imageIds.push((await img("access_point", "FortiAP 231F fwgroup", "FP231F", [7, 4, 4, 702], "7.4.4 build0702")).id);

    const cred = await prisma.credential.create({ data: { name: PFX + "-login", type: "http", config: { authMode: "form", username: "admin", password: "pw" }, createdBy: flasherU } });
    credId = cred.id;
    for (const assetType of ["switch", "firewall", "access_point"]) {
      await prisma.firmwareCredentialBinding.create({ data: { manufacturer: MFR, assetType, model: null, credentialId: credId } });
    }
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const all = Object.values(ids);
    await prisma.firmwareGroupSchedule.deleteMany({ where: { gateAssetId: { in: all } } });
    await prisma.firmwareUpgradeSchedule.deleteMany({ where: { assetId: { in: all } } });
    await prisma.firmwareUpgradeRun.deleteMany({ where: { assetId: { in: all } } });
    await prisma.maintenanceHold.deleteMany({ where: { assetId: { in: all } } }).catch(() => undefined);
    await prisma.firmwareCredentialBinding.deleteMany({ where: { credentialId: credId } });
    await prisma.firmwareImage.deleteMany({ where: { id: { in: imageIds } } });
    await prisma.assetDependencyParent.deleteMany({ where: { assetId: { in: all } } });
    await prisma.event.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.asset.deleteMany({ where: { id: { in: all } } });
    await prisma.credential.deleteMany({ where: { name: PFX + "-login" } });
    await prisma.user.deleteMany({ where: { username: { startsWith: PFX + "-user-" } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: PFX + "-role-" } } });
  });

  it("sources: a reader sees the selection split by controlling FortiGate", async () => {
    const reader = await loginAs(readerU);
    const mixed = await reader.agent.post(`${BASE}/sources`).set("X-CSRF-Token", reader.csrf).send({ assetIds: [ids.ap1, ids.sw1, ids.swB] });
    expect(mixed.status, JSON.stringify(mixed.body)).toBe(200);
    expect(mixed.body.sources.map((s: { gateName: string }) => s.gateName).sort()).toEqual(["fwgroup-gateA", "fwgroup-gateB"]);
    expect(mixed.body.unresolved).toEqual([]);
    const one = await reader.agent.post(`${BASE}/sources`).set("X-CSRF-Token", reader.csrf).send({ assetIds: [ids.ap1, ids.sw1, ids.gateA] });
    expect(one.body.sources).toHaveLength(1);
    expect(one.body.sources[0].gateAssetId).toBe(ids.gateA);
  });

  it("preview: assets:write only; deepest first; an already-current device is dropped; a mixed selection is a 400", async () => {
    const reader = await loginAs(readerU);
    const flasher = await loginAs(flasherU);
    const sel = [ids.gateA, ids.sw1, ids.sw2, ids.ap1];
    expect((await reader.agent.post(`${BASE}/preview`).set("X-CSRF-Token", reader.csrf).send({ assetIds: sel })).status).toBe(403);
    const res = await flasher.agent.post(`${BASE}/preview`).set("X-CSRF-Token", flasher.csrf).send({ assetIds: sel });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const plan = res.body.plan;
    expect(plan.gate.assetId).toBe(ids.gateA);
    expect(plan.included.map((m: { name: string; depth: number }) => [m.name, m.depth])).toEqual([["fwgroup-ap1", 3], ["fwgroup-sw1", 2], ["fwgroup-gateA", 1]]);
    expect(plan.included[0].ancestorIds).toEqual([ids.sw1, ids.gateA]);
    expect(plan.dropped).toEqual([expect.objectContaining({ assetId: ids.sw2, kind: "current" })]);
    expect(res.body.defaults.notifyEmails).toEqual(["flasher@example.com"]);

    const mixed = await flasher.agent.post(`${BASE}/preview`).set("X-CSRF-Token", flasher.csrf).send({ assetIds: [ids.sw1, ids.swB] });
    expect(mixed.status).toBe(400);
    expect(mixed.body.error).toMatch(/one FortiGate at a time/);
  });

  it("booking supersedes a single-device booking only when confirmed; one group per FortiGate; a single booking is then refused; cancel", async () => {
    const reader = await loginAs(readerU);
    const flasher = await loginAs(flasherU);
    const single = await prisma.firmwareUpgradeSchedule.create({
      data: { assetId: ids.sw1, imageId: imageIds[0], toVersion: "7.6.8 build1164", scheduledFor: new Date(Date.now() + 10 * 3_600_000), notifyEmails: ["a@example.com"], createdBy: flasherU },
    });
    const body = { assetIds: [ids.gateA, ids.sw1, ids.sw2, ids.ap1], scheduledFor: inHours(5), concurrency: 2, notifyEmails: ["flasher@example.com"] };

    expect((await reader.agent.post(BASE).set("X-CSRF-Token", reader.csrf).send({ ...body, cancelIndividual: true })).status).toBe(403);
    const unconfirmed = await flasher.agent.post(BASE).set("X-CSRF-Token", flasher.csrf).send(body);
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.error).toMatch(/single-device upgrade scheduled/);
    expect((await prisma.firmwareUpgradeSchedule.findUniqueOrThrow({ where: { id: single.id } })).status).toBe("pending");

    const booked = await flasher.agent.post(BASE).set("X-CSRF-Token", flasher.csrf).send({ ...body, cancelIndividual: true });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const group = booked.body.group;
    expect(group).toMatchObject({ gateAssetId: ids.gateA, status: "pending", concurrency: 2, notifyEmails: ["flasher@example.com"], createdBy: flasherU });
    expect(group.members.map((m: { name: string; state: string }) => [m.name, m.state])).toEqual([
      ["fwgroup-ap1", "planned"], ["fwgroup-sw1", "planned"], ["fwgroup-gateA", "planned"], ["fwgroup-sw2", "dropped"],
    ]);
    const after = await prisma.firmwareUpgradeSchedule.findUniqueOrThrow({ where: { id: single.id } });
    expect(after).toMatchObject({ status: "cancelled", cancelledBy: flasherU });

    // One group per gate — the service, then the database.
    const again = await flasher.agent.post(BASE).set("X-CSRF-Token", flasher.csrf).send({ ...body, cancelIndividual: true });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/only one group per FortiGate/);
    await expect(prisma.firmwareGroupSchedule.create({ data: { gateAssetId: ids.gateA, scheduledFor: new Date(Date.now() + 3_600_000), notifyEmails: ["a@example.com"], createdBy: "test" } }))
      .rejects.toMatchObject({ code: "P2002" });

    // A single-device booking on a member is refused while the group stands.
    const swBase = `/api/v1/assets/${ids.sw1}/firmware-upgrade`;
    const refused = await flasher.agent.post(`${swBase}/schedules`).set("X-CSRF-Token", flasher.csrf).send({ imageId: imageIds[0], scheduledFor: inHours(8), notifyEmails: ["a@example.com"] });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/group firmware upgrade/);

    // The card names the group.
    const card = await reader.agent.get(swBase);
    expect(card.body.group).toMatchObject({ id: group.id, gateAssetId: ids.gateA, status: "pending", memberState: "planned" });

    expect((await reader.agent.delete(`${BASE}/${group.id}`).set("X-CSRF-Token", reader.csrf)).status).toBe(403);
    const cancelled = await flasher.agent.delete(`${BASE}/${group.id}`).set("X-CSRF-Token", flasher.csrf);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.group.status).toBe("cancelled");
    expect(cancelled.body.group.members.filter((m: { state: string }) => m.state === "skipped").map((m: { skipKind: string }) => m.skipKind)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect((await reader.agent.get(swBase)).body.group).toBeNull();

    const actions = (await prisma.event.findMany({ where: { resourceId: { in: [ids.gateA, ids.sw1] } }, select: { action: true } })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["firmware.group_upgrade_scheduled", "firmware.group_upgrade_cancelled", "firmware.upgrade_schedule_cancelled"]));
  });

  it("the database refuses a concurrency outside 1–10 and a group nobody hears about", async () => {
    const base = { gateAssetId: ids.gateB, scheduledFor: new Date(Date.now() + 3_600_000), createdBy: "test", status: "cancelled" };
    await expect(prisma.firmwareGroupSchedule.create({ data: { ...base, concurrency: 11, notifyEmails: ["a@example.com"] } })).rejects.toThrow();
    await expect(prisma.firmwareGroupSchedule.create({ data: { ...base, notifyEmails: [] } })).rejects.toThrow();
  });

  it("the job's tick runs a due group: the switch's flash is refused, the FortiGate above it is skipped, the group completes", async () => {
    const g = await prisma.firmwareGroupSchedule.create({
      data: {
        gateAssetId: ids.gateA, scheduledFor: new Date(Date.now() - 30_000), concurrency: 1, notifyEmails: ["flasher@example.com"], createdBy: flasherU,
        members: {
          create: [
            { assetId: ids.sw1, imageId: imageIds[0], fromVersion: "7.4.3 build0542", toVersion: "7.6.8 build1164", depth: 2, ancestorIds: [ids.gateA], mclagPeerIds: [] },
            { assetId: ids.gateA, imageId: imageIds[1], fromVersion: "7.4.5 build2702", toVersion: "7.6.4 build3596", depth: 1, ancestorIds: [], mclagPeerIds: [] },
          ],
        },
      },
    });
    const res = await runDueGroupSchedules(new Date());
    expect(res.started).toBeGreaterThanOrEqual(1);
    const after = await prisma.firmwareGroupSchedule.findUniqueOrThrow({ where: { id: g.id }, include: { members: true } });
    expect(after.status).toBe("completed");
    const byAsset = Object.fromEntries(after.members.map((m) => [m.assetId, m]));
    expect(byAsset[ids.sw1]).toMatchObject({ state: "failed" });
    expect(byAsset[ids.sw1].detail).toMatch(/missing from disk/);
    expect(byAsset[ids.gateA]).toMatchObject({ state: "skipped", skipKind: "subtree" });
    expect(byAsset[ids.gateA].detail).toMatch(/fwgroup-sw1, behind it, failed/);
    // The summary was attempted exactly once (no email channel in the test DB → recorded, not sent).
    expect(after.notifiedAt).not.toBeNull();
    const evs = (await prisma.event.findMany({ where: { resourceId: ids.gateA }, select: { action: true } })).map((e) => e.action);
    expect(evs).toEqual(expect.arrayContaining(["firmware.group_upgrade_started", "firmware.group_upgrade_completed", "firmware.group_member_skipped"]));
  });
});

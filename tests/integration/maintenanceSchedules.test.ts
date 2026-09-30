/**
 * tests/integration/maintenanceSchedules.test.ts
 *
 * Integration coverage for the maintenance-schedule surface:
 *   - RBAC gates on /api/v1/maintenance-schedules (admin passes; a
 *     readonly-role caller is 403 on read AND write — the key seeds "none"
 *     for readonly)
 *   - create with a now-active one-shot → the target asset flips to
 *     status="maintenance" IMMEDIATELY (inline reconcile), parks the prior
 *     status, opens a window row, and stops appearing in the monitor
 *     candidate filter
 *   - preview: monitored-only + device list cap + criteria matching
 *   - operator PUT moving status off "maintenance" closes the windows
 *     (endReason "operator") without the scheduler re-entering
 *   - delete → windows closed ("deleted") + status restored
 *   - DELETE /:id/assets/:assetId (asset edit modal → Maintenance tab): one
 *     device out, the schedule deleted when it was the last target, refused
 *     for a filter-matched device, gated on maintenanceManagement
 *   - GET /assets/:id/maintenance-windows range filtering + maintenance-info
 *   - GET /server-time: the wall clock + zone the pickers must be filled in,
 *     usable as a one-shot startAt verbatim (the browser-clock bug)
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

const RO_USERNAME = "polaris-maint-readonly";
const RO_PASSWORD = "test-password-do-not-use-in-prod";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await authedAgent(app);
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.maintenanceSchedule.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.user.deleteMany({ where: { username: RO_USERNAME } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.maintenanceSchedule.deleteMany();
  await prisma.asset.deleteMany(); // cascades asset_maintenance_windows
});

function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** One-shot spanning [now-1h, now+1h] — active right now. */
function activeOneshot() {
  return {
    version: 1,
    kind: "oneshot",
    startAt: localIso(new Date(Date.now() - 60 * 60 * 1000)),
    endAt: localIso(new Date(Date.now() + 60 * 60 * 1000)),
  };
}

async function seedAsset(hostname: string, over: Record<string, unknown> = {}) {
  return prisma.asset.create({
    data: {
      hostname,
      assetType: "server",
      status: "active",
      monitored: true,
      ...over,
    } as any,
  });
}

d("maintenance-schedules RBAC", () => {
  it("admin lists; a readonly-role caller reads the calendar but is 403 on every write", async () => {
    const { agent, csrf } = await authedAgent(app);
    const ok = await agent.get("/api/v1/maintenance-schedules");
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.schedules)).toBe(true);

    // readonly user: the maintenanceManagement key seeds "read" for readonly
    // as of migration 20260922000000_rbac_catalogue_hygiene. It seeded "none"
    // before that, which put the role below its own description ("read on
    // every function that allows non-admin reads") and hid the maintenance
    // calendar from a NOC account whose whole job is knowing what is silenced
    // and why. Read is the grant; every mutation stays at write.
    const roRole = await prisma.role.findUnique({ where: { name: "readonly" } });
    expect(roRole).toBeTruthy();
    await prisma.user.upsert({
      where: { username: RO_USERNAME },
      create: {
        username: RO_USERNAME,
        passwordHash: await hashPassword(RO_PASSWORD),
        roleId: roRole!.id,
        authProvider: "local",
      },
      update: { roleId: roRole!.id },
    });
    const roAgent = request.agent(app);
    await roAgent.get("/api/v1/auth/me");
    const login = await roAgent.post("/api/v1/auth/login").send({ username: RO_USERNAME, password: RO_PASSWORD });
    expect(login.status).toBe(200);
    await roAgent.get("/api/v1/auth/me");
    const roCookies = (roAgent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
    const roCsrf = (roCookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";

    // Reads the calendar…
    expect((await roAgent.get("/api/v1/maintenance-schedules")).status).toBe(200);
    // …and cannot schedule, edit or delete anything on it.
    const post = await roAgent
      .post("/api/v1/maintenance-schedules")
      .set("X-CSRF-Token", roCsrf)
      .send({ name: "nope", assetIds: ["x"], schedule: activeOneshot() });
    expect(post.status).toBe(403);
    const del = await roAgent
      .delete("/api/v1/maintenance-schedules/does-not-matter")
      .set("X-CSRF-Token", roCsrf);
    expect(del.status).toBe(403);

    // Admin write passes the same gate.
    const asset = await seedAsset("rbac-target");
    const adminPost = await agent
      .post("/api/v1/maintenance-schedules")
      .set("X-CSRF-Token", csrf)
      .send({ name: "RBAC OK", assetIds: [asset.id], schedule: activeOneshot() });
    expect(adminPost.status).toBe(201);
  });
});

d("GET /maintenance-schedules/server-time", () => {
  it("reports a wall clock the pickers can use verbatim, plus the zone", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/maintenance-schedules/server-time");
    expect(res.status).toBe(200);
    // The exact shape the browser computes its skew from.
    expect(res.body.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(typeof res.body.timeZone).toBe("string");
    expect(typeof res.body.offsetMinutes).toBe("number");
    // `|| 0` folds -0 to +0: on a UTC host getTimezoneOffset() is 0 and
    // negating it yields -0, which toBe/toEqual (Object.is / chai deep-eq)
    // both distinguish from the server's +0 — the test failed only on
    // UTC-clocked runners (CI, the dev container) and passed elsewhere.
    expect(res.body.offsetMinutes).toBe(-new Date().getTimezoneOffset() || 0);
  });

  it("is not captured by the /:id route", async () => {
    // Declared above "/:id" — a capture would 404 as a missing schedule.
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/maintenance-schedules/server-time");
    expect(res.status).toBe(200);
    expect(res.body.now).toBeTruthy();
  });

  it("the reported wall clock is accepted as a one-shot startAt and enters immediately", async () => {
    // The property the fix rests on: a window prefilled from THIS value is
    // open on the server, whereas one prefilled from a browser in another zone
    // may already have ended. Round-tripping it proves the string is read back
    // as the same wall clock the server reported.
    const { agent, csrf } = await authedAgent(app);
    const clock = await agent.get("/api/v1/maintenance-schedules/server-time");
    const asset = await seedAsset("server-time-roundtrip");
    const end = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    const endAt = `${end.getFullYear()}-${p(end.getMonth() + 1)}-${p(end.getDate())}T` +
      `${p(end.getHours())}:${p(end.getMinutes())}`;
    const res = await agent
      .post("/api/v1/maintenance-schedules")
      .set("X-CSRF-Token", csrf)
      .send({
        name: "From server clock",
        assetIds: [asset.id],
        schedule: { version: 1, kind: "oneshot", startAt: clock.body.now, endAt },
      });
    expect(res.status).toBe(201);
    const after = await prisma.asset.findUnique({ where: { id: asset.id } });
    expect(after?.status).toBe("maintenance");
  });
});

d("maintenance-schedule lifecycle", () => {
  // Parked FROM `active`, and it can no longer be anything else: business
  // rule 10's unmonitorable set grew to cover `storage` and `quarantined` in
  // 2026-08, `decommissioned`/`disabled` were always there, and `maintenance`
  // is the window itself — so `active` is the only status left that a
  // maintenance target can hold on the way in. This fixture read `storage`
  // until then, which the widening turned into monitored=false at create time
  // and therefore out of `∩ monitored` targeting: the asset silently stopped
  // being entered and this test went red on main for three pushes. Don't
  // "improve" it back to a more interesting status.
  it("create with a now-active window enters maintenance immediately and parks the prior status", async () => {
    const { agent, csrf } = await authedAgent(app);
    const asset = await seedAsset("enter-now");

    const res = await agent
      .post("/api/v1/maintenance-schedules")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Enter now", assetIds: [asset.id], schedule: activeOneshot() });
    expect(res.status).toBe(201);

    const after = await prisma.asset.findUnique({ where: { id: asset.id } });
    expect(after!.status).toBe("maintenance");
    expect(after!.maintenanceReturnStatus).toBe("active");
    expect(after!.statusChangedBy).toBe("system:maintenance");

    const windows = await prisma.assetMaintenanceWindow.findMany({ where: { assetId: asset.id } });
    expect(windows).toHaveLength(1);
    expect(windows[0].endedAt).toBeNull();
    expect(windows[0].scheduleName).toBe("Enter now");
  });

  it("unmonitored assets are not entered", async () => {
    const { agent, csrf } = await authedAgent(app);
    const asset = await seedAsset("unmonitored", { monitored: false });
    const res = await agent
      .post("/api/v1/maintenance-schedules")
      .set("X-CSRF-Token", csrf)
      .send({ name: "No-op", assetIds: [asset.id], schedule: activeOneshot() });
    expect(res.status).toBe(201);
    const after = await prisma.asset.findUnique({ where: { id: asset.id } });
    expect(after!.status).toBe("active");
    expect(await prisma.assetMaintenanceWindow.count({ where: { assetId: asset.id } })).toBe(0);
  });

  // The status-driven half of the test above it. `monitored:false` gets there
  // by operator intent; this gets there through business rule 10 — a status in
  // the unmonitorable set is clamped to monitored=false on write, so it can
  // never be a maintenance target no matter what the schedule names. Pins the
  // rule 10 ↔ rule 16 interaction that broke the two fixtures in this file,
  // and states the product answer: a window on a shelved or quarantined device
  // would be a no-op, because nothing is polling it to silence.
  it("assets in an unmonitorable status are not entered", async () => {
    const { agent, csrf } = await authedAgent(app);
    const shelved = await seedAsset("shelved", { status: "storage" });
    const isolated = await seedAsset("isolated", { status: "quarantined" });
    // The clamp is what makes them untargetable — assert it, so a failure here
    // reads as "rule 10 changed" rather than "maintenance broke".
    expect((await prisma.asset.findUnique({ where: { id: shelved.id } }))!.monitored).toBe(false);
    expect((await prisma.asset.findUnique({ where: { id: isolated.id } }))!.monitored).toBe(false);

    const res = await agent
      .post("/api/v1/maintenance-schedules")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Shelf", assetIds: [shelved.id, isolated.id], schedule: activeOneshot() });
    expect(res.status).toBe(201);

    for (const a of [shelved, isolated]) {
      const after = await prisma.asset.findUnique({ where: { id: a.id } });
      expect(after!.status).toBe(a.status);
      expect(after!.maintenanceReturnStatus).toBeNull();
      expect(await prisma.assetMaintenanceWindow.count({ where: { assetId: a.id } })).toBe(0);
    }
  });

  it("rejects status criteria, empty targets, and malformed schedules", async () => {
    const { agent, csrf } = await authedAgent(app);
    const noTargets = await agent
      .post("/api/v1/maintenance-schedules")
      .set("X-CSRF-Token", csrf)
      .send({ name: "x", schedule: activeOneshot() });
    expect(noTargets.status).toBe(400);

    const statusRule = await agent
      .post("/api/v1/maintenance-schedules")
      .set("X-CSRF-Token", csrf)
      .send({
        name: "x",
        criteria: { version: 1, match: "all", rules: [{ field: "status", op: "exact", values: ["active"] }] },
        schedule: activeOneshot(),
      });
    expect(statusRule.status).toBe(400);

    const badShape = await agent
      .post("/api/v1/maintenance-schedules")
      .set("X-CSRF-Token", csrf)
      .send({ name: "x", assetIds: ["a"], schedule: { version: 1, kind: "recurring", freq: "weekly" } });
    expect(badShape.status).toBe(400);
  });

  it("operator PUT moving status off maintenance closes windows as operator-released and the scheduler does not re-enter", async () => {
    const { agent, csrf } = await authedAgent(app);
    // TWO explicit assets: a single-asset one-shot is the ad-hoc shape and
    // self-deletes on operator release — this test exercises the release
    // suppression on a schedule that SURVIVES the release.
    const asset = await seedAsset("op-release");
    const peer = await seedAsset("op-release-peer");
    const created = await agent
      .post("/api/v1/maintenance-schedules")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Release me", assetIds: [asset.id, peer.id], schedule: activeOneshot() });
    expect(created.status).toBe(201);
    expect((await prisma.asset.findUnique({ where: { id: asset.id } }))!.status).toBe("maintenance");

    const put = await agent
      .put(`/api/v1/assets/${asset.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ status: "active" });
    expect(put.status).toBe(200);

    const after = await prisma.asset.findUnique({ where: { id: asset.id } });
    expect(after!.status).toBe("active");
    expect(after!.maintenanceReturnStatus).toBeNull();
    const windows = await prisma.assetMaintenanceWindow.findMany({ where: { assetId: asset.id } });
    expect(windows).toHaveLength(1);
    expect(windows[0].endReason).toBe("operator");
    // The peer's window is untouched and the multi-asset schedule survives.
    expect((await prisma.asset.findUnique({ where: { id: peer.id } }))!.status).toBe("maintenance");

    // A fresh reconcile (any schedule write triggers one) must NOT re-enter
    // this occurrence.
    const bump = await agent
      .put(`/api/v1/maintenance-schedules/${created.body.schedule.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ name: "Release me", assetIds: [asset.id, peer.id], schedule: created.body.schedule.schedule });
    expect(bump.status).toBe(200);
    expect((await prisma.asset.findUnique({ where: { id: asset.id } }))!.status).toBe("active");
    expect(await prisma.assetMaintenanceWindow.count({ where: { assetId: asset.id, endedAt: null } })).toBe(0);
  });

  it("operator release deletes an ad-hoc-shaped schedule (single-asset one-shot, no criteria)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const asset = await seedAsset("adhoc-release");
    const created = await agent
      .post("/api/v1/maintenance-schedules")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Ad-hoc — adhoc-release", assetIds: [asset.id], schedule: activeOneshot() });
    expect(created.status).toBe(201);
    expect((await prisma.asset.findUnique({ where: { id: asset.id } }))!.status).toBe("maintenance");

    const put = await agent
      .put(`/api/v1/assets/${asset.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ status: "active" });
    expect(put.status).toBe(200);

    // Spent ad-hoc schedule is gone; window history keeps the name snapshot.
    expect(await prisma.maintenanceSchedule.findUnique({ where: { id: created.body.schedule.id } })).toBeNull();
    const windows = await prisma.assetMaintenanceWindow.findMany({ where: { assetId: asset.id } });
    expect(windows).toHaveLength(1);
    expect(windows[0].endReason).toBe("operator");
    expect(windows[0].scheduleId).toBeNull();
    expect(windows[0].scheduleName).toBe("Ad-hoc — adhoc-release");
  });

  it("delete closes the window (deleted) and restores the parked status", async () => {
    const { agent, csrf } = await authedAgent(app);
    // `active` for the same reason as the enter-now fixture above: a
    // quarantined asset is clamped unmonitorable and never enters at all.
    const asset = await seedAsset("del-restore");
    const created = await agent
      .post("/api/v1/maintenance-schedules")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Doomed", assetIds: [asset.id], schedule: activeOneshot() });
    expect(created.status).toBe(201);

    const del = await agent
      .delete(`/api/v1/maintenance-schedules/${created.body.schedule.id}`)
      .set("X-CSRF-Token", csrf);
    expect(del.status).toBe(204);

    const after = await prisma.asset.findUnique({ where: { id: asset.id } });
    expect(after!.status).toBe("active");
    expect(after!.maintenanceReturnStatus).toBeNull();
    const windows = await prisma.assetMaintenanceWindow.findMany({ where: { assetId: asset.id } });
    expect(windows).toHaveLength(1);
    expect(windows[0].endReason).toBe("deleted");
  });
});

d("maintenance preview + asset reads", () => {
  it("preview returns only monitored assets, capped at 50, with the true total", async () => {
    const { agent, csrf } = await authedAgent(app);
    for (let i = 0; i < 55; i++) await seedAsset(`prev-${String(i).padStart(2, "0")}`);
    await seedAsset("prev-unmon", { monitored: false });

    const res = await agent
      .post("/api/v1/maintenance-schedules/preview")
      .set("X-CSRF-Token", csrf)
      .send({ criteria: { version: 1, match: "all", rules: [{ field: "hostname", op: "contains", values: ["prev-"] }] } });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(55);
    expect(res.body.assets).toHaveLength(50);
    expect(res.body.assets.map((a: any) => a.hostname)).not.toContain("prev-unmon");
  });

  it("GET /assets/:id/maintenance-windows filters by range; maintenance-info reports coverage", async () => {
    const { agent, csrf } = await authedAgent(app);
    const asset = await seedAsset("windows-read");
    const created = await agent
      .post("/api/v1/maintenance-schedules")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Readable", assetIds: [asset.id], schedule: activeOneshot() });
    expect(created.status).toBe(201);

    // Range covering now → the open window is returned.
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const win = await agent.get(`/api/v1/assets/${asset.id}/maintenance-windows?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(win.status).toBe(200);
    expect(win.body.windows).toHaveLength(1);
    expect(win.body.windows[0].scheduleName).toBe("Readable");
    expect(win.body.windows[0].endedAt).toBeNull();

    // A range that ended before the window opened → empty.
    const oldFrom = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const oldTo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const none = await agent.get(`/api/v1/assets/${asset.id}/maintenance-windows?from=${encodeURIComponent(oldFrom)}&to=${encodeURIComponent(oldTo)}`);
    expect(none.status).toBe(200);
    expect(none.body.windows).toHaveLength(0);

    const info = await agent.get(`/api/v1/assets/${asset.id}/maintenance-info`);
    expect(info.status).toBe(200);
    expect(info.body.inMaintenance).toBe(true);
    expect(info.body.status).toBe("maintenance"); // the modal re-syncs its Status dropdown from this
    expect(info.body.openWindows).toHaveLength(1);
    expect(info.body.schedules.map((s: any) => s.name)).toContain("Readable");
    expect(info.body.schedules[0].activeNow).toBe(true);
    // The Maintenance tab's action gates travel with the row.
    expect(info.body.schedules[0]).toMatchObject({ explicit: true, removable: true, lastTarget: true });
  });
});

d("DELETE /maintenance-schedules/:id/assets/:assetId", () => {
  it("removes one device, leaves the schedule running for the rest, and ends that device's window", async () => {
    const { agent, csrf } = await authedAgent(app);
    const keep = await seedAsset("multi-keep");
    const drop = await seedAsset("multi-drop");
    const created = await agent
      .post("/api/v1/maintenance-schedules")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Two devices", assetIds: [keep.id, drop.id], schedule: activeOneshot() });
    expect(created.status).toBe(201);
    expect((await prisma.asset.findUnique({ where: { id: drop.id } }))!.status).toBe("maintenance");

    const res = await agent
      .delete(`/api/v1/maintenance-schedules/${created.body.schedule.id}/assets/${drop.id}`)
      .set("X-CSRF-Token", csrf);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scheduleDeleted: false, remainingAssetIds: 1 });

    const row = await prisma.maintenanceSchedule.findUnique({ where: { id: created.body.schedule.id } });
    expect(row!.assetIds).toEqual([keep.id]);
    // Dropped device is out of maintenance; the other one stays in it.
    expect((await prisma.asset.findUnique({ where: { id: drop.id } }))!.status).toBe("active");
    expect((await prisma.asset.findUnique({ where: { id: keep.id } }))!.status).toBe("maintenance");
    const closed = await prisma.assetMaintenanceWindow.findFirst({ where: { assetId: drop.id } });
    expect(closed!.endedAt).not.toBeNull();
    expect(closed!.endReason).toBe("criteria");
  });

  it("deletes the schedule when the removed device was its last target", async () => {
    const { agent, csrf } = await authedAgent(app);
    const asset = await seedAsset("only-device");
    const created = await agent
      .post("/api/v1/maintenance-schedules")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Only device", assetIds: [asset.id], schedule: activeOneshot() });
    expect(created.status).toBe(201);

    const res = await agent
      .delete(`/api/v1/maintenance-schedules/${created.body.schedule.id}/assets/${asset.id}`)
      .set("X-CSRF-Token", csrf);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scheduleDeleted: true, scheduleName: "Only device" });
    expect(await prisma.maintenanceSchedule.findUnique({ where: { id: created.body.schedule.id } })).toBeNull();
    expect((await prisma.asset.findUnique({ where: { id: asset.id } }))!.status).toBe("active");
    const evt = await prisma.event.findFirst({
      where: { action: "maintenance_schedule.deleted", resourceId: created.body.schedule.id },
    });
    expect(evt).toBeTruthy();
  });

  it("refuses a device the schedule reaches through its filter, and gates on maintenanceManagement", async () => {
    const { agent, csrf } = await authedAgent(app);
    const asset = await seedAsset("filtered-device", { model: "MX-9000" });
    const created = await agent
      .post("/api/v1/maintenance-schedules")
      .set("X-CSRF-Token", csrf)
      .send({
        name: "By filter",
        criteria: { rules: [{ field: "model", op: "contains", values: ["MX-9000"] }] },
        schedule: activeOneshot(),
      });
    expect(created.status).toBe(201);

    const refused = await agent
      .delete(`/api/v1/maintenance-schedules/${created.body.schedule.id}/assets/${asset.id}`)
      .set("X-CSRF-Token", csrf);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/filter/i);
    expect((await prisma.asset.findUnique({ where: { id: asset.id } }))!.status).toBe("maintenance");

    // readonly (maintenanceManagement: none) can't reach the endpoint at all.
    const roRole = await prisma.role.findUnique({ where: { name: "readonly" } });
    await prisma.user.upsert({
      where: { username: RO_USERNAME },
      create: {
        username: RO_USERNAME,
        passwordHash: await hashPassword(RO_PASSWORD),
        roleId: roRole!.id,
        authProvider: "local",
      },
      update: { roleId: roRole!.id },
    });
    const roAgent = request.agent(app);
    await roAgent.get("/api/v1/auth/me");
    await roAgent.post("/api/v1/auth/login").send({ username: RO_USERNAME, password: RO_PASSWORD });
    await roAgent.get("/api/v1/auth/me");
    const roCookies = (roAgent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
    const roCsrf = (roCookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
    const ro = await roAgent
      .delete(`/api/v1/maintenance-schedules/${created.body.schedule.id}/assets/${asset.id}`)
      .set("X-CSRF-Token", roCsrf);
    expect(ro.status).toBe(403);
  });
});

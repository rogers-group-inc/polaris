/**
 * tests/integration/writeScope.test.ts — business rule 141 (e) / (f) at the
 * routes: what a Read-Write caller may change on the tag-scoped keys.
 *
 * Three callers, one matrix: Read-Write on every scoped key. `alice` holds the
 * region WS-North and the other tag ws-pci; `bob` holds no tags; `root` holds
 * Full Read-Write (and Clear Alerts). Four devices: one alice added, one
 * carrying her other tag, one carrying her region (different case), one with
 * no owner and no tags — the shape integration discovery leaves behind.
 *
 * The cases pin: owned / tagged / regional reach at Read-Write; the ownerless
 * untagged row being Full Read-Write only; a bulk verb refusing before any
 * write; alerts judged on their device (none = Full RW only) and clear needing
 * its own key; maintenance by explicit devices vs a filter; the DHCP
 * duplicate-reservation conflict resolvable at reservations:write with a
 * binding in scope and visible at discoveryConflicts:read; stale verbs on the
 * reservation's network; a site layout on the site's FortiGate; the subnet
 * refresh gap closed.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { reconcileDuplicateReservationConflicts, DUPLICATE_RESERVATION_COLLISION_REASON } from "../../src/services/duplicateReservationConflictService.js";
import { dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "wscope-test";
const PASSWORD = "wscope-password-not-real";
const BLOCK = "10.98.0.0/16";
const CIDR_A = "10.98.6.0/24";
const CIDR_B = "10.98.7.0/24";
const ETH = "02:00:00:00:98:01";

const SCOPED = ["assets", "assetsQuarantine", "alerts", "maintenanceManagement", "discoveryConflicts", "staleReservations", "deviceMap", "subnets", "reservations"];

function matrix(base: string, overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) out[key] = overrides[key] ?? base;
  return out;
}
function writeOn(keys: string[], level: string, extra: Record<string, string> = {}): Record<string, string> {
  const o: Record<string, string> = { ...extra };
  for (const k of keys) o[k] = level;
  return matrix("read", o);
}

async function createRoleUser(suffix: string, permissions: Record<string, string>, tags: { regionTags?: string[]; otherTags?: string[] } = {}): Promise<string> {
  const role = await prisma.role.create({ data: { name: PFX + "-role-" + suffix, permissions } });
  const username = PFX + "-user-" + suffix;
  await prisma.user.create({
    data: { username, passwordHash: await hashPassword(PASSWORD), roleId: role.id, authProvider: "local", regionTags: tags.regionTags ?? [], otherTags: tags.otherTags ?? [] },
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

let alice = "";
let bob = "";
let root = "";
let subnetA = "";   // carries region:WS-North
let subnetB = "";   // no tags, no owner
let mine = "";      // createdBy alice
let tagged = "";    // tags ["ws-pci"]
let regional = "";  // tags ["region:ws-north"] (case differs from the user's)
let orphan = "";    // nothing

async function mkAsset(name: string, over: Record<string, unknown> = {}): Promise<string> {
  return (await prisma.asset.create({
    data: { hostname: PFX + "-" + name, assetType: "workstation", status: "active", monitored: false, ...over },
  })).id;
}

async function cleanup(): Promise<void> {
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: PFX } }, select: { id: true } });
  const ids = assets.map((a) => a.id);
  await prisma.conflict.deleteMany({ where: { assetId: { in: ids } } });
  await prisma.notification.deleteMany({ where: { assetHostname: { startsWith: PFX } } });
  await prisma.maintenanceSchedule.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.ipBlock.deleteMany({ where: { cidr: BLOCK } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX + "-user-" } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX + "-role-" } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await cleanup();
  alice = await createRoleUser("alice", writeOn(SCOPED, "write", { discoveryConflicts: "read" }), { regionTags: ["WS-North"], otherTags: ["ws-pci"] });
  bob = await createRoleUser("bob", writeOn(SCOPED, "write", { discoveryConflicts: "read" }));
  root = await createRoleUser("root", writeOn(SCOPED, "fullwrite", { alertClear: "write" }));

  const block = await prisma.ipBlock.create({ data: { name: PFX, cidr: BLOCK, ipVersion: "v4" } });
  subnetA = (await prisma.subnet.create({ data: { blockId: block.id, cidr: CIDR_A, name: PFX + "-a", tags: ["region:WS-North"] } })).id;
  subnetB = (await prisma.subnet.create({ data: { blockId: block.id, cidr: CIDR_B, name: PFX + "-b" } })).id;

  mine = await mkAsset("mine", { createdBy: alice });
  tagged = await mkAsset("tagged", { tags: ["ws-pci"] });
  regional = await mkAsset("regional", { tags: ["region:ws-north"] });
  orphan = await mkAsset("orphan");
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
});

async function rename(who: string, id: string, note: string) {
  const s = await loginAs(who);
  return s.agent.put("/api/v1/assets/" + id).set("X-CSRF-Token", s.csrf).send({ notes: note });
}

d("assets — Read-Write reaches owned, tagged and regional devices; nothing else", () => {
  it("alice edits the device she added, the one carrying her tag and the one in her region", async () => {
    expect((await rename(alice, mine, "owned")).status).toBe(200);
    expect((await rename(alice, tagged, "tagged")).status).toBe(200);
    expect((await rename(alice, regional, "regional")).status).toBe(200);
  });

  it("an ownerless, untagged device is Full Read-Write only", async () => {
    const res = await rename(alice, orphan, "nope");
    expect(res.status).toBe(403);
    expect(String(res.body.error ?? res.body.message)).toMatch(/you created or that carry one of your tags/);
    expect((await rename(root, orphan, "root")).status).toBe(200);
  });

  it("a tagless Read-Write caller reaches only what they added", async () => {
    expect((await rename(bob, mine, "not bobs")).status).toBe(403);
    expect((await rename(bob, tagged, "not bobs")).status).toBe(403);
    const created = await (await loginAs(bob)).agent.post("/api/v1/assets").set("X-CSRF-Token", (await loginAs(bob)).csrf)
      .send({ hostname: PFX + "-bobs", assetType: "workstation", status: "active" });
    expect(created.status).toBe(201);
    expect(created.body.createdBy).toBe(bob);
    expect((await rename(bob, created.body.id, "mine now")).status).toBe(200);
  });

  it("a bulk verb with one out-of-scope device refuses before any write", async () => {
    const s = await loginAs(alice);
    const res = await s.agent.post("/api/v1/assets/bulk-monitor").set("X-CSRF-Token", s.csrf).send({ ids: [mine, orphan], monitored: true });
    expect(res.status).toBe(403);
    expect(String(res.body.error ?? res.body.message)).toMatch(/orphan/);
    const rows = await prisma.asset.findMany({ where: { id: { in: [mine, orphan] } }, select: { monitored: true } });
    expect(rows.every((r) => r.monitored === false)).toBe(true);
  });

  it("the fleet-wide verbs need Full Read-Write", async () => {
    const s = await loginAs(alice);
    const res = await s.agent.put("/api/v1/assets/ip-history-settings").set("X-CSRF-Token", s.csrf).send({});
    expect(res.status).toBe(403);
    expect(String(res.body.error ?? res.body.message)).toMatch(/Full Read-Write/);
  });

  it("quarantine follows the same reach", async () => {
    const s = await loginAs(alice);
    const res = await s.agent.post("/api/v1/assets/" + orphan + "/quarantine").set("X-CSRF-Token", s.csrf).send({});
    expect(res.status).toBe(403);
  });
});

d("alerts — judged on the device; none means Full Read-Write; clear is its own key", () => {
  async function alert(assetId: string | null) {
    return prisma.notification.create({
      data: { assetId, assetHostname: PFX + "-alert", severity: "critical", message: "test", regionTags: [] },
    });
  }
  it("acknowledging an alert on a tagged device works; on an orphan it does not", async () => {
    const s = await loginAs(alice);
    const ok = await alert(tagged);
    const no = await alert(orphan);
    expect((await s.agent.post("/api/v1/alerts/acknowledge").set("X-CSRF-Token", s.csrf).send({ ids: [ok.id] })).status).toBe(200);
    const res = await s.agent.post("/api/v1/alerts/acknowledge").set("X-CSRF-Token", s.csrf).send({ ids: [no.id] });
    expect(res.status).toBe(403);
    expect((await prisma.notification.findUnique({ where: { id: no.id } }))?.acknowledgedAt ?? null).toBeNull();
  });
  it("an alert with no device is Full Read-Write only", async () => {
    const n = await alert(null);
    const a = await loginAs(alice);
    expect((await a.agent.post("/api/v1/alerts/acknowledge").set("X-CSRF-Token", a.csrf).send({ ids: [n.id] })).status).toBe(403);
    const r = await loginAs(root);
    expect((await r.agent.post("/api/v1/alerts/acknowledge").set("X-CSRF-Token", r.csrf).send({ ids: [n.id] })).status).toBe(200);
  });
  it("clearing needs the Clear Alerts key, then the same reach", async () => {
    const n = await alert(tagged);
    const a = await loginAs(alice);
    expect((await a.agent.post("/api/v1/alerts/clear").set("X-CSRF-Token", a.csrf).send({ ids: [n.id] })).status).toBe(403);
    const r = await loginAs(root);
    expect((await r.agent.post("/api/v1/alerts/clear").set("X-CSRF-Token", r.csrf).send({ ids: [n.id] })).status).toBe(200);
  });
});

function activeOneshot() {
  const p = (n: number) => String(n).padStart(2, "0");
  const iso = (dt: Date) => `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}`;
  return { version: 1, kind: "oneshot", startAt: iso(new Date(Date.now() - 3600_000)), endAt: iso(new Date(Date.now() + 3600_000)) };
}

d("maintenance — explicit devices in scope, or the creator; a filter is Full Read-Write", () => {
  it("alice schedules her own device, not the orphan, and never by filter", async () => {
    const s = await loginAs(alice);
    const ok = await s.agent.post("/api/v1/maintenance-schedules").set("X-CSRF-Token", s.csrf).send({ name: PFX + "-ok", assetIds: [mine], schedule: activeOneshot() });
    expect(ok.status).toBe(201);
    const no = await s.agent.post("/api/v1/maintenance-schedules").set("X-CSRF-Token", s.csrf).send({ name: PFX + "-no", assetIds: [orphan], schedule: activeOneshot() });
    expect(no.status).toBe(403);
    const filt = await s.agent.post("/api/v1/maintenance-schedules").set("X-CSRF-Token", s.csrf)
      .send({ name: PFX + "-filter", criteria: { assetType: ["workstation"] }, schedule: activeOneshot() });
    expect(filt.status).toBe(403);
    expect(String(filt.body.error ?? filt.body.message)).toMatch(/Full Read-Write/);
    // bob cannot delete alice's window; alice can.
    const b = await loginAs(bob);
    expect((await b.agent.delete("/api/v1/maintenance-schedules/" + ok.body.schedule.id).set("X-CSRF-Token", b.csrf)).status).toBe(403);
    expect((await s.agent.delete("/api/v1/maintenance-schedules/" + ok.body.schedule.id).set("X-CSRF-Token", s.csrf)).status).toBe(204);
  });
});

d("the DHCP duplicate-reservation conflict (rule 141 (f))", () => {
  it("is visible at discoveryConflicts:read and resolved at reservations:write when a binding is in scope", async () => {
    const dev = await mkAsset("dup", {
      ipAddress: "10.98.6.20", macAddress: ETH,
      macAddressRows: { create: [{ mac: ETH, source: "dhcp_reservation", lastSeen: new Date() }] },
    });
    const a = await prisma.reservation.create({ data: { subnetId: subnetA, ipAddress: "10.98.6.20", macAddress: ETH, sourceType: "dhcp_reservation", status: "active", hostname: PFX + "-dup" } });
    await prisma.reservation.create({ data: { subnetId: subnetB, ipAddress: "10.98.7.20", macAddress: ETH, sourceType: "dhcp_reservation", status: "active", hostname: PFX + "-dup" } });
    await reconcileDuplicateReservationConflicts();
    const conflict = await prisma.conflict.findFirst({
      where: { assetId: dev, status: "pending", entityType: "asset", proposedAssetFields: { path: ["collisionReason"], equals: DUPLICATE_RESERVATION_COLLISION_REASON } },
    });
    expect(conflict).toBeTruthy();

    // bob: no tags, created nothing — the bindings are out of his reach.
    const b = await loginAs(bob);
    expect((await b.agent.get("/api/v1/conflicts")).status).toBe(200);
    const bobTry = await b.agent.post("/api/v1/conflicts/" + conflict!.id + "/keep-reservation").set("X-CSRF-Token", b.csrf).send({ reservationId: a.id });
    expect(bobTry.status).toBe(403);

    // alice: subnet A carries her region, so one binding is in scope — and
    // with that, every binding in the conflict may be released.
    const s = await loginAs(alice);
    const keep = await s.agent.post("/api/v1/conflicts/" + conflict!.id + "/keep-reservation").set("X-CSRF-Token", s.csrf).send({ reservationId: a.id });
    expect(keep.status).toBe(200);
    expect((await prisma.reservation.findMany({ where: { macAddress: ETH, status: "active" } })).map((r) => r.id)).toEqual([a.id]);
  });
});

d("stale reservations — the reservation's network; the threshold is Full Read-Write", () => {
  it("alice snoozes on her region's network, not on the untagged one; the threshold needs Full RW", async () => {
    const inScope = await prisma.reservation.create({ data: { subnetId: subnetA, ipAddress: "10.98.6.30", sourceType: "manual", status: "active" } });
    const outOfScope = await prisma.reservation.create({ data: { subnetId: subnetB, ipAddress: "10.98.7.30", sourceType: "manual", status: "active" } });
    const s = await loginAs(alice);
    expect((await s.agent.post("/api/v1/reservations/" + inScope.id + "/snooze").set("X-CSRF-Token", s.csrf).send({})).status).not.toBe(403);
    expect((await s.agent.post("/api/v1/reservations/" + outOfScope.id + "/snooze").set("X-CSRF-Token", s.csrf).send({})).status).toBe(403);
    expect((await s.agent.put("/api/v1/reservations/stale-settings").set("X-CSRF-Token", s.csrf).send({ staleAfterDays: 30 })).status).toBe(403);
  });
});

d("site layouts and the subnet refresh", () => {
  it("a site's layout follows its FortiGate's reach", async () => {
    const fgIn = await mkAsset("fg-in", { assetType: "firewall", tags: ["ws-pci"] });
    const fgOut = await mkAsset("fg-out", { assetType: "firewall" });
    const s = await loginAs(alice);
    expect((await s.agent.put("/api/v1/map/sites/" + fgIn + "/topology/layout").set("X-CSRF-Token", s.csrf).send({ view: "flat", positions: { a: { x: 0, y: 0 } } })).status).toBe(200);
    expect((await s.agent.put("/api/v1/map/sites/" + fgOut + "/topology/layout").set("X-CSRF-Token", s.csrf).send({ view: "flat", positions: { a: { x: 0, y: 0 } } })).status).toBe(403);
  });

  it("refreshing a network takes the own-or-tagged check it never had", async () => {
    const b = await loginAs(bob);
    expect((await b.agent.post("/api/v1/subnets/" + subnetB + "/refresh").set("X-CSRF-Token", b.csrf).send({})).status).toBe(403);
    const s = await loginAs(alice);
    expect((await s.agent.post("/api/v1/subnets/" + subnetA + "/refresh").set("X-CSRF-Token", s.csrf).send({})).status).not.toBe(403);
  });
});

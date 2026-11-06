/**
 * tests/integration/assetMacSplit.test.ts
 *
 * POST /assets/:id/macs/split — business rule 91(j): split MACs off a fused
 * asset (devices that shared a DHCP hostname before rule 91(f)) onto assets of
 * their own, named apart by MAC (rule 91(i)).
 *
 * Pinned: the gate (assets:write, write scope); what moves (the MAC row, its
 * address rows, their IP history, the fortigate-endpoint source keyed on it)
 * and what stays; the new asset's primary MAC is the split MAC (discovery's
 * endpoint upsert re-binds by primary MAC); the original's monitored address
 * and address pin leave a split MAC; the refusals (primary, the device's own
 * NIC / port range, unknown MAC, quarantined, every MAC); naming of the new
 * assets and of the original only when its name is discovery's.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { dbDescribe, dbReachable, ensureTestUser, waitForEventCount } from "./_helpers.js";

const d = dbDescribe;
const PFX = "msplit-test";
const HOST = "MSPLIT-PHONE";
const PASSWORD = "msplit-password-not-real";

const P = "AA:BB:CC:91:2A:01";   // primary — stays
const X = "AA:BB:CC:91:2B:02";   // split
const Y = "AA:BB:CC:91:2C:03";   // split
const NIC = "AA:BB:CC:91:2D:04"; // Intune-reported NIC: the device's own
const RANGE = "DD:EE:FF:91:00:00";

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
  if (resp.status !== 200) throw new Error("login as " + username + " failed (" + resp.status + ")");
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  const s = { agent, csrf };
  sessions.set(username, s);
  return s;
}

let writeUser = "";
let readUser = "";
let assetId = "";

const T = (iso: string) => new Date(iso);

async function cleanup() {
  const ids = (await prisma.asset.findMany({
    where: { OR: [{ hostname: { startsWith: HOST } }, { macAddress: { in: [P, X, Y, NIC] } }] },
    select: { id: true },
  })).map((a) => a.id);
  if (ids.length) {
    await prisma.event.deleteMany({ where: { resourceId: { in: ids } } });
    await prisma.asset.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.assetSource.deleteMany({ where: { sourceKind: "fortigate-endpoint", externalId: { in: [P, X, Y] } } });
}

async function seed(over: Record<string, unknown> = {}) {
  await cleanup();
  const a = await prisma.asset.create({
    data: {
      hostname: HOST, assetType: "workstation", status: "active", monitored: false,
      macAddress: P, ipAddress: "10.99.242.11", // monitored on X's address, pinned to X
      primaryAddressMac: X, primaryAddressIp: "10.99.242.11", primaryAddressPinnedAt: new Date(), primaryAddressPinnedBy: "someone",
      createdBy: writeUser,
      macAddressRows: {
        create: [
          { mac: P, source: "device-inventory", lastSeen: T("2026-11-05T12:00:00Z"), firstSeen: T("2026-10-01T00:00:00Z") },
          { mac: X, source: "device-inventory", lastSeen: T("2026-11-06T12:00:00Z"), firstSeen: T("2026-10-09T00:00:00Z") },
          { mac: Y, source: "fortigate", lastSeen: T("2026-11-04T12:00:00Z"), firstSeen: T("2026-10-14T00:00:00Z") },
          { mac: NIC, source: "intune-wifi", lastSeen: T("2026-11-01T12:00:00Z"), firstSeen: T("2026-10-01T00:00:00Z") },
          { mac: RANGE, macEnd: "DD:EE:FF:91:00:0F", source: "monitor-interface", lastSeen: T("2026-11-01T12:00:00Z"), firstSeen: T("2026-10-01T00:00:00Z") },
        ],
      },
      associatedIpRows: {
        create: [
          { ip: "10.99.242.10", mac: P, source: "device-inventory", device: "MSPLIT-GW", lastSeen: T("2026-11-05T12:00:00Z") },
          { ip: "10.99.242.11", mac: X, source: "device-inventory", device: "MSPLIT-GW", lastSeen: T("2026-11-06T12:00:00Z") },
          { ip: "10.99.242.12", mac: Y, source: "dhcp-lease", device: "MSPLIT-GW", lastSeen: T("2026-11-04T12:00:00Z") },
          { ip: "10.99.242.13", mac: Y, source: "arp", device: "MSPLIT-GW", lastSeen: T("2026-11-02T12:00:00Z") },
        ],
      },
      ipHistory: {
        create: [
          { ip: "10.99.242.10", source: "dhcp", firstSeen: T("2026-10-01T00:00:00Z"), lastSeen: T("2026-11-05T12:00:00Z") },
          { ip: "10.99.242.11", source: "dhcp", firstSeen: T("2026-10-09T00:00:00Z"), lastSeen: T("2026-11-06T12:00:00Z") },
          { ip: "10.99.242.12", source: "dhcp", firstSeen: T("2026-10-14T00:00:00Z"), lastSeen: T("2026-11-04T12:00:00Z") },
        ],
      },
      ...over,
    } as never,
  });
  assetId = a.id;
  for (const mac of [P, X]) {
    await prisma.assetSource.create({
      data: { assetId, sourceKind: "fortigate-endpoint", externalId: mac, observed: { hostname: HOST, mac } as never, firstSeen: new Date(), lastSeen: new Date() },
    });
  }
  return a.id;
}

const split = async (user: string, macs: string[], id = assetId) => {
  const s = await loginAs(user);
  return s.agent.post(`/api/v1/assets/${id}/macs/split`).set("X-CSRF-Token", s.csrf).send({ macs });
};

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX + "-user-" } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX + "-role-" } } });
  writeUser = await createRoleUser("write", matrix("none", { assets: "write" }));
  readUser = await createRoleUser("read", matrix("none", { assets: "read" }));
});

beforeEach(async () => { if (dbReachable) await seed(); });

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX + "-user-" } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX + "-role-" } } });
  await prisma.$disconnect();
});

d("POST /assets/:id/macs/split (business rule 91(j))", () => {
  it("needs assets:write", async () => {
    const r = await split(readUser, [X]);
    expect(r.status).toBe(403);
  });

  it("moves each MAC, its addresses, their history and its endpoint source onto a new asset", async () => {
    const r = await split(writeUser, [X, Y]);
    expect(r.status).toBe(200);
    expect(r.body.created).toHaveLength(2);

    const nx = await prisma.asset.findFirstOrThrow({
      where: { macAddress: X, id: { not: assetId } },
      include: { macAddressRows: true, associatedIpRows: true, ipHistory: true, sources: true },
    });
    expect(nx.hostname).toBe(`${HOST}-912B02`);
    expect(nx.ipAddress).toBe("10.99.242.11");
    expect(nx.createdBy).toBe(writeUser);
    expect(nx.macAddressRows.map((m) => m.mac)).toEqual([X]);
    expect(nx.associatedIpRows.map((a) => a.ip)).toEqual(["10.99.242.11"]);
    expect(nx.ipHistory.map((h) => h.ip)).toEqual(["10.99.242.11"]);
    expect(nx.sources.filter((s) => s.sourceKind === "fortigate-endpoint").map((s) => s.externalId)).toEqual([X]);

    const ny = await prisma.asset.findFirstOrThrow({
      where: { macAddress: Y, id: { not: assetId } },
      include: { associatedIpRows: true, ipHistory: true },
    });
    expect(ny.hostname).toBe(`${HOST}-912C03`);
    expect(ny.ipAddress).toBe("10.99.242.12"); // the freshest of its two
    expect(ny.associatedIpRows.map((a) => a.ip).sort()).toEqual(["10.99.242.12", "10.99.242.13"]);
    expect(ny.ipHistory.map((h) => h.ip)).toEqual(["10.99.242.12"]);

    const orig = await prisma.asset.findUniqueOrThrow({
      where: { id: assetId },
      include: { macAddressRows: true, associatedIpRows: true, ipHistory: true },
    });
    // Its name came from discovery (a fortigate-endpoint source), so it is named apart too.
    expect(orig.hostname).toBe(`${HOST}-912A01`);
    expect(orig.macAddress).toBe(P);
    expect(orig.macAddressRows.map((m) => m.mac).sort()).toEqual([P, NIC, RANGE].sort());
    expect(orig.associatedIpRows.map((a) => a.ip)).toEqual(["10.99.242.10"]);
    expect(orig.ipHistory.map((h) => h.ip)).toEqual(["10.99.242.10"]);
    // Monitored on a split address, pinned to a split MAC → moved off both.
    expect(orig.ipAddress).toBe("10.99.242.10");
    expect(orig.primaryAddressMac).toBeNull();
    expect(orig.primaryAddressIp).toBeNull();

    expect(await waitForEventCount("asset.mac_split", 2, assetId)).toBe(2);
  });

  it("refuses the primary MAC, the device's own NIC and port range, and an unknown MAC", async () => {
    expect((await split(writeUser, [P])).status).toBe(409);
    expect((await split(writeUser, [NIC])).status).toBe(409);
    expect((await split(writeUser, [RANGE])).status).toBe(409);
    expect((await split(writeUser, ["AA:BB:CC:00:00:99"])).status).toBe(404);
    // Nothing moved on a refusal.
    const n = await prisma.assetMacAddress.count({ where: { assetId } });
    expect(n).toBe(5);
  });

  it("accepts any MAC spelling", async () => {
    const r = await split(writeUser, [X.toLowerCase().replace(/:/g, "-")]);
    expect(r.status).toBe(200);
    expect(r.body.created[0].mac).toBe(X);
  });

  it("refuses a quarantined asset", async () => {
    await prisma.asset.update({ where: { id: assetId }, data: { quarantinedAt: new Date() } });
    expect((await split(writeUser, [X])).status).toBe(409);
  });

  it("an operator's name for the original is kept", async () => {
    await prisma.asset.update({ where: { id: assetId }, data: { hostname: HOST, hostnameOverride: HOST } });
    const r = await split(writeUser, [X]);
    expect(r.status).toBe(200);
    const orig = await prisma.asset.findUniqueOrThrow({ where: { id: assetId }, select: { hostname: true } });
    expect(orig.hostname).toBe(HOST);
    expect(r.body.created[0].hostname).toBe(`${HOST}-912B02`);
  });
});

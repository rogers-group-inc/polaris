/**
 * tests/integration/primaryIpv6.test.ts
 *
 * Business rule 127 against a real database:
 *
 *  - **The reconcile picks the primary IPv6** from the asset's IPv6
 *    address-list rows, and clears it when the rows are gone.
 *  - **The operator pins one.** PUT /assets/:id/primary-ipv6 (assets:write)
 *    sets it, the reconcile leaves it alone, DELETE re-picks straight away.
 *  - **The IPv4 pin refuses an IPv6 address**, pointing at the IPv6 endpoint.
 *  - **IPv6 off**: a pin is refused (409), and the reconcile clears every
 *    unpinned value while keeping an operator's pin.
 *  - **The Server Settings switch** reads and writes the mode.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import { setIpv6Enabled, initializeIpv6Setting, _resetIpv6GateForTests } from "../../src/services/ipv6GateService.js";
import { reconcilePrimaryIpv6 } from "../../src/services/primaryIpv6Service.js";

const d = dbDescribe;
const PFX = "primv6-test";
const PASSWORD = "primv6-password-not-real";
const MAC = "AA:BB:CC:06:06:01";
const V6_A = "2001:db8:127::a";
const V6_B = "2001:db8:127::b";
let assetId = "";
let writeUser = "";
let readUser = "";
let adminUser = "";

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

async function cleanup(): Promise<void> {
  await prisma.asset.deleteMany({ where: { OR: [{ hostname: { startsWith: PFX } }, { macAddress: MAC }] } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  writeUser = await createRoleUser("w", matrix("none", { assets: "write" }));
  readUser = await createRoleUser("r", matrix("none", { assets: "read" }));
  adminUser = await createRoleUser("a", matrix("none", { serverSettingsSystem: "write" }));
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.setting.deleteMany({ where: { key: "ipv6Config" } });
  _resetIpv6GateForTests();
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX + "-user-" } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX + "-role-" } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  _resetIpv6GateForTests();
  await setIpv6Enabled(true, "test");
  const seen = new Date();
  assetId = (await prisma.asset.create({
    data: {
      hostname: PFX + "-sensor", macAddress: MAC, assetType: "other", status: "active", ipAddress: null,
      associatedIpRows: {
        create: [
          { ip: V6_A, source: "monitor-system-info", interfaceName: "eth0", mac: MAC, lastSeen: new Date(seen.getTime() - 60_000) },
          { ip: V6_B, source: "monitor-system-info", interfaceName: "eth0", mac: MAC, lastSeen: seen },
        ],
      },
    },
  })).id;
});

const primary = async () =>
  prisma.asset.findUniqueOrThrow({ where: { id: assetId }, select: { ipv6Address: true, ipv6Pinned: true, ipv6PinnedBy: true } });

d("primary IPv6 (rule 127)", () => {
  it("the reconcile picks one of the asset's IPv6 rows and clears it when they go", async () => {
    await reconcilePrimaryIpv6();
    expect([V6_A, V6_B]).toContain((await primary()).ipv6Address);

    await prisma.assetAssociatedIp.deleteMany({ where: { assetId } });
    await reconcilePrimaryIpv6();
    expect((await primary()).ipv6Address).toBeNull();
  });

  it("a pin holds against the reconcile; unpinning re-picks", async () => {
    const w = await loginAs(writeUser);
    const put = await w.agent.put(`/api/v1/assets/${assetId}/primary-ipv6`).set("X-CSRF-Token", w.csrf).send({ ip: "2001:DB8:127::C" });
    expect(put.status).toBe(200);
    expect(put.body.ipv6Address).toBe("2001:db8:127::c");
    await reconcilePrimaryIpv6();
    expect(await primary()).toMatchObject({ ipv6Address: "2001:db8:127::c", ipv6Pinned: true, ipv6PinnedBy: writeUser });

    const del = await w.agent.delete(`/api/v1/assets/${assetId}/primary-ipv6`).set("X-CSRF-Token", w.csrf);
    expect(del.status).toBe(200);
    const after = await primary();
    expect(after.ipv6Pinned).toBe(false);
    expect([V6_A, V6_B]).toContain(after.ipv6Address);
  });

  it("refuses a pin from assets:read, a non-IPv6 value and a link-local one", async () => {
    const r = await loginAs(readUser);
    expect((await r.agent.put(`/api/v1/assets/${assetId}/primary-ipv6`).set("X-CSRF-Token", r.csrf).send({ ip: V6_A })).status).toBe(403);
    const w = await loginAs(writeUser);
    expect((await w.agent.put(`/api/v1/assets/${assetId}/primary-ipv6`).set("X-CSRF-Token", w.csrf).send({ ip: "10.0.0.1" })).status).toBe(400);
    expect((await w.agent.put(`/api/v1/assets/${assetId}/primary-ipv6`).set("X-CSRF-Token", w.csrf).send({ ip: "fe80::1" })).status).toBe(400);
  });

  it("the IPv4 pin refuses an IPv6 address", async () => {
    const w = await loginAs(writeUser);
    const res = await w.agent.put(`/api/v1/assets/${assetId}/primary-address`).set("X-CSRF-Token", w.csrf).send({ mac: MAC, ip: V6_A });
    expect(res.status).toBe(400);
    expect(String(res.body.error ?? res.body.message ?? "")).toMatch(/primary-ipv6/);
  });

  it("with IPv6 off: a pin is refused, unpinned values clear, a pin is kept", async () => {
    await reconcilePrimaryIpv6();
    const pinned = await prisma.asset.create({
      data: { hostname: PFX + "-pinned", assetType: "other", status: "active", ipv6Address: V6_A, ipv6Pinned: true },
    });
    await setIpv6Enabled(false, "test");

    const w = await loginAs(writeUser);
    expect((await w.agent.put(`/api/v1/assets/${assetId}/primary-ipv6`).set("X-CSRF-Token", w.csrf).send({ ip: V6_A })).status).toBe(409);

    await reconcilePrimaryIpv6();
    expect((await primary()).ipv6Address).toBeNull();
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: pinned.id } })).ipv6Address).toBe(V6_A);
  });

  it("Server Settings reads and writes the toggle", async () => {
    const a = await loginAs(adminUser);
    const put = await a.agent.put("/api/v1/server-settings/ipv6").set("X-CSRF-Token", a.csrf).send({ enabled: false });
    expect(put.status).toBe(200);
    expect(put.body.ipv6).toMatchObject({ enabled: false, setBy: "operator" });
    const get = await a.agent.get("/api/v1/server-settings/ipv6");
    expect(get.body.ipv6.enabled).toBe(false);
    expect(Array.isArray(get.body.ipv6.hostAddresses)).toBe(true);
    expect(typeof get.body.ipv6.hasRoute).toBe("boolean");
    expect(get.body.ipv6.dialable).toBe(false); // off is never dialable
    expect((await a.agent.put("/api/v1/server-settings/ipv6").set("X-CSRF-Token", a.csrf).send({ enabled: "yes" })).status).toBe(400);

    const w = await loginAs(writeUser);
    expect((await w.agent.put("/api/v1/server-settings/ipv6").set("X-CSRF-Token", w.csrf).send({ enabled: true })).status).toBe(403);
  });

  it("the install-time decision is made once, from the host, and never overrides a choice", async () => {
    await prisma.setting.deleteMany({ where: { key: "ipv6Config" } });
    _resetIpv6GateForTests();
    const first = await initializeIpv6Setting();
    expect(first.initialized).toBe(true);
    const row = await prisma.setting.findUnique({ where: { key: "ipv6Config" } });
    expect(row?.value).toMatchObject({ enabled: first.enabled, setBy: "install" });
    expect(await prisma.event.count({ where: { action: "settings.ipv6.initialized" } })).toBeGreaterThan(0);

    // Later boots: no-op. An operator's choice is kept even when it differs from the host.
    await setIpv6Enabled(!first.enabled, "test");
    _resetIpv6GateForTests();
    const again = await initializeIpv6Setting();
    expect(again).toEqual({ initialized: false, enabled: !first.enabled });
  });

  it("/auth/me carries the switch", async () => {
    const w = await loginAs(writeUser);
    const me = await w.agent.get("/api/v1/auth/me");
    expect(me.body.ipv6Enabled).toBe(true);
    expect(typeof me.body.ipv6Dialable).toBe("boolean");
  });
});

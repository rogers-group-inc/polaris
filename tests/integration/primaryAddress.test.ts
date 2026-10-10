/**
 * tests/integration/primaryAddress.test.ts
 *
 * Business rule 102 against a real database:
 *
 *  - **Discovery records every current binding per MAC.** A card can carry
 *    several addresses (a reservation plus a leftover lease, secondary IPs in
 *    ARP); each becomes its own AssetAssociatedIp row under that MAC.
 *  - **Current-state per gate.** A gate whose read succeeded drops the bindings
 *    it no longer reports; manual and interface-scrape rows are never touched.
 *  - **The operator pins one (MAC, IP) pair.** PUT /assets/:id/primary-address
 *    sets it (assets:write), refuses a pair that is not on the list, and the
 *    db.ts guard holds it against later discovery writes — following the card
 *    only when the pinned address went quiet and the card has one recent one.
 *  - **Removing the MAC releases the pin** and takes the MAC's discovered
 *    addresses with it.
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
import { syncDhcpSubnets } from "../../src/services/discovery/discoveryEngine.js";
import { _resetAgeSweepForTests } from "../../src/services/assetAddressService.js";
import { PIN_FOLLOW_STALE_MS } from "../../src/utils/assetInvariants.js";

const d = dbDescribe;
const PFX = "primaddr-test";
const PASSWORD = "primaddr-password-not-real";
const ETH = "AA:BB:CC:02:02:40";
const WIFI = "AA:BB:CC:02:02:95";
const GATE = "PRIMADDR-GW";
const IP_RES = "10.92.25.235";
const IP_SECONDARY = "10.92.25.236";
const IP_LEFTOVER = "10.92.6.23";
const IP_WIFI = "10.92.6.40";
let integrationId = "";
let assetId = "";
let writeUser = "";
let readUser = "";

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
  await prisma.asset.deleteMany({ where: { OR: [{ hostname: { startsWith: PFX } }, { macAddress: { in: [ETH, WIFI] } }] } });
  const intgs = await prisma.integration.findMany({ where: { name: PFX }, select: { id: true } });
  if (intgs.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: intgs.map((i) => i.id) } } });
    await prisma.integration.deleteMany({ where: { id: { in: intgs.map((i) => i.id) } } });
  }
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  writeUser = await createRoleUser("w", matrix("none", { assets: "write" }));
  readUser = await createRoleUser("r", matrix("none", { assets: "read" }));
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX + "-user-" } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX + "-role-" } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  _resetAgeSweepForTests();
  integrationId = (await prisma.integration.create({ data: { type: "fortimanager", name: PFX, config: {}, enabled: true } })).id;
  const seen = new Date();
  assetId = (await prisma.asset.create({
    data: {
      hostname: PFX + "-hmi", macAddress: ETH, assetType: "workstation", status: "active", ipAddress: IP_RES, ipSource: GATE,
      macAddressRows: {
        create: [
          { mac: ETH, source: "intune-ethernet", lastSeen: seen, firstSeen: seen },
          { mac: WIFI, source: "intune-wifi", lastSeen: seen, firstSeen: seen },
        ],
      },
    },
  })).id;
});

const dhcp = (over: Record<string, unknown>) => ({
  device: GATE, interfaceName: "internal", hostname: PFX + "-hmi", type: "dhcp-lease" as const, seenLeased: true, ...over,
});
const inv = (over: Record<string, unknown>) => ({
  device: GATE, hostname: PFX + "-hmi", os: "Windows", osVersion: "", hardwareVendor: "", interfaceName: "internal",
  switchName: "SW-1", switchPort: "3", apName: "", user: "", isOnline: true, lastSeen: new Date().toISOString(), ...over,
});

function run(opts: { dhcp?: any[]; inv?: any[]; arp?: any[]; readOk?: boolean } = {}) {
  const ok = opts.readOk !== false;
  return syncDhcpSubnets(integrationId, PFX, "fortimanager", {
    subnets: [], devices: [], interfaceIps: [],
    dhcpEntries: opts.dhcp ?? [], deviceInventory: opts.inv ?? [],
    inventoryDevices: ok ? [GATE] : [], knownDeviceNames: [GATE], knownDeviceSerials: [],
    fortiSwitches: [], fortiAps: [], vips: [], switchMacTable: [],
    arpTable: opts.arp ?? [], arpQueriedDevices: ok ? [GATE] : [],
    dhcpLeasesInventoriedDevices: ok ? [GATE] : [],
  } as any, "tester", "full");
}

/** The HMI as the gate sees it: two addresses on the Ethernet card plus an ARP secondary, one on Wi-Fi. */
const FULL_VIEW = {
  dhcp: [
    dhcp({ macAddress: ETH, ipAddress: IP_RES, type: "dhcp-reservation" }),
    dhcp({ macAddress: ETH, ipAddress: IP_LEFTOVER, expireTime: 2_000_000_000 }),
    dhcp({ macAddress: WIFI, ipAddress: IP_WIFI, accessPoint: "AP-1", ssid: "Plant", expireTime: 2_000_000_000 }),
    // Configuration nobody holds is not an address the device has.
    dhcp({ macAddress: ETH, ipAddress: "10.92.99.1", type: "dhcp-reservation", seenLeased: false }),
  ],
  inv: [inv({ macAddress: ETH, ipAddress: IP_RES })],
  arp: [{ fortigateDevice: GATE, ip: IP_SECONDARY, mac: ETH, interface: "internal" }],
};

const addresses = () =>
  prisma.assetAssociatedIp.findMany({ where: { assetId }, select: { ip: true, mac: true, source: true, device: true, medium: true }, orderBy: { ip: "asc" } });

d("per-MAC address list (business rule 102)", () => {
  it("records every current binding as its own row under its MAC", async () => {
    await run(FULL_VIEW);
    const rows = await addresses();
    const byIp = Object.fromEntries(rows.map((r) => [r.ip, r]));
    expect(Object.keys(byIp).sort()).toEqual([IP_RES, IP_SECONDARY, IP_LEFTOVER, IP_WIFI].sort());
    expect(byIp[IP_RES]).toMatchObject({ mac: ETH, source: "device-inventory", device: GATE, medium: "wired" });
    expect(byIp[IP_LEFTOVER]).toMatchObject({ mac: ETH, source: "dhcp-lease" });
    expect(byIp[IP_SECONDARY]).toMatchObject({ mac: ETH, source: "arp" });
    expect(byIp[IP_WIFI]).toMatchObject({ mac: WIFI, source: "dhcp-lease", medium: "wireless" });
    // And rule 101 still picks the monitored address.
    expect((await prisma.asset.findUnique({ where: { id: assetId } }))?.ipAddress).toBe(IP_RES);
  });

  it("drops a binding the gate stops reporting, but only when that read succeeded", async () => {
    await run(FULL_VIEW);
    await prisma.assetAssociatedIp.create({ data: { assetId, ip: "10.92.1.1", source: "manual" } });
    await prisma.assetAssociatedIp.create({ data: { assetId, ip: "10.92.1.2", source: "monitor-system-info", mac: ETH } });

    // A failed read keeps everything.
    await run({ readOk: false });
    expect((await addresses()).length).toBe(6);

    // A successful read without the leftover lease and the Wi-Fi lease drops them.
    await run({ dhcp: [FULL_VIEW.dhcp[0]!], inv: FULL_VIEW.inv, arp: FULL_VIEW.arp });
    const ips = (await addresses()).map((r) => r.ip);
    expect(ips).not.toContain(IP_LEFTOVER);
    expect(ips).not.toContain(IP_WIFI);
    expect(ips).toEqual(expect.arrayContaining([IP_RES, IP_SECONDARY, "10.92.1.1", "10.92.1.2"]));
  });

  it("never overwrites a manual or interface-scrape row for the same IP", async () => {
    await prisma.assetAssociatedIp.create({ data: { assetId, ip: IP_SECONDARY, source: "monitor-system-info", interfaceName: "eth0:1" } });
    await run(FULL_VIEW);
    const row = await prisma.assetAssociatedIp.findFirst({ where: { assetId, ip: IP_SECONDARY } });
    expect(row?.source).toBe("monitor-system-info");
    expect(row?.mac).toBe(ETH); // gains the MAC it lacked
  });
});

d("primary-address pin (business rule 102)", () => {
  it("PUT pins a pair from the list, and later discovery writes keep it", async () => {
    await run(FULL_VIEW);
    const { agent, csrf } = await loginAs(writeUser);
    const r = await agent.put(`/api/v1/assets/${assetId}/primary-address`).set("X-CSRF-Token", csrf).send({ mac: ETH, ip: IP_SECONDARY });
    expect(r.status).toBe(200);
    let a = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(a).toMatchObject({ ipAddress: IP_SECONDARY, ipSource: "pinned", primaryAddressMac: ETH, primaryAddressIp: IP_SECONDARY });

    // Discovery's winner is still IP_RES; the guard rewrites it back.
    await run(FULL_VIEW);
    a = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(a?.ipAddress).toBe(IP_SECONDARY);
    // And the identity MAC is not moved by a pin.
    expect(a?.macAddress).toBe(ETH);
  });

  it("refuses a pair not on the asset's list, and a read-only user", async () => {
    await run(FULL_VIEW);
    const w = await loginAs(writeUser);
    const bad = await w.agent.put(`/api/v1/assets/${assetId}/primary-address`).set("X-CSRF-Token", w.csrf).send({ mac: WIFI, ip: IP_RES });
    expect(bad.status).toBe(409);
    const ro = await loginAs(readUser);
    const denied = await ro.agent.put(`/api/v1/assets/${assetId}/primary-address`).set("X-CSRF-Token", ro.csrf).send({ mac: ETH, ip: IP_RES });
    expect(denied.status).toBe(403);
  });

  it("refuses to pin Fortinet infrastructure", async () => {
    await prisma.asset.update({ where: { id: assetId }, data: { assetType: "switch", fortinetTopology: { role: "fortiswitch" } } });
    await prisma.assetAssociatedIp.create({ data: { assetId, ip: IP_RES, mac: ETH, source: "manual" } });
    const w = await loginAs(writeUser);
    const r = await w.agent.put(`/api/v1/assets/${assetId}/primary-address`).set("X-CSRF-Token", w.csrf).send({ mac: ETH, ip: IP_RES });
    expect(r.status).toBe(409);
  });

  it("pinning replaces a typed override; typing an IP releases the pin", async () => {
    await run(FULL_VIEW);
    await prisma.asset.update({ where: { id: assetId }, data: { ipAddress: "10.92.50.50", ipOverride: "10.92.50.50", ipSource: "manual" } });
    const w = await loginAs(writeUser);
    await w.agent.put(`/api/v1/assets/${assetId}/primary-address`).set("X-CSRF-Token", w.csrf).send({ mac: ETH, ip: IP_SECONDARY });
    let a = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(a?.ipOverride).toBeNull();
    expect(a?.ipAddress).toBe(IP_SECONDARY);

    const put = await w.agent.put(`/api/v1/assets/${assetId}`).set("X-CSRF-Token", w.csrf).send({ ipAddress: "10.92.60.60" });
    expect(put.status).toBe(200);
    a = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(a).toMatchObject({ ipAddress: "10.92.60.60", ipOverride: "10.92.60.60", primaryAddressMac: null, primaryAddressIp: null });
  });

  it("follows the card when the pinned address went quiet and the card has one recent address", async () => {
    await run(FULL_VIEW);
    const w = await loginAs(writeUser);
    await w.agent.put(`/api/v1/assets/${assetId}/primary-address`).set("X-CSRF-Token", w.csrf).send({ mac: ETH, ip: IP_LEFTOVER });
    // The card renumbered: only one ETH address is recent now.
    const old = new Date(Date.now() - PIN_FOLLOW_STALE_MS - 60_000);
    await prisma.assetAssociatedIp.updateMany({ where: { assetId, mac: ETH }, data: { lastSeen: old } });
    await prisma.assetAssociatedIp.update({ where: { assetId_ip: { assetId, ip: IP_RES } }, data: { lastSeen: new Date() } });

    await prisma.asset.update({ where: { id: assetId }, data: { ipAddress: "10.92.77.77", ipSource: GATE } });
    const a = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(a).toMatchObject({ ipAddress: IP_RES, primaryAddressIp: IP_RES, primaryAddressMac: ETH });
  });

  it("DELETE releases the pin", async () => {
    await run(FULL_VIEW);
    const w = await loginAs(writeUser);
    await w.agent.put(`/api/v1/assets/${assetId}/primary-address`).set("X-CSRF-Token", w.csrf).send({ mac: ETH, ip: IP_SECONDARY });
    const del = await w.agent.delete(`/api/v1/assets/${assetId}/primary-address`).set("X-CSRF-Token", w.csrf);
    expect(del.status).toBe(200);
    const a = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(a?.primaryAddressMac).toBeNull();
    await run(FULL_VIEW);
    expect((await prisma.asset.findUnique({ where: { id: assetId } }))?.ipAddress).toBe(IP_RES);
  });

  it("removing the pinned MAC releases the pin and its discovered addresses", async () => {
    await run(FULL_VIEW);
    const w = await loginAs(writeUser);
    await w.agent.put(`/api/v1/assets/${assetId}/primary-address`).set("X-CSRF-Token", w.csrf).send({ mac: WIFI, ip: IP_WIFI });
    const del = await w.agent.delete(`/api/v1/assets/${assetId}/macs/${WIFI}`).set("X-CSRF-Token", w.csrf);
    expect(del.status).toBe(200);
    const a = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(a?.primaryAddressMac).toBeNull();
    expect((await addresses()).some((r) => r.mac === WIFI)).toBe(false);
  });

  it("GET /assets/:id carries the pin and each address's MAC, gate and medium", async () => {
    await run(FULL_VIEW);
    const w = await loginAs(writeUser);
    await w.agent.put(`/api/v1/assets/${assetId}/primary-address`).set("X-CSRF-Token", w.csrf).send({ mac: ETH, ip: IP_RES });
    const r = await w.agent.get(`/api/v1/assets/${assetId}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ primaryAddressMac: ETH, primaryAddressIp: IP_RES });
    const row = (r.body.associatedIps as any[]).find((x) => x.ip === IP_RES);
    expect(row).toMatchObject({ mac: ETH, device: GATE, medium: "wired" });
  });
});

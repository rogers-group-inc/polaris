/**
 * tests/integration/assetIpamAddressCheck.test.ts
 *
 * Business rule 102(a) against a real database: opening an asset's details
 * (GET /assets/:id) re-checks its discovered DHCP addresses against IPAM.
 *
 *  - An address IPAM released, or now gives to another MAC, leaves the list —
 *    with an Event naming it.
 *  - A lease IPAM now records as a reservation is re-labelled.
 *  - IPAM without a subnet for the address on that gate has no opinion: the
 *    row stays. So do ARP, detected-device, interface-scrape and manual rows.
 *  - The same address behind a DIFFERENT gate is not this subnet's to judge.
 *  - A read grant is enough.
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

const d = dbDescribe;
const PFX = "ipamchk-test";
const PASSWORD = "ipamchk-password-not-real";
const ETH = "AA:BB:CC:03:03:40";
const OTHER = "AA:BB:CC:03:03:99";
const GATE = "IPAMCHK-GW";
const OTHER_GATE = "IPAMCHK-GW2";
const BLOCK = "10.93.0.0/16";
const CIDR = "10.93.6.0/24";
let assetId = "";
let subnetId = "";
let readUser = "";

function matrix(base: string, overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) out[key] = overrides[key] ?? base;
  return out;
}

async function loginAs(username: string) {
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const resp = await agent.post("/api/v1/auth/login").send({ username, password: PASSWORD }).set("Content-Type", "application/json");
  if (resp.status !== 200) throw new Error("login as " + username + " failed (" + resp.status + ")");
  return agent;
}
let agent: ReturnType<typeof request.agent>;

async function cleanup(): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.ipBlock.deleteMany({ where: { cidr: BLOCK } });
  await prisma.event.deleteMany({ where: { action: "asset.addresses_ipam_reconciled", resourceName: { startsWith: PFX } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX + "-user-" } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX + "-role-" } } });
  const role = await prisma.role.create({ data: { name: PFX + "-role-r", permissions: matrix("none", { assets: "read" }) } });
  readUser = PFX + "-user-r";
  await prisma.user.create({
    data: { username: readUser, passwordHash: await hashPassword(PASSWORD), roleId: role.id, authProvider: "local" },
  });
  agent = await loginAs(readUser);
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
  const block = await prisma.ipBlock.create({ data: { name: PFX, cidr: BLOCK, ipVersion: "v4" } });
  subnetId = (await prisma.subnet.create({
    data: { blockId: block.id, cidr: CIDR, name: PFX, fortigateDevice: GATE },
  })).id;
  // No ipAddress: an asset whose primary IP sits in a known subnet gets a
  // dns_resolved reservation from rule 11, fire-and-forget off this write, and
  // it raced the first test's own reserve("10.93.6.10") for the
  // (subnet, ip, status) slot — CI lost it on 2026-10-14. The check under test
  // reads the associated-IP rows, never the asset's own address.
  assetId = (await prisma.asset.create({
    data: { hostname: PFX + "-hmi", macAddress: ETH, assetType: "workstation", status: "active" },
  })).id;
});

const seen = () => new Date();
async function addr(ip: string, source: string, over: Record<string, unknown> = {}) {
  await prisma.assetAssociatedIp.create({
    data: { assetId, ip, source, mac: ETH, device: GATE, lastSeen: seen(), firstSeen: seen(), ...over },
  });
}
async function reserve(ip: string, over: Record<string, unknown> = {}) {
  await prisma.reservation.create({
    data: { subnetId, ipAddress: ip, macAddress: ETH, sourceType: "dhcp_lease", status: "active", ...over },
  });
}
async function open() {
  const res = await agent.get("/api/v1/assets/" + assetId);
  expect(res.status).toBe(200);
  return (res.body.associatedIps as Array<{ ip: string; source: string }>).sort((a, b) => a.ip.localeCompare(b.ip));
}

d("asset details re-check DHCP addresses against IPAM (business rule 102(a))", () => {
  it("drops an address IPAM released and one IPAM gives to another MAC, and logs both", async () => {
    await addr("10.93.6.10", "dhcp-lease");
    await addr("10.93.6.11", "dhcp-lease");
    await addr("10.93.6.12", "dhcp-reservation");
    await reserve("10.93.6.10");
    await reserve("10.93.6.11", { status: "released" });
    await reserve("10.93.6.12", { macAddress: OTHER.toLowerCase(), sourceType: "dhcp_reservation" });

    expect((await open()).map((r) => r.ip)).toEqual(["10.93.6.10"]);
    const ev = await prisma.event.findFirst({ where: { action: "asset.addresses_ipam_reconciled", resourceId: assetId } });
    expect(ev?.message).toContain("10.93.6.11");
    expect(ev?.message).toContain("10.93.6.12");
    expect(ev?.actor).toBe(readUser);
  });

  it("re-labels a lease IPAM now records as a reservation", async () => {
    await addr("10.93.6.20", "dhcp-lease");
    await reserve("10.93.6.20", { sourceType: "dhcp_reservation" });
    expect(await open()).toMatchObject([{ ip: "10.93.6.20", source: "dhcp-reservation" }]);
  });

  it("leaves rows IPAM cannot judge: no subnet, another gate, and non-DHCP sources", async () => {
    await addr("10.94.1.5", "dhcp-lease");                        // no IPAM subnet holds it
    await addr("10.93.6.30", "dhcp-lease", { device: OTHER_GATE }); // same space, different gate
    await addr("10.93.6.31", "arp");
    await addr("10.93.6.32", "device-inventory");
    await addr("10.93.6.33", "monitor-system-info");
    await addr("10.93.6.34", "manual");
    expect((await open()).map((r) => r.ip)).toEqual(
      ["10.93.6.30", "10.93.6.31", "10.93.6.32", "10.93.6.33", "10.93.6.34", "10.94.1.5"],
    );
    expect(await prisma.event.count({ where: { action: "asset.addresses_ipam_reconciled", resourceId: assetId } })).toBe(0);
  });

  it("writes nothing when the list already agrees with IPAM", async () => {
    await addr("10.93.6.40", "dhcp-reservation");
    await reserve("10.93.6.40", { sourceType: "dhcp_reservation" });
    const before = await prisma.assetAssociatedIp.findFirst({ where: { assetId, ip: "10.93.6.40" } });
    await open();
    const after = await prisma.assetAssociatedIp.findFirst({ where: { assetId, ip: "10.93.6.40" } });
    expect(after).toEqual(before);
  });
});

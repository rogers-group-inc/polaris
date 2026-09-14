/**
 * tests/integration/assetVips.test.ts
 *
 * GET /assets/:id/vips — the General tab's VIP / Virtual Server rows: the
 * external address a published device answers on, and the firewall the VIP is
 * configured on.
 *
 * What needs a real database here is everything the row depends on and nothing
 * the service itself computes:
 *
 *   - the VIP facts are reached through the CONTAINMENT join, so an identical
 *     address in another block's subnet must not contribute a row;
 *   - the gate is named by FortiManager's DEVICE NAME, so a gate whose own
 *     hostname differs must still resolve (the fortinetParentKey contract) —
 *     and a gate Polaris holds no row for must still be NAMED;
 *   - an asset's ASSOCIATED addresses count, not just its primary one;
 *   - the endpoint is gated `reservations:read` on top of `assets:read`.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { resolveAssetVips } from "../../src/services/assetVipService.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

const PFX = "assetvips-test";
const PASSWORD = "assetvips-password-not-real";
/** A role matrix: `base` everywhere, then the named overrides. */
function matrix(base: string, overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) out[key] = overrides[key] ?? base;
  return out;
}

const FMG_DEVICE_NAME = "SITE-A-FGT-PRIMARY";
const SERVER_IP = "10.88.1.50";
const SERVER_ALT_IP = "10.88.2.50";
const EXT_IP = "203.0.113.10";
const EXT_IP_ALT = "203.0.113.11";

let gate = "";
let server = "";
let plain = "";

/** An active reservation on `ip` in `subnetId`, optionally VIP-stamped. */
async function reserve(subnetId: string, ip: string, vipInfo: Record<string, unknown> | null) {
  return prisma.reservation.create({
    data: {
      subnetId,
      ipAddress: ip,
      hostname: "res-" + ip,
      status: "active",
      sourceType: vipInfo ? "vip" : "manual",
      ...(vipInfo ? { vipInfo: vipInfo as any } : {}),
    },
  });
}

/** A caller holding assets:read but NOT reservations:read. */
let noResUser = "";
let noResAgent: ReturnType<typeof request.agent> | null = null;

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();

  await prisma.user.deleteMany({ where: { username: { startsWith: `${PFX}-user-` } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: `${PFX}-role-` } } });
  const role = await prisma.role.create({
    data: { name: `${PFX}-role-nores`, permissions: matrix("none", { assets: "read" }) },
  });
  noResUser = `${PFX}-user-nores`;
  await prisma.user.create({
    data: { username: noResUser, passwordHash: await hashPassword(PASSWORD), roleId: role.id, authProvider: "local" },
  });
  noResAgent = request.agent(app);
  await noResAgent.get("/api/v1/auth/me");
  const resp = await noResAgent
    .post("/api/v1/auth/login")
    .send({ username: noResUser, password: PASSWORD })
    .set("Content-Type", "application/json");
  if (resp.status !== 200) throw new Error(`login as ${noResUser} failed (${resp.status})`);
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.user.deleteMany({ where: { username: { startsWith: `${PFX}-user-` } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: `${PFX}-role-` } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.reservation.deleteMany();
  await prisma.subnet.deleteMany();
  await prisma.ipBlock.deleteMany();
  await prisma.assetAssociatedIp.deleteMany();
  await prisma.asset.deleteMany();

  const block = await prisma.ipBlock.create({
    data: { name: "VIP Test Block", cidr: "10.88.0.0/16", ipVersion: "v4" },
  });
  const inside = await prisma.subnet.create({
    data: { blockId: block.id, cidr: "10.88.1.0/24", name: "Servers", status: "available" },
  });
  const insideAlt = await prisma.subnet.create({
    data: { blockId: block.id, cidr: "10.88.2.0/24", name: "Servers B", status: "available" },
  });

  // The gate's hostname deliberately DIFFERS from its FMG device name — which
  // is the name `vipInfo.device` carries, so a hostname match finds nothing.
  gate = (
    await prisma.asset.create({
      data: {
        hostname: "fgt-a.example.internal",
        assetType: "firewall",
        status: "active",
        ipAddress: "10.88.0.1",
        fortinetTopology: { deviceName: FMG_DEVICE_NAME } as any,
      },
    })
  ).id;

  server = (
    await prisma.asset.create({
      data: { hostname: "WEB-01", assetType: "server", status: "active", ipAddress: SERVER_IP },
    })
  ).id;
  await prisma.assetAssociatedIp.create({
    data: { assetId: server, ip: SERVER_ALT_IP, source: "monitor-interface" },
  });

  plain = (
    await prisma.asset.create({
      data: { hostname: "WEB-02", assetType: "server", status: "active", ipAddress: "10.88.1.51" },
    })
  ).id;

  // The primary address is a VIP's mapped target…
  await reserve(inside.id, SERVER_IP, {
    name: "web-prod", device: FMG_DEVICE_NAME, extip: EXT_IP, role: "mapped", isVirtualServer: false,
  });
  // …and the associated address is a virtual server's pool member, on a gate
  // Polaris holds no Asset row for.
  await reserve(insideAlt.id, SERVER_ALT_IP, {
    name: "lb-pool", device: "GATE-NOT-IN-INVENTORY", extip: EXT_IP_ALT, role: "realserver", isVirtualServer: true,
  });
  // A plain reservation is not a VIP.
  await reserve(inside.id, "10.88.1.51", null);
});

d("GET /assets/:id/vips", () => {
  it("names the external address and the gate, for the primary AND associated addresses", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${server}/vips`);
    expect(res.status).toBe(200);
    expect(res.body.vips).toHaveLength(2);

    // Sorted outside-in: mapped before realserver.
    const [mapped, pool] = res.body.vips;
    expect(mapped).toMatchObject({
      ip: SERVER_IP,
      subnetCidr: "10.88.1.0/24",
      name: "web-prod",
      extip: EXT_IP,
      role: "mapped",
      isVirtualServer: false,
      device: FMG_DEVICE_NAME,
    });
    // The whole point of routing through fortinetParentKey: the VIP names the
    // gate by its FMG device name, and the gate's hostname is something else.
    expect(mapped.asset).toEqual({ id: gate, hostname: "fgt-a.example.internal" });

    expect(pool).toMatchObject({
      ip: SERVER_ALT_IP,
      name: "lb-pool",
      extip: EXT_IP_ALT,
      role: "realserver",
      isVirtualServer: true,
      device: "GATE-NOT-IN-INVENTORY",
    });
    // Unresolved is a state, not an error — the VIP is still worth naming.
    expect(pool.asset).toBeNull();
  });

  it("returns nothing for an asset whose reservation carries no VIP stamp", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${plain}/vips`);
    expect(res.status).toBe(200);
    expect(res.body.vips).toEqual([]);
  });

  it("ignores a same-address VIP reservation in a subnet that doesn't contain the asset", async () => {
    // Another block carrying the same 10.88.2.0/24 address space. The asset's
    // address resolves to ONE containing subnet, so only that subnet's
    // reservation may contribute — a raw match on ipAddress would pick up both.
    const otherBlock = await prisma.ipBlock.create({
      data: { name: "Shadow Block", cidr: "10.99.0.0/16", ipVersion: "v4" },
    });
    const shadow = await prisma.subnet.create({
      data: { blockId: otherBlock.id, cidr: "10.99.9.0/24", name: "Shadow", status: "available" },
    });
    await reserve(shadow.id, SERVER_IP, {
      name: "wrong-vip", device: FMG_DEVICE_NAME, extip: "198.51.100.9", role: "mapped", isVirtualServer: false,
    });

    const result = await resolveAssetVips(server);
    expect(result!.vips.map((v) => v.name).sort()).toEqual(["lb-pool", "web-prod"]);
  });

  it("404s for an asset that doesn't exist", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/assets/00000000-0000-0000-0000-000000000000/vips");
    expect(res.status).toBe(404);
  });

  it("403s a caller without reservations:read — the facts live on a reservation", async () => {
    const res = await noResAgent!.get(`/api/v1/assets/${server}/vips`);
    expect(res.status).toBe(403);
  });
});

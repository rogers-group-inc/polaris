/**
 * tests/integration/pinMovesLastSeenGate.test.ts
 *
 * Business rule 101(b) at pin time: pinning an asset's primary address (the
 * address-list pin, or an address typed in Edit) moves its last-seen FortiGate
 * (`Asset.learnedLocation`) to the gate whose IPAM network holds that address —
 * and leaves it alone when IPAM cannot say.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable, ensureTestUser, authedAgent } from "./_helpers.js";
import { pinPrimaryAddress } from "../../src/services/primaryAddressService.js";

const d = dbDescribe;
const PFX = "pingate-test";
const MAC = "AA:BB:CC:08:08:40";
const BLOCK = "10.98.0.0/16";

async function cleanup(): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.ipBlock.deleteMany({ where: { cidr: BLOCK } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});
afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});
beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const block = await prisma.ipBlock.create({ data: { name: PFX, cidr: BLOCK, ipVersion: "v4" } });
  await prisma.subnet.create({ data: { blockId: block.id, cidr: "10.98.1.0/24", name: PFX + "-a", fortigateDevice: "PINGATE-A" } });
  await prisma.subnet.create({ data: { blockId: block.id, cidr: "10.98.2.0/24", name: PFX + "-b", fortigateDevice: "PINGATE-B" } });
});

async function makeAsset(name: string): Promise<string> {
  const a = await prisma.asset.create({
    data: {
      hostname: PFX + "-" + name, assetType: "workstation", status: "active", macAddress: MAC,
      ipAddress: "10.98.1.10", learnedLocation: "PINGATE-A",
      macAddressRows: { create: [{ mac: MAC, source: "dhcp_lease" }] },
    },
  });
  for (const [ip, device] of [["10.98.1.10", "PINGATE-A"], ["10.98.2.20", "PINGATE-B"], ["10.99.9.9", "PINGATE-X"]]) {
    await prisma.assetAssociatedIp.create({
      data: { assetId: a.id, ip, mac: MAC, source: "dhcp-lease", device, firstSeen: new Date(), lastSeen: new Date() },
    });
  }
  return a.id;
}
const gateOf = async (id: string) =>
  (await prisma.asset.findUniqueOrThrow({ where: { id }, select: { learnedLocation: true } })).learnedLocation;

d("pinning an address moves the last-seen FortiGate (business rule 101(b))", () => {
  it("the address-list pin names the gate whose network holds the pinned address", async () => {
    const id = await makeAsset("listpin");
    await pinPrimaryAddress({ assetId: id, mac: MAC, ip: "10.98.2.20", actor: "tester" });
    expect(await gateOf(id)).toBe("PINGATE-B");
    const ev = await prisma.event.findFirst({ where: { action: "asset.primary_address.pinned", resourceId: id } });
    expect((ev?.details as any)?.learnedLocation).toEqual({ from: "PINGATE-A", to: "PINGATE-B" });
  });

  it("leaves the gate alone when no IPAM network holds the pinned address", async () => {
    const id = await makeAsset("noipam");
    await pinPrimaryAddress({ assetId: id, mac: MAC, ip: "10.99.9.9", actor: "tester" });
    expect(await gateOf(id)).toBe("PINGATE-A");
  });

  it("an address typed in Edit moves the gate too", async () => {
    const id = await makeAsset("typed");
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.put(`/api/v1/assets/${id}`).set("X-CSRF-Token", csrf).send({ ipAddress: "10.98.2.77" });
    expect(res.status).toBe(200);
    expect(await gateOf(id)).toBe("PINGATE-B");
  });
});

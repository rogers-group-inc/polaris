/**
 * tests/integration/assetAddressNetworks.test.ts
 *
 * The asset panel names the IPAM network each address sits in: GET
 * /assets/:id carries `network` on every associatedIps row (the IPs hover),
 * and GET /assets/:id/ip-history carries `vlan` + `network` per row (the IP
 * History table's VLAN column). Gate-aware: the same private range behind two
 * gates resolves to the row's own gate's network.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable, ensureTestUser, authedAgent } from "./_helpers.js";

const d = dbDescribe;
const PFX = "addrnet-test";
const MAC = "AA:BB:CC:09:09:40";
const BLOCK_A = "10.96.0.0/16";

async function cleanup(): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.ipBlock.deleteMany({ where: { name: { startsWith: PFX } } });
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
  const a = await prisma.ipBlock.create({ data: { name: PFX + "-a", cidr: BLOCK_A, ipVersion: "v4" } });
  await prisma.subnet.create({ data: { blockId: a.id, cidr: "10.96.1.0/24", name: PFX + "-data", vlan: 51, fortigateDevice: "ADDRNET-A" } });
  await prisma.subnet.create({ data: { blockId: a.id, cidr: "10.96.2.0/24", name: PFX + "-voice", vlan: 52, fortigateDevice: "ADDRNET-A" } });
});

d("the asset panel names each address's network", () => {
  it("GET /assets/:id puts the network on each address row, and /ip-history the VLAN", async () => {
    const asset = await prisma.asset.create({
      data: {
        hostname: PFX + "-pc", assetType: "workstation", status: "active", macAddress: MAC,
        ipAddress: "10.96.1.10", ipSource: "ADDRNET-A", learnedLocation: "ADDRNET-A",
        macAddressRows: { create: [{ mac: MAC, source: "dhcp_lease" }] },
      },
    });
    await prisma.assetAssociatedIp.create({
      data: { assetId: asset.id, ip: "10.96.2.20", mac: MAC, source: "device-inventory", device: "ADDRNET-A", firstSeen: new Date(), lastSeen: new Date() },
    });
    await prisma.assetAssociatedIp.create({
      data: { assetId: asset.id, ip: "172.31.9.9", mac: MAC, source: "arp", device: "ADDRNET-A", firstSeen: new Date(), lastSeen: new Date() },
    });

    const { agent } = await authedAgent(app);
    const detail = await agent.get(`/api/v1/assets/${asset.id}`);
    expect(detail.status).toBe(200);
    const byIp = new Map((detail.body.associatedIps as any[]).map((r) => [r.ip, r]));
    expect(byIp.get("10.96.2.20")?.network).toMatchObject({ name: PFX + "-voice", cidr: "10.96.2.0/24", vlan: 52 });
    expect(byIp.get("172.31.9.9")?.network).toBeNull();

    const hist = await agent.get(`/api/v1/assets/${asset.id}/ip-history`);
    expect(hist.status).toBe(200);
    const row = (hist.body as any[]).find((h) => h.ip === "10.96.1.10");
    expect(row).toMatchObject({ vlan: 51, network: { name: PFX + "-data" } });
  });
});

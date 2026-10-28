/**
 * tests/integration/assistantSlideIns.test.ts
 *
 * The assistant's asset_details and get_network tools (business rule 95)
 * against real rows — the unit tests mock Prisma, so this is what proves
 * every section's query runs on the real schema:
 *  - every asset_details section answers for a role that holds every read
 *    key, none of them with an error, and the rows written come back;
 *  - get_network answers the panel's page with the holder and asset of each
 *    used address, whole-network counts and the first free addresses.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import { runAssistantTool } from "../../src/services/assistantToolService.js";
import { ASSET_SECTIONS } from "../../src/services/assetDetailReadService.js";

const d = dbDescribe;
const HOST = "assistant-slidein-test";
const CIDR = "10.250.77.0/29";
const READ_ALL = Object.fromEntries(
  ["assets", "subnets", "reservations", "contacts", "assetsQuarantine", "alerts", "automationManagement"].map((k) => [k, "read"]),
);
const req = { session: { userId: "u1", roleSnapshot: { permissions: READ_ALL } } } as never;
let assetId = "";

async function wipe(): Promise<void> {
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: HOST } }, select: { id: true } });
  const list = assets.map((a) => a.id);
  if (list.length) {
    await prisma.assetPhysicalEntity.deleteMany({ where: { assetId: { in: list } } });
    await prisma.assetHardwareSensorSample.deleteMany({ where: { assetId: { in: list } } });
    await prisma.assetMacTableEntry.deleteMany({ where: { assetId: { in: list } } });
    await prisma.assetProcess.deleteMany({ where: { assetId: { in: list } } });
    await prisma.assetMclagPeer.deleteMany({ where: { assetId: { in: list } } });
    await prisma.assetIpHistory.deleteMany({ where: { assetId: { in: list } } });
    await prisma.asset.deleteMany({ where: { id: { in: list } } });
  }
  await prisma.ipBlock.deleteMany({ where: { name: HOST } });
}

d("asset_details + get_network", () => {
  beforeAll(async () => {
    await wipe();
    const a = await prisma.asset.create({
      data: { hostname: `${HOST}-sw`, status: "active", assetType: "switch", ipAddress: "10.250.77.2", notes: "rack 4" } as never,
    });
    assetId = a.id;
    await prisma.assetPhysicalEntity.create({ data: { assetId, entIndex: 1, entClass: "powerSupply", name: "PSU 1", serialNum: "PSU-123", isFru: true } });
    await prisma.assetHardwareSensorSample.create({ data: { assetId, timestamp: new Date(), sensorName: "CPU", sensorClass: "temperature", value: 51, unit: "C" } });
    await prisma.assetMacTableEntry.create({ data: { assetId, macAddress: "0A:00:00:00:00:01", vlanId: 20, ifName: "port1", status: "learned" } });
    await prisma.assetProcess.create({ data: { assetId, name: "sshd", instanceCount: 2, cpuPct: 0.5 } });
    await prisma.assetMclagPeer.create({ data: { assetId, localPort: "port48", peerSn: "S124XXXX" } });

    const block = await prisma.ipBlock.create({ data: { name: HOST, cidr: "10.250.0.0/16", ipVersion: "v4" } as never });
    const subnet = await prisma.subnet.create({ data: { blockId: block.id, cidr: CIDR, name: `${HOST} net`, vlan: 20 } });
    await prisma.reservation.create({
      data: {
        subnetId: subnet.id, ipAddress: "10.250.77.2", hostname: `${HOST}-sw`, macAddress: "0A:00:00:00:00:02",
        status: "active", sourceType: "manual", notes: "core switch",
      } as never,
    });
  });
  afterAll(wipe);

  it("every section answers on the real schema", async () => {
    const r = await runAssistantTool(
      "asset_details",
      JSON.stringify({ id: assetId, sections: ASSET_SECTIONS.slice(0, 6) }),
      { req, maxRows: 50 },
    );
    const r2 = await runAssistantTool(
      "asset_details",
      JSON.stringify({ id: assetId, sections: ASSET_SECTIONS.slice(6, 12) }),
      { req, maxRows: 50 },
    );
    const r3 = await runAssistantTool(
      "asset_details",
      JSON.stringify({ id: assetId, sections: ASSET_SECTIONS.slice(12) }),
      { req, maxRows: 50 },
    );
    const all = { ...(r.data as any), ...(r2.data as any), ...(r3.data as any) };
    for (const s of ASSET_SECTIONS) {
      expect(all[s], s).toBeDefined();
      // A section-level failure is { error } in its slot; a nested
      // { error } (a firmware card with no engine) is the card's own answer.
      expect(all[s]?.error, `${s}: ${all[s]?.error}`).toBeUndefined();
    }
    expect(all.identity.notes).toBe("rack 4");
    expect(all.hardware.inventory.rows[0]).toMatchObject({ name: "PSU 1", serialNum: "PSU-123" });
    expect(all.hardware.sensors.rows[0]).toMatchObject({ sensorName: "CPU", value: 51 });
    expect(all.mac_table.rows[0]).toMatchObject({ macAddress: "0A:00:00:00:00:01", vlanId: 20, ifName: "port1" });
    expect(all.processes.processes.rows[0]).toMatchObject({ name: "sshd", instanceCount: 2 });
    expect(all.connections.mclagPeers[0]).toMatchObject({ localPort: "port48", peerSn: "S124XXXX" });
  });

  it("get_network reads the panel's page, counts and first free addresses", async () => {
    const r = (await runAssistantTool("get_network", JSON.stringify({ cidr: CIDR }), { req, maxRows: 50 })).data as any;
    expect(r).toMatchObject({ found: true, cidr: CIDR, vlan: 20 });
    expect(r.utilization).toMatchObject({ reserved: 1, usableHosts: 6, free: 5, byKind: { manual: 1 } });
    expect(r.firstFree[0]).toBe("10.250.77.1");
    expect(r.addresses.rows).toEqual([expect.objectContaining({
      address: "10.250.77.2", hostname: `${HOST}-sw`, macAddress: "0A:00:00:00:00:02", notes: "core switch",
      assetId, assetHostname: `${HOST}-sw`,
    })]);
  });
});

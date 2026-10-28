/**
 * tests/integration/networkTagInheritance.test.ts
 *
 * Business rule 137 end to end against a real database: a tag on a
 * FortiGate-discovered network lands on the ports of that gate's switches that
 * carry the network's VLAN (as "network" rows) and on the switch (with
 * NetworkTagAssignment provenance), and comes off again when the network loses
 * it — without ever touching a hand-applied or filter-applied copy.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import { reconcileNetworkTags } from "../../src/services/networkTagInheritanceService.js";
import { reconcileTagsForAsset } from "../../src/services/tagAssignmentService.js";
import { listInterfaceTags, setInterfaceTags } from "../../src/services/interfaceTagService.js";
import { updateSubnet } from "../../src/services/subnetService.js";

const d = dbDescribe;
const PFX = "nettag-test-";
const CRIT = `${PFX}Priority Critical`;
const WARN = `${PFX}Priority Warning`;

const ids: Record<string, string> = {};

async function portTags(assetId: string): Promise<string[]> {
  const rows = await prisma.assetInterfaceTag.findMany({ where: { assetId }, orderBy: [{ ifName: "asc" }, { tag: "asc" }] });
  return rows.map((r) => `${r.ifName}:${r.tag}:${r.source}`);
}

async function assetTags(assetId: string): Promise<string[]> {
  return [...(await prisma.asset.findUniqueOrThrow({ where: { id: assetId }, select: { tags: true } })).tags].sort();
}

async function cleanup(): Promise<void> {
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: PFX } }, select: { id: true } });
  await prisma.networkTagAssignment.deleteMany({ where: { assetId: { in: assets.map((a) => a.id) } } });
  // Cascades the interfaces and the interface tags.
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.subnet.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.ipBlock.deleteMany({ where: { name: { startsWith: PFX } } });
}

async function makeSwitch(name: string, controllerSerial: string, ports: Array<[string, number | null, number[], boolean?]>): Promise<string> {
  const a = await prisma.asset.create({
    data: {
      hostname: PFX + name,
      assetType: "switch",
      status: "active",
      fortinetTopology: { role: "fortiswitch", controllerSerial } as any,
    },
  });
  for (const [ifName, nativeVlan, taggedVlans, trunksAllVlans] of ports) {
    await prisma.assetInterface.create({
      data: { assetId: a.id, ifName, ifType: "physical", nativeVlan, taggedVlans, trunksAllVlans: trunksAllVlans === true },
    });
  }
  return a.id;
}

d("Network tags inherited by switches and ports (business rule 137)", () => {
  beforeEach(async () => {
    await cleanup();
    const block = await prisma.ipBlock.create({ data: { name: PFX + "block", cidr: "10.137.0.0/16", ipVersion: "v4" } as any });
    await prisma.asset.create({ data: { hostname: PFX + "gate-a", assetType: "firewall", status: "active", serialNumber: "NETTAGFGTA" } });
    await prisma.asset.create({ data: { hostname: PFX + "gate-b", assetType: "firewall", status: "active", serialNumber: "NETTAGFGTB" } });
    // Gate A serves VLAN 30 (Critical) and VLAN 40 (Warning).
    ids.net30 = (await prisma.subnet.create({
      data: { blockId: block.id, cidr: "10.137.30.0/24", name: PFX + "v30", vlan: 30, fortigateSerial: "NETTAGFGTA",
        fortigateDevice: "gate-a", tags: [CRIT, "dhcp-discovered", "fortigate"] },
    })).id;
    ids.net40 = (await prisma.subnet.create({
      data: { blockId: block.id, cidr: "10.137.40.0/24", name: PFX + "v40", vlan: 40, fortigateSerial: "NETTAGFGTA",
        fortigateDevice: "gate-a", tags: [WARN] },
    })).id;
    // A DHCP-server-learned network on VLAN 30: no gate, hands nothing down.
    await prisma.subnet.create({
      data: { blockId: block.id, cidr: "10.137.130.0/24", name: PFX + "dhcp", vlan: 30, tags: [`${PFX}from-dhcp`] },
    });
    ids.swA = await makeSwitch("sw-a", "NETTAGFGTA", [
      ["port1", 30, []],
      ["port2", 40, []],
      ["port3", 50, []],
      ["port47", 1, [30, 40]],
      ["fortilink", 1, [30, 40], true],
    ]);
    // Behind gate B: VLAN 30 there is a different network entirely.
    ids.swB = await makeSwitch("sw-b", "NETTAGFGTB", [["port1", 30, []]]);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("tags the carrying ports and the switch, skips the allow-all trunk and the other gate's switch", async () => {
    await reconcileNetworkTags();
    expect(await portTags(ids.swA)).toEqual([
      `port1:${CRIT}:network`,
      `port2:${WARN}:network`,
      `port47:${CRIT}:network`,
      `port47:${WARN}:network`,
    ]);
    expect(await assetTags(ids.swA)).toEqual([CRIT, WARN]);
    expect(await portTags(ids.swB)).toEqual([]);
    expect(await assetTags(ids.swB)).toEqual([]);

    const view = (await listInterfaceTags(ids.swA)).get("port1");
    expect(view).toEqual([expect.objectContaining({ name: CRIT, auto: true, via: "network" })]);

    // Idempotent: a second pass writes nothing.
    expect(await reconcileNetworkTags()).toEqual({ assetsAdded: 0, assetsRemoved: 0, portsAdded: 0, portsRemoved: 0 });
  });

  it("takes the tags back off when the network loses them, and leaves a hand-applied copy alone", async () => {
    // The operator tagged port2 and the switch with Warning by hand first.
    await prisma.assetInterfaceTag.create({ data: { assetId: ids.swA, ifName: "port2", tag: WARN, source: "manual" } });
    await prisma.asset.update({ where: { id: ids.swA }, data: { tags: [WARN] } });
    await reconcileNetworkTags();
    expect(await portTags(ids.swA)).toContain(`port2:${WARN}:manual`);
    expect(await portTags(ids.swA)).not.toContain(`port2:${WARN}:network`);
    // The switch already carried Warning, so it is not claimed.
    expect(await prisma.networkTagAssignment.findMany({ where: { assetId: ids.swA }, select: { tag: true } }))
      .toEqual([{ tag: CRIT }]);

    await prisma.subnet.update({ where: { id: ids.net30 }, data: { tags: [] } });
    await prisma.subnet.update({ where: { id: ids.net40 }, data: { tags: [] } });
    await reconcileNetworkTags();
    expect(await portTags(ids.swA)).toEqual([`port2:${WARN}:manual`]);
    expect(await assetTags(ids.swA)).toEqual([WARN]);
    expect(await prisma.networkTagAssignment.count({ where: { assetId: ids.swA } })).toBe(0);
  });

  it("keeps an inherited port tag by hand when the operator names it", async () => {
    await reconcileNetworkTags();
    await setInterfaceTags(ids.swA, "port1", [CRIT], "tester");
    await prisma.subnet.update({ where: { id: ids.net30 }, data: { tags: [] } });
    await reconcileNetworkTags();
    expect((await portTags(ids.swA)).filter((t) => t.startsWith("port1:"))).toEqual([`port1:${CRIT}:manual`]);
  });

  it("does not put back a switch tag an operator took off", async () => {
    await reconcileNetworkTags();
    await prisma.asset.update({ where: { id: ids.swA }, data: { tags: [WARN] } });
    await reconcileNetworkTags();
    expect(await assetTags(ids.swA)).toEqual([WARN]);
  });

  it("follows a port that moves VLAN through the per-switch reconcile", async () => {
    await reconcileNetworkTags();
    await prisma.assetInterface.update({
      where: { assetId_ifName: { assetId: ids.swA, ifName: "port3" } },
      data: { nativeVlan: 30 },
    });
    await reconcileTagsForAsset(ids.swA);
    expect(await portTags(ids.swA)).toContain(`port3:${CRIT}:network`);
  });

  it("reconciles after a network edit through the subnet service", async () => {
    await reconcileNetworkTags();
    await updateSubnet(ids.net40, { tags: [WARN, `${PFX}extra`] } as any);
    // scheduleNetworkTagReconcile is fire-and-forget; wait for its row.
    for (let i = 0; i < 50; i++) {
      if ((await portTags(ids.swA)).includes(`port2:${PFX}extra:network`)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await portTags(ids.swA)).toContain(`port2:${PFX}extra:network`);
  });
});

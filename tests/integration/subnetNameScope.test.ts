/**
 * tests/integration/subnetNameScope.test.ts
 *
 * A `subnet` condition matched by registry Subnet NAME ("is in subnet named
 * Plant-*") through the real scope loader — the path the engine tick, the
 * wizard preview and the alert-group governed set all use. The unit suite
 * mocks the registry; this one proves the real query (non-deprecated subnets
 * only) and the stamp reach `loadScopeAssetIds`.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { loadScopeAssetIds } from "../../src/services/notificationEngine.js";
import { invalidateSubnetRegistryCache } from "../../src/services/scopeRelationIndex.js";

const d = dbDescribe;
const NAME = "subnet-name-scope-test";

async function wipe(): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: NAME } } });
  await prisma.ipBlock.deleteMany({ where: { name: { startsWith: NAME } } });
}

async function host(name: string, ip: string): Promise<string> {
  const a = await prisma.asset.create({
    data: { hostname: `${NAME}-${name}`, ipAddress: ip, status: "active", tags: [NAME] } as never,
    select: { id: true },
  });
  return a.id;
}

const scope = (operator: string, value: string) => ({
  condition: {
    op: "and",
    children: [
      { field: "tag", operator: "has", value: NAME },
      { field: "subnet", operator, value },
    ],
  },
});

d("subnet conditions matched by NAME", () => {
  beforeEach(async () => {
    await wipe();
    invalidateSubnetRegistryCache();
  });

  afterAll(async () => {
    if (dbReachable) await wipe();
  });

  it("selects devices in every subnet whose name matches, and skips deprecated ones", async () => {
    const block = await prisma.ipBlock.create({
      data: { name: `${NAME} block`, cidr: "10.251.0.0/16", ipVersion: "v4" } as never,
      select: { id: true },
    });
    await prisma.subnet.createMany({
      data: [
        { blockId: block.id, cidr: "10.251.1.0/24", name: "Plant-Ashfield" },
        { blockId: block.id, cidr: "10.251.2.0/24", name: "plant-dock" },
        { blockId: block.id, cidr: "10.251.3.0/24", name: "Office" },
        { blockId: block.id, cidr: "10.251.4.0/24", name: "Plant-Old", status: "deprecated" },
      ] as never,
    });
    const ash = await host("ash", "10.251.1.10");
    const dock = await host("dock", "10.251.2.10");
    const office = await host("office", "10.251.3.10");
    const old = await host("old", "10.251.4.10");

    const inPlant = await loadScopeAssetIds(scope("inSubnetNamed", "Plant-*") as never);
    expect(inPlant.sort()).toEqual([ash, dock].sort());

    const notPlant = await loadScopeAssetIds(scope("notInSubnetNamed", "Plant-*") as never);
    expect(notPlant.sort()).toEqual([office, old].sort());

    const inRange = await loadScopeAssetIds(scope("inRange", "10.251.1.0-10.251.2.255") as never);
    expect(inRange.sort()).toEqual([ash, dock].sort());
  });
});

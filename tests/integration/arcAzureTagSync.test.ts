/**
 * tests/integration/arcAzureTagSync.test.ts
 *
 * Azure resource tags mirrored onto Asset.tags as `azure:<key>=<value>` by the
 * Arc sync (opt-in, importAzureTags). The prefix is Arc-owned, so every run
 * strips every `azure:` tag off the assets it touches and re-adds the current
 * set — which is only safe if the strip never reaches an operator's tag.
 * Pinned against a real Postgres:
 *   1. toggle on: the tag lands, and syncAzureTagRegistry mints its registry row.
 *   2. a changed value in Azure replaces the old tag, keeps the operator's,
 *      and the registry prunes the name nothing carries any more.
 *   3. toggle off: the next run takes the mirrored tags back off.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncArcDevices, syncAzureTagRegistry } from "../../src/services/discovery/discoveryEngine.js";
import { normalizeArcMachine } from "../../src/services/azureArcService.js";

const d = dbDescribe;
const HOST = "arc-azuretag-t1";
const SUB = "11111111-1111-1111-1111-111111111111";
const ARM_ID = `/subscriptions/${SUB}/resourceGroups/rg-test/providers/Microsoft.HybridCompute/machines/${HOST}`;
// Unique to this file so the registry assertions can't see another suite's rows.
const KEY = "PolarisTestDefenderPlan";
let integrationId = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

async function cleanup(): Promise<void> {
  await prisma.assetSource.deleteMany({ where: { externalId: ARM_ID.toLowerCase() } });
  await prisma.asset.deleteMany({ where: { hostname: { contains: HOST, mode: "insensitive" } } });
  await prisma.tag.deleteMany({ where: { name: { startsWith: `azure:${KEY}` } } });
  const intgs = await prisma.integration.findMany({ where: { name: "arc-azuretag-test" }, select: { id: true } });
  if (intgs.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: intgs.map((i) => i.id) } } });
    await prisma.integration.deleteMany({ where: { id: { in: intgs.map((i) => i.id) } } });
  }
}

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const intg = await prisma.integration.create({
    data: { type: "azurearc", name: "arc-azuretag-test", config: {}, enabled: true },
  });
  integrationId = intg.id;
});

function result(tags: Record<string, string>) {
  const m = normalizeArcMachine({
    id: ARM_ID,
    name: HOST,
    type: "Microsoft.HybridCompute/machines",
    location: "eastus",
    subscriptionId: SUB,
    resourceGroup: "rg-test",
    tags,
    properties: { status: "Connected", displayName: HOST, osType: "windows", osName: "Windows" },
  });
  return { machines: [m!], clusters: [], subscriptionsQueried: 1, usedFallback: false };
}

async function assetTags(): Promise<string[]> {
  const src = await prisma.assetSource.findFirst({ where: { externalId: ARM_ID.toLowerCase() }, select: { assetId: true } });
  const a = await prisma.asset.findUnique({ where: { id: src!.assetId }, select: { tags: true } });
  return a!.tags;
}

async function registryNames(): Promise<string[]> {
  const rows = await prisma.tag.findMany({ where: { name: { startsWith: `azure:${KEY}` } }, select: { name: true } });
  return rows.map((r) => r.name).sort();
}

const ON = { importAzureTags: true };

d("Arc sync — Azure resource tags as azure: asset tags", () => {
  it("adds the tag and mints its registry row when the toggle is on", async () => {
    await syncArcDevices(integrationId, "arc-azuretag-test", ON, result({ [KEY]: "P1" }) as any);
    await syncAzureTagRegistry();
    expect(await assetTags()).toContain(`azure:${KEY}=P1`);
    expect(await registryNames()).toEqual([`azure:${KEY}=P1`]);
  });

  it("replaces a changed value, keeps the operator's tags, and prunes the old registry row", async () => {
    await syncArcDevices(integrationId, "arc-azuretag-test", ON, result({ [KEY]: "P1" }) as any);
    const src = await prisma.assetSource.findFirst({ where: { externalId: ARM_ID.toLowerCase() }, select: { assetId: true } });
    const a = await prisma.asset.findUnique({ where: { id: src!.assetId }, select: { tags: true } });
    await prisma.asset.update({ where: { id: src!.assetId }, data: { tags: [...a!.tags, "operator-kept"] } });

    await syncArcDevices(integrationId, "arc-azuretag-test", ON, result({ [KEY]: "P2" }) as any);
    await syncAzureTagRegistry();

    const tags = await assetTags();
    expect(tags).toContain(`azure:${KEY}=P2`);
    expect(tags).not.toContain(`azure:${KEY}=P1`);
    expect(tags).toContain("operator-kept");
    expect(await registryNames()).toEqual([`azure:${KEY}=P2`]);
  });

  it("takes the mirrored tags back off when the toggle is turned off", async () => {
    await syncArcDevices(integrationId, "arc-azuretag-test", ON, result({ [KEY]: "P1" }) as any);
    await syncAzureTagRegistry();
    await syncArcDevices(integrationId, "arc-azuretag-test", {}, result({ [KEY]: "P1" }) as any);
    await syncAzureTagRegistry();
    expect((await assetTags()).some((t) => t.startsWith("azure:"))).toBe(false);
    expect(await registryNames()).toEqual([]);
  });
});

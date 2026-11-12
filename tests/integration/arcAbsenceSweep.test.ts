/**
 * tests/integration/arcAbsenceSweep.test.ts
 *
 * Business rule 70(a): the Azure Arc disappearance sweep. A machine whose
 * resource is gone from Azure loses its `arc` source row and — when this
 * integration manages the asset and the operator opted in — the asset is
 * decommissioned and its `azure:` tags removed. Everything that is NOT
 * evidence of deletion must leave the fleet alone: the toggle off, a scoped
 * or incomplete or empty read, a subscription that was not read, and a
 * machine that is merely filtered out or disconnected.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncArcDevices, sweepArcAbsence } from "../../src/services/discovery/discoveryEngine.js";
import {
  normalizeArcMachine,
  arcSweepBlockedReason,
  arcResourceWasRead,
  type ArcAbsenceEvidence,
} from "../../src/services/azureArcService.js";

const d = dbDescribe;
const NAME = "arc-absence-test";
const SUB_A = "aaaaaaaa-1111-1111-1111-111111111111";
const SUB_B = "bbbbbbbb-2222-2222-2222-222222222222";
const armId = (sub: string, host: string) =>
  `/subscriptions/${sub}/resourceGroups/rg-test/providers/Microsoft.HybridCompute/machines/${host}`.toLowerCase();
const HOSTS = { a1: "arc-absence-a1", a2: "arc-absence-a2", b1: "arc-absence-b1" };
const IDS = { a1: armId(SUB_A, HOSTS.a1), a2: armId(SUB_A, HOSTS.a2), b1: armId(SUB_B, HOSTS.b1) };
const ON = { decommissionMissing: true, importAzureTags: true };
let integrationId = "";

function machine(sub: string, host: string) {
  return normalizeArcMachine({
    id: armId(sub, host), name: host, type: "Microsoft.HybridCompute/machines", location: "eastus",
    subscriptionId: sub, resourceGroup: "rg-test", tags: { PolarisAbsenceTest: "yes" },
    properties: { status: "Connected", displayName: host, osType: "windows", osName: "Windows" },
  })!;
}

const evidence = (over: Partial<ArcAbsenceEvidence> = {}): ArcAbsenceEvidence => ({
  machineIds: [IDS.a1, IDS.a2, IDS.b1], clusterIds: null, subscriptionsRead: [SUB_A, SUB_B], complete: true, scoped: false, ...over,
});
const run = (absence: ArcAbsenceEvidence | undefined, config: Record<string, unknown> = ON) =>
  sweepArcAbsence(integrationId, NAME, config, { machines: [], clusters: [], subscriptionsQueried: 2, usedFallback: false, absence } as never);

async function cleanup(): Promise<void> {
  await prisma.assetSource.deleteMany({ where: { externalId: { in: Object.values(IDS) } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: "arc-absence-", mode: "insensitive" } } });
  await prisma.tag.deleteMany({ where: { name: { startsWith: "azure:PolarisAbsenceTest" } } });
  const intgs = await prisma.integration.findMany({ where: { name: { startsWith: NAME } }, select: { id: true } });
  if (intgs.length) {
    const ids = intgs.map((i) => i.id);
    await prisma.event.deleteMany({ where: { action: "asset.arc.decommissioned" } });
    await prisma.conflict.deleteMany({ where: { integrationId: { in: ids } } });
    await prisma.integration.deleteMany({ where: { id: { in: ids } } });
  }
}

async function state(host: string) {
  const asset = await prisma.asset.findFirstOrThrow({ where: { hostname: { equals: host, mode: "insensitive" } }, select: { id: true, status: true, tags: true } });
  const rows = await prisma.assetSource.count({ where: { assetId: asset.id, sourceKind: "arc" } });
  return { id: asset.id, status: asset.status, hasAzureTag: asset.tags.some((t) => t.startsWith("azure:")), arcRows: rows };
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});
afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});
beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  integrationId = (await prisma.integration.create({ data: { type: "azurearc", name: NAME, config: {}, enabled: true } })).id;
  await syncArcDevices(integrationId, NAME, ON, {
    machines: [machine(SUB_A, HOSTS.a1), machine(SUB_A, HOSTS.a2), machine(SUB_B, HOSTS.b1)],
    clusters: [], subscriptionsQueried: 2, usedFallback: false,
  } as never);
});

d("Azure Arc disappearance sweep (rule 70(a))", () => {
  it("decommissions a machine that is gone from a subscription that was read, and takes its azure: tags", async () => {
    expect(await state(HOSTS.a1)).toMatchObject({ status: "active", hasAzureTag: true, arcRows: 1 });

    const out = await run(evidence({ machineIds: [IDS.a2, IDS.b1] }));
    expect(out.map((n) => n.toLowerCase())).toEqual([HOSTS.a1]);

    expect(await state(HOSTS.a1)).toMatchObject({ status: "decommissioned", hasAzureTag: false, arcRows: 0 });
    expect(await state(HOSTS.a2)).toMatchObject({ status: "active", hasAzureTag: true, arcRows: 1 });
    expect(await state(HOSTS.b1)).toMatchObject({ status: "active", hasAzureTag: true, arcRows: 1 });
  });

  it("does nothing at all while the toggle is off", async () => {
    expect(await run(evidence({ machineIds: [IDS.a2, IDS.b1] }), { importAzureTags: true })).toEqual([]);
    expect(await state(HOSTS.a1)).toMatchObject({ status: "active", hasAzureTag: true, arcRows: 1 });
  });

  it("leaves alone a machine whose subscription was not read this run", async () => {
    // The app registration lost Reader on subscription B: a complete, non-empty
    // read that simply has none of B's machines in it.
    expect(await run(evidence({ machineIds: [IDS.a1, IDS.a2], subscriptionsRead: [SUB_A] }))).toEqual([]);
    expect(await state(HOSTS.b1)).toMatchObject({ status: "active", hasAzureTag: true, arcRows: 1 });
  });

  it("refuses a scoped, an incomplete, an empty and an unrecorded read", async () => {
    const gone = [IDS.a2, IDS.b1];
    expect(await run(evidence({ machineIds: gone, scoped: true }))).toEqual([]);
    expect(await run(evidence({ machineIds: gone, complete: false }))).toEqual([]);
    expect(await run(evidence({ machineIds: [] }))).toEqual([]);
    expect(await run(evidence({ machineIds: gone, subscriptionsRead: [] }))).toEqual([]);
    expect(await run(undefined)).toEqual([]);
    expect(await state(HOSTS.a1)).toMatchObject({ status: "active", hasAzureTag: true, arcRows: 1 });
  });

  it("an asset another integration manages only loses the stale row and the azure: tags", async () => {
    const other = await prisma.integration.create({ data: { type: "vcenter", name: `${NAME}-owner`, config: {}, enabled: true } });
    const a1 = await state(HOSTS.a1);
    await prisma.asset.update({ where: { id: a1.id }, data: { discoveredByIntegrationId: other.id } });

    expect(await run(evidence({ machineIds: [IDS.a2, IDS.b1] }))).toEqual([]);
    expect(await state(HOSTS.a1)).toMatchObject({ status: "active", hasAzureTag: false, arcRows: 0 });
  });

  it("is a no-op when every machine is still in Azure, filtered out or not", async () => {
    // machineIds is the RAW read: a machine dropped by a filter or by
    // includeDisconnected=false is still listed, so it is still alive.
    expect(await run(evidence())).toEqual([]);
    for (const h of Object.values(HOSTS)) expect(await state(h)).toMatchObject({ status: "active", arcRows: 1 });
  });
});

d("Azure Arc sweep guards, pure (rule 70(a))", () => {
  it("arcSweepBlockedReason names each refusal and passes a whole read", () => {
    expect(arcSweepBlockedReason({})).toMatch(/no record/);
    expect(arcSweepBlockedReason({ absence: evidence({ scoped: true }) })).toMatch(/single machine/);
    expect(arcSweepBlockedReason({ absence: evidence({ complete: false }) })).toMatch(/incomplete/);
    expect(arcSweepBlockedReason({ absence: evidence({ subscriptionsRead: [] }) })).toMatch(/no subscription/);
    expect(arcSweepBlockedReason({ absence: evidence({ machineIds: [] }) })).toMatch(/empty/);
    expect(arcSweepBlockedReason({ absence: evidence() })).toBeNull();
  });

  it("arcResourceWasRead judges by the resource's own subscription, case-insensitively", () => {
    expect(arcResourceWasRead(IDS.a1, [SUB_A])).toBe(true);
    expect(arcResourceWasRead(IDS.a1.toUpperCase(), [SUB_A])).toBe(true);
    expect(arcResourceWasRead(IDS.b1, [SUB_A])).toBe(false);
    expect(arcResourceWasRead("not-an-arm-id", [SUB_A])).toBe(false);
  });
});

/**
 * tests/integration/workloadSync.test.ts
 *
 * syncWorkloadDevices against a real Postgres (Unraid / TrueNAS SCALE). Pins:
 *   1. a first run creates host (hypervisor) + VM (server) + container
 *      (container), their source rows, and VM/container → host placement edges;
 *   2. a re-run is idempotent (no new assets, no duplicate rows / edges);
 *   3. a container that vanished is swept and decommissioned — a FILTERED-OUT
 *      one is not;
 *   4. an incomplete read (Docker unreadable) sweeps nothing;
 *   5. the shrink guard refuses a read that lost most of the fleet at once;
 *   6. a name collision with an unlinked asset becomes a pending Conflict,
 *      never a merge;
 *   7. a Polaris stop's monitoring-pause flag survives the sync.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncWorkloadDevices, type WorkloadDiscoveryResult } from "../../src/services/discovery/workloadSync.js";

const d = dbDescribe;
const NAME = "wl-sync-test";
const PREFIX = "wlsync-";
let integrationId = "";

async function cleanup(): Promise<void> {
  const intgs = await prisma.integration.findMany({ where: { name: NAME }, select: { id: true } });
  const ids = intgs.map((i) => i.id);
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: PREFIX } }, select: { id: true } });
  const assetIds = assets.map((a) => a.id);
  if (assetIds.length) {
    await prisma.assetDependencyParent.deleteMany({ where: { OR: [{ assetId: { in: assetIds } }, { parentAssetId: { in: assetIds } }] } });
    await prisma.assetSource.deleteMany({ where: { assetId: { in: assetIds } } });
    await prisma.conflict.deleteMany({ where: { OR: [{ assetId: { in: assetIds } }, { integrationId: { in: ids } }] } });
    await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  }
  if (ids.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: ids } } });
    await prisma.integration.deleteMany({ where: { id: { in: ids } } });
  }
}

beforeAll(async () => { if (dbReachable) await prisma.$connect(); });
afterAll(async () => { if (!dbReachable) return; await cleanup(); await prisma.$disconnect(); });
beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const intg = await prisma.integration.create({ data: { type: "unraid", name: NAME, config: {}, enabled: true } });
  integrationId = intg.id;
});

const ctr = (name: string, state = "running") => ({
  platformId: `srv:${name}`, name: `${PREFIX}${name}`, image: `img/${name}`, state: state as any, rawState: state.toUpperCase(),
  ip: null, updateAvailable: false, version: null, latestVersion: null, memberCount: 1, ports: [], autostart: true,
});

function result(over: Partial<WorkloadDiscoveryResult> = {}, containers = [ctr("plex"), ctr("sonarr")]): WorkloadDiscoveryResult {
  const vms = [{
    platformId: "srv:vm1", name: `${PREFIX}win11`, uuid: "6f1c2b9e-1111-2222-3333-444455556666", state: "running" as const,
    rawState: "RUNNING", cpuCount: null, memoryBytes: null, ip: null, macs: ["52:54:00:aa:bb:01"], autostart: true,
  }];
  return {
    platform: "unraid",
    host: {
      hostname: `${PREFIX}tower`, os: "Unraid", osVersion: "7.2.0", ip: "10.250.0.2", serial: null, manufacturer: null, model: null,
      cpuCount: 8, memTotalBytes: 32e9, uptimeSeconds: 100,
      pools: [{ name: "array", kind: "array", totalBytes: 1000, usedBytes: 400, health: "STARTED" }], disks: [],
    },
    vms,
    containers,
    inventoryComplete: true,
    presentVmNames: vms.map((v) => v.name),
    presentContainerNames: containers.map((c) => c.name),
    ...over,
  };
}

async function byName(suffix: string) {
  return prisma.asset.findFirst({ where: { hostname: `${PREFIX}${suffix}` }, select: { id: true, assetType: true, status: true, virtualization: true, monitored: true, dependencyLayer: true } });
}

d("syncWorkloadDevices", () => {
  it("creates host / VM / containers with source rows and placement edges, idempotently", async () => {
    const r1 = await syncWorkloadDevices(integrationId, NAME, {}, result());
    expect(r1.created.sort()).toEqual([`${PREFIX}plex`, `${PREFIX}sonarr`, `${PREFIX}tower`, `${PREFIX}win11`].sort());

    const host = await byName("tower");
    const vm = await byName("win11");
    const plex = await byName("plex");
    expect(host?.assetType).toBe("hypervisor");
    expect(host?.dependencyLayer).toBe(1);
    expect(vm?.assetType).toBe("server");
    expect(plex?.assetType).toBe("container");
    expect((plex?.virtualization as any)?.hostAssetId).toBe(host?.id);
    expect((host?.virtualization as any)?.pools).toHaveLength(1);

    const kinds = (await prisma.assetSource.findMany({ where: { integrationId }, select: { sourceKind: true, externalId: true } }))
      .map((s) => `${s.sourceKind}|${s.externalId}`).sort();
    expect(kinds).toEqual([
      `unraid-container|${integrationId}:ctr:${PREFIX}plex`,
      `unraid-container|${integrationId}:ctr:${PREFIX}sonarr`,
      `unraid-host|${integrationId}:host`,
      "unraid-vm|6f1c2b9e-1111-2222-3333-444455556666",
    ].sort());

    const edges = await prisma.assetDependencyParent.findMany({ where: { source: "unraid", parentAssetId: host!.id } });
    expect(edges).toHaveLength(3);

    const r2 = await syncWorkloadDevices(integrationId, NAME, {}, result());
    expect(r2.created).toEqual([]);
    expect(r2.updated).toHaveLength(4);
    expect(await prisma.assetSource.count({ where: { integrationId } })).toBe(4);
    expect(await prisma.assetDependencyParent.count({ where: { source: "unraid", parentAssetId: host!.id } })).toBe(3);
  });

  it("decommissions a vanished container but keeps a filtered-out one", async () => {
    await syncWorkloadDevices(integrationId, NAME, {}, result());
    // sonarr deleted on the host; plex still there but now excluded by filter.
    const r = await syncWorkloadDevices(integrationId, NAME, { containerExclude: [`${PREFIX}plex`] }, result({}, [ctr("plex")]));
    expect(r.decommissioned).toEqual([`${PREFIX}sonarr`]);
    expect((await byName("sonarr"))?.status).toBe("decommissioned");
    expect((await byName("plex"))?.status).toBe("active");
    expect(await prisma.assetSource.count({ where: { externalId: `${integrationId}:ctr:${PREFIX}plex` } })).toBe(1);
  });

  it("sweeps nothing when part of the inventory could not be read", async () => {
    await syncWorkloadDevices(integrationId, NAME, {}, result());
    const r = await syncWorkloadDevices(integrationId, NAME, {}, result({ inventoryComplete: false, presentContainerNames: [] }, []));
    expect(r.decommissioned).toEqual([]);
    expect((await byName("plex"))?.status).toBe("active");
    expect(await prisma.assetSource.count({ where: { integrationId, sourceKind: "unraid-container" } })).toBe(2);
  });

  it("refuses a read that lost more of the fleet than the guard allows", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ctr(`c${i}`));
    await syncWorkloadDevices(integrationId, NAME, {}, result({}, many));
    const r = await syncWorkloadDevices(integrationId, NAME, {}, result({}, many.slice(0, 2)));
    expect(r.decommissioned).toEqual([]);
    expect(await prisma.assetSource.count({ where: { integrationId, sourceKind: "unraid-container" } })).toBe(60);
  });

  it("raises a Conflict for a name an unlinked asset already has, and creates nothing for it", async () => {
    const manual = await prisma.asset.create({ data: { hostname: `${PREFIX}plex`, assetType: "other", status: "active" } });
    const r = await syncWorkloadDevices(integrationId, NAME, {}, result());
    expect(r.skipped.some((s) => s.startsWith(`${PREFIX}plex`))).toBe(true);
    const conflicts = await prisma.conflict.findMany({ where: { assetId: manual.id, status: "pending" } });
    expect(conflicts).toHaveLength(1);
    expect((conflicts[0].proposedAssetFields as any).sourceType).toBe("unraid");
    expect((conflicts[0].proposedAssetFields as any).workloadRole).toBe("container");
    expect(await prisma.asset.count({ where: { hostname: `${PREFIX}plex` } })).toBe(1);
  });

  it("carries a Polaris stop's monitoring-pause flag across the sync", async () => {
    await syncWorkloadDevices(integrationId, NAME, {}, result());
    const plex = await byName("plex");
    await prisma.asset.update({
      where: { id: plex!.id },
      data: { virtualization: { ...(plex!.virtualization as any), monitoringPausedByStop: true } },
    });
    await syncWorkloadDevices(integrationId, NAME, {}, result({}, [ctr("plex", "stopped"), ctr("sonarr")]));
    const after = await byName("plex");
    expect((after?.virtualization as any)?.monitoringPausedByStop).toBe(true);
    expect((after?.virtualization as any)?.state).toBe("stopped");
  });
});

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
 *   7. a Polaris stop's monitoring-pause flag survives the sync;
 *   8. several hosts per integration (a cluster): one host asset per node,
 *      each workload placed on its own node, a migration moves the edge and
 *      logs `asset.<platform>.moved`, an offline node keeps its asset without
 *      a lastSeen bump, and a node removed from the cluster is swept.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
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
    hosts: [{
      hostname: `${PREFIX}tower`, os: "Unraid", osVersion: "7.2.0", ip: "10.250.0.2", serial: null, manufacturer: null, model: null,
      cpuCount: 8, memTotalBytes: 32e9, uptimeSeconds: 100,
      pools: [{ name: "array", kind: "array", totalBytes: 1000, usedBytes: 400, health: "STARTED" }], disks: [],
    }],
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

// ─── Several hosts per integration (a Proxmox-style cluster) ─────────────────

function clusterResult(vmOn: string, nodes = ["n1", "n2"], over: Partial<WorkloadDiscoveryResult> = {}): WorkloadDiscoveryResult {
  const base = result();
  const vms = base.vms.map((v) => ({ ...v, hostKey: vmOn }));
  // Two LXCs with the SAME name on different nodes — told apart by identityKey.
  const containers = [
    { ...ctr("web"), platformId: "101", identityKey: "101", hostKey: "n1" },
    { ...ctr("web"), platformId: "201", identityKey: "201", hostKey: "n2" },
  ];
  return {
    ...base,
    hosts: nodes.map((k, i) => ({ ...base.hosts[0], key: k, online: true, hostname: `${PREFIX}${k}`, ip: `10.250.1.${i + 1}` })),
    vms,
    containers,
    presentVmNames: vms.map((v) => v.name),
    presentContainerNames: containers.map((c) => c.name),
    ...over,
  };
}

const edgeParent = async (assetId: string) =>
  (await prisma.assetDependencyParent.findMany({ where: { source: "unraid", assetId }, select: { parentAssetId: true } })).map((e) => e.parentAssetId);

d("syncWorkloadDevices — several hosts", () => {
  it("creates one host asset per node and places each workload on its own node", async () => {
    await syncWorkloadDevices(integrationId, NAME, {}, clusterResult("n1"));
    const n1 = await byName("n1");
    const n2 = await byName("n2");
    expect(n1?.assetType).toBe("hypervisor");
    expect(n2?.assetType).toBe("hypervisor");
    const hostIds = (await prisma.assetSource.findMany({ where: { integrationId, sourceKind: "unraid-host" }, select: { externalId: true } }))
      .map((s) => s.externalId).sort();
    expect(hostIds).toEqual([`${integrationId}:node:n1`, `${integrationId}:node:n2`]);

    const vm = await byName("win11");
    expect(await edgeParent(vm!.id)).toEqual([n1!.id]);
    expect((vm?.virtualization as any)?.hostName).toBe(`${PREFIX}n1`);

    const webs = await prisma.asset.findMany({ where: { hostname: `${PREFIX}web` }, select: { id: true } });
    expect(webs).toHaveLength(2);
    const parents = (await Promise.all(webs.map((w) => edgeParent(w.id)))).flat().sort();
    expect(parents).toEqual([n1!.id, n2!.id].sort());
    expect((n1?.virtualization as any)?.vmCount).toBe(1);
    expect((n2?.virtualization as any)?.vmCount).toBe(0);
  });

  it("moves the placement edge when a VM migrates, and records the move", async () => {
    await syncWorkloadDevices(integrationId, NAME, {}, clusterResult("n1"));
    await syncWorkloadDevices(integrationId, NAME, {}, clusterResult("n2"));
    const vm = await byName("win11");
    const n2 = await byName("n2");
    expect(await edgeParent(vm!.id)).toEqual([n2!.id]);
    expect(await prisma.asset.count({ where: { hostname: `${PREFIX}win11` } })).toBe(1);
    // The sync logs without awaiting (as every sync does) — wait for the row.
    await vi.waitFor(async () => {
      const moved = await prisma.event.findFirst({ where: { action: "asset.unraid.moved", resourceId: vm!.id } });
      expect(moved?.message).toMatch(/moved from .*n1 to .*n2/);
    });
  });

  it("keeps an offline node's asset but does not bump its lastSeen", async () => {
    await syncWorkloadDevices(integrationId, NAME, {}, clusterResult("n1"));
    const before = await prisma.asset.findFirst({ where: { hostname: `${PREFIX}n2` }, select: { lastSeen: true } });
    const offline = clusterResult("n1");
    offline.hosts[1] = { ...offline.hosts[1], online: false };
    await syncWorkloadDevices(integrationId, NAME, {}, offline);
    const after = await prisma.asset.findFirst({ where: { hostname: `${PREFIX}n2` }, select: { lastSeen: true, status: true, virtualization: true } });
    expect(after?.status).toBe("active");
    expect(after?.lastSeen?.getTime()).toBe(before?.lastSeen?.getTime());
    expect((after?.virtualization as any)?.online).toBe(false);
  });

  it("keeps an offline node's last pools instead of blanking them", async () => {
    await syncWorkloadDevices(integrationId, NAME, {}, clusterResult("n1"));
    const offline = clusterResult("n1");
    offline.hosts[1] = { ...offline.hosts[1], online: false, pools: [] };
    await syncWorkloadDevices(integrationId, NAME, {}, offline);
    const n2 = await byName("n2");
    expect((n2?.virtualization as any)?.pools?.map((p: any) => p.name)).toEqual(["array"]);
    // An ONLINE node that reports no pools really has none.
    const emptied = clusterResult("n1");
    emptied.hosts[1] = { ...emptied.hosts[1], pools: [] };
    await syncWorkloadDevices(integrationId, NAME, {}, emptied);
    expect(((await byName("n2"))?.virtualization as any)?.pools).toEqual([]);
  });

  it("sweeps a node removed from the cluster", async () => {
    await syncWorkloadDevices(integrationId, NAME, {}, clusterResult("n1", ["n1", "n2", "n3"]));
    await syncWorkloadDevices(integrationId, NAME, {}, clusterResult("n1", ["n1", "n2"]));
    expect((await byName("n3"))?.status).toBe("decommissioned");
    expect((await byName("n2"))?.status).toBe("active");
  });
});

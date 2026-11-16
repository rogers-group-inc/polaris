/**
 * tests/unit/integrationDetachService.test.ts
 *
 * Business rule 160 — what deleting an integration does to everything it
 * discovered: its source rows, sightings, finished discovery run and
 * placement edges go; Arc's azure: tags are stripped; pushed DHCP entries are
 * left on the device and written to ONE warning Event; and, when asked, the
 * assets nothing else reports are decommissioned — where a row with NO
 * integration (manual, agent) still counts as another reporter. The
 * integration-level suite (tests/integration/integrationDetach.test.ts) runs
 * it on a real database; this one pins the branches, the query shapes and
 * the follow-ups without one.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  syncAzureTagRegistry: vi.fn(),
  releaseAssetsForDecommission: vi.fn(),
  releaseInfraReservationsForAssets: vi.fn(),
  recomputeDependencyTree: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/tagAssignmentService.js", () => ({ syncAzureTagRegistry: h.syncAzureTagRegistry }));
vi.mock("../../src/services/maintenanceScheduleService.js", () => ({ releaseAssetsForDecommission: h.releaseAssetsForDecommission }));
vi.mock("../../src/services/reservationService.js", () => ({ releaseInfraReservationsForAssets: h.releaseInfraReservationsForAssets }));
vi.mock("../../src/services/dependencyTreeService.js", () => ({ recomputeDependencyTree: h.recomputeDependencyTree }));
vi.mock("../../src/utils/logger.js", () => ({ logger: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() } }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { ENRICHMENT_SOURCE_KINDS } from "../../src/utils/assetProjection.js";
import {
  previewIntegrationDetach,
  detachIntegration,
  detachSummary,
  type IntegrationDetachResult,
} from "../../src/services/integrationDetachService.js";

const src = {
  findMany: stubbed(prisma.assetSource.findMany),
  deleteMany: stubbed(prisma.assetSource.deleteMany),
};
const asset = {
  findMany: stubbed(prisma.asset.findMany),
  update: stubbed(prisma.asset.update),
  updateMany: stubbed(prisma.asset.updateMany),
};
const subnetCount = stubbed(prisma.subnet.count);
const resv = { count: stubbed(prisma.reservation.count), findMany: stubbed(prisma.reservation.findMany) };
const edges = stubbed(prisma.assetDependencyParent.deleteMany);
const sightings = stubbed(prisma.assetFortigateSighting.deleteMany);
const runs = stubbed(prisma.discoveryRun.deleteMany);

const INT = { id: "int-1", name: "Corp vCenter", type: "vcenter" };
const ARC = { id: "int-1", name: "Corp Arc", type: "azurearc" };

/**
 * A tiny fake for the two assetSource.findMany shapes: the integration's own
 * rows (`where.integrationId`) and the "someone else reports it" probe
 * (`where.assetId.in`). `others` lists the asset ids another reporter claims.
 */
function sources(own: string[], others: string[] = []) {
  src.findMany.mockImplementation(async ({ where }: any) => {
    if (where.assetId?.in) return (where.assetId.in as string[]).filter((id) => others.includes(id)).map((assetId) => ({ assetId }));
    return own.map((assetId) => ({ assetId }));
  });
}

type FakeAsset = { id: string; hostname?: string | null; ipAddress?: string | null; assetType?: string; monitored?: boolean; tags?: string[] };
/** asset.findMany: the sole-source read (has `status`) and the azure-tag read (has `tags`). */
function assets(rows: FakeAsset[]) {
  asset.findMany.mockImplementation(async ({ where }: any) => {
    const inChunk = rows.filter((r) => (where.id.in as string[]).includes(r.id));
    if (where.tags) return inChunk.filter((r) => (r.tags ?? []).length > 0).map((r) => ({ id: r.id, tags: r.tags ?? [] }));
    return inChunk.map((r) => ({ id: r.id, hostname: r.hostname ?? null, ipAddress: r.ipAddress ?? null, assetType: r.assetType ?? "server", monitored: r.monitored ?? false }));
  });
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  vi.clearAllMocks();
  h.syncAzureTagRegistry.mockReset().mockResolvedValue(undefined);
  h.releaseAssetsForDecommission.mockReset().mockResolvedValue(undefined);
  h.releaseInfraReservationsForAssets.mockReset().mockResolvedValue(undefined);
  h.recomputeDependencyTree.mockReset().mockResolvedValue(undefined);
  sources([]);
  assets([]);
  subnetCount.mockResolvedValue(0);
  resv.count.mockResolvedValue(0);
  resv.findMany.mockResolvedValue([]);
  src.deleteMany.mockResolvedValue({ count: 0 });
  sightings.mockResolvedValue({ count: 0 });
  runs.mockResolvedValue({ count: 0 });
  edges.mockResolvedValue({ count: 0 });
  asset.updateMany.mockImplementation(async ({ where }: any) => ({ count: where.id.in.length }));
});

// ─── Preview ──────────────────────────────────────────────────────────────

describe("previewIntegrationDetach", () => {
  it("counts sourced, sole-source (and monitored), networks and pushed reservations", async () => {
    sources(["a1", "a2", "a3"], ["a2"]);
    assets([{ id: "a1", monitored: true }, { id: "a2" }, { id: "a3", monitored: false }]);
    subnetCount.mockResolvedValue(4);
    resv.count.mockResolvedValue(6);
    expect(await previewIntegrationDetach(INT)).toEqual({
      sourcedAssets: 3, soleSourceAssets: 2, soleSourceMonitored: 1, networks: 4, pushedReservations: 6, azureTaggedAssets: 0,
    });
    expect(subnetCount).toHaveBeenCalledWith({ where: { discoveredBy: "int-1" } });
    expect(resv.count).toHaveBeenCalledWith({ where: { pushedToId: "int-1" } });
  });

  it("reads distinct assets from this integration's own source rows", async () => {
    await previewIntegrationDetach(INT);
    expect(src.findMany.mock.calls[0][0]).toEqual({ where: { integrationId: "int-1" }, select: { assetId: true }, distinct: ["assetId"] });
  });

  it("counts a row with NO integration (manual, agent) as another reporter — never NOT: { integrationId }", async () => {
    sources(["a1"]);
    assets([{ id: "a1" }]);
    await previewIntegrationDetach(INT);
    const probe = src.findMany.mock.calls.find((c: any[]) => c[0].where.assetId)![0].where;
    expect(probe.OR).toEqual([{ integrationId: null }, { integrationId: { not: "int-1" } }]);
    expect(probe.NOT).toBeUndefined();
    expect(probe.sourceKind).toEqual({ notIn: [...ENRICHMENT_SOURCE_KINDS] });
  });

  it("only offers assets owned by this integration or by nothing, and not already decommissioned (rule 70)", async () => {
    sources(["a1"]);
    assets([{ id: "a1" }]);
    await previewIntegrationDetach(INT);
    const where = asset.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ not: "decommissioned" });
    expect(where.OR).toEqual([{ discoveredByIntegrationId: "int-1" }, { discoveredByIntegrationId: null }]);
  });

  it("skips the asset read when every sourced asset has another reporter", async () => {
    sources(["a1", "a2"], ["a1", "a2"]);
    const out = await previewIntegrationDetach(INT);
    expect(out.soleSourceAssets).toBe(0);
    expect(asset.findMany).not.toHaveBeenCalled();
  });

  it("chunks the sole-source probe by 500 asset ids", async () => {
    const ids = Array.from({ length: 1201 }, (_, i) => `a${i}`);
    sources(ids, ids);
    await previewIntegrationDetach(INT);
    const probes = src.findMany.mock.calls.filter((c: any[]) => c[0].where.assetId);
    expect(probes.map((c: any[]) => c[0].where.assetId.in.length)).toEqual([500, 500, 201]);
  });

  it("counts azure:-tagged assets only for an Azure Arc integration", async () => {
    sources(["a1", "a2", "a3"], ["a1", "a2", "a3"]);
    assets([{ id: "a1", tags: ["Azure:env=prod", "site"] }, { id: "a2", tags: ["site"] }, { id: "a3", tags: [] }]);
    expect((await previewIntegrationDetach(ARC)).azureTaggedAssets).toBe(1);
    expect((await previewIntegrationDetach(INT)).azureTaggedAssets).toBe(0);
  });

  it("is all zeros for an integration that discovered nothing", async () => {
    expect(await previewIntegrationDetach(INT)).toEqual({
      sourcedAssets: 0, soleSourceAssets: 0, soleSourceMonitored: 0, networks: 0, pushedReservations: 0, azureTaggedAssets: 0,
    });
  });
});

// ─── Detach ───────────────────────────────────────────────────────────────

describe("detachIntegration — own rows", () => {
  it("deletes its source rows, sightings and FINISHED discovery runs in one transaction", async () => {
    sources(["a1", "a2"]);
    src.deleteMany.mockResolvedValue({ count: 5 });
    sightings.mockResolvedValue({ count: 2 });
    subnetCount.mockResolvedValue(3);
    const out = await detachIntegration(INT, { decommission: false, actor: "alice" });
    expect(src.deleteMany).toHaveBeenCalledWith({ where: { integrationId: "int-1" } });
    expect(sightings).toHaveBeenCalledWith({ where: { integrationId: "int-1" } });
    expect(runs).toHaveBeenCalledWith({ where: { integrationId: "int-1", status: { in: ["completed", "aborted", "error"] } } });
    expect(out).toMatchObject({ sourceRows: 5, sightings: 2, detachedAssets: 2, networks: 3, decommissioned: 0, dhcpEntriesLeft: 0 });
  });

  it("never decommissions without the tick-box, and never reads the sole-source set", async () => {
    sources(["a1"]);
    assets([{ id: "a1" }]);
    await detachIntegration(INT, { decommission: false });
    expect(src.findMany.mock.calls.some((c: any[]) => c[0].where.assetId)).toBe(false);
    expect(asset.updateMany).not.toHaveBeenCalled();
    expect(h.releaseAssetsForDecommission).not.toHaveBeenCalled();
  });

  it("throws when a step fails — the caller has not deleted the integration yet", async () => {
    sources(["a1"]);
    src.deleteMany.mockRejectedValue(new Error("db down"));
    await expect(detachIntegration(INT, { decommission: false })).rejects.toThrow("db down");
  });
});

describe("detachIntegration — placement edges", () => {
  it.each(["vcenter", "unraid", "truenas", "proxmox"])("%s: deletes the edges its sync wrote, either end", async (type) => {
    sources(["a1"]);
    edges.mockResolvedValue({ count: 2 });
    const out = await detachIntegration({ ...INT, type }, { decommission: false });
    expect(edges).toHaveBeenCalledWith({ where: { source: type, OR: [{ assetId: { in: ["a1"] } }, { parentAssetId: { in: ["a1"] } }] } });
    expect(out.placementEdges).toBe(2);
  });

  it("other integration types touch no placement edge", async () => {
    sources(["a1"]);
    for (const type of ["fortimanager", "entraid", "azurearc", "activedirectory"]) {
      await detachIntegration({ ...INT, type }, { decommission: false });
    }
    expect(edges).not.toHaveBeenCalled();
  });

  it("sums the edges across 500-id chunks", async () => {
    sources(Array.from({ length: 1001 }, (_, i) => `a${i}`));
    edges.mockResolvedValue({ count: 1 });
    expect((await detachIntegration(INT, { decommission: false })).placementEdges).toBe(3);
  });

  it("recomputes the dependency tree only when an edge or asset left", async () => {
    sources(["a1"]);
    await detachIntegration(INT, { decommission: false });
    expect(h.recomputeDependencyTree).not.toHaveBeenCalled();
    edges.mockResolvedValue({ count: 1 });
    await detachIntegration(INT, { decommission: false });
    expect(h.recomputeDependencyTree).toHaveBeenCalledTimes(1);
  });

  it("a failed recompute is logged, not thrown — the detach is already complete", async () => {
    sources(["a1"]);
    edges.mockResolvedValue({ count: 1 });
    h.recomputeDependencyTree.mockRejectedValue(new Error("boom"));
    await expect(detachIntegration(INT, { decommission: false })).resolves.toMatchObject({ placementEdges: 1 });
    await new Promise((r) => setImmediate(r));
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringMatching(/dependency tree/));
  });
});

describe("detachIntegration — azure: tags", () => {
  it("strips azure: tags (any case) from an Arc integration's assets and keeps the rest", async () => {
    sources(["a1", "a2"]);
    assets([{ id: "a1", tags: ["azure:env=prod", "AZURE:owner=x", "site:nash"] }, { id: "a2", tags: ["site:nash"] }]);
    const out = await detachIntegration(ARC, { decommission: false });
    expect(asset.update).toHaveBeenCalledTimes(1);
    expect(asset.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { tags: ["site:nash"] } });
    expect(out.azureTagsStripped).toBe(1);
    expect(h.syncAzureTagRegistry).toHaveBeenCalledTimes(1);
  });

  it("writes in transactions of 100", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `a${i}`);
    sources(ids);
    assets(ids.map((id) => ({ id, tags: ["azure:x=y"] })));
    await detachIntegration(ARC, { decommission: false });
    const batches = vi.mocked(prisma.$transaction).mock.calls.filter((c: any[]) => Array.isArray(c[0]) && c[0].length !== 3);
    expect(batches.map((c: any[]) => c[0].length)).toEqual([100, 100, 50]);
  });

  it("does nothing to tags for a non-Arc integration, nor syncs the registry", async () => {
    sources(["a1"]);
    assets([{ id: "a1", tags: ["azure:env=prod"] }]);
    const out = await detachIntegration(INT, { decommission: false });
    expect(asset.update).not.toHaveBeenCalled();
    expect(out.azureTagsStripped).toBe(0);
    expect(h.syncAzureTagRegistry).not.toHaveBeenCalled();
  });

  it("a failed registry sync is logged, not thrown", async () => {
    sources(["a1"]);
    assets([{ id: "a1", tags: ["azure:x=y"] }]);
    h.syncAzureTagRegistry.mockRejectedValue(new Error("boom"));
    await expect(detachIntegration(ARC, { decommission: false })).resolves.toMatchObject({ azureTagsStripped: 1 });
    await new Promise((r) => setImmediate(r));
    expect(h.warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/azure tag registry/));
  });
});

describe("detachIntegration — pushed DHCP entries", () => {
  const entry = (i: number) => ({
    id: `r${i}`, ipAddress: `10.0.0.${i}`, macAddress: `aa:bb:cc:00:00:${String(i).padStart(2, "0")}`, hostname: `h${i}`,
    pushStatus: "synced", pushedScopeId: 3, pushedEntryId: i, subnet: { cidr: "10.0.0.0/24", name: "Users", fortigateDevice: "FGT-1" },
  });

  it("writes nothing when nothing was pushed", async () => {
    await detachIntegration(INT, { decommission: false });
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("writes ONE warning Event listing every entry left on the device (singular wording)", async () => {
    resv.findMany.mockResolvedValue([entry(5)]);
    const out = await detachIntegration(INT, { decommission: false, actor: "alice" });
    expect(out.dhcpEntriesLeft).toBe(1);
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({
      action: "integration.dhcp_entries_left", resourceType: "integration", resourceId: "int-1", actor: "alice", level: "warning",
      details: {
        count: 1, listed: 1,
        entries: [{ ip: "10.0.0.5", mac: "aa:bb:cc:00:00:05", hostname: "h5", network: "10.0.0.0/24", networkName: "Users", device: "FGT-1", scopeId: 3, entryId: 5, pushStatus: "synced" }],
      },
    });
    expect(ev.message).toMatch(/^1 DHCP reservation pushed through "Corp vCenter" was left on the device/);
    expect(ev.message).toMatch(/remove it;/);
    expect(resv.findMany.mock.calls[0][0].where).toEqual({ pushedToId: "int-1" });
  });

  it("uses plural wording and nulls for an entry with no network", async () => {
    resv.findMany.mockResolvedValue([entry(1), { ...entry(2), subnet: null }]);
    await detachIntegration(INT, { decommission: false });
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev.message).toMatch(/^2 DHCP reservations pushed through "Corp vCenter" were left/);
    expect(ev.message).toMatch(/remove them;/);
    expect(ev).toMatchObject({ details: { entries: [{}, { network: null, networkName: null, device: null }] } });
  });

  it("caps the listed entries at 500 while the count stays true", async () => {
    resv.findMany.mockResolvedValue(Array.from({ length: 612 }, (_, i) => entry(i)));
    const out = await detachIntegration(INT, { decommission: false });
    const ev = eventLog.logEvent.mock.calls[0][0];
    const details = ev.details as { count: number; listed: number; entries: unknown[] };
    expect(details.count).toBe(612);
    expect(details.listed).toBe(500);
    expect(details.entries).toHaveLength(500);
    expect(ev.message).toMatch(/^612 /);
    expect(out.dhcpEntriesLeft).toBe(612);
  });
});

describe("detachIntegration — decommission (B-D1)", () => {
  it("decommissions only the assets nothing else reports, reading them BEFORE the source rows go", async () => {
    sources(["a1", "a2"], ["a2"]);
    assets([{ id: "a1", hostname: "vm-01" }, { id: "a2", hostname: "vm-02" }]);
    const out = await detachIntegration(INT, { decommission: true, actor: "alice" });
    expect(out.decommissioned).toBe(1);
    const probeOrder = src.findMany.mock.invocationCallOrder[1];
    expect(probeOrder).toBeLessThan(src.deleteMany.mock.invocationCallOrder[0]);
    expect(asset.updateMany).toHaveBeenCalledTimes(1);
    const upd = asset.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: { in: ["a1"] }, status: { not: "decommissioned" } });
    expect(upd.data).toMatchObject({ status: "decommissioned", statusChangedBy: "alice" });
    expect(upd.data.statusChangedAt).toBeInstanceOf(Date);
  });

  it("releases maintenance holds for every retired asset, and infra reservations only for switches / APs", async () => {
    sources(["sw", "ap", "srv"]);
    assets([{ id: "sw", assetType: "switch" }, { id: "ap", assetType: "access_point" }, { id: "srv", assetType: "server" }]);
    await detachIntegration(INT, { decommission: true, actor: "alice" });
    expect(h.releaseInfraReservationsForAssets).toHaveBeenCalledWith(["sw", "ap"], { reason: "asset decommissioned", actor: "alice" });
    const [ids, opts] = h.releaseAssetsForDecommission.mock.calls[0];
    expect(ids).toEqual(["sw", "ap", "srv"]);
    expect(opts).toMatchObject({ actor: "alice", statusChangedBy: "alice", reason: 'its only source, the integration "Corp vCenter", was deleted' });
    expect(h.releaseAssetsForDecommission.mock.invocationCallOrder[0]).toBeLessThan(asset.updateMany.mock.invocationCallOrder[0]);
  });

  it("skips the infra release when no switch or AP is retired", async () => {
    sources(["srv"]);
    assets([{ id: "srv" }]);
    await detachIntegration(INT, { decommission: true });
    expect(h.releaseInfraReservationsForAssets).not.toHaveBeenCalled();
  });

  it("stamps the integration's name as the changer when no actor is given", async () => {
    sources(["a1"]);
    assets([{ id: "a1" }]);
    await detachIntegration(INT, { decommission: true });
    expect(asset.updateMany.mock.calls[0][0].data.statusChangedBy).toBe("Corp vCenter");
    expect(h.releaseAssetsForDecommission.mock.calls[0][1].statusChangedBy).toBe("Corp vCenter");
  });

  it("writes one Event per retired asset in ONE batch, labelled hostname → IP → id", async () => {
    // Was a bug until 2026-11-16: one logEvent per asset via Promise.all (2,000 concurrent inserts).
    sources(["a1", "a2", "a3"]);
    assets([{ id: "a1", hostname: "vm-01" }, { id: "a2", ipAddress: "2001:db8::5" }, { id: "a3" }]);
    await detachIntegration(INT, { decommission: true, actor: "alice" });
    expect(eventLog.logEvent.mock.calls.map((c) => c[0]).filter((e) => e.action === "asset.integration_deleted.decommissioned")).toEqual([]);
    expect(eventLog.logEventsBatch).toHaveBeenCalledTimes(1);
    const evs = (eventLog.logEventsBatch.mock.calls[0][0] as Array<Record<string, any>>);
    expect(evs.map((e) => e.resourceName)).toEqual(["vm-01", "2001:db8::5", "a3"]);
    expect(evs[0]).toMatchObject({
      resourceType: "asset", resourceId: "a1", actor: "alice",
      details: { reason: "integration-deleted", integrationId: "int-1", integrationName: "Corp vCenter" },
    });
    expect(evs[0].message).toMatch(/no other discovery source reports it/);
  });

  it("counts what the update really changed and recomputes the tree", async () => {
    sources(["a1", "a2"]);
    assets([{ id: "a1" }, { id: "a2" }]);
    asset.updateMany.mockResolvedValue({ count: 1 });
    const out = await detachIntegration(INT, { decommission: true });
    expect(out.decommissioned).toBe(1);
    expect(h.recomputeDependencyTree).toHaveBeenCalledTimes(1);
  });

  it("does nothing when every sourced asset has another reporter", async () => {
    sources(["a1"], ["a1"]);
    assets([{ id: "a1" }]);
    const out = await detachIntegration({ ...INT, type: "fortimanager" }, { decommission: true });
    expect(out.decommissioned).toBe(0);
    expect(asset.updateMany).not.toHaveBeenCalled();
    expect(h.releaseAssetsForDecommission).not.toHaveBeenCalled();
    expect(h.recomputeDependencyTree).not.toHaveBeenCalled();
  });

  it("chunks the decommission update by 500 ids", async () => {
    const ids = Array.from({ length: 1100 }, (_, i) => `a${i}`);
    sources(ids);
    assets(ids.map((id) => ({ id })));
    const out = await detachIntegration({ ...INT, type: "entraid" }, { decommission: true });
    expect(asset.updateMany.mock.calls.map((c: any[]) => c[0].where.id.in.length)).toEqual([500, 500, 100]);
    expect(out.decommissioned).toBe(1100);
  });
});

// ─── detachSummary ────────────────────────────────────────────────────────

describe("detachSummary", () => {
  const zero: IntegrationDetachResult = {
    sourceRows: 0, detachedAssets: 0, decommissioned: 0, azureTagsStripped: 0, sightings: 0, placementEdges: 0, networks: 0, dhcpEntriesLeft: 0,
  };

  it("is empty when nothing happened", () => {
    expect(detachSummary(zero)).toBe("");
  });

  it("uses singulars for one of each", () => {
    expect(detachSummary({ ...zero, detachedAssets: 1, decommissioned: 1, networks: 1, azureTagsStripped: 1, placementEdges: 1, dhcpEntriesLeft: 1 }))
      .toBe("1 asset detached (1 decommissioned); 1 network kept as manual; azure: tags removed from 1 asset; 1 placement link removed; 1 DHCP entry left on the device");
  });

  it("uses plurals and omits the decommission clause when none were", () => {
    expect(detachSummary({ ...zero, detachedAssets: 412, networks: 3, azureTagsStripped: 2, placementEdges: 9, dhcpEntriesLeft: 6 }))
      .toBe("412 assets detached; 3 networks kept as manual; azure: tags removed from 2 assets; 9 placement links removed; 6 DHCP entries left on the device");
  });

  it("does not count source rows or sightings in the text", () => {
    expect(detachSummary({ ...zero, sourceRows: 50, sightings: 7 })).toBe("");
  });
});

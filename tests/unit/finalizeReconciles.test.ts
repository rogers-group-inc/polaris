/**
 * tests/unit/finalizeReconciles.test.ts — the own suite for
 * src/services/discovery/dhcp/finalizeReconciles.ts (syncDhcpSubnets Phases
 * 12–13.7, CQ-T010).
 *
 * Pins the order and the sub-phase timer marks, each reconcile's summary line
 * (and its silence when nothing changed), failure isolation between them, the
 * Fortinet-only gate on 13.6 / 13.7, the management-access write (serial →
 * asset through the integration's own AssetSource rows, first summary per
 * serial, one write per asset, unchanged summaries skipped, 200-update
 * transactions), and the description-sync scope (rule 142: a scoped run names
 * its gate, a full run passes no filter).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const m = vi.hoisted(() => ({
  recompute: vi.fn(),
  regions: vi.fn(),
  tags: vi.fn(),
  descSync: vi.fn(),
  descEnabled: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/dependencyTreeService.js", () => ({ recomputeDependencyTree: m.recompute }));
vi.mock("../../src/services/mapRegionService.js", () => ({ reconcileMapRegions: m.regions }));
vi.mock("../../src/services/tagAssignmentService.js", () => ({ reconcileAllTags: m.tags }));
vi.mock("../../src/services/descriptionSyncService.js", () => ({ runDescriptionSyncForIntegration: m.descSync }));
vi.mock("../../src/utils/descriptionSyncFlags.js", () => ({ anyDescriptionSyncEnabled: m.descEnabled }));

const { runFinalizeReconciles } = await import("../../src/services/discovery/dhcp/finalizeReconciles.js");

const db = {
  sourceFindMany: stubbed(prisma.assetSource.findMany),
  assetFindMany: stubbed(prisma.asset.findMany),
  assetUpdate: stubbed(prisma.asset.update),
  integrationFindUnique: stubbed(prisma.integration.findUnique),
  transaction: stubbed(prisma.$transaction),
};

const ZERO_DESC = { pushed: 0, adopted: 0, failed: 0, skippedDevices: 0, fmgMirrored: 0, fmgMirrorFailed: 0 };

beforeEach(() => {
  resetDbStub();
  for (const f of Object.values(m)) f.mockReset();
  m.recompute.mockResolvedValue({ scoped: 0, edgesWritten: 0, unresolved: 0, endpointEdges: 0 });
  m.regions.mockResolvedValue({ assetsTouched: 0, subnetsTouched: 0, added: 0, removed: 0, subnetsAdded: 0, subnetsRemoved: 0 });
  m.tags.mockResolvedValue({ added: 0, removed: 0 });
  m.descEnabled.mockReturnValue(false);
  m.descSync.mockResolvedValue(ZERO_DESC);
  db.integrationFindUnique.mockResolvedValue({ id: "i1", type: "fortimanager", config: { syncFortigateDescriptions: true }, name: "HQ FMG" });
  db.sourceFindMany.mockResolvedValue([]);
  db.assetFindMany.mockResolvedValue([]);
  db.assetUpdate.mockImplementation((args: unknown) => args);
  db.transaction.mockResolvedValue([]);
});

function input(over: Record<string, unknown> = {}) {
  return {
    integrationId: "i1", integrationType: "fortimanager", mode: "finalize" as string,
    result: { devices: [{ name: "FGT-A", hostname: "fgt-a" }], managementAccess: [] } as any,
    phaseMark: vi.fn(), syncLog: vi.fn(),
    ...over,
  };
}
const go = (i: ReturnType<typeof input>) => runFinalizeReconciles(i as never);

describe("runFinalizeReconciles — Phases 12, 13, 13.65", () => {
  it("runs every reconcile in order with the sub-phase marks between them, and is silent when nothing changed", async () => {
    const order: string[] = [];
    m.recompute.mockImplementation(async () => { order.push("12"); return { scoped: 0 }; });
    m.regions.mockImplementation(async () => { order.push("13"); return { assetsTouched: 0, subnetsTouched: 0 }; });
    m.tags.mockImplementation(async () => { order.push("13.65"); return { added: 0, removed: 0 }; });
    const run = input();
    run.phaseMark.mockImplementation((n: string) => order.push(`mark:${n}`));
    await go(run);
    expect(order).toEqual(["12", "mark:13", "13", "mark:13.65", "13.65", "mark:13.6", "mark:13.7"]);
    expect(m.recompute).toHaveBeenCalledWith("i1");
    expect(run.syncLog).not.toHaveBeenCalled();
  });

  it("summarizes the dependency tree, with the unresolved and endpoint parts only when non-zero", async () => {
    m.recompute.mockResolvedValueOnce({ scoped: 4, edgesWritten: 7, unresolved: 2, endpointEdges: 3 });
    const a = input();
    await go(a);
    expect(a.syncLog).toHaveBeenCalledWith("info", "Dependency tree: 7 edge(s) across 4 asset(s), 2 unresolved; 3 endpoint edge(s)");
    m.recompute.mockResolvedValueOnce({ scoped: 1, edgesWritten: 1, unresolved: 0, endpointEdges: 0 });
    const b = input();
    await go(b);
    expect(b.syncLog).toHaveBeenCalledWith("info", "Dependency tree: 1 edge(s) across 1 asset(s)");
  });

  it("summarizes region and criteria tags when something moved", async () => {
    m.regions.mockResolvedValue({ assetsTouched: 3, subnetsTouched: 0, added: 2, removed: 1, subnetsAdded: 0, subnetsRemoved: 0 });
    m.tags.mockResolvedValue({ added: 0, removed: 5 });
    const run = input();
    await go(run);
    expect(run.syncLog).toHaveBeenCalledWith("info", "Map region tags: +2/-1 on 3 asset(s), +0/-0 on 0 network(s)");
    expect(run.syncLog).toHaveBeenCalledWith("info", "Criteria tags: +0 / -5");
  });

  it("each failure is logged and the rest still run", async () => {
    m.recompute.mockRejectedValue(new Error("dag"));
    m.regions.mockRejectedValue(new Error("geo"));
    m.tags.mockRejectedValue({});
    m.descEnabled.mockReturnValue(true);
    const run = input();
    await expect(go(run)).resolves.toBeUndefined();
    expect(run.syncLog.mock.calls).toEqual([
      ["error", "Dependency tree recompute failed: dag"],
      ["error", "Map region reconcile failed: geo"],
      ["error", "Tag-assignment reconcile failed: Unknown error"],
    ]);
    expect(m.descSync).toHaveBeenCalled();
  });
});

describe("runFinalizeReconciles — Phase 13.6 management access", () => {
  const ma = (...pairs: Array<[string | null, Record<string, unknown>]>) =>
    ({ devices: [], managementAccess: pairs.map(([serial, summary]) => ({ serial, summary })) });

  it("is skipped for a non-Fortinet integration and for an empty list", async () => {
    await go(input({ integrationType: "vcenter", result: ma(["X", {}]) }));
    await go(input({ result: { devices: [] } }));
    expect(db.sourceFindMany).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("maps each serial to its asset through this integration's own source rows; the first summary per serial wins", async () => {
    db.sourceFindMany.mockResolvedValue([{ assetId: "a1", externalId: "FGT1" }, { assetId: "a2", externalId: "SW1" }]);
    const run = input({ integrationType: "fortigate", result: ma(["FGT1", { https: true }], [null, { ssh: true }], ["SW1", { ssh: true }], ["FGT1", { https: false }]) });
    await go(run);
    expect(db.sourceFindMany).toHaveBeenCalledWith({
      where: { integrationId: "i1", sourceKind: { in: ["fortigate-firewall", "fortiswitch", "fortiap"] }, externalId: { in: ["FGT1", "SW1"] } },
      select: { assetId: true, externalId: true },
    });
    expect(db.assetFindMany).toHaveBeenCalledWith({ where: { id: { in: ["a1", "a2"] } }, select: { id: true, managementAccess: true } });
    expect(db.transaction).toHaveBeenCalledWith([
      { where: { id: "a1" }, data: { managementAccess: { https: true } } },
      { where: { id: "a2" }, data: { managementAccess: { ssh: true } } },
    ]);
    expect(run.syncLog).toHaveBeenCalledWith("info", "Management-access: recorded allowaccess for 2 device(s)");
  });

  it("writes one asset once even when two of its serials report (an HA pair on one row)", async () => {
    db.sourceFindMany.mockResolvedValue([{ assetId: "a1", externalId: "FGT1" }, { assetId: "a1", externalId: "FGT2" }]);
    await go(input({ result: ma(["FGT1", { https: true }], ["FGT2", { https: false }]) }));
    expect(db.transaction).toHaveBeenCalledWith([{ where: { id: "a1" }, data: { managementAccess: { https: true } } }]);
  });

  it("skips summaries equal to the stored one (key order aside), and logs nothing when all are unchanged", async () => {
    db.sourceFindMany.mockResolvedValue([{ assetId: "a1", externalId: "FGT1" }]);
    db.assetFindMany.mockResolvedValue([{ id: "a1", managementAccess: { ssh: false, https: true } }]);
    const run = input({ result: ma(["FGT1", { https: true, ssh: false }]) });
    await go(run);
    expect(db.assetUpdate).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(run.syncLog).not.toHaveBeenCalled();
  });

  it("a serial with no source row writes nothing", async () => {
    const run = input({ result: ma(["UNKNOWN", { https: true }]) });
    await go(run);
    expect(db.assetFindMany).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("batches the writes 200 to a transaction", async () => {
    const n = 201;
    const pairs: Array<[string, Record<string, unknown>]> = Array.from({ length: n }, (_, i) => [`S${i}`, { https: true }]);
    db.sourceFindMany.mockResolvedValue(pairs.map(([s], i) => ({ assetId: `a${i}`, externalId: s })));
    const run = input({ result: ma(...pairs) });
    await go(run);
    expect(db.transaction.mock.calls.map((c) => (c[0] as unknown[]).length)).toEqual([200, 1]);
    expect(run.syncLog).toHaveBeenCalledWith("info", "Management-access: recorded allowaccess for 201 device(s)");
  });

  it("a failed write is logged and Phase 13.7 still runs", async () => {
    db.sourceFindMany.mockRejectedValue(new Error("pool"));
    m.descEnabled.mockReturnValue(true);
    const run = input({ result: ma(["FGT1", {}]) });
    await go(run);
    expect(run.syncLog).toHaveBeenCalledWith("error", "Management-access write failed: pool");
    expect(m.descSync).toHaveBeenCalled();
  });
});

describe("runFinalizeReconciles — Phase 13.7 description sync", () => {
  it("is skipped for a non-Fortinet integration, a missing integration row, or every class off", async () => {
    await go(input({ integrationType: "proxmox" }));
    expect(db.integrationFindUnique).not.toHaveBeenCalled();
    db.integrationFindUnique.mockResolvedValueOnce(null);
    m.descEnabled.mockReturnValue(true);
    await go(input());
    m.descEnabled.mockReturnValue(false);
    await go(input());
    expect(m.descSync).not.toHaveBeenCalled();
    expect(db.integrationFindUnique).toHaveBeenCalledWith({ where: { id: "i1" }, select: { id: true, type: true, config: true, name: true } });
  });

  it("a full run reconciles the whole integration; a scoped run only its gate's names (rule 142)", async () => {
    m.descEnabled.mockReturnValue(true);
    await go(input());
    expect(m.descSync).toHaveBeenLastCalledWith(expect.objectContaining({ id: "i1" }), undefined);
    await go(input({ mode: "finalize-scoped", result: { devices: [{ name: "FGT-A", hostname: "fgt-a" }, { name: "", hostname: null }], managementAccess: [] } }));
    expect(m.descSync).toHaveBeenLastCalledWith(expect.objectContaining({ id: "i1" }), ["FGT-A", "fgt-a"]);
  });

  it("reports what it did, naming the FMG mirror and skipped devices only when non-zero; a quiet pass logs nothing", async () => {
    m.descEnabled.mockReturnValue(true);
    m.descSync.mockResolvedValueOnce({ ...ZERO_DESC, pushed: 2, adopted: 1, fmgMirrored: 3, fmgMirrorFailed: 1, skippedDevices: 4 });
    const a = input();
    await go(a);
    expect(a.syncLog).toHaveBeenCalledWith("info", "Description sync: pushed 2, adopted 1, failed 0, FMG mirror 3 ok / 1 failed, 4 device(s) skipped");
    m.descSync.mockResolvedValueOnce({ ...ZERO_DESC, failed: 1 });
    const b = input();
    await go(b);
    expect(b.syncLog).toHaveBeenCalledWith("info", "Description sync: pushed 0, adopted 0, failed 1");
    const c = input();
    await go(c);
    expect(c.syncLog).not.toHaveBeenCalled();
  });

  it("a failure is logged, never thrown", async () => {
    m.descEnabled.mockReturnValue(true);
    m.descSync.mockRejectedValue(new Error("fmg 503"));
    const run = input();
    await expect(go(run)).resolves.toBeUndefined();
    expect(run.syncLog).toHaveBeenCalledWith("error", "Description sync failed: fmg 503");
  });
});

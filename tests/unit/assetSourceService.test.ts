/**
 * tests/unit/assetSourceService.test.ts — the Sources tab's server half, moved
 * out of routes/assets/sources.ts (CQ-B062 slice 2): the per-source view's
 * presentation order and (sourceKind, integration) collapse, the split's
 * refusals, and the audited merge's 404s, Event and conflict settling. The
 * HTTP contract stays covered by tests/integration/assetMerge.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  mergeAssets: vi.fn(),
  repointSerial: vi.fn(),
  repointIp: vi.fn(),
  reconcileIp: vi.fn(),
  settleSerial: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
beforeEach(() => resetEventLogStub());
vi.mock("../../src/services/assetMergeService.js", () => ({ mergeAssets: m.mergeAssets }));
vi.mock("../../src/services/duplicateIpConflictService.js", () => ({
  repointDuplicateIpConflicts: m.repointIp,
  reconcileDuplicateIpForAddresses: m.reconcileIp,
}));
vi.mock("../../src/services/duplicateSerialConflictService.js", () => ({
  repointDuplicateSerialConflicts: m.repointSerial,
  settleDuplicateSerialConflictsAfterMerge: m.settleSerial,
}));
// assertAssetExists is the only thing taken from the detail-read service; keep
// its real prisma-backed shape without loading monitoringService.
vi.mock("../../src/services/assetDetailReadService.js", () => ({
  assertAssetExists: async (id: string) => {
    const a = await db.assetFindUnique({ where: { id }, select: { id: true } });
    if (!a) throw Object.assign(new Error("Asset not found"), { httpStatus: 404 });
  },
}));

import { listAssetSourcesForDisplay, splitAssetSource, mergeAssetsAudited } from "../../src/services/assetSourceService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const db = {
  assetFindUnique: stubbed(prisma.asset.findUnique),
  sourceFindMany: stubbed(prisma.assetSource.findMany),
  transaction: stubbed(prisma.$transaction),
};

beforeEach(() => {
  resetDbStub(); for (const f of Object.values(m)) f.mockReset(); });

const src = (over: Record<string, unknown>) => ({
  id: "s", sourceKind: "manual", externalId: "x", integrationId: null, integration: null,
  observed: {}, inferred: false, syncedAt: null, firstSeen: null, lastSeen: null, ...over,
});

describe("listAssetSourcesForDisplay", () => {
  it("404s on an unknown asset", async () => {
    db.assetFindUnique.mockResolvedValue(null);
    await expect(listAssetSourcesForDisplay("gone")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("orders identity-first, manual last, and keeps the newest row per (kind, integration)", async () => {
    db.assetFindUnique.mockResolvedValue({ id: "a" });
    db.sourceFindMany.mockResolvedValue([
      src({ id: "man", sourceKind: "manual" }),
      src({ id: "ep-old", sourceKind: "fortigate-endpoint", integrationId: "i1", lastSeen: new Date("2026-01-01") }),
      src({ id: "ep-new", sourceKind: "fortigate-endpoint", integrationId: "i1", lastSeen: new Date("2026-02-01") }),
      src({ id: "ent", sourceKind: "entra" }),
      src({ id: "odd", sourceKind: "some-new-kind" }),
    ]);
    const out = await listAssetSourcesForDisplay("a");
    expect(out.map((r) => r.id)).toEqual(["ent", "ep-new", "odd", "man"]);
    expect(out[0]).toHaveProperty("state");
  });
});

describe("splitAssetSource", () => {
  it("refuses a manual source and an only source with 409", async () => {
    db.assetFindUnique.mockResolvedValue({ id: "a", hostname: "h" });
    db.sourceFindMany.mockResolvedValue([src({ id: "s1", sourceKind: "manual" }), src({ id: "s2", sourceKind: "ad" })]);
    await expect(splitAssetSource("a", "s1", "op")).rejects.toMatchObject({ httpStatus: 409 });
    db.sourceFindMany.mockResolvedValue([src({ id: "s2", sourceKind: "ad" })]);
    await expect(splitAssetSource("a", "s2", "op")).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("404s a source that is not on the asset", async () => {
    db.assetFindUnique.mockResolvedValue({ id: "a", hostname: "h" });
    db.sourceFindMany.mockResolvedValue([src({ id: "s2", sourceKind: "ad" })]);
    await expect(splitAssetSource("a", "nope", "op")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("creates the new asset, moves the source and logs asset.split with the actor", async () => {
    db.assetFindUnique.mockResolvedValue({ id: "a", hostname: "h" });
    db.sourceFindMany.mockResolvedValue([src({ id: "s1", sourceKind: "entra" }), src({ id: "s2", sourceKind: "ad" })]);
    const create = vi.fn().mockResolvedValue({ id: "new" });
    const update = vi.fn().mockResolvedValue({});
    db.transaction.mockImplementation(async (fn: any) => fn({ asset: { create }, assetSource: { update } }));
    const r = await splitAssetSource("a", "s1", "op");
    expect(r).toMatchObject({ originalAssetId: "a", newAssetId: "new", movedSourceId: "s1" });
    expect(create.mock.calls[0][0].data).toMatchObject({ assetType: "workstation", statusChangedBy: "op", createdBy: "op" });
    expect(update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { assetId: "new" } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "asset.split", actor: "op", resourceId: "a" });
  });
});

describe("mergeAssetsAudited", () => {
  const input = { canonicalId: "c", ghostId: "g", fieldWinners: {}, dependencyWinner: undefined, canManageIntegrations: false, actor: "op" };

  it("404s before touching anything when either side is missing", async () => {
    db.assetFindUnique.mockImplementation(async ({ where }: any) => (where.id === "c" ? { id: "c" } : null));
    await expect(mergeAssetsAudited(input)).rejects.toMatchObject({ httpStatus: 404 });
    expect(m.repointSerial).not.toHaveBeenCalled();
    expect(m.mergeAssets).not.toHaveBeenCalled();
  });

  it("repoints conflicts, merges, logs asset.merged and settles both card kinds", async () => {
    db.assetFindUnique.mockImplementation(async ({ where }: any) =>
      where.id === "c" ? { id: "c", hostname: "keep", ipAddress: "10.0.0.2" } : { id: "g", hostname: "dup", ipAddress: "10.0.0.9" });
    const result = { survivorId: "c", absorbedId: "g", movedSources: 2, carriedMonitoring: false, movedDependents: 0, movedDependencyParents: 0 };
    m.mergeAssets.mockResolvedValue(result);
    expect(await mergeAssetsAudited(input)).toBe(result);
    expect(m.repointSerial).toHaveBeenCalledWith("g", "c");
    expect(m.repointIp).toHaveBeenCalledWith("g", "c");
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "asset.merged", actor: "op", resourceId: "c" });
    expect(m.reconcileIp).toHaveBeenCalledWith(["10.0.0.2", "10.0.0.9"]);
    expect(m.settleSerial).toHaveBeenCalledWith(expect.objectContaining({ survivorAssetId: "c", absorbedAssetId: "g", actor: "op" }));
  });

  it("does not fail a committed merge when settling throws", async () => {
    db.assetFindUnique.mockResolvedValue({ id: "x", hostname: "h", ipAddress: null });
    m.mergeAssets.mockResolvedValue({ survivorId: "c", absorbedId: "g", movedSources: 0, movedDependents: 0, movedDependencyParents: 0 });
    m.settleSerial.mockRejectedValue(new Error("boom"));
    m.reconcileIp.mockRejectedValue(new Error("boom"));
    await expect(mergeAssetsAudited(input)).resolves.toBeTruthy();
  });
});

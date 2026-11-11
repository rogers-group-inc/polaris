/**
 * tests/unit/assetDependencyService.test.ts — the write half of the
 * Dependencies tab moved out of routes/assets/dependencies.ts (CQ-B062 slice
 * 2): the override's refusals (self, unknown, wrong type, cycle) and the
 * Dependency Test's type gate and idempotent clear. The read contract is
 * tests/integration/assetDependenciesContract.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  assetFindUnique: vi.fn(), assetFindMany: vi.fn(), assetUpdate: vi.fn(),
  edgeFindMany: vi.fn(), edgeDeleteMany: vi.fn(), transaction: vi.fn(),
  logEvent: vi.fn(), propagate: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: { findUnique: m.assetFindUnique, findMany: m.assetFindMany, update: m.assetUpdate },
    assetDependencyParent: { findMany: m.edgeFindMany, deleteMany: m.edgeDeleteMany },
    $transaction: m.transaction,
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: m.logEvent }));
vi.mock("../../src/services/dependencyTreeService.js", () => ({ propagateAfterStatusChange: m.propagate, FORTINET_INFRA_ASSET_TYPES: ["firewall", "switch", "access_point"] }));
vi.mock("../../src/services/notificationService.js", () => ({ activeAlertSummaryByAsset: vi.fn() }));

import { setDependencyOverride, clearDependencyOverride, startDependencyTest, clearDependencyTest } from "../../src/services/assetDependencyService.js";

beforeEach(() => { for (const f of Object.values(m)) f.mockReset(); m.assetFindUnique.mockResolvedValue({ id: "a", hostname: "a" }); });

describe("setDependencyOverride", () => {
  it("404s an unknown asset and refuses itself as a parent", async () => {
    m.assetFindUnique.mockResolvedValueOnce(null);
    await expect(setDependencyOverride("a", { parentAssetIds: ["p"] })).rejects.toMatchObject({ httpStatus: 404 });
    await expect(setDependencyOverride("a", { parentAssetIds: ["a"] })).rejects.toThrow(/its own dependency parent/);
  });
  it("refuses an unknown parent and a non-infra parent", async () => {
    m.assetFindMany.mockResolvedValueOnce([]);
    await expect(setDependencyOverride("a", { parentAssetIds: ["p"] })).rejects.toThrow(/not found/);
    m.assetFindMany.mockResolvedValueOnce([{ id: "p", assetType: "server", hostname: "srv" }]);
    await expect(setDependencyOverride("a", { parentAssetIds: ["p"] })).rejects.toThrow(/must be firewall\/switch\/access_point: srv/);
  });
  it("refuses a parent whose own chain leads back to the asset", async () => {
    m.assetFindMany.mockResolvedValue([{ id: "p", assetType: "switch", hostname: "sw" }]);
    m.edgeFindMany.mockResolvedValue([{ assetId: "p", parentAssetId: "a", source: "computed" }]);
    await expect(setDependencyOverride("a", { parentAssetIds: ["p"] })).rejects.toThrow(/cycle/);
    expect(m.transaction).not.toHaveBeenCalled();
  });
});

describe("clearDependencyOverride", () => {
  it("logs only when override edges were removed", async () => {
    m.edgeDeleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await clearDependencyOverride("a")).toEqual({ ok: true, removed: 0 });
    expect(m.logEvent).not.toHaveBeenCalled();
    m.edgeDeleteMany.mockResolvedValueOnce({ count: 2 });
    expect(await clearDependencyOverride("a")).toEqual({ ok: true, removed: 2 });
    expect(m.edgeDeleteMany).toHaveBeenLastCalledWith({ where: { assetId: "a", source: "override" } });
    expect(m.logEvent.mock.calls[0][0].action).toBe("asset.dependency.override_cleared");
  });
});

describe("Dependency Test", () => {
  it("only Fortinet infra can be tested", async () => {
    m.assetFindUnique.mockResolvedValueOnce({ id: "a", hostname: "a", assetType: "server" });
    await expect(startDependencyTest("a", 10, "op")).rejects.toMatchObject({ httpStatus: 400 });
    expect(m.assetUpdate).not.toHaveBeenCalled();
  });
  it("clearing a test that is not running is a no-op", async () => {
    m.assetFindUnique.mockResolvedValueOnce({ id: "a", hostname: "a", dependencyTestUntil: null, dependencyTestStartedBy: null });
    expect(await clearDependencyTest("a", "op")).toEqual({ ok: true, alreadyCleared: true });
    expect(m.assetUpdate).not.toHaveBeenCalled();
    expect(m.propagate).not.toHaveBeenCalled();
  });
  it("clearing a running test resets it, propagates and logs with the actor", async () => {
    m.assetFindUnique.mockResolvedValueOnce({ id: "a", hostname: "a", dependencyTestUntil: new Date(), dependencyTestStartedBy: "x" });
    expect(await clearDependencyTest("a", "op")).toEqual({ ok: true });
    expect(m.assetUpdate).toHaveBeenCalledWith({ where: { id: "a" }, data: { dependencyTestUntil: null, dependencyTestStartedBy: null } });
    expect(m.propagate).toHaveBeenCalledWith("a");
    expect(m.logEvent.mock.calls[0][0]).toMatchObject({ action: "asset.dependency_test.cleared", actor: "op" });
  });
});

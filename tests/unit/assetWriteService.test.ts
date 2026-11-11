/**
 * tests/unit/assetWriteService.test.ts — the request-free pieces of the asset
 * write path moved out of routes/assets/write.ts (CQ-B062 slice 2): the create
 * pre-checks, the monitor-override reset, and the quarantine-status guard
 * (now in assetQuarantineService). The full create / PUT contract is
 * tests/integration/assetPutContract.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  assetFindUnique: vi.fn(), assetUpdate: vi.fn(), integrationFindUnique: vi.fn(), logEvent: vi.fn(),
  assetFindMany: vi.fn(), assetDeleteMany: vi.fn(), assetDelete: vi.fn(), releaseInfra: vi.fn(), syncAzure: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: { findUnique: m.assetFindUnique, update: m.assetUpdate, findMany: m.assetFindMany, deleteMany: m.assetDeleteMany, delete: m.assetDelete },
    integration: { findUnique: m.integrationFindUnique },
  },
}));
vi.mock("../../src/services/eventLogService.js", async (orig) => ({ ...(await orig<object>()), logEvent: m.logEvent }));
vi.mock("../../src/services/reservationService.js", async (orig) => ({ ...(await orig<object>()), releaseInfraReservationsForAssets: m.releaseInfra }));
vi.mock("../../src/services/tagAssignmentService.js", async (orig) => ({ ...(await orig<object>()), syncAzureTagRegistry: m.syncAzure }));

import { validateAssetCreate, resetMonitorOverrideToIntegrationDefault, bulkDeleteAssets, deleteAsset } from "../../src/services/assetWriteService.js";
import { assertQuarantineStatusUntouched } from "../../src/services/assetQuarantineService.js";

beforeEach(() => { for (const f of Object.values(m)) f.mockReset(); });

describe("validateAssetCreate", () => {
  it("refuses a create that sets status quarantined", () => {
    expect(() => validateAssetCreate({ status: "quarantined" } as any)).toThrow(/quarantine/i);
  });
  it("refuses a half coordinate pair", () => {
    expect(() => validateAssetCreate({ latitude: 10 } as any)).toThrow();
  });
  it("accepts a plain create", () => {
    expect(() => validateAssetCreate({ hostname: "x", latitude: 10, longitude: 20 } as any)).not.toThrow();
  });
});

describe("assertQuarantineStatusUntouched", () => {
  it("allows no status, and an unchanged quarantine", () => {
    expect(() => assertQuarantineStatusUntouched(undefined, "quarantined")).not.toThrow();
    expect(() => assertQuarantineStatusUntouched("quarantined", "quarantined")).not.toThrow();
    expect(() => assertQuarantineStatusUntouched("active", "storage")).not.toThrow();
  });
  it("refuses entering or leaving quarantine by status", () => {
    expect(() => assertQuarantineStatusUntouched("quarantined", "active")).toThrow(/POST \/assets\/:id\/quarantine/);
    expect(() => assertQuarantineStatusUntouched("active", "quarantined")).toThrow(/DELETE \/assets\/:id\/quarantine/);
  });
});

describe("bulkDeleteAssets", () => {
  it("refuses the whole call when any id is quarantined, deleting nothing", async () => {
    m.assetFindMany.mockResolvedValue([
      { id: "a", hostname: "a", ipAddress: null, status: "active", assetType: "server" },
      { id: "q", hostname: "q-box", ipAddress: null, status: "quarantined", assetType: "workstation" },
    ]);
    await expect(bulkDeleteAssets(["a", "q"], "op")).rejects.toMatchObject({ httpStatus: 409 });
    expect(m.assetDeleteMany).not.toHaveBeenCalled();
  });

  it("releases infra reservations for switches / APs first, then deletes in one statement", async () => {
    m.assetFindMany.mockResolvedValue([
      { id: "s", hostname: "sw", ipAddress: null, status: "active", assetType: "switch" },
      { id: "w", hostname: "pc", ipAddress: null, status: "active", assetType: "workstation" },
    ]);
    m.assetDeleteMany.mockResolvedValue({ count: 2 });
    expect(await bulkDeleteAssets(["s", "w"], "op")).toBe(2);
    expect(m.releaseInfra).toHaveBeenCalledWith(["s"], { reason: "asset deleted", actor: "op" });
    expect(m.releaseInfra.mock.invocationCallOrder[0]).toBeLessThan(m.assetDeleteMany.mock.invocationCallOrder[0]);
    expect(m.assetDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["s", "w"] } } });
    expect(m.logEvent.mock.calls[0][0]).toMatchObject({ action: "asset.bulk_deleted", actor: "op" });
  });
});

describe("deleteAsset", () => {
  it("404s an unknown asset and 409s a quarantined one", async () => {
    m.assetFindUnique.mockResolvedValueOnce(null);
    await expect(deleteAsset("x", "op")).rejects.toMatchObject({ httpStatus: 404 });
    m.assetFindUnique.mockResolvedValueOnce({ id: "x", status: "quarantined", hostname: "h", ipAddress: null, assetType: "server", tags: [] });
    await expect(deleteAsset("x", "op")).rejects.toMatchObject({ httpStatus: 409 });
    expect(m.assetDelete).not.toHaveBeenCalled();
  });

  it("releases an AP's reservation before deleting and resyncs azure tags only when it carried one", async () => {
    m.assetFindUnique.mockResolvedValue({ id: "ap", status: "active", hostname: "ap1", ipAddress: "10.0.0.5", assetType: "access_point", tags: ["azure:env=prod"] });
    await deleteAsset("ap", "op");
    expect(m.releaseInfra).toHaveBeenCalledWith(["ap"], { reason: "asset deleted", actor: "op" });
    expect(m.assetDelete).toHaveBeenCalledWith({ where: { id: "ap" } });
    expect(m.syncAzure).toHaveBeenCalled();
    expect(m.logEvent.mock.calls[0][0]).toMatchObject({ action: "asset.deleted", resourceId: "ap", actor: "op" });
  });
});

describe("resetMonitorOverrideToIntegrationDefault", () => {
  const base = { id: "a", hostname: "h", ipAddress: null, assetType: "switch", monitored: false, monitorOverride: true, discoveredByIntegrationId: "i", fortinetTopology: null };

  it("404s an unknown asset and 400s one with no discovering integration", async () => {
    m.assetFindUnique.mockResolvedValueOnce(null);
    await expect(resetMonitorOverrideToIntegrationDefault("a", "op")).rejects.toMatchObject({ httpStatus: 404 });
    m.assetFindUnique.mockResolvedValueOnce({ ...base, discoveredByIntegrationId: null });
    await expect(resetMonitorOverrideToIntegrationDefault("a", "op")).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("realigns to the integration's class flag, clears the pin and logs the reset", async () => {
    m.assetFindUnique.mockResolvedValue(base);
    m.integrationFindUnique.mockResolvedValue({ type: "fortimanager", config: { addAsMonitored: { switches: true } } });
    m.assetUpdate.mockImplementation(async ({ data }: any) => ({ ...base, ...data }));
    const r = await resetMonitorOverrideToIntegrationDefault("a", "op");
    expect(m.assetUpdate.mock.calls[0][0].data.monitorOverride).toBe(false);
    expect(typeof m.assetUpdate.mock.calls[0][0].data.monitored).toBe("boolean");
    expect(r.monitorOverride).toBe(false);
    expect(m.logEvent.mock.calls[0][0]).toMatchObject({ action: "monitor.override_reset", resourceId: "a", actor: "op" });
  });

  it("an HA standby firewall always resets to unmonitored", async () => {
    m.assetFindUnique.mockResolvedValue({ ...base, assetType: "firewall", fortinetTopology: { haRole: "secondary" } });
    m.integrationFindUnique.mockResolvedValue({ type: "fortimanager", config: {} });
    m.assetUpdate.mockImplementation(async ({ data }: any) => ({ ...base, ...data }));
    await resetMonitorOverrideToIntegrationDefault("a", "op");
    expect(m.assetUpdate.mock.calls[0][0].data).toEqual({ monitored: false, monitorOverride: false });
  });
});

/**
 * tests/unit/assetWriteService.test.ts — the request-free pieces of the asset
 * write path moved out of routes/assets/write.ts (CQ-B062 slice 2): the create
 * pre-checks, the monitor-override reset, and the quarantine-status guard
 * (now in assetQuarantineService). The full create / PUT contract is
 * tests/integration/assetPutContract.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ assetFindUnique: vi.fn(), assetUpdate: vi.fn(), integrationFindUnique: vi.fn(), logEvent: vi.fn() }));
vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: { findUnique: m.assetFindUnique, update: m.assetUpdate },
    integration: { findUnique: m.integrationFindUnique },
  },
}));
vi.mock("../../src/services/eventLogService.js", async (orig) => ({ ...(await orig<object>()), logEvent: m.logEvent }));

import { validateAssetCreate, resetMonitorOverrideToIntegrationDefault } from "../../src/services/assetWriteService.js";
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

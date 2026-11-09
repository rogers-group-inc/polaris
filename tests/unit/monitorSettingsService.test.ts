/**
 * tests/unit/monitorSettingsService.test.ts
 *
 * The write side of the monitoring-settings hierarchy (manual tier, integration
 * tier, manual-scope class overrides): what each write validates, what it
 * persists, and that it invalidates the resolver cache for exactly its scope so
 * the next monitor pass picks the change up.
 *
 * The polling-compatibility matrix (utils/pollingCompatibility.ts) and the
 * collector-capability table run for real — the service's job is to apply them
 * at write time, and a mocked matrix would only test the mock.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  settingFindUnique: vi.fn(),
  settingUpsert: vi.fn(),
  integrationFindUnique: vi.fn(),
  integrationUpdate: vi.fn(),
  overrideFindMany: vi.fn(),
  overrideFindFirst: vi.fn(),
  overrideFindUnique: vi.fn(),
  overrideCreate: vi.fn(),
  overrideUpdate: vi.fn(),
  overrideDelete: vi.fn(),
  assetFindMany: vi.fn(),
  invalidate: vi.fn(),
  logEvent: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: { findUnique: m.settingFindUnique, upsert: m.settingUpsert },
    integration: { findUnique: m.integrationFindUnique, update: m.integrationUpdate },
    monitorClassOverride: {
      findMany: m.overrideFindMany,
      findFirst: m.overrideFindFirst,
      findUnique: m.overrideFindUnique,
      create: m.overrideCreate,
      update: m.overrideUpdate,
      delete: m.overrideDelete,
    },
    asset: { findMany: m.assetFindMany },
  },
}));
vi.mock("../../src/services/monitoringService.js", () => ({ invalidateMonitorSettingsCache: m.invalidate }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: m.logEvent }));
vi.mock("../../src/utils/logger.js", () => ({
  logger: { warn: m.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const svc = await import("../../src/services/monitorSettingsService.js");

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.settingUpsert.mockResolvedValue({});
  m.integrationUpdate.mockResolvedValue({});
  m.overrideCreate.mockImplementation(async (a: { data: Record<string, unknown> }) => ({ id: "ov-new", integration: null, ...a.data }));
  m.overrideUpdate.mockImplementation(async (a: { where: { id: string }; data: Record<string, unknown> }) => ({
    id: a.where.id, assetType: "server", integration: null, ...a.data,
  }));
  m.overrideDelete.mockResolvedValue({});
});

const fmg = { id: "int-fmg", name: "FMG", type: "fortimanager", config: { host: "fmg", monitorSettings: { old: true } } };

// ─── Manual tier ─────────────────────────────────────────────────────────────

describe("manual tier", () => {
  it("reads null until an operator has saved something", async () => {
    m.settingFindUnique.mockResolvedValue(null);
    await expect(svc.getManualMonitorSettings()).resolves.toBeNull();
  });

  it("persists the input with the legacy retention keys stripped, and invalidates the manual scope", async () => {
    const out = await svc.updateManualMonitorSettings(
      { intervalSeconds: 30, sampleRetentionDays: 7, telemetryRetentionDays: 7, systemInfoRetentionDays: 7 },
      "alice",
    );
    expect(out).toEqual({ intervalSeconds: 30 });
    const up = m.settingUpsert.mock.calls[0][0];
    expect(up.where).toEqual({ key: "manualMonitorSettings" });
    expect(up.update.value).toEqual({ intervalSeconds: 30 });
    expect(up.create.value).toEqual({ intervalSeconds: 30 });
    expect(m.invalidate).toHaveBeenCalledWith({ integrationId: null });
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "monitor_settings.manual.updated", actor: "alice" }));
  });
});

// ─── Integration tier ────────────────────────────────────────────────────────

describe("integration tier", () => {
  it("404s for an unknown integration on read and on write", async () => {
    m.integrationFindUnique.mockResolvedValue(null);
    await expect(svc.getIntegrationMonitorSettings("x")).rejects.toMatchObject({ httpStatus: 404 });
    await expect(svc.updateIntegrationMonitorSettings("x", {}, "a")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("reads the tier from config.monitorSettings, null when unseeded", async () => {
    m.integrationFindUnique.mockResolvedValue({ ...fmg, config: { host: "fmg" } });
    await expect(svc.getIntegrationMonitorSettings("int-fmg")).resolves.toEqual({
      integrationId: "int-fmg", integrationName: "FMG", integrationType: "fortimanager", settings: null,
    });
  });

  it("replaces config.monitorSettings, keeps the rest of the config, and invalidates that integration only", async () => {
    m.integrationFindUnique.mockResolvedValue({ ...fmg, config: { ...fmg.config } });
    await svc.updateIntegrationMonitorSettings("int-fmg", { responseTimePolling: "snmp", sampleRetentionDays: 3 }, "alice");
    const data = m.integrationUpdate.mock.calls[0][0].data;
    expect(data.config).toEqual({ host: "fmg", monitorSettings: { responseTimePolling: "snmp" } });
    expect(m.invalidate).toHaveBeenCalledWith({ integrationId: "int-fmg" });
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "monitor_settings.integration.updated", resourceId: "int-fmg",
    }));
  });

  it("refuses a method the integration's source cannot use (WinRM on FortiManager) and writes nothing", async () => {
    m.integrationFindUnique.mockResolvedValue({ ...fmg });
    await expect(
      svc.updateIntegrationMonitorSettings("int-fmg", { cpuMemoryPolling: "winrm" }, "alice"),
    ).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("cpuMemoryPolling") });
    expect(m.integrationUpdate).not.toHaveBeenCalled();
    expect(m.invalidate).not.toHaveBeenCalled();
  });

  it("refuses a method the stream cannot ride even when the source allows it (REST for processes)", async () => {
    m.integrationFindUnique.mockResolvedValue({ ...fmg });
    await expect(
      svc.updateIntegrationMonitorSettings("int-fmg", { processesPolling: "rest_api" }, "alice"),
    ).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("processes stream") });
  });

  it("refuses ICMP on any stream but response time", async () => {
    m.integrationFindUnique.mockResolvedValue({ ...fmg });
    await expect(
      svc.updateIntegrationMonitorSettings("int-fmg", { responseTimePolling: "icmp" }, "a"),
    ).resolves.toBeDefined();
    await expect(
      svc.updateIntegrationMonitorSettings("int-fmg", { storagePolling: "icmp" }, "a"),
    ).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("ICMP") });
  });

  it("accepts — but warns about — a compatible method with no collector, so a re-save of a stored value never 400s", async () => {
    m.integrationFindUnique.mockResolvedValue({ ...fmg });
    // SNMP processes (hrSWRunTable) is compatible on paper and unimplemented.
    await expect(
      svc.updateIntegrationMonitorSettings("int-fmg", { processesPolling: "snmp" }, "a"),
    ).resolves.toEqual({ processesPolling: "snmp" });
    expect(m.warn).toHaveBeenCalledTimes(1);
    expect(m.warn.mock.calls[0][0]).toMatchObject({ stream: "processes", method: "snmp" });
    expect(m.integrationUpdate).toHaveBeenCalled();
  });

  it("ignores unset / null polling fields", async () => {
    m.integrationFindUnique.mockResolvedValue({ ...fmg });
    await expect(
      svc.updateIntegrationMonitorSettings("int-fmg", { cpuMemoryPolling: null, lldpPolling: undefined }, "a"),
    ).resolves.toBeDefined();
  });
});

// ─── Class overrides ─────────────────────────────────────────────────────────

describe("class overrides", () => {
  it("filters by integrationId, with the string 'null' selecting manual-scope rows", async () => {
    m.overrideFindMany.mockResolvedValue([]);
    await svc.listClassOverrides("null", "server");
    expect(m.overrideFindMany.mock.calls[0][0].where).toEqual({ integrationId: null, assetType: "server" });
    await svc.listClassOverrides("int-1", undefined);
    expect(m.overrideFindMany.mock.calls[1][0].where).toEqual({ integrationId: "int-1" });
    await svc.listClassOverrides(undefined, 42);
    expect(m.overrideFindMany.mock.calls[2][0].where).toEqual({});
  });

  it("refuses to create an integration-scoped override (Phase 2: manual scope only)", async () => {
    await expect(
      svc.createClassOverride({ integrationId: "int-1", assetType: "server" }, "a"),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(m.overrideCreate).not.toHaveBeenCalled();
  });

  it("409s a duplicate manual-scope (null, assetType) pair, which the @@unique cannot catch on NULL", async () => {
    m.overrideFindFirst.mockResolvedValue({ id: "ov-1" });
    await expect(
      svc.createClassOverride({ integrationId: null, assetType: "server" }, "a"),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect(m.overrideFindFirst.mock.calls[0][0].where).toEqual({ integrationId: null, assetType: "server" });
    expect(m.overrideCreate).not.toHaveBeenCalled();
  });

  it("creates with retention keys stripped, invalidates (null, assetType), and logs 'Manual'", async () => {
    m.overrideFindFirst.mockResolvedValue(null);
    const created = await svc.createClassOverride(
      { integrationId: null, assetType: "printer", responseTimePolling: "snmp", sampleRetentionDays: 9 },
      "alice",
    );
    expect(m.overrideCreate.mock.calls[0][0].data).toEqual({ integrationId: null, assetType: "printer", responseTimePolling: "snmp" });
    expect(created.id).toBe("ov-new");
    expect(m.invalidate).toHaveBeenCalledWith({ integrationId: null, assetType: "printer" });
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "monitor_settings.class_override.created", resourceName: "printer @ Manual",
    }));
  });

  it("validates a manual-scope create against the stream rules (ICMP off response time is refused)", async () => {
    m.overrideFindFirst.mockResolvedValue(null);
    await expect(
      svc.createClassOverride({ integrationId: null, assetType: "printer", temperaturePolling: "icmp" }, "a"),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("404s an update or delete of an override that does not exist", async () => {
    m.overrideFindUnique.mockResolvedValue(null);
    await expect(svc.updateClassOverride("nope", {}, "a")).rejects.toMatchObject({ httpStatus: 404 });
    await expect(svc.deleteClassOverride("nope", "a")).rejects.toMatchObject({ httpStatus: 404 });
    expect(m.overrideDelete).not.toHaveBeenCalled();
  });

  it("refuses to update a leftover integration-scoped row the Phase 2 sweep missed", async () => {
    m.overrideFindUnique.mockResolvedValue({ id: "ov-1", integrationId: "int-1", assetType: "server", integration: { type: "fortigate" } });
    await expect(svc.updateClassOverride("ov-1", {}, "a")).rejects.toMatchObject({ httpStatus: 400 });
    expect(m.overrideUpdate).not.toHaveBeenCalled();
  });

  it("updates a manual-scope row and invalidates the row's own (integrationId, assetType) scope", async () => {
    m.overrideFindUnique.mockResolvedValue({ id: "ov-1", integrationId: null, assetType: "server", integration: null });
    await svc.updateClassOverride("ov-1", { cpuMemoryPolling: "agent", telemetryRetentionDays: 4 }, "alice");
    expect(m.overrideUpdate.mock.calls[0][0].data).toEqual({ cpuMemoryPolling: "agent" });
    expect(m.invalidate).toHaveBeenCalledWith({ integrationId: null, assetType: "server" });
  });

  it("delete removes the row, invalidates its scope, and writes a deleted Event", async () => {
    m.overrideFindUnique.mockResolvedValue({ id: "ov-1", integrationId: null, assetType: "server", integration: null });
    await svc.deleteClassOverride("ov-1", "alice");
    expect(m.overrideDelete).toHaveBeenCalledWith({ where: { id: "ov-1" } });
    expect(m.invalidate).toHaveBeenCalledWith({ integrationId: null, assetType: "server" });
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "monitor_settings.class_override.deleted", resourceId: "ov-1" }));
  });
});

// ─── Asset-overrides reverse lookup ──────────────────────────────────────────

describe("listAssetOverrides", () => {
  beforeEach(() => m.assetFindMany.mockResolvedValue([]));

  it("scopes by discovering integration ('null' = manual) and asset type, capped at 500", async () => {
    await svc.listAssetOverrides("null", "server");
    const q = m.assetFindMany.mock.calls[0][0];
    expect(q.where.discoveredByIntegrationId).toBeNull();
    expect(q.where.assetType).toBe("server");
    expect(q.take).toBe(500);
    await svc.listAssetOverrides("int-1", undefined);
    const q2 = m.assetFindMany.mock.calls[1][0];
    expect(q2.where.discoveredByIntegrationId).toBe("int-1");
    expect(q2.where).not.toHaveProperty("assetType");
  });

  it("selects the IPv6 address so an IPv6-only asset can be shown (business rule 128)", async () => {
    await svc.listAssetOverrides(undefined, undefined);
    expect(m.assetFindMany.mock.calls[0][0].select.ipv6Address).toBe(true);
  });

  // SUSPECTED GAP (not fixed — tests-only change, see CQ-T010 in
  // docs/CODE-QUALITY-LEDGER.md): the OR list predates the processes /
  // eventLog streams and the per-stream lldp / storage / processes / eventLog
  // intervals. An asset whose ONLY override is one of those columns never
  // appears in the "Asset Overrides" list, so an operator auditing deviations
  // at a scope cannot see it. Flip to `it` once the OR list (and the select)
  // cover every per-asset override column on Asset.
  it.fails("finds an asset whose only per-asset override is a newer stream's polling method or interval", async () => {
    await svc.listAssetOverrides(undefined, undefined);
    const or = m.assetFindMany.mock.calls[0][0].where.OR as Array<Record<string, unknown>>;
    const cols = or.map((c) => Object.keys(c)[0]);
    for (const col of ["processesPolling", "eventLogPolling", "lldpIntervalSec", "storageIntervalSec", "processesIntervalSec", "eventLogIntervalSec"]) {
      expect(cols).toContain(col);
    }
  });
});

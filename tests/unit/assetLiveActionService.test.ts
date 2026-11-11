/**
 * tests/unit/assetLiveActionService.test.ts — the asset details buttons that
 * reach a device, moved out of routes/assets/detail.ts (CQ-B062 slice 2):
 * the integration device-filter gate refuses before any traffic (409 + an
 * Event), rediscover's refusals, and the SNMP walk's credential checks. Also
 * the monitor-history range checks now in assetDetailReadService.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ logEvent: vi.fn(),
  filter: vi.fn(), probeAsset: vi.fn(), collectSystemInfo: vi.fn(), snmpWalkRaw: vi.fn(),
  scope: vi.fn(), isRunActive: vi.fn(), triggerDiscovery: vi.fn(),
  assertCredScope: vi.fn(), getCredential: vi.fn(), recordUse: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: m.logEvent }));
vi.mock("../../src/utils/integrationFilter.js", () => ({ assetMatchesIntegrationFilter: m.filter }));
vi.mock("../../src/services/monitoringService.js", () => ({
  probeAsset: m.probeAsset, recordProbeResult: vi.fn(), collectTelemetry: vi.fn(), recordTelemetryResult: vi.fn(),
  collectHardwareSensors: vi.fn(), recordHardwareSensorResult: vi.fn(), collectSystemInfo: m.collectSystemInfo,
  recordSystemInfoResult: vi.fn(), runSdwanFor: vi.fn(), snmpWalkRaw: m.snmpWalkRaw,
}));
vi.mock("../../src/services/discovery/assetDiscoveryScope.js", () => ({ resolveDiscoveryScopeForAsset: m.scope }));
vi.mock("../../src/services/discoveryRunState.js", () => ({ isRunActive: m.isRunActive }));
vi.mock("../../src/services/discovery/discoveryEngine.js", () => ({ triggerDiscovery: m.triggerDiscovery }));
vi.mock("../../src/services/assetCredentialScopeService.js", () => ({ assertCredentialInAssetScope: m.assertCredScope }));
vi.mock("../../src/services/credentialService.js", () => ({ getCredential: m.getCredential }));
vi.mock("../../src/services/credentialUseAuditService.js", () => ({ recordCredentialUse: m.recordUse }));
vi.mock("../../src/services/ipv6GateService.js", () => ({ ipv6Dialable: () => false }));

import { pollAssetNow, refreshAssetSystemInfo, rediscoverAsset, snmpWalkAsset } from "../../src/services/assetLiveActionService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const db = {
  assetFindUnique: stubbed(prisma.asset.findUnique),
  sourceFindFirst: stubbed(prisma.assetSource.findFirst),
};

beforeEach(() => {
  resetDbStub(); for (const f of Object.values(m)) f.mockReset(); });

const filtered = { hostname: "fg1", ipAddress: "10.0.0.1", learnedLocation: null, assetType: "firewall", discoveredByIntegration: { id: "i", type: "fortimanager", name: "FMG", config: {} } };
const cred = { username: "op", actor: "op", mayUseAny: false };

describe("the device-filter gate", () => {
  it("Poll now 404s an unknown asset", async () => {
    db.assetFindUnique.mockResolvedValue(null);
    await expect(pollAssetNow("x", "op")).rejects.toMatchObject({ httpStatus: 404 });
  });
  it("Poll now on an excluded device answers 409 with the reason and probes nothing", async () => {
    db.assetFindUnique.mockResolvedValue(filtered);
    m.filter.mockReturnValue({ included: false, reason: "Excluded by deviceExclude" });
    const r = await pollAssetNow("a", "op");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ success: false, error: "Excluded by deviceExclude" });
    expect(m.probeAsset).not.toHaveBeenCalled();
    expect(m.logEvent.mock.calls[0][0]).toMatchObject({ action: "asset.refresh", level: "warning", actor: "op" });
  });
  it("Refresh on an excluded device answers 409 and collects nothing", async () => {
    db.assetFindUnique.mockResolvedValue(filtered);
    m.filter.mockReturnValue({ included: false, reason: "nope" });
    expect(await refreshAssetSystemInfo("a", "op")).toEqual({ status: 409, body: { supported: true, collected: false, error: "nope" } });
    expect(m.collectSystemInfo).not.toHaveBeenCalled();
  });
});

describe("rediscoverAsset", () => {
  it("404 for a missing asset, 400 with the reason for one with no re-runnable discovery", async () => {
    m.scope.mockResolvedValueOnce({ ok: false, notFound: true, reason: "Asset not found" });
    await expect(rediscoverAsset("x", "op")).rejects.toMatchObject({ httpStatus: 404 });
    m.scope.mockResolvedValueOnce({ ok: false, reason: "Manual asset" });
    await expect(rediscoverAsset("x", "op")).rejects.toMatchObject({ httpStatus: 400, message: "Manual asset" });
  });
  it("409 while a run is active, without starting another", async () => {
    m.scope.mockResolvedValue({ ok: true, resolved: { integration: { id: "i", name: "FMG", type: "fortimanager" }, scope: null, deviceName: "fg1", filterAsset: filtered, viaController: false } });
    m.filter.mockReturnValue({ included: true, reason: null });
    m.isRunActive.mockResolvedValue(true);
    const r = await rediscoverAsset("a", "op");
    expect(r.status).toBe(409);
    expect(m.triggerDiscovery).not.toHaveBeenCalled();
  });
  it("queues the run (202) under the caller's name", async () => {
    m.scope.mockResolvedValue({ ok: true, resolved: { integration: { id: "i", name: "FMG", type: "fortimanager" }, scope: { deviceName: "fg1" }, deviceName: "fg1", filterAsset: filtered, viaController: false } });
    m.filter.mockReturnValue({ included: true, reason: null });
    m.isRunActive.mockResolvedValue(false);
    m.triggerDiscovery.mockResolvedValue(true);
    const r = await rediscoverAsset("a", "op");
    expect(r.status).toBe(202);
    expect(m.triggerDiscovery).toHaveBeenCalledWith("i", "op", { scope: { deviceName: "fg1" }, scopeLabel: "fg1" });
  });
});

describe("snmpWalkAsset", () => {
  const walk = { credentialId: "c", oid: "1.3.6.1.2.1.1", maxRows: 10 };
  it("400 for an asset with no address, and for a non-SNMP credential", async () => {
    db.assetFindUnique.mockResolvedValueOnce({ id: "a", hostname: "h", ipAddress: null, ipv6Address: null });
    await expect(snmpWalkAsset("a", walk, false, cred, "op")).rejects.toMatchObject({ httpStatus: 400 });
    db.assetFindUnique.mockResolvedValueOnce({ id: "a", hostname: "h", ipAddress: "10.0.0.2", ipv6Address: null });
    m.getCredential.mockResolvedValueOnce({ id: "c", name: "ssh1", type: "ssh", config: {} });
    await expect(snmpWalkAsset("a", walk, false, cred, "op")).rejects.toThrow(/expected "snmp"/);
    expect(m.snmpWalkRaw).not.toHaveBeenCalled();
  });
  it("checks the credential scope at read level, records the use, and answers 502 on a device failure", async () => {
    db.assetFindUnique.mockResolvedValue({ id: "a", hostname: "h", ipAddress: "10.0.0.2", ipv6Address: null });
    m.getCredential.mockResolvedValue({ id: "c", name: "snmp1", type: "snmp", config: {} });
    m.snmpWalkRaw.mockRejectedValue(new Error("timeout"));
    await expect(snmpWalkAsset("a", walk, false, cred, "op")).rejects.toMatchObject({ httpStatus: 502 });
    expect(m.assertCredScope).toHaveBeenCalledWith("a", "c", false);
    expect(m.recordUse.mock.calls[0][1]).toBe("asset.snmp-walk");
  });
});

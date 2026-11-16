/**
 * tests/unit/notificationCadenceService.test.ts — own unit suite for
 * src/services/notificationCadenceService.ts (CQ-T010).
 *
 * The pure half (streamForMetric, summarizeIntervals) is pinned in
 * notificationCadence.test.ts; this suite covers the two DB-backed lookups with
 * the scope loader and the monitor-settings resolver mocked at the module
 * boundary, plus METRIC_STREAM's coverage of the engine's metric catalogue.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveMonitorSettings: vi.fn(),
  resolveSdwanIntervalSec: vi.fn(),
  sdwanShouldQueue: vi.fn(),
  loadScopeAssetIds: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/monitoringService.js", () => ({
  resolveMonitorSettings: mocks.resolveMonitorSettings,
  resolveSdwanIntervalSec: mocks.resolveSdwanIntervalSec,
  sdwanShouldQueue: mocks.sdwanShouldQueue,
}));
vi.mock("../../src/services/notificationEngine.js", () => ({
  loadScopeAssetIds: mocks.loadScopeAssetIds,
}));

import {
  resolveScopeCadence,
  resolveAssetCadenceSec,
  METRIC_STREAM,
  summarizeIntervals,
} from "../../src/services/notificationCadenceService.js";
import { ASSET_METRICS, ASSET_STATE_FIELDS } from "../../src/services/notificationTypes/triggers.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const SETTINGS = {
  intervalSeconds: 60, probeTimeoutMs: 2000,
  cpuMemoryIntervalSeconds: 300, cpuMemoryTimeoutMs: 10000,
  temperatureIntervalSeconds: 600, temperatureTimeoutMs: 15000,
  systemInfoIntervalSeconds: 900, systemInfoTimeoutMs: 20000,
  storageIntervalSeconds: 1800, storageTimeoutMs: 25000,
};

const asset = (id: string, extra: Record<string, unknown> = {}) => ({
  id, assetType: "switch", discoveredByIntegrationId: "i1", discoveredByIntegration: { type: "fortimanager" }, ...extra,
});

beforeEach(() => {
  resetDbStub();
  for (const f of Object.values(mocks)) f.mockReset();
  mocks.resolveMonitorSettings.mockResolvedValue(SETTINGS);
  mocks.loadScopeAssetIds.mockResolvedValue([]);
});

describe("METRIC_STREAM coverage", () => {
  it("names a stream for every asset metric the engine resolves", () => {
    const missing = (ASSET_METRICS as readonly string[]).filter((m) => !(m in METRIC_STREAM));
    expect(missing).toEqual([]);
  });

  it("names a stream for every asset-state field", () => {
    const missing = (ASSET_STATE_FIELDS as readonly string[]).filter((f) => !(f in METRIC_STREAM));
    expect(missing).toEqual([]);
  });

  it("maps the controller-link field to the system-info (interface) cadence (rule 59(a))", async () => {
    // Was the probe cadence until 2026-11-16: the sweep ran on its own 60 s timer.
    expect(METRIC_STREAM.fortilinkStatus).toBe("systemInfo");
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset("a1"));
    expect(await resolveAssetCadenceSec("a1", "fortilinkStatus")).toBe(900);
  });

  it("summarizeIntervals ignores non-finite values", () => {
    expect(summarizeIntervals([Number.NaN, Number.POSITIVE_INFINITY, 60])).toEqual({ mode: 60, min: 60, max: 60 });
  });
});

describe("resolveAssetCadenceSec", () => {
  it("reads the stream's interval off the device's resolved settings", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset("a1"));
    expect(await resolveAssetCadenceSec("a1", "memPct")).toBe(300);
    expect(await resolveAssetCadenceSec("a1", "ifInBps")).toBe(900);
    expect(await resolveAssetCadenceSec("a1", "storageUsedPct")).toBe(1800);
    expect(await resolveAssetCadenceSec("a1", "hwSensorValue")).toBe(600);
    expect(await resolveAssetCadenceSec("a1", null)).toBe(60);
  });

  it("hands the resolver the integration type off the joined relation", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset("a1"));
    await resolveAssetCadenceSec("a1", "cpuPct");
    expect(mocks.resolveMonitorSettings.mock.calls[0]![0]).toMatchObject({ id: "a1", discoveredByIntegrationType: "fortimanager" });
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset("a2", { discoveredByIntegration: null }));
    await resolveAssetCadenceSec("a2", "cpuPct");
    expect(mocks.resolveMonitorSettings.mock.calls[1]![0]).toMatchObject({ discoveredByIntegrationType: null });
  });

  it("reads an SD-WAN metric's interval from the integration sidecar", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset("a1"));
    mocks.resolveSdwanIntervalSec.mockReturnValue(120);
    expect(await resolveAssetCadenceSec("a1", "sdwanLatencyMs")).toBe(120);
  });

  it("answers null for no device, an unknown device, a non-positive interval, or a resolver failure", async () => {
    expect(await resolveAssetCadenceSec(null, "cpuPct")).toBeNull();
    expect(await resolveAssetCadenceSec(undefined, "cpuPct")).toBeNull();
    stubbed(prisma.asset.findUnique).mockResolvedValue(null);
    expect(await resolveAssetCadenceSec("gone", "cpuPct")).toBeNull();
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset("a1"));
    mocks.resolveMonitorSettings.mockResolvedValue({ ...SETTINGS, cpuMemoryIntervalSeconds: 0 });
    expect(await resolveAssetCadenceSec("a1", "cpuPct")).toBeNull();
    mocks.resolveMonitorSettings.mockRejectedValue(new Error("boom"));
    expect(await resolveAssetCadenceSec("a1", "cpuPct")).toBeNull();
  });

  it("answers a path-check reading from the CHECK's interval, never the device's", async () => {
    stubbed(prisma.pathCheck.findUnique).mockResolvedValue({ intervalSec: 45 });
    expect(await resolveAssetCadenceSec(null, "pathLatencyMs", "chk1")).toBe(45);
    expect(prisma.pathCheck.findUnique).toHaveBeenCalledWith({ where: { id: "chk1" }, select: { intervalSec: true } });
    expect(prisma.asset.findUnique).not.toHaveBeenCalled();
  });

  it("answers null for a path-check reading with no check id, an unknown check, or a zero interval", async () => {
    expect(await resolveAssetCadenceSec("a1", "pathOk")).toBeNull();
    expect(prisma.pathCheck.findUnique).not.toHaveBeenCalled();
    stubbed(prisma.pathCheck.findUnique).mockResolvedValue(null);
    expect(await resolveAssetCadenceSec("a1", "pathOk", "x")).toBeNull();
    stubbed(prisma.pathCheck.findUnique).mockResolvedValue({ intervalSec: 0 });
    expect(await resolveAssetCadenceSec("a1", "pathOk", "x")).toBeNull();
  });
});

describe("resolveScopeCadence", () => {
  it("answers an empty cadence when the scope matches no monitored device", async () => {
    const out = await resolveScopeCadence({} as never, "memPct");
    expect(out).toEqual({ stream: "cpuMemory", mode: 0, min: 0, max: 0, timeoutMs: 0, assetCount: 0 });
    expect(mocks.loadScopeAssetIds).toHaveBeenCalledWith({}, { monitoredOnly: true });
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });

  it("reports the modal interval, the range and the modal timeout across the matched devices", async () => {
    mocks.loadScopeAssetIds.mockResolvedValue(["a1", "a2", "a3"]);
    stubbed(prisma.asset.findMany).mockResolvedValue([asset("a1"), asset("a2"), asset("a3", { discoveredByIntegrationId: "i2" })]);
    mocks.resolveMonitorSettings
      .mockResolvedValueOnce(SETTINGS)
      .mockResolvedValueOnce(SETTINGS)
      .mockResolvedValueOnce({ ...SETTINGS, cpuMemoryIntervalSeconds: 60, cpuMemoryTimeoutMs: 5000 });
    const out = await resolveScopeCadence({} as never, "cpuPct");
    expect(out).toEqual({ stream: "cpuMemory", mode: 300, min: 60, max: 300, timeoutMs: 10000, assetCount: 3 });
    expect(prisma.asset.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["a1", "a2", "a3"] } } }));
  });

  it("falls back to the probe cadence for an unmapped metric", async () => {
    mocks.loadScopeAssetIds.mockResolvedValue(["a1"]);
    stubbed(prisma.asset.findMany).mockResolvedValue([asset("a1")]);
    const out = await resolveScopeCadence({} as never, "somethingNew");
    expect(out).toMatchObject({ stream: "responseTime", mode: 60, timeoutMs: 2000, assetCount: 1 });
  });

  it("skips a device whose settings will not resolve rather than guessing", async () => {
    mocks.loadScopeAssetIds.mockResolvedValue(["a1", "a2"]);
    stubbed(prisma.asset.findMany).mockResolvedValue([asset("a1"), asset("a2")]);
    mocks.resolveMonitorSettings.mockResolvedValueOnce(SETTINGS).mockRejectedValueOnce(new Error("bad"));
    const out = await resolveScopeCadence({} as never, "memPct");
    expect(out).toMatchObject({ mode: 300, min: 300, max: 300 });
  });

  // Was a bug until 2026-11-14: a device whose settings fail to resolve "contributes nothing rather
  // than a guess — the caption says how many devices it is speaking for"
  // (the catch block's own comment), yet assetCount is assets.length. Input:
  // two matched devices, one resolver failure. Actual assetCount 2 (the caption
  // claims both); expected 1 (the device the interval actually speaks for).
  it("counts only the devices the reported interval speaks for", async () => {
    mocks.loadScopeAssetIds.mockResolvedValue(["a1", "a2"]);
    stubbed(prisma.asset.findMany).mockResolvedValue([asset("a1"), asset("a2")]);
    mocks.resolveMonitorSettings.mockResolvedValueOnce(SETTINGS).mockRejectedValueOnce(new Error("bad"));
    const out = await resolveScopeCadence({} as never, "memPct");
    expect(out.assetCount).toBe(1);
  });

  it("reports zeros when every device's settings fail", async () => {
    mocks.loadScopeAssetIds.mockResolvedValue(["a1"]);
    stubbed(prisma.asset.findMany).mockResolvedValue([asset("a1")]);
    mocks.resolveMonitorSettings.mockRejectedValue(new Error("bad"));
    const out = await resolveScopeCadence({} as never, "memPct");
    expect(out).toMatchObject({ mode: 0, min: 0, max: 0, timeoutMs: 0 });
  });

  it("counts only the gates the SD-WAN pass polls, at the sidecar interval", async () => {
    mocks.loadScopeAssetIds.mockResolvedValue(["g1", "g2", "g3"]);
    stubbed(prisma.asset.findMany).mockResolvedValue([asset("g1"), asset("g2"), asset("g3")]);
    mocks.resolveSdwanIntervalSec.mockImplementation((a: { id: string }) => (a.id === "g3" ? 30 : 60));
    mocks.sdwanShouldQueue.mockImplementation((a: { id: string }) => a.id !== "g2");
    const out = await resolveScopeCadence({} as never, "sdwanPacketLoss");
    expect(out).toEqual({ stream: "sdwan", mode: 30, min: 30, max: 60, timeoutMs: 20000, assetCount: 2 });
  });

  it("answers a path metric from the enabled checks the scoped hosts run, one row per host x check", async () => {
    mocks.loadScopeAssetIds.mockResolvedValue(["h1", "h2", "h3"]);
    stubbed(prisma.pathCheckSource.findMany).mockResolvedValue([
      { assetId: "h1", check: { intervalSec: 60, timeoutMs: 5000 } },
      { assetId: "h1", check: { intervalSec: 300, timeoutMs: 8000 } },
      { assetId: "h2", check: { intervalSec: 60, timeoutMs: 5000 } },
    ]);
    const out = await resolveScopeCadence({} as never, "pathLatencyMs");
    expect(out).toEqual({ stream: "pathCheck", mode: 60, min: 60, max: 300, timeoutMs: 5000, assetCount: 2 });
    expect(prisma.pathCheckSource.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { assetId: { in: ["h1", "h2", "h3"] }, check: { enabled: true } },
    }));
    expect(mocks.resolveMonitorSettings).not.toHaveBeenCalled();
  });

  it("answers zeros for a path metric when no scoped host runs a check", async () => {
    mocks.loadScopeAssetIds.mockResolvedValue(["h1"]);
    stubbed(prisma.pathCheckSource.findMany).mockResolvedValue([]);
    expect(await resolveScopeCadence({} as never, "pathOk")).toEqual({ stream: "pathCheck", mode: 0, min: 0, max: 0, timeoutMs: 0, assetCount: 0 });
  });
});

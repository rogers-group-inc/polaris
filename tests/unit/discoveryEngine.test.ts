/**
 * tests/unit/discoveryEngine.test.ts — the run-control and source-row entry
 * points of src/services/discovery/discoveryEngine.ts (CQ-T010: one own file
 * per service).
 *
 * Complements, does not repeat:
 *   - the sync passes (syncDhcpSubnets and its extracted phases, syncEntraDevices,
 *     syncActiveDirectoryDevices, syncVcenterDevices, syncArcDevices) — the
 *     dhcpPhasesExtracted* suites and ~25 integration tests;
 *   - the phase gates (vcenterPassEnabled, sweepPhaseEnabled, …) — syncSweepPhaseGate;
 *   - buildWarmCacheKeyMap — fmgWarmCacheKeying; AssetIndex / hostname index —
 *     their own suites; triggerDiscovery's refusals — integration/triggerDiscoveryRefusals;
 *   - the Arc sweep against a real DB — integration/arcAbsenceSweep (toggle off,
 *     unread subscription, blocked reads, another owner, no-op);
 *   - upsertFortinetInfraAssetSource's osVersion carry-forward against a real DB —
 *     integration/infraSourcePriorObserved.
 *
 * What this adds — exports nothing ran the body of, and branches the above miss:
 *   - expireVerboseLogging: the 30-minute window, legacy rows with no stamp left
 *     alone, the stamp removed and the rest of the config kept;
 *   - checkForSlowRuns: integration-level and per-FortiGate slow Events, the
 *     dedup flags persisted only on change, queued rows skipped, the baseline
 *     read failing quietly, the auto-abort ceiling (abort / granted exemption /
 *     silent exemption) and its carve-outs (scoped run, cancel already pending);
 *   - runPreflightTest / isDiscoveryRunning / hasActiveDiscoveries: the dispatch;
 *   - triggerDiscovery: the coalesce (a re-trigger while active returns false
 *     and resets nothing), the queued row's scope label, the pg-boss hand-off;
 *   - upsertFortigateFirewallAssetSource: an OFFLINE (cached-CMDB) cycle never
 *     advances lastSeen, the phantom `manual` row is swept;
 *   - upsertFortinetInfraAssetSource: the priorObserved fast path skips the read,
 *     a present osVersion never reads, integrationName stamped;
 *   - knownEthernetMacsFromIntuneRows: keys lower-cased, non-string fields → null;
 *   - sweepArcAbsence: the scale guard (rule 70 / 35(c)), an unread cluster table
 *     keeping an asset alive, the azure: tag strip, and a failing clean-up hook
 *     logged rather than aborting the decommission.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  listActiveRuns: vi.fn(),
  persistSlowFlags: vi.fn(),
  requestCancel: vi.fn(),
  isRunActive: vi.fn(),
  anyRunActive: vi.fn(),
  upsertQueuedRun: vi.fn(),
  getBaselines: vi.fn(),
  evaluateAutoAbort: vi.fn(),
  publishDiscoveryJob: vi.fn(),
  integrationAdapter: vi.fn(),
  releaseAssetsForDecommission: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/discoveryRunState.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listActiveRuns: h.listActiveRuns,
  persistSlowFlags: h.persistSlowFlags,
  requestCancel: h.requestCancel,
  isRunActive: h.isRunActive,
  anyRunActive: h.anyRunActive,
  upsertQueuedRun: h.upsertQueuedRun,
}));
vi.mock("../../src/services/discoveryDurationService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getBaselines: h.getBaselines,
}));
vi.mock("../../src/services/discoveryAutoAbortService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  evaluateAutoAbort: h.evaluateAutoAbort,
}));
vi.mock("../../src/services/queueService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  publishDiscoveryJob: h.publishDiscoveryJob,
}));
vi.mock("../../src/services/integrationAdapters.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  integrationAdapter: h.integrationAdapter,
}));
vi.mock("../../src/services/maintenanceScheduleService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  releaseAssetsForDecommission: h.releaseAssetsForDecommission,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  expireVerboseLogging,
  checkForSlowRuns,
  runPreflightTest,
  isDiscoveryRunning,
  hasActiveDiscoveries,
  triggerDiscovery,
  upsertFortigateFirewallAssetSource,
  upsertFortinetInfraAssetSource,
  knownEthernetMacsFromIntuneRows,
  sweepArcAbsence,
} from "../../src/services/discovery/discoveryEngine.js";
import type { ArcDiscoveryResult } from "../../src/services/azureArcService.js";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const MIN = 60_000;

/** Every logEvent input, by action. */
const events = (action?: string) =>
  eventLog.logEvent.mock.calls.map((c) => c[0]).filter((e) => !action || e.action === action);

beforeEach(async () => {
  resetDbStub();
  resetEventLogStub();
  for (const f of Object.values(h)) f.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const real = await vi.importActual<typeof import("../../src/services/integrationAdapters.js")>("../../src/services/integrationAdapters.js");
  h.integrationAdapter.mockImplementation(real.integrationAdapter);
  h.releaseAssetsForDecommission.mockResolvedValue([]);
  h.persistSlowFlags.mockResolvedValue(undefined);
  h.requestCancel.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── expireVerboseLogging ──────────────────────────────────────────────────

describe("expireVerboseLogging", () => {
  it("switches verbose logging off once its 30-minute window has passed, keeping the rest of the config", async () => {
    vi.mocked(prisma.integration.findMany).mockResolvedValue([
      { id: "old", name: "FMG", config: { host: "h", verboseLogging: true, verboseLoggingEnabledAt: new Date(NOW.getTime() - 31 * MIN).toISOString() } },
      { id: "fresh", name: "FG", config: { verboseLogging: true, verboseLoggingEnabledAt: new Date(NOW.getTime() - 29 * MIN).toISOString() } },
      { id: "legacy", name: "AD", config: { verboseLogging: true } },
      { id: "off", name: "VC", config: { verboseLogging: false, verboseLoggingEnabledAt: "2020-01-01T00:00:00.000Z" } },
    ] as never);
    await expireVerboseLogging();
    expect(prisma.integration.update).toHaveBeenCalledTimes(1);
    expect(prisma.integration.update).toHaveBeenCalledWith({ where: { id: "old" }, data: { config: { host: "h", verboseLogging: false } } });
  });

  it("exactly at the 30-minute boundary the window has expired", async () => {
    vi.mocked(prisma.integration.findMany).mockResolvedValue([
      { id: "edge", name: "FMG", config: { verboseLogging: true, verboseLoggingEnabledAt: new Date(NOW.getTime() - 30 * MIN).toISOString() } },
    ] as never);
    await expireVerboseLogging();
    expect(prisma.integration.update).toHaveBeenCalledTimes(1);
  });
});

// ─── checkForSlowRuns ──────────────────────────────────────────────────────

describe("checkForSlowRuns", () => {
  const baseline = (avgMs: number, over: Record<string, number> = {}) => ({
    sampleCount: 12, avgMs, stddevMs: avgMs / 10, thresholdMs: avgMs * 1.5, autoAbortMs: avgMs * 2, ...over,
  });
  const run = (over: Record<string, unknown> = {}) => ({
    integrationId: "i1", integrationName: "FMG-1", type: "fortigate", status: "running",
    startedAt: new Date(NOW.getTime() - 10 * MIN), cancelRequested: false, scopeDeviceName: null,
    slowAlerted: false, slowAlertedDevices: [], activeDevices: [], ...over,
  });

  it("nothing in flight reads no baselines", async () => {
    h.listActiveRuns.mockResolvedValue([]);
    await checkForSlowRuns();
    expect(h.getBaselines).not.toHaveBeenCalled();
  });

  it("a run past its threshold gets ONE integration-level slow Event and the flag is persisted", async () => {
    h.listActiveRuns.mockResolvedValue([run()]);
    h.getBaselines.mockResolvedValue(new Map([["i1", baseline(5 * MIN, { autoAbortMs: 60 * MIN })]]));
    await checkForSlowRuns();
    const slow = events("integration.discover.slow");
    expect(slow).toHaveLength(1);
    expect(slow[0]).toMatchObject({ resourceId: "i1", level: "warning", details: { scope: "integration", elapsedMs: 10 * MIN, sampleCount: 12 } });
    expect(slow[0].message).toBe('Discovery for "FMG-1" is running longer than normal — 600s elapsed vs typical 300s (threshold 450s, 12 samples)');
    expect(h.persistSlowFlags).toHaveBeenCalledWith("i1", true, []);
  });

  it("an already-flagged run is not re-announced and nothing is persisted", async () => {
    h.listActiveRuns.mockResolvedValue([run({ slowAlerted: true })]);
    h.getBaselines.mockResolvedValue(new Map([["i1", baseline(5 * MIN, { autoAbortMs: 60 * MIN })]]));
    await checkForSlowRuns();
    expect(events()).toHaveLength(0);
    expect(h.persistSlowFlags).not.toHaveBeenCalled();
  });

  it("a queued row (no startedAt) is never charged its queue time", async () => {
    h.listActiveRuns.mockResolvedValue([run({ startedAt: null, status: "queued" })]);
    h.getBaselines.mockResolvedValue(new Map([["i1", baseline(1000)]]));
    await checkForSlowRuns();
    expect(events()).toHaveLength(0);
    expect(h.evaluateAutoAbort).not.toHaveBeenCalled();
  });

  it("a failing baseline read is swallowed", async () => {
    h.listActiveRuns.mockResolvedValue([run()]);
    h.getBaselines.mockRejectedValue(new Error("settings row locked"));
    await expect(checkForSlowRuns()).resolves.toBeUndefined();
    expect(events()).toHaveLength(0);
  });

  it("FortiManager: each slow FortiGate gets its own Event; an already-flagged gate is not even looked up", async () => {
    h.listActiveRuns.mockResolvedValue([run({
      type: "fortimanager",
      slowAlerted: true,
      slowAlertedDevices: ["FGT-OLD"],
      activeDevices: [
        { name: "FGT-SLOW", startedAt: NOW.getTime() - 8_500 },
        { name: "FGT-OK", startedAt: NOW.getTime() - 1_000 },
        { name: "FGT-OLD", startedAt: NOW.getTime() - 60 * MIN },
      ],
    })]);
    h.getBaselines.mockResolvedValue(new Map([
      ["i1", baseline(30 * MIN)],
      ["i1:FGT-SLOW", baseline(4000)],
      ["i1:FGT-OK", baseline(4000)],
    ]));
    await checkForSlowRuns();
    expect(h.getBaselines.mock.calls[0][0]).toEqual(["i1", "i1:FGT-SLOW", "i1:FGT-OK"]);
    const slow = events("integration.discover.slow");
    expect(slow).toHaveLength(1);
    expect(slow[0].details).toMatchObject({ scope: "fortigate", device: "FGT-SLOW" });
    // Sub-10s durations carry one decimal.
    expect(slow[0].message).toBe('Discovery on FortiGate "FGT-SLOW" via "FMG-1" is running longer than normal — 8.5s elapsed vs typical 4.0s (threshold 6.0s, 12 samples)');
    expect(h.persistSlowFlags).toHaveBeenCalledWith("i1", true, ["FGT-OLD", "FGT-SLOW"]);
  });

  it("past the auto-abort ceiling the run is cancelled and the Event names the slow and running gates", async () => {
    h.listActiveRuns.mockResolvedValue([run({
      type: "fortimanager", slowAlerted: true, slowAlertedDevices: ["FGT-B"],
      activeDevices: [{ name: "FGT-A", startedAt: NOW.getTime() - 2 * MIN }],
    })]);
    h.getBaselines.mockResolvedValue(new Map([["i1", baseline(4 * MIN)]]));
    h.evaluateAutoAbort.mockResolvedValue({ action: "abort" });
    await checkForSlowRuns();
    expect(h.evaluateAutoAbort).toHaveBeenCalledWith("i1", new Date(NOW.getTime() - 10 * MIN).toISOString());
    expect(h.requestCancel).toHaveBeenCalledWith("i1");
    const ab = events("integration.discover.auto_aborted");
    expect(ab).toHaveLength(1);
    expect(ab[0].message).toBe('Auto-aborting discovery for "FMG-1" — 600s elapsed vs typical 240s (auto-abort threshold 480s). Slow-flagged FortiGates: FGT-B. Still running: FGT-A (120s).');
    expect(ab[0].details).toMatchObject({ autoAbortMs: 8 * MIN, activeDevices: [{ name: "FGT-A", elapsedMs: 2 * MIN }], slowDevices: ["FGT-B"] });
  });

  it("an exemption is announced once when granted and is silent afterwards; neither cancels", async () => {
    h.listActiveRuns.mockResolvedValue([run({ slowAlerted: true })]);
    h.getBaselines.mockResolvedValue(new Map([["i1", baseline(4 * MIN)]]));
    h.evaluateAutoAbort.mockResolvedValueOnce({ action: "exempt", granted: true });
    await checkForSlowRuns();
    expect(events("integration.discover.auto_abort_skipped")).toHaveLength(1);
    h.evaluateAutoAbort.mockResolvedValueOnce({ action: "exempt", granted: false });
    await checkForSlowRuns();
    expect(events("integration.discover.auto_abort_skipped")).toHaveLength(1);
    expect(h.requestCancel).not.toHaveBeenCalled();
  });

  it("a failing auto-abort decision read neither cancels nor throws", async () => {
    h.listActiveRuns.mockResolvedValue([run({ slowAlerted: true })]);
    h.getBaselines.mockResolvedValue(new Map([["i1", baseline(4 * MIN)]]));
    h.evaluateAutoAbort.mockRejectedValue(new Error("x"));
    await checkForSlowRuns();
    expect(h.requestCancel).not.toHaveBeenCalled();
  });

  it("a scoped single-device run, a run with a cancel pending, and a queued run are never auto-aborted", async () => {
    h.listActiveRuns.mockResolvedValue([
      run({ slowAlerted: true, scopeDeviceName: "FGT-A" }),
      run({ integrationId: "i2", slowAlerted: true, cancelRequested: true }),
      run({ integrationId: "i3", slowAlerted: true, status: "queued" }),
    ]);
    h.getBaselines.mockResolvedValue(new Map([["i1", baseline(MIN)], ["i2", baseline(MIN)], ["i3", baseline(MIN)]]));
    await checkForSlowRuns();
    expect(h.evaluateAutoAbort).not.toHaveBeenCalled();
    expect(h.requestCancel).not.toHaveBeenCalled();
  });
});

// ─── dispatch helpers ──────────────────────────────────────────────────────

describe("runPreflightTest / isDiscoveryRunning / hasActiveDiscoveries", () => {
  it("an unknown type answers without dispatching", async () => {
    expect(await runPreflightTest({ id: "i1", type: "netbox", config: {} })).toEqual({ ok: false, message: "Unknown integration type: netbox" });
  });

  it("a known type dispatches to its adapter's testConnection with the stored config and id", async () => {
    const testConnection = vi.fn(async () => ({ ok: true, message: "Connected", version: "7.4" }));
    h.integrationAdapter.mockReturnValue({ testConnection });
    const config = { host: "fmg" };
    expect(await runPreflightTest({ id: "i1", type: "fortimanager", config })).toEqual({ ok: true, message: "Connected", version: "7.4" });
    expect(testConnection).toHaveBeenCalledWith(config, "i1");
  });

  it("the run-state questions are answered by the DiscoveryRun table", async () => {
    h.isRunActive.mockResolvedValue(true);
    h.anyRunActive.mockResolvedValue(false);
    expect(await isDiscoveryRunning("i1")).toBe(true);
    expect(h.isRunActive).toHaveBeenCalledWith("i1");
    expect(await hasActiveDiscoveries()).toBe(false);
  });
});

// ─── triggerDiscovery ──────────────────────────────────────────────────────

describe("triggerDiscovery", () => {
  const fg = { id: "i1", name: "Branch FG", type: "fortigate", config: { host: "10.0.0.1", apiToken: "t" } };

  it("a re-trigger while a run is active returns false and leaves the in-flight row alone", async () => {
    vi.mocked(prisma.integration.findUnique).mockResolvedValue(fg as never);
    h.isRunActive.mockResolvedValue(true);
    expect(await triggerDiscovery("i1", "alice")).toBe(false);
    expect(h.upsertQueuedRun).not.toHaveBeenCalled();
    expect(h.publishDiscoveryJob).not.toHaveBeenCalled();
  });

  it("queues the run row with a scope label and hands the scope to the discovery worker", async () => {
    vi.mocked(prisma.integration.findUnique).mockResolvedValue({ ...fg, type: "fortimanager", name: "FMG" } as never);
    h.isRunActive.mockResolvedValue(false);
    h.publishDiscoveryJob.mockResolvedValue(true);
    const scope = { kind: "fmg-device" as const, deviceName: "FGT-A" };
    expect(await triggerDiscovery("i1", "alice", { scope })).toBe(true);
    expect(h.upsertQueuedRun).toHaveBeenCalledWith({ integrationId: "i1", integrationName: "FMG", type: "fortimanager", actor: "alice", scopeDeviceName: "FGT-A" });
    expect(h.publishDiscoveryJob).toHaveBeenCalledWith("i1", "alice", scope);
  });

  it("a caller-supplied display name labels the run instead of the raw scope key", async () => {
    vi.mocked(prisma.integration.findUnique).mockResolvedValue({ id: "i1", name: "Entra", type: "entraid", config: { tenantId: "t", clientId: "c", clientSecret: "s" } } as never);
    h.isRunActive.mockResolvedValue(false);
    h.publishDiscoveryJob.mockResolvedValue(true);
    await triggerDiscovery("i1", "alice", { scope: { kind: "entra-device", deviceId: "0f1e-guid" }, scopeLabel: "  LAPTOP-42 " });
    expect(h.upsertQueuedRun.mock.calls[0][0].scopeDeviceName).toBe("LAPTOP-42");
  });

  it("an unscoped run carries no scope label", async () => {
    vi.mocked(prisma.integration.findUnique).mockResolvedValue(fg as never);
    h.isRunActive.mockResolvedValue(false);
    h.publishDiscoveryJob.mockResolvedValue(true);
    await triggerDiscovery("i1", "auto-discovery");
    expect(h.upsertQueuedRun.mock.calls[0][0].scopeDeviceName).toBeUndefined();
    expect(h.publishDiscoveryJob).toHaveBeenCalledWith("i1", "auto-discovery", undefined);
  });

  it("missing config is refused before the run-state check", async () => {
    vi.mocked(prisma.integration.findUnique).mockResolvedValue({ ...fg, config: { host: "10.0.0.1" } } as never);
    await expect(triggerDiscovery("i1", "alice")).rejects.toMatchObject({ httpStatus: 400 });
    expect(h.isRunActive).not.toHaveBeenCalled();
  });
});

// ─── AssetSource upserts ───────────────────────────────────────────────────

describe("upsertFortigateFirewallAssetSource", () => {
  const synced = new Date(NOW.getTime() - 1000);

  it("a live cycle stamps lastSeen on create and update and sweeps the phantom manual row", async () => {
    await upsertFortigateFirewallAssetSource("a1", "i1", "FGT60F001", { hostname: "fw" }, synced, NOW);
    const arg = vi.mocked(prisma.assetSource.upsert).mock.calls[0][0] as any;
    expect(arg.where).toEqual({ sourceKind_externalId: { sourceKind: "fortigate-firewall", externalId: "FGT60F001" } });
    expect(arg.create).toMatchObject({ assetId: "a1", integrationId: "i1", inferred: false, syncedAt: synced, firstSeen: NOW, lastSeen: NOW });
    expect(arg.update).toMatchObject({ assetId: "a1", syncedAt: synced, lastSeen: NOW });
    expect(prisma.assetSource.deleteMany).toHaveBeenCalledWith({ where: { assetId: "a1", sourceKind: "manual", externalId: "a1" } });
  });

  it("an OFFLINE (cached-CMDB) cycle refreshes the row but never advances lastSeen", async () => {
    await upsertFortigateFirewallAssetSource("a1", "i1", "FGT60F001", {}, synced, null);
    const arg = vi.mocked(prisma.assetSource.upsert).mock.calls[0][0] as any;
    expect(arg.update).not.toHaveProperty("lastSeen");
    expect(arg.update.syncedAt).toBe(synced);
    // A first sighting while offline must still satisfy the non-null columns.
    expect(arg.create).toMatchObject({ firstSeen: synced, lastSeen: synced });
  });
});

describe("upsertFortinetInfraAssetSource", () => {
  it("a present osVersion never reads the prior row; integrationName is stamped (null when absent)", async () => {
    const observed: Record<string, unknown> = { osVersion: "FP231F-v7.4.5-build0734" };
    await upsertFortinetInfraAssetSource("fortiap", "a1", "i1", "FP231F001", observed, NOW, NOW);
    expect(prisma.assetSource.findUnique).not.toHaveBeenCalled();
    expect(observed.integrationName).toBeNull();
    const arg = vi.mocked(prisma.assetSource.upsert).mock.calls[0][0] as any;
    expect(arg.where).toEqual({ sourceKind_externalId: { sourceKind: "fortiap", externalId: "FP231F001" } });
    expect(arg.create).toMatchObject({ firstSeen: NOW, lastSeen: NOW });
    expect(prisma.assetSource.deleteMany).toHaveBeenCalledWith({ where: { assetId: "a1", sourceKind: "manual", externalId: "a1" } });
  });

  it("an absent osVersion is carried from the supplied prior blob without a read", async () => {
    const observed: Record<string, unknown> = { osVersion: "" };
    await upsertFortinetInfraAssetSource("fortiswitch", "a1", "i1", "S148F001", observed, NOW, NOW, "FMG-1", { osVersion: "S148F-v7.4.3" });
    expect(prisma.assetSource.findUnique).not.toHaveBeenCalled();
    expect(observed).toMatchObject({ osVersion: "S148F-v7.4.3", integrationName: "FMG-1" });
  });

  it("priorObserved null means 'no such row': nothing is read and nothing is carried", async () => {
    const observed: Record<string, unknown> = {};
    await upsertFortinetInfraAssetSource("fortiswitch", "a1", "i1", "S148F001", observed, NOW, NOW, "FMG-1", null);
    expect(prisma.assetSource.findUnique).not.toHaveBeenCalled();
    expect(observed.osVersion).toBeUndefined();
  });

  it("not supplied: reads the row once and ignores a non-string prior version", async () => {
    vi.mocked(prisma.assetSource.findUnique).mockResolvedValue({ observed: { osVersion: 7 } } as never);
    const observed: Record<string, unknown> = {};
    await upsertFortinetInfraAssetSource("fortiap", "a1", "i1", "FP001", observed, NOW, NOW);
    expect(prisma.assetSource.findUnique).toHaveBeenCalledTimes(1);
    expect(observed.osVersion).toBeUndefined();
  });
});

describe("knownEthernetMacsFromIntuneRows", () => {
  it("keys by lower-cased device id and keeps only string fields", () => {
    const out = knownEthernetMacsFromIntuneRows([
      { externalId: "ABC-123", observed: { ethernetMacAddress: "001122334455", ethernetMacSyncedAt: "2026-06-01T00:00:00Z" } },
      { externalId: "def-456", observed: { ethernetMacAddress: 12, ethernetMacSyncedAt: null } },
      { externalId: "ghi", observed: null },
    ]);
    expect([...out.keys()]).toEqual(["abc-123", "def-456", "ghi"]);
    expect(out.get("abc-123")).toEqual({ ethernetMacAddress: "001122334455", ethernetMacSyncedAt: "2026-06-01T00:00:00Z" });
    expect(out.get("def-456")).toEqual({ ethernetMacAddress: null, ethernetMacSyncedAt: null });
    expect(out.get("ghi")).toEqual({ ethernetMacAddress: null, ethernetMacSyncedAt: null });
  });
});

// ─── sweepArcAbsence ───────────────────────────────────────────────────────

describe("sweepArcAbsence", () => {
  const machine = (n: number | string) => `/subscriptions/sub1/resourceGroups/rg/providers/Microsoft.HybridCompute/machines/m${n}`;
  const cluster = (n: number | string) => `/subscriptions/sub1/resourceGroups/rg/providers/Microsoft.Kubernetes/connectedClusters/k${n}`;
  const result = (machineIds: string[], clusterIds: string[] | null): ArcDiscoveryResult => ({
    machines: [], clusters: [],
    absence: { machineIds, clusterIds, subscriptionsRead: ["sub1"], complete: true, scoped: false },
  } as unknown as ArcDiscoveryResult);
  const on = { decommissionMissing: true };
  const syncLines = () => events("integration.sync").map((e) => `${e.level}: ${e.message}`);

  it("the scale guard: too many vanished rows reads as a broken read and touches nothing", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, assetId: `a${i}`, sourceKind: "arc", externalId: machine(i) }));
    vi.mocked(prisma.assetSource.findMany).mockResolvedValue(rows as never);
    // 55 of 60 gone > max(50, 20% of 60)
    const out = await sweepArcAbsence("i1", "Arc", on, result([0, 1, 2, 3, 4].map(machine), null));
    expect(out).toEqual([]);
    expect(prisma.assetSource.deleteMany).not.toHaveBeenCalled();
    expect(syncLines().some((l) => l.startsWith("warning: [Arc] Disappearance sweep skipped — 55 of 60 Azure Arc source row(s) vanished"))).toBe(true);
  });

  it("an asset whose cluster table was not read stays alive although its machine row is swept", async () => {
    vi.mocked(prisma.assetSource.findMany).mockResolvedValue([
      { id: "s1", assetId: "a1", sourceKind: "arc", externalId: machine(1) },
      { id: "s2", assetId: "a1", sourceKind: "arc-k8s", externalId: cluster(1) },
    ] as never);
    vi.mocked(prisma.asset.findMany).mockResolvedValue([] as never);
    const out = await sweepArcAbsence("i1", "Arc", on, result([machine(2)], null));
    expect(out).toEqual([]);
    expect(prisma.assetSource.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["s1"] } } });
    expect(prisma.asset.updateMany).not.toHaveBeenCalled();
  });

  it("strips azure: tags from an asset left with no Arc row, then decommissions what this integration manages", async () => {
    vi.mocked(prisma.assetSource.findMany).mockResolvedValue([
      { id: "s1", assetId: "a1", sourceKind: "arc", externalId: machine(1) },
      { id: "s2", assetId: "a2", sourceKind: "arc", externalId: machine(2) },
    ] as never);
    vi.mocked(prisma.asset.findMany)
      .mockResolvedValueOnce([{ id: "a1", tags: ["azure:env:prod", "site:hq", "AZURE:owner:ops"] }] as never) // onRowsGone
      .mockResolvedValueOnce([{ id: "a1", hostname: "srv1", ipAddress: null, discoveredByIntegrationId: "i1" }] as never);
    vi.mocked(prisma.asset.update).mockResolvedValue({} as never);
    const out = await sweepArcAbsence("i1", "Arc", on, result([machine(2)], null), "alice");
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { tags: ["site:hq"] } });
    expect(out).toEqual(["srv1"]);
    expect(h.releaseAssetsForDecommission).toHaveBeenCalledWith(["a1"], { at: NOW, actor: "alice", statusChangedBy: "Arc", reason: 'no longer present in "Arc"' });
    expect(prisma.asset.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["a1"] } }, data: { status: "decommissioned", statusChangedAt: NOW, statusChangedBy: "Arc" } });
    const batch = eventLog.logEventsBatch.mock.calls[0][0];
    expect(batch).toEqual([expect.objectContaining({ action: "asset.arc.decommissioned", resourceId: "a1", details: expect.objectContaining({ reason: "missing-from-directory" }) })]);
  });

  it("a failing tag clean-up is logged as a warning and does not stop the decommission", async () => {
    vi.mocked(prisma.assetSource.findMany).mockResolvedValue([
      { id: "s1", assetId: "a1", sourceKind: "arc", externalId: machine(1) },
    ] as never);
    vi.mocked(prisma.asset.findMany)
      .mockRejectedValueOnce(new Error("statement timeout"))
      .mockResolvedValueOnce([{ id: "a1", hostname: null, ipAddress: "10.0.0.9", discoveredByIntegrationId: null }] as never);
    // Fleet of one, one gone: inside the scale guard's floor of 50.
    const out = await sweepArcAbsence("i1", "Arc", on, result([machine(9)], null));
    expect(out).toEqual(["10.0.0.9"]);
    expect(syncLines()).toContain("warning: [Arc] Azure Arc: clean-up after the swept source rows failed — statement timeout");
  });
});

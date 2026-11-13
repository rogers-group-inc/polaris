/**
 * tests/unit/monitoringService.test.ts — the per-asset cadence runners of
 * src/services/monitoringService.ts (CQ-T010: one own file per service).
 *
 * Complements, does not repeat:
 *   - recordProbeResult's state machine — probeCadence, notificationMaintenanceSuppression,
 *     monitorStatus / failure-bucket suites and the integration tests;
 *   - the due-set builders (computeDueWork / resolveDueCadences / loadMonitorPassCandidates)
 *     — tests/integration/computeDueWork.test.ts, probeCadence.test.ts;
 *   - sdwanShouldQueue — sdwanCadence.test.ts; readWidgetOid — widgetRowSymbol.test.ts;
 *     customWidgetIntervalSec — customWidgetEnablement.test.ts;
 *   - queueService.test.ts, which only MOCKS every run*For.
 *
 * What this adds — every runner below had no test that ran its body:
 *   - lldpPollingCollects, passSweepIntervalSec (the sweep floor under the
 *     configured interval);
 *   - runProbeBatchFor: the pickup re-check (unmonitored / already polled since
 *     publication), the "never attempted is not a miss" rule, the sample stamped
 *     at the instant the echoes went out, one asset's failed write not
 *     abandoning the chunk, per-attempt probe metrics;
 *   - runProbeFor: duplicate / skipped / success / failure / crash outcomes;
 *   - runTelemetryFor: a thrown collector packaged as a failed stream;
 *   - runCustomWidgetsFor: attempt stamped first (rule 118), rule 130's model gate
 *     incl. an RE2-refused pattern matching nothing (rule 116);
 *   - runSystemInfoFor / runFastFilteredFor: supported / data / failure mapping;
 *   - runLldpFor + runStorageFor: rule 118(a) attempt stamps, transport choice,
 *     collectStorageOnlySnmp's disk-row filter / allocation units / vendor fallback,
 *     pinned mounts written "fast", the rest "slow";
 *   - runEventLogFor: master switch before any write, anchor stamped on every
 *     exit, the 1.5x-interval collection window and the 30 s timeout floor;
 *   - runSdwanFor: pickup re-check, stamp-even-on-failure, rules full-replace only
 *     when the CMDB read succeeded;
 *   - runProcessesFor: sub-pass due logic, per-sub-pass anchors, the credential
 *     chain down to the AD bind fallback (and its override carve-out);
 *   - runLossSweepFor: shared address pinged once and fanned out, never-attempted
 *     targets write nothing, rule 38b / 29h markers, NULL response time, one
 *     updateMany for the anchors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  startWorkTimer: vi.fn(),
  recordWorkOutcome: vi.fn(),
  recordProbe: vi.fn(),
  probeAsset: vi.fn(),
  loadTelemetryAsset: vi.fn(),
  collectTelemetry: vi.fn(),
  collectHardwareSensors: vi.fn(),
  collectFastFiltered: vi.fn(),
  recordFastFilteredResult: vi.fn(),
  collectSystemInfo: vi.fn(),
  recordTelemetryResult: vi.fn(),
  recordHardwareSensorResult: vi.fn(),
  recordSystemInfoResult: vi.fn(),
  persistPerfSlaSampleStream: vi.fn(),
  persistSdwanRules: vi.fn(),
  persistAssetProcesses: vi.fn(),
  resolveMonitorSettings: vi.fn(),
  resolveSnmpConfigForStream: vi.fn(),
  resolveAgentlessCredConfig: vi.fn(),
  loadClassOverrideStreamCredential: vi.fn(),
  resolveSdwanIntervalSec: vi.fn(),
  collectLldpOnlySnmp: vi.fn(),
  collectVendorDiskFallback: vi.fn(),
  withSnmpSession: vi.fn(),
  snmpWalk: vi.fn(),
  collectLldpOnlyFortinet: vi.fn(),
  collectSdwanFortinet: vi.fn(),
  persistLldpNeighbors: vi.fn(),
  persistProcessConnections: vi.fn(),
  collectProcessesSsh: vi.fn(),
  collectProcessesWinrm: vi.fn(),
  collectHostSsh: vi.fn(),
  collectHostWinrm: vi.fn(),
  collectEventLogSsh: vi.fn(),
  collectEventLogWinrm: vi.fn(),
  ingestOsEventLog: vi.fn(),
  getAgentEventLogConfig: vi.fn(),
  enqueueMonitorSample: vi.fn(),
  enqueueStorageSamples: vi.fn(),
  enqueueProcessSamples: vi.fn(),
  enqueueProbePatch: vi.fn(),
  getPendingProbePatch: vi.fn(),
  burstPing: vi.fn(),
  pingTargets: vi.fn(),
  detectFping: vi.fn(),
  enabledWidgetIdsForAsset: vi.fn(),
  widgetProfileForAsset: vi.fn(),
  collectGenericApiWidgetSamples: vi.fn(),
  resolveDownDetection: vi.fn(),
  pickDbProfile: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/metrics.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  startWorkTimer: m.startWorkTimer,
  recordWorkOutcome: m.recordWorkOutcome,
  recordProbe: m.recordProbe,
  startSampleWriteTimer: () => () => undefined,
}));
vi.mock("../../src/services/monitoring/probes.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()), probeAsset: m.probeAsset,
}));
vi.mock("../../src/services/monitoring/streamCollection.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadTelemetryAsset: m.loadTelemetryAsset,
  collectTelemetry: m.collectTelemetry,
  collectHardwareSensors: m.collectHardwareSensors,
  collectFastFiltered: m.collectFastFiltered,
  recordFastFilteredResult: m.recordFastFilteredResult,
  collectSystemInfo: m.collectSystemInfo,
}));
vi.mock("../../src/services/monitoring/pollStamps.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  recordTelemetryResult: m.recordTelemetryResult,
  recordHardwareSensorResult: m.recordHardwareSensorResult,
}));
vi.mock("../../src/services/monitoring/systemInfoPersist.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  recordSystemInfoResult: m.recordSystemInfoResult,
  persistPerfSlaSampleStream: m.persistPerfSlaSampleStream,
  persistSdwanRules: m.persistSdwanRules,
  persistAssetProcesses: m.persistAssetProcesses,
}));
vi.mock("../../src/services/monitoring/monitorSettings.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveMonitorSettings: m.resolveMonitorSettings,
  resolveSnmpConfigForStream: m.resolveSnmpConfigForStream,
  resolveAgentlessCredConfig: m.resolveAgentlessCredConfig,
  loadClassOverrideStreamCredential: m.loadClassOverrideStreamCredential,
  resolveSdwanIntervalSec: m.resolveSdwanIntervalSec,
}));
vi.mock("../../src/services/monitoring/snmpCollectors.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  collectLldpOnlySnmp: m.collectLldpOnlySnmp,
  collectVendorDiskFallback: m.collectVendorDiskFallback,
}));
vi.mock("../../src/services/monitoring/snmpCore.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  withSnmpSession: m.withSnmpSession,
  snmpWalk: m.snmpWalk,
}));
vi.mock("../../src/services/monitoring/fortiosCollectors.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  collectLldpOnlyFortinet: m.collectLldpOnlyFortinet,
  collectSdwanFortinet: m.collectSdwanFortinet,
}));
vi.mock("../../src/services/monitoring/neighborPersistence.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  persistLldpNeighbors: m.persistLldpNeighbors,
  persistProcessConnections: m.persistProcessConnections,
}));
vi.mock("../../src/services/agentlessProcessService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  collectProcessesSsh: m.collectProcessesSsh,
  collectProcessesWinrm: m.collectProcessesWinrm,
}));
vi.mock("../../src/services/agentlessHostService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  collectHostSsh: m.collectHostSsh,
  collectHostWinrm: m.collectHostWinrm,
  collectEventLogSsh: m.collectEventLogSsh,
  collectEventLogWinrm: m.collectEventLogWinrm,
}));
vi.mock("../../src/services/osEventLogService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ingestOsEventLog: m.ingestOsEventLog,
  getAgentEventLogConfig: m.getAgentEventLogConfig,
}));
vi.mock("../../src/services/sampleWriteBuffer.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  enqueueMonitorSample: m.enqueueMonitorSample,
  enqueueStorageSamples: m.enqueueStorageSamples,
  enqueueProcessSamples: m.enqueueProcessSamples,
}));
vi.mock("../../src/services/probePatchBuffer.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  enqueueProbePatch: m.enqueueProbePatch,
  getPendingProbePatch: m.getPendingProbePatch,
}));
vi.mock("../../src/utils/burstPing.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  burstPing: m.burstPing,
  pingTargets: m.pingTargets,
  detectFping: m.detectFping,
}));
vi.mock("../../src/services/customWidgetEnablementService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  enabledWidgetIdsForAsset: m.enabledWidgetIdsForAsset,
  widgetProfileForAsset: m.widgetProfileForAsset,
}));
vi.mock("../../src/services/genericApiMonitorService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  collectGenericApiWidgetSamples: m.collectGenericApiWidgetSamples,
}));
vi.mock("../../src/services/downDetectionService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveDownDetection: m.resolveDownDetection,
}));
vi.mock("../../src/services/profileResolver.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  pickDbProfile: m.pickDbProfile,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { resetEventLogStub } from "./_eventLogStub.js";
import { OID } from "../../src/services/monitoring/snmpCore.js";
import { suggestedSweepIntervalSec } from "../../src/utils/burstPing.js";
import {
  lldpPollingCollects,
  passSweepIntervalSec,
  runProbeBatchFor,
  runProbeFor,
  runTelemetryFor,
  runCustomWidgetsFor,
  runSystemInfoFor,
  runFastFilteredFor,
  runLldpFor,
  runStorageFor,
  runEventLogFor,
  runSdwanFor,
  runProcessesFor,
  runLossSweepFor,
  resolveSdwanPollIntervalForAsset,
  type WorkItemLabels,
} from "../../src/services/monitoringService.js";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const labels: WorkItemLabels = { transport: "icmp", assetType: "server" };

/** The resolved settings a test runs under; reset each test, tweaked per case. */
let settings: Record<string, unknown>;

const asset = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  hostname: "host-1",
  dnsName: null,
  assetType: "server",
  monitored: true,
  status: "active",
  ipAddress: "10.0.0.5",
  ipv6Address: null,
  ipOverride: null,
  hostnameOverride: null,
  manufacturer: null,
  model: null,
  monitorCredential: null,
  interfacesCredential: null,
  lldpCredential: null,
  eventLogCredential: null,
  processesCredential: null,
  discoveredByIntegration: null,
  discoveredByIntegrationId: null,
  monitoredStorage: [],
  monitoredProcesses: [],
  mappedProcesses: [],
  lastProcessesAt: null,
  lastProcessPinsAt: null,
  ...over,
});

/** Every `prisma.asset.update` data payload, in call order. */
const updates = () => vi.mocked(prisma.asset.update).mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
const outcomes = () => m.recordWorkOutcome.mock.calls.map((c) => `${c[0]}:${c[1]}`);

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of Object.values(m)) f.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  settings = {
    intervalSeconds: 60,
    responseTimePolling: "icmp",
    lldpPolling: "snmp",
    lldpTimeoutMs: 5000,
    lldpCredentialId: null,
    storagePolling: "snmp",
    storageTimeoutMs: 6000,
    interfacesPolling: "rest_api",
    interfacesCredentialId: null,
    eventLogPolling: "ssh",
    eventLogIntervalSeconds: 600,
    eventLogTimeoutMs: 15_000,
    eventLogCredentialId: null,
    processesPolling: "ssh",
    processesIntervalSeconds: 300,
    processesTimeoutMs: 10_000,
    processesCredentialId: null,
    systemInfoTimeoutMs: 9000,
  };
  m.resolveMonitorSettings.mockImplementation(async () => settings);
  m.startWorkTimer.mockReturnValue(() => undefined);
  m.resolveDownDetection.mockResolvedValue(null);
  m.getPendingProbePatch.mockReturnValue(undefined);
  vi.mocked(prisma.asset.update).mockResolvedValue({} as never);
  vi.mocked(prisma.asset.updateMany).mockResolvedValue({ count: 1 } as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ─── small pure helpers ────────────────────────────────────────────────────

describe("lldpPollingCollects", () => {
  it("collects only over SNMP and FortiOS REST", () => {
    expect(lldpPollingCollects("snmp")).toBe(true);
    expect(lldpPollingCollects("rest_api")).toBe(true);
    for (const other of ["agent", "ssh", "winrm", "icmp", "generic_api", "disabled", null, undefined]) {
      expect(lldpPollingCollects(other as string | null | undefined)).toBe(false);
    }
  });
});

describe("passSweepIntervalSec", () => {
  it("is the configured interval when fping can hold it", async () => {
    m.detectFping.mockResolvedValue(true);
    vi.stubEnv("POLARIS_LOSS_SWEEP_INTERVAL_SEC", "");
    expect(await passSweepIntervalSec(2000)).toBe(60);
    vi.stubEnv("POLARIS_LOSS_SWEEP_INTERVAL_SEC", "300");
    expect(await passSweepIntervalSec(2000)).toBe(300);
  });

  it("is floored at what the per-host fallback pinger can finish for the fleet", async () => {
    m.detectFping.mockResolvedValue(false);
    vi.stubEnv("POLARIS_LOSS_SWEEP_INTERVAL_SEC", "60");
    const got = await passSweepIntervalSec(10_000);
    expect(got).toBe(suggestedSweepIntervalSec(10_000, false));
    expect(got).toBeGreaterThan(60);
    expect(got % 30).toBe(0);
  });
});

// ─── runProbeBatchFor ──────────────────────────────────────────────────────

describe("runProbeBatchFor", () => {
  const snap = (id: string, over: Record<string, unknown> = {}) => ({
    id, hostname: id, assetType: "server", monitored: true, monitorStatus: "up",
    lastUptimeSec: null, consecutiveFailures: 0, consecutiveSuccesses: 3,
    dependencySuppressed: false, lastMonitorAt: null, ipAddress: `10.0.0.${id.slice(1)}`,
    ipv6Address: null, ipConfirmedFor: null, ipConfirmedSince: null, ...over,
  });

  it("an empty chunk succeeds without a read", async () => {
    expect(await runProbeBatchFor([], labels)).toBe("success");
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
    expect(m.pingTargets).not.toHaveBeenCalled();
  });

  it("drops assets unmonitored or already polled since publication, and pings only the rest", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([
      snap("a1"),
      snap("a2", { monitored: false }),
      snap("a3", { lastMonitorAt: new Date(NOW.getTime() - 10_000) }), // 10 s ago, 60 s cadence
    ] as never);
    m.pingTargets.mockResolvedValue(new Map([["10.0.0.1", { sent: 1, received: 1, avgRttMs: 2.6 }]]));
    const items = [
      { id: "a1", target: "10.0.0.1", timeoutMs: 1000, intervalSec: 60 },
      { id: "a2", target: "10.0.0.2", timeoutMs: 1000, intervalSec: 60 },
      { id: "a3", target: "10.0.0.3", timeoutMs: 1000, intervalSec: 60 },
      { id: "gone", target: "10.0.0.9", timeoutMs: 1000, intervalSec: 60 }, // no row any more
    ];
    expect(await runProbeBatchFor(items, labels)).toBe("success");
    expect(m.pingTargets).toHaveBeenCalledTimes(1);
    expect(m.pingTargets.mock.calls[0][0]).toEqual([{ target: "10.0.0.1", timeoutMs: 1000 }]);
    expect(m.pingTargets.mock.calls[0][1]).toEqual({ count: 1 });
  });

  it("a pending (unflushed) probe patch also counts as already polled", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([snap("a1")] as never);
    m.getPendingProbePatch.mockReturnValue({ lastMonitorAt: new Date(NOW.getTime() - 5_000) });
    expect(await runProbeBatchFor([{ id: "a1", target: "10.0.0.1", timeoutMs: 1000, intervalSec: 60 }], labels)).toBe("success");
    expect(m.pingTargets).not.toHaveBeenCalled();
  });

  it("records a reply with the measured RTT and a miss with the timeout it cost, both stamped at send time", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([snap("a1"), snap("a2")] as never);
    m.pingTargets.mockImplementation(async () => {
      vi.setSystemTime(new Date(NOW.getTime() + 2_000)); // the slowest target times out
      return new Map([
        ["10.0.0.1", { sent: 1, received: 1, avgRttMs: 3.6 }],
        ["10.0.0.2", { sent: 1, received: 0, avgRttMs: null }],
      ]);
    });
    await runProbeBatchFor([
      { id: "a1", target: "10.0.0.1", timeoutMs: 1500 },
      { id: "a2", target: "10.0.0.2", timeoutMs: 2000 },
    ], labels);
    const samples = m.enqueueMonitorSample.mock.calls.map((c) => c[0]);
    expect(samples).toHaveLength(2);
    const ok = samples.find((s) => s.assetId === "a1");
    const miss = samples.find((s) => s.assetId === "a2");
    expect(ok).toMatchObject({ success: true, responseTimeMs: 4, error: null, timeoutMs: null });
    expect(miss).toMatchObject({ success: false, responseTimeMs: null, error: "no echo reply", timeoutMs: 2000 });
    // The instant the echoes went out, not the completion two seconds later.
    expect(ok.timestamp).toEqual(NOW);
    expect(miss.timestamp).toEqual(NOW);
    expect(m.enqueueProbePatch.mock.calls.find((c) => c[0] === "a1")?.[1].lastMonitorAt).toEqual(NOW);
    // One probe observation per attempted asset: one success, one failure.
    expect(m.recordProbe.mock.calls.map((c) => c[2]).sort()).toEqual(["failure", "success"]);
  });

  it("a target absent from the ping result (never attempted) writes nothing and is not counted", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([snap("a1"), snap("a2")] as never);
    m.pingTargets.mockResolvedValue(new Map([
      ["10.0.0.2", { sent: 0, received: 0, avgRttMs: null }], // sent 0 is also "not attempted"
    ]));
    expect(await runProbeBatchFor([
      { id: "a1", target: "10.0.0.1", timeoutMs: 1000 },
      { id: "a2", target: "10.0.0.2", timeoutMs: 1000 },
    ], labels)).toBe("success");
    expect(m.enqueueMonitorSample).not.toHaveBeenCalled();
    expect(m.enqueueProbePatch).not.toHaveBeenCalled();
    expect(m.recordProbe).not.toHaveBeenCalled();
  });

  it("one asset's failed state write does not abandon the rest of the chunk", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([snap("a1"), snap("a2")] as never);
    m.pingTargets.mockResolvedValue(new Map([
      ["10.0.0.1", { sent: 1, received: 1, avgRttMs: 1 }],
      ["10.0.0.2", { sent: 1, received: 1, avgRttMs: 1 }],
    ]));
    m.resolveMonitorSettings.mockImplementation(async (a: { id: string }) => {
      if (a.id === "a1") throw new Error("settings read failed");
      return settings;
    });
    expect(await runProbeBatchFor([
      { id: "a1", target: "10.0.0.1", timeoutMs: 1000 },
      { id: "a2", target: "10.0.0.2", timeoutMs: 1000 },
    ], labels)).toBe("success");
    expect(m.enqueueMonitorSample.mock.calls.map((c) => c[0].assetId)).toEqual(["a2"]);
  });

  it("a crash in the read is reported as crash", async () => {
    vi.mocked(prisma.asset.findMany).mockRejectedValue(new Error("pool exhausted"));
    expect(await runProbeBatchFor([{ id: "a1", target: "10.0.0.1", timeoutMs: 1000 }], labels)).toBe("crash");
    expect(outcomes()).toEqual(["probe:crash"]);
  });
});

// ─── runProbeFor ───────────────────────────────────────────────────────────

describe("runProbeFor", () => {
  const snapshot = { id: "a1", hostname: "h", monitorStatus: "up", consecutiveFailures: 0, consecutiveSuccesses: 1, lastUptimeSec: null, dependencySuppressed: false };

  it("passes the carried interval through and reports a duplicate as a clean no-op", async () => {
    m.probeAsset.mockImplementation(async (_id: string, out: { dueIntervalSec?: number }) => {
      expect(out.dueIntervalSec).toBe(120);
      return { success: true, responseTimeMs: 1, duplicate: true };
    });
    expect(await runProbeFor("a1", labels, 120)).toBe("success");
    expect(m.enqueueMonitorSample).not.toHaveBeenCalled();
    expect(m.recordProbe).not.toHaveBeenCalled();
  });

  it("a skipped probe stamps the cadence anchor only and counts as neither outcome", async () => {
    m.probeAsset.mockImplementation(async (_id: string, out: Record<string, unknown>) => {
      out.snapshot = snapshot;
      return { success: false, responseTimeMs: 0, skipped: true };
    });
    expect(await runProbeFor("a1", labels)).toBe("success");
    expect(updates()).toEqual([{ lastMonitorAt: NOW }]);
    expect(m.enqueueMonitorSample).not.toHaveBeenCalled();
    expect(m.recordProbe).not.toHaveBeenCalled();
  });

  it("success and failure map to the probe metric and the work outcome", async () => {
    m.probeAsset.mockImplementation(async (_id: string, out: Record<string, unknown>) => {
      out.snapshot = snapshot;
      out.timeoutMs = 3000;
      return { success: false, responseTimeMs: 3000, error: "timeout" };
    });
    expect(await runProbeFor("a1", labels)).toBe("failure");
    expect(m.recordProbe.mock.calls[0][0]).toBe("icmp");
    expect(m.recordProbe.mock.calls[0][2]).toBe("failure");
    // The probe's own timeout rides into the failed sample (business rule 67).
    expect(m.enqueueMonitorSample.mock.calls[0][0]).toMatchObject({ success: false, timeoutMs: 3000 });
    // The preloaded snapshot was used — no second read.
    expect(prisma.asset.findUnique).not.toHaveBeenCalled();

    m.probeAsset.mockImplementation(async (_id: string, out: Record<string, unknown>) => {
      out.snapshot = snapshot;
      return { success: true, responseTimeMs: 12 };
    });
    expect(await runProbeFor("a1", labels)).toBe("success");
    expect(outcomes()).toEqual(["probe:failure", "probe:success"]);
  });

  it("a thrown probe is a crash, still observed as a failed probe", async () => {
    m.probeAsset.mockRejectedValue(new Error("boom"));
    expect(await runProbeFor("a1", labels)).toBe("crash");
    expect(m.recordProbe.mock.calls[0][2]).toBe("failure");
    expect(outcomes()).toEqual(["probe:crash"]);
  });
});

// ─── runTelemetryFor ───────────────────────────────────────────────────────

describe("runTelemetryFor", () => {
  beforeEach(() => {
    m.loadTelemetryAsset.mockResolvedValue(asset());
    m.collectGenericApiWidgetSamples.mockResolvedValue({ samples: [], stateRows: [] });
  });

  it("hands ONE preloaded row to both collectors and succeeds when both deliver", async () => {
    const row = asset();
    m.loadTelemetryAsset.mockResolvedValue(row);
    m.collectTelemetry.mockResolvedValue({ supported: true, data: { cpuPct: 1 } });
    m.collectHardwareSensors.mockResolvedValue({ supported: true, data: [] });
    expect(await runTelemetryFor("a1", labels)).toBe("success");
    expect(m.loadTelemetryAsset).toHaveBeenCalledTimes(1);
    expect(m.collectTelemetry.mock.calls[0][1]).toBe(row);
    expect(m.collectHardwareSensors.mock.calls[0][1]).toBe(row);
  });

  it("unsupported streams are a clean pass, not a failure", async () => {
    m.collectTelemetry.mockResolvedValue({ supported: false });
    m.collectHardwareSensors.mockResolvedValue({ supported: false });
    expect(await runTelemetryFor("a1", labels)).toBe("success");
  });

  it("a thrown collector is packaged as a failed stream and still recorded; the other stream is untouched", async () => {
    m.collectTelemetry.mockRejectedValue(new Error("snmp timeout"));
    m.collectHardwareSensors.mockResolvedValue({ supported: true, data: [{ name: "cpu", value: 40 }] });
    expect(await runTelemetryFor("a1", labels)).toBe("failure");
    expect(m.recordTelemetryResult).toHaveBeenCalledWith("a1", { supported: true, error: "snmp timeout" });
    expect(m.recordHardwareSensorResult).toHaveBeenCalledWith("a1", { supported: true, data: [{ name: "cpu", value: 40 }] });
  });

  it("a failed asset read is a crash", async () => {
    m.loadTelemetryAsset.mockRejectedValue(new Error("db down"));
    expect(await runTelemetryFor("a1", labels)).toBe("crash");
  });
});

// ─── runCustomWidgetsFor ───────────────────────────────────────────────────

describe("runCustomWidgetsFor", () => {
  it("stamps the attempt before anything else, even for an asset that has gone (rule 118)", async () => {
    m.loadTelemetryAsset.mockResolvedValue(null);
    expect(await runCustomWidgetsFor("a1", labels)).toBe("success");
    expect(prisma.asset.updateMany).toHaveBeenCalledWith({ where: { id: "a1" }, data: { lastCustomWidgetAttemptAt: NOW } });
    expect(m.enabledWidgetIdsForAsset).not.toHaveBeenCalled();
  });

  it("no widget switched on is a clean pass that collects nothing", async () => {
    m.loadTelemetryAsset.mockResolvedValue(asset());
    m.enabledWidgetIdsForAsset.mockResolvedValue(new Set());
    expect(await runCustomWidgetsFor("a1", labels)).toBe("success");
    expect(m.widgetProfileForAsset).not.toHaveBeenCalled();
  });

  it("widgets switched on but no governing profile is a failure with nothing written", async () => {
    m.loadTelemetryAsset.mockResolvedValue(asset());
    m.enabledWidgetIdsForAsset.mockResolvedValue(new Set(["w1"]));
    m.widgetProfileForAsset.mockReturnValue(null);
    expect(await runCustomWidgetsFor("a1", labels)).toBe("failure");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("a widget whose model pattern does not match — or that RE2 cannot compile — polls nothing (rules 116, 130)", async () => {
    m.loadTelemetryAsset.mockResolvedValue(asset({ model: "FG-60F" }));
    m.enabledWidgetIdsForAsset.mockResolvedValue(new Set(["w1", "w2", "w3"]));
    m.widgetProfileForAsset.mockReturnValue({
      widgets: [
        { id: "w1", modelPattern: "^FG-100" },
        { id: "w2", modelPattern: "(?<=FG)-60F" }, // lookbehind: refused by RE2, matches nothing
        { id: "w9", modelPattern: null }, // applies, but not switched on for this asset
      ],
    });
    expect(await runCustomWidgetsFor("a1", labels)).toBe("failure");
    expect(m.resolveMonitorSettings).not.toHaveBeenCalled();
  });

  it("a crash after the stamp is reported as crash", async () => {
    m.loadTelemetryAsset.mockRejectedValue(new Error("x"));
    expect(await runCustomWidgetsFor("a1", labels)).toBe("crash");
    expect(prisma.asset.updateMany).toHaveBeenCalled();
  });
});

// ─── runSystemInfoFor / runFastFilteredFor ─────────────────────────────────

describe("runSystemInfoFor / runFastFilteredFor", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["supported with data", { supported: true, data: { interfaces: [] } }, "success"],
    ["supported, no data", { supported: true, error: "timeout" }, "failure"],
    ["unsupported", { supported: false }, "success"],
  ];
  for (const [name, result, want] of cases) {
    it(`system info: ${name} → ${want}, and the result is always persisted`, async () => {
      m.collectSystemInfo.mockResolvedValue(result);
      expect(await runSystemInfoFor("a1", { ...labels, verbose: true })).toBe(want);
      expect(m.recordSystemInfoResult).toHaveBeenCalledWith("a1", result);
    });
    it(`fast filtered: ${name} → ${want}, and the result is always persisted`, async () => {
      m.collectFastFiltered.mockResolvedValue(result);
      expect(await runFastFilteredFor("a1", labels)).toBe(want);
      expect(m.recordFastFilteredResult).toHaveBeenCalledWith("a1", result);
    });
  }

  it("a thrown collector is a crash on both", async () => {
    m.collectSystemInfo.mockRejectedValue(new Error("x"));
    m.collectFastFiltered.mockRejectedValue(new Error("x"));
    expect(await runSystemInfoFor("a1", labels)).toBe("crash");
    expect(await runFastFilteredFor("a1", labels)).toBe("crash");
    expect(outcomes()).toEqual(["systemInfo:crash", "fastFiltered:crash"]);
  });
});

// ─── runLldpFor ────────────────────────────────────────────────────────────

describe("runLldpFor", () => {
  const fgIntegration = { id: "i1", type: "fortigate", config: { apiToken: "t" } };

  it("an unmonitored asset ends cleanly with no attempt stamp", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({ monitored: false }) as never);
    expect(await runLldpFor("a1", labels)).toBe("success");
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it("a method this runner does not collect ends cleanly with no attempt stamp", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    settings.lldpPolling = "agent";
    expect(await runLldpFor("a1", labels)).toBe("success");
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it("no address: the attempt is stamped (rule 118(a)) and the pass fails", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({ ipAddress: null }) as never);
    expect(await runLldpFor("a1", labels)).toBe("failure");
    expect(updates()).toEqual([{ lastLldpAttemptAt: NOW }]);
  });

  it("REST LLDP on an asset not discovered by a Fortinet integration fails without a call", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({ discoveredByIntegration: { type: "activedirectory", config: {} } }) as never);
    settings.lldpPolling = "rest_api";
    expect(await runLldpFor("a1", labels)).toBe("failure");
    expect(m.collectLldpOnlyFortinet).not.toHaveBeenCalled();
  });

  it("REST LLDP prefers the per-stream REST credential over the asset default", async () => {
    const lldpCred = { type: "restapi", config: { token: "a" } };
    const monCred = { type: "restapi", config: { token: "b" } };
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({
      discoveredByIntegration: fgIntegration, lldpCredential: lldpCred, monitorCredential: monCred,
    }) as never);
    settings.lldpPolling = "rest_api";
    m.collectLldpOnlyFortinet.mockResolvedValue([]);
    expect(await runLldpFor("a1", labels)).toBe("success");
    expect(m.collectLldpOnlyFortinet).toHaveBeenCalledWith("10.0.0.5", fgIntegration, 5000, lldpCred);
    // An empty list is a real answer: it full-replaces with nothing, labelled fortios.
    expect(m.persistLldpNeighbors).toHaveBeenCalledWith("a1", [], NOW, "fortios");
    expect(updates()).toEqual([{ lastLldpAttemptAt: NOW }, { lastLldpAt: NOW }]);
  });

  it("SNMP LLDP with no resolvable credential fails without dialling", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    m.resolveSnmpConfigForStream.mockResolvedValue({ error: "no SNMP credential" });
    expect(await runLldpFor("a1", labels)).toBe("failure");
    expect(m.collectLldpOnlySnmp).not.toHaveBeenCalled();
  });

  it("SNMP LLDP: a resolver throw is treated as no credential, not a crash", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    m.resolveSnmpConfigForStream.mockRejectedValue(new Error("fortinet lookup"));
    expect(await runLldpFor("a1", labels)).toBe("failure");
    expect(outcomes()).toEqual(["lldp:failure"]);
  });

  it("SNMP LLDP: a transport failure keeps the stored rows and does not bump lastLldpAt", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    m.resolveSnmpConfigForStream.mockResolvedValue({ cfg: { community: "public" } });
    m.collectLldpOnlySnmp.mockRejectedValue(new Error("timeout"));
    expect(await runLldpFor("a1", labels)).toBe("failure");
    expect(m.persistLldpNeighbors).not.toHaveBeenCalled();
    expect(updates()).toEqual([{ lastLldpAttemptAt: NOW }]);
  });

  it("SNMP LLDP success persists the neighbours labelled snmp and stamps lastLldpAt", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    m.resolveSnmpConfigForStream.mockResolvedValue({ cfg: { community: "public" } });
    const neigh = [{ localPort: "1", remoteName: "sw2" }];
    m.collectLldpOnlySnmp.mockResolvedValue(neigh);
    expect(await runLldpFor("a1", labels)).toBe("success");
    expect(m.collectLldpOnlySnmp).toHaveBeenCalledWith("10.0.0.5", { community: "public" }, 5000);
    expect(m.persistLldpNeighbors).toHaveBeenCalledWith("a1", neigh, NOW, "snmp");
  });

  it("a stamp that fails is best-effort and does not fail the pass", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    vi.mocked(prisma.asset.update).mockRejectedValueOnce(new Error("lock timeout"));
    m.resolveSnmpConfigForStream.mockResolvedValue({ cfg: {} });
    m.collectLldpOnlySnmp.mockResolvedValue([]);
    expect(await runLldpFor("a1", labels)).toBe("success");
  });
});

// ─── runStorageFor ─────────────────────────────────────────────────────────

describe("runStorageFor", () => {
  it("methods with no dedicated storage cadence end cleanly with no stamp", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    for (const method of ["rest_api", "agent", "icmp", "vcenter"]) {
      settings.storagePolling = method;
      expect(await runStorageFor("a1", labels)).toBe("success");
    }
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it("SSH storage dials the DNS name when there is no address, and writes pinned mounts fast, the rest slow", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({
      ipAddress: null, dnsName: "host-1.corp", monitoredStorage: ["/"],
    }) as never);
    settings.storagePolling = "ssh";
    m.resolveAgentlessCredConfig.mockResolvedValue({ username: "u", password: "p" });
    m.collectHostSsh.mockResolvedValue({ storage: [
      { mountPath: "/", totalBytes: 1000.4, usedBytes: 500.6 },
      { mountPath: "/var", totalBytes: null, usedBytes: null },
    ] });
    expect(await runStorageFor("a1", labels)).toBe("success");
    expect(m.collectHostSsh).toHaveBeenCalledWith("host-1.corp", { username: "u", password: "p" },
      { telemetry: false, interfaces: false, storage: true, timeoutMs: 6000 });
    const rows = m.enqueueStorageSamples.mock.calls[0][0];
    expect(rows).toEqual([
      { assetId: "a1", timestamp: NOW, cadence: "fast", mountPath: "/", totalBytes: 1000n, usedBytes: 501n },
      { assetId: "a1", timestamp: NOW, cadence: "slow", mountPath: "/var", totalBytes: null, usedBytes: null },
    ]);
    expect(updates()).toEqual([{ lastStorageAttemptAt: NOW }, { lastStorageAt: NOW }]);
  });

  it("the AD bind fallback is withheld from an asset with an operator IP override", async () => {
    const ad = { type: "activedirectory", config: { bindDn: "x", bindPassword: "y" } };
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({ discoveredByIntegration: ad, ipOverride: "10.0.0.5" }) as never);
    settings.storagePolling = "winrm";
    m.resolveAgentlessCredConfig.mockResolvedValue(null);
    expect(await runStorageFor("a1", labels)).toBe("failure");
    expect(m.resolveAgentlessCredConfig.mock.calls[0][3]).toBeNull();
    expect(m.collectHostWinrm).not.toHaveBeenCalled();
  });

  it("a failed agentless scrape keeps the stored mounts and leaves lastStorageAt alone", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    settings.storagePolling = "winrm";
    m.resolveAgentlessCredConfig.mockResolvedValue({ username: "u", password: "p" });
    m.collectHostWinrm.mockRejectedValue(new Error("401"));
    expect(await runStorageFor("a1", labels)).toBe("failure");
    expect(m.collectHostWinrm.mock.calls[0][0]).toMatchObject({ host: "10.0.0.5" });
    expect(m.enqueueStorageSamples).not.toHaveBeenCalled();
    expect(updates()).toEqual([{ lastStorageAttemptAt: NOW }]);
  });

  it("SNMP storage never falls back to a name: no address is a failure", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({ ipAddress: null, dnsName: "h.corp" }) as never);
    expect(await runStorageFor("a1", labels)).toBe("failure");
    expect(m.resolveSnmpConfigForStream).not.toHaveBeenCalled();
  });

  it("SNMP storage keeps fixed / removable disk rows only and multiplies by the allocation unit", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    m.resolveSnmpConfigForStream.mockResolvedValue({ cfg: { community: "c" } });
    m.withSnmpSession.mockImplementation(async (_h: string, _c: unknown, fn: (s: unknown) => Promise<unknown>) => fn({}));
    const walks: Record<string, Map<string, unknown>> = {
      [OID.hrStorageType]: new Map<string, unknown>([["1", OID.hrStorageRam], ["31", OID.hrStorageFixedDisk], ["32", OID.hrStorageFixedDisk]]),
      [OID.hrStorageDescr]: new Map<string, unknown>([["1", "Physical memory"], ["31", Buffer.from("/\0\0")]]),
      [OID.hrStorageAllocationUnits]: new Map<string, unknown>([["31", 4096]]),
      [OID.hrStorageSize]: new Map<string, unknown>([["31", 100], ["32", 10]]),
      [OID.hrStorageUsed]: new Map<string, unknown>([["31", 25]]),
    };
    m.snmpWalk.mockImplementation(async (_s: unknown, oid: string) => walks[oid] ?? new Map());
    expect(await runStorageFor("a1", labels)).toBe("success");
    const rows = m.enqueueStorageSamples.mock.calls[0][0];
    expect(rows).toEqual([
      // NUL padding stripped from the description
      { assetId: "a1", timestamp: NOW, cadence: "slow", mountPath: "/", totalBytes: 409600n, usedBytes: 102400n },
      // no description → disk-<idx>; no unit → 1; no used → null (never a confident 0)
      { assetId: "a1", timestamp: NOW, cadence: "slow", mountPath: "disk-32", totalBytes: 10n, usedBytes: null },
    ]);
    expect(m.collectVendorDiskFallback).not.toHaveBeenCalled();
  });

  it("SNMP storage falls back to the vendor disk scalar pair when the table has no disk", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({ manufacturer: "Fortinet", model: "FS-148F" }) as never);
    m.resolveSnmpConfigForStream.mockResolvedValue({ cfg: {} });
    m.withSnmpSession.mockImplementation(async (_h: string, _c: unknown, fn: (s: unknown) => Promise<unknown>) => fn({}));
    m.snmpWalk.mockRejectedValue(new Error("noSuchObject"));
    m.pickDbProfile.mockReturnValue({ profileManufacturer: "Fortinet" });
    m.collectVendorDiskFallback.mockResolvedValue({ mountPath: "flash", totalBytes: 2048, usedBytes: 1024 });
    expect(await runStorageFor("a1", labels)).toBe("success");
    expect(m.collectVendorDiskFallback.mock.calls[0][2]).toEqual({ manufacturer: "Fortinet", model: "FS-148F", profileManufacturer: "Fortinet" });
    expect(m.enqueueStorageSamples.mock.calls[0][0]).toEqual([
      { assetId: "a1", timestamp: NOW, cadence: "slow", mountPath: "flash", totalBytes: 2048n, usedBytes: 1024n },
    ]);
  });

  it("SNMP storage with nothing at all still stamps lastStorageAt (an empty answer is an answer)", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    m.resolveSnmpConfigForStream.mockResolvedValue({ cfg: {} });
    m.withSnmpSession.mockImplementation(async (_h: string, _c: unknown, fn: (s: unknown) => Promise<unknown>) => fn({}));
    m.snmpWalk.mockResolvedValue(new Map());
    m.collectVendorDiskFallback.mockResolvedValue(null);
    expect(await runStorageFor("a1", labels)).toBe("success");
    expect(m.enqueueStorageSamples).not.toHaveBeenCalled();
    expect(updates()).toEqual([{ lastStorageAttemptAt: NOW }, { lastStorageAt: NOW }]);
  });

  it("an SNMP session failure is a failure, not a crash", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    m.resolveSnmpConfigForStream.mockResolvedValue({ cfg: {} });
    m.withSnmpSession.mockRejectedValue(new Error("gate wait timeout"));
    expect(await runStorageFor("a1", labels)).toBe("failure");
  });
});

// ─── runEventLogFor ────────────────────────────────────────────────────────

describe("runEventLogFor", () => {
  const anchorStamps = () => updates().filter((d) => "lastEventLogAt" in d).length;

  beforeEach(() => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    m.getAgentEventLogConfig.mockResolvedValue({ enabled: true, minLevel: "warning" });
    m.resolveAgentlessCredConfig.mockResolvedValue({ username: "u", password: "p" });
  });

  it("agent-mode assets never reach the master switch", async () => {
    settings.eventLogPolling = "agent";
    expect(await runEventLogFor("a1", labels)).toBe("success");
    expect(m.getAgentEventLogConfig).not.toHaveBeenCalled();
  });

  it("the master switch off costs nothing: no anchor write, no collection", async () => {
    m.getAgentEventLogConfig.mockResolvedValue({ enabled: false });
    expect(await runEventLogFor("a1", labels)).toBe("success");
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(m.collectEventLogSsh).not.toHaveBeenCalled();
  });

  it("no credential: the anchor is still stamped and the pass fails", async () => {
    m.resolveAgentlessCredConfig.mockResolvedValue(null);
    expect(await runEventLogFor("a1", labels)).toBe("failure");
    expect(anchorStamps()).toBe(1);
  });

  it("asks for 1.5x the interval, capped entries, with a 30 s timeout floor", async () => {
    m.collectEventLogSsh.mockResolvedValue([]);
    expect(await runEventLogFor("a1", labels)).toBe("success");
    expect(m.collectEventLogSsh).toHaveBeenCalledWith("10.0.0.5", { username: "u", password: "p" },
      { sinceMinutes: 15, maxEntries: 300, timeoutMs: 30_000 });
    // An empty window ingests nothing.
    expect(m.ingestOsEventLog).not.toHaveBeenCalled();
    expect(anchorStamps()).toBe(1);
  });

  it("a short interval still asks for at least one minute; a long timeout is kept", async () => {
    settings.eventLogIntervalSeconds = 20;
    settings.eventLogTimeoutMs = 45_000;
    m.collectEventLogSsh.mockResolvedValue([]);
    await runEventLogFor("a1", labels);
    expect(m.collectEventLogSsh.mock.calls[0][2]).toEqual({ sinceMinutes: 1, maxEntries: 300, timeoutMs: 45_000 });
  });

  it("WinRM dials by name when there is no address and hands entries to the shared sink", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({ ipAddress: null, dnsName: "dc1.corp" }) as never);
    settings.eventLogPolling = "winrm";
    const entries = [{ level: "error", message: "disk" }];
    m.collectEventLogWinrm.mockResolvedValue(entries);
    expect(await runEventLogFor("a1", labels)).toBe("success");
    expect(m.collectEventLogWinrm.mock.calls[0][0]).toMatchObject({ host: "dc1.corp", username: "u" });
    expect(m.ingestOsEventLog).toHaveBeenCalledWith("a1", "host-1", entries, { enabled: true, minLevel: "warning" });
  });

  it("a collector failure stamps the anchor, fails, and ingests nothing", async () => {
    m.collectEventLogSsh.mockRejectedValue(new Error("auth failed"));
    expect(await runEventLogFor("a1", labels)).toBe("failure");
    expect(anchorStamps()).toBe(1);
    expect(m.ingestOsEventLog).not.toHaveBeenCalled();
  });
});

// ─── runSdwanFor / resolveSdwanPollIntervalForAsset ────────────────────────

describe("runSdwanFor", () => {
  const fg = { id: "i1", type: "fortigate", config: { apiToken: "tok" } };

  beforeEach(() => {
    m.resolveSdwanIntervalSec.mockReturnValue(60);
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({ assetType: "firewall", discoveredByIntegration: fg }) as never);
  });

  it("the pickup re-check: no integration, or interfaces off REST, ends cleanly with no stamp", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValueOnce(asset({ assetType: "firewall" }) as never);
    expect(await runSdwanFor("a1", labels)).toBe("success");
    settings.interfacesPolling = "snmp";
    expect(await runSdwanFor("a1", labels)).toBe("success");
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(m.collectSdwanFortinet).not.toHaveBeenCalled();
  });

  it("an integration with no API token and no REST credential fails after stamping", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({ assetType: "firewall", discoveredByIntegration: { type: "fortigate", config: {} } }) as never);
    expect(await runSdwanFor("a1", labels)).toBe("failure");
    expect(updates()).toEqual([{ lastSdwanAt: NOW }]);
    expect(m.collectSdwanFortinet).not.toHaveBeenCalled();
  });

  it("an unreachable gate is stamped anyway so it is asked once per interval", async () => {
    m.collectSdwanFortinet.mockResolvedValue({ perfSla: [], sdwanRules: undefined, reachable: false });
    expect(await runSdwanFor("a1", labels)).toBe("failure");
    expect(updates()).toEqual([{ lastSdwanAt: NOW }]);
    expect(m.persistPerfSlaSampleStream).not.toHaveBeenCalled();
  });

  it("rules are full-replaced only when the CMDB read succeeded; SLA samples always land", async () => {
    m.collectSdwanFortinet.mockResolvedValue({ perfSla: [{ name: "hc" }], sdwanRules: undefined, reachable: true });
    expect(await runSdwanFor("a1", labels)).toBe("success");
    expect(m.collectSdwanFortinet.mock.calls[0][0]).toMatchObject({ host: "10.0.0.5", apiToken: "tok" });
    expect(m.collectSdwanFortinet.mock.calls[0][1]).toBe(9000);
    expect(m.persistPerfSlaSampleStream).toHaveBeenCalledWith("a1", [{ name: "hc" }], NOW);
    expect(m.persistSdwanRules).not.toHaveBeenCalled();

    m.collectSdwanFortinet.mockResolvedValue({ perfSla: [], sdwanRules: [], reachable: true });
    await runSdwanFor("a1", labels);
    expect(m.persistSdwanRules).toHaveBeenCalledWith("a1", []);
  });
});

describe("resolveSdwanPollIntervalForAsset", () => {
  it("is null for a decommissioned or disabled asset and the interval for an eligible gate", async () => {
    m.resolveSdwanIntervalSec.mockReturnValue(120);
    vi.mocked(prisma.asset.findUnique).mockResolvedValueOnce(asset({ status: "decommissioned", assetType: "firewall" }) as never);
    expect(await resolveSdwanPollIntervalForAsset("a1")).toBeNull();
    vi.mocked(prisma.asset.findUnique).mockResolvedValueOnce(asset({ status: "disabled", assetType: "firewall" }) as never);
    expect(await resolveSdwanPollIntervalForAsset("a1")).toBeNull();
    vi.mocked(prisma.asset.findUnique).mockResolvedValueOnce(asset({ assetType: "firewall" }) as never);
    expect(await resolveSdwanPollIntervalForAsset("a1")).toBe(120);
    vi.mocked(prisma.asset.findUnique).mockResolvedValueOnce(asset({ assetType: "switch" }) as never);
    expect(await resolveSdwanPollIntervalForAsset("a1")).toBeNull();
  });
});

// ─── runProcessesFor ───────────────────────────────────────────────────────

describe("runProcessesFor", () => {
  const anchors = () => updates();

  it("nothing due (fresh inventory, no pins) ends cleanly without a stamp", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({ lastProcessesAt: new Date(NOW.getTime() - 60_000) }) as never);
    expect(await runProcessesFor("a1", labels)).toBe("success");
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it("a non-agentless method ends cleanly", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    settings.processesPolling = "agent";
    expect(await runProcessesFor("a1", labels)).toBe("success");
    expect(m.collectProcessesSsh).not.toHaveBeenCalled();
  });

  it("a failure stamps exactly the sub-passes it attempted", async () => {
    // Inventory fresh; pins present and never collected → only the pin anchor.
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({
      ipAddress: null, monitoredProcesses: ["nginx"], lastProcessesAt: new Date(NOW.getTime() - 60_000),
    }) as never);
    expect(await runProcessesFor("a1", labels)).toBe("failure");
    expect(anchors()).toEqual([{ lastProcessPinsAt: NOW }]);
  });

  it("the pinned sub-pass alone asks for no inventory, only the pins and maps", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({
      monitoredProcesses: ["nginx"], mappedProcesses: ["sshd"],
      lastProcessesAt: new Date(NOW.getTime() - 60_000), lastProcessPinsAt: new Date(NOW.getTime() - 61_000),
      monitorCredential: { type: "ssh", config: { username: "u", password: "p" } },
    }) as never);
    m.collectProcessesSsh.mockResolvedValue({ telemetry: [{ name: "nginx", cpuPct: 1.5, memRssBytes: 100, instanceCount: 2 }] });
    expect(await runProcessesFor("a1", labels)).toBe("success");
    expect(m.collectProcessesSsh).toHaveBeenCalledWith("10.0.0.5", { username: "u", password: "p" },
      { inventory: false, monitored: ["nginx"], mapped: ["sshd"], timeoutMs: 10_000 });
    expect(m.enqueueProcessSamples.mock.calls[0][0]).toEqual([
      { assetId: "a1", timestamp: NOW, cadence: "fast", name: "nginx", cpuPct: 1.5, memRssBytes: 100, instanceCount: 2 },
    ]);
    expect(m.persistAssetProcesses).not.toHaveBeenCalled();
    expect(anchors()).toEqual([{ lastProcessPinsAt: NOW }]);
  });

  it("a credential of the wrong type is skipped for the class-override credential", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({ processesCredential: { type: "winrm", config: { username: "w" } } }) as never);
    m.loadClassOverrideStreamCredential.mockResolvedValue({ config: { username: "class" } });
    m.collectProcessesSsh.mockResolvedValue({ inventory: [{ name: "init" }], connections: [{ local: "1" }] });
    expect(await runProcessesFor("a1", labels)).toBe("success");
    expect(m.loadClassOverrideStreamCredential).toHaveBeenCalledWith(null, "ssh");
    expect(m.collectProcessesSsh.mock.calls[0][1]).toEqual({ username: "class" });
    expect(m.persistAssetProcesses).toHaveBeenCalledWith("a1", [{ name: "init" }]);
    expect(m.persistProcessConnections).toHaveBeenCalledWith("a1", [{ local: "1" }]);
    expect(anchors()).toEqual([{ lastProcessesAt: NOW }]);
  });

  it("falls back to the AD bind account over WinRM HTTPS 5986 with a 30 s timeout floor", async () => {
    settings.processesPolling = "winrm";
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({
      discoveredByIntegration: { type: "activedirectory", config: { bindDn: "CORP\\svc", bindPassword: "pw" } },
    }) as never);
    m.loadClassOverrideStreamCredential.mockResolvedValue(null);
    m.collectProcessesWinrm.mockResolvedValue({ inventory: [] });
    expect(await runProcessesFor("a1", labels)).toBe("success");
    expect(m.collectProcessesWinrm.mock.calls[0][0]).toEqual({
      host: "10.0.0.5", username: "CORP\\svc", password: "pw", useHttps: true, port: 5986, verifyTls: false, timeoutMs: 30_000,
    });
  });

  it("the AD bind fallback is refused for an asset with a hostname override", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({
      hostnameOverride: "pinned",
      discoveredByIntegration: { type: "activedirectory", config: { bindDn: "svc", bindPassword: "pw" } },
    }) as never);
    m.loadClassOverrideStreamCredential.mockResolvedValue(null);
    expect(await runProcessesFor("a1", labels)).toBe("failure");
    expect(m.collectProcessesSsh).not.toHaveBeenCalled();
    expect(anchors()).toEqual([{ lastProcessesAt: NOW }]);
  });

  it("a collector throw stamps the anchors and fails", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({ monitorCredential: { type: "ssh", config: {} } }) as never);
    m.collectProcessesSsh.mockRejectedValue(new Error("auth"));
    expect(await runProcessesFor("a1", labels)).toBe("failure");
    expect(anchors()).toEqual([{ lastProcessesAt: NOW }]);
  });
});

// ─── runLossSweepFor ───────────────────────────────────────────────────────

describe("runLossSweepFor", () => {
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id, monitored: true, status: "active", dependencySuppressed: false, monitorStatus: "up",
    ipAddress: null, ipv6Address: null, dnsName: null, hostname: null, ...over,
  });

  it("an empty chunk succeeds without a read", async () => {
    expect(await runLossSweepFor([], labels)).toBe("success");
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });

  it("nothing eligible (unmonitored, in maintenance, no address) pings nothing", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([
      row("a1", { monitored: false, ipAddress: "10.0.0.1" }),
      row("a2", { status: "maintenance", ipAddress: "10.0.0.2" }),
      row("a3"),
    ] as never);
    expect(await runLossSweepFor(["a1", "a2", "a3"], labels)).toBe("success");
    expect(m.burstPing).not.toHaveBeenCalled();
  });

  it("pings a shared address once, fans the reading out, marks explained misses, and stamps only what was attempted", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([
      row("a1", { ipAddress: "10.0.0.1" }),
      row("a2", { ipAddress: "10.0.0.1", dependencySuppressed: true }), // HA pair on one address
      row("a3", { ipAddress: "10.0.0.3", monitorStatus: "down" }),
      row("a4", { hostname: "unresolvable" }), // never attempted
      row("a5", { ipAddress: "10.0.0.5", dependencySuppressed: true }), // suppressed but answering
    ] as never);
    m.burstPing.mockResolvedValue(new Map([
      ["10.0.0.1", { sent: 5, received: 0, avgRttMs: null }],
      ["10.0.0.3", { sent: 5, received: 0, avgRttMs: null }],
      ["10.0.0.5", { sent: 5, received: 4, avgRttMs: 1.2 }],
    ]));
    expect(await runLossSweepFor(["a1", "a2", "a3", "a4", "a5"], labels)).toBe("success");
    expect(m.burstPing).toHaveBeenCalledTimes(1);
    expect(m.burstPing.mock.calls[0][0]).toEqual(["10.0.0.1", "10.0.0.3", "unresolvable", "10.0.0.5"]);

    const byId = new Map(m.enqueueMonitorSample.mock.calls.map((c) => [c[0].assetId, c[0]]));
    expect([...byId.keys()].sort()).toEqual(["a1", "a2", "a3", "a5"]);
    for (const s of byId.values()) {
      expect(s.responseTimeMs).toBeNull(); // never a burst RTT in the response-time column
      expect(s.probeKind).toBe("icmp");
      expect(s.timestamp).toEqual(NOW);
    }
    expect(byId.get("a1")).toMatchObject({ success: false, packetsSent: 5, packetsReceived: 0, error: "no echo reply", dependencyDown: undefined, assetDown: undefined });
    expect(byId.get("a2")).toMatchObject({ success: false, dependencyDown: true });
    expect(byId.get("a3")).toMatchObject({ success: false, assetDown: true });
    expect(byId.get("a5")).toMatchObject({ success: true, error: null, packetsReceived: 4, dependencyDown: undefined });

    expect(prisma.asset.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.asset.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1", "a2", "a3", "a5"] } },
      data: { lastLossSampleAt: NOW },
    });
    // The sweep reaches no verdict: no state patch, no status transition.
    expect(m.enqueueProbePatch).not.toHaveBeenCalled();
  });

  it("a sweep where nothing was attempted writes no anchor", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([row("a1", { ipAddress: "10.0.0.1" })] as never);
    m.burstPing.mockResolvedValue(new Map());
    expect(await runLossSweepFor(["a1"], labels)).toBe("success");
    expect(prisma.asset.updateMany).not.toHaveBeenCalled();
  });

  it("a pinger crash is reported as crash", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([row("a1", { ipAddress: "10.0.0.1" })] as never);
    m.burstPing.mockRejectedValue(new Error("spawn EAGAIN"));
    expect(await runLossSweepFor(["a1"], labels)).toBe("crash");
    expect(outcomes()).toEqual(["lossSample:crash"]);
  });
});

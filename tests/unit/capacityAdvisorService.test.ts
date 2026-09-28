/**
 * tests/unit/capacityAdvisorService.test.ts
 *
 * Coverage for the Capacity Advisor pure compute (buildAdvisorState),
 * histogram percentile parser (percentile), and roundUpToNearest helper.
 *
 * Three scenarios anchor the test set, matching the synthetic-input cases
 * in the plan file:
 *
 *   - Small install (200 monitored, 1 fortigate): cursor, floor workers,
 *     pool around 50.
 *   - Medium install (2000 monitored, 1 fortimanager proxy, 5 fortigates):
 *     pgboss, scaled workers, pool > 100.
 *   - Large install (10000 monitored, fortimanager direct, parallelism=20):
 *     pool > 300, max_connections undersized when current = 100.
 *
 * Asset counts refer to MONITORED assets only — the advisor sizes to
 * workload, not inventory. Discovered-only assets do not enter the calc.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// Mock queueService so isPgbossInstalled is configurable per-test without
// pulling in the real module (which imports the pg-boss optional dep).
vi.mock("../../src/services/queueService.js", () => ({
  isPgbossInstalled: vi.fn(() => true),
  setQueueMode: vi.fn(),
}));

// Mock prisma (the service imports it for readIntegrationBreakdown / setting
// upsert paths). buildAdvisorState is pure so these mocks are only loaded for
// the unrelated transition Event path — set safe defaults.
vi.mock("../../src/db.js", () => ({
  prisma: {
    integration: { findMany: vi.fn(async () => []) },
    setting: { findUnique: vi.fn(), upsert: vi.fn() },
    event: { create: vi.fn() },
    $queryRawUnsafe: vi.fn(async () => []),
    asset: { count: vi.fn() },
  },
}));

// Mock the metrics accessor so percentile tests can supply controlled bucket
// data. The exporting module re-exports HistogramBucketValue type via the
// service's own type definitions.
vi.mock("../../src/metrics.js", () => ({
  getMonitorWorkHistogramValues: vi.fn(async () => ({ values: [] })),
  setEnvVar: vi.fn(),
}));

import {
  buildAdvisorState,
  percentile,
  roundUpToNearest,
  summarizeAdvisorGaps,
  type AdvisorInputs,
  type CadenceObservation,
  COLD_START_MIN_SAMPLES,
} from "../../src/services/capacityAdvisorService.js";

// Mirrored from src/metrics.ts:33 — keep aligned if the histogram buckets change.
const HISTOGRAM_BUCKETS = [0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60];

/** Helper: build a synthetic prom-client histogram values array for a single
 *  cadence with the given cumulative bucket counts and total. */
function synthHistogram(
  cadence: string,
  bucketCumCounts: number[],
  total: number,
): Array<{ labels: Record<string, string | number>; value: number; metricName?: string }> {
  const out: Array<{ labels: Record<string, string | number>; value: number; metricName?: string }> = [];
  for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
    out.push({
      labels: { cadence, asset_type: "firewall", transport: "rest_api", le: HISTOGRAM_BUCKETS[i] },
      value: bucketCumCounts[i] ?? bucketCumCounts[bucketCumCounts.length - 1] ?? 0,
      metricName: "polaris_monitor_work_duration_seconds_bucket",
    });
  }
  out.push({
    labels: { cadence, asset_type: "firewall", transport: "rest_api" },
    value: total,
    metricName: "polaris_monitor_work_duration_seconds_count",
  });
  out.push({
    labels: { cadence, asset_type: "firewall", transport: "rest_api" },
    value: 0,
    metricName: "polaris_monitor_work_duration_seconds_sum",
  });
  return out;
}

function fullObservation(p90: number, sampleCount = 5000): CadenceObservation {
  return { p50: p90 / 2, p90, sampleCount, usedDefault: false };
}
function coldObservation(): CadenceObservation {
  return { p50: null, p90: null, sampleCount: 5, usedDefault: true };
}

function baseSnapshot(opts: {
  monitoredAssetCount: number;
  monitoredInterfaceCount?: number;
  peakObserved?: number;
  prismaPoolSize?: number;
  pgbossPoolSize?: number | null;
  maxConnections?: number;
  activeQueueMode?: "cursor" | "pgboss";
}): any {
  return {
    computedAt: new Date().toISOString(),
    severity: "ok",
    reasons: [],
    appHost: { cpuCount: 8, totalMemoryBytes: 32 * 1024 * 1024 * 1024, freeMemoryBytes: 8 * 1024 * 1024 * 1024, loadAvg: [0,0,0], volumes: [], dbColocated: true },
    database: {
      sizeBytes: 1_000_000_000,
      sampleTables: [],
      dataDirectory: null,
      timescale: { extensionInstalled: false, hypertableTables: [] },
      queue: { pgbossInstalled: true, active: opts.activeQueueMode ?? "cursor", persisted: opts.activeQueueMode ?? "cursor" },
      connectionPool: {
        currentInUse: opts.peakObserved ?? 10,
        peakObserved: opts.peakObserved ?? 10,
        prismaPoolSize: opts.prismaPoolSize ?? 25,
        pgbossPoolSize: opts.pgbossPoolSize ?? null,
        maxConnections: opts.maxConnections ?? 200,
      },
      rollupLastSuccess: { hourly: null, daily: null },
      io: { trackIoTiming: true, measured: false, avgBackendsBlockedOnDisk: null, windowSeconds: null },
    },
    workload: {
      monitoredAssetCount: opts.monitoredAssetCount,
      monitoredInterfaceCount: opts.monitoredInterfaceCount ?? 0,
      monitoredStorageCount: 0,
      agentCount: 0,
      cadences: { responseTimeSec: 60, telemetrySec: 60, systemInfoSec: 600 },
      retention: { monitorDays: 30, telemetryDays: 30, systemInfoDays: 30 },
      steadyStateSizeBytes: 5_000_000_000,
    },
  };
}

function buildInputs(snap: any, env?: Partial<AdvisorInputs["currentEnv"]>): AdvisorInputs {
  return {
    snapshot: snap,
    integrations: { fortimanagerProxy: 0, fortimanagerDirectParallelismSum: 0, fortigate: 0, entra: 0, activedirectory: 0, windowsserver: 0 },
    cadence: {
      probe:        fullObservation(0.3),
      fastFiltered: fullObservation(0.5),
      telemetry:    fullObservation(0.7),
      systemInfo:   fullObservation(1.0),
      lldp:         fullObservation(0.5),
      storage:      fullObservation(0.5),
    },
    cadenceIntervals: { probe: 60, fastFiltered: 60, telemetry: 60, systemInfo: 600, lldp: 600, storage: 600 },
    handlerTimeoutSec: { probe: 30, fastFiltered: 60, telemetry: 180, systemInfo: 300, lldp: 600, storage: 600 },
    applicable: {
      probe:        snap.workload.monitoredAssetCount,
      fastFiltered: snap.workload.monitoredInterfaceCount,
      telemetry:    snap.workload.monitoredAssetCount,
      systemInfo:   snap.workload.monitoredAssetCount,
      lldp:         snap.workload.monitoredAssetCount,
      storage:      0,
    },
    currentEnv: {
      DATABASE_POOL_SIZE: 25,
      POLARIS_PGBOSS_POOL_SIZE: 20,
      POLARIS_MONITOR_PROBE_WORKERS: 24,
      POLARIS_MONITOR_FAST_WORKERS: 24,
      POLARIS_MONITOR_HEAVY_WORKERS: 24,
      POLARIS_MONITOR_LLDP_WORKERS: 12,
      POLARIS_MONITOR_STORAGE_WORKERS: 12,
      POLARIS_MONITOR_FLOATING_WORKERS: 32,
      POLARIS_PROBE_CONCURRENCY: 16,
      POLARIS_HEAVY_CONCURRENCY: 8,
      ...env,
    },
    pgTuning: {
      sharedBuffers:      { current: "128MB", recommended: "8GB", changeRequired: true },
      effectiveCacheSize: { current: "4GB",   recommended: "24GB", changeRequired: true },
      workMem:            { current: "4MB",   recommended: "256MB", changeRequired: true },
      randomPageCost:     { current: "4",     recommended: "1.1", changeRequired: true },
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────

describe("roundUpToNearest", () => {
  it("rounds up to the nearest multiple", () => {
    expect(roundUpToNearest(149, 50)).toBe(150);
    expect(roundUpToNearest(151, 50)).toBe(200);
    expect(roundUpToNearest(200, 50)).toBe(200);
    expect(roundUpToNearest(1, 50)).toBe(50);
  });
  it("handles zero / invalid multiples gracefully", () => {
    expect(roundUpToNearest(149, 0)).toBe(149);
    expect(roundUpToNearest(NaN, 50)).toBe(NaN);
  });
});

describe("percentile (histogram parser)", () => {
  it("returns null when sample count is below the cold-start threshold", () => {
    const values = synthHistogram("probe", [10, 30, 50, 70, 85, 95, 99, 99, 99], 50);
    const result = percentile(values, "probe", 0.9);
    expect(result.sampleCount).toBe(50);
    expect(result.value).toBeNull();
  });
  it("computes p90 with linear interpolation inside the right bucket", () => {
    // 1000 samples, cumulative bucket counts steer 90th percentile into the
    // 0.5 bucket. The exact interpolation should land between prev (0.1) and
    // current (0.5) boundaries.
    const cum = [100, 500, 900, 950, 980, 1000, 1000, 1000, 1000];
    const values = synthHistogram("probe", cum, 1000);
    const result = percentile(values, "probe", 0.9);
    expect(result.sampleCount).toBe(1000);
    expect(result.value).not.toBeNull();
    // Within the 0.1..0.5 bucket: target=900 is at the bucket's upper edge.
    expect(result.value!).toBeGreaterThanOrEqual(0.1);
    expect(result.value!).toBeLessThanOrEqual(0.5);
  });
  it("aggregates across asset_type × transport labels for the same cadence", () => {
    // Two label combos contributing to the same cadence. Each contributes
    // 500 samples — the percentile should reflect the merged distribution.
    const baseCum = [50, 250, 450, 475, 490, 500, 500, 500, 500];
    const mixed = [
      ...synthHistogram("probe", baseCum, 500),
      // Second label combo: identical shape under different transport.
      ...synthHistogram("probe", baseCum, 500).map((v) => ({
        ...v,
        labels: { ...v.labels, transport: "snmp" },
      })),
    ];
    const result = percentile(mixed, "probe", 0.5);
    expect(result.sampleCount).toBe(1000);
    expect(result.value).not.toBeNull();
  });
  it("falls through to the last finite bucket when target lands at the upper edge", () => {
    // Total 100, target = p90 × 100 = 90. Cumulative max is exactly 90, which
    // hits in the last bucket (60). The interpolation upper edge is 60.
    const cum = [10, 20, 30, 40, 50, 60, 70, 80, 90];
    const values = synthHistogram("probe", cum, 100);
    const result = percentile(values, "probe", 0.9);
    expect(result.sampleCount).toBe(100);
    expect(result.value).toBe(60);
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe("buildAdvisorState — tiny install (6 monitored, cursor) scales the floor down", () => {
  const snap = baseSnapshot({
    monitoredAssetCount: 6,
    monitoredInterfaceCount: 2,
    activeQueueMode: "cursor",
    maxConnections: 100,
  });
  // Override defaults to lower-than-floor values so the test exercises the
  // floor logic instead of falling back to the never-shrink rule.
  const inputs = buildInputs(snap, {
    POLARIS_MONITOR_PROBE_WORKERS: 1,
    POLARIS_MONITOR_FAST_WORKERS: 1,
    POLARIS_MONITOR_HEAVY_WORKERS: 1,
    POLARIS_MONITOR_FLOATING_WORKERS: 1,
    POLARIS_PROBE_CONCURRENCY: 1,
    POLARIS_HEAVY_CONCURRENCY: 1,
    DATABASE_POOL_SIZE: 1,
  });
  inputs.integrations.fortigate = 1;
  const state = buildAdvisorState(inputs);

  it("scales the per-cadence floor with monitoredAssetCount × 0.5 (clamped at PER_CADENCE_FLOOR_MIN=4)", () => {
    // ceil(6 × 0.5) = 3, clamped to floor min of 4.
    const probe = state.recommendations.find((r) => r.key === "POLARIS_MONITOR_PROBE_WORKERS")!;
    expect(probe.recommended).toBe(4);
    const heavy = state.recommendations.find((r) => r.key === "POLARIS_MONITOR_HEAVY_WORKERS")!;
    expect(heavy.recommended).toBe(4);
    const fast = state.recommendations.find((r) => r.key === "POLARIS_MONITOR_FAST_WORKERS")!;
    expect(fast.recommended).toBe(4);
  });
  it("scales the floating floor proportionally (clamped at FLOATING_FLOOR_MIN=4)", () => {
    const floating = state.recommendations.find((r) => r.key === "POLARIS_MONITOR_FLOATING_WORKERS")!;
    // Phase 2: floatingWorkers = max(floatingFloor, ceil(sumWorkersNeeded × 0.25))
    // With 6 cadences at floor 4 each, sumWorkersNeeded = 24 → ceil(24×0.25) = 6.
    expect(floating.recommended).toBe(6);
  });
  it("emits a sensible cursor PROBE_CONCURRENCY (sum of probe + fastFiltered floors)", () => {
    const probeC = state.recommendations.find((r) => r.key === "POLARIS_PROBE_CONCURRENCY")!;
    // 4 (probe floor) + 4 (fastFiltered floor) = 8
    expect(probeC.recommended).toBe(8);
  });
  it("emits a sensible cursor HEAVY_CONCURRENCY (sum of telemetry + systemInfo floors)", () => {
    const heavyC = state.recommendations.find((r) => r.key === "POLARIS_HEAVY_CONCURRENCY")!;
    expect(heavyC.recommended).toBe(8);
  });
  it("keeps the Prisma pool tiny (workerCeiling = 4×4 + 4 = 20 → ~50 after rounding)", () => {
    const prisma = state.recommendations.find((r) => r.key === "DATABASE_POOL_SIZE")!;
    expect(prisma.recommended).toBeLessThanOrEqual(50);
  });
});

describe("buildAdvisorState — small install (200 monitored, 1 fortigate, cursor)", () => {
  const snap = baseSnapshot({
    monitoredAssetCount: 200,
    monitoredInterfaceCount: 50,
    activeQueueMode: "cursor",
    maxConnections: 200,
  });
  const inputs = buildInputs(snap);
  inputs.integrations.fortigate = 1;
  const state = buildAdvisorState(inputs);

  it("recommends staying on cursor mode (under 500-asset threshold)", () => {
    expect(state.recommendedQueueMode).toBe("cursor");
    const qm = state.recommendations.find((r) => r.key === "QUEUE_MODE")!;
    expect(qm.recommended).toBe("cursor");
    expect(qm.changeRequired).toBe(false);
  });
  it("floors per-cadence workers at 24 (PER_CADENCE_FLOOR)", () => {
    const heavy = state.recommendations.find((r) => r.key === "POLARIS_MONITOR_HEAVY_WORKERS")!;
    expect(heavy.recommended).toBe(24);
  });
  it("sizes Prisma pool around 200 (workerCeiling + reserve + http overhead)", () => {
    const prisma = state.recommendations.find((r) => r.key === "DATABASE_POOL_SIZE")!;
    // Phase 2: 6 cadences × 24-worker floor = 144 + floating = 180 ceiling;
    // discoveryReserve = 1; httpOverhead = 15 → 196 modeled → 200 rounded.
    expect(prisma.recommended).toBeGreaterThanOrEqual(150);
    expect(prisma.recommended).toBeLessThanOrEqual(250);
  });
  it("emits PG_MAX_CONNECTIONS as advisory-only", () => {
    const mc = state.recommendations.find((r) => r.key === "PG_MAX_CONNECTIONS")!;
    expect(mc.applyMode).toBe("advisory-only");
  });
});

describe("buildAdvisorState — medium install (2000 monitored, 1 FMG proxy, 5 fortigates)", () => {
  const snap = baseSnapshot({
    monitoredAssetCount: 2000,
    monitoredInterfaceCount: 500,
    activeQueueMode: "cursor",
    peakObserved: 100,
    maxConnections: 200,
    pgbossPoolSize: 20,
  });
  const inputs = buildInputs(snap);
  inputs.integrations.fortimanagerProxy = 1;
  inputs.integrations.fortigate = 5;
  const state = buildAdvisorState(inputs);

  it("recommends flipping to pg-boss (over 500-asset threshold)", () => {
    expect(state.recommendedQueueMode).toBe("pgboss");
    const qm = state.recommendations.find((r) => r.key === "QUEUE_MODE")!;
    expect(qm.recommended).toBe("pgboss");
    expect(qm.changeRequired).toBe(true);
  });
  it("scales heavy workers above the 24 floor (telemetry has 2000 assets × 0.7s / 60s)", () => {
    const heavy = state.recommendations.find((r) => r.key === "POLARIS_MONITOR_HEAVY_WORKERS")!;
    // workersNeeded = ceil(2000 × 0.7 × 1.5 / 60) = 35
    expect(heavy.recommended).toBeGreaterThan(24);
  });
  it("sizes Prisma pool > 100", () => {
    const prisma = state.recommendations.find((r) => r.key === "DATABASE_POOL_SIZE")!;
    expect(prisma.recommended).toBeGreaterThan(100);
  });
});

describe("buildAdvisorState — large install (10000 monitored, FMG direct, parallelism=20)", () => {
  const snap = baseSnapshot({
    monitoredAssetCount: 10000,
    monitoredInterfaceCount: 2000,
    activeQueueMode: "pgboss",
    peakObserved: 250,
    maxConnections: 100, // intentionally undersized
    pgbossPoolSize: 20,
  });
  const inputs = buildInputs(snap);
  inputs.integrations.fortimanagerDirectParallelismSum = 20;
  const state = buildAdvisorState(inputs);

  it("recommends max_connections > current 100", () => {
    const mc = state.recommendations.find((r) => r.key === "PG_MAX_CONNECTIONS")!;
    expect(mc.changeRequired).toBe(true);
    expect(mc.recommended).toBeGreaterThan(100);
  });
  it("sizes Prisma pool > 300", () => {
    const prisma = state.recommendations.find((r) => r.key === "DATABASE_POOL_SIZE")!;
    expect(prisma.recommended).toBeGreaterThan(300);
  });
  it("rolls up restartRequired = true and anyChangeRequired = true", () => {
    expect(state.restartRequired).toBe(true);
    expect(state.anyChangeRequired).toBe(true);
  });
});

describe("buildAdvisorState — cold start", () => {
  const snap = baseSnapshot({ monitoredAssetCount: 500, activeQueueMode: "cursor" });
  const inputs = buildInputs(snap);
  inputs.cadence = {
    probe: coldObservation(),
    fastFiltered: coldObservation(),
    telemetry: coldObservation(),
    systemInfo: coldObservation(),
    lldp: coldObservation(),
    storage: coldObservation(),
  };
  const state = buildAdvisorState(inputs);

  it("flags usingColdStartDefaults", () => {
    expect(state.usingColdStartDefaults).toBe(true);
  });
  it("still produces sensible recommendations (workers at floor, not zero)", () => {
    const probe = state.recommendations.find((r) => r.key === "POLARIS_MONITOR_PROBE_WORKERS")!;
    expect(probe.recommended).toBe(24);
  });
});

describe("buildAdvisorState — Prisma pool honors observed peak", () => {
  // Regression for the case the user spotted in production: the model said
  // 152 was fine but peakObserved=179 told the truth. The advisor should
  // size Prisma so the peak (minus pg-boss share) lands at <=80% utilization.
  const snap = baseSnapshot({
    monitoredAssetCount: 1714,
    monitoredInterfaceCount: 32,
    activeQueueMode: "pgboss",
    peakObserved: 179,
    pgbossPoolSize: 20,
    prismaPoolSize: 152,
    maxConnections: 300,
  });
  const inputs = buildInputs(snap, { DATABASE_POOL_SIZE: 152, POLARIS_PGBOSS_POOL_SIZE: 20 });
  inputs.integrations.fortimanagerProxy = 1;
  const state = buildAdvisorState(inputs);

  it("recommends Prisma pool above current when peak exceeds modeled target", () => {
    const prisma = state.recommendations.find((r) => r.key === "DATABASE_POOL_SIZE")!;
    expect(prisma.changeRequired).toBe(true);
    // peakPrismaFloor = ceil((peak − pgbossTarget) / 0.80). pgbossTarget now
    // scales with worker count (max(20, 0.25 × workerCeiling)) instead of
    // being a fixed 20, so peakPrismaFloor is somewhat lower than the prior
    // (179 − 20) / 0.80 = 199. Still well above the 152 current pool so the
    // recommendation has changeRequired=true; we just don't pin the exact
    // value the way the older test did.
    expect(prisma.recommended).toBeGreaterThan(prisma.current as number);
  });
  it("includes peakPrismaFloor in the breakdown so operators see the driver", () => {
    const prisma = state.recommendations.find((r) => r.key === "DATABASE_POOL_SIZE")!;
    expect(prisma.breakdown).toHaveProperty("peakPrismaFloor");
    expect(prisma.breakdown!.peakObserved).toBe(179);
  });
});

describe("buildAdvisorState — Prisma pool divides peakObserved by processCount on split-role installs", () => {
  // Regression for the prod bug: peakObserved comes from `pg_stat_activity`
  // and is GROUP-WIDE (sums every Polaris process's backends). The Prisma
  // pool sizing it floors is PER-PROCESS. On a 5-process split-role install
  // with each process holding ~150 backends, peakObserved = 750. Pre-fix the
  // advisor recommended a per-process pool of ~900; post-fix it should
  // divide by processCount first so the floor reflects per-process demand.
  const ORIGINAL_ENV = process.env.POLARIS_MONITOR_REPLICAS;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.POLARIS_MONITOR_REPLICAS;
    else process.env.POLARIS_MONITOR_REPLICAS = ORIGINAL_ENV;
  });

  it("recommends a single-process pool ~5× smaller when 3 monitor replicas are configured", () => {
    const snap = baseSnapshot({
      monitoredAssetCount: 2080,
      activeQueueMode: "pgboss",
      peakObserved: 750, // group-wide across 5 processes
      pgbossPoolSize: 50,
      prismaPoolSize: 200,
      maxConnections: 1500,
    });
    const inputs = buildInputs(snap, { DATABASE_POOL_SIZE: 200, POLARIS_PGBOSS_POOL_SIZE: 50 });
    inputs.integrations.fortimanagerDirectParallelismSum = 1;

    process.env.POLARIS_MONITOR_REPLICAS = "3"; // web + 3 monitor + discovery = 5
    const splitState = buildAdvisorState(inputs);
    const splitPrisma = splitState.recommendations.find((r) => r.key === "DATABASE_POOL_SIZE")!;

    delete process.env.POLARIS_MONITOR_REPLICAS; // processCount = 1
    const singleState = buildAdvisorState(inputs);
    const singlePrisma = singleState.recommendations.find((r) => r.key === "DATABASE_POOL_SIZE")!;

    // Split should be substantially smaller — single-process forces the 750-
    // conn peak through one pool. Pre-fix these came out equal.
    expect(splitPrisma.recommended).toBeLessThan(singlePrisma.recommended as number);
    // Sanity: split pool should be in the ~workerCeiling+reserve+overhead
    // range, NOT ballooning past 800 like the pre-fix bug.
    expect(splitPrisma.recommended).toBeLessThan(500);
  });

  it("exposes processCount + peakPerProcess in the breakdown", () => {
    const snap = baseSnapshot({
      monitoredAssetCount: 2080,
      activeQueueMode: "pgboss",
      peakObserved: 750,
      pgbossPoolSize: 50,
      prismaPoolSize: 200,
      maxConnections: 1500,
    });
    const inputs = buildInputs(snap, { DATABASE_POOL_SIZE: 200, POLARIS_PGBOSS_POOL_SIZE: 50 });
    process.env.POLARIS_MONITOR_REPLICAS = "3";
    const state = buildAdvisorState(inputs);
    const prisma = state.recommendations.find((r) => r.key === "DATABASE_POOL_SIZE")!;
    expect(prisma.breakdown).toHaveProperty("processCount", 5);
    expect(prisma.breakdown).toHaveProperty("peakPerProcess");
    // peakPerProcess = ceil(750 / 5) = 150
    expect(prisma.breakdown!.peakPerProcess).toBe(150);
  });

  it("preserves single-process behavior when POLARIS_MONITOR_REPLICAS is unset", () => {
    const snap = baseSnapshot({
      monitoredAssetCount: 1714,
      activeQueueMode: "pgboss",
      peakObserved: 179,
      pgbossPoolSize: 20,
      prismaPoolSize: 152,
      maxConnections: 300,
    });
    const inputs = buildInputs(snap, { DATABASE_POOL_SIZE: 152, POLARIS_PGBOSS_POOL_SIZE: 20 });
    inputs.integrations.fortimanagerProxy = 1;
    delete process.env.POLARIS_MONITOR_REPLICAS;
    const state = buildAdvisorState(inputs);
    const prisma = state.recommendations.find((r) => r.key === "DATABASE_POOL_SIZE")!;
    // processCount = 1 → peakPerProcess = peakObserved (unchanged from pre-fix behavior).
    expect(prisma.breakdown!.processCount).toBe(1);
    expect(prisma.breakdown!.peakPerProcess).toBe(179);
    expect(prisma.changeRequired).toBe(true);
  });
});

describe("summarizeAdvisorGaps filters cursor-only levers when recommended mode is pgboss", () => {
  // Regression for the case the user spotted: heavy_concurrency 8 → 48 was
  // surfacing in monitor_workers_undersized on a pgboss-active install,
  // where that cursor-only env var does nothing.
  const snap = baseSnapshot({
    monitoredAssetCount: 2000,
    activeQueueMode: "pgboss",
    pgbossPoolSize: 20,
  });
  const inputs = buildInputs(snap, {
    POLARIS_HEAVY_CONCURRENCY: 8,  // way below what cursor would need
    POLARIS_PROBE_CONCURRENCY: 8,
  });
  const state = buildAdvisorState(inputs);

  it("does not flag POLARIS_HEAVY_CONCURRENCY when recommendedQueueMode is pgboss", () => {
    expect(state.recommendedQueueMode).toBe("pgboss");
    const gaps = summarizeAdvisorGaps(state);
    // worstGap must not mention cursor-only levers.
    if (gaps.worstGap) {
      expect(gaps.worstGap).not.toContain("heavy_concurrency");
      expect(gaps.worstGap).not.toContain("probe_concurrency");
    }
  });
});

describe("buildAdvisorState — never recommends shrinking", () => {
  const snap = baseSnapshot({ monitoredAssetCount: 50, activeQueueMode: "cursor" });
  const inputs = buildInputs(snap, {
    DATABASE_POOL_SIZE: 200, // operator has manually over-provisioned
    POLARIS_MONITOR_HEAVY_WORKERS: 96,
  });
  const state = buildAdvisorState(inputs);

  it("keeps prisma pool at the larger current value", () => {
    const prisma = state.recommendations.find((r) => r.key === "DATABASE_POOL_SIZE")!;
    expect(prisma.recommended).toBe(200);
    expect(prisma.changeRequired).toBe(false);
  });
  it("keeps heavy workers at the larger current value", () => {
    const heavy = state.recommendations.find((r) => r.key === "POLARIS_MONITOR_HEAVY_WORKERS")!;
    expect(heavy.recommended).toBe(96);
    expect(heavy.changeRequired).toBe(false);
  });
});

describe("buildAdvisorState — discovered-only assets don't change the recommendation", () => {
  // The advisor consumes monitoredAssetCount + monitoredInterfaceCount only.
  // Whatever the total Asset rowcount is in the DB has no effect — this test
  // documents that contract by holding the monitored counts fixed and
  // ensuring the recommendation is stable.
  const snapA = baseSnapshot({ monitoredAssetCount: 200, monitoredInterfaceCount: 50 });
  const snapB = baseSnapshot({ monitoredAssetCount: 200, monitoredInterfaceCount: 50 });
  // (Snapshots are structurally identical — discovered-only counts aren't
  // even passed through, which is the point.)
  const stateA = buildAdvisorState(buildInputs(snapA));
  const stateB = buildAdvisorState(buildInputs(snapB));
  it("produces matching recommendations regardless of total inventory", () => {
    const aPrisma = stateA.recommendations.find((r) => r.key === "DATABASE_POOL_SIZE")!.recommended;
    const bPrisma = stateB.recommendations.find((r) => r.key === "DATABASE_POOL_SIZE")!.recommended;
    expect(aPrisma).toBe(bPrisma);
  });
});

describe("COLD_START_MIN_SAMPLES is exported", () => {
  it("matches the documented threshold (100)", () => {
    expect(COLD_START_MIN_SAMPLES).toBe(100);
  });
});

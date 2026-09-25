/**
 * src/services/sampleHistoryService.ts
 *
 * Tier-aware readers for the six chart history endpoints. Phase 4 of the
 * tiered sample-retention work. Each function takes (assetId, since, until,
 * tier[, extraKey, fetchSince]) and returns serialised sample rows + stats
 * matching the existing response shape the chart renderers expect, with two
 * additions on rollup tiers:
 *
 * `fetchSince` is the optional **lookback overflow** boundary — when set,
 * the query window extends to `[fetchSince, until]` so the rendered chart
 * has at least one sample BEFORE the visible window, letting the polyline
 * enter the chart area from the left edge instead of starting partway
 * through. Stats are still computed from samples within `[since, until]`
 * so the operator-visible counts and averages match the visible window
 * (overflow rows are for line continuity only). Defaults to `since` when
 * omitted, in which case behavior is unchanged. See the "Time-series chart
 * (SVG)" section of polaris-ui-canon for the convention.
 *
 *   - Gauge tables (monitor, telemetry, temperature, storage):
 *     samples keep the SAME field names the detail tier emits — e.g.
 *     `responseTimeMs`, `cpuPct`, `celsius`, `usedBytes`. On rollup tier
 *     those values are bucket averages instead of point measurements;
 *     `min*` / `max*` siblings + `sampleCount` are added so tooltips can
 *     show the bucket spread.
 *
 *   - Counter tables (interface, ipsec): rollup samples ADD pre-computed
 *     rate fields (`inBytesPerSec`, `outBytesPerSec`, ..., or
 *     `incomingBytesPerSec` / `outgoingBytesPerSec` for ipsec) computed
 *     from the bucket's first/last counter endpoints. Cumulative counter
 *     fields (`inOctets`, `incomingBytes`, ...) are intentionally OMITTED
 *     on rollup tiers — those values are only meaningful as deltas, and
 *     the rate is what the chart actually plots. The frontend branches
 *     on `bucketSeconds > 0` to read the rate fields directly instead of
 *     diffing consecutive cumulative samples (which is what detail tier
 *     still needs).
 *
 * BigInt → number coercion at the boundary, same as the existing
 * `bigIntToNumber()` helper in routes/assets.ts. Octets up to 2^53-1
 * (≈9 PB) fit safely.
 */

import { prisma } from "../db.js";
import type { SampleTier } from "./sampleQueryRouter.js";

function bn(v: bigint | null | undefined): number | null {
  if (v == null) return null;
  return Number(v);
}

/**
 * Narrow `AssetTelemetrySample.cpuCorePcts` (jsonb, therefore `JsonValue` to
 * Prisma) to the number vector the chart wants.
 *
 * jsonb is schemaless from the database's point of view, so this is the
 * boundary where the shape is actually checked rather than asserted — an
 * older agent, a hand-written row or a future shape change reaches here as
 * whatever it is, and anything that is not a finite-number array becomes
 * null (charted as "no per-core data") instead of reaching the browser as a
 * ragged array that renders as NaN coordinates in an SVG path.
 */
function coreVector(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: number[] = [];
  for (const x of v) {
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    out.push(x);
  }
  return out;
}

/**
 * Counter-rate helper. `first` and `last` are cumulative counter values at
 * the boundaries of a bucket; `bucketStart` and `lastBucketSampleAt` give
 * the time delta. Returns null on missing endpoints or counter resets
 * (negative deltas), matching the detail-tier client-side diff behavior.
 */
function rate(first: number | null, last: number | null, bucketStartMs: number, lastSampleAtMs: number): number | null {
  if (first == null || last == null) return null;
  const delta = last - first;
  if (delta < 0) return null; // counter reset
  const seconds = (lastSampleAtMs - bucketStartMs) / 1000;
  if (seconds <= 0) return 0;
  return delta / seconds;
}

// ─── Monitor history (response time) ─────────────────────────────────────────

export interface MonitorHistoryRow {
  timestamp:      Date;
  success?:       boolean;   // detail only
  /** Detail only — a failure taken while the parent was dark (drawn grey). */
  dependencyDown?: boolean | null;
  responseTimeMs: number | null;
  error?:         string | null;
  // Rollup-only:
  sampleCount?:       number;
  successCount?:      number;
  failureCount?:      number;
  /** Rollup only — how many of `failureCount` were dependency-suppressed. */
  dependencyFailureCount?: number | null;
  minResponseTimeMs?: number | null;
  maxResponseTimeMs?: number | null;
}

export interface MonitorHistoryResult {
  samples: MonitorHistoryRow[];
  stats: {
    total: number;
    failed: number;
    successRate: number | null;
    packetLossRate: number | null;
    avgMs: number | null;
    minMs: number | null;
    maxMs: number | null;
  };
}

export async function readMonitorHistory(
  assetId: string,
  since: Date,
  until: Date,
  tier: SampleTier,
  fetchSince?: Date,
): Promise<MonitorHistoryResult> {
  const queryFrom = fetchSince ?? since;
  const sinceMs = since.getTime();
  if (tier === "detail") {
    const rows = await prisma.assetMonitorSample.findMany({
      // Response-time poll only, matching the hourly/daily rollups this same
      // function reads at coarser tiers — otherwise the panel's packet-loss
      // and sample counts would change meaning as the operator widened the
      // range. The dense ICMP sampler rows serve the probeLossPct metric, the
      // NOC Packet Loss widget and the alert-email loss chart.
      where: { assetId, timestamp: { gte: queryFrom, lte: until }, OR: [{ probeKind: null }, { probeKind: "primary" }] },
      orderBy: { timestamp: "asc" },
      select: { timestamp: true, success: true, responseTimeMs: true, error: true, dependencyDown: true },
    });
    const visible = rows.filter((s) => s.timestamp.getTime() >= sinceMs);
    const total = visible.length;
    const failed = visible.filter((s) => !s.success).length;
    const ok = visible.filter((s) => s.success && typeof s.responseTimeMs === "number").map((s) => s.responseTimeMs as number);
    return {
      samples: rows,
      stats: {
        total,
        failed,
        successRate: total ? (total - failed) / total : null,
        packetLossRate: total ? failed / total : null,
        avgMs: ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null,
        minMs: ok.length ? Math.min(...ok) : null,
        maxMs: ok.length ? Math.max(...ok) : null,
      },
    };
  }

  const table = tier === "hourly" ? "asset_monitor_samples_hourly" : "asset_monitor_samples_daily";
  const rows = await prisma.$queryRawUnsafe<Array<{
    bucketStart: Date;
    sampleCount: number;
    successCount: number;
    failureCount: number;
    dependencyFailureCount: number | null;
    avgResponseTimeMs: number | null;
    minResponseTimeMs: number | null;
    maxResponseTimeMs: number | null;
  }>>(
    `SELECT "bucketStart", "sampleCount", "successCount", "failureCount",
            "dependencyFailureCount",
            "avgResponseTimeMs", "minResponseTimeMs", "maxResponseTimeMs"
     FROM "${table}"
     WHERE "assetId" = $1 AND "bucketStart" >= $2 AND "bucketStart" <= $3
     ORDER BY "bucketStart" ASC`,
    assetId, queryFrom, until,
  );

  let total = 0, failed = 0;
  let weightedSum = 0, weightedCount = 0;
  let minMs: number | null = null, maxMs: number | null = null;
  for (const r of rows) {
    if (r.bucketStart.getTime() < sinceMs) continue;
    total += r.sampleCount;
    failed += r.failureCount;
    if (r.avgResponseTimeMs != null && r.successCount > 0) {
      weightedSum += r.avgResponseTimeMs * r.successCount;
      weightedCount += r.successCount;
    }
    if (r.minResponseTimeMs != null) minMs = minMs == null ? r.minResponseTimeMs : Math.min(minMs, r.minResponseTimeMs);
    if (r.maxResponseTimeMs != null) maxMs = maxMs == null ? r.maxResponseTimeMs : Math.max(maxMs, r.maxResponseTimeMs);
  }
  return {
    samples: rows.map((r) => ({
      timestamp:         r.bucketStart,
      responseTimeMs:    r.avgResponseTimeMs,
      sampleCount:       r.sampleCount,
      successCount:      r.successCount,
      failureCount:      r.failureCount,
      dependencyFailureCount: r.dependencyFailureCount,
      minResponseTimeMs: r.minResponseTimeMs,
      maxResponseTimeMs: r.maxResponseTimeMs,
    })),
    stats: {
      total,
      failed,
      successRate: total ? (total - failed) / total : null,
      packetLossRate: total ? failed / total : null,
      avgMs: weightedCount ? Math.round(weightedSum / weightedCount) : null,
      minMs,
      maxMs,
    },
  };
}

/**
 * Timestamp of the newest SUCCESSFUL probe at or after `since`, read from the
 * detail table regardless of which tier the chart itself is rendering.
 *
 * The chart's stale banner ("Last successful update X ago") can't be derived
 * from a rollup sample: a rollup row's `timestamp` is its `bucketStart`, so on
 * the daily tier the newest point is up to 24h "old" by construction (and the
 * daily rollup itself only runs once a day at 02:30 UTC, so today's bucket
 * covers only the first hours of the UTC day). Measuring freshness off that
 * makes a perfectly healthy 1-minute probe look 17h stale the moment the
 * operator switches to 30d. Detail samples carry real timestamps, so ask them.
 *
 * Returns null when the detail tier holds no success in the window — either
 * the probe has genuinely been failing that long, or the last success predates
 * detail retention. Callers fall back to the rollup-derived value there.
 */
export async function readLastMonitorSuccessAt(assetId: string, since: Date): Promise<Date | null> {
  const row = await prisma.assetMonitorSample.findFirst({
    // Response-time poll only: a device whose SNMP agent is dead still answers
    // ping, and counting that as a success would report the monitored service
    // as recently healthy when it has not answered in hours.
    where: { assetId, success: true, timestamp: { gte: since }, OR: [{ probeKind: null }, { probeKind: "primary" }] },
    orderBy: { timestamp: "desc" },
    select: { timestamp: true },
  });
  return row?.timestamp ?? null;
}

// ─── Telemetry history (CPU + memory) ────────────────────────────────────────

export interface TelemetryHistoryRow {
  timestamp:        Date;
  cpuPct:           number | null;
  // Per-logical-core utilisation, index = core id. DETAIL TIER ONLY — the
  // rollups do not carry it, so this is undefined on hourly/daily and the
  // CPU chart falls back to the aggregate line and says why. null (rather
  // than undefined) means the tier COULD carry it and this source did not.
  cpuCorePcts?:     number[] | null;
  memPct:           number | null;
  memUsedBytes:     number | null;
  memTotalBytes:    number | null;
  // Memory breakdown bands (bytes). Present on every tier; null when the
  // source reports no breakdown. The four sum to memTotalBytes when they
  // are present at all — see the agent's meminfo.go.
  memBuffersBytes?: number | null;
  memCachedBytes?:  number | null;
  memFreeBytes?:    number | null;
  swapUsedBytes?:   number | null;
  swapTotalBytes?:  number | null;
  // The vCenter band set, also on every tier. Disjoint from the agent's
  // above: a VM partitions its configured RAM into private / shared /
  // ballooned / swapped / compressed, an ESXi host partitions installed RAM
  // into consumed / ballooned / swapped. A row carries one set or neither,
  // and the chart picks its band table from whichever arrived.
  memPrivateBytes?:    number | null;
  memSharedBytes?:     number | null;
  memBalloonedBytes?:  number | null;
  memSwappedBytes?:    number | null;
  memCompressedBytes?: number | null;
  memConsumedBytes?:   number | null;
  // FortiGate active session count (null for other sources). On detail tier
  // this is the raw value; on rollup tiers it's the bucket average, with
  // min/max alongside.
  sessionCount?:    number | null;
  sampleCount?:     number;
  minCpuPct?:       number | null;
  maxCpuPct?:       number | null;
  minMemPct?:       number | null;
  maxMemPct?:       number | null;
  minSessionCount?: number | null;
  maxSessionCount?: number | null;
}

export interface TelemetryHistoryResult {
  samples: TelemetryHistoryRow[];
  stats: {
    total: number;
    avgCpuPct: number | null;
    maxCpuPct: number | null;
    avgMemPct: number | null;
    maxMemPct: number | null;
  };
}

export async function readTelemetryHistory(
  assetId: string,
  since: Date,
  until: Date,
  tier: SampleTier,
  fetchSince?: Date,
): Promise<TelemetryHistoryResult> {
  const queryFrom = fetchSince ?? since;
  const sinceMs = since.getTime();
  if (tier === "detail") {
    const samples = await prisma.assetTelemetrySample.findMany({
      where: { assetId, timestamp: { gte: queryFrom, lte: until } },
      orderBy: { timestamp: "asc" },
      select: {
        timestamp: true, cpuPct: true, cpuCorePcts: true,
        memPct: true, memUsedBytes: true, memTotalBytes: true,
        memBuffersBytes: true, memCachedBytes: true, memFreeBytes: true,
        swapUsedBytes: true, swapTotalBytes: true,
        memPrivateBytes: true, memSharedBytes: true, memBalloonedBytes: true,
        memSwappedBytes: true, memCompressedBytes: true, memConsumedBytes: true,
        sessionCount: true,
      },
    });
    const rows: TelemetryHistoryRow[] = samples.map((s) => ({
      timestamp:     s.timestamp,
      cpuPct:        s.cpuPct,
      cpuCorePcts:   coreVector(s.cpuCorePcts),
      memPct:        s.memPct,
      memUsedBytes:  bn(s.memUsedBytes),
      memTotalBytes: bn(s.memTotalBytes),
      memBuffersBytes: bn(s.memBuffersBytes),
      memCachedBytes:  bn(s.memCachedBytes),
      memFreeBytes:    bn(s.memFreeBytes),
      swapUsedBytes:   bn(s.swapUsedBytes),
      swapTotalBytes:  bn(s.swapTotalBytes),
      memPrivateBytes:    bn(s.memPrivateBytes),
      memSharedBytes:     bn(s.memSharedBytes),
      memBalloonedBytes:  bn(s.memBalloonedBytes),
      memSwappedBytes:    bn(s.memSwappedBytes),
      memCompressedBytes: bn(s.memCompressedBytes),
      memConsumedBytes:   bn(s.memConsumedBytes),
      sessionCount:  s.sessionCount,
    }));
    const visible = rows.filter((r) => r.timestamp.getTime() >= sinceMs);
    const cpus = visible.map((r) => r.cpuPct).filter((x): x is number => typeof x === "number");
    const mems = visible.map((r) => r.memPct ?? (r.memTotalBytes && r.memUsedBytes ? (r.memUsedBytes / r.memTotalBytes) * 100 : null))
                     .filter((x): x is number => typeof x === "number");
    return {
      samples: rows,
      stats: {
        total:     visible.length,
        avgCpuPct: cpus.length ? cpus.reduce((a, b) => a + b, 0) / cpus.length : null,
        maxCpuPct: cpus.length ? Math.max(...cpus) : null,
        avgMemPct: mems.length ? mems.reduce((a, b) => a + b, 0) / mems.length : null,
        maxMemPct: mems.length ? Math.max(...mems) : null,
      },
    };
  }

  const table = tier === "hourly" ? "asset_telemetry_samples_hourly" : "asset_telemetry_samples_daily";
  const rows = await prisma.$queryRawUnsafe<Array<{
    bucketStart: Date;
    sampleCount: number;
    avgCpuPct: number | null; minCpuPct: number | null; maxCpuPct: number | null;
    avgMemPct: number | null; minMemPct: number | null; maxMemPct: number | null;
    avgMemUsedBytes: bigint | null;
    maxMemUsedBytes: bigint | null;
    lastMemTotalBytes: bigint | null;
    avgMemBuffersBytes: bigint | null;
    avgMemCachedBytes: bigint | null;
    avgMemFreeBytes: bigint | null;
    avgSwapUsedBytes: bigint | null;
    lastSwapTotalBytes: bigint | null;
    avgMemPrivateBytes: bigint | null;
    avgMemSharedBytes: bigint | null;
    avgMemBalloonedBytes: bigint | null;
    avgMemSwappedBytes: bigint | null;
    avgMemCompressedBytes: bigint | null;
    avgMemConsumedBytes: bigint | null;
    avgSessionCount: number | null; minSessionCount: number | null; maxSessionCount: number | null;
  }>>(
    `SELECT "bucketStart", "sampleCount",
            "avgCpuPct", "minCpuPct", "maxCpuPct",
            "avgMemPct", "minMemPct", "maxMemPct",
            "avgMemUsedBytes", "maxMemUsedBytes", "lastMemTotalBytes",
            "avgMemBuffersBytes", "avgMemCachedBytes", "avgMemFreeBytes",
            "avgSwapUsedBytes", "lastSwapTotalBytes",
            "avgMemPrivateBytes", "avgMemSharedBytes", "avgMemBalloonedBytes",
            "avgMemSwappedBytes", "avgMemCompressedBytes", "avgMemConsumedBytes",
            "avgSessionCount", "minSessionCount", "maxSessionCount"
     FROM "${table}"
     WHERE "assetId" = $1 AND "bucketStart" >= $2 AND "bucketStart" <= $3
     ORDER BY "bucketStart" ASC`,
    assetId, queryFrom, until,
  );

  let total = 0;
  let cpuWeightedSum = 0, cpuWeightedCount = 0, cpuMax: number | null = null;
  let memWeightedSum = 0, memWeightedCount = 0, memMax: number | null = null;
  const out: TelemetryHistoryRow[] = rows.map((r) => {
    if (r.bucketStart.getTime() >= sinceMs) {
      total += r.sampleCount;
      if (r.avgCpuPct != null) { cpuWeightedSum += r.avgCpuPct * r.sampleCount; cpuWeightedCount += r.sampleCount; }
      if (r.maxCpuPct != null) cpuMax = cpuMax == null ? r.maxCpuPct : Math.max(cpuMax, r.maxCpuPct);
      if (r.avgMemPct != null) { memWeightedSum += r.avgMemPct * r.sampleCount; memWeightedCount += r.sampleCount; }
      if (r.maxMemPct != null) memMax = memMax == null ? r.maxMemPct : Math.max(memMax, r.maxMemPct);
    }
    return {
      timestamp:     r.bucketStart,
      cpuPct:        r.avgCpuPct,
      memPct:        r.avgMemPct,
      memUsedBytes:  bn(r.avgMemUsedBytes),
      memTotalBytes: bn(r.lastMemTotalBytes),
      // cpuCorePcts is deliberately ABSENT on the rollup tiers (not null):
      // the chart distinguishes "this tier cannot carry per-core" from
      // "this source does not report per-core" and words its note
      // differently for each.
      memBuffersBytes: bn(r.avgMemBuffersBytes),
      memCachedBytes:  bn(r.avgMemCachedBytes),
      memFreeBytes:    bn(r.avgMemFreeBytes),
      swapUsedBytes:   bn(r.avgSwapUsedBytes),
      swapTotalBytes:  bn(r.lastSwapTotalBytes),
      memPrivateBytes:    bn(r.avgMemPrivateBytes),
      memSharedBytes:     bn(r.avgMemSharedBytes),
      memBalloonedBytes:  bn(r.avgMemBalloonedBytes),
      memSwappedBytes:    bn(r.avgMemSwappedBytes),
      memCompressedBytes: bn(r.avgMemCompressedBytes),
      memConsumedBytes:   bn(r.avgMemConsumedBytes),
      sessionCount:  r.avgSessionCount,
      sampleCount:   r.sampleCount,
      minCpuPct:     r.minCpuPct,
      maxCpuPct:     r.maxCpuPct,
      minMemPct:     r.minMemPct,
      maxMemPct:     r.maxMemPct,
      minSessionCount: r.minSessionCount,
      maxSessionCount: r.maxSessionCount,
    };
  });
  return {
    samples: out,
    stats: {
      total,
      avgCpuPct: cpuWeightedCount ? cpuWeightedSum / cpuWeightedCount : null,
      maxCpuPct: cpuMax,
      avgMemPct: memWeightedCount ? memWeightedSum / memWeightedCount : null,
      maxMemPct: memMax,
    },
  };
}

// ─── Hardware-sensor history (per sensor; mixed classes/units) ───────────────
//
// One series per sensor. `value` is the reading in `unit` (°C, RPM, V, …);
// `sensorClass` lets the UI group/label. `alarmStatus` rides the detail tier
// only (not aggregatable). The rollup tiers carry avg/min/max of `value`.

export interface HardwareSensorHistoryRow {
  timestamp:    Date;
  sensorName:   string;
  sensorClass:  string;
  unit:         string | null;
  value:        number | null;
  alarmStatus?: string | null;
  sampleCount?: number;
  minValue?:    number | null;
  maxValue?:    number | null;
}

export interface HardwareSensorHistoryResult {
  samples: HardwareSensorHistoryRow[];
  stats: {
    total: number;
    avgValue: number | null;
    minValue: number | null;
    maxValue: number | null;
  };
}

export async function readHardwareSensorHistory(
  assetId: string,
  since: Date,
  until: Date,
  tier: SampleTier,
  sensorName: string | null,
  fetchSince?: Date,
): Promise<HardwareSensorHistoryResult> {
  const queryFrom = fetchSince ?? since;
  const sinceMs = since.getTime();
  if (tier === "detail") {
    const samples = await prisma.assetHardwareSensorSample.findMany({
      where: { assetId, timestamp: { gte: queryFrom, lte: until }, ...(sensorName ? { sensorName } : {}) },
      orderBy: { timestamp: "asc" },
    });
    const rows: HardwareSensorHistoryRow[] = samples.map((s) => ({
      timestamp:   s.timestamp,
      sensorName:  s.sensorName,
      sensorClass: s.sensorClass,
      unit:        s.unit,
      value:       s.value,
      alarmStatus: s.alarmStatus,
    }));
    const visible = rows.filter((r) => r.timestamp.getTime() >= sinceMs);
    const vs = visible.map((r) => r.value).filter((x): x is number => typeof x === "number");
    return {
      samples: rows,
      stats: {
        total:    visible.length,
        avgValue: vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null,
        minValue: vs.length ? Math.min(...vs) : null,
        maxValue: vs.length ? Math.max(...vs) : null,
      },
    };
  }

  const table = tier === "hourly" ? "asset_hardware_sensor_samples_hourly" : "asset_hardware_sensor_samples_daily";
  const params: unknown[] = [assetId, queryFrom, until];
  let where = `"assetId" = $1 AND "bucketStart" >= $2 AND "bucketStart" <= $3`;
  if (sensorName) {
    params.push(sensorName);
    where += ` AND "sensorName" = $4`;
  }
  const rows = await prisma.$queryRawUnsafe<Array<{
    bucketStart: Date;
    sensorName: string;
    sensorClass: string;
    unit: string | null;
    sampleCount: number;
    avgValue: number | null;
    minValue: number | null;
    maxValue: number | null;
  }>>(
    `SELECT "bucketStart", "sensorName", "sensorClass", "unit", "sampleCount", "avgValue", "minValue", "maxValue"
     FROM "${table}"
     WHERE ${where}
     ORDER BY "bucketStart" ASC`,
    ...params,
  );

  let total = 0;
  let weightedSum = 0, weightedCount = 0;
  let vmin: number | null = null, vmax: number | null = null;
  const out: HardwareSensorHistoryRow[] = rows.map((r) => {
    if (r.bucketStart.getTime() >= sinceMs) {
      total += r.sampleCount;
      if (r.avgValue != null) { weightedSum += r.avgValue * r.sampleCount; weightedCount += r.sampleCount; }
      if (r.minValue != null) vmin = vmin == null ? r.minValue : Math.min(vmin, r.minValue);
      if (r.maxValue != null) vmax = vmax == null ? r.maxValue : Math.max(vmax, r.maxValue);
    }
    return {
      timestamp:   r.bucketStart,
      sensorName:  r.sensorName,
      sensorClass: r.sensorClass,
      unit:        r.unit,
      value:       r.avgValue,
      sampleCount: r.sampleCount,
      minValue:    r.minValue,
      maxValue:    r.maxValue,
    };
  });
  return {
    samples: out,
    stats: {
      total,
      avgValue: weightedCount ? weightedSum / weightedCount : null,
      minValue: vmin,
      maxValue: vmax,
    },
  };
}

// ─── Storage history (per mountpoint) ────────────────────────────────────────

export interface StorageHistoryRow {
  timestamp:  Date;
  totalBytes: number | null;
  usedBytes:  number | null;
  sampleCount?:  number;
  minUsedBytes?: number | null;
  maxUsedBytes?: number | null;
}

export async function readStorageHistory(
  assetId: string,
  since: Date,
  until: Date,
  tier: SampleTier,
  mountPath: string,
  fetchSince?: Date,
): Promise<{ samples: StorageHistoryRow[] }> {
  const queryFrom = fetchSince ?? since;
  if (tier === "detail") {
    const samples = await prisma.assetStorageSample.findMany({
      where: { assetId, mountPath, timestamp: { gte: queryFrom, lte: until } },
      orderBy: { timestamp: "asc" },
    });
    return {
      samples: samples.map((s) => ({
        timestamp:  s.timestamp,
        totalBytes: bn(s.totalBytes),
        usedBytes:  bn(s.usedBytes),
      })),
    };
  }

  const table = tier === "hourly" ? "asset_storage_samples_hourly" : "asset_storage_samples_daily";
  const rows = await prisma.$queryRawUnsafe<Array<{
    bucketStart: Date;
    sampleCount: number;
    avgUsedBytes: bigint | null;
    minUsedBytes: bigint | null;
    maxUsedBytes: bigint | null;
    lastTotalBytes: bigint | null;
  }>>(
    `SELECT "bucketStart", "sampleCount", "avgUsedBytes", "minUsedBytes", "maxUsedBytes", "lastTotalBytes"
     FROM "${table}"
     WHERE "assetId" = $1 AND "mountPath" = $2 AND "bucketStart" >= $3 AND "bucketStart" <= $4
     ORDER BY "bucketStart" ASC`,
    assetId, mountPath, queryFrom, until,
  );
  return {
    samples: rows.map((r) => ({
      timestamp:    r.bucketStart,
      totalBytes:   bn(r.lastTotalBytes),
      usedBytes:    bn(r.avgUsedBytes),
      sampleCount:  r.sampleCount,
      minUsedBytes: bn(r.minUsedBytes),
      maxUsedBytes: bn(r.maxUsedBytes),
    })),
  };
}

// ─── Process history (per pinned program — two gauges: cpu%, rss bytes) ──────

export interface ProcessHistoryRow {
  timestamp:     Date;
  cpuPct:        number | null;
  memRssBytes:   number | null;
  instanceCount?: number | null;
  sampleCount?:  number;
  minCpuPct?:    number | null;
  maxCpuPct?:    number | null;
  minMemRssBytes?: number | null;
  maxMemRssBytes?: number | null;
}

export async function readProcessHistory(
  assetId: string,
  since: Date,
  until: Date,
  tier: SampleTier,
  name: string,
  fetchSince?: Date,
): Promise<{ samples: ProcessHistoryRow[] }> {
  const queryFrom = fetchSince ?? since;
  if (tier === "detail") {
    const samples = await prisma.assetProcessSample.findMany({
      where: { assetId, name, timestamp: { gte: queryFrom, lte: until } },
      orderBy: { timestamp: "asc" },
    });
    return {
      samples: samples.map((s) => ({
        timestamp:     s.timestamp,
        cpuPct:        s.cpuPct,
        memRssBytes:   bn(s.memRssBytes),
        instanceCount: s.instanceCount,
      })),
    };
  }

  const table = tier === "hourly" ? "asset_process_samples_hourly" : "asset_process_samples_daily";
  const rows = await prisma.$queryRawUnsafe<Array<{
    bucketStart: Date;
    sampleCount: number;
    avgCpuPct: number | null;
    minCpuPct: number | null;
    maxCpuPct: number | null;
    avgMemRssBytes: bigint | null;
    minMemRssBytes: bigint | null;
    maxMemRssBytes: bigint | null;
  }>>(
    `SELECT "bucketStart", "sampleCount", "avgCpuPct", "minCpuPct", "maxCpuPct",
            "avgMemRssBytes", "minMemRssBytes", "maxMemRssBytes"
     FROM "${table}"
     WHERE "assetId" = $1 AND "name" = $2 AND "bucketStart" >= $3 AND "bucketStart" <= $4
     ORDER BY "bucketStart" ASC`,
    assetId, name, queryFrom, until,
  );
  return {
    samples: rows.map((r) => ({
      timestamp:       r.bucketStart,
      cpuPct:          r.avgCpuPct,
      memRssBytes:     bn(r.avgMemRssBytes),
      sampleCount:     r.sampleCount,
      minCpuPct:       r.minCpuPct,
      maxCpuPct:       r.maxCpuPct,
      minMemRssBytes:  bn(r.minMemRssBytes),
      maxMemRssBytes:  bn(r.maxMemRssBytes),
    })),
  };
}

// ─── Interface history (counter table) ───────────────────────────────────────

export interface InterfaceHistoryRow {
  timestamp:   Date;
  adminStatus: string | null;
  operStatus:  string | null;
  speedBps:    number | null;
  ipAddress:   string | null;
  macAddress:  string | null;
  // Detail-tier counter values (cumulative). Omitted on rollup tier.
  inOctets?:   number | null;
  outOctets?:  number | null;
  inErrors?:   number | null;
  outErrors?:  number | null;
  // Rollup-tier pre-computed rates (bytes/sec, errors/sec). Omitted on detail.
  inBytesPerSec?:  number | null;
  outBytesPerSec?: number | null;
  inErrorsPerSec?:  number | null;
  outErrorsPerSec?: number | null;
  sampleCount?:    number;
}

export interface InterfaceHistoryMeta {
  alias:                  string | null;
  description:            string | null;
  discoveredDescription:  string | null;
  overrideDescription:    string | null;
}

export async function readInterfaceHistory(
  assetId: string,
  since: Date,
  until: Date,
  tier: SampleTier,
  ifName: string,
  fetchSince?: Date,
): Promise<{ samples: InterfaceHistoryRow[]; meta: InterfaceHistoryMeta }> {
  const queryFrom = fetchSince ?? since;
  if (tier === "detail") {
    const samples = await prisma.assetInterfaceSample.findMany({
      where: { assetId, ifName, timestamp: { gte: queryFrom, lte: until } },
      orderBy: { timestamp: "asc" },
    });
    const latest = samples.length > 0 ? samples[samples.length - 1] : null;
    return {
      samples: samples.map((s) => ({
        timestamp:   s.timestamp,
        adminStatus: s.adminStatus,
        operStatus:  s.operStatus,
        speedBps:    bn(s.speedBps),
        ipAddress:   s.ipAddress,
        macAddress:  s.macAddress,
        inOctets:    bn(s.inOctets),
        outOctets:   bn(s.outOctets),
        inErrors:    bn(s.inErrors),
        outErrors:   bn(s.outErrors),
      })),
      meta: {
        alias:                 latest?.alias       ?? null,
        description:           null, // resolved by caller with override merge
        discoveredDescription: latest?.description ?? null,
        overrideDescription:   null,
      },
    };
  }

  const table = tier === "hourly" ? "asset_interface_samples_hourly" : "asset_interface_samples_daily";
  const rows = await prisma.$queryRawUnsafe<Array<{
    bucketStart: Date;
    sampleCount: number;
    firstInOctets: bigint | null; lastInOctets: bigint | null;
    firstOutOctets: bigint | null; lastOutOctets: bigint | null;
    firstInErrors: bigint | null; lastInErrors: bigint | null;
    firstOutErrors: bigint | null; lastOutErrors: bigint | null;
    maxSpeedBps: bigint | null;
    lastAdminStatus: string | null;
    lastOperStatus: string | null;
    lastIpAddress: string | null;
    lastMacAddress: string | null;
    lastAlias: string | null;
    lastDescription: string | null;
    lastBucketSampleAt: Date;
  }>>(
    `SELECT "bucketStart", "sampleCount",
            "firstInOctets", "lastInOctets",
            "firstOutOctets", "lastOutOctets",
            "firstInErrors", "lastInErrors",
            "firstOutErrors", "lastOutErrors",
            "maxSpeedBps",
            "lastAdminStatus", "lastOperStatus",
            "lastIpAddress", "lastMacAddress",
            "lastAlias", "lastDescription",
            "lastBucketSampleAt"
     FROM "${table}"
     WHERE "assetId" = $1 AND "ifName" = $2 AND "bucketStart" >= $3 AND "bucketStart" <= $4
     ORDER BY "bucketStart" ASC`,
    assetId, ifName, queryFrom, until,
  );

  let latestAlias: string | null = null;
  let latestDesc:  string | null = null;
  const samples: InterfaceHistoryRow[] = rows.map((r) => {
    if (r.lastAlias       != null) latestAlias = r.lastAlias;
    if (r.lastDescription != null) latestDesc  = r.lastDescription;
    const startMs = r.bucketStart.getTime();
    const lastMs  = r.lastBucketSampleAt.getTime();
    return {
      timestamp:       r.bucketStart,
      adminStatus:     r.lastAdminStatus,
      operStatus:      r.lastOperStatus,
      speedBps:        bn(r.maxSpeedBps),
      ipAddress:       r.lastIpAddress,
      macAddress:      r.lastMacAddress,
      inBytesPerSec:   rate(bn(r.firstInOctets),  bn(r.lastInOctets),  startMs, lastMs),
      outBytesPerSec:  rate(bn(r.firstOutOctets), bn(r.lastOutOctets), startMs, lastMs),
      inErrorsPerSec:  rate(bn(r.firstInErrors),  bn(r.lastInErrors),  startMs, lastMs),
      outErrorsPerSec: rate(bn(r.firstOutErrors), bn(r.lastOutErrors), startMs, lastMs),
      sampleCount:     r.sampleCount,
    };
  });
  return {
    samples,
    meta: {
      alias:                 latestAlias,
      description:           null,
      discoveredDescription: latestDesc,
      overrideDescription:   null,
    },
  };
}

// ─── IPsec history (counter table + status) ──────────────────────────────────

export interface IpsecHistoryRow {
  timestamp:     Date;
  status:        string; // "up" | "down" | "partial" | "dynamic" (detail value or dominant in bucket)
  remoteGateway: string | null;
  // Detail-only cumulative bytes:
  incomingBytes?: number | null;
  outgoingBytes?: number | null;
  // Rollup-only pre-computed rates + status counts:
  incomingBytesPerSec?: number | null;
  outgoingBytesPerSec?: number | null;
  statusUpCount?:      number;
  statusDownCount?:    number;
  statusPartialCount?: number;
  statusDynamicCount?: number;
  proxyIdCount:    number | null;
  sampleCount?:    number;
}

function dominantStatus(up: number, down: number, partial: number, dynamic: number): string {
  // Pick whichever status saw the most samples in the bucket. Ties go to
  // the worse status: down > partial > dynamic > up, so a flapping tunnel
  // never looks healthier than its worst observed state.
  const ranked: Array<[string, number]> = [
    ["down", down], ["partial", partial], ["dynamic", dynamic], ["up", up],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  return ranked[0][0];
}

export async function readIpsecHistory(
  assetId: string,
  since: Date,
  until: Date,
  tier: SampleTier,
  tunnelName: string,
  fetchSince?: Date,
): Promise<{ samples: IpsecHistoryRow[] }> {
  const queryFrom = fetchSince ?? since;
  if (tier === "detail") {
    const samples = await prisma.assetIpsecTunnelSample.findMany({
      where: { assetId, tunnelName, timestamp: { gte: queryFrom, lte: until } },
      orderBy: { timestamp: "asc" },
    });
    return {
      samples: samples.map((s) => ({
        timestamp:     s.timestamp,
        status:        s.status,
        remoteGateway: s.remoteGateway,
        incomingBytes: bn(s.incomingBytes),
        outgoingBytes: bn(s.outgoingBytes),
        proxyIdCount:  s.proxyIdCount,
      })),
    };
  }

  const table = tier === "hourly" ? "asset_ipsec_tunnel_samples_hourly" : "asset_ipsec_tunnel_samples_daily";
  const rows = await prisma.$queryRawUnsafe<Array<{
    bucketStart: Date;
    sampleCount: number;
    statusUpCount: number; statusDownCount: number; statusPartialCount: number; statusDynamicCount: number;
    firstIncomingBytes: bigint | null; lastIncomingBytes: bigint | null;
    firstOutgoingBytes: bigint | null; lastOutgoingBytes: bigint | null;
    lastRemoteGateway: string | null;
    lastProxyIdCount: number | null;
    lastBucketSampleAt: Date;
  }>>(
    `SELECT "bucketStart", "sampleCount",
            "statusUpCount", "statusDownCount", "statusPartialCount", "statusDynamicCount",
            "firstIncomingBytes", "lastIncomingBytes",
            "firstOutgoingBytes", "lastOutgoingBytes",
            "lastRemoteGateway",
            "lastProxyIdCount",
            "lastBucketSampleAt"
     FROM "${table}"
     WHERE "assetId" = $1 AND "tunnelName" = $2 AND "bucketStart" >= $3 AND "bucketStart" <= $4
     ORDER BY "bucketStart" ASC`,
    assetId, tunnelName, queryFrom, until,
  );

  return {
    samples: rows.map((r) => {
      const startMs = r.bucketStart.getTime();
      const lastMs  = r.lastBucketSampleAt.getTime();
      return {
        timestamp:           r.bucketStart,
        status:              dominantStatus(r.statusUpCount, r.statusDownCount, r.statusPartialCount, r.statusDynamicCount),
        remoteGateway:       r.lastRemoteGateway,
        incomingBytesPerSec: rate(bn(r.firstIncomingBytes), bn(r.lastIncomingBytes), startMs, lastMs),
        outgoingBytesPerSec: rate(bn(r.firstOutgoingBytes), bn(r.lastOutgoingBytes), startMs, lastMs),
        statusUpCount:       r.statusUpCount,
        statusDownCount:     r.statusDownCount,
        statusPartialCount:  r.statusPartialCount,
        statusDynamicCount:  r.statusDynamicCount,
        proxyIdCount:        r.lastProxyIdCount,
        sampleCount:         r.sampleCount,
      };
    }),
  };
}

// ─── SD-WAN Performance SLA history (gauge per health-check member) ───────────

export interface PerfSlaHistoryRow {
  timestamp:  Date;
  state:      string; // "up" | "down" (detail value, or dominant in bucket)
  latencyMs:  number | null;
  jitterMs:   number | null;
  packetLoss: number | null;
  // Rollup-tier extras (bucket spread); omitted on detail tier.
  minLatencyMs?:  number | null;
  maxLatencyMs?:  number | null;
  minJitterMs?:   number | null;
  maxJitterMs?:   number | null;
  minPacketLoss?: number | null;
  maxPacketLoss?: number | null;
  stateUpCount?:   number;
  stateDownCount?: number;
  sampleCount?:    number;
}

export async function readPerfSlaHistory(
  assetId: string,
  since: Date,
  until: Date,
  tier: SampleTier,
  healthCheck: string,
  link: string,
  fetchSince?: Date,
): Promise<{ samples: PerfSlaHistoryRow[] }> {
  const queryFrom = fetchSince ?? since;
  if (tier === "detail") {
    const samples = await prisma.assetPerfSlaSample.findMany({
      where: { assetId, healthCheck, link, timestamp: { gte: queryFrom, lte: until } },
      orderBy: { timestamp: "asc" },
    });
    return {
      samples: samples.map((s) => ({
        timestamp:  s.timestamp,
        state:      s.state,
        latencyMs:  s.latencyMs,
        jitterMs:   s.jitterMs,
        packetLoss: s.packetLoss,
      })),
    };
  }

  const table = tier === "hourly" ? "asset_perf_sla_samples_hourly" : "asset_perf_sla_samples_daily";
  const rows = await prisma.$queryRawUnsafe<Array<{
    bucketStart: Date;
    sampleCount: number;
    stateUpCount: number; stateDownCount: number;
    avgLatencyMs: number | null; minLatencyMs: number | null; maxLatencyMs: number | null;
    avgJitterMs: number | null; minJitterMs: number | null; maxJitterMs: number | null;
    avgPacketLoss: number | null; minPacketLoss: number | null; maxPacketLoss: number | null;
  }>>(
    `SELECT "bucketStart", "sampleCount", "stateUpCount", "stateDownCount",
            "avgLatencyMs", "minLatencyMs", "maxLatencyMs",
            "avgJitterMs", "minJitterMs", "maxJitterMs",
            "avgPacketLoss", "minPacketLoss", "maxPacketLoss"
     FROM "${table}"
     WHERE "assetId" = $1 AND "healthCheck" = $2 AND "link" = $3 AND "bucketStart" >= $4 AND "bucketStart" <= $5
     ORDER BY "bucketStart" ASC`,
    assetId, healthCheck, link, queryFrom, until,
  );

  return {
    samples: rows.map((r) => ({
      timestamp:      r.bucketStart,
      state:          r.stateDownCount > r.stateUpCount ? "down" : "up",
      latencyMs:      r.avgLatencyMs,
      jitterMs:       r.avgJitterMs,
      packetLoss:     r.avgPacketLoss,
      minLatencyMs:   r.minLatencyMs,
      maxLatencyMs:   r.maxLatencyMs,
      minJitterMs:    r.minJitterMs,
      maxJitterMs:    r.maxJitterMs,
      minPacketLoss:  r.minPacketLoss,
      maxPacketLoss:  r.maxPacketLoss,
      stateUpCount:   r.stateUpCount,
      stateDownCount: r.stateDownCount,
      sampleCount:    r.sampleCount,
    })),
  };
}

// ─── Agent-run path checks ───────────────────────────────────────────
//
// One (agent host, check) series. Detail rows carry the per-run verdict; rollup
// rows translate back to the SAME field names (latencyMs = the bucket average,
// ok = the bucket's majority verdict) plus the counts the availability chart
// and the status strip need: okCount / failCount / sampleCount.

export interface PathCheckHistoryRow {
  timestamp:  Date;
  ok:         boolean;
  latencyMs:  number | null;
  dnsMs:      number | null;
  connectMs:  number | null;
  tlsMs:      number | null;
  ttfbMs:     number | null;
  httpStatus: number | null;
  hopCount:   number | null;
  error?:     string | null;
  // Rollup-tier extras; omitted on the detail tier.
  minLatencyMs?: number | null;
  maxLatencyMs?: number | null;
  okCount?:      number;
  failCount?:    number;
  sampleCount?:  number;
}

export async function readPathCheckHistory(
  assetId: string,
  since: Date,
  until: Date,
  tier: SampleTier,
  checkId: string,
  fetchSince?: Date,
): Promise<{ samples: PathCheckHistoryRow[] }> {
  const queryFrom = fetchSince ?? since;
  if (tier === "detail") {
    const samples = await prisma.assetPathCheckSample.findMany({
      where: { assetId, checkId, timestamp: { gte: queryFrom, lte: until } },
      orderBy: { timestamp: "asc" },
      select: {
        timestamp: true, ok: true, latencyMs: true, dnsMs: true, connectMs: true,
        tlsMs: true, ttfbMs: true, httpStatus: true, hopCount: true, error: true,
      },
    });
    return { samples };
  }
  const table = tier === "hourly" ? "asset_path_check_samples_hourly" : "asset_path_check_samples_daily";
  const rows = await prisma.$queryRawUnsafe<Array<{
    bucketStart: Date;
    sampleCount: number; okCount: number; failCount: number;
    avgLatencyMs: number | null; minLatencyMs: number | null; maxLatencyMs: number | null;
    avgDnsMs: number | null; avgConnectMs: number | null; avgTlsMs: number | null; avgTtfbMs: number | null;
    avgHopCount: number | null; modeHttpStatus: number | null;
  }>>(
    `SELECT "bucketStart", "sampleCount", "okCount", "failCount",
            "avgLatencyMs", "minLatencyMs", "maxLatencyMs",
            "avgDnsMs", "avgConnectMs", "avgTlsMs", "avgTtfbMs",
            "avgHopCount", "modeHttpStatus"
     FROM "${table}"
     WHERE "assetId" = $1 AND "checkId" = $2 AND "bucketStart" >= $3 AND "bucketStart" <= $4
     ORDER BY "bucketStart" ASC`,
    assetId, checkId, queryFrom, until,
  );
  return {
    samples: rows.map((r) => ({
      timestamp:    r.bucketStart,
      ok:           r.okCount >= r.failCount,
      latencyMs:    r.avgLatencyMs,
      dnsMs:        r.avgDnsMs,
      connectMs:    r.avgConnectMs,
      tlsMs:        r.avgTlsMs,
      ttfbMs:       r.avgTtfbMs,
      httpStatus:   r.modeHttpStatus,
      hopCount:     r.avgHopCount === null ? null : Math.round(r.avgHopCount),
      minLatencyMs: r.minLatencyMs,
      maxLatencyMs: r.maxLatencyMs,
      okCount:      r.okCount,
      failCount:    r.failCount,
      sampleCount:  r.sampleCount,
    })),
  };
}

// ─── Polling-history summary (merge comparison) ──────────────────────────────
//
// "How much polling history does this asset have?" for the asset-merge
// comparison UI: the absorbed side's sample history is orphaned by a merge
// (no-FK hypertables — see assetMergeService's header), so the modal shows
// each side's history size and defaults the survivor to the longer one.
//
// Covers the two universal streams — monitor probes (response time / up-down)
// and cpu/mem telemetry — across all three retention tiers. The daily rollup
// holds the oldest history, detail the newest, so the span comes from the
// min/max over every tier. The sample count is STITCHED so overlapping
// coverage isn't double-counted: all of daily, plus hourly buckets past the
// last daily bucket's end, plus detail rows past the last hourly bucket's end.
// Rollup buckets are written on completed boundaries, so the stitch is exact
// up to the newest partial bucket — the UI presents the count as approximate.

export interface StreamHistorySummary {
  oldestAt: Date | null;
  newestAt: Date | null;
  sampleCount: number;
}

export interface PollingHistorySummary {
  oldestAt: Date | null;
  newestAt: Date | null;
  /** Whole days between oldestAt and newestAt (0 when empty or sub-day). */
  spanDays: number;
  /** monitor + telemetry stitched counts combined. */
  sampleCount: number;
  monitor: StreamHistorySummary;
  telemetry: StreamHistorySummary;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type MinMaxCountRow = { mn: Date | null; mx: Date | null; cnt: bigint | number };

async function streamHistorySummary(
  assetId: string,
  detailTable: string,
  hourlyTable: string,
  dailyTable: string,
): Promise<StreamHistorySummary> {
  // Table names are module-level constants below — never caller input.
  const daily = (await prisma.$queryRawUnsafe<MinMaxCountRow[]>(
    `SELECT min("bucketStart") AS mn, max("bucketStart") AS mx,
            COALESCE(sum("sampleCount"), 0)::bigint AS cnt
     FROM "${dailyTable}" WHERE "assetId" = $1`,
    assetId,
  ))[0];

  // Hourly buckets already covered by a daily bucket ([bucketStart, +1d)) are
  // excluded from the count; min/max stay unconditional for the span.
  const hourlyFrom = daily?.mx ? new Date(daily.mx.getTime() + DAY_MS) : null;
  const hourly = (await prisma.$queryRawUnsafe<MinMaxCountRow[]>(
    `SELECT min("bucketStart") AS mn, max("bucketStart") AS mx,
            COALESCE(sum("sampleCount") FILTER (WHERE $2::timestamptz IS NULL OR "bucketStart" >= $2::timestamptz), 0)::bigint AS cnt
     FROM "${hourlyTable}" WHERE "assetId" = $1`,
    assetId, hourlyFrom,
  ))[0];

  const detailFrom = hourly?.mx
    ? new Date(hourly.mx.getTime() + HOUR_MS)
    : hourlyFrom;
  const detail = (await prisma.$queryRawUnsafe<MinMaxCountRow[]>(
    `SELECT min("timestamp") AS mn, max("timestamp") AS mx,
            COALESCE(count(*) FILTER (WHERE $2::timestamptz IS NULL OR "timestamp" >= $2::timestamptz), 0)::bigint AS cnt
     FROM "${detailTable}" WHERE "assetId" = $1`,
    assetId, detailFrom,
  ))[0];

  const mins = [daily?.mn, hourly?.mn, detail?.mn].filter((d): d is Date => d != null);
  const maxs = [daily?.mx, hourly?.mx, detail?.mx].filter((d): d is Date => d != null);
  return {
    oldestAt: mins.length ? new Date(Math.min(...mins.map((d) => d.getTime()))) : null,
    newestAt: maxs.length ? new Date(Math.max(...maxs.map((d) => d.getTime()))) : null,
    sampleCount: Number(daily?.cnt ?? 0) + Number(hourly?.cnt ?? 0) + Number(detail?.cnt ?? 0),
  };
}

export async function readPollingHistorySummary(assetId: string): Promise<PollingHistorySummary> {
  const monitor = await streamHistorySummary(
    assetId, "asset_monitor_samples", "asset_monitor_samples_hourly", "asset_monitor_samples_daily",
  );
  const telemetry = await streamHistorySummary(
    assetId, "asset_telemetry_samples", "asset_telemetry_samples_hourly", "asset_telemetry_samples_daily",
  );
  const mins = [monitor.oldestAt, telemetry.oldestAt].filter((d): d is Date => d != null);
  const maxs = [monitor.newestAt, telemetry.newestAt].filter((d): d is Date => d != null);
  const oldestAt = mins.length ? new Date(Math.min(...mins.map((d) => d.getTime()))) : null;
  const newestAt = maxs.length ? new Date(Math.max(...maxs.map((d) => d.getTime()))) : null;
  return {
    oldestAt,
    newestAt,
    spanDays: oldestAt && newestAt ? Math.floor((newestAt.getTime() - oldestAt.getTime()) / DAY_MS) : 0,
    sampleCount: monitor.sampleCount + telemetry.sampleCount,
    monitor,
    telemetry,
  };
}

// ─── SD-WAN members (per-interface health-check summary) ─────────────────────

/** How far back the SD-WAN Members table's Health Check Status strip reaches. */
export const SDWAN_STATUS_STRIP_MINUTES = 30;

export interface SdwanMemberHealthCheck {
  healthCheck: string;
  state:       string;        // "up" | "down"
  latencyMs:   number | null;
  jitterMs:    number | null;
  packetLoss:  number | null;
}
export interface SdwanMemberRow {
  link:         string;       // WAN member interface name
  zone:         string | null; // SD-WAN zone the member belongs to
  state:        string;       // aggregate latest: "up" iff up in every health-check it's in
  ip:           string | null;
  linkSpeedBps: number | null;
  linkUp:       boolean | null;
  txBytes:      number | null; // interface outOctets (cumulative)
  rxBytes:      number | null; // interface inOctets (cumulative)
  healthChecks: SdwanMemberHealthCheck[];
  recent:       Array<{ timestamp: Date; up: boolean }>; // recent per-scrape up/down for the status strip
}

/**
 * Per-member SD-WAN health summary for the asset modal's "SD-WAN Members" table.
 * Aggregates the perfSla stream by WAN member (a member can appear in several
 * health-checks) and joins the latest interface sample for IP / link / byte
 * counters. `recent` powers the green/red health-check status strip — one entry
 * per scrape over the last SDWAN_STATUS_STRIP_MINUTES (30), `up` = up in every
 * health-check at that time.
 * Reads the `perfSla` (+ `interfaces`) retention entities; current values come
 * from the latest rows, the strip from recent detail samples.
 *
 * `collectedAt` is the newest of those latest samples — one stamp for the whole
 * table, since a scrape writes every member at once. Null means never scraped.
 */
export async function readSdwanMembers(
  assetId: string,
): Promise<{ members: SdwanMemberRow[]; collectedAt: Date | null }> {
  // A: latest sample per (member, health-check). `timestamp` comes back too:
  // the newest of these IS the SD-WAN scrape stamp, and the tab's freshness
  // strip reads it rather than the asset's lastSystemInfoAt — SD-WAN rides the
  // system-info pass but is one optional leg of it, so a pass whose SD-WAN call
  // failed advances lastSystemInfoAt while this table stands still. Reading the
  // pass stamp would report that stale table as current, which is the exact
  // misreading the strip exists to prevent.
  const latest = await prisma.$queryRawUnsafe<Array<{
    link: string; healthCheck: string; zone: string | null; state: string;
    latencyMs: number | null; jitterMs: number | null; packetLoss: number | null;
    timestamp: Date;
  }>>(
    `SELECT DISTINCT ON ("link", "healthCheck")
            "link", "healthCheck", "zone", "state", "latencyMs", "jitterMs", "packetLoss", "timestamp"
     FROM "asset_perf_sla_samples" WHERE "assetId" = $1
     ORDER BY "link", "healthCheck", "timestamp" DESC`,
    assetId,
  );
  if (latest.length === 0) return { members: [], collectedAt: null };
  let collectedAt: Date | null = null;
  for (const r of latest) {
    if (r.timestamp && (!collectedAt || r.timestamp > collectedAt)) collectedAt = r.timestamp;
  }

  // B: recent per-(member, scrape) aggregated up/down for the status strip.
  // The window alone bounds the strip: the SD-WAN cadence floors at 60s, so 30
  // minutes is at most ~30 segments (plus any Poll Now reads). It used to be 90
  // minutes cut to the newest 48 readings — which, once SD-WAN moved to its own
  // 60s cadence, meant the strip spanned "the last 48 minutes", a figure nobody
  // chose.
  const recentRows = await prisma.$queryRawUnsafe<Array<{ link: string; timestamp: Date; up: boolean }>>(
    `SELECT "link", "timestamp", bool_and("state" = 'up') AS up
     FROM "asset_perf_sla_samples"
     WHERE "assetId" = $1 AND "timestamp" > now() - make_interval(mins => $2::int)
     GROUP BY "link", "timestamp" ORDER BY "link", "timestamp" ASC`,
    assetId,
    SDWAN_STATUS_STRIP_MINUTES,
  );

  // C: current interface state per member ifName (IP / speed / link state /
  // bytes), from the CURRENT-STATE inventory. A WAN member is frequently NOT
  // pinned, so reading the pinned-only sample table here would silently blank
  // these columns for exactly the common case. The previous DISTINCT ON also
  // had no time bound at all, so it could return an arbitrarily old reading.
  const links = Array.from(new Set(latest.map((r) => r.link)));
  const ifaceRows = await prisma.assetInterface.findMany({
    where: { assetId, ifName: { in: links } },
    select: {
      ifName: true, ipAddress: true, speedBps: true,
      operStatus: true, inOctets: true, outOctets: true,
    },
  });
  const ifaceByName = new Map(ifaceRows.map((r) => [r.ifName, r]));
  const recentByLink = new Map<string, Array<{ timestamp: Date; up: boolean }>>();
  for (const r of recentRows) {
    if (!recentByLink.has(r.link)) recentByLink.set(r.link, []);
    recentByLink.get(r.link)!.push({ timestamp: r.timestamp, up: r.up });
  }

  const hcByLink = new Map<string, SdwanMemberHealthCheck[]>();
  const zoneByLink = new Map<string, string>();
  for (const r of latest) {
    if (!hcByLink.has(r.link)) hcByLink.set(r.link, []);
    hcByLink.get(r.link)!.push({ healthCheck: r.healthCheck, state: r.state, latencyMs: r.latencyMs, jitterMs: r.jitterMs, packetLoss: r.packetLoss });
    if (r.zone && !zoneByLink.has(r.link)) zoneByLink.set(r.link, r.zone);
  }

  const members: SdwanMemberRow[] = links.map((link) => {
    const hcs = hcByLink.get(link) ?? [];
    const iface = ifaceByName.get(link) ?? null;
    const recent = recentByLink.get(link) ?? [];
    return {
      link,
      zone:         zoneByLink.get(link) ?? null,
      state:        hcs.length && hcs.every((h) => h.state === "up") ? "up" : "down",
      ip:           iface?.ipAddress ?? null,
      linkSpeedBps: iface?.speedBps != null ? Number(iface.speedBps) : null,
      linkUp:       iface ? iface.operStatus === "up" : null,
      txBytes:      iface?.outOctets != null ? Number(iface.outOctets) : null,
      rxBytes:      iface?.inOctets  != null ? Number(iface.inOctets)  : null,
      healthChecks: hcs,
      recent,
    };
  });
  // Sort: physical/WAN members first (those with an IP), then by name.
  members.sort((a, b) => (a.ip ? 0 : 1) - (b.ip ? 0 : 1) || a.link.localeCompare(b.link));
  return { members, collectedAt };
}

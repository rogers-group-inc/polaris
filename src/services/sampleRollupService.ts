/**
 * src/services/sampleRollupService.ts
 *
 * Rolls up the six monitor sample tables into per-hour and per-day
 * aggregates. Phase 2 of the tiered sample-retention work — writes the
 * tables phase 1 created. Nothing reads them yet (phase 4 lands the
 * tier-routing helper that picks rollup tier vs detail at query time).
 *
 * Mechanism: one custom INSERT...ON CONFLICT statement per source per
 * tier. Portable across plain Postgres and TimescaleDB — uses
 * `date_trunc('hour' | 'day', ts)` rather than Timescale's `time_bucket`
 * so a single code path covers both deployments. On Timescale boxes the
 * rollup tables can still be hypertables (see timescaleService.ts) but
 * the rollup writer doesn't depend on that.
 *
 * Counter-table handling: AssetInterfaceSample and AssetIpsecTunnelSample
 * carry cumulative counters that can wrap or reset. The rollup stores
 * `first` and `last` values per bucket plus `lastBucketSampleAt`, so the
 * read layer (phase 4) can derive rate as
 *   rate = (last - first) / (lastBucketSampleAt - bucketStart in seconds)
 * dropping negative deltas as counter resets — same convention the
 * detail-tier `/interface-history` endpoint uses today.
 *
 * Daily-from-hourly: rather than re-scanning the (potentially huge)
 * detail table for the daily bucket, the daily rollup reads from the
 * hourly tier. Aggregation: SUM for counts, weighted-avg for gauge means
 * (weighted by the underlying sampleCount), MIN/MAX for min/max, and
 * `(ARRAY_AGG(... ORDER BY bucketStart ASC))[1]` / DESC for first/last
 * counter values across the day's hourly buckets.
 *
 * Idempotent — re-running with the same lookback window UPDATEs the
 * existing buckets in place. The hourly job uses a 2-hour lookback so
 * late-arriving samples (which the buffer can flush up to 2 seconds late
 * by design — see sampleWriteBuffer.ts) still land in the right bucket
 * on the next tick. The daily job uses a 2-day lookback for the same
 * reason at a coarser cadence.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { startSampleRollupTimer } from "../metrics.js";

export type RollupTier = "hourly" | "daily";

export type SourceTable =
  | "monitor"
  | "telemetry"
  | "hardware"
  | "interface"
  | "storage"
  | "ipsec"
  | "perfSla"
  | "pathCheck"
  | "process";

interface RollupDef {
  source:        SourceTable;
  /** Source table name in Postgres (snake_case). */
  detailTable:   string;
  /** Hourly rollup table name. */
  hourlyTable:   string;
  /** Daily rollup table name. */
  dailyTable:    string;
}

const DEFS: RollupDef[] = [
  { source: "monitor",     detailTable: "asset_monitor_samples",       hourlyTable: "asset_monitor_samples_hourly",       dailyTable: "asset_monitor_samples_daily"       },
  { source: "telemetry",   detailTable: "asset_telemetry_samples",     hourlyTable: "asset_telemetry_samples_hourly",     dailyTable: "asset_telemetry_samples_daily"     },
  { source: "hardware",    detailTable: "asset_hardware_sensor_samples", hourlyTable: "asset_hardware_sensor_samples_hourly", dailyTable: "asset_hardware_sensor_samples_daily" },
  { source: "interface",   detailTable: "asset_interface_samples",     hourlyTable: "asset_interface_samples_hourly",     dailyTable: "asset_interface_samples_daily"     },
  { source: "storage",     detailTable: "asset_storage_samples",       hourlyTable: "asset_storage_samples_hourly",       dailyTable: "asset_storage_samples_daily"       },
  { source: "ipsec",       detailTable: "asset_ipsec_tunnel_samples",  hourlyTable: "asset_ipsec_tunnel_samples_hourly",  dailyTable: "asset_ipsec_tunnel_samples_daily"  },
  { source: "perfSla",     detailTable: "asset_perf_sla_samples",      hourlyTable: "asset_perf_sla_samples_hourly",      dailyTable: "asset_perf_sla_samples_daily"      },
  { source: "pathCheck", detailTable: "asset_path_check_samples", hourlyTable: "asset_path_check_samples_hourly", dailyTable: "asset_path_check_samples_daily" },
  { source: "process",     detailTable: "asset_process_samples",       hourlyTable: "asset_process_samples_hourly",       dailyTable: "asset_process_samples_daily"       },
];

export interface RollupResult {
  source: SourceTable;
  tier:   RollupTier;
  /** Rows touched (inserted + updated). Drawn from `cmd_status` after the INSERT. */
  rowsTouched: number;
  durationMs:  number;
}

/**
 * Roll up every source table into its hourly tier, looking back
 * `lookbackHours` hours from now. Idempotent — runs `INSERT...ON
 * CONFLICT DO UPDATE` so re-running over the same window rewrites
 * existing buckets with fresh aggregates.
 */
export async function rollupHourly(lookbackHours = 2): Promise<RollupResult[]> {
  const since = new Date(Date.now() - lookbackHours * 3600 * 1000);
  return runAll("hourly", since);
}

/**
 * Roll up every hourly tier into its daily tier, looking back
 * `lookbackDays` days from now. Reads from `<table>_hourly`, not from
 * the detail table — keeps the daily tick cheap even on big fleets.
 */
export async function rollupDaily(lookbackDays = 2): Promise<RollupResult[]> {
  const since = new Date(Date.now() - lookbackDays * 86400 * 1000);
  return runAll("daily", since);
}

async function runAll(tier: RollupTier, since: Date): Promise<RollupResult[]> {
  const results: RollupResult[] = [];
  for (const def of DEFS) {
    const result = await runOne(def, tier, since);
    results.push(result);
  }
  return results;
}

async function runOne(def: RollupDef, tier: RollupTier, since: Date): Promise<RollupResult> {
  const stop = startSampleRollupTimer(tier, def.source);
  const t0 = Date.now();
  let rowsTouched = 0;
  try {
    const sql = buildSql(def, tier);
    // $executeRawUnsafe returns the affected row count (INSERT + UPDATE).
    rowsTouched = await prisma.$executeRawUnsafe(sql, since);
  } catch (err) {
    logger.error(
      { err, source: def.source, tier, since: since.toISOString() },
      "Sample rollup failed for this table; continuing with the next",
    );
  } finally {
    stop();
  }
  return { source: def.source, tier, rowsTouched, durationMs: Date.now() - t0 };
}

// ─── SQL builders ────────────────────────────────────────────────────────────
//
// Each builder returns ONE parameterised statement. $1 = since timestamp.
// Bucket size is encoded as `'1 hour'` / `'1 day'` and the source table
// switches between detail (for hourly tier) and hourly (for daily tier).

function buildSql(def: RollupDef, tier: RollupTier): string {
  switch (def.source) {
    case "monitor":      return tier === "hourly" ? sqlMonitorHourly()      : sqlMonitorDaily();
    case "telemetry":    return tier === "hourly" ? sqlTelemetryHourly()    : sqlTelemetryDaily();
    case "hardware":     return tier === "hourly" ? sqlHardwareHourly()     : sqlHardwareDaily();
    case "interface":    return tier === "hourly" ? sqlInterfaceHourly()    : sqlInterfaceDaily();
    case "storage":      return tier === "hourly" ? sqlStorageHourly()      : sqlStorageDaily();
    case "ipsec":        return tier === "hourly" ? sqlIpsecHourly()        : sqlIpsecDaily();
    case "perfSla":      return tier === "hourly" ? sqlPerfSlaHourly()      : sqlPerfSlaDaily();
    case "pathCheck": return tier === "hourly" ? sqlPathCheckHourly() : sqlPathCheckDaily();
    case "process":      return tier === "hourly" ? sqlProcessHourly()      : sqlProcessDaily();
  }
}

// ─── Process (gauges — cpu%, rss bytes — keyed by program name) ──────────────

function sqlProcessHourly(): string {
  return `
    INSERT INTO "asset_process_samples_hourly" (
      "id", "assetId", "bucketStart", "name", "sampleCount",
      "avgCpuPct", "minCpuPct", "maxCpuPct",
      "avgMemRssBytes", "minMemRssBytes", "maxMemRssBytes"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('hour', "timestamp") AS bucket_start,
      "name",
      COUNT(*)::int,
      AVG("cpuPct"),
      MIN("cpuPct"),
      MAX("cpuPct"),
      AVG("memRssBytes")::bigint,
      MIN("memRssBytes"),
      MAX("memRssBytes")
    FROM "asset_process_samples"
    WHERE "timestamp" >= $1
    GROUP BY "assetId", bucket_start, "name"
    ON CONFLICT ("bucketStart", "assetId", "name") DO UPDATE SET
      "sampleCount"    = EXCLUDED."sampleCount",
      "avgCpuPct"      = EXCLUDED."avgCpuPct",
      "minCpuPct"      = EXCLUDED."minCpuPct",
      "maxCpuPct"      = EXCLUDED."maxCpuPct",
      "avgMemRssBytes" = EXCLUDED."avgMemRssBytes",
      "minMemRssBytes" = EXCLUDED."minMemRssBytes",
      "maxMemRssBytes" = EXCLUDED."maxMemRssBytes"
  `;
}

function sqlProcessDaily(): string {
  return `
    INSERT INTO "asset_process_samples_daily" (
      "id", "assetId", "bucketStart", "name", "sampleCount",
      "avgCpuPct", "minCpuPct", "maxCpuPct",
      "avgMemRssBytes", "minMemRssBytes", "maxMemRssBytes"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('day', "bucketStart") AS bucket_start,
      "name",
      SUM("sampleCount")::int,
      SUM("avgCpuPct" * "sampleCount") / NULLIF(SUM("sampleCount"), 0),
      MIN("minCpuPct"),
      MAX("maxCpuPct"),
      (SUM("avgMemRssBytes" * "sampleCount") / NULLIF(SUM("sampleCount"), 0))::bigint,
      MIN("minMemRssBytes"),
      MAX("maxMemRssBytes")
    FROM "asset_process_samples_hourly"
    WHERE "bucketStart" >= $1
    GROUP BY "assetId", bucket_start, "name"
    ON CONFLICT ("bucketStart", "assetId", "name") DO UPDATE SET
      "sampleCount"    = EXCLUDED."sampleCount",
      "avgCpuPct"      = EXCLUDED."avgCpuPct",
      "minCpuPct"      = EXCLUDED."minCpuPct",
      "maxCpuPct"      = EXCLUDED."maxCpuPct",
      "avgMemRssBytes" = EXCLUDED."avgMemRssBytes",
      "minMemRssBytes" = EXCLUDED."minMemRssBytes",
      "maxMemRssBytes" = EXCLUDED."maxMemRssBytes"
  `;
}

/**
 * The response-time poll's own rows: NULL predates probeKind and means the
 * same thing as the literal. A compile-time literal, interpolated into the
 * SQL below — never near user data.
 */
const PRIMARY = `("probeKind" IS NULL OR "probeKind" = 'primary')`;

// ─── Monitor (gauge — response time) ─────────────────────────────────────────

function sqlMonitorHourly(): string {
  // PRIMARY-ONLY COLUMNS, ALL-KINDS SCAN. Every count and every response-time
  // aggregate below is FILTERed to the response-time poll, exactly as it was
  // when the WHERE clause did that filtering — those columns describe the
  // operator's configured transport, and `probeOutageService` reads
  // failureCount / dependencyFailureCount to decide what an outage looked like.
  // Mixing a second transport into them would change what a chart's red band
  // means.
  //
  // The WHERE no longer excludes probeKind='icmp', though, because the packet
  // columns need those rows. The old exclusion was written for the per-asset
  // loss SAMPLER, which ran ONLY during warning/recovering windows: folding it
  // into 400-day aggregates would have counted a quiet month and an
  // incident-heavy month at different sampling rates, making historical loss
  // non-comparable across time. That reasoning died with the sampler. The sweep
  // that replaced it is UNIFORM — every eligible asset, every cycle, whatever
  // state it is in (business rule 29) — which is precisely what makes it
  // comparable across time, and what makes rolling it up worth doing at all.
  return `
    INSERT INTO "asset_monitor_samples_hourly" (
      "id", "assetId", "bucketStart",
      "sampleCount", "successCount", "failureCount", "dependencyFailureCount",
      "avgResponseTimeMs", "minResponseTimeMs", "maxResponseTimeMs",
      "packetsSent", "packetsReceived"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('hour', "timestamp") AS bucket_start,
      COUNT(*) FILTER (WHERE ${PRIMARY})::int,
      COUNT(*) FILTER (WHERE ${PRIMARY} AND success)::int,
      COUNT(*) FILTER (WHERE ${PRIMARY} AND NOT success)::int,
      -- Explained misses (parent dark at probe time). Carried through the
      -- rollups so a multi-day dependency outage still reads grey once the
      -- detail rows have aged out; a bucket only counts as a dependency outage
      -- when EVERY failure in it was one.
      COUNT(*) FILTER (WHERE ${PRIMARY} AND NOT success AND "dependencyDown")::int,
      AVG("responseTimeMs") FILTER (WHERE ${PRIMARY} AND success AND "responseTimeMs" IS NOT NULL),
      MIN("responseTimeMs") FILTER (WHERE ${PRIMARY} AND success AND "responseTimeMs" IS NOT NULL),
      MAX("responseTimeMs") FILTER (WHERE ${PRIMARY} AND success AND "responseTimeMs" IS NOT NULL),
      -- Packet totals from the ICMP burst sweep, SUMMED rather than averaged so
      -- a long range stays a true packets-lost/packets-sent ratio instead of a
      -- mean of per-bucket percentages (which would weight a bucket holding one
      -- sweep the same as one holding sixty). NULL when the bucket held no
      -- sweep rows at all, which is what tells a reader to fall back to the
      -- row-count ratio — exactly the fallback probeLossQuery makes.
      SUM("packetsSent") FILTER (WHERE "packetsSent" IS NOT NULL)::int,
      SUM("packetsReceived") FILTER (WHERE "packetsSent" IS NOT NULL)::int
    FROM "asset_monitor_samples"
    WHERE "timestamp" >= $1
    GROUP BY "assetId", bucket_start
    ON CONFLICT ("bucketStart", "assetId") DO UPDATE SET
      "sampleCount"       = EXCLUDED."sampleCount",
      "successCount"      = EXCLUDED."successCount",
      "failureCount"      = EXCLUDED."failureCount",
      "dependencyFailureCount" = EXCLUDED."dependencyFailureCount",
      "avgResponseTimeMs" = EXCLUDED."avgResponseTimeMs",
      "minResponseTimeMs" = EXCLUDED."minResponseTimeMs",
      "maxResponseTimeMs" = EXCLUDED."maxResponseTimeMs",
      "packetsSent"       = EXCLUDED."packetsSent",
      "packetsReceived"   = EXCLUDED."packetsReceived"
  `;
}

function sqlMonitorDaily(): string {
  // Weighted average: SUM(avgResponseTimeMs * successCount) / NULLIF(SUM(successCount), 0).
  // The successCount is the correct weight because avgResponseTimeMs was
  // computed over successes only.
  return `
    INSERT INTO "asset_monitor_samples_daily" (
      "id", "assetId", "bucketStart",
      "sampleCount", "successCount", "failureCount", "dependencyFailureCount",
      "avgResponseTimeMs", "minResponseTimeMs", "maxResponseTimeMs",
      "packetsSent", "packetsReceived"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('day', "bucketStart") AS bucket_start,
      SUM("sampleCount")::int,
      SUM("successCount")::int,
      SUM("failureCount")::int,
      -- COALESCE: hourly buckets rolled up before the column existed carry
      -- NULL, and one NULL would otherwise wipe the whole day's count.
      SUM(COALESCE("dependencyFailureCount", 0))::int,
      SUM("avgResponseTimeMs" * "successCount") / NULLIF(SUM("successCount"), 0),
      MIN("minResponseTimeMs"),
      MAX("maxResponseTimeMs"),
      -- Deliberately NOT coalesced to 0 like dependencyFailureCount above: for
      -- that column 0 is the truthful reading of "no dependency failures", but
      -- here a day whose hourly buckets all predate the sweep must stay NULL,
      -- because 0 packets sent would read as a 0% loss day rather than as a day
      -- with no packet data. SUM ignores NULLs and returns NULL only when every
      -- input is NULL, which is exactly the distinction wanted.
      SUM("packetsSent")::int,
      SUM("packetsReceived")::int
    FROM "asset_monitor_samples_hourly"
    WHERE "bucketStart" >= $1
    GROUP BY "assetId", bucket_start
    ON CONFLICT ("bucketStart", "assetId") DO UPDATE SET
      "sampleCount"       = EXCLUDED."sampleCount",
      "successCount"      = EXCLUDED."successCount",
      "failureCount"      = EXCLUDED."failureCount",
      "dependencyFailureCount" = EXCLUDED."dependencyFailureCount",
      "avgResponseTimeMs" = EXCLUDED."avgResponseTimeMs",
      "minResponseTimeMs" = EXCLUDED."minResponseTimeMs",
      "maxResponseTimeMs" = EXCLUDED."maxResponseTimeMs",
      "packetsSent"       = EXCLUDED."packetsSent",
      "packetsReceived"   = EXCLUDED."packetsReceived"
  `;
}

// ─── Telemetry (gauge — CPU + memory) ────────────────────────────────────────

function sqlTelemetryHourly(): string {
  return `
    INSERT INTO "asset_telemetry_samples_hourly" (
      "id", "assetId", "bucketStart", "sampleCount",
      "avgCpuPct", "minCpuPct", "maxCpuPct",
      "avgMemPct", "minMemPct", "maxMemPct",
      "avgMemUsedBytes", "maxMemUsedBytes", "lastMemTotalBytes",
      "avgMemBuffersBytes", "avgMemCachedBytes", "avgMemFreeBytes",
      "avgSwapUsedBytes", "lastSwapTotalBytes",
      "avgMemPrivateBytes", "avgMemSharedBytes", "avgMemBalloonedBytes",
      "avgMemSwappedBytes", "avgMemCompressedBytes", "avgMemConsumedBytes",
      "avgSessionCount", "minSessionCount", "maxSessionCount"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('hour', "timestamp") AS bucket_start,
      COUNT(*)::int,
      AVG("cpuPct"), MIN("cpuPct"), MAX("cpuPct"),
      AVG("memPct"), MIN("memPct"), MAX("memPct"),
      AVG("memUsedBytes")::bigint, MAX("memUsedBytes"),
      (ARRAY_AGG("memTotalBytes" ORDER BY "timestamp" DESC) FILTER (WHERE "memTotalBytes" IS NOT NULL))[1],
      -- Memory bands: AVG only. The chart stacks them, and a stack of
      -- independent minima or maxima sums to a total no sample ever had.
      -- AVG ignores NULLs, so a bucket mixing agent rows with rows from a
      -- source that reports no breakdown averages the bands over the rows
      -- that HAVE them, while "sampleCount" still counts every row — the
      -- bands can therefore under-sum the total in a mixed bucket, which is
      -- correct: an asset only ever has one telemetry source at a time, so
      -- a mixed bucket means the source changed mid-hour.
      AVG("memBuffersBytes")::bigint, AVG("memCachedBytes")::bigint, AVG("memFreeBytes")::bigint,
      AVG("swapUsedBytes")::bigint,
      (ARRAY_AGG("swapTotalBytes" ORDER BY "timestamp" DESC) FILTER (WHERE "swapTotalBytes" IS NOT NULL))[1],
      -- The vCenter bands, averaged the same way. They cannot appear in the
      -- same bucket as the agent bands above unless the asset's telemetry
      -- source changed mid-hour, which is the one case both sets go non-null
      -- and is already the documented caveat for a mixed bucket.
      AVG("memPrivateBytes")::bigint, AVG("memSharedBytes")::bigint, AVG("memBalloonedBytes")::bigint,
      AVG("memSwappedBytes")::bigint, AVG("memCompressedBytes")::bigint, AVG("memConsumedBytes")::bigint,
      AVG("sessionCount"), MIN("sessionCount"), MAX("sessionCount")
    FROM "asset_telemetry_samples"
    WHERE "timestamp" >= $1
    GROUP BY "assetId", bucket_start
    ON CONFLICT ("bucketStart", "assetId") DO UPDATE SET
      "sampleCount"       = EXCLUDED."sampleCount",
      "avgCpuPct"         = EXCLUDED."avgCpuPct",
      "minCpuPct"         = EXCLUDED."minCpuPct",
      "maxCpuPct"         = EXCLUDED."maxCpuPct",
      "avgMemPct"         = EXCLUDED."avgMemPct",
      "minMemPct"         = EXCLUDED."minMemPct",
      "maxMemPct"         = EXCLUDED."maxMemPct",
      "avgMemUsedBytes"   = EXCLUDED."avgMemUsedBytes",
      "maxMemUsedBytes"   = EXCLUDED."maxMemUsedBytes",
      "lastMemTotalBytes" = EXCLUDED."lastMemTotalBytes",
      "avgMemBuffersBytes" = EXCLUDED."avgMemBuffersBytes",
      "avgMemCachedBytes"  = EXCLUDED."avgMemCachedBytes",
      "avgMemFreeBytes"    = EXCLUDED."avgMemFreeBytes",
      "avgSwapUsedBytes"   = EXCLUDED."avgSwapUsedBytes",
      "lastSwapTotalBytes" = EXCLUDED."lastSwapTotalBytes",
      "avgMemPrivateBytes"    = EXCLUDED."avgMemPrivateBytes",
      "avgMemSharedBytes"     = EXCLUDED."avgMemSharedBytes",
      "avgMemBalloonedBytes"  = EXCLUDED."avgMemBalloonedBytes",
      "avgMemSwappedBytes"    = EXCLUDED."avgMemSwappedBytes",
      "avgMemCompressedBytes" = EXCLUDED."avgMemCompressedBytes",
      "avgMemConsumedBytes"   = EXCLUDED."avgMemConsumedBytes",
      "avgSessionCount"   = EXCLUDED."avgSessionCount",
      "minSessionCount"   = EXCLUDED."minSessionCount",
      "maxSessionCount"   = EXCLUDED."maxSessionCount"
  `;
}

function sqlTelemetryDaily(): string {
  // Weighted averages by sampleCount.
  return `
    INSERT INTO "asset_telemetry_samples_daily" (
      "id", "assetId", "bucketStart", "sampleCount",
      "avgCpuPct", "minCpuPct", "maxCpuPct",
      "avgMemPct", "minMemPct", "maxMemPct",
      "avgMemUsedBytes", "maxMemUsedBytes", "lastMemTotalBytes",
      "avgMemBuffersBytes", "avgMemCachedBytes", "avgMemFreeBytes",
      "avgSwapUsedBytes", "lastSwapTotalBytes",
      "avgMemPrivateBytes", "avgMemSharedBytes", "avgMemBalloonedBytes",
      "avgMemSwappedBytes", "avgMemCompressedBytes", "avgMemConsumedBytes",
      "avgSessionCount", "minSessionCount", "maxSessionCount"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('day', "bucketStart") AS bucket_start,
      SUM("sampleCount")::int,
      SUM("avgCpuPct"      * "sampleCount") / NULLIF(SUM("sampleCount"), 0),
      MIN("minCpuPct"),
      MAX("maxCpuPct"),
      SUM("avgMemPct"      * "sampleCount") / NULLIF(SUM("sampleCount"), 0),
      MIN("minMemPct"),
      MAX("maxMemPct"),
      (SUM("avgMemUsedBytes" * "sampleCount") / NULLIF(SUM("sampleCount"), 0))::bigint,
      MAX("maxMemUsedBytes"),
      (ARRAY_AGG("lastMemTotalBytes" ORDER BY "bucketStart" DESC) FILTER (WHERE "lastMemTotalBytes" IS NOT NULL))[1],
      -- Weighted like every other average here, but weighted by the count of
      -- rows in the hour, not by how many of them carried a band. An hour
      -- with no breakdown contributes NULL, which SUM ignores while
      -- SUM("sampleCount") still counts it — the same mixed-source caveat as
      -- the hourly roll, and the same reason it is acceptable.
      (SUM("avgMemBuffersBytes" * "sampleCount") / NULLIF(SUM("sampleCount"), 0))::bigint,
      (SUM("avgMemCachedBytes"  * "sampleCount") / NULLIF(SUM("sampleCount"), 0))::bigint,
      (SUM("avgMemFreeBytes"    * "sampleCount") / NULLIF(SUM("sampleCount"), 0))::bigint,
      (SUM("avgSwapUsedBytes"   * "sampleCount") / NULLIF(SUM("sampleCount"), 0))::bigint,
      (ARRAY_AGG("lastSwapTotalBytes" ORDER BY "bucketStart" DESC) FILTER (WHERE "lastSwapTotalBytes" IS NOT NULL))[1],
      (SUM("avgMemPrivateBytes"    * "sampleCount") / NULLIF(SUM("sampleCount"), 0))::bigint,
      (SUM("avgMemSharedBytes"     * "sampleCount") / NULLIF(SUM("sampleCount"), 0))::bigint,
      (SUM("avgMemBalloonedBytes"  * "sampleCount") / NULLIF(SUM("sampleCount"), 0))::bigint,
      (SUM("avgMemSwappedBytes"    * "sampleCount") / NULLIF(SUM("sampleCount"), 0))::bigint,
      (SUM("avgMemCompressedBytes" * "sampleCount") / NULLIF(SUM("sampleCount"), 0))::bigint,
      (SUM("avgMemConsumedBytes"   * "sampleCount") / NULLIF(SUM("sampleCount"), 0))::bigint,
      SUM("avgSessionCount" * "sampleCount") / NULLIF(SUM("sampleCount"), 0),
      MIN("minSessionCount"),
      MAX("maxSessionCount")
    FROM "asset_telemetry_samples_hourly"
    WHERE "bucketStart" >= $1
    GROUP BY "assetId", bucket_start
    ON CONFLICT ("bucketStart", "assetId") DO UPDATE SET
      "sampleCount"       = EXCLUDED."sampleCount",
      "avgCpuPct"         = EXCLUDED."avgCpuPct",
      "minCpuPct"         = EXCLUDED."minCpuPct",
      "maxCpuPct"         = EXCLUDED."maxCpuPct",
      "avgMemPct"         = EXCLUDED."avgMemPct",
      "minMemPct"         = EXCLUDED."minMemPct",
      "maxMemPct"         = EXCLUDED."maxMemPct",
      "avgMemUsedBytes"   = EXCLUDED."avgMemUsedBytes",
      "maxMemUsedBytes"   = EXCLUDED."maxMemUsedBytes",
      "lastMemTotalBytes" = EXCLUDED."lastMemTotalBytes",
      "avgMemBuffersBytes" = EXCLUDED."avgMemBuffersBytes",
      "avgMemCachedBytes"  = EXCLUDED."avgMemCachedBytes",
      "avgMemFreeBytes"    = EXCLUDED."avgMemFreeBytes",
      "avgSwapUsedBytes"   = EXCLUDED."avgSwapUsedBytes",
      "lastSwapTotalBytes" = EXCLUDED."lastSwapTotalBytes",
      "avgMemPrivateBytes"    = EXCLUDED."avgMemPrivateBytes",
      "avgMemSharedBytes"     = EXCLUDED."avgMemSharedBytes",
      "avgMemBalloonedBytes"  = EXCLUDED."avgMemBalloonedBytes",
      "avgMemSwappedBytes"    = EXCLUDED."avgMemSwappedBytes",
      "avgMemCompressedBytes" = EXCLUDED."avgMemCompressedBytes",
      "avgMemConsumedBytes"   = EXCLUDED."avgMemConsumedBytes",
      "avgSessionCount"   = EXCLUDED."avgSessionCount",
      "minSessionCount"   = EXCLUDED."minSessionCount",
      "maxSessionCount"   = EXCLUDED."maxSessionCount"
  `;
}

// ─── Hardware sensors (gauge per sensor; mixed classes/units) ─────────────────
//
// One row per (sensor) per bucket. `value` averages within a class+unit (the
// rollup is keyed on sensorName, which is class/unit-stable within a device).
// `sensorClass` and `unit` are descriptive — carried up as the bucket's most
// recent value. `alarmStatus` is not aggregatable, so it lives only on the
// detail tier.

function sqlHardwareHourly(): string {
  return `
    INSERT INTO "asset_hardware_sensor_samples_hourly" (
      "id", "assetId", "bucketStart", "sensorName", "sensorClass", "unit",
      "sampleCount", "avgValue", "minValue", "maxValue"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('hour', "timestamp") AS bucket_start,
      "sensorName",
      (ARRAY_AGG("sensorClass" ORDER BY "timestamp" DESC))[1],
      (ARRAY_AGG("unit"        ORDER BY "timestamp" DESC) FILTER (WHERE "unit" IS NOT NULL))[1],
      COUNT(*)::int,
      AVG("value"), MIN("value"), MAX("value")
    FROM "asset_hardware_sensor_samples"
    WHERE "timestamp" >= $1
    GROUP BY "assetId", bucket_start, "sensorName"
    ON CONFLICT ("bucketStart", "assetId", "sensorName") DO UPDATE SET
      "sensorClass" = EXCLUDED."sensorClass",
      "unit"        = EXCLUDED."unit",
      "sampleCount" = EXCLUDED."sampleCount",
      "avgValue"    = EXCLUDED."avgValue",
      "minValue"    = EXCLUDED."minValue",
      "maxValue"    = EXCLUDED."maxValue"
  `;
}

function sqlHardwareDaily(): string {
  return `
    INSERT INTO "asset_hardware_sensor_samples_daily" (
      "id", "assetId", "bucketStart", "sensorName", "sensorClass", "unit",
      "sampleCount", "avgValue", "minValue", "maxValue"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('day', "bucketStart") AS bucket_start,
      "sensorName",
      (ARRAY_AGG("sensorClass" ORDER BY "bucketStart" DESC))[1],
      (ARRAY_AGG("unit"        ORDER BY "bucketStart" DESC) FILTER (WHERE "unit" IS NOT NULL))[1],
      SUM("sampleCount")::int,
      SUM("avgValue" * "sampleCount") / NULLIF(SUM("sampleCount"), 0),
      MIN("minValue"),
      MAX("maxValue")
    FROM "asset_hardware_sensor_samples_hourly"
    WHERE "bucketStart" >= $1
    GROUP BY "assetId", bucket_start, "sensorName"
    ON CONFLICT ("bucketStart", "assetId", "sensorName") DO UPDATE SET
      "sensorClass" = EXCLUDED."sensorClass",
      "unit"        = EXCLUDED."unit",
      "sampleCount" = EXCLUDED."sampleCount",
      "avgValue"    = EXCLUDED."avgValue",
      "minValue"    = EXCLUDED."minValue",
      "maxValue"    = EXCLUDED."maxValue"
  `;
}

// ─── Storage (gauge per mountpoint) ──────────────────────────────────────────

function sqlStorageHourly(): string {
  return `
    INSERT INTO "asset_storage_samples_hourly" (
      "id", "assetId", "bucketStart", "mountPath", "sampleCount",
      "avgUsedBytes", "minUsedBytes", "maxUsedBytes", "lastTotalBytes"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('hour', "timestamp") AS bucket_start,
      "mountPath",
      COUNT(*)::int,
      AVG("usedBytes")::bigint,
      MIN("usedBytes"),
      MAX("usedBytes"),
      (ARRAY_AGG("totalBytes" ORDER BY "timestamp" DESC) FILTER (WHERE "totalBytes" IS NOT NULL))[1]
    FROM "asset_storage_samples"
    WHERE "timestamp" >= $1 AND "cadence" = 'fast'
    GROUP BY "assetId", bucket_start, "mountPath"
    ON CONFLICT ("bucketStart", "assetId", "mountPath") DO UPDATE SET
      "sampleCount"    = EXCLUDED."sampleCount",
      "avgUsedBytes"   = EXCLUDED."avgUsedBytes",
      "minUsedBytes"   = EXCLUDED."minUsedBytes",
      "maxUsedBytes"   = EXCLUDED."maxUsedBytes",
      "lastTotalBytes" = EXCLUDED."lastTotalBytes"
  `;
}

function sqlStorageDaily(): string {
  return `
    INSERT INTO "asset_storage_samples_daily" (
      "id", "assetId", "bucketStart", "mountPath", "sampleCount",
      "avgUsedBytes", "minUsedBytes", "maxUsedBytes", "lastTotalBytes"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('day', "bucketStart") AS bucket_start,
      "mountPath",
      SUM("sampleCount")::int,
      (SUM("avgUsedBytes" * "sampleCount") / NULLIF(SUM("sampleCount"), 0))::bigint,
      MIN("minUsedBytes"),
      MAX("maxUsedBytes"),
      (ARRAY_AGG("lastTotalBytes" ORDER BY "bucketStart" DESC) FILTER (WHERE "lastTotalBytes" IS NOT NULL))[1]
    FROM "asset_storage_samples_hourly"
    WHERE "bucketStart" >= $1
    GROUP BY "assetId", bucket_start, "mountPath"
    ON CONFLICT ("bucketStart", "assetId", "mountPath") DO UPDATE SET
      "sampleCount"    = EXCLUDED."sampleCount",
      "avgUsedBytes"   = EXCLUDED."avgUsedBytes",
      "minUsedBytes"   = EXCLUDED."minUsedBytes",
      "maxUsedBytes"   = EXCLUDED."maxUsedBytes",
      "lastTotalBytes" = EXCLUDED."lastTotalBytes"
  `;
}

// ─── Interface (counter — octets, errors) ────────────────────────────────────
//
// Detail samples carry cumulative counters. The rollup stores per-bucket
// first/last so the read layer can derive rate without re-scanning detail.
// Last-seen descriptor columns (status, ip, mac, alias, ...) use the most
// recent sample's value within the bucket via ARRAY_AGG ORDER BY DESC.

function sqlInterfaceHourly(): string {
  return `
    INSERT INTO "asset_interface_samples_hourly" (
      "id", "assetId", "bucketStart", "ifName", "sampleCount",
      "firstInOctets",  "lastInOctets",
      "firstOutOctets", "lastOutOctets",
      "firstInErrors",  "lastInErrors",
      "firstOutErrors", "lastOutErrors",
      "maxSpeedBps",
      "lastAdminStatus", "lastOperStatus",
      "lastIpAddress", "lastMacAddress",
      "lastAlias", "lastDescription",
      "lastIfType", "lastIfParent", "lastVlanId",
      "lastPoeStatus", "lastPoeClass",
      "lastBucketSampleAt"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('hour', "timestamp") AS bucket_start,
      "ifName",
      COUNT(*)::int,
      (ARRAY_AGG("inOctets"  ORDER BY "timestamp" ASC)  FILTER (WHERE "inOctets"  IS NOT NULL))[1],
      (ARRAY_AGG("inOctets"  ORDER BY "timestamp" DESC) FILTER (WHERE "inOctets"  IS NOT NULL))[1],
      (ARRAY_AGG("outOctets" ORDER BY "timestamp" ASC)  FILTER (WHERE "outOctets" IS NOT NULL))[1],
      (ARRAY_AGG("outOctets" ORDER BY "timestamp" DESC) FILTER (WHERE "outOctets" IS NOT NULL))[1],
      (ARRAY_AGG("inErrors"  ORDER BY "timestamp" ASC)  FILTER (WHERE "inErrors"  IS NOT NULL))[1],
      (ARRAY_AGG("inErrors"  ORDER BY "timestamp" DESC) FILTER (WHERE "inErrors"  IS NOT NULL))[1],
      (ARRAY_AGG("outErrors" ORDER BY "timestamp" ASC)  FILTER (WHERE "outErrors" IS NOT NULL))[1],
      (ARRAY_AGG("outErrors" ORDER BY "timestamp" DESC) FILTER (WHERE "outErrors" IS NOT NULL))[1],
      MAX("speedBps"),
      (ARRAY_AGG("adminStatus" ORDER BY "timestamp" DESC) FILTER (WHERE "adminStatus" IS NOT NULL))[1],
      (ARRAY_AGG("operStatus"  ORDER BY "timestamp" DESC) FILTER (WHERE "operStatus"  IS NOT NULL))[1],
      (ARRAY_AGG("ipAddress"   ORDER BY "timestamp" DESC) FILTER (WHERE "ipAddress"   IS NOT NULL))[1],
      (ARRAY_AGG("macAddress"  ORDER BY "timestamp" DESC) FILTER (WHERE "macAddress"  IS NOT NULL))[1],
      (ARRAY_AGG("alias"       ORDER BY "timestamp" DESC) FILTER (WHERE "alias"       IS NOT NULL))[1],
      (ARRAY_AGG("description" ORDER BY "timestamp" DESC) FILTER (WHERE "description" IS NOT NULL))[1],
      (ARRAY_AGG("ifType"      ORDER BY "timestamp" DESC) FILTER (WHERE "ifType"      IS NOT NULL))[1],
      (ARRAY_AGG("ifParent"    ORDER BY "timestamp" DESC) FILTER (WHERE "ifParent"    IS NOT NULL))[1],
      (ARRAY_AGG("vlanId"      ORDER BY "timestamp" DESC) FILTER (WHERE "vlanId"      IS NOT NULL))[1],
      (ARRAY_AGG("poeStatus"   ORDER BY "timestamp" DESC) FILTER (WHERE "poeStatus"   IS NOT NULL))[1],
      (ARRAY_AGG("poeClass"    ORDER BY "timestamp" DESC) FILTER (WHERE "poeClass"    IS NOT NULL))[1],
      MAX("timestamp")
    FROM "asset_interface_samples"
    WHERE "timestamp" >= $1 AND "cadence" = 'fast'
    GROUP BY "assetId", bucket_start, "ifName"
    ON CONFLICT ("bucketStart", "assetId", "ifName") DO UPDATE SET
      "sampleCount"        = EXCLUDED."sampleCount",
      "firstInOctets"      = EXCLUDED."firstInOctets",
      "lastInOctets"       = EXCLUDED."lastInOctets",
      "firstOutOctets"     = EXCLUDED."firstOutOctets",
      "lastOutOctets"      = EXCLUDED."lastOutOctets",
      "firstInErrors"      = EXCLUDED."firstInErrors",
      "lastInErrors"       = EXCLUDED."lastInErrors",
      "firstOutErrors"     = EXCLUDED."firstOutErrors",
      "lastOutErrors"      = EXCLUDED."lastOutErrors",
      "maxSpeedBps"        = EXCLUDED."maxSpeedBps",
      "lastAdminStatus"    = EXCLUDED."lastAdminStatus",
      "lastOperStatus"     = EXCLUDED."lastOperStatus",
      "lastIpAddress"      = EXCLUDED."lastIpAddress",
      "lastMacAddress"     = EXCLUDED."lastMacAddress",
      "lastAlias"          = EXCLUDED."lastAlias",
      "lastDescription"    = EXCLUDED."lastDescription",
      "lastIfType"         = EXCLUDED."lastIfType",
      "lastIfParent"       = EXCLUDED."lastIfParent",
      "lastVlanId"         = EXCLUDED."lastVlanId",
      "lastPoeStatus"      = EXCLUDED."lastPoeStatus",
      "lastPoeClass"       = EXCLUDED."lastPoeClass",
      "lastBucketSampleAt" = EXCLUDED."lastBucketSampleAt"
  `;
}

function sqlInterfaceDaily(): string {
  return `
    INSERT INTO "asset_interface_samples_daily" (
      "id", "assetId", "bucketStart", "ifName", "sampleCount",
      "firstInOctets",  "lastInOctets",
      "firstOutOctets", "lastOutOctets",
      "firstInErrors",  "lastInErrors",
      "firstOutErrors", "lastOutErrors",
      "maxSpeedBps",
      "lastAdminStatus", "lastOperStatus",
      "lastIpAddress", "lastMacAddress",
      "lastAlias", "lastDescription",
      "lastIfType", "lastIfParent", "lastVlanId",
      "lastPoeStatus", "lastPoeClass",
      "lastBucketSampleAt"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('day', "bucketStart") AS bucket_start,
      "ifName",
      SUM("sampleCount")::int,
      (ARRAY_AGG("firstInOctets"  ORDER BY "bucketStart" ASC)  FILTER (WHERE "firstInOctets"  IS NOT NULL))[1],
      (ARRAY_AGG("lastInOctets"   ORDER BY "bucketStart" DESC) FILTER (WHERE "lastInOctets"   IS NOT NULL))[1],
      (ARRAY_AGG("firstOutOctets" ORDER BY "bucketStart" ASC)  FILTER (WHERE "firstOutOctets" IS NOT NULL))[1],
      (ARRAY_AGG("lastOutOctets"  ORDER BY "bucketStart" DESC) FILTER (WHERE "lastOutOctets"  IS NOT NULL))[1],
      (ARRAY_AGG("firstInErrors"  ORDER BY "bucketStart" ASC)  FILTER (WHERE "firstInErrors"  IS NOT NULL))[1],
      (ARRAY_AGG("lastInErrors"   ORDER BY "bucketStart" DESC) FILTER (WHERE "lastInErrors"   IS NOT NULL))[1],
      (ARRAY_AGG("firstOutErrors" ORDER BY "bucketStart" ASC)  FILTER (WHERE "firstOutErrors" IS NOT NULL))[1],
      (ARRAY_AGG("lastOutErrors"  ORDER BY "bucketStart" DESC) FILTER (WHERE "lastOutErrors"  IS NOT NULL))[1],
      MAX("maxSpeedBps"),
      (ARRAY_AGG("lastAdminStatus" ORDER BY "bucketStart" DESC) FILTER (WHERE "lastAdminStatus" IS NOT NULL))[1],
      (ARRAY_AGG("lastOperStatus"  ORDER BY "bucketStart" DESC) FILTER (WHERE "lastOperStatus"  IS NOT NULL))[1],
      (ARRAY_AGG("lastIpAddress"   ORDER BY "bucketStart" DESC) FILTER (WHERE "lastIpAddress"   IS NOT NULL))[1],
      (ARRAY_AGG("lastMacAddress"  ORDER BY "bucketStart" DESC) FILTER (WHERE "lastMacAddress"  IS NOT NULL))[1],
      (ARRAY_AGG("lastAlias"       ORDER BY "bucketStart" DESC) FILTER (WHERE "lastAlias"       IS NOT NULL))[1],
      (ARRAY_AGG("lastDescription" ORDER BY "bucketStart" DESC) FILTER (WHERE "lastDescription" IS NOT NULL))[1],
      (ARRAY_AGG("lastIfType"      ORDER BY "bucketStart" DESC) FILTER (WHERE "lastIfType"      IS NOT NULL))[1],
      (ARRAY_AGG("lastIfParent"    ORDER BY "bucketStart" DESC) FILTER (WHERE "lastIfParent"    IS NOT NULL))[1],
      (ARRAY_AGG("lastVlanId"      ORDER BY "bucketStart" DESC) FILTER (WHERE "lastVlanId"      IS NOT NULL))[1],
      (ARRAY_AGG("lastPoeStatus"   ORDER BY "bucketStart" DESC) FILTER (WHERE "lastPoeStatus"   IS NOT NULL))[1],
      (ARRAY_AGG("lastPoeClass"    ORDER BY "bucketStart" DESC) FILTER (WHERE "lastPoeClass"    IS NOT NULL))[1],
      MAX("lastBucketSampleAt")
    FROM "asset_interface_samples_hourly"
    WHERE "bucketStart" >= $1
    GROUP BY "assetId", bucket_start, "ifName"
    ON CONFLICT ("bucketStart", "assetId", "ifName") DO UPDATE SET
      "sampleCount"        = EXCLUDED."sampleCount",
      "firstInOctets"      = EXCLUDED."firstInOctets",
      "lastInOctets"       = EXCLUDED."lastInOctets",
      "firstOutOctets"     = EXCLUDED."firstOutOctets",
      "lastOutOctets"      = EXCLUDED."lastOutOctets",
      "firstInErrors"      = EXCLUDED."firstInErrors",
      "lastInErrors"       = EXCLUDED."lastInErrors",
      "firstOutErrors"     = EXCLUDED."firstOutErrors",
      "lastOutErrors"      = EXCLUDED."lastOutErrors",
      "maxSpeedBps"        = EXCLUDED."maxSpeedBps",
      "lastAdminStatus"    = EXCLUDED."lastAdminStatus",
      "lastOperStatus"     = EXCLUDED."lastOperStatus",
      "lastIpAddress"      = EXCLUDED."lastIpAddress",
      "lastMacAddress"     = EXCLUDED."lastMacAddress",
      "lastAlias"          = EXCLUDED."lastAlias",
      "lastDescription"    = EXCLUDED."lastDescription",
      "lastIfType"         = EXCLUDED."lastIfType",
      "lastIfParent"       = EXCLUDED."lastIfParent",
      "lastVlanId"         = EXCLUDED."lastVlanId",
      "lastPoeStatus"      = EXCLUDED."lastPoeStatus",
      "lastPoeClass"       = EXCLUDED."lastPoeClass",
      "lastBucketSampleAt" = EXCLUDED."lastBucketSampleAt"
  `;
}

// ─── IPsec (counter — bytes; status counts) ──────────────────────────────────

function sqlIpsecHourly(): string {
  return `
    INSERT INTO "asset_ipsec_tunnel_samples_hourly" (
      "id", "assetId", "bucketStart", "tunnelName", "sampleCount",
      "statusUpCount", "statusDownCount", "statusPartialCount", "statusDynamicCount",
      "firstIncomingBytes", "lastIncomingBytes",
      "firstOutgoingBytes", "lastOutgoingBytes",
      "lastRemoteGateway", "lastParentInterface", "lastProxyIdCount",
      "lastBucketSampleAt"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('hour', "timestamp") AS bucket_start,
      "tunnelName",
      COUNT(*)::int,
      COUNT(*) FILTER (WHERE status = 'up')::int,
      COUNT(*) FILTER (WHERE status = 'down')::int,
      COUNT(*) FILTER (WHERE status = 'partial')::int,
      COUNT(*) FILTER (WHERE status = 'dynamic')::int,
      (ARRAY_AGG("incomingBytes" ORDER BY "timestamp" ASC)  FILTER (WHERE "incomingBytes" IS NOT NULL))[1],
      (ARRAY_AGG("incomingBytes" ORDER BY "timestamp" DESC) FILTER (WHERE "incomingBytes" IS NOT NULL))[1],
      (ARRAY_AGG("outgoingBytes" ORDER BY "timestamp" ASC)  FILTER (WHERE "outgoingBytes" IS NOT NULL))[1],
      (ARRAY_AGG("outgoingBytes" ORDER BY "timestamp" DESC) FILTER (WHERE "outgoingBytes" IS NOT NULL))[1],
      (ARRAY_AGG("remoteGateway"   ORDER BY "timestamp" DESC) FILTER (WHERE "remoteGateway"   IS NOT NULL))[1],
      (ARRAY_AGG("parentInterface" ORDER BY "timestamp" DESC) FILTER (WHERE "parentInterface" IS NOT NULL))[1],
      (ARRAY_AGG("proxyIdCount"    ORDER BY "timestamp" DESC) FILTER (WHERE "proxyIdCount"    IS NOT NULL))[1],
      MAX("timestamp")
    FROM "asset_ipsec_tunnel_samples"
    WHERE "timestamp" >= $1 AND "cadence" = 'fast'
    GROUP BY "assetId", bucket_start, "tunnelName"
    ON CONFLICT ("bucketStart", "assetId", "tunnelName") DO UPDATE SET
      "sampleCount"         = EXCLUDED."sampleCount",
      "statusUpCount"       = EXCLUDED."statusUpCount",
      "statusDownCount"     = EXCLUDED."statusDownCount",
      "statusPartialCount"  = EXCLUDED."statusPartialCount",
      "statusDynamicCount"  = EXCLUDED."statusDynamicCount",
      "firstIncomingBytes"  = EXCLUDED."firstIncomingBytes",
      "lastIncomingBytes"   = EXCLUDED."lastIncomingBytes",
      "firstOutgoingBytes"  = EXCLUDED."firstOutgoingBytes",
      "lastOutgoingBytes"   = EXCLUDED."lastOutgoingBytes",
      "lastRemoteGateway"   = EXCLUDED."lastRemoteGateway",
      "lastParentInterface" = EXCLUDED."lastParentInterface",
      "lastProxyIdCount"    = EXCLUDED."lastProxyIdCount",
      "lastBucketSampleAt"  = EXCLUDED."lastBucketSampleAt"
  `;
}

function sqlIpsecDaily(): string {
  return `
    INSERT INTO "asset_ipsec_tunnel_samples_daily" (
      "id", "assetId", "bucketStart", "tunnelName", "sampleCount",
      "statusUpCount", "statusDownCount", "statusPartialCount", "statusDynamicCount",
      "firstIncomingBytes", "lastIncomingBytes",
      "firstOutgoingBytes", "lastOutgoingBytes",
      "lastRemoteGateway", "lastParentInterface", "lastProxyIdCount",
      "lastBucketSampleAt"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('day', "bucketStart") AS bucket_start,
      "tunnelName",
      SUM("sampleCount")::int,
      SUM("statusUpCount")::int,
      SUM("statusDownCount")::int,
      SUM("statusPartialCount")::int,
      SUM("statusDynamicCount")::int,
      (ARRAY_AGG("firstIncomingBytes" ORDER BY "bucketStart" ASC)  FILTER (WHERE "firstIncomingBytes" IS NOT NULL))[1],
      (ARRAY_AGG("lastIncomingBytes"  ORDER BY "bucketStart" DESC) FILTER (WHERE "lastIncomingBytes"  IS NOT NULL))[1],
      (ARRAY_AGG("firstOutgoingBytes" ORDER BY "bucketStart" ASC)  FILTER (WHERE "firstOutgoingBytes" IS NOT NULL))[1],
      (ARRAY_AGG("lastOutgoingBytes"  ORDER BY "bucketStart" DESC) FILTER (WHERE "lastOutgoingBytes"  IS NOT NULL))[1],
      (ARRAY_AGG("lastRemoteGateway"   ORDER BY "bucketStart" DESC) FILTER (WHERE "lastRemoteGateway"   IS NOT NULL))[1],
      (ARRAY_AGG("lastParentInterface" ORDER BY "bucketStart" DESC) FILTER (WHERE "lastParentInterface" IS NOT NULL))[1],
      (ARRAY_AGG("lastProxyIdCount"    ORDER BY "bucketStart" DESC) FILTER (WHERE "lastProxyIdCount"    IS NOT NULL))[1],
      MAX("lastBucketSampleAt")
    FROM "asset_ipsec_tunnel_samples_hourly"
    WHERE "bucketStart" >= $1
    GROUP BY "assetId", bucket_start, "tunnelName"
    ON CONFLICT ("bucketStart", "assetId", "tunnelName") DO UPDATE SET
      "sampleCount"         = EXCLUDED."sampleCount",
      "statusUpCount"       = EXCLUDED."statusUpCount",
      "statusDownCount"     = EXCLUDED."statusDownCount",
      "statusPartialCount"  = EXCLUDED."statusPartialCount",
      "statusDynamicCount"  = EXCLUDED."statusDynamicCount",
      "firstIncomingBytes"  = EXCLUDED."firstIncomingBytes",
      "lastIncomingBytes"   = EXCLUDED."lastIncomingBytes",
      "firstOutgoingBytes"  = EXCLUDED."firstOutgoingBytes",
      "lastOutgoingBytes"   = EXCLUDED."lastOutgoingBytes",
      "lastRemoteGateway"   = EXCLUDED."lastRemoteGateway",
      "lastParentInterface" = EXCLUDED."lastParentInterface",
      "lastProxyIdCount"    = EXCLUDED."lastProxyIdCount",
      "lastBucketSampleAt"  = EXCLUDED."lastBucketSampleAt"
  `;
}

// ─── SD-WAN Performance SLA (gauge per health-check member) ───────────────────
//
// latency/jitter/packet-loss are instantaneous gauges → averaged like
// telemetry (NOT first/last-diffed like the IPsec byte counters). Link state
// rolls up into up/down counts. Only cadence='fast' rows roll up (SD-WAN stamps
// every row "fast" — see recordSystemInfoResult).

function sqlPerfSlaHourly(): string {
  return `
    INSERT INTO "asset_perf_sla_samples_hourly" (
      "id", "assetId", "bucketStart", "healthCheck", "link", "sampleCount",
      "stateUpCount", "stateDownCount",
      "avgLatencyMs", "minLatencyMs", "maxLatencyMs",
      "avgJitterMs", "minJitterMs", "maxJitterMs",
      "avgPacketLoss", "minPacketLoss", "maxPacketLoss",
      "lastBucketSampleAt"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('hour', "timestamp") AS bucket_start,
      "healthCheck",
      "link",
      COUNT(*)::int,
      COUNT(*) FILTER (WHERE state = 'up')::int,
      COUNT(*) FILTER (WHERE state = 'down')::int,
      AVG("latencyMs"), MIN("latencyMs"), MAX("latencyMs"),
      AVG("jitterMs"),  MIN("jitterMs"),  MAX("jitterMs"),
      AVG("packetLoss"), MIN("packetLoss"), MAX("packetLoss"),
      MAX("timestamp")
    FROM "asset_perf_sla_samples"
    WHERE "timestamp" >= $1 AND "cadence" = 'fast'
    GROUP BY "assetId", bucket_start, "healthCheck", "link"
    ON CONFLICT ("bucketStart", "assetId", "healthCheck", "link") DO UPDATE SET
      "sampleCount"        = EXCLUDED."sampleCount",
      "stateUpCount"       = EXCLUDED."stateUpCount",
      "stateDownCount"     = EXCLUDED."stateDownCount",
      "avgLatencyMs"       = EXCLUDED."avgLatencyMs",
      "minLatencyMs"       = EXCLUDED."minLatencyMs",
      "maxLatencyMs"       = EXCLUDED."maxLatencyMs",
      "avgJitterMs"        = EXCLUDED."avgJitterMs",
      "minJitterMs"        = EXCLUDED."minJitterMs",
      "maxJitterMs"        = EXCLUDED."maxJitterMs",
      "avgPacketLoss"      = EXCLUDED."avgPacketLoss",
      "minPacketLoss"      = EXCLUDED."minPacketLoss",
      "maxPacketLoss"      = EXCLUDED."maxPacketLoss",
      "lastBucketSampleAt" = EXCLUDED."lastBucketSampleAt"
  `;
}

// ─── Agent-run path checks (gauge + pass/fail per check) ─────────────
//
// Latency and its phases are gauges → averaged. ok/fail roll up as counts, the
// SD-WAN state precedent, which is what the availability chart and the
// pathFailurePct metric need on the long-range tiers. The HTTP status rolls up
// as the bucket's MOST FREQUENT code (mode ignores the nulls tcp/icmp rows
// carry). The daily tier weights each average by the number of hourly samples
// that actually HAD a value — a failed run carries no latency, so weighting by
// sampleCount would drag the day's average toward zero.

function sqlPathCheckHourly(): string {
  return `
    INSERT INTO "asset_path_check_samples_hourly" (
      "id", "assetId", "bucketStart", "checkId", "sampleCount",
      "okCount", "failCount",
      "avgLatencyMs", "minLatencyMs", "maxLatencyMs",
      "avgDnsMs", "avgConnectMs", "avgTlsMs", "avgTtfbMs",
      "avgHopCount", "maxHopCount", "modeHttpStatus",
      "lastBucketSampleAt"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('hour', "timestamp") AS bucket_start,
      "checkId",
      COUNT(*)::int,
      COUNT(*) FILTER (WHERE "ok")::int,
      COUNT(*) FILTER (WHERE NOT "ok")::int,
      AVG("latencyMs"), MIN("latencyMs"), MAX("latencyMs"),
      AVG("dnsMs"), AVG("connectMs"), AVG("tlsMs"), AVG("ttfbMs"),
      AVG("hopCount"), MAX("hopCount"),
      mode() WITHIN GROUP (ORDER BY "httpStatus"),
      MAX("timestamp")
    FROM "asset_path_check_samples"
    WHERE "timestamp" >= $1 AND "cadence" = 'fast'
    GROUP BY "assetId", bucket_start, "checkId"
    ON CONFLICT ("bucketStart", "assetId", "checkId") DO UPDATE SET
      "sampleCount"        = EXCLUDED."sampleCount",
      "okCount"            = EXCLUDED."okCount",
      "failCount"          = EXCLUDED."failCount",
      "avgLatencyMs"       = EXCLUDED."avgLatencyMs",
      "minLatencyMs"       = EXCLUDED."minLatencyMs",
      "maxLatencyMs"       = EXCLUDED."maxLatencyMs",
      "avgDnsMs"           = EXCLUDED."avgDnsMs",
      "avgConnectMs"       = EXCLUDED."avgConnectMs",
      "avgTlsMs"           = EXCLUDED."avgTlsMs",
      "avgTtfbMs"          = EXCLUDED."avgTtfbMs",
      "avgHopCount"        = EXCLUDED."avgHopCount",
      "maxHopCount"        = EXCLUDED."maxHopCount",
      "modeHttpStatus"     = EXCLUDED."modeHttpStatus",
      "lastBucketSampleAt" = EXCLUDED."lastBucketSampleAt"
  `;
}

function sqlPathCheckDaily(): string {
  // Weight = hours that reported a value × their sample count. The ok count
  // stands in for "samples that had a latency" (a failed run has none).
  const wavg = (col: string) =>
    `SUM("${col}" * "okCount") / NULLIF(SUM(CASE WHEN "${col}" IS NOT NULL THEN "okCount" END), 0)`;
  return `
    INSERT INTO "asset_path_check_samples_daily" (
      "id", "assetId", "bucketStart", "checkId", "sampleCount",
      "okCount", "failCount",
      "avgLatencyMs", "minLatencyMs", "maxLatencyMs",
      "avgDnsMs", "avgConnectMs", "avgTlsMs", "avgTtfbMs",
      "avgHopCount", "maxHopCount", "modeHttpStatus",
      "lastBucketSampleAt"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('day', "bucketStart") AS bucket_start,
      "checkId",
      SUM("sampleCount")::int,
      SUM("okCount")::int,
      SUM("failCount")::int,
      ${wavg("avgLatencyMs")}, MIN("minLatencyMs"), MAX("maxLatencyMs"),
      ${wavg("avgDnsMs")}, ${wavg("avgConnectMs")}, ${wavg("avgTlsMs")}, ${wavg("avgTtfbMs")},
      SUM("avgHopCount" * "sampleCount") / NULLIF(SUM(CASE WHEN "avgHopCount" IS NOT NULL THEN "sampleCount" END), 0),
      MAX("maxHopCount"),
      mode() WITHIN GROUP (ORDER BY "modeHttpStatus"),
      MAX("lastBucketSampleAt")
    FROM "asset_path_check_samples_hourly"
    WHERE "bucketStart" >= $1
    GROUP BY "assetId", bucket_start, "checkId"
    ON CONFLICT ("bucketStart", "assetId", "checkId") DO UPDATE SET
      "sampleCount"        = EXCLUDED."sampleCount",
      "okCount"            = EXCLUDED."okCount",
      "failCount"          = EXCLUDED."failCount",
      "avgLatencyMs"       = EXCLUDED."avgLatencyMs",
      "minLatencyMs"       = EXCLUDED."minLatencyMs",
      "maxLatencyMs"       = EXCLUDED."maxLatencyMs",
      "avgDnsMs"           = EXCLUDED."avgDnsMs",
      "avgConnectMs"       = EXCLUDED."avgConnectMs",
      "avgTlsMs"           = EXCLUDED."avgTlsMs",
      "avgTtfbMs"          = EXCLUDED."avgTtfbMs",
      "avgHopCount"        = EXCLUDED."avgHopCount",
      "maxHopCount"        = EXCLUDED."maxHopCount",
      "modeHttpStatus"     = EXCLUDED."modeHttpStatus",
      "lastBucketSampleAt" = EXCLUDED."lastBucketSampleAt"
  `;
}

function sqlPerfSlaDaily(): string {
  // Weighted averages by sampleCount (gauges); min/max carried straight up.
  return `
    INSERT INTO "asset_perf_sla_samples_daily" (
      "id", "assetId", "bucketStart", "healthCheck", "link", "sampleCount",
      "stateUpCount", "stateDownCount",
      "avgLatencyMs", "minLatencyMs", "maxLatencyMs",
      "avgJitterMs", "minJitterMs", "maxJitterMs",
      "avgPacketLoss", "minPacketLoss", "maxPacketLoss",
      "lastBucketSampleAt"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('day', "bucketStart") AS bucket_start,
      "healthCheck",
      "link",
      SUM("sampleCount")::int,
      SUM("stateUpCount")::int,
      SUM("stateDownCount")::int,
      SUM("avgLatencyMs"  * "sampleCount") / NULLIF(SUM("sampleCount"), 0), MIN("minLatencyMs"),  MAX("maxLatencyMs"),
      SUM("avgJitterMs"   * "sampleCount") / NULLIF(SUM("sampleCount"), 0), MIN("minJitterMs"),   MAX("maxJitterMs"),
      SUM("avgPacketLoss" * "sampleCount") / NULLIF(SUM("sampleCount"), 0), MIN("minPacketLoss"), MAX("maxPacketLoss"),
      MAX("lastBucketSampleAt")
    FROM "asset_perf_sla_samples_hourly"
    WHERE "bucketStart" >= $1
    GROUP BY "assetId", bucket_start, "healthCheck", "link"
    ON CONFLICT ("bucketStart", "assetId", "healthCheck", "link") DO UPDATE SET
      "sampleCount"        = EXCLUDED."sampleCount",
      "stateUpCount"       = EXCLUDED."stateUpCount",
      "stateDownCount"     = EXCLUDED."stateDownCount",
      "avgLatencyMs"       = EXCLUDED."avgLatencyMs",
      "minLatencyMs"       = EXCLUDED."minLatencyMs",
      "maxLatencyMs"       = EXCLUDED."maxLatencyMs",
      "avgJitterMs"        = EXCLUDED."avgJitterMs",
      "minJitterMs"        = EXCLUDED."minJitterMs",
      "maxJitterMs"        = EXCLUDED."maxJitterMs",
      "avgPacketLoss"      = EXCLUDED."avgPacketLoss",
      "minPacketLoss"      = EXCLUDED."minPacketLoss",
      "maxPacketLoss"      = EXCLUDED."maxPacketLoss",
      "lastBucketSampleAt" = EXCLUDED."lastBucketSampleAt"
  `;
}

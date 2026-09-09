/**
 * src/services/capacityService.ts
 *
 * Computes a "capacity snapshot" of the host + database + monitoring workload
 * and grades it ok / watch / amber / red. Surfaced via GET
 * /api/v1/server-settings/pg-tuning and rendered on the Server Settings →
 * Maintenance tab; the global navbar banner reads severity from the same
 * payload.
 *
 * Rationale: small DBs need no tuning, but the time-series sample tables
 * (asset_monitor_samples, asset_interface_samples, etc.) grow with
 * monitoredAssets × probe-cadence × retention. Once that product blows past
 * host RAM or *any* of the volumes Polaris/Postgres write to is squeezed,
 * ops needs to know before it bites — not after.
 *
 * Volumes scanned (deduped by stat.dev so single-LV installs collapse cleanly):
 *
 *   app      — install dir (where dist/ lives)
 *   state    — POLARIS_STATE_DIR root (often the same as app)
 *   backups  — encrypted DB dump destination
 *   db       — PostgreSQL `SHOW data_directory`, only when the DB is on
 *              localhost (`appHost.dbColocated` is the hint)
 *
 * Severity tiering:
 *   red    — disk free <10% on any volume, DB > 50% of free disk on its
 *            volume, autovacuum stale >7d on a populated sample table,
 *            projected size > 8× host RAM
 *   amber  — disk 10–20% on any volume, dead-tup >20%, projected > 4× RAM,
 *            pgTuningNeeded, sustained disk-read pressure (db_io_pressure)
 *   watch  — disk 20–30% on any volume; disk-read pressure building or
 *            track_io_timing off (can't measure). Drives the transition Event
 *            to syslog/SFTP archival but NOT the navbar banner — gives ops a
 *            "you have weeks, not minutes" signal before amber.
 */

import { totalmem, freemem, cpus, loadavg } from "node:os";
import { statfs, stat } from "node:fs/promises";
import { PG_DATA_DIR_CANDIDATES, pickFirstExistingPath } from "../utils/startupDiskCheck.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { prisma } from "../db.js";
import { getMonitorSettings, RETENTION_PRUNE_INTERVAL_MS, type MonitorSettings } from "./monitoringService.js";
import { isTimescaleAvailable, isHypertable, ALL_HYPERTABLE_CANDIDATES, getEffectiveCompressAfterDays } from "./timescaleService.js";
import { getSampleRetention, SELECTION_AWARE_ENTITIES, UNSELECTED_DETAIL_HOURS, type RetentionEntity, type RetentionTier, type SampleRetention } from "./sampleRetentionService.js";
import { isPgbossInstalled, getBootTimeMode, getQueueMode } from "./queueService.js";
import { getDeploymentContext } from "../utils/deploymentContext.js";
import { BACKUP_DIR, STATE_DIR } from "../utils/paths.js";
import { logger } from "../utils/logger.js";
import { getDirectDatabaseUrl, isPgbouncerMode } from "../utils/dbConnections.js";
import { logEvent } from "./eventLogService.js";
import { detectFping } from "../utils/burstPing.js";
import { configuredSweepIntervalSec, resolveSweepIntervalSec } from "../utils/lossSweep.js";
import {
  deriveDbIoVerdict,
  IO_VERDICT_STALE_MS,
  DB_IO_WATCH_BACKENDS,
  DB_IO_WARNING_BACKENDS,
  type DbIoReading,
  type DbIoVerdict,
} from "./capacityDbIo.js";

export type Severity = "ok" | "watch" | "warning" | "critical";

// Back-compat shim: older Polaris versions stored severity as "red" / "amber"
// in `Setting.capacity.lastSeverity` and may exist in flight on cached snapshots
// returned from the route handler between an old browser tab and a new server.
// `normalizeSeverity()` accepts either vocabulary and returns the new form so
// downstream comparisons + persistence + metrics stay consistent. The two
// legacy names are intentionally narrowed off the exported `Severity` type so
// new code can't introduce them.
export function normalizeSeverity(s: unknown): Severity {
  if (s === "critical" || s === "warning" || s === "watch" || s === "ok") return s;
  if (s === "red") return "critical";
  if (s === "amber") return "warning";
  return "ok";
}

// ─── Connection-pool peak tracking ───────────────────────────────────────────
//
// Tracks the highest pg_stat_activity count this process has seen across
// every capacity snapshot since boot. Module-local — resets on process
// restart, which is fine: if the pool is genuinely undersized the alert
// will resurface within one capacityWatch tick (10 min) of operator load.
let peakConnectionCount = 0;

// ─── Direct pg.Pool for pg_stat_activity reads ──────────────────────────────
//
// When PgBouncer sits in front of Postgres, the application Prisma client
// goes through it — but `pg_stat_activity` then shows the PgBouncer-side
// view of backend connections, which under-counts what Polaris actually
// holds. Open a tiny dedicated pool (max 2) against the direct URL so the
// pool-saturation gauges + the Capacity Advisor's pool sizing read the
// real cluster-side state.
//
// Lazy-init: under single-URL installs we never instantiate this and just
// route the query through `prisma` like before. Same data, no extra pool.
let directStatsPool: pg.Pool | null = null;

function getDirectStatsPool(): pg.Pool | null {
  if (!isPgbouncerMode()) return null;
  if (directStatsPool) return directStatsPool;
  const url = getDirectDatabaseUrl();
  if (!url) return null;
  directStatsPool = new pg.Pool({ connectionString: url, max: 2 });
  directStatsPool.on("error", (err) => {
    logger.warn({ err: err.message }, "capacityService: direct stats pool error");
  });
  return directStatsPool;
}

async function readPgStatActivity(): Promise<{ in_use: number; max: number }> {
  const directPool = getDirectStatsPool();
  const sql = `
    SELECT
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS in_use,
      (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max
  `;
  try {
    if (directPool) {
      const r = await directPool.query<{ in_use: number; max: number }>(sql);
      return r.rows[0] ?? { in_use: 0, max: 0 };
    }
    const r = await prisma.$queryRawUnsafe<{ in_use: number; max: number }[]>(sql);
    return r[0] ?? { in_use: 0, max: 0 };
  } catch {
    return { in_use: 0, max: 0 };
  }
}

// ─── Disk-read pressure (pg_stat_database) ───────────────────────────────────
//
// Replaces the old size-based `ram_insufficient` heuristic. The pure rate math
// + tunable thresholds live in capacityDbIo.ts (dependency-free, unit-tested);
// this module owns the DB read + module-local rate state. We flag RAM pressure
// only when the host is genuinely waiting on storage — medium-aware (HDD vs
// SATA vs NVMe) and OS-page-cache-aware for free, because an in-cache read
// returns from read() in ~0ms. blk_read_time is only populated when
// `track_io_timing = on`; when it's off we can't measure and nudge the operator
// to enable it instead of guessing.

// Module-local rate state — same accepted tradeoff as `peakConnectionCount`
// above: resets on process restart, re-warms within one capacityWatch tick.
// capacityWatch and the Maintenance route both run on the `web` role, the same
// process, so the baseline is shared between them.
let prevDbIo: DbIoReading | null = null;
let lastIoVerdict: { verdict: DbIoVerdict; atMs: number } | null = null;

async function readPgStatDatabaseIo(): Promise<DbIoReading | null> {
  const directPool = getDirectStatsPool();
  // clock_timestamp() (not now()) so elapsed reflects wall time, not txn start.
  const sql = `
    SELECT
      blks_read::float8                                   AS "blksRead",
      blks_hit::float8                                    AS "blksHit",
      COALESCE(blk_read_time, 0)::float8                  AS "blkReadTime",
      (current_setting('track_io_timing') = 'on')         AS "trackIoTiming",
      (extract(epoch FROM clock_timestamp()) * 1000.0)::float8 AS "nowMs"
    FROM pg_stat_database
    WHERE datname = current_database()
  `;
  type Row = { blksRead: number; blksHit: number; blkReadTime: number; trackIoTiming: boolean; nowMs: number };
  try {
    const row = directPool
      ? (await directPool.query<Row>(sql)).rows[0]
      : (await prisma.$queryRawUnsafe<Row[]>(sql))[0];
    if (!row) return null;
    return {
      nowMs: Number(row.nowMs),
      blksRead: Number(row.blksRead),
      blksHit: Number(row.blksHit),
      blkReadTime: Number(row.blkReadTime),
      trackIoTiming: Boolean(row.trackIoTiming),
    };
  } catch {
    return null;
  }
}

/**
 * Read pg_stat_database, fold it against the previous reading into the snapshot
 * `io` shape, and advance the module-local rate state. A measured verdict is
 * cached so a sub-window Maintenance-tab refresh between capacityWatch ticks
 * reuses it instead of flickering the reason off.
 */
async function computeDbIoState(): Promise<CapacitySnapshot["database"]["io"]> {
  const reading = await readPgStatDatabaseIo();
  if (!reading) {
    return { trackIoTiming: false, measured: false, avgBackendsBlockedOnDisk: null, windowSeconds: null };
  }
  const verdict = deriveDbIoVerdict(prevDbIo, reading);
  prevDbIo = reading;
  if (verdict.measured) {
    lastIoVerdict = { verdict, atMs: reading.nowMs };
    return { trackIoTiming: reading.trackIoTiming, ...verdict };
  }
  if (lastIoVerdict && reading.nowMs - lastIoVerdict.atMs < IO_VERDICT_STALE_MS) {
    return { trackIoTiming: reading.trackIoTiming, ...lastIoVerdict.verdict };
  }
  return { trackIoTiming: reading.trackIoTiming, measured: false, avgBackendsBlockedOnDisk: null, windowSeconds: null };
}

function readEnvInt(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

export interface CapacityReason {
  severity: "watch" | "warning" | "critical";
  code: string;
  message: string;
  suggestion: string;
  /** Optional grouping tag. Reasons sharing a family collapse to the
   *  highest-severity one in `collapseReasonsByFamily()`; lower-severity
   *  reasons in the same family are suppressed from the rendered card.
   *  Reasons without a family pass through unchanged. */
  family?: string;
}

export type VolumeRole = "app" | "state" | "backups" | "db";

export interface VolumeStat {
  /** All Polaris-named paths that resolve to this filesystem. */
  paths: string[];
  /** Roles this volume serves (deduped). Useful for the operator-facing label. */
  roles: VolumeRole[];
  freeBytes: number;
  totalBytes: number;
}

export interface CapacitySampleTable {
  name: string;
  rows: number;
  bytes: number;
  avgBytesPerRow: number;
  deadTupRatio: number;
  lastAutovacuum: string | null;
}

export interface CapacitySnapshot {
  computedAt: string;
  severity: Severity;
  reasons: CapacityReason[];
  appHost: {
    cpuCount: number;
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    loadAvg: [number, number, number];
    /**
     * Every distinct filesystem Polaris and (when co-located) Postgres write
     * to. Pre-deduped by stat.dev so a single-LV box shows one entry, a
     * STIG-style RHEL with separate /var and /opt LVs shows two, etc.
     */
    volumes: VolumeStat[];
    /**
     * Is fping on PATH? A HOST fact, not a workload one, and it changes how
     * much the ICMP cadences cost: with it, one process serves up to 500
     * targets; without it Polaris forks per host. Probed once per process and
     * cached, so this is free after the first snapshot.
     */
    hasFping: boolean;
    dbColocated: boolean;
  };
  database: {
    sizeBytes: number;
    sampleTables: CapacitySampleTable[];
    /**
     * PostgreSQL `SHOW data_directory` value. Null when the DB is remote
     * (path is meaningless on this host) or when the SHOW failed.
     */
    dataDirectory: string | null;
    /**
     * TimescaleDB extension + per-table hypertable status. Drives the
     * `timescale_recommended` reason and is surfaced on the Maintenance tab
     * so operators can see at a glance whether their sample tables are on
     * the fast path (hypertable + chunk-drop prune + compression).
     */
    timescale: {
      extensionInstalled: boolean;
      hypertableTables: string[];
    };
    /**
     * Monitor work queue status. `pgbossInstalled` reflects whether the
     * pg-boss npm package is available at runtime; `active` is the mode
     * the running process is using (captured from Setting at boot);
     * `persisted` is the current Setting value (= what the next process
     * restart will use). When `active !== persisted`, the operator has
     * flipped the mode via the [Enable on next restart] button and a
     * restart is pending. Surfaced on the Maintenance tab Capabilities row.
     */
    queue: {
      pgbossInstalled: boolean;
      active: "cursor" | "pgboss";
      persisted: "cursor" | "pgboss";
    };
    /**
     * Live connection-pool picture against PostgreSQL's `max_connections`.
     *
     * `currentInUse` is the snapshot count from pg_stat_activity at the time
     * this CapacitySnapshot was built. `peakObserved` is a rolling high-water
     * mark tracked in module-local memory across snapshots — captures the
     * worst-case during discovery / peak monitoring even though the snapshot
     * itself might land during a quiet moment. Resets on process restart;
     * acceptable because the alert recurs naturally if the pool is genuinely
     * undersized.
     *
     * `prismaPoolSize` is what the Prisma driver-adapter pool was created with
     * (DATABASE_POOL_SIZE env var, default 25). `pgbossPoolSize` is what
     * pg-boss's separate internal pool was created with (POLARIS_PGBOSS_POOL_SIZE
     * env var, default 10) — null when the boot-time queue mode is "cursor"
     * since pg-boss isn't running.
     *
     * Drives the `db_pool_undersized` capacity reason and is surfaced on the
     * Maintenance tab Database card so operators can see headroom at a glance.
     */
    connectionPool: {
      currentInUse: number;
      peakObserved: number;
      prismaPoolSize: number;
      pgbossPoolSize: number | null;
      maxConnections: number;
    };
    /**
     * Last successful run timestamp for each rollup tier, stamped by the
     * `sampleRollup.<tier>` job via `Setting("sampleRollup.<tier>.lastSuccess")`.
     * Null when no successful run has landed yet (fresh install before the
     * first tick fires). Drives the `sample_rollup_lagging` watch reason
     * which catches a stuck rollup before the detail tier outgrows its
     * window with no aggregates produced.
     */
    rollupLastSuccess: {
      hourly: string | null;
      daily:  string | null;
    };
    /**
     * Measured disk-read pressure, derived from `pg_stat_database` between
     * successive snapshots (rate, not the cumulative-since-reset counters).
     * Drives the `db_io_pressure` watch/warning and the `track_io_timing_off`
     * watch — the replacement for the old size-based `ram_insufficient`
     * heuristic.
     *
     * `trackIoTiming` is PostgreSQL's `track_io_timing` GUC: when off,
     * `blk_read_time` stays 0 so we can't tell OS-cache hits from real disk
     * reads — `measured` is false and we nudge the operator to enable it.
     *
     * `avgBackendsBlockedOnDisk` = Δblk_read_time(ms) / Δelapsed(ms) over the
     * window — intuitively "average number of connections continuously blocked
     * on storage reads." Medium-aware for free: a cache miss costs ~5-10ms on
     * spinning disk, ~0.02ms on NVMe, ~0 on an OS-page-cache hit, so this is
     * high only when misses are both frequent AND slow.
     *
     * `measured` is false on the first snapshot of a process, on too-short a
     * window, or after a stats reset — consumers must not fire a reason then.
     */
    io: {
      trackIoTiming: boolean;
      measured: boolean;
      avgBackendsBlockedOnDisk: number | null;
      windowSeconds: number | null;
    };
  };
  workload: {
    monitoredAssetCount: number;
    /**
     * Total operator-pinned interfaces being polled on the fast cadence — sum
     * of `Asset.monitoredInterfaces` PLUS `Asset.monitoredIpsecTunnels` array
     * lengths across every monitored asset (IPsec tunnels are interfaces from
     * the operator's perspective and fast-poll the same way). Independent of
     * the ~20-iface-per-asset default the steady-state projection assumes for
     * the full system-info pass; this is just the fast-poll subset operators
     * have explicitly opted into.
     */
    monitoredInterfaceCount: number;
    /**
     * Total operator-pinned storage mounts being polled on the fast cadence —
     * sum of `Asset.monitoredStorage` array lengths across every monitored
     * asset.
     */
    monitoredStorageCount: number;
    cadences: { responseTimeSec: number; telemetrySec: number; systemInfoSec: number };
    retention: { monitorDays: number; telemetryDays: number; systemInfoDays: number };
    /**
     * Steady-state DB size at the current cadences, retention, and monitored
     * asset count. This is what the database will grow to *if nothing changes*
     * — not a 30-day forecast. Calculated by extrapolating per-asset row rates
     * across the configured retention window for every time-series sample
     * table, then summing.
     */
    steadyStateSizeBytes: number;
  };
}

// Tables we project. Each maps to which (stream, tier) governs its retention
// AND which asset-count bucket populates it.
//
//   "all"        — every monitored asset (response-time probe fires for all,
//                  including managed switches/APs via the controller path)
//   "telemetry"  — assets whose resolved telemetry method can actually deliver
//                  CPU/memory data. Managed FortiSwitches/FortiAPs on REST API
//                  are excluded: the endpoint lives on the parent FortiGate,
//                  not the device's IP, so collectTelemetry returns
//                  {supported:false} and lastTelemetryAt never advances.
//   "systemInfo" — same exclusion for interface/storage/IPsec/LLDP tables.
//                  WinRM and SSH *do* support system-info in principle so they
//                  are not excluded here (only the REST API + switch/AP combo).
//   null         — no cadence-driven row model exists for this table (the
//                  STANDALONE hypertables: log lines, custom-widget probes and
//                  state probes are emitted per matched line / per pinned item,
//                  not once per asset per tick). These project from their
//                  MEASURED daily byte-rate only, falling back to their current
//                  on-disk size rather than to a workload guess.
//
// Every table listed here must also be measured by getSampleTableStats(), because
// projectSteadyStateSize() subtracts the measured bytes of the whole list from the
// database size before adding the projection back. A managed hypertable MISSING
// from this list is therefore not merely unprojected — its bytes stay inside
// `baseBytes` and ride into the steady-state figure at face value, so the
// projection tracks the live database size instead of forecasting it. That is
// exactly what `asset_service_log_samples` did (13 GB of an 89 GB prod database,
// 2026-09): it was added to STANDALONE_SAMPLE_TABLES without a projection entry.
// `tests/unit/timescaleTables.test.ts` now fails when a managed hypertable is
// neither projected here nor listed as deliberately exempt.
//
// Detail tier rows are the raw per-cadence samples (rate driven by the
// monitor cadence settings). Hourly tier is a fixed 24 buckets/day per
// (asset, extra-key) cell; daily tier is 1 bucket/day per (asset, extra-key).
export const SAMPLE_TABLES: Array<{
  name: string;
  entity: RetentionEntity;
  tier:   RetentionTier;
  countKey: "all" | "telemetry" | "systemInfo" | null;
}> = [
  // Source (detail) tables
  { name: "asset_monitor_samples",       entity: "assets",      tier: "detail", countKey: "all"        },
  { name: "asset_telemetry_samples",     entity: "cpuMem",      tier: "detail", countKey: "telemetry"  },
  { name: "asset_hardware_sensor_samples", entity: "hardware",  tier: "detail", countKey: "telemetry"  },
  { name: "asset_interface_samples",     entity: "interfaces",  tier: "detail", countKey: "systemInfo" },
  { name: "asset_storage_samples",       entity: "storage",     tier: "detail", countKey: "systemInfo" },
  { name: "asset_ipsec_tunnel_samples",  entity: "ipsec",       tier: "detail", countKey: "systemInfo" },
  // SD-WAN streams ride the system-info cadence but only emit on FortiGate
  // firewalls with pullSdwan enabled — countKey "systemInfo" overestimates on
  // mixed fleets; learned avg bytes/row + actual row counts take over as soon
  // as the tables are non-empty.
  { name: "asset_perf_sla_samples",      entity: "perfSla",     tier: "detail", countKey: "systemInfo" },
  // Process telemetry is opt-in PER PINNED PROGRAM (Asset.monitoredProcesses) —
  // most assets pin zero, so countKey "telemetry" over-projects on mixed
  // fleets; learned row counts take over once the table is non-empty (same
  // caveat as perfSla). rowsPerAssetPerDay assumes ~1 pinned program.
  { name: "asset_process_samples",       entity: "process",     tier: "detail", countKey: "telemetry"  },
  // Standalone detail-only hypertables (timescaleService.STANDALONE_SAMPLE_TABLES):
  // no rollup companions and not RETENTION_ENTITYs of their own, so each rides an
  // umbrella window — the two log tables on `process.detail`, the widget/state
  // probes on `interfaces.detail`, matching the pruneTierByDays call sites in
  // monitoringService. countKey is null: rows are emitted per matched log line /
  // per pinned widget or state row, which no per-asset cadence multiplier models
  // honestly, so these project measured-only.
  { name: "asset_service_log_samples",   entity: "process",     tier: "detail", countKey: null         },
  { name: "asset_process_log_samples",   entity: "process",     tier: "detail", countKey: null         },
  { name: "asset_custom_widget_samples", entity: "interfaces",  tier: "detail", countKey: null         },
  { name: "asset_state_samples",         entity: "interfaces",  tier: "detail", countKey: null         },
  // (asset_sdwan_rules is current-state, not a sample table — excluded from the projection.)
  // Hourly rollups
  { name: "asset_monitor_samples_hourly",       entity: "assets",      tier: "hourly", countKey: "all"        },
  { name: "asset_telemetry_samples_hourly",     entity: "cpuMem",      tier: "hourly", countKey: "telemetry"  },
  { name: "asset_hardware_sensor_samples_hourly", entity: "hardware",  tier: "hourly", countKey: "telemetry"  },
  { name: "asset_interface_samples_hourly",     entity: "interfaces",  tier: "hourly", countKey: "systemInfo" },
  { name: "asset_storage_samples_hourly",       entity: "storage",     tier: "hourly", countKey: "systemInfo" },
  { name: "asset_ipsec_tunnel_samples_hourly",  entity: "ipsec",       tier: "hourly", countKey: "systemInfo" },
  { name: "asset_perf_sla_samples_hourly",      entity: "perfSla",     tier: "hourly", countKey: "systemInfo" },
  { name: "asset_process_samples_hourly",       entity: "process",     tier: "hourly", countKey: "telemetry"  },
  // Daily rollups
  { name: "asset_monitor_samples_daily",        entity: "assets",      tier: "daily",  countKey: "all"        },
  { name: "asset_telemetry_samples_daily",      entity: "cpuMem",      tier: "daily",  countKey: "telemetry"  },
  { name: "asset_hardware_sensor_samples_daily", entity: "hardware",  tier: "daily",  countKey: "telemetry"  },
  { name: "asset_interface_samples_daily",      entity: "interfaces",  tier: "daily",  countKey: "systemInfo" },
  { name: "asset_storage_samples_daily",        entity: "storage",     tier: "daily",  countKey: "systemInfo" },
  { name: "asset_ipsec_tunnel_samples_daily",   entity: "ipsec",       tier: "daily",  countKey: "systemInfo" },
  { name: "asset_perf_sla_samples_daily",       entity: "perfSla",     tier: "daily",  countKey: "systemInfo" },
  { name: "asset_process_samples_daily",        entity: "process",     tier: "daily",  countKey: "telemetry"  },
];

// Cadence intervals consumed by the rows-per-asset-per-day calc. Source
// tables drive their rate from the monitor cadence settings; rollup tables
// are tier-fixed (24 buckets/day for hourly, 1 for daily) and ignore
// the cadence input.
/**
 * Selection-aware entities whose DETAIL tier is still dominated by unselected
 * (`cadence="slow"`) rows pruned at UNSELECTED_DETAIL_HOURS.
 *
 * A subset of SELECTION_AWARE_ENTITIES: `interfaces` left it in the pinned-only
 * cutover (unpinned interfaces stopped producing sample rows entirely — their
 * current state moved to `asset_interfaces`), so its detail tier is now
 * all-pinned and keeps the configured retention like any ordinary stream.
 * Storage and IPsec still write the slow rows and keep the 24h cap.
 */
const UNSELECTED_DOMINATED_ENTITIES: readonly string[] = SELECTION_AWARE_ENTITIES.filter(
  (e) => e !== "interfaces",
);

interface WorkloadModelInputs {
  sample: number;
  telemetry: number;
  systemInfo: number;
  /** Fleet-average PINNED interfaces per system-info-eligible asset
   *  (sum of Asset.monitoredInterfaces / eligible asset count).
   *
   *  Not a cadence, but it belongs in the same model input: since the
   *  pinned-only cutover, `asset_interface_samples` carries one row per PINNED
   *  interface per scrape rather than one per interface, so the row rate scales
   *  with what operators pinned rather than with port count. Modelling it as a
   *  flat ~20 interfaces/asset would now over-project badly on a fleet of
   *  48-port switches with two pinned uplinks each — and an over-projection
   *  raises false capacity warnings. */
  pinnedIfacesPerAsset: number;
}

// Default rows-per-asset-per-day when we have no samples yet to learn from.
// Numbers are deliberately conservative so a fresh install with monitoring
// just turned on still gets a sensible projection. Multipliers for tables
// with an extra-key dimension (sensorName / ifName / mountPath / tunnelName)
// match the prior single-tier defaults.
const DEFAULT_ROWS_PER_ASSET_PER_DAY: Record<string, (c: WorkloadModelInputs) => number> = {
  // Source tables — rate × extra-key multiplier
  // One row per response-time poll. The ICMP loss sampler (utils/lossSweep.ts)
  // writes additional rows at 10s, but ONLY while an asset sits in
  // warning/recovering — so its volume is a function of how much of the day the
  // fleet spends mid-incident, not of fleet size. Deliberately not modelled:
  // assuming the worst case (every asset sampled continuously) would inflate
  // every install's projection ~6-30x for rows that a healthy fleet never
  // writes, and the projection's job is to size steady state. A fleet in
  // sustained trouble will show it in the measured table size instead, which is
  // what the advisor reads once there is history.
  asset_monitor_samples:       (c) => 86400 / c.sample,
  asset_telemetry_samples:     (c) => 86400 / c.telemetry,
  asset_hardware_sensor_samples: (c) => (86400 / c.telemetry)  * 12,  // ~12 sensors (FortiGates ~22)
  // PINNED interfaces only, and they are written on BOTH cadences: the full
  // system-info pass covers them, and the fast re-walk re-scrapes them on the
  // probe interval. Unpinned interfaces no longer produce sample rows at all —
  // their current state lives in `asset_interfaces` (see AssetInterface).
  asset_interface_samples:     (c) => ((86400 / c.systemInfo) + (86400 / c.sample)) * c.pinnedIfacesPerAsset,
  asset_storage_samples:       (c) => (86400 / c.systemInfo) * 3,   // ~3 mounts
  asset_ipsec_tunnel_samples:  (c) => (86400 / c.systemInfo) * 1,   // ~1 tunnel
  asset_perf_sla_samples:      (c) => (86400 / c.systemInfo) * 4,   // ~2 health-checks × 2 WAN members (SD-WAN FortiGates only)
  asset_process_samples:       (c) => (86400 / c.telemetry)  * 1,   // ~1 pinned program (opt-in; most assets pin zero)
  // Hourly rollups — 24 buckets/day × extra-key multiplier
  asset_monitor_samples_hourly:       () => 24,
  asset_telemetry_samples_hourly:     () => 24,
  asset_hardware_sensor_samples_hourly: () => 24 * 12,
  // Rollups have always been cadence='fast' only, so keying them off pinned
  // count rather than a flat ~20 interfaces/asset also corrects a pre-existing
  // over-projection, not just the effect of the pinned-only cutover.
  asset_interface_samples_hourly:     (c) => 24 * c.pinnedIfacesPerAsset,
  asset_storage_samples_hourly:       () => 24 * 3,
  asset_ipsec_tunnel_samples_hourly:  () => 24,
  asset_perf_sla_samples_hourly:      () => 24 * 4,
  asset_process_samples_hourly:       () => 24 * 1,
  // Daily rollups — 1 bucket/day × extra-key multiplier
  asset_monitor_samples_daily:        () => 1,
  asset_telemetry_samples_daily:      () => 1,
  asset_hardware_sensor_samples_daily: () => 12,
  asset_interface_samples_daily:      (c) => c.pinnedIfacesPerAsset,
  asset_storage_samples_daily:        () => 3,
  asset_ipsec_tunnel_samples_daily:   () => 1,
  asset_perf_sla_samples_daily:       () => 4,
  asset_process_samples_daily:        () => 1,
};

// Defaults used only when a table has zero rows (so avg bytes/row is unknown).
// Rollup rows are slightly larger than source rows on the gauge tables
// (extra avg/min/max columns) and substantially larger on the counter tables
// (first/last endpoints + last-seen descriptor columns).
const DEFAULT_BYTES_PER_ROW: Record<string, number> = {
  asset_monitor_samples:       310,
  asset_telemetry_samples:     325,
  asset_hardware_sensor_samples: 330,
  asset_interface_samples:     395,
  asset_storage_samples:       310,
  asset_ipsec_tunnel_samples:  390,
  asset_perf_sla_samples:      360,
  asset_process_samples:       320,
  // Hourly + daily rollup defaults share the same shape per source.
  asset_monitor_samples_hourly:      280,
  asset_monitor_samples_daily:       280,
  asset_telemetry_samples_hourly:    340,
  asset_telemetry_samples_daily:     340,
  asset_hardware_sensor_samples_hourly:  280,
  asset_hardware_sensor_samples_daily:   280,
  asset_interface_samples_hourly:    420,
  asset_interface_samples_daily:     420,
  asset_storage_samples_hourly:      280,
  asset_storage_samples_daily:       280,
  asset_ipsec_tunnel_samples_hourly: 360,
  asset_ipsec_tunnel_samples_daily:  360,
  asset_perf_sla_samples_hourly:     360,
  asset_perf_sla_samples_daily:      360,
  asset_process_samples_hourly:      340,
  asset_process_samples_daily:       340,
};

const APP_DIR = dirname(fileURLToPath(import.meta.url));

// Conventional PGDATA paths per platform. Used when `SHOW data_directory`
// fails — typically because the application's DB role is not a superuser and
// not a member of `pg_read_all_settings` (the default in a least-privilege
// install), which makes `data_directory` unreadable. Without this fallback a
// separate /var on a STIG-style RHEL layout never enters the volume scan and
// the UI shows only the app volume even when /var is the at-risk filesystem.
// Candidate list + probe shared with the boot-time check — see
// utils/startupDiskCheck.ts (was a verbatim copy here until the 2026-08 audit).

function isDbLocal(): boolean {
  const url = process.env.DATABASE_URL || "";
  const m = url.match(/@([^:/?]+)/);
  if (!m) return false;
  const host = m[1].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Resolve PostgreSQL's data directory. Tries `SHOW data_directory` first
 * because it's authoritative when it works; falls back to scanning the
 * platform's conventional PGDATA candidates when it doesn't (the common case
 * is a non-superuser application role lacking `pg_read_all_settings`, which
 * makes `data_directory` unreadable). Returns null when the DB is remote or
 * when no candidate path exists on disk.
 */
async function resolveDbDataDirectory(): Promise<string | null> {
  if (!isDbLocal()) return null;
  try {
    const rows = await prisma.$queryRawUnsafe<{ data_directory: string }[]>(
      "SHOW data_directory",
    );
    const path = rows[0]?.data_directory;
    if (path && path.length > 0) return path;
  } catch (err: any) {
    logger.debug({ err: err?.message }, "capacityService: SHOW data_directory failed, falling back to platform candidates");
  }
  return pickFirstExistingPath(PG_DATA_DIR_CANDIDATES);
}

/**
 * Statfs a single path. Returns null on any failure (path missing, permission
 * denied, statfs unsupported). Caller drops null entries.
 */
async function statfsPath(
  path: string,
  role: VolumeRole,
): Promise<{ role: VolumeRole; path: string; dev: number; freeBytes: number; totalBytes: number } | null> {
  try {
    const [fs, st] = await Promise.all([statfs(path), stat(path)]);
    return {
      role,
      path,
      dev: Number(st.dev),
      freeBytes: Number(fs.bavail) * Number(fs.bsize),
      totalBytes: Number(fs.blocks) * Number(fs.bsize),
    };
  } catch {
    return null;
  }
}

/**
 * Build the deduped volume list. Each candidate path is statfs'd; entries
 * sharing the same stat.dev are merged so a single-volume box reports one
 * row (with multiple roles), and a multi-LV layout reports each filesystem
 * once. Roles are preserved as a set so the UI can label "app + state + db
 * on /var" or "db alone on /var/lib/pgsql".
 */
async function getVolumes(dataDirectory: string | null): Promise<VolumeStat[]> {
  const candidates: Array<{ role: VolumeRole; path: string }> = [
    { role: "app",     path: APP_DIR    },
    { role: "state",   path: STATE_DIR  },
    { role: "backups", path: BACKUP_DIR },
  ];
  if (dataDirectory) candidates.push({ role: "db", path: dataDirectory });

  const probed = (await Promise.all(candidates.map((c) => statfsPath(c.path, c.role))))
    .filter((v): v is NonNullable<typeof v> => v !== null);

  // Dedupe by stat.dev. Roles and paths accumulate; free/total are the same
  // for every entry on the same dev so we just take the first.
  const byDev = new Map<number, VolumeStat>();
  for (const p of probed) {
    const existing = byDev.get(p.dev);
    if (existing) {
      if (!existing.roles.includes(p.role)) existing.roles.push(p.role);
      if (!existing.paths.includes(p.path)) existing.paths.push(p.path);
    } else {
      byDev.set(p.dev, {
        paths: [p.path],
        roles: [p.role],
        freeBytes: p.freeBytes,
        totalBytes: p.totalBytes,
      });
    }
  }

  // Stable order: by lowest-free-percent first, so the most-at-risk volume
  // is always the first reasons-loop sees and the first the UI renders.
  return [...byDev.values()].sort((a, b) => {
    const pctA = a.totalBytes > 0 ? a.freeBytes / a.totalBytes : 1;
    const pctB = b.totalBytes > 0 ? b.freeBytes / b.totalBytes : 1;
    return pctA - pctB;
  });
}

interface PgStatRow {
  relname: string;
  n_live_tup: bigint;
  n_dead_tup: bigint;
  bytes: bigint;
  last_autovacuum: Date | null;
}

async function getSampleTableStats(): Promise<CapacitySampleTable[]> {
  const names = SAMPLE_TABLES.map((t) => t.name);
  // Catalog-only sizing — chunk-aware. `pg_total_relation_size(parent)` on a
  // PG11+ partitioned/inheritance parent recursively sums all children's
  // relfilenodes via stat(); for TimescaleDB hypertables (asset_monitor_samples
  // + the 5 *_hourly / *_daily rollups, each potentially backed by hundreds
  // of chunks in _timescaledb_internal.*) that becomes thousands of fs
  // syscalls per call and dominated the Maintenance tab's last 30s of
  // wall-clock. We replace it with a sum of relpages over the parent + its
  // inheritance children (chunks) + their indexes, all read from pg_class.
  // n_live_tup / n_dead_tup likewise aggregate parent + chunks because the
  // parent's own pg_stat_user_tables row is 0/0 for hypertables.
  const rows = await prisma.$queryRawUnsafe<PgStatRow[]>(
    `WITH parents AS (
       SELECT c.oid, c.relname, c.relpages
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = ANY($1::text[])
     ),
     children AS (
       SELECT p.oid AS parent_oid, i.inhrelid AS rel_oid
       FROM parents p
       JOIN pg_inherits i ON i.inhparent = p.oid
     ),
     parent_index_pages AS (
       SELECT p.oid AS parent_oid, COALESCE(SUM(ic.relpages), 0)::bigint AS pages
       FROM parents p
       LEFT JOIN pg_index ix ON ix.indrelid = p.oid
       LEFT JOIN pg_class ic ON ic.oid = ix.indexrelid
       GROUP BY p.oid
     ),
     child_heap_pages AS (
       SELECT c.parent_oid, COALESCE(SUM(cls.relpages), 0)::bigint AS pages
       FROM children c
       JOIN pg_class cls ON cls.oid = c.rel_oid
       GROUP BY c.parent_oid
     ),
     child_index_pages AS (
       SELECT c.parent_oid, COALESCE(SUM(ic.relpages), 0)::bigint AS pages
       FROM children c
       JOIN pg_index ix ON ix.indrelid = c.rel_oid
       JOIN pg_class ic ON ic.oid = ix.indexrelid
       GROUP BY c.parent_oid
     ),
     child_stats AS (
       SELECT
         c.parent_oid,
         COALESCE(SUM(s.n_live_tup), 0)::bigint AS n_live_tup,
         COALESCE(SUM(s.n_dead_tup), 0)::bigint AS n_dead_tup,
         MAX(s.last_autovacuum) AS last_autovacuum
       FROM children c
       LEFT JOIN pg_stat_user_tables s ON s.relid = c.rel_oid
       GROUP BY c.parent_oid
     )
     SELECT
       p.relname,
       (COALESCE(ps.n_live_tup, 0) + COALESCE(cs.n_live_tup, 0))::bigint AS n_live_tup,
       (COALESCE(ps.n_dead_tup, 0) + COALESCE(cs.n_dead_tup, 0))::bigint AS n_dead_tup,
       ((p.relpages + COALESCE(pip.pages, 0) + COALESCE(chp.pages, 0) + COALESCE(cip.pages, 0))::bigint
         * current_setting('block_size')::bigint)::bigint AS bytes,
       GREATEST(ps.last_autovacuum, cs.last_autovacuum) AS last_autovacuum
     FROM parents p
     LEFT JOIN pg_stat_user_tables ps ON ps.relid = p.oid
     LEFT JOIN parent_index_pages pip ON pip.parent_oid = p.oid
     LEFT JOIN child_heap_pages chp ON chp.parent_oid = p.oid
     LEFT JOIN child_index_pages cip ON cip.parent_oid = p.oid
     LEFT JOIN child_stats cs ON cs.parent_oid = p.oid`,
    names,
  );

  // Index by name so we can return a stable, complete list even when a table
  // isn't yet in pg_stat_user_tables (fresh install before first insert).
  const byName = new Map(rows.map((r) => [r.relname, r]));
  return SAMPLE_TABLES.map((t) => {
    const r = byName.get(t.name);
    const live = r ? Number(r.n_live_tup) : 0;
    const dead = r ? Number(r.n_dead_tup) : 0;
    const bytes = r ? Number(r.bytes) : 0;
    const total = live + dead;
    // Divide by (live + dead) so a bloated table — tiny live count, large dead
    // count from a recent aggressive prune — doesn't produce an absurd per-row
    // estimate. bytes / 8 live rows on a 180 MB table → 22 MB/row; bytes /
    // (8 + 80k dead) → ~2 kB/row, which is realistic.
    const avgBytesPerRow = total > 0 ? Math.round(bytes / total) : DEFAULT_BYTES_PER_ROW[t.name] ?? 300;
    return {
      name: t.name,
      rows: live,
      bytes,
      avgBytesPerRow,
      deadTupRatio: total > 0 ? dead / total : 0,
      lastAutovacuum: r?.last_autovacuum ? r.last_autovacuum.toISOString() : null,
    };
  });
}

/** Median of a non-empty numeric array (robust to a single bloated outlier). */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const DETAIL_TABLE_NAMES: readonly string[] = SAMPLE_TABLES.filter((d) => d.tier === "detail").map((d) => d.name);

/** A chunk must have been accumulating for at least this long before its
 *  bytes / elapsed-days rate means anything. A chunk opened ten minutes ago
 *  holds a few pages over a few minutes and yields a wildly noisy rate in
 *  either direction, so it is left out of the median. */
const MIN_MEASURABLE_CHUNK_DAYS = 0.25;

/**
 * Measure the real per-day on-disk footprint of each DETAIL hypertable from its
 * recent UNCOMPRESSED chunks. Returns bytes/day per table (median of the
 * per-chunk rates over up to 8 recent chunks); a table with no chunk that has
 * been filling for at least MIN_MEASURABLE_CHUNK_DAYS is omitted, and the caller
 * falls back to the workload model — or, for the standalone tables that have no
 * workload model, to the table's current size.
 *
 * Why measure instead of the count×rows×bytesPerRow workload model: that model
 * can't see index + page overhead and relies on hardcoded per-asset multipliers
 * (interfaces/sensors/mounts per asset) that are wildly fleet-specific — on a
 * real fleet it underprojected interface detail ~33× (2026-06: assumed 20
 * ifaces × 24h unselected cap × 395 B/row vs. reality 9,418 pinned interfaces ×
 * 7-day retention × ~1.1 kB/row on disk). A chunk's size IS the true daily
 * footprint, indexes and all.
 *
 * Why the span is ELAPSED (`LEAST(range_end, now()) - range_start`) rather than
 * the chunk's nominal range, and why the currently-filling chunk counts instead
 * of being excluded as unsettled: a table whose detail retention is SHORTER than
 * its chunk interval only ever has ONE chunk, and that chunk's `range_end` is
 * always in the future — so the old "settled" filter (range_end older than 24 h)
 * matched nothing and the table fell back to the workload guess forever. On prod
 * that silently described `asset_hardware_sensor_samples` — 15 GB, the
 * second-largest table in the database, 3-day retention against a 7-day chunk
 * interval (2026-09). An elapsed span measures a partial chunk correctly because
 * the same partiality divides out of numerator and denominator.
 *
 * (The old filter also compared a timestamptz against `now() AT TIME ZONE 'UTC'`,
 * which Postgres re-casts using the session zone — on a UTC−5 host that made the
 * intended 24 h settling window 19 h. Comparing against plain `now()` is right:
 * `timescaledb_information.chunks` reports its ranges as timestamptz anchored to
 * UTC even when the partition column is a bare `timestamp`.)
 *
 * Why "uncompressed" only: a compressed chunk's bytes are its post-compression
 * footprint, so mixing them in understates the rate at which the table lays
 * bytes down. Median over several chunks tolerates a single
 * decompression-bloated outlier.
 */
async function measureDetailDailyBytes(): Promise<Record<string, number>> {
  // One query per detail/standalone hypertable, fanned out: the per-table rates
  // are independent, and the list is a fixed 13 tables regardless of fleet size
  // (each capped at 8 chunks), so this is bounded at both 100 and 2000 monitored
  // assets. Sequential awaits here were 13 catalog round-trips in series on a
  // path the Maintenance tab waits on.
  const measured = await Promise.all(
    DETAIL_TABLE_NAMES.filter((name) => isHypertable(name)).map(async (name) => {
      try {
        const rows = await prisma.$queryRawUnsafe<{ bytes: bigint | null; elapsed_secs: number | null }[]>(
          `SELECT pg_total_relation_size(format('%I.%I', chunk_schema, chunk_name)::regclass) AS bytes,
                  EXTRACT(epoch FROM (LEAST(range_end, now()) - range_start)) AS elapsed_secs
             FROM timescaledb_information.chunks
            WHERE hypertable_name = $1
              AND NOT is_compressed
              AND range_start < now()
            ORDER BY range_start DESC
            LIMIT 8`,
          name,
        );
        const dailyRates = rows
          .map((r) => {
            const bytes = Number(r.bytes ?? 0);
            const elapsedDays = Number(r.elapsed_secs ?? 0) / 86400;
            return elapsedDays >= MIN_MEASURABLE_CHUNK_DAYS ? bytes / elapsedDays : 0;
          })
          .filter((v) => v > 0);
        return dailyRates.length > 0 ? { name, rate: median(dailyRates) } : null;
      } catch (err) {
        logger.debug({ err, table: name }, "measureDetailDailyBytes: chunk scan failed; using workload model");
        return null;
      }
    }),
  );
  const out: Record<string, number> = {};
  for (const m of measured) if (m) out[m.name] = m.rate;
  return out;
}

/**
 * Per-table chunk interval in days, for every managed hypertable. Feeds
 * `effectiveRetentionDays`: a table's chunk interval is the granularity at which
 * `drop_chunks` can reclaim anything, so it is also the slack between the
 * retention an operator set and the data actually kept on disk.
 *
 * A table absent from the result (a plain Postgres table, or a TimescaleDB whose
 * information views are unreadable) gets 0 slack, which is correct for the plain
 * case: row-level DELETE prunes at the exact cutoff.
 */
async function getChunkIntervalDays(): Promise<Record<string, number>> {
  if (!isTimescaleAvailable()) return {};
  try {
    const rows = await prisma.$queryRawUnsafe<{ name: string; days: number | null }[]>(
      `SELECT hypertable_name AS name,
              EXTRACT(epoch FROM time_interval) / 86400.0 AS days
         FROM timescaledb_information.dimensions
        WHERE hypertable_name = ANY($1::text[])
          AND time_interval IS NOT NULL`,
      [...ALL_HYPERTABLE_CANDIDATES],
    );
    const out: Record<string, number> = {};
    for (const r of rows) {
      const days = Number(r.days ?? 0);
      if (days > 0) out[r.name] = days;
    }
    return out;
  } catch (err) {
    logger.debug({ err }, "getChunkIntervalDays: dimension scan failed; projecting without chunk slack");
    return {};
  }
}

/**
 * How many days of data a tier actually keeps on disk, given the retention an
 * operator configured.
 *
 * `drop_chunks` can only drop a WHOLE chunk, and only once every row in it is
 * past the cutoff — so a chunk becomes droppable `retention` days after its
 * range ENDS, not after its rows were written. The retention prune then runs on
 * its own cadence (`RETENTION_PRUNE_INTERVAL_MS`, 24 h), so the drop lands up to
 * one cadence later again. Peak age of retained data is therefore
 * `retention + chunkInterval + pruneCadence`, and peak is the right figure for a
 * capacity forecast: it is the disk you must actually have.
 *
 * Modelling `retention` alone is what put the prod steady-state figure ~18 GB
 * BELOW the live database size (2026-09). The five largest sample tables sit on
 * TimescaleDB's default 7-day chunk interval against a 3–7 day retention window,
 * so they keep 1.5–3× the configured window: `asset_monitor_samples` held 12.58
 * days of data against a 7-day setting.
 *
 * Returns 0 for a tier that is off (0) or FOREVER (-1) — an unbounded tier has no
 * finite steady state and the caller treats it as unprojectable. Pure, for unit
 * testing.
 */
export function effectiveRetentionDays(opts: {
  retentionDays: number;
  /** 0 for a plain (non-hypertable) table — row-DELETE prunes at the exact cutoff. */
  chunkIntervalDays: number;
  pruneCadenceDays?: number;
}): number {
  const { retentionDays, chunkIntervalDays } = opts;
  if (retentionDays <= 0) return 0;
  const pruneCadenceDays = opts.pruneCadenceDays ?? RETENTION_PRUNE_INTERVAL_MS / 86_400_000;
  return retentionDays + Math.max(0, chunkIntervalDays) + Math.max(0, pruneCadenceDays);
}

/**
 * Bytes for a single DETAIL tier. Prefers the measured uncompressed daily rate
 * (× effective retention) when the tier genuinely never compresses (retention ≤
 * compress-after, or compression disabled) — that's the accurate on-disk
 * footprint. Otherwise (no measurement, or retention reaches past the frontier
 * so part of the data IS compressed and the uncompressed rate would
 * over-project) falls back to the supplied fallback estimate.
 *
 * Two DIFFERENT retention numbers are in play here, and conflating them is a
 * live trap:
 *   - `retentionDays` is the EFFECTIVE window (`effectiveRetentionDays()`) and is
 *     the MULTIPLIER — chunk-granularity slack is real footprint, and leaving it
 *     out is what made this projection read below the live database size (2026-09).
 *   - `configuredRetentionDays` is the operator's setting and is the GATE. Whether
 *     a chunk is ever compressed is decided by the compression policy and the
 *     retention policy racing on the SAME clock: both fire off the chunk's
 *     `range_end` plus their own window, so a tier with retention ≤ compress-after
 *     is dropped before compression ever reaches it and its chunks are pure
 *     uncompressed density. Chunk size shifts how long the data sits on disk but
 *     not which policy wins, so the gate must not see the slack. (Prod bears this
 *     out: the 7d-retention / 7d-compress detail tables report 0 compressed bytes.)
 *
 * `fallbackBytes` is the workload-model estimate for the tiered tables. The
 * standalone tables (log lines, widget and state probes) have no cadence row
 * model to build one from, so their caller passes the table's CURRENT on-disk
 * size: neutral in the projection — it cancels the same table's contribution to
 * `sampleBytesNow` — rather than a fabricated number or a silent zero. Pure for
 * unit testing.
 */
export function projectDetailBytes(opts: {
  measuredDailyBytes: number | null;
  /** Days of data actually kept on disk — the multiplier. */
  retentionDays: number;
  /** The operator's configured window — decides whether compression ever
   *  reaches this tier's chunks. Defaults to `retentionDays` for callers with no
   *  slack to distinguish. */
  configuredRetentionDays?: number;
  compressAfterDays: number;
  fallbackBytes: number;
}): number {
  const { measuredDailyBytes, retentionDays, compressAfterDays, fallbackBytes } = opts;
  const configuredRetentionDays = opts.configuredRetentionDays ?? retentionDays;
  if (
    measuredDailyBytes != null &&
    measuredDailyBytes > 0 &&
    (compressAfterDays <= 0 || configuredRetentionDays <= compressAfterDays)
  ) {
    return measuredDailyBytes * retentionDays;
  }
  return fallbackBytes;
}

export function projectSteadyStateSize(args: {
  currentDbBytes: number;
  sampleTables: CapacitySampleTable[];
  monitoredCount: number;
  /** Monitored assets that can actually produce telemetry (CPU/memory/temps).
   *  Excludes managed FortiSwitches/FortiAPs whose resolved polling is REST API. */
  telemetryEligibleCount: number;
  /** Monitored assets that can actually produce system-info (interfaces/storage/IPsec).
   *  Same exclusion as telemetryEligibleCount; WinRM/SSH are kept in. */
  systemInfoEligibleCount: number;
  monitor: MonitorSettings;
  retention: SampleRetention;
  /** Measured uncompressed daily bytes per DETAIL table (from settled chunks).
   *  When present for a never-compressing detail tier, used instead of the
   *  workload model. Omitted → pure workload model (existing behavior). */
  measuredDetailDailyBytes?: Record<string, number>;
  /** Effective compress-after window (days) per table; gates the measured-rate
   *  path (only trusted when retention ≤ this). */
  compressAfterByTable?: Record<string, number>;
  /** Chunk interval (days) per table, from `getChunkIntervalDays()`. Drives the
   *  drop_chunks granularity slack in `effectiveRetentionDays` — a table absent
   *  here is treated as a plain table pruned at the exact cutoff (0 slack). */
  chunkIntervalByTable?: Record<string, number>;
  /** Fleet-wide sum of `Asset.monitoredInterfaces` lengths. Drives the
   *  interface tables' row rate, which since the pinned-only cutover scales
   *  with pinned interfaces rather than with port count. Omitted → a
   *  conservative per-asset default. */
  pinnedInterfaceCount?: number;
}): number {
  const { currentDbBytes, sampleTables, monitoredCount, telemetryEligibleCount, systemInfoEligibleCount, monitor, retention, measuredDetailDailyBytes, compressAfterByTable, chunkIntervalByTable, pinnedInterfaceCount } = args;

  // Subtract current sample-table bytes so we don't double-count when adding
  // the projected sample-table bytes back in.
  const sampleBytesNow = sampleTables.reduce((sum, t) => sum + t.bytes, 0);
  const baseBytes = Math.max(0, currentDbBytes - sampleBytesNow);

  if (monitoredCount === 0) {
    return currentDbBytes;
  }

  // Cadence intervals drive the source-table row rate. Rollup tables ignore
  // these (they're tier-fixed at 24 buckets/day hourly, 1 daily) — except the
  // interface rollups, which scale with pinned count like their source.
  const intervals: WorkloadModelInputs = {
    sample:     monitor.intervalSeconds,
    telemetry:  monitor.telemetryIntervalSeconds,
    systemInfo: monitor.systemInfoIntervalSeconds,
    // Fleet average. Falls back to 2 (a typical "pin the uplinks" selection)
    // when the caller didn't supply a count — deliberately a small number, not
    // the old flat 20: since the pinned-only cutover an unpinned interface
    // produces no sample rows at all, so assuming a port-count-shaped figure
    // would over-project and raise false capacity warnings.
    pinnedIfacesPerAsset:
      pinnedInterfaceCount != null && systemInfoEligibleCount > 0
        ? pinnedInterfaceCount / systemInfoEligibleCount
        : 2,
  };

  let projectedSampleBytes = 0;
  for (const def of SAMPLE_TABLES) {
    const t = sampleTables.find((s) => s.name === def.name);
    if (!t) continue;

    const count =
      def.countKey === "telemetry"  ? telemetryEligibleCount  :
      def.countKey === "systemInfo" ? systemInfoEligibleCount :
      monitoredCount;
    // Per-entity retention, widened to what `drop_chunks` actually leaves on
    // disk. FOREVER (-1) has no finite steady state, so effectiveRetentionDays
    // returns 0 (an unbounded tier can't be projected); 0 = tier off = 0.
    // The configured number is kept alongside it: it is the compression gate,
    // while the widened one is the multiplier. See projectDetailBytes.
    const configuredRetentionDays = Math.max(0, retention[def.entity][def.tier]);
    const fullRetentionDays = effectiveRetentionDays({
      retentionDays: retention[def.entity][def.tier],
      chunkIntervalDays: chunkIntervalByTable?.[def.name] ?? 0,
    });

    // The standalone hypertables have no per-asset cadence row model. They are
    // measured-only: projected from their real daily byte-rate, and otherwise
    // left at their current size rather than guessed at.
    if (def.countKey === null) {
      projectedSampleBytes += projectDetailBytes({
        measuredDailyBytes: measuredDetailDailyBytes?.[def.name] ?? null,
        retentionDays: fullRetentionDays,
        configuredRetentionDays,
        compressAfterDays: compressAfterByTable?.[def.name] ?? 0,
        fallbackBytes: t.bytes,
      });
      continue;
    }

    const rowsPerAssetPerDay = DEFAULT_ROWS_PER_ASSET_PER_DAY[def.name](intervals);
    // Per-row size for the workload model: use the CALIBRATED default, never the
    // live-measured `t.avgBytesPerRow`. That value (relpages / pg_stat tuples) is
    // unreliable — relpages count bloated/empty pages + TimescaleDB-compressed
    // TOAST the tuple estimate can't see, and it swings as autovacuum/ANALYZE
    // churn under write load, routinely landing at 10–180 kB/row for ~400-byte
    // rows (phantom 14–218 TB steady-states, 2026-06). `t` is still required
    // (skip tables with no stats row yet); its measured bytes feed the table
    // breakdown display only.
    const bytesPerRow = DEFAULT_BYTES_PER_ROW[def.name] ?? 300;

    if (def.tier === "detail") {
      // DETAIL tier: prefer the MEASURED uncompressed daily byte-rate × full
      // retention when the tier never compresses (retention ≤ compress-after) —
      // that captures the true on-disk footprint (indexes + overhead + the real
      // pinned-interface/cadence/asset mix) the workload model can't see. The
      // workload model is the fallback, and for entities whose detail is still
      // dominated by UNSELECTED rows it keeps the conservative
      // UNSELECTED_DETAIL_HOURS (24h) cap (that bulk prunes at 24h; the pinned
      // subset is negligible beside it — only used on fresh installs with no
      // settled chunk yet).
      //
      // `interfaces` is deliberately NOT in that set any more: since the
      // pinned-only cutover it writes no unselected rows at all, so every row
      // in asset_interface_samples is pinned and keeps FULL retention.
      // Capping it at 24h would now UNDER-project by the whole retention
      // multiple (7× at the default), which is the dangerous direction for a
      // capacity forecast.
      //
      // The unselected cap gets the prune cadence but NOT the chunk slack: those
      // rows go out through a bounded row-DELETE at UNSELECTED_DETAIL_HOURS, not
      // through drop_chunks, so chunk granularity does not hold them.
      let fallbackRetentionDays = fullRetentionDays;
      if ((UNSELECTED_DOMINATED_ENTITIES as readonly string[]).includes(def.entity)) {
        const unselectedCapDays = effectiveRetentionDays({
          retentionDays: UNSELECTED_DETAIL_HOURS / 24,
          chunkIntervalDays: 0,
        });
        fallbackRetentionDays = Math.min(fullRetentionDays || unselectedCapDays, unselectedCapDays);
      }
      projectedSampleBytes += projectDetailBytes({
        measuredDailyBytes: measuredDetailDailyBytes?.[def.name] ?? null,
        retentionDays: fullRetentionDays,
        configuredRetentionDays,
        compressAfterDays: compressAfterByTable?.[def.name] ?? 0,
        fallbackBytes: count * rowsPerAssetPerDay * fallbackRetentionDays * bytesPerRow,
      });
    } else {
      // Rollup tiers (hourly/daily) are bucket-fixed (24/day, 1/day) and mostly
      // COMPRESSED at steady state, so the measured-uncompressed approach would
      // over-project — keep the stable workload model.
      projectedSampleBytes += count * rowsPerAssetPerDay * fullRetentionDays * bytesPerRow;
    }
  }

  return baseBytes + projectedSampleBytes;
}

function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + " GB";
  if (b >= 1024 ** 2) return Math.round(b / 1024 ** 2) + " MB";
  if (b >= 1024)      return Math.round(b / 1024) + " kB";
  return b + " B";
}

/** Friendly label for a volume — combines its roles into "app + state" etc. */
function volumeLabel(v: VolumeStat): string {
  if (v.roles.length === 1) {
    if (v.roles[0] === "db") return "Database volume";
    if (v.roles[0] === "app") return "Application volume";
    if (v.roles[0] === "state") return "State volume";
    if (v.roles[0] === "backups") return "Backups volume";
  }
  const has = (r: VolumeRole) => v.roles.includes(r);
  if (has("db") && has("app")) return "Application + DB volume";
  if (has("db")) return "DB volume";
  return "Application volume";
}

export interface AdvisorGapsForReasons {
  workersUndersized: boolean;
  poolUndersized: boolean;
  maxConnectionsUndersized: boolean;
  /** Brief text naming the worst worker gap, used inside the reason message. */
  worstGap?: string;
  /** The recommended max_connections value, surfaced in the reason text. */
  recommendedMaxConnections?: number;
  /** Cadences whose observed p90 has climbed toward the pg-boss handler timeout
   *  cap (`pgboss.queue.expire_seconds`). Non-empty fires the
   *  `monitor_handler_timeout_pressure` watch reason. */
  handlerTimeoutPressure?: import("./capacityAdvisorService.js").HandlerTimeoutPressure[];
}

// Stable family key for a volume. The collapse pass groups every disk reason
// targeting the same filesystem under one family so the higher-severity
// projection reasons absorb the volume-percentage thresholds. Different
// volumes (DB / app / state / backups) each get their own family — they're
// independently actionable.
function volumeFamilyKey(v: VolumeStat): string {
  if (v.roles.includes("db")) return "disk:db";
  if (v.roles.length > 0) return `disk:${[...v.roles].sort().join("+")}`;
  return `disk:${v.paths[0] ?? "unknown"}`;
}

// Dead-tuple ratio at which a sample table is considered bloated enough to
// warrant attention — shared by the amber `autovacuum_lag` rule and the
// critical `autovacuum_stale` rule (the latter additionally requires the
// table to have gone >7d without an autovacuum). Single source so the two
// rules stay in lockstep.
export const AUTOVACUUM_BLOAT_DEAD_TUP_RATIO = 0.2;

/**
 * Is a sample table genuinely suffering stale autovacuum — i.e. a real,
 * Critical-worthy problem rather than a quiet idle table?
 *
 * A table qualifies only when ALL of:
 *   - it is NOT a TimescaleDB hypertable (those are append-only/immutable
 *     once compressed and legitimately never autovacuum — exempted so they
 *     don't trip this red rule permanently),
 *   - it is populated (`rows > 1000`),
 *   - it is actually bloated (`deadTupRatio > AUTOVACUUM_BLOAT_DEAD_TUP_RATIO`),
 *     AND
 *   - it has a recorded autovacuum that ran more than 7 days ago.
 *
 * The dead-tuple gate is the fix for the false-positive this rule produced on
 * small / low-churn installs (few monitored assets, no TimescaleDB): a plain
 * rollup table with negligible dead tuples doesn't *need* a vacuum, so
 * PostgreSQL correctly declines to run one — that is not a problem and must
 * not surface as Critical. Bloat-present + stale-7d together are the real
 * "autovacuum is wedged and bloat is climbing unbounded" signal.
 */
export function isStaleVacuumTable(
  t: CapacitySampleTable,
  isHypertable: boolean,
  nowMs: number = Date.now(),
): boolean {
  if (isHypertable) return false;
  if (!t.lastAutovacuum || t.rows <= 1000) return false;
  if (t.deadTupRatio <= AUTOVACUUM_BLOAT_DEAD_TUP_RATIO) return false;
  return nowMs - new Date(t.lastAutovacuum).getTime() > 7 * 86400 * 1000;
}

// Message wording convention across all reasons:
//
//   `<Subject> <state> (<metric context>). <Action>.`
//
// Subject: noun phrase ("Database volume", "Host RAM", "Database steady-state size")
// State:   active-voice verb ("has 27% free", "exceeds 4× host RAM")
// Metric:  parenthetical with concrete numbers + units; absent if the state
//          line already carries them
// Action:  imperative one-sentence remediation, ending with a period

/**
 * Below this many monitored assets, fping's absence is not worth a warning.
 * 500 is where the fallback's per-host forking starts to be a measurable share
 * of a core rather than noise, and it is comfortably under the point where the
 * throughput floor begins widening the sweep cadence.
 */
const FPING_ADVISORY_ASSET_FLOOR = 500;

function computeReasons(
  snap: CapacitySnapshot,
  pgTuningNeeded: boolean,
  advisor?: AdvisorGapsForReasons,
  lifecycle?: CapacityReason[],
): CapacityReason[] {
  const reasons: CapacityReason[] = [];
  const ram = snap.appHost.totalMemoryBytes;

  // ── Per-volume disk thresholds ────────────────────────────────────────────
  // Walk every distinct filesystem Polaris/Postgres write to so a small
  // separate /var (the canonical RHEL trap) is caught even when the install
  // volume is comfortable. Volumes are pre-sorted lowest-free first.
  for (const v of snap.appHost.volumes) {
    if (v.totalBytes <= 0) continue;
    const pct = v.freeBytes / v.totalBytes;
    const pathHint = v.paths[0] ? `, ${v.paths[0]}` : "";
    const label = volumeLabel(v);
    const family = volumeFamilyKey(v);
    const metric = `${(pct * 100).toFixed(1)}% free — ${formatBytes(v.freeBytes)} of ${formatBytes(v.totalBytes)}${pathHint}`;

    if (pct < 0.10) {
      reasons.push({
        severity: "critical",
        code: "disk_critical",
        family,
        message: `${label} is critically full (${metric}).`,
        suggestion: v.roles.includes("db")
          ? "Free disk or expand the volume immediately — PostgreSQL refuses new writes when the volume is full."
          : "Free disk or expand the volume immediately — backups and update rollback both need headroom.",
      });
    } else if (pct < 0.20) {
      reasons.push({
        severity: "warning",
        code: "disk_low",
        family,
        message: `${label} is running low on space (${metric}).`,
        suggestion: "Plan to expand the volume soon — backups and update rollback both need headroom.",
      });
    } else if (pct < 0.30) {
      reasons.push({
        severity: "watch",
        code: "disk_watch",
        family,
        message: `${label} is getting tight (${metric}).`,
        suggestion: "Watch the trend; expand the volume before it crosses 20%.",
      });
    }
  }

  const dbVolume = snap.appHost.volumes.find((v) => v.roles.includes("db"));

  // Steady-state projection exceeds available disk on the DB volume. At current
  // settings the DB will fill the disk before reaching steady-state — the
  // per-volume disk-free thresholds above won't fire until it's already too late.
  // Compare *additional growth needed* (steady-state minus current size) against
  // free space — the bytes already on disk are part of the steady-state total
  // but they're not future growth, so they shouldn't be double-counted.
  const projectedGrowthBytes = Math.max(
    0,
    snap.workload.steadyStateSizeBytes - snap.database.sizeBytes,
  );
  if (dbVolume && projectedGrowthBytes > dbVolume.freeBytes) {
    reasons.push({
      severity: "critical",
      code: "projected_exceeds_disk",
      family: "disk:db",
      message: `Database growth will overflow the DB volume before reaching steady-state (need ${formatBytes(projectedGrowthBytes)} more, only ${formatBytes(dbVolume.freeBytes)} free; steady-state target ${formatBytes(snap.workload.steadyStateSizeBytes)}).`,
      suggestion: "Narrow the monitored-interface selection (each integration's Monitoring tab), reduce sample retention or monitored asset count, or expand the database volume. Pinned interfaces are usually the largest single driver — only they keep a time-series, so a broad auto-monitor pattern across many-port switches dominates the projection. The Capacity Advisor card surfaces the retention and cadence levers if you can't expand the volume.",
    });
  } else if (dbVolume && projectedGrowthBytes > dbVolume.freeBytes * 0.75) {
    reasons.push({
      severity: "warning",
      code: "projected_approaches_disk",
      family: "disk:db",
      message: `Database growth will consume more than 75% of the DB volume's free space before reaching steady-state (need ${formatBytes(projectedGrowthBytes)} more, only ${formatBytes(dbVolume.freeBytes)} free; steady-state target ${formatBytes(snap.workload.steadyStateSizeBytes)}).`,
      suggestion: "Narrow the monitored-interface selection (each integration's Monitoring tab) or reduce sample retention, or expand the database volume before it fills. Pinned interfaces are usually the largest single driver — only they keep a time-series. The Capacity Advisor card surfaces the retention and cadence levers if you can't expand the volume.",
    });
  }

  // Stale autovacuum on a populated, BLOATED sample table — bloat will keep
  // growing. Collapsed into a single reason listing every affected table so an
  // install with several bloated sample tables doesn't render the same advice
  // 3-5 times stacked vertically. The qualifying conditions (hypertable
  // exemption + populated + bloated + >7d stale) live in `isStaleVacuumTable`;
  // the dead-tuple gate is what keeps a low-churn non-Timescale install from
  // tripping this red rule on a rollup table that simply has nothing worth
  // vacuuming.
  const tsHypertables = new Set(snap.database.timescale?.hypertableTables ?? []);
  const staleTables = snap.database.sampleTables.filter((t) =>
    isStaleVacuumTable(t, tsHypertables.has(t.name)),
  );
  if (staleTables.length > 0) {
    const names = staleTables.map((t) => t.name).join(", ");
    reasons.push({
      severity: "critical",
      code: "autovacuum_stale",
      family: "autovacuum",
      message: staleTables.length === 1
        ? `PostgreSQL autovacuum hasn't run on ${names} in over 7 days.`
        : `PostgreSQL autovacuum hasn't run on ${staleTables.length} sample tables in over 7 days (${names}).`,
      suggestion: `Run VACUUM manually on the affected tables and lower autovacuum_vacuum_scale_factor to 0.05 for each.`,
    });
  }

  // Steady-state DB size > 8× host RAM — query performance will collapse.
  if (snap.workload.steadyStateSizeBytes > ram * 8) {
    reasons.push({
      severity: "critical",
      code: "projected_db_huge",
      family: "db_ram",
      message: `Database steady-state size is more than 8× host RAM (steady-state ${formatBytes(snap.workload.steadyStateSizeBytes)}, host RAM ${formatBytes(ram)}).`,
      suggestion: "Add RAM, narrow the monitored-interface selection (each integration's Monitoring tab), or reduce sample retention — query performance will collapse without it. Pinned interfaces are usually the largest single driver of sample volume, since only they keep a time-series. The Capacity Advisor card surfaces the retention and cadence levers if you can't add RAM.",
    });
  }

  // ── Warning: autovacuum lag ──────────────────────────────────────────────
  // Collapsed into a single reason listing every affected table with its
  // dead-tuple percentage — multiple bloated sample tables would otherwise
  // each push their own near-identical warning row.
  const laggingTables = snap.database.sampleTables.filter(
    (t) => t.rows > 1000 && t.deadTupRatio > AUTOVACUUM_BLOAT_DEAD_TUP_RATIO,
  );
  if (laggingTables.length > 0) {
    const list = laggingTables
      .map((t) => `${t.name} ${(t.deadTupRatio * 100).toFixed(0)}%`)
      .join(", ");
    reasons.push({
      severity: "warning",
      code: "autovacuum_lag",
      family: "autovacuum",
      message: laggingTables.length === 1
        ? `PostgreSQL autovacuum is falling behind on ${list} dead tuples.`
        : `PostgreSQL autovacuum is falling behind on ${laggingTables.length} sample tables (${list}).`,
      suggestion: `Lower autovacuum_vacuum_scale_factor to 0.05 for the affected tables.`,
    });
  }

  if (snap.workload.steadyStateSizeBytes > ram * 4 && snap.workload.steadyStateSizeBytes <= ram * 8) {
    reasons.push({
      severity: "warning",
      code: "projected_db_large",
      family: "db_ram",
      message: `Database steady-state size exceeds 4× host RAM (steady-state ${formatBytes(snap.workload.steadyStateSizeBytes)}, host RAM ${formatBytes(ram)}).`,
      suggestion: "Add RAM, narrow the monitored-interface selection (each integration's Monitoring tab), or reduce sample retention before performance degrades. Pinned interfaces are usually the largest single driver of sample volume, since only they keep a time-series. The Capacity Advisor card surfaces the retention and cadence levers if you can't add RAM.",
    });
  }

  // ── pg-boss state ────────────────────────────────────────────────────────
  // The legacy pgboss_recommended / pgboss_overdue / pgboss_pending reasons
  // were folded into the Capacity Advisor card, which surfaces queue mode as
  // one of its levers alongside pool sizes and worker counts. See
  // capacityAdvisorService.ts and the QUEUE_MODE recommendation.

  // ── Watch: TimescaleDB recommendation ────────────────────────────────────
  // Once the sample tables together cross ~1 GB and the extension isn't
  // installed, advise the operator. Below the threshold it's not worth
  // bothering them — plain Postgres prune handles small sample tables fine.
  // Above it, partition-drop prune and compression are step-change wins
  // (10-30× storage reduction, instant chunk drops vs. seq-scan deleteMany).
  // The suggestion adapts to deployment context so the install hint matches
  // the operator's actual environment.
  const TIMESCALE_RECOMMEND_BYTES = 1024 * 1024 * 1024; // 1 GB
  const sampleTableBytes = snap.database.sampleTables.reduce((sum, t) => sum + t.bytes, 0);
  if (!snap.database.timescale.extensionInstalled && sampleTableBytes > TIMESCALE_RECOMMEND_BYTES) {
    const ctx = getDeploymentContext();
    const suggestion = !ctx.dbIsLocal
      ? "Ask your database administrator to install the timescaledb extension on the polaris database. Some managed services (RDS for Postgres) don't support it; Timescale Cloud and Azure Postgres Flexible Server do."
      : ctx.runtimeIsContainer
        ? "Switch your Postgres container to the timescale/timescaledb:latest-pg15 image. Existing data is preserved on the volume."
        : "Install TimescaleDB on this server. See docs/INSTALL.md → Recommended: TimescaleDB.";
    reasons.push({
      severity: "watch",
      code: "timescale_recommended",
      family: "timescale",
      message: `Sample tables are ${formatBytes(sampleTableBytes)} without TimescaleDB compression (~10× shrink available).`,
      suggestion,
    });
  }

  // ── Watch: sample rollup job lagging ────────────────────────────────────
  // The rollup writer (hourly every 30 min, daily at 02:30 UTC) stamps a
  // Setting on success. If either tier's lastSuccess is stale beyond a
  // reasonable window we fire one rolled-up reason naming the laggard. The
  // user-visible symptom of a stuck rollup is that long-range chart
  // queries that should hit the rollup tier either return empty (no
  // aggregates yet) or fall through to scanning the detail table and slow
  // way down — operators see "the 30-day chart got slow" without
  // realizing the upstream tick is wedged.
  const HOURLY_STALE_MS = 6 * 60 * 60 * 1000;       // 6 hours
  const DAILY_STALE_MS  = 36 * 60 * 60 * 1000;      // 36 hours
  const nowMs = Date.now();
  const hourlyAt = snap.database.rollupLastSuccess.hourly
    ? new Date(snap.database.rollupLastSuccess.hourly).getTime()
    : null;
  const dailyAt = snap.database.rollupLastSuccess.daily
    ? new Date(snap.database.rollupLastSuccess.daily).getTime()
    : null;
  // Only fire on installs where sample rows actually exist — a fresh
  // install with no monitored assets has no aggregates to produce, so a
  // missing lastSuccess is expected, not a problem.
  const anySampleRows = snap.database.sampleTables.some((t) => t.rows > 0);
  if (anySampleRows) {
    const hourlyStale = hourlyAt == null || (nowMs - hourlyAt) > HOURLY_STALE_MS;
    const dailyStale  = dailyAt  == null || (nowMs - dailyAt)  > DAILY_STALE_MS;
    if (hourlyStale || dailyStale) {
      const parts: string[] = [];
      if (hourlyStale) {
        parts.push(hourlyAt == null
          ? "hourly tier has never produced a successful run"
          : `last hourly run ${Math.round((nowMs - hourlyAt) / 3600_000)}h ago`);
      }
      if (dailyStale) {
        parts.push(dailyAt == null
          ? "daily tier has never produced a successful run"
          : `last daily run ${Math.round((nowMs - dailyAt) / 3600_000)}h ago`);
      }
      reasons.push({
        severity: "watch",
        code: "sample_rollup_lagging",
        family: "sample_rollup",
        message: `Sample rollup job is lagging — ${parts.join("; ")}.`,
        suggestion:
          "Check journalctl for `sampleRollup.hourly` / `sampleRollup.daily` errors and " +
          "for the `polaris_job_total{job=\"sampleRollup.*\",outcome=\"failure\"}` counter. " +
          "Long-range chart queries depend on these aggregates; without them they fall " +
          "back to scanning the detail table at every load.",
      });
    }
  }

  // ── Watch: pool / workers / max_connections undersized (rollup from advisor) ─
  // The legacy `db_pool_undersized` reason was absorbed into the Capacity
  // Advisor's DATABASE_POOL_SIZE recommendation — the advisor factors
  // peakObserved into the prisma pool target directly, so when the pool is
  // genuinely undersized the advisor's row flips to "Stage" and the
  // poolUndersized flag (passed in via `advisor`) carries the signal.
  const pool = snap.database.connectionPool;

  // ── Watch: connection pool undersized (rollup from advisor) ────────────
  // Replaces the legacy `db_pool_undersized` reason which fired on peak
  // utilization heuristics. The advisor's DATABASE_POOL_SIZE recommendation
  // now factors peakObserved directly into the prisma pool target, so when
  // pool is undersized the advisor card carries the exact recommended value
  // and this reason just flags it for the Maintenance pill.
  if (advisor?.poolUndersized) {
    reasons.push({
      severity: "watch",
      code: "pool_undersized",
      family: "db_pool",
      message: `Database connection pool is below current peak demand (peak ${pool.peakObserved} of ${pool.prismaPoolSize + (pool.pgbossPoolSize ?? 0)} Polaris capacity).`,
      suggestion:
        `Open the Capacity Advisor card and click Stage to write the recommended pool sizes ` +
        `to .env. Bumping the pool is a low-risk fix when Postgres has headroom. If ` +
        `pg_stat_activity shows many rows stuck in idle in transaction, fix the holders instead.`,
    });
  }

  // ── Watch: monitor workers undersized (rollup from advisor) ─────────────
  // Single rollup reason — one entry per cadence would clutter the panel.
  // The advisor card carries the per-cadence recommendations.
  if (advisor?.workersUndersized) {
    const gapText = advisor.worstGap ? ` (worst gap: ${advisor.worstGap})` : "";
    reasons.push({
      severity: "watch",
      code: "monitor_workers_undersized",
      family: "monitor_workers",
      message: `Monitor worker pool is below current workload${gapText}.`,
      suggestion:
        `Open the Capacity Advisor card and click Stage to write the recommended worker ` +
        `counts to .env. Takes effect on next Polaris restart.`,
    });
  }

  // ── Watch: monitor handler timeout pressure (per-cadence) ───────────────
  // Observed p90 has climbed toward the pg-boss handler kill cap
  // (`pgboss.queue.expire_seconds`). Fires BEFORE actual kills so the
  // operator can react before the histogram-based p90 the advisor reads
  // starts getting truncated by killed jobs.
  if (advisor?.handlerTimeoutPressure && advisor.handlerTimeoutPressure.length > 0) {
    const parts = advisor.handlerTimeoutPressure
      .map((p) => `${p.cadence} p90=${p.p90Sec.toFixed(1)}s vs cap ${p.expireSec}s (${Math.round(p.utilization * 100)}%)`)
      .join("; ");
    reasons.push({
      severity: "watch",
      code: "monitor_handler_timeout_pressure",
      family: "monitor_handlers",
      message: `Monitor handler runtime is brushing the pg-boss timeout cap on one or more cadences (${parts}).`,
      suggestion:
        `Either raise EXPIRE_BY_QUEUE for the affected cadence in src/services/queueService.ts ` +
        `(reapplies on restart via updateQueue), trim the per-asset payload ` +
        `(fewer Asset.monitoredInterfaces / monitoredStorage / monitoredIpsecTunnels), ` +
        `or lengthen the cadence so jobs complete before re-queueing.`,
    });
  }

  // ── Amber: max_connections undersized ───────────────────────────────────
  // Fires when current max_connections is below what the advisor would
  // recommend. Requires a PostgreSQL restart, so it stays advisory and
  // doesn't get a Stage button.
  if (advisor?.maxConnectionsUndersized && advisor.recommendedMaxConnections && pool.maxConnections > 0) {
    reasons.push({
      severity: "warning",
      code: "max_connections_undersized",
      family: "db_max_connections",
      message:
        `PostgreSQL max_connections is below the recommended value for current workload ` +
        `(current ${pool.maxConnections}, recommended ${advisor.recommendedMaxConnections}).`,
      suggestion:
        `Set max_connections=${advisor.recommendedMaxConnections} in postgresql.conf and ` +
        `restart PostgreSQL. Polaris can't change this from the UI because it requires a Postgres restart.`,
    });
  }

  // ── Watch: unauthenticated /metrics or /health endpoint ────────────────
  // Both endpoints are open by default and gated by their respective bearer
  // tokens when set. The setup wizard auto-generates both tokens at install
  // time; this fires when an operator has cleared one (or upgraded from a
  // pre-auto-token install). /metrics is the higher-impact leak — fleet
  // size, monitor health by status, queue depth, transport-level RTT
  // histograms — so it gets its own reason; /health is recon-only ("the
  // app is up") but symmetric and trivial to gate, so we surface it too.
  // Watch-severity: Maintenance-tab warning + audit Event, no navbar
  // banner. Operators who deliberately want either endpoint open (some
  // L4 health probes can't carry a header) can ignore the warning.
  if (!process.env.METRICS_TOKEN || process.env.METRICS_TOKEN.trim() === "") {
    reasons.push({
      severity: "watch",
      code: "metrics_token_unset",
      family: "metrics_token",
      message:
        "/metrics is reachable without authentication (leaks fleet size, monitored asset " +
        "health, monitor pass duration, and queue depth — useful recon if Polaris is " +
        "publicly reachable).",
      suggestion:
        "Click Generate token to write METRICS_TOKEN into .env (the gate takes effect " +
        "immediately — no restart). Then update your Prometheus scrape config to send " +
        "`Authorization: Bearer <token>` — see docs/grafana/README.md.",
    });
  }
  if (!process.env.HEALTH_TOKEN || process.env.HEALTH_TOKEN.trim() === "") {
    reasons.push({
      severity: "watch",
      code: "health_token_unset",
      family: "health_token",
      message:
        "/health is reachable without authentication (leaks only 'the app is up' but the " +
        "gate is trivial to enable).",
      suggestion:
        "Click Generate token to write HEALTH_TOKEN into .env (the gate takes effect " +
        "immediately — no restart). Then configure your monitoring system to send " +
        "`Authorization: Bearer <token>`.",
    });
  }

  // Secrets-at-rest. Without POLARIS_SECRET_KEY the Prisma extension's sealing
  // is a no-op, so device and integration secrets sit in the clear in Postgres
  // and therefore in the clear in every pg_dump. Watch-severity rather than
  // amber: it is the pre-2026-08 behaviour, so it must not paint an upgraded
  // install red, but it should not stay invisible either.
  if (!process.env.POLARIS_SECRET_KEY || process.env.POLARIS_SECRET_KEY.trim() === "") {
    reasons.push({
      severity: "watch",
      code: "secrets_key_unset",
      family: "secrets_key",
      message:
        "POLARIS_SECRET_KEY is not set, so SNMP communities, WinRM/SSH passwords and keys, " +
        "FortiManager/FortiGate API tokens, the Entra client secret, vCenter credentials and " +
        "delivery-channel secrets are stored as plaintext in the database — and therefore in " +
        "plaintext in every database backup.",
      suggestion:
        "Add a 32-byte key to .env as POLARIS_SECRET_KEY (`openssl rand -hex 32`) and restart. " +
        "Existing secrets are encrypted automatically on the next boot. Keep a copy of the key " +
        "somewhere other than this host: sealed secrets cannot be recovered without it, and a " +
        "backup restored onto a host with a different key needs them re-entered.",
    });
  }

  // fping absent. Not a fault and never amber: the per-host fallback produces
  // IDENTICAL loss figures and identical up/down verdicts, and the status probe
  // sends exactly one echo per asset per cycle either way. What changes is
  // process count — one spawn per monitored asset per sweep instead of one per
  // 500 — so this is only worth saying when the fleet is big enough for that to
  // matter. Below the threshold an operator would just be reading a warning
  // about nothing.
  //
  // Watch-severity deliberately: an operator whose estate cannot publish EPEL
  // (fping is not in RHEL BaseOS/AppStream) has no action available, and a
  // banner they cannot clear is worse than a line they can read and accept.
  const sweepAssets = snap.workload.monitoredAssetCount;
  if (!snap.appHost.hasFping && sweepAssets >= FPING_ADVISORY_ASSET_FLOOR) {
    const cadence = resolveSweepIntervalSec(configuredSweepIntervalSec(), sweepAssets, false);
    reasons.push({
      severity: "watch",
      code: "fping_absent",
      family: "fping",
      message:
        `fping is not installed, so both ICMP cadences fork one process per host: ` +
        `about ${sweepAssets} processes per packet-loss sweep across ${sweepAssets} ` +
        `monitored assets, plus one per ICMP-polled asset per response-time poll. ` +
        `Loss figures and up/down verdicts are unaffected — this is process cost, ` +
        `not correctness. The sweep is running on a ${cadence}s cadence.`,
      suggestion:
        "Install fping to batch both (one process per 500 targets): on RHEL it lives in " +
        "EPEL (`dnf install -y epel-release fping`), on Debian/Ubuntu the standard archive " +
        "(`apt install -y fping`), then restart Polaris — the probe is cached per process. " +
        "If your estate cannot publish EPEL, raise POLARIS_LOSS_SWEEP_INTERVAL_SEC instead: " +
        "300 cuts the sweep's process count fivefold and leaves the reading itself unchanged.",
    });
  }

  // ── Disk-read pressure (replaces the old size-based ram_insufficient) ─────
  // Only meaningful once the DB can't fully fit in RAM — below that, disk
  // pressure can't come from the working set spilling out of cache. We never
  // tell the operator a specific GB target (the old "recommended N GB" number
  // is gone); the signal is qualitative and medium-aware.
  const io = snap.database.io;
  const dbExceedsRam = snap.database.sizeBytes > ram;
  if (dbExceedsRam && !io.trackIoTiming) {
    // Can't measure without track_io_timing — nudge the operator to enable it
    // rather than guessing. Own family so a growth warning doesn't collapse
    // away the "turn on measurement" hint.
    reasons.push({
      severity: "watch",
      code: "track_io_timing_off",
      family: "pg_io_timing",
      message: `Can't measure disk-read pressure: PostgreSQL track_io_timing is off, and the database (${formatBytes(snap.database.sizeBytes)}) is larger than host RAM (${formatBytes(ram)}).`,
      suggestion: "Enable track_io_timing = on (RELOAD, no restart; negligible overhead on modern hardware — verify with pg_test_timing) so Polaris can tell whether reads are actually hitting disk.",
    });
  } else if (dbExceedsRam && io.measured && io.avgBackendsBlockedOnDisk !== null && io.avgBackendsBlockedOnDisk >= DB_IO_WATCH_BACKENDS) {
    // Real, sustained disk-read wait. Shares the db_ram family with
    // projected_db_large / projected_db_huge so a higher-severity DB-vs-RAM
    // finding absorbs it in the collapse pass.
    const avg = io.avgBackendsBlockedOnDisk;
    const mins = io.windowSeconds ? Math.round(io.windowSeconds / 60) : null;
    const windowText = mins && mins >= 1 ? ` over the last ${mins} min` : "";
    reasons.push({
      severity: avg >= DB_IO_WARNING_BACKENDS ? "warning" : "watch",
      code: "db_io_pressure",
      family: "db_ram",
      message: `Disk I/O is high — PostgreSQL is spending significant time reading from storage rather than serving from cache (avg ${avg.toFixed(1)} connection(s) blocked on disk${windowText}; host RAM ${formatBytes(ram)}, database ${formatBytes(snap.database.sizeBytes)}).`,
      suggestion: "Consider adding RAM so more of the working set stays cached. Narrowing the monitored-interface selection (each integration's Monitoring tab) is often the biggest lever — only pinned interfaces keep a time-series, so fewer pins means fewer rows written AND a smaller working set competing for cache. Faster storage (NVMe) or lower sample retention also reduce disk reads; the Capacity Advisor card surfaces the retention and cadence levers.",
    });
  }
  if (pgTuningNeeded) {
    reasons.push({
      severity: "warning",
      code: "pg_tuning_needed",
      family: "pg_tuning",
      message: `One or more PostgreSQL settings are below the recommended minimum for current workload.`,
      suggestion: "See the PostgreSQL Tuning section below for the specific settings to adjust.",
    });
  }

  // Platform end-of-life. All share one family, so the collapse pass yields a
  // single row here and the per-component breakdown lives on the Platform
  // Lifecycle card. `watch`-severity lifecycle rows never reach this list at
  // all — see lifecycleCapacityReasons.
  for (const r of lifecycle ?? []) reasons.push(r);

  return collapseReasonsByFamily(reasons);
}

// Severity rank used by the collapse pass and the headline picker. Numeric so
// `Math.max` works cleanly on a mixed list.
const SEVERITY_RANK: Record<Severity, number> = {
  ok: 0,
  watch: 1,
  warning: 2,
  critical: 3,
};

/**
 * Group reasons by `family` and keep only the highest-severity entry per
 * family. Reasons without a `family` pass through unchanged (they're
 * standalone concerns with no overlapping siblings).
 *
 * When a higher-severity reason absorbs lower-severity reasons in the same
 * family, the suppressed reasons' suggestions are concatenated onto the
 * winner's suggestion (deduplicated by trimmed equality) so the operator
 * doesn't lose the original remediation hints. Messages are NOT merged —
 * the winner's message is the active framing of the family's problem.
 *
 * Stable order: preserves the input order of winners. Each family's winner
 * stays where its highest-severity representative appeared in the input.
 */
export function collapseReasonsByFamily(reasons: CapacityReason[]): CapacityReason[] {
  // First pass: bucket by family, track the winning index within each bucket.
  const buckets = new Map<string, CapacityReason[]>();
  const order: Array<{ family: string | null; reason: CapacityReason }> = [];
  for (const r of reasons) {
    if (!r.family) {
      order.push({ family: null, reason: r });
      continue;
    }
    if (!buckets.has(r.family)) {
      buckets.set(r.family, []);
      order.push({ family: r.family, reason: r });
    }
    buckets.get(r.family)!.push(r);
  }
  // Second pass: for each family, pick the highest-severity entry and merge
  // suggestions from the suppressed ones into it.
  const winners = new Map<string, CapacityReason>();
  for (const [family, bucket] of buckets) {
    const sorted = [...bucket].sort(
      (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
    );
    const winner = sorted[0]!;
    const losers = sorted.slice(1);
    if (losers.length === 0) {
      winners.set(family, winner);
      continue;
    }
    // Deduplicate suggestions by exact trimmed text so we don't append the
    // winner's own suggestion if a loser happened to use the same words.
    const seen = new Set<string>([winner.suggestion.trim()]);
    const extra: string[] = [];
    for (const l of losers) {
      const t = l.suggestion.trim();
      if (!seen.has(t)) {
        seen.add(t);
        extra.push(`Also: ${t}`);
      }
    }
    winners.set(family, {
      ...winner,
      suggestion: extra.length > 0 ? `${winner.suggestion} ${extra.join(" ")}` : winner.suggestion,
    });
  }
  // Third pass: emit in the recorded order, substituting bucket winners.
  return order.map((entry) =>
    entry.family ? winners.get(entry.family) ?? entry.reason : entry.reason,
  );
}

function deriveSeverity(reasons: CapacityReason[]): Severity {
  if (reasons.some((r) => r.severity === "critical")) return "critical";
  if (reasons.some((r) => r.severity === "warning")) return "warning";
  if (reasons.some((r) => r.severity === "watch")) return "watch";
  return "ok";
}

/**
 * Build the snapshot. Pure: reads system state but does not write any
 * Settings or Events. Use `recordCapacityTransition` if you want to fire
 * the audit-log Event on severity changes.
 */
export async function getCapacitySnapshot(opts: {
  pgTuningNeeded: boolean;
  /** Optional advisor-driven gap data. When provided, populates the
   *  `monitor_workers_undersized` / `max_connections_undersized` reasons.
   *  Omitted by callers that don't yet have an advisor state (e.g. the
   *  first half of the two-pass orchestration in getCapacitySnapshotWithAdvisor). */
  advisor?: AdvisorGapsForReasons;
}): Promise<CapacitySnapshot> {
  const dataDirectory = await resolveDbDataDirectory();

  // An asset is telemetry/systemInfo-eligible when it is NOT a managed
  // FortiSwitch/FortiAP whose resolved polling method is REST API. The full
  // four-tier hierarchy resolver isn't practical for an aggregate count, so we
  // approximate: exclude assets where assetType is switch/access_point AND
  // the per-asset polling column is null (= inherits REST API from the FMG/FG
  // integration source default) or explicitly set to rest_api. Switches/APs
  // with an explicit snmp override are correctly kept in.
  // Count helper: assets that will actually produce telemetry/systemInfo rows.
  // Managed FortiSwitches/APs on REST API never do (the endpoints live on the
  // parent FortiGate, not the device's IP), so the full monitored count would
  // inflate those table projections. We approximate by excluding assets where
  // assetType is switch/access_point AND the per-asset polling column is null
  // (= inherits REST API from the integration source default) or explicitly
  // set to rest_api. Assets with an explicit snmp override are kept in.
  const telemetryEligibleSQL = `
    SELECT COUNT(*)::bigint AS count FROM "assets"
    WHERE monitored = true
      AND NOT (
        "assetType" IN ('switch', 'access_point')
        AND ("cpuMemoryPolling" IS NULL OR "cpuMemoryPolling" = 'rest_api')
      )`;
  const systemInfoEligibleSQL = `
    SELECT COUNT(*)::bigint AS count FROM "assets"
    WHERE monitored = true
      AND NOT (
        "assetType" IN ('switch', 'access_point')
        AND ("interfacesPolling" IS NULL OR "interfacesPolling" = 'rest_api')
      )`;

  const [
    monitor,
    sampleRetention,
    monitoredCount,
    telemetryEligibleRow,
    systemInfoEligibleRow,
    monitoredPinRow,
    volumes,
    dbSizeRow,
    sampleTables,
    connRow,
    dbIoState,
  ] = await Promise.all([
    getMonitorSettings(),
    getSampleRetention(),
    prisma.asset.count({ where: { monitored: true } }),
    prisma.$queryRawUnsafe<{ count: bigint }[]>(telemetryEligibleSQL),
    prisma.$queryRawUnsafe<{ count: bigint }[]>(systemInfoEligibleSQL),
    // One pass over monitored assets summing all three fast-cadence pin arrays.
    // IPsec tunnels are folded into the interface count (they are interfaces
    // from the operator's perspective); storage mounts are reported separately.
    prisma.$queryRawUnsafe<{ interfaces: bigint; ipsec: bigint; storage: bigint }[]>(
      `SELECT COALESCE(SUM(COALESCE(array_length("monitoredInterfaces", 1), 0)), 0)::bigint     AS interfaces,
              COALESCE(SUM(COALESCE(array_length("monitoredIpsecTunnels", 1), 0)), 0)::bigint   AS ipsec,
              COALESCE(SUM(COALESCE(array_length("monitoredStorage", 1), 0)), 0)::bigint         AS storage
         FROM "assets"
        WHERE monitored = true`,
    ),
    getVolumes(dataDirectory),
    prisma.$queryRawUnsafe<{ size: bigint }[]>(
      // Catalog-only size sum. pg_database_size() stat()'s every relfilenode in
      // the data directory; with TimescaleDB hypertable chunks (asset_monitor_samples
      // + the 5 *_hourly / *_daily rollups, each potentially with hundreds of
      // chunks) that becomes thousands of fs syscalls and dominates the
      // capacity-advisor wall-clock. Reading relpages from pg_class is an
      // in-memory catalog lookup; values are accurate as of the last ANALYZE
      // (minute-scale lag is acceptable for the capacity advisor's RAM-target
      // recommendation).
      `SELECT (current_setting('block_size')::bigint * SUM(relpages::bigint))::bigint AS size
         FROM pg_class WHERE relkind IN ('r', 'i', 't', 'm')`,
    ),
    getSampleTableStats(),
    readPgStatActivity(),
    computeDbIoState(),
  ]);
  // Pull the rollup-job lastSuccess markers separately so the failure mode of
  // a missing Setting row stays simple to reason about (parallel fetch on the
  // Promise.all above would force us to handle settled-rejected for one row
  // among many). These reads are cheap and unindexed-PK-fast.
  const [rollupHourlyRow, rollupDailyRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "sampleRollup.hourly.lastSuccess" } }),
    prisma.setting.findUnique({ where: { key: "sampleRollup.daily.lastSuccess" } }),
  ]);
  const rollupLastSuccess = {
    hourly: ((rollupHourlyRow?.value as Record<string, unknown> | null)?.at as string | null) ?? null,
    daily:  ((rollupDailyRow ?.value as Record<string, unknown> | null)?.at as string | null) ?? null,
  };
  const telemetryEligibleCount  = Number(telemetryEligibleRow[0]?.count  ?? monitoredCount);
  const systemInfoEligibleCount = Number(systemInfoEligibleRow[0]?.count ?? monitoredCount);

  const monitoredInterfaceCount =
    Number(monitoredPinRow[0]?.interfaces ?? 0) + Number(monitoredPinRow[0]?.ipsec ?? 0);
  const monitoredStorageCount = Number(monitoredPinRow[0]?.storage ?? 0);
  const dbSizeBytes = Number(dbSizeRow[0]?.size ?? 0);

  // Connection-pool snapshot. Update the rolling peak before reading it back
  // so the snapshot reflects the new high-water mark when this call is the
  // one that observed it.
  const currentInUse = Number(connRow.in_use ?? 0);
  const maxConnections = Number(connRow.max ?? 0);
  if (currentInUse > peakConnectionCount) peakConnectionCount = currentInUse;
  const bootMode = getBootTimeMode();
  const prismaPoolSize = readEnvInt("DATABASE_POOL_SIZE", 25);
  // Default must match queueService.ts:resolveEnvInt("POLARIS_PGBOSS_POOL_SIZE", 20) — that's
  // the value pg-boss is actually instantiated with when the env var is unset, so we report
  // it consistently in the snapshot. A mismatch here made the Database card's "Polaris pool
  // size" line disagree with the Capacity Advisor's "POLARIS_PGBOSS_POOL_SIZE" row.
  const pgbossPoolSize = bootMode === "pgboss" ? readEnvInt("POLARIS_PGBOSS_POOL_SIZE", 20) : null;

  const cadences = {
    responseTimeSec: monitor.intervalSeconds,
    telemetrySec:    monitor.telemetryIntervalSeconds,
    systemInfoSec:   monitor.systemInfoIntervalSeconds,
  };
  // Summarize the new tiered retention as the legacy single-number shape
  // the snapshot consumers still expect. Use the default-class detail tier
  // since that's the operator-facing "this is the recent-data window" value.
  // The full per-tier per-class shape is available via the global
  // Setting("sampleRetention") fetched by the Maintenance card directly.
  const retention = {
    monitorDays:    sampleRetention.assets.detail,
    telemetryDays:  sampleRetention.cpuMem.detail,
    systemInfoDays: sampleRetention.interfaces.detail,
  };

  // Measure the real daily footprint of each detail hypertable (settled,
  // uncompressed chunks) so the projection reflects actual on-disk size —
  // indexes, overhead, and the true pinned-interface/cadence mix — instead of
  // the hardcoded workload multipliers. Per-table compress-after gates which
  // detail tiers can trust the measurement (only those that never compress).
  const [measuredDetailDailyBytes, chunkIntervalByTable] = await Promise.all([
    measureDetailDailyBytes(),
    getChunkIntervalDays(),
  ]);
  const compressAfterByTable: Record<string, number> = {};
  for (const def of SAMPLE_TABLES) {
    if (def.tier === "detail") compressAfterByTable[def.name] = getEffectiveCompressAfterDays(def.name);
  }

  const steadyStateSizeBytes = projectSteadyStateSize({
    currentDbBytes: dbSizeBytes,
    sampleTables,
    monitoredCount,
    telemetryEligibleCount,
    systemInfoEligibleCount,
    monitor,
    retention: sampleRetention,
    measuredDetailDailyBytes,
    compressAfterByTable,
    chunkIntervalByTable,
    // Since the pinned-only cutover the interface tables' row rate scales with
    // what operators pinned, not with port count.
    pinnedInterfaceCount: monitoredInterfaceCount,
  });

  // One cached spawn; the web role never runs a sweep so its own probe is cold
  // until something asks. Asking here is what makes the fallback VISIBLE on the
  // Maintenance tab instead of only in a monitor-role log line.
  const hasFping = await detectFping();

  const snap: CapacitySnapshot = {
    computedAt: new Date().toISOString(),
    severity: "ok",
    reasons: [],
    appHost: {
      hasFping,
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
      loadAvg: loadavg() as [number, number, number],
      volumes,
      dbColocated: isDbLocal(),
    },
    database: {
      sizeBytes: dbSizeBytes,
      sampleTables,
      dataDirectory,
      timescale: {
        extensionInstalled: isTimescaleAvailable(),
        hypertableTables: ALL_HYPERTABLE_CANDIDATES.filter((t) => isHypertable(t)),
      },
      queue: {
        pgbossInstalled: isPgbossInstalled(),
        active: getBootTimeMode(),
        persisted: await getQueueMode(),
      },
      connectionPool: {
        currentInUse,
        peakObserved: peakConnectionCount,
        prismaPoolSize,
        pgbossPoolSize,
        maxConnections,
      },
      rollupLastSuccess,
      io: dbIoState,
    },
    workload: {
      monitoredAssetCount: monitoredCount,
      monitoredInterfaceCount,
      monitoredStorageCount,
      cadences,
      retention,
      steadyStateSizeBytes,
    },
  };

  snap.reasons = computeReasons(snap, opts.pgTuningNeeded, opts.advisor, await lifecycleReasonsSafe());
  snap.severity = deriveSeverity(snap.reasons);
  return snap;
}

/**
 * Platform end-of-life reasons, or none.
 *
 * Lazy dynamic import for the same reason getCapacitySnapshotWithAdvisor uses
 * one: it keeps this module out of a load cycle with a service that reads
 * capacity state. Wrapped so a lifecycle failure can never take the capacity
 * snapshot with it — the snapshot drives the sidebar disk alert, which is the
 * more urgent of the two signals.
 *
 * Fetched here rather than threaded through every caller: getCapacitySnapshot
 * has four call sites today and a fifth would silently miss the reasons.
 */
async function lifecycleReasonsSafe(): Promise<CapacityReason[]> {
  try {
    const { getPlatformLifecycle, lifecycleCapacityReasons } = await import(
      "./platformLifecycleService.js"
    );
    const result = await getPlatformLifecycle();
    return lifecycleCapacityReasons(result) as CapacityReason[];
  } catch (err) {
    logger.debug({ err }, "platform lifecycle reasons unavailable; capacity snapshot continues without them");
    return [];
  }
}

/**
 * Two-pass orchestrator: builds an initial snapshot, computes the Capacity
 * Advisor state against it, then rebuilds the snapshot with the advisor's gap
 * data wired into computeReasons so the advisor-driven reasons appear.
 *
 * Used by callers that want both the snapshot and the advisor state without
 * duplicating the orchestration (capacityWatch job, the new
 * /server-settings/capacity-advisor route).
 *
 * `pgTuning` is the external dependency that `capacityAdvisorService` can't
 * compute on its own — it's owned by `buildPgRecommended` in serverSettings.ts.
 * Callers pass in the already-computed current/recommended pairs.
 */
export async function getCapacitySnapshotWithAdvisor(
  opts: {
    pgTuningNeeded: boolean;
    pgTuning: import("./capacityAdvisorService.js").PgTuningExternal;
  },
): Promise<{
  snapshot: CapacitySnapshot;
  advisor: import("./capacityAdvisorService.js").AdvisorState;
}> {
  // Avoid an import cycle at module load: require lazily inside the function.
  // capacityAdvisorService imports type-only from this module, so this dynamic
  // import is purely a paranoia-belt for the runtime side.
  const advisorMod = await import("./capacityAdvisorService.js");
  // Build the snapshot once. The expensive bits (sample-table stats, volume
  // statfs, pg_stat_activity) cost hundreds of ms on busy DBs — re-running
  // the full snapshot just to inject advisor reasons was doubling the
  // Maintenance tab's first-paint latency.
  const snapshot = await getCapacitySnapshot({
    pgTuningNeeded: opts.pgTuningNeeded,
  });
  // Compute the advisor state against this snapshot.
  const advisor = await advisorMod.recomputeAdvisorFromSnapshot(snapshot, opts.pgTuning);
  const gaps = advisorMod.summarizeAdvisorGaps(advisor);
  // The recommendedMaxConnections lives on the advisor's PG_MAX_CONNECTIONS
  // recommendation; surface it so the reason text can name the value.
  const maxConnRec = advisor.recommendations.find((r) => r.key === "PG_MAX_CONNECTIONS");
  const gapsForReasons: AdvisorGapsForReasons = {
    ...gaps,
    recommendedMaxConnections:
      maxConnRec && typeof maxConnRec.recommended === "number"
        ? maxConnRec.recommended
        : undefined,
    handlerTimeoutPressure: gaps.handlerTimeoutPressure,
  };
  // Re-derive reasons + severity in place with the advisor gaps wired in,
  // so the advisor-driven reasons fire without doing a second snapshot pass.
  // The lifecycle result is memoized, so re-fetching it for this second pass
  // costs nothing and keeps the two passes' reason lists identical.
  snapshot.reasons = computeReasons(snapshot, opts.pgTuningNeeded, gapsForReasons, await lifecycleReasonsSafe());
  snapshot.severity = deriveSeverity(snapshot.reasons);
  return { snapshot, advisor };
}

// ─── Transition-only Event emission ───────────────────────────────────────────
// Storing the last severity in a Setting key lets us emit an Event only when
// severity actually changes. The Event flows out through eventArchiveService
// to syslog/SFTP, so a flip into red on a busy night reaches the on-call
// channel even when the UI has already stopped responding (DB on the floor).
// The route handler and a periodic job both call this; concurrent calls are
// idempotent because we re-read the stored value inside the same flow and
// no-op when it already matches the new severity.

const SEVERITY_SETTING_KEY = "capacity.lastSeverity";

interface StoredSeverity {
  severity: Severity;
  recordedAt: string;
}

async function readStoredSeverity(): Promise<StoredSeverity | null> {
  const row = await prisma.setting.findUnique({ where: { key: SEVERITY_SETTING_KEY } });
  if (!row) return null;
  const v = row.value as Partial<StoredSeverity> | null;
  if (!v || !v.severity) return null;
  // Back-compat: pre-rename rows store "red"/"amber"; normalize on read so
  // the transition compare against the fresh severity uses the same vocab.
  return {
    severity: normalizeSeverity(v.severity),
    recordedAt: v.recordedAt ?? new Date(0).toISOString(),
  };
}

async function writeStoredSeverity(severity: Severity): Promise<void> {
  const value: StoredSeverity = { severity, recordedAt: new Date().toISOString() };
  await prisma.setting.upsert({
    where: { key: SEVERITY_SETTING_KEY },
    update: { value: value as any },
    create: { key: SEVERITY_SETTING_KEY, value: value as any },
  });
}

function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

function pickHeadlineReason(reasons: CapacityReason[]): CapacityReason | null {
  if (reasons.length === 0) return null;
  const ranked = [...reasons].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
  return ranked[0];
}

/**
 * Compare current snapshot severity against the last-stored severity and emit
 * one `capacity.severity_changed` Event if they differ. Best-effort — failures
 * are logged at debug level and never thrown so a transient DB hiccup doesn't
 * break the snapshot fetch.
 *
 * Maps severity to Event level: red → "error", amber/watch → "warning",
 * ok → "info" (recovery).
 */
export async function recordCapacityTransition(snap: CapacitySnapshot): Promise<void> {
  try {
    const prior = await readStoredSeverity();
    if (prior && prior.severity === snap.severity) return;

    const level = snap.severity === "critical"
      ? "error"
      : snap.severity === "warning" || snap.severity === "watch"
      ? "warning"
      : "info";

    const direction = !prior
      ? "initial"
      : severityRank(snap.severity) > severityRank(prior.severity)
        ? "escalated"
        : "recovered";

    const headline = pickHeadlineReason(snap.reasons);
    const message = !prior
      ? `Capacity baseline established at ${snap.severity}.`
      : direction === "escalated"
        ? `Capacity ${prior.severity} → ${snap.severity}${headline ? `: ${headline.message}` : "."}`
        : `Capacity ${prior.severity} → ${snap.severity} (recovered).`;

    // Routed through logEvent so Setting.eventRetention.minLevel applies
    // uniformly across the codebase — an operator who muted info events
    // for the rest of Polaris doesn't get unmuted just for capacity
    // recovery transitions. Escalations (warning/error level) still flow
    // through regardless because those outrank the default minLevel.
    await logEvent({
      action: "capacity.severity_changed",
      resourceType: "system",
      actor: "system",
      level,
      message,
      details: {
        from: prior?.severity ?? null,
        to: snap.severity,
        direction,
        reasons: snap.reasons,
        volumes: snap.appHost.volumes.map((v) => ({
          paths: v.paths,
          roles: v.roles,
          freeBytes: v.freeBytes,
          totalBytes: v.totalBytes,
          freePct: v.totalBytes > 0
            ? Number(((v.freeBytes / v.totalBytes) * 100).toFixed(1))
            : null,
        })),
      },
    });

    await writeStoredSeverity(snap.severity);
  } catch (err: any) {
    logger.debug({ err: err?.message }, "capacityService: recordCapacityTransition failed");
  }
}

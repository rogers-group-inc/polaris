/**
 * src/services/timescaleService.ts
 *
 * TimescaleDB detection and hypertable utilities. Polaris's monitoring
 * sample tables (asset_monitor_samples, asset_telemetry_samples,
 * asset_hardware_sensor_samples, asset_interface_samples, asset_storage_samples,
 * asset_ipsec_tunnel_samples, asset_perf_sla_samples)
 * work as plain Postgres tables OR as Timescale hypertables; the prune layer
 * dispatches on hypertable status so the same code path works in both modes.
 *
 * Detection runs once at startup via `detectTimescale()` and caches the
 * result + per-table hypertable status. Subsequent calls return the cached
 * value. Re-detection happens automatically after the boot-time conversion
 * pass (Step 3b) so downstream `isHypertable()` checks reflect the
 * post-conversion state.
 *
 * Detection failures are non-fatal — the cache stays at "extension not
 * available" and the prune layer falls through to the deleteMany path.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";

/** Source sample tables we project / prune / hypertable. Partitioned by `timestamp`. */
export const SAMPLE_TABLES = [
  "asset_monitor_samples",
  "asset_telemetry_samples",
  "asset_hardware_sensor_samples",
  "asset_interface_samples",
  "asset_storage_samples",
  "asset_ipsec_tunnel_samples",
  "asset_perf_sla_samples",
  "asset_process_samples",
] as const;

/**
 * Hourly + daily rollup tables produced by sampleRollupService. Partitioned
 * by `bucketStart` (not `timestamp`). Same Timescale treatment as the source
 * tables: hypertable conversion + per-table compression with the
 * `TIMESCALE_COMPRESS_AFTER_DAYS` window.
 */
export const ROLLUP_TABLES = [
  "asset_monitor_samples_hourly",
  "asset_monitor_samples_daily",
  "asset_telemetry_samples_hourly",
  "asset_telemetry_samples_daily",
  "asset_hardware_sensor_samples_hourly",
  "asset_hardware_sensor_samples_daily",
  "asset_interface_samples_hourly",
  "asset_interface_samples_daily",
  "asset_storage_samples_hourly",
  "asset_storage_samples_daily",
  "asset_ipsec_tunnel_samples_hourly",
  "asset_ipsec_tunnel_samples_daily",
  "asset_perf_sla_samples_hourly",
  "asset_perf_sla_samples_daily",
  "asset_process_samples_hourly",
  "asset_process_samples_daily",
] as const;

/**
 * Detail-only sample tables that are hypertable-managed but live OUTSIDE the
 * tiered detail→hourly→daily rollup model (no rollup companions, not a
 * RETENTION_ENTITY). They get hypertable conversion + compression + drop_chunks
 * pruning like the others, but their retention rides an umbrella window rather
 * than a per-entity tier. `asset_custom_widget_samples` (one row per
 * ManufacturerCustomWidget probe) and `asset_state_samples` (one 0/1 row per
 * state probe row) are both pruned on the system-info umbrella window by
 * pruneSystemInfoSamples; the log tables ride the process window.
 *
 * `asset_state_samples` has no rollup companions on purpose: averaging a boolean
 * yields a duty cycle rather than a state, so there is nothing meaningful for
 * the rollup writer to compute.
 */
export const STANDALONE_SAMPLE_TABLES = [
  "asset_custom_widget_samples",
  "asset_state_samples",
  "asset_process_log_samples",
  "asset_service_log_samples",
] as const;

/** Every table we manage as a hypertable — tiered source + rollup + standalone. */
export const ALL_HYPERTABLE_CANDIDATES = [
  ...SAMPLE_TABLES,
  ...ROLLUP_TABLES,
  ...STANDALONE_SAMPLE_TABLES,
] as const;

export type SampleTableName = typeof SAMPLE_TABLES[number];
export type RollupTableName = typeof ROLLUP_TABLES[number];
export type StandaloneSampleTableName = typeof STANDALONE_SAMPLE_TABLES[number];
export type ManagedHypertableName = typeof ALL_HYPERTABLE_CANDIDATES[number];

interface DetectionState {
  extensionInstalled: boolean;
  /**
   * The installed extension version, e.g. "2.17.2". Null when the extension
   * is absent or the probe predates this field. Read by the platform
   * lifecycle card — TimescaleDB publishes no dated end-of-life, but the
   * version still decides which PostgreSQL majors are reachable (2.29 dropped
   * PostgreSQL 15), so it belongs on the stack inventory.
   */
  extensionVersion: string | null;
  hypertables: Set<string>;
  detectedAt: number;
}

let state: DetectionState = {
  extensionInstalled: false,
  extensionVersion: null,
  hypertables: new Set(),
  detectedAt: 0,
};

/**
 * Probe Postgres for the timescaledb extension and the hypertable status of
 * every sample table. Caches the result. Idempotent — call as many times as
 * you like; the cache only updates when the probe succeeds.
 */
export async function detectTimescale(): Promise<DetectionState> {
  try {
    // extversion comes along for free — same row, same query.
    const ext = await prisma.$queryRawUnsafe<{ extname: string; extversion: string | null }[]>(
      `SELECT extname, extversion FROM pg_extension WHERE extname = 'timescaledb'`,
    );
    const installed = ext.length > 0;
    const extensionVersion = ext[0]?.extversion ?? null;
    const hypertables = new Set<string>();
    if (installed) {
      // Hypertable inventory. `timescaledb_information.hypertables` only lists
      // tables that are currently hypertables — anything missing is plain
      // Postgres. Filter to our sample tables so we ignore unrelated user
      // hypertables (none in Polaris today, but safe to scope).
      try {
        const rows = await prisma.$queryRawUnsafe<{ hypertable_name: string }[]>(
          `SELECT hypertable_name FROM timescaledb_information.hypertables`,
        );
        for (const r of rows) {
          if ((ALL_HYPERTABLE_CANDIDATES as readonly string[]).includes(r.hypertable_name)) {
            hypertables.add(r.hypertable_name);
          }
        }
      } catch (err) {
        // Schema didn't exist yet (extension just installed but information
        // schema not visible to this role). Still set installed=true so the
        // operator-facing alert dismisses; hypertable conversion will fix it
        // on next boot once the schema is reachable.
        logger.debug({ err }, "timescaledb_information schema unreadable; treating sample tables as plain");
      }
    }
    state = { extensionInstalled: installed, extensionVersion, hypertables, detectedAt: Date.now() };
    logger.info(
      { installed, extensionVersion, hypertables: [...hypertables] },
      "TimescaleDB detection complete",
    );
  } catch (err) {
    logger.warn({ err }, "TimescaleDB detection failed; treating as not available");
    state = { extensionInstalled: false, extensionVersion: null, hypertables: new Set(), detectedAt: Date.now() };
  }
  return state;
}

export function isTimescaleAvailable(): boolean {
  return state.extensionInstalled;
}

export function isHypertable(tableName: string): boolean {
  return state.hypertables.has(tableName);
}

export function getDetectionState(): DetectionState {
  return state;
}

/**
 * Drop chunks older than the supplied cutoff from a hypertable. No-op when
 * the table is not a hypertable; cheap to call unconditionally.
 *
 * `drop_chunks` is chunk-granular — it can only drop a chunk when ALL rows
 * in the chunk are older than the cutoff. That makes it a fast pre-filter
 * before the per-class deleteMany pass: chunks beyond the longest retention
 * disappear in O(1) without a seq-scan, then deleteMany handles the residue
 * inside the retention window.
 */
export async function dropChunks(tableName: string, olderThan: Date): Promise<void> {
  if (!isHypertable(tableName)) return;
  try {
    // Cast to `timestamp` (without time zone) — the sample tables' partitioning
    // column is Prisma `DateTime` which maps to `timestamp(3)` in Postgres, so
    // drop_chunks rejects a `timestamptz` cutoff with SQLSTATE 22023:
    // "invalid time argument type". The ISO string Date.toISOString() produces
    // is UTC; Postgres strips the trailing Z when parsing into `timestamp`, so
    // the comparison stays correct (column values are UTC by convention).
    await prisma.$executeRawUnsafe(
      `SELECT drop_chunks($1::regclass, $2::timestamp)`,
      tableName,
      olderThan.toISOString(),
    );
  } catch (err) {
    logger.warn({ err, table: tableName }, "drop_chunks failed; falling back to deleteMany");
  }
}

// Compression-window resolver for `add_compression_policy`. Operators tune
// via TIMESCALE_COMPRESS_AFTER_DAYS; default 7 keeps the 1h / 24h / 7d UI
// chart ranges on uncompressed chunks for instant query latency. 0 disables
// compression entirely (chunks stay uncompressed forever).
function resolveCompressAfterDays(): number {
  const raw = process.env.TIMESCALE_COMPRESS_AFTER_DAYS;
  if (!raw) return 7;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 7;
  return n;
}

/**
 * Convert the source sample tables AND the rollup tables to hypertables
 * (idempotent) and apply / refresh per-table compression. Runs once at boot,
 * AFTER `detectTimescale()` has populated the cache. No-op when the
 * extension is not installed.
 *
 * Per-table flow:
 *   1. If not yet a hypertable, `create_hypertable(..., migrate_data => TRUE)`
 *      with `if_not_exists => TRUE`. Existing data is reorganized into
 *      chunks during the call (brief ACCESS EXCLUSIVE lock — typically
 *      sub-second on small fleets, several minutes on huge ones).
 *   2. Enable / refresh column compression. Idempotent ALTER TABLE.
 *      `compress_segmentby = "assetId"` keeps the read pattern (filter by
 *      asset, range over time) efficient inside compressed chunks.
 *   3. Ensure the compression policy matches the current
 *      `TIMESCALE_COMPRESS_AFTER_DAYS` window — but only remove + re-add when
 *      the window actually CHANGED (compressionPolicyMatches). An unconditional
 *      recreate on every boot resets the policy's next_start ~12h out, so a
 *      host that reboots more often (in-app updates cycle polaris.target) would
 *      never let the policy reach its first run and chunks would never compress.
 *
 * After the per-table loop, a self-heal pass (compressEligibleBacklog)
 * compresses any chunks already past their window but still uncompressed —
 * doing immediately what the 12h policy scheduler otherwise might never get to.
 * This is what prevents the uncompressed delete-churn bloat that ballooned
 * asset_interface_samples to 114 GB in prod (a single 63 GB uncompressed chunk).
 *
 * Source tables partition by `timestamp`; rollup tables partition by
 * `bucketStart`. The compression `orderby` clause uses the same column so
 * compressed chunks stay time-ordered for the prune layer's `drop_chunks`
 * fast path.
 *
 * Errors on any single table are logged and swallowed; the loop continues
 * on the next table. The prune layer falls back to plain-table deleteMany
 * for any table that didn't make it through.
 */
// Selection-aware source tables (interfaces / storage / ipsec) carry a mix of
// "fast" (operator-selected, full retention) and "slow"/unselected rows that
// prune trims to 24h via a per-row deleteMany. Two requirements fall out:
//   - a small (1-day) chunk interval so drop_chunks peels selected history at
//     day granularity and the slow 24h trim lands in small recent chunks;
//   - compress-after >= 2 days as a backstop. The PRIMARY guarantee that the
//     slow deleteMany never touches a compressed chunk is on the prune side:
//     it lower-bounds its window at getEffectiveCompressAfterDays() (see
//     unselectedSlowPruneWindow). A row-level DELETE matching rows in a
//     compressed chunk forces TimescaleDB to decompress the whole chunk into
//     its rowstore heap, leaving multi-GB of un-truncatable low-density heap
//     (prod incident 2026-06-08 — chunks at 0 live tuples / 10 GB on disk).
const SELECTION_AWARE_SOURCE_TABLES = new Set<string>([
  "asset_interface_samples",
  "asset_storage_samples",
  "asset_ipsec_tunnel_samples",
]);
const SELECTION_AWARE_CHUNK_INTERVAL = "1 day";
const SELECTION_AWARE_MIN_COMPRESS_AFTER_DAYS = 2;

/** Max chunks compressed per table per boot by the self-heal backlog pass.
 *  Bounds a large first-run / post-outage backlog so it can't stall boot or
 *  fire dozens of parallel-ish compress_chunk calls. Steady state has 0-1
 *  eligible chunks per table; the cap only bites on first deploy of this code
 *  or after a long compression outage. Overflow is logged + retried next boot. */
const MAX_BACKLOG_COMPRESS_CHUNKS_PER_TABLE = 8;

/** Resolve the effective compress-after window for a table. Selection-aware
 *  tables (interface/storage/ipsec) floor at SELECTION_AWARE_MIN_COMPRESS_AFTER_DAYS;
 *  the prune lower-bounds its unselected deleteMany at this same window so it
 *  never decompresses a compressed chunk. 0 (compression disabled) passes
 *  through unchanged. */
function effectiveCompressAfterFor(table: string, compressAfterDays: number): number {
  const selectionAware = SELECTION_AWARE_SOURCE_TABLES.has(table);
  return selectionAware && compressAfterDays > 0
    ? Math.max(compressAfterDays, SELECTION_AWARE_MIN_COMPRESS_AFTER_DAYS)
    : compressAfterDays;
}

/**
 * Public: the effective compress-after window (in days) Polaris applies to a
 * hypertable, folding the operator's `TIMESCALE_COMPRESS_AFTER_DAYS` with the
 * selection-aware floor. Returns 0 when compression is disabled.
 *
 * The retention prune calls this to lower-bound its unselected-row deleteMany
 * (see `unselectedSlowPruneWindow` in sampleRetentionService): a row-level
 * DELETE that matches rows inside a COMPRESSED chunk forces TimescaleDB to
 * decompress the whole chunk into its rowstore heap, leaving multi-GB of
 * un-truncatable low-density heap (prod incident 2026-06-08). Bounding the
 * delete at this frontier keeps it on uncompressed chunks only.
 */
export function getEffectiveCompressAfterDays(table: string): number {
  return effectiveCompressAfterFor(table, resolveCompressAfterDays());
}

/**
 * True when `table` already carries a compression policy whose `compress_after`
 * window equals `${days} days`. Lets migrateToHypertables SKIP the
 * remove+re-add when nothing changed.
 *
 * Why this matters: re-adding a compression policy resets the job's next_start
 * to `now() + schedule_interval` (12h). migrateToHypertables runs on every
 * web-role boot, so a host that reboots more often than 12h (in-app updates
 * cycle polaris.target; crash loops) would perpetually reset the policy before
 * its first real run ever fires — and the backlog never compresses. Skipping
 * the recreate when the window is unchanged lets the policy's schedule survive
 * across restarts.
 */
async function compressionPolicyMatches(table: string, days: number): Promise<boolean> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ matches: boolean }[]>(
      `SELECT ((config->>'compress_after')::interval = ($2 || ' days')::interval) AS matches
         FROM timescaledb_information.jobs
        WHERE proc_name = 'policy_compression'
          AND hypertable_name = $1`,
      table,
      String(days),
    );
    return rows.length > 0 && rows.every((r) => r.matches === true);
  } catch (err) {
    // Introspection failed (view shape differs across TS versions) — fall back
    // to recreating the policy, which is always correct, just not idempotent.
    logger.debug({ err, table }, "compression policy introspection failed; will recreate");
    return false;
  }
}

/**
 * Self-heal pass: compress chunks that have already aged past `compressAfterDays`
 * but are still uncompressed. Does immediately, at boot, what the TimescaleDB
 * compression POLICY would only do on its 12h schedule — so a frequently
 * restarted host (whose policy timer keeps resetting; see
 * compressionPolicyMatches) doesn't accumulate uncompressed delete-churn bloat.
 * Interface samples are the canonical victim: ~64M rows/day written, nearly all
 * unselected rows DELETEd at 24h out of live uncompressed heap, which never
 * shrinks back to the OS — a single uncompressed chunk reached 63 GB in prod.
 *
 * Sequential + oldest-first + capped at MAX_BACKLOG_COMPRESS_CHUNKS_PER_TABLE.
 * Only touches chunks older than the window, so it never compresses a chunk the
 * unselected 24h deleteMany still needs to write to. Per-chunk errors are
 * swallowed (logged); compress_chunk is atomic per chunk, so partial progress
 * (e.g. interrupted by a restart) is durable and resumes next boot.
 */
async function compressEligibleBacklog(table: string, compressAfterDays: number): Promise<void> {
  if (compressAfterDays <= 0) return;
  // Compute the cutoff in JS (UTC) and compare against the view's timestamptz
  // range_end — avoids session-timezone ambiguity. A few hours of imprecision
  // is harmless: the window is >= 2 days and chunks are 1d/7d wide.
  const cutoff = new Date(Date.now() - compressAfterDays * 24 * 3600 * 1000);
  let eligible: { qualified: string }[];
  try {
    eligible = await prisma.$queryRawUnsafe<{ qualified: string }[]>(
      `SELECT format('%I.%I', chunk_schema, chunk_name) AS "qualified"
         FROM timescaledb_information.chunks
        WHERE hypertable_name = $1
          AND is_compressed = false
          AND range_end <= $2::timestamptz
        ORDER BY range_start ASC`,
      table,
      cutoff.toISOString(),
    );
  } catch (err) {
    logger.debug({ err, table }, "backlog chunk introspection failed; skipping backlog compression");
    return;
  }
  if (eligible.length === 0) return;

  const toCompress = eligible.slice(0, MAX_BACKLOG_COMPRESS_CHUNKS_PER_TABLE);
  const start = Date.now();
  let compressed = 0;
  for (const chunk of toCompress) {
    try {
      await prisma.$executeRawUnsafe(`SELECT compress_chunk($1::regclass)`, chunk.qualified);
      compressed++;
    } catch (err) {
      logger.warn({ err, table, chunk: chunk.qualified }, "backlog compress_chunk failed");
    }
  }
  const remaining = eligible.length - compressed;
  logger.info(
    { table, eligibleChunks: eligible.length, compressed, remaining, durationMs: Date.now() - start },
    remaining > 0
      ? `Compressed ${compressed} backlog chunk(s) on ${table}; ${remaining} remain (resume next boot / policy)`
      : `Compressed ${compressed} backlog chunk(s) on ${table}`,
  );
}

export async function migrateToHypertables(): Promise<void> {
  if (!isTimescaleAvailable()) return;
  const compressAfterDays = resolveCompressAfterDays();

  const targets: Array<{ table: string; partitionColumn: "timestamp" | "bucketStart" }> = [
    ...SAMPLE_TABLES.map((t) => ({ table: t, partitionColumn: "timestamp" as const })),
    ...ROLLUP_TABLES.map((t) => ({ table: t, partitionColumn: "bucketStart" as const })),
    ...STANDALONE_SAMPLE_TABLES.map((t) => ({ table: t, partitionColumn: "timestamp" as const })),
  ];

  for (const { table, partitionColumn } of targets) {
    try {
      const wasHypertable = isHypertable(table);
      const start = Date.now();
      const selectionAware = SELECTION_AWARE_SOURCE_TABLES.has(table);

      if (!wasHypertable) {
        logger.info({ table, partitionColumn }, "Converting sample table to hypertable");
        await prisma.$executeRawUnsafe(
          `SELECT create_hypertable($1::regclass, by_range('${partitionColumn}'), if_not_exists => TRUE, migrate_data => TRUE)`,
          table,
        );
      }

      // Smaller chunk interval for the selection-aware tables. Affects only
      // chunks created after this call — existing chunks keep their interval
      // and age out naturally. Idempotent.
      if (selectionAware) {
        await prisma.$executeRawUnsafe(
          `SELECT set_chunk_time_interval($1::regclass, INTERVAL '${SELECTION_AWARE_CHUNK_INTERVAL}')`,
          table,
        );
      }

      // Enable column compression. Setting these table options is idempotent
      // — re-running with the same values is a no-op. compress_segmentby
      // pins compressed rows by assetId so per-asset queries inside a
      // compressed chunk decompress only the relevant segment, not the whole
      // chunk. The orderby column matches the partition column so compressed
      // chunks stay time-ordered for drop_chunks pruning.
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${table}" SET (timescaledb.compress = on, timescaledb.compress_segmentby = '"assetId"', timescaledb.compress_orderby = '"${partitionColumn}" DESC')`,
      );

      // Compression policy. Selection-aware tables keep the recent window
      // uncompressed long enough that the unselected 24h deleteMany never hits
      // a compressed chunk. When compression is disabled globally (0), ensure
      // no policy lingers.
      const effectiveCompressAfter = effectiveCompressAfterFor(table, compressAfterDays);
      if (effectiveCompressAfter > 0) {
        // Only remove + re-add when the window actually changed. An
        // unconditional recreate resets the policy's next_start to ~12h out;
        // on a host that reboots more often than that the policy would never
        // reach its first run. See compressionPolicyMatches.
        if (!(await compressionPolicyMatches(table, effectiveCompressAfter))) {
          await prisma.$executeRawUnsafe(
            `SELECT remove_compression_policy($1::regclass, if_exists => TRUE)`,
            table,
          );
          await prisma.$executeRawUnsafe(
            `SELECT add_compression_policy($1::regclass, INTERVAL '${effectiveCompressAfter} days')`,
            table,
          );
        }
      } else {
        await prisma.$executeRawUnsafe(
          `SELECT remove_compression_policy($1::regclass, if_exists => TRUE)`,
          table,
        );
      }

      const action = wasHypertable ? "Refreshed compression on" : "Converted to hypertable:";
      logger.info(
        { table, partitionColumn, durationMs: Date.now() - start, compressAfterDays: effectiveCompressAfter, selectionAware },
        `${action} ${table}`,
      );
    } catch (err) {
      logger.error(
        { err, table, partitionColumn },
        "Hypertable migration failed for this table; falling back to plain-table prune path",
      );
    }
  }

  // Re-detect so isHypertable() reflects the post-conversion state for the
  // prune layer + the capacity snapshot.
  await detectTimescale();

  // Self-heal pass: compress any already-eligible-but-uncompressed chunks now,
  // rather than waiting on the 12h policy scheduler (which a frequently
  // restarted host never lets fire). Runs after the DDL loop so every policy is
  // in place first; sequential per table so a large backlog can't saturate the
  // DB. Best-effort — failures are logged inside the helper, never thrown.
  for (const { table } of targets) {
    await compressEligibleBacklog(table, effectiveCompressAfterFor(table, compressAfterDays));
  }
}

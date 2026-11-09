/**
 * src/jobs/reclaimBloatedChunks.ts
 *
 * Nightly maintenance: reclaim orphaned heap left behind in ALREADY-compressed
 * TimescaleDB chunks of ANY sample hypertable (detail + hourly/daily rollups).
 *
 * Mechanism (prod incident 2026-06-08): a row-level DELETE that matches rows
 * inside a compressed chunk forces TimescaleDB to decompress the whole chunk
 * into its rowstore heap to perform the delete. Autovacuum then reclaims the
 * dead tuples to the FSM but never returns the pages to the OS, leaving a
 * multi-GB low-density heap whose real (columnstore) data is only a few hundred
 * MB. `compress_chunk` is a no-op on such a chunk ("already columnstore"), so
 * only a relation rewrite (VACUUM FULL) reclaims it. We saw four interface
 * detail chunks at 0 live tuples / ~10 GB on disk each holding ~350 MB of real
 * data — and again on 2026-06-17 a single `asset_interface_samples_hourly`
 * chunk at 10 GB / 323 MB after the unguarded rollup-tier deleteMany. The scan
 * now covers every hypertable (`ALL_HYPERTABLE_CANDIDATES`), not just the
 * selection-aware detail tables, so rollup-tier residue self-heals too.
 *
 * The prune-side fix (`unselectedSlowPruneWindow` / `pruneSelectionAwareDetail`)
 * prevents NEW occurrences by keeping the slow deleteMany off compressed
 * chunks. THIS job is the self-healing safety net: it clears pre-fix bloat and
 * any future decompression (manual ops, backfills) without an operator hand-
 * running VACUUM FULL.
 *
 * Safety:
 *   - Detection is read-only (chunk_compression_stats + pg_total_relation_size).
 *   - Only chunks whose on-disk size both exceeds MIN_BLOAT_BYTES AND dwarfs
 *     their compressed bytes (> BLOAT_RATIO×) are touched, so healthy compressed
 *     chunks are never needlessly rewritten.
 *   - VACUUM FULL runs on a dedicated direct connection with a short
 *     `lock_timeout`, so it fails fast and skips rather than blocking live
 *     monitoring writes. These are old chunks (no current writes), and with 0
 *     live tuples the rewrite is near-instant.
 *   - Capped at MAX_CHUNKS_PER_RUN; overflow is logged and retried next run.
 *
 * Runs on the scheduler role (see src/app.ts). No-op when TimescaleDB is absent
 * (no hypertables) or when no chunk is bloated.
 *
 * See project memory "DB bloat / compression not running".
 */

import pg from "pg";
import { getDirectDatabaseUrl } from "../utils/dbConnections.js";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { isHypertable, ALL_HYPERTABLE_CANDIDATES } from "../services/timescaleService.js";
import { defineJob } from "./_defineJob.js";
import { sleep } from "../utils/sleep.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000;      // every 6h — fast self-heal without hammering locks
const STARTUP_DELAY_MS = 10 * 60 * 1000;     // 10 min after boot — clear of the boot-time compression self-heal pass
const MIN_BLOAT_BYTES = 256 * 1024 * 1024;   // ignore compressed chunks under 256 MB on disk
const BLOAT_RATIO = 3;                        // on-disk must exceed 3× the compressed bytes to count as bloat
const MAX_CHUNKS_PER_RUN = 12;
// VACUUM FULL needs AccessExclusiveLock, which the resolver's interface-sample
// reads (AccessShareLock, sometimes minutes long) keep stealing. Keep the
// per-attempt lock_timeout SHORT so we never queue ahead of and block live
// reads for more than this; instead RETRY across the run — a read gap opens
// within a few attempts, and once acquired the rewrite of a 0-live chunk is
// seconds. (The daily 5s-once version skipped every chunk in prod 2026-06-08.)
const LOCK_TIMEOUT_MS = 5000;
const RETRY_ATTEMPTS = 6;                     // per chunk
const RETRY_BACKOFF_MS = 30 * 1000;           // wait between lock-timeout retries
const STATEMENT_TIMEOUT_MS = 10 * 60 * 1000; // generous per-chunk ceiling; 0-live rewrites finish in seconds


// Scan EVERY hypertable for decompression bloat, not just the selection-aware
// detail tables. The original list covered only the detail tables whose
// unselected/slow row-DELETE churn decompressed chunks (2026-06-08). But the
// 2026-06-17 incident decompressed a chunk of a *rollup* table
// (`asset_interface_samples_hourly`, via the unguarded `pruneTierByDays`
// deleteMany) — which the detail-only list left stranded (one 10 GB chunk
// holding 323 MB of real data). The prune-side fixes (`tieredPruneWindow` +
// `pruneSelectionAwareDetail`) now keep BOTH detail and rollup row-DELETEs off
// compressed chunks, so going forward nothing should decompress — but this
// job is the self-healing net for the existing residue and any future manual
// op / backfill on ANY hypertable. Detection is read-only and the VACUUM FULL
// only fires on genuinely bloated chunks (> MIN_BLOAT_BYTES AND > BLOAT_RATIO×
// their compressed bytes), so widening the scan is cheap and safe.
const BLOAT_SCAN_TABLES = ALL_HYPERTABLE_CANDIDATES;

interface BloatCandidate {
  qualified: string; // already %I-quoted schema.table from format() in Postgres
  onDiskBytes: number;
  compressedBytes: number;
}

/** Read-only scan for compressed chunks whose heap dwarfs their compressed data. */
async function findBloatedChunks(): Promise<BloatCandidate[]> {
  const candidates: BloatCandidate[] = [];
  for (const table of BLOAT_SCAN_TABLES) {
    if (!isHypertable(table)) continue; // plain Postgres / not yet migrated
    let rows: { qualified: string; on_disk: bigint | null; compressed: bigint | null }[];
    try {
      rows = await prisma.$queryRawUnsafe<
        { qualified: string; on_disk: bigint | null; compressed: bigint | null }[]
      >(
        `SELECT format('%I.%I', s.chunk_schema, s.chunk_name) AS qualified,
                pg_total_relation_size(format('%I.%I', s.chunk_schema, s.chunk_name)::regclass) AS on_disk,
                s.after_compression_total_bytes AS compressed
           FROM chunk_compression_stats($1::regclass) s
          WHERE s.compression_status = 'Compressed'`,
        table,
      );
    } catch (err) {
      logger.debug({ err, table }, "reclaimBloatedChunks: compression-stats scan failed; skipping table");
      continue;
    }
    for (const r of rows) {
      const onDiskBytes = Number(r.on_disk ?? 0);
      const compressedBytes = Number(r.compressed ?? 0);
      if (onDiskBytes >= MIN_BLOAT_BYTES && onDiskBytes > BLOAT_RATIO * Math.max(compressedBytes, 1)) {
        candidates.push({ qualified: r.qualified, onDiskBytes, compressedBytes });
      }
    }
  }
  // Biggest offenders first; cap per run.
  candidates.sort((a, b) => b.onDiskBytes - a.onDiskBytes);
  return candidates.slice(0, MAX_CHUNKS_PER_RUN);
}

/** VACUUM FULL each candidate on a dedicated, lock-timeout-guarded connection. */
async function reclaim(candidates: BloatCandidate[]): Promise<{ count: number; reclaimedBytes: number }> {
  const client = new pg.Client({ connectionString: getDirectDatabaseUrl() });
  await client.connect();
  let count = 0;
  let reclaimedBytes = 0;
  try {
    // Fail fast instead of blocking live monitoring writes; bound the rewrite.
    await client.query(`SET lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    await client.query(`SET statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    for (const c of candidates) {
      let done = false;
      for (let attempt = 1; attempt <= RETRY_ATTEMPTS && !done; attempt++) {
        try {
          // qualified is catalog-derived and %I-quoted by Postgres' format(); VACUUM
          // cannot be parameterized, so it is interpolated. No user input reaches here.
          await client.query(`VACUUM (FULL) ${c.qualified}`);
          const after = await client.query<{ sz: string }>(
            `SELECT pg_total_relation_size($1::regclass) AS sz`,
            [c.qualified],
          );
          const delta = c.onDiskBytes - Number(after.rows[0]?.sz ?? c.onDiskBytes);
          if (delta > 0) reclaimedBytes += delta;
          count++;
          done = true;
          logger.info(
            { chunk: c.qualified, beforeBytes: c.onDiskBytes, reclaimedBytes: delta, attempt },
            "Reclaimed bloated compressed chunk",
          );
        } catch (err) {
          // 55P03 = lock_timeout: a long read holds the chunk. Back off and retry
          // — a gap usually opens within a few attempts. Any other error is not
          // lock contention, so stop retrying this chunk.
          const code = (err as { code?: string } | null)?.code;
          if (code === "55P03" && attempt < RETRY_ATTEMPTS) {
            logger.debug(
              { chunk: c.qualified, attempt },
              "VACUUM FULL lock_timeout; backing off and retrying",
            );
            await sleep(RETRY_BACKOFF_MS);
            continue;
          }
          logger.warn(
            { err, chunk: c.qualified, attempts: attempt },
            "VACUUM FULL on bloated chunk skipped (will retry next run)",
          );
          break;
        }
      }
    }
  } finally {
    await client.end();
  }
  return { count, reclaimedBytes };
}

// Delay the first run past boot so it doesn't race the compression self-heal
// pass, then run every 6h from there.
defineJob({
  name: "reclaimBloatedChunks",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: STARTUP_DELAY_MS,
  intervalAfterFirstRun: true,
  run: async () => {
    const candidates = await findBloatedChunks();
    if (candidates.length === 0) return;
    const totalOnDisk = candidates.reduce((a, c) => a + c.onDiskBytes, 0);
    logger.info(
      { chunks: candidates.length, onDiskBytes: totalOnDisk },
      "Found bloated compressed chunk(s); reclaiming",
    );
    const { count, reclaimedBytes } = await reclaim(candidates);
    if (count > 0) {
      logger.info({ count, reclaimedBytes }, "reclaimBloatedChunks complete");
    }
  },
});

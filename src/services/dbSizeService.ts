/**
 * dbSizeService — the one place that measures how big this database is.
 *
 * Everything here is CATALOG-ONLY: `pg_class.relpages × block_size`, never
 * `pg_database_size()` or `pg_total_relation_size()`. Those helpers stat() every
 * relfilenode behind a relation, and a TimescaleDB hypertable decomposes into
 * hundreds of chunks (28 hypertables at prod scale), which made the Maintenance
 * tab wait minutes on the filesystem. The cost is freshness: relpages is
 * accurate as of the last VACUUM/ANALYZE, which is why `neverAnalyzedRelations`
 * is reported alongside every figure — after a `pg_upgrade` (planner stats are
 * not carried across before PG18) a relation nothing has written to since can
 * sit at relpages 0 forever and silently understate the total.
 *
 * Why this module exists at all: the Database card used to print a whole-database
 * total (`SUM(relpages)` over EVERY schema) directly above a table list that was
 * public-schema-only, heap+index-only, and — whenever the chunk fold failed —
 * hypertable-parent-only. On prod (2026-09-17) that read 76.6 GB above a list
 * whose rows summed to ~2.6 GB, with no way to tell which of the three gaps held
 * the missing ~74 GB. The two numbers are now computed from ONE attribution pass
 * over the catalog and reconcile by construction: every relation in the database
 * belongs to exactly one bucket, and the buckets sum to the total.
 *
 * Attribution rules:
 *  - an index belongs to the schema of the table it indexes
 *  - a TOAST relation belongs to the schema of the table it stores for, and a
 *    TOAST index belongs to that same table (two hops)
 *  - a TimescaleDB chunk — uncompressed OR compressed — belongs to its user
 *    hypertable in `public`, not to `_timescaledb_internal`
 * so `polarisBytes` is "the bytes of Polaris's own tables, everything included"
 * and the residual is honestly labelled as pg-boss + PostgreSQL's own catalog.
 *
 * Business rule 71: the parts are the whole by construction, and a measurement whose
 * mechanism broke reports that rather than reading zero.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { isTimescaleAvailable } from "./timescaleService.js";

/** One public-schema table, sized with everything that belongs to it. */
export interface TableSize {
  name: string;
  /** Live tuples, chunks folded in. Compressed chunks contribute 0 (their
   *  `n_live_tup` counts compressed batches, ~1 per 1000 logical rows). */
  rows: number;
  deadRows: number;
  /** Heap + indexes + TOAST, for the table and every chunk it owns. */
  bytes: number;
  lastAutovacuum: Date | null;
  chunkCount: number;
  compressedChunkCount: number;
}

/**
 * How the tables in a `TableSizeResult` were measured. `parent-only` means the
 * chunk fold failed, so every hypertable is reported at its parent relation's
 * size, which is ~0. This is RETURNED rather than merely logged because the two
 * cases are indistinguishable on the card otherwise: a 15 GB sample table and an
 * empty one both render as "0 B".
 */
export type TableSizing = "chunk-aware" | "parent-only" | "no-timescale";

export interface TableSizeResult {
  sizing: TableSizing;
  tables: TableSize[];
}

export interface DatabaseSizeBreakdown {
  /** Every relation in the database. The figure the card calls "Current size". */
  totalBytes: number;
  /** `public` tables with their indexes, TOAST and TimescaleDB chunks. */
  polarisBytes: number;
  /** The pg-boss job queue schema — real bytes, and not one of Polaris's tables. */
  pgbossBytes: number;
  /** PostgreSQL's own catalog + information_schema. */
  catalogBytes: number;
  /** Anything else (a session store in its own schema, an operator's scratch table). */
  otherBytes: number;
  /**
   * Relations that have never been VACUUMed or ANALYZEd (`reltuples = -1`), so
   * they carry relpages 0 and are invisible to every figure here. Non-zero right
   * after a restore or a major-version upgrade until `vacuumdb --analyze` runs.
   */
  neverAnalyzedRelations: number;
}

/**
 * Pages for a relation, its indexes, its TOAST relation and that TOAST
 * relation's index. Applied to a public table and to every chunk alike — and
 * the TOAST term is not an edge case for chunks: a COMPRESSED chunk keeps its
 * compressed batches in TOAST, which on a real hypertable is most of its bytes
 * (10.6 MB of a 32.4 MB test hypertable). Counting heap+index only, as the
 * predecessor query did, misses nearly all of a compressed table.
 */
const OWNED_PAGES_SQL = `
    c.relpages
      + COALESCE(ix.pages, 0)
      + COALESCE(tt.pages, 0)`;

const OWNED_PAGES_JOINS_SQL = `
    LEFT JOIN LATERAL (
      SELECT SUM(i.relpages)::bigint AS pages
      FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
      WHERE x.indrelid = c.oid
    ) ix ON true
    LEFT JOIN LATERAL (
      SELECT (tc.relpages + COALESCE((
        SELECT SUM(ti.relpages)::bigint
        FROM pg_index tx JOIN pg_class ti ON ti.oid = tx.indexrelid
        WHERE tx.indrelid = tc.oid
      ), 0))::bigint AS pages
      FROM pg_class tc WHERE tc.oid = c.reltoastrelid
    ) tt ON true`;

/**
 * How to fold chunk relations back onto their hypertable. `false` skips the fold
 * (no TimescaleDB, or its catalog is unreadable); `"with-legacy-link"` adds the
 * hop through `hypertable.compressed_hypertable_id` that pre-2.30 versions need.
 */
type ChunkFold = false | "prefix" | "prefix-with-legacy-link";

/**
 * Chunk relations, found by their NAME PREFIX rather than by the chunk catalog.
 *
 * This is deliberate, and it is the bug that made prod's card unreadable. The
 * predecessor query joined `_timescaledb_catalog.chunk` on
 * `schema_name`/`table_name` and reached compressed chunks through
 * `hypertable.compressed_hypertable_id`. TimescaleDB 2.30 — which prod moved to
 * with PG17 on 2026-09-16 — rewrote all of that:
 *   - `chunk` lost `schema_name`/`table_name` in favour of a single `relid`,
 *     so the query errored outright (42703) and sizing fell back to parent-only;
 *   - there is no longer an internal compression hypertable at all
 *     (`compression_state` = 0, `compressed_hypertable_id` = NULL), and a
 *     compressed chunk is NOT registered in `chunk`. Nothing in the catalog
 *     points at it: `compression_chunk_size.compressed_chunk_id` is 0 and
 *     pg_depend has no link. So even a fixed catalog join would have silently
 *     missed every compressed byte.
 * What HAS been stable across the whole 2.x line is the relation naming:
 * `_hyper_<hypertableId>_<chunkId>_chunk[...]` for a chunk, with a `_compressed`
 * suffix (2.30) or a `compress_hyper_<internalHypertableId>_...` name (earlier)
 * for its compressed half. Reading the hypertable id out of the name needs only
 * `hypertable.id`, which has never moved.
 *
 * Verified against `hypertable_detailed_size()` on TimescaleDB 2.30: 31.94 MB
 * measured vs 32.40 MB reported, the 1.4% being the FSM/visibility-map forks
 * that `relpages` does not count.
 */
function chunkOwnerCte(fold: Exclude<ChunkFold, false>): string {
  // Pre-2.30, a compressed chunk's name carries the id of the INTERNAL
  // compression hypertable, which the user hypertable claims via
  // `compressed_hypertable_id` — hence the second hop and the COALESCE. On 2.30
  // the column still exists but is always NULL, and the join is harmless; the
  // "prefix" variant omits it entirely so a future version that drops the column
  // keeps working.
  const legacyLink = fold === "prefix-with-legacy-link";
  return `
  ht AS (
    SELECT id, schema_name, table_name${legacyLink ? ", compressed_hypertable_id" : ""}
    FROM _timescaledb_catalog.hypertable
  ),
  chunk_owner AS (
    SELECT
      COALESCE(${legacyLink ? "userht.schema_name, " : ""}ownerht.schema_name) AS user_schema,
      COALESCE(${legacyLink ? "userht.table_name, " : ""}ownerht.table_name)   AS user_table,
      (cls.relname LIKE '%\\_compressed' OR cls.relname LIKE 'compress\\_hyper%') AS is_compressed,
      cls.oid AS rel_oid
    FROM pg_class cls
    JOIN pg_namespace ns ON ns.oid = cls.relnamespace AND ns.nspname = '_timescaledb_internal'
    JOIN ht ownerht ON ownerht.id = (substring(cls.relname from '^(?:_hyper|compress_hyper)_(\\d+)_'))::int
    ${legacyLink ? "LEFT JOIN ht userht ON userht.compressed_hypertable_id = ownerht.id" : ""}
    WHERE cls.relkind = 'r'
      AND cls.relname ~ '^(_hyper|compress_hyper)_\\d+_\\d+_chunk'
  )`;

}

/**
 * Does this TimescaleDB still carry `hypertable.compressed_hypertable_id`?
 * Probed once per process (the answer changes only with an extension upgrade,
 * which restarts nothing — a stale `true` costs an unnecessary LEFT JOIN, a
 * stale `false` costs pre-2.30 compressed chunks, and both are corrected on the
 * next boot). Null result is treated as absent, which is the safe modern shape.
 */
let legacyCompressedLink: boolean | null = null;

async function chunkFoldMode(): Promise<Exclude<ChunkFold, false>> {
  if (legacyCompressedLink === null) {
    try {
      const rows = await prisma.$queryRawUnsafe<{ present: boolean }[]>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_attribute
            WHERE attrelid = '_timescaledb_catalog.hypertable'::regclass
              AND attname = 'compressed_hypertable_id'
              AND NOT attisdropped
         ) AS present`,
      );
      legacyCompressedLink = rows[0]?.present === true;
    } catch (err) {
      logger.debug({ err }, "dbSize.compressed_link_probe_failed; assuming the modern catalog shape");
      legacyCompressedLink = false;
    }
  }
  return legacyCompressedLink ? "prefix-with-legacy-link" : "prefix";
}

/** Exported for the tests: forget the probed catalog shape. */
export function _resetCatalogShapeCache(): void {
  legacyCompressedLink = null;
}

interface TableSizeRow {
  name: string;
  bytes: bigint | null;
  n_live_tup: bigint | null;
  n_dead_tup: bigint | null;
  last_autovacuum: Date | null;
  chunk_count: number | null;
  compressed_chunk_count: number | null;
}

/**
 * Size every table in the `public` schema (or just `names`, when given), with
 * chunks, indexes and TOAST folded into the owning table.
 *
 * Scale: one round trip, hash joins over the catalog. At 2000 monitored assets
 * pg_class holds the 28 hypertables' chunks plus their indexes and TOAST — tens
 * of thousands of rows, all in shared buffers. There is no per-table or
 * per-asset query here and there must never be one: this runs on a tab fetch.
 */
export async function getTableSizes(names?: readonly string[]): Promise<TableSizeResult> {
  const filter = names ? "AND c.relname = ANY($1::text[])" : "";
  const params = names ? [names as string[]] : [];
  const run = (chunks: ChunkFold) =>
    prisma.$queryRawUnsafe<TableSizeRow[]>(buildTableSizeSql({ chunks, filter }), ...params);

  if (!isTimescaleAvailable()) {
    return { sizing: "no-timescale", tables: (await run(false)).map(mapTableRow) };
  }

  try {
    return { sizing: "chunk-aware", tables: (await run(await chunkFoldMode())).map(mapTableRow) };
  } catch (err) {
    // Degrade VISIBLY: the caller surfaces `parent-only` on the card so an
    // operator can tell "the fold broke" from "the sample tables are empty".
    logger.warn({ err }, "dbSize.chunk_aware_sizing_failed; falling back to parent-only sizing");
    return { sizing: "parent-only", tables: (await run(false)).map(mapTableRow) };
  }
}

/** Exported for the SQL-shape tests; not part of the module's contract. */
export function buildTableSizeSql(opts: { chunks: ChunkFold; filter: string }): string {
  // Without the fold, `owned` is the parent relations alone — correct for a
  // plain Postgres install, where a non-hypertable holds all its own pages.
  const ownedUnion = opts.chunks
    ? `
    SELECT p.name AS table_name, p.oid AS rel_oid, false AS is_chunk, false AS is_compressed
    FROM parents p
    UNION ALL
    SELECT p.name, co.rel_oid, true, co.is_compressed
    FROM chunk_owner co
    JOIN parents p ON p.name = co.user_table AND co.user_schema = 'public'`
    : `
    SELECT p.name AS table_name, p.oid AS rel_oid, false AS is_chunk, false AS is_compressed
    FROM parents p`;

  return `
  WITH parents AS (
    SELECT c.oid, c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' ${opts.filter}
  ),${opts.chunks ? chunkOwnerCte(opts.chunks) + "," : ""}
  owned AS (${ownedUnion}
  ),
  sized AS (
    SELECT
      o.table_name,
      o.is_chunk,
      o.is_compressed,
      (${OWNED_PAGES_SQL})::bigint AS pages,
      COALESCE(s.n_live_tup, 0)::bigint AS n_live_tup,
      COALESCE(s.n_dead_tup, 0)::bigint AS n_dead_tup,
      s.last_autovacuum
    FROM owned o
    JOIN pg_class c ON c.oid = o.rel_oid
    LEFT JOIN pg_stat_user_tables s ON s.relid = o.rel_oid${OWNED_PAGES_JOINS_SQL}
  )
  SELECT
    p.name AS name,
    (COALESCE(SUM(sz.pages), 0) * current_setting('block_size')::bigint)::bigint AS bytes,
    COALESCE(SUM(CASE WHEN sz.is_compressed THEN 0 ELSE sz.n_live_tup END), 0)::bigint AS n_live_tup,
    COALESCE(SUM(CASE WHEN sz.is_compressed THEN 0 ELSE sz.n_dead_tup END), 0)::bigint AS n_dead_tup,
    MAX(sz.last_autovacuum) AS last_autovacuum,
    COUNT(sz.table_name) FILTER (WHERE sz.is_chunk)::int AS chunk_count,
    COUNT(sz.table_name) FILTER (WHERE sz.is_compressed)::int AS compressed_chunk_count
  FROM parents p
  LEFT JOIN sized sz ON sz.table_name = p.name
  GROUP BY p.name
  ORDER BY 2 DESC`;
}

function mapTableRow(r: TableSizeRow): TableSize {
  return {
    name: r.name,
    bytes: Number(r.bytes ?? 0),
    rows: Number(r.n_live_tup ?? 0),
    deadRows: Number(r.n_dead_tup ?? 0),
    lastAutovacuum: r.last_autovacuum ?? null,
    chunkCount: Number(r.chunk_count ?? 0),
    compressedChunkCount: Number(r.compressed_chunk_count ?? 0),
  };
}

/**
 * Attribute EVERY relation in the database to exactly one bucket. Index and
 * TOAST relations follow the table they serve, and a TimescaleDB chunk follows
 * its user hypertable, so the `polaris` bucket is comparable with the sum of
 * `getTableSizes()` and the rest is genuinely not Polaris's tables.
 *
 * The self-joins on pg_class are plain LEFT JOINs on purpose: as LATERAL
 * subqueries, `tp.reltoastrelid = c.oid` is a seq scan of pg_class per TOAST
 * relation (there is no index on reltoastrelid), which is quadratic in the chunk
 * count. As joins the planner hashes pg_class once.
 */
function relationOwnerSql(chunks: ChunkFold): string {
  return `
  WITH ${chunks ? chunkOwnerCte(chunks) + "," : ""}
  rels AS (
    SELECT
      c.relpages::bigint AS relpages,
      -- The TABLE this relation's bytes belong to. A chunk's index and TOAST
      -- resolve to the chunk heap, which the chunk fold then resolves to the
      -- user hypertable — so a compressed chunk's payload (which lives in its
      -- TOAST) lands on the same table the card lists.
      COALESCE(tp.oid, tp2.oid, it.oid, c.oid) AS table_oid,
      COALESCE(
        tpn.nspname,   -- TOAST relation → the table it stores for
        tpn2.nspname,  -- TOAST index → the table behind its TOAST relation
        itn.nspname,   -- index → the table it indexes
        n.nspname      -- table / matview → itself
      ) AS owner_ns
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_index x ON c.relkind = 'i' AND x.indexrelid = c.oid
    LEFT JOIN pg_class it ON it.oid = x.indrelid
    LEFT JOIN pg_namespace itn ON itn.oid = it.relnamespace
    LEFT JOIN pg_class tp ON c.relkind = 't' AND tp.reltoastrelid = c.oid
    LEFT JOIN pg_namespace tpn ON tpn.oid = tp.relnamespace
    LEFT JOIN pg_class tp2 ON it.relkind = 't' AND tp2.reltoastrelid = it.oid
    LEFT JOIN pg_namespace tpn2 ON tpn2.oid = tp2.relnamespace
    WHERE c.relkind IN ('r', 'i', 't', 'm')
  )
  SELECT
    CASE
      -- A chunk of a public hypertable first: its relations sit in
      -- _timescaledb_internal but its bytes are Polaris's sample data, and they
      -- are the bulk of the database.
      ${chunks ? "WHEN co.user_schema = 'public' THEN 'polaris'" : ""}
      WHEN r.owner_ns IN ('pg_catalog', 'information_schema') THEN 'catalog'
      WHEN r.owner_ns = 'pgboss'                              THEN 'pgboss'
      WHEN r.owner_ns = 'public'                              THEN 'polaris'
      -- Whatever is still sitting in a TimescaleDB schema after the fold is the
      -- extension's own catalog and background-job bookkeeping.
      WHEN r.owner_ns LIKE '\\_timescaledb%'                  THEN 'timescale'
      ELSE 'other'
    END AS bucket,
    (SUM(r.relpages) * current_setting('block_size')::bigint)::bigint AS bytes
  FROM rels r
  ${chunks ? "LEFT JOIN chunk_owner co ON co.rel_oid = r.table_oid" : ""}
  GROUP BY 1`;
}

interface BucketRow {
  bucket: string;
  bytes: bigint | null;
}

/**
 * The card's "Current size", decomposed so the table list under it can be shown
 * to account for it. `totalBytes` is the sum of the buckets by construction —
 * the figure and its explanation cannot drift apart.
 */
export async function getDatabaseSizeBreakdown(): Promise<DatabaseSizeBreakdown> {
  let buckets: BucketRow[] | null = null;

  if (isTimescaleAvailable()) {
    try {
      buckets = await prisma.$queryRawUnsafe<BucketRow[]>(relationOwnerSql(await chunkFoldMode()));
    } catch (err) {
      logger.warn({ err }, "dbSize.breakdown_chunk_fold_failed; chunk bytes will bucket as residual");
    }
  }
  if (!buckets) {
    // No TimescaleDB, or its chunk catalog is unreadable. The TOTAL stays
    // correct either way — only the polaris/other split degrades, because chunk
    // relations then bucket as `timescale` and land in the residual, which is
    // consistent with the `parent-only` table list the card shows beside it.
    try {
      buckets = await prisma.$queryRawUnsafe<BucketRow[]>(relationOwnerSql(false));
    } catch (err) {
      logger.warn({ err }, "dbSize.breakdown_query_failed; falling back to a flat total");
      buckets = await prisma.$queryRawUnsafe<BucketRow[]>(
        `SELECT 'other' AS bucket,
                (SUM(relpages) * current_setting('block_size')::bigint)::bigint AS bytes
           FROM pg_class WHERE relkind IN ('r', 'i', 't', 'm')`,
      );
    }
  }

  return summarizeBuckets(buckets, await countNeverAnalyzed());
}

/** `reltuples = -1` is PG14+'s "never vacuumed or analyzed" marker. Such a
 *  relation reports relpages 0 no matter how much data it holds, so it is
 *  missing from every figure in this module until autovacuum reaches it. */
async function countNeverAnalyzed(): Promise<number> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r'
          AND c.reltuples = -1
          AND (n.nspname = 'public' OR n.nspname LIKE '\\_timescaledb%')`,
    );
    return Number(rows[0]?.count ?? 0);
  } catch (err) {
    logger.debug({ err }, "dbSize.never_analyzed_probe_failed");
    return 0;
  }
}

/** Pure bucket → breakdown mapping. Exported for the unit tests. */
export function summarizeBuckets(buckets: BucketRow[], neverAnalyzedRelations: number): DatabaseSizeBreakdown {
  const by = (name: string) => Number(buckets.find((b) => b.bucket === name)?.bytes ?? 0);
  const polarisBytes = by("polaris");
  const pgbossBytes = by("pgboss");
  const catalogBytes = by("catalog");
  // "timescale" is the extension's own catalog/bookkeeping, not a Polaris table
  // — it belongs with the residual, not with the data it describes.
  const otherBytes = by("other") + by("timescale");
  return {
    totalBytes: polarisBytes + pgbossBytes + catalogBytes + otherBytes,
    polarisBytes,
    pgbossBytes,
    catalogBytes,
    otherBytes,
    neverAnalyzedRelations,
  };
}

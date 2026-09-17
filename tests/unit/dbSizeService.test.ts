/**
 * tests/unit/dbSizeService.test.ts
 *
 * The Database card printed a whole-database total (`SUM(relpages)` over every
 * schema) directly above a table list that was public-schema-only,
 * heap+index-only, and parent-only whenever the TimescaleDB chunk fold failed.
 * On prod (2026-09-17) that read 76.6 GB above rows summing to ~2.6 GB with no
 * way to tell which gap held the missing ~74 GB.
 *
 * These are the pure halves: the bucket arithmetic (the buckets must SUM to the
 * total — that is what makes the card reconcile by construction) and the shape
 * of the generated SQL (which relations get folded into a table's bytes). The
 * SQL is executed for real in tests/integration/dbSize.test.ts.
 */

import { describe, it, expect, vi } from "vitest";

// dbSizeService imports prisma at module load; stub it so the pure helpers can
// be imported without opening a connection.
vi.mock("../../src/db.js", () => ({
  prisma: { $queryRawUnsafe: vi.fn(), $queryRaw: vi.fn() },
  getDirectStatsPool: () => null,
}));

import { summarizeBuckets, buildTableSizeSql } from "../../src/services/dbSizeService.js";

const GB = 1024 ** 3;

describe("summarizeBuckets", () => {
  it("sums every bucket into the total", () => {
    const b = summarizeBuckets(
      [
        { bucket: "polaris", bytes: BigInt(70 * GB) },
        { bucket: "pgboss", bytes: BigInt(4 * GB) },
        { bucket: "catalog", bytes: BigInt(GB / 2) },
        { bucket: "other", bytes: BigInt(GB / 4) },
      ],
      0,
    );
    expect(b.totalBytes).toBe(b.polarisBytes + b.pgbossBytes + b.catalogBytes + b.otherBytes);
    expect(b.totalBytes).toBe(74 * GB + GB / 2 + GB / 4);
  });

  it("folds the TimescaleDB extension's own schemas into the residual, not into Polaris's tables", () => {
    // Chunks of a public hypertable are attributed to 'polaris' by the query;
    // whatever is still labelled 'timescale' is the extension's catalog and
    // background-job bookkeeping, which is NOT one of the tables the card lists.
    // Adding it to polarisBytes would make the list look like it under-counts.
    const b = summarizeBuckets(
      [
        { bucket: "polaris", bytes: BigInt(10 * GB) },
        { bucket: "timescale", bytes: BigInt(GB) },
      ],
      0,
    );
    expect(b.polarisBytes).toBe(10 * GB);
    expect(b.otherBytes).toBe(GB);
    expect(b.totalBytes).toBe(11 * GB);
  });

  it("treats a missing bucket as zero rather than NaN", () => {
    const b = summarizeBuckets([], 0);
    expect(b.totalBytes).toBe(0);
    expect(b.polarisBytes).toBe(0);
    expect(b.pgbossBytes).toBe(0);
    expect(Number.isNaN(b.totalBytes)).toBe(false);
  });

  it("carries the never-analyzed relation count through", () => {
    // Non-zero is the post-pg_upgrade / post-restore state: relpages is 0 for a
    // relation nothing has written to since, so every figure understates until
    // vacuumdb runs. The card has to be able to say so.
    expect(summarizeBuckets([], 412).neverAnalyzedRelations).toBe(412);
  });
});

describe("buildTableSizeSql", () => {
  const modern = buildTableSizeSql({ chunks: "prefix", filter: "" });
  const legacy = buildTableSizeSql({ chunks: "prefix-with-legacy-link", filter: "" });
  const parentOnly = buildTableSizeSql({ chunks: false, filter: "" });

  it("counts TOAST and TOAST-index pages, not just heap and indexes", () => {
    // The per-table rows used to be heap + index only while the total included
    // relkind 't', so every table was understated by its TOAST — and a
    // COMPRESSED chunk keeps its batches in TOAST, which is most of its bytes.
    for (const sql of [modern, legacy, parentOnly]) {
      expect(sql).toContain("c.reltoastrelid");
      expect(sql).toMatch(/tt\.pages/);
      expect(sql).toMatch(/ix\.pages/);
    }
  });

  it("finds chunk relations by name prefix, not through the chunk catalog", () => {
    // TimescaleDB 2.30 replaced chunk.schema_name/table_name with relid AND
    // stopped registering compressed chunks in the catalog at all — nothing in
    // the catalog points at a compressed chunk (compressed_chunk_id is 0,
    // pg_depend has no link). The naming convention is the only stable route,
    // and getting this wrong is silent: the query errors or matches nothing,
    // sizing degrades to parent-only, and every hypertable reads ~0.
    for (const sql of [modern, legacy]) {
      expect(sql).toContain("_timescaledb_internal");
      expect(sql).toMatch(/\^\(\?:_hyper\|compress_hyper\)_\(\\d\+\)_/);
      // both spellings of "this is the compressed half"
      expect(sql).toContain("_compressed'");
      expect(sql).toContain("compress\\_hyper%");
      expect(sql).not.toContain("_timescaledb_catalog.chunk");
    }
  });

  it("only hops through compressed_hypertable_id on catalogs that still have it", () => {
    // 2.30 keeps the column but leaves it NULL; a future version may drop it,
    // and referencing a missing column errors the whole query (42703) rather
    // than degrading a single row.
    expect(legacy).toContain("compressed_hypertable_id");
    expect(modern).not.toContain("compressed_hypertable_id");
  });

  it("attributes chunks only to a hypertable that really is in public", () => {
    for (const sql of [modern, legacy]) {
      expect(sql).toContain("co.user_schema = 'public'");
    }
  });

  it("degrades to parent relations alone with the fold off", () => {
    expect(parentOnly).not.toContain("_timescaledb");
    expect(parentOnly).not.toContain("chunk_owner");
  });

  it("never counts a compressed chunk's tuples as logical rows", () => {
    // A compressed chunk's n_live_tup is its batch count (~1 per 1000 logical
    // rows); summing it would badly understate the table's row count while its
    // bytes are counted in full.
    expect(modern).toContain("CASE WHEN sz.is_compressed THEN 0 ELSE sz.n_live_tup END");
    expect(modern).toContain("CASE WHEN sz.is_compressed THEN 0 ELSE sz.n_dead_tup END");
  });

  it("applies a caller-supplied name filter to the parent scan", () => {
    const filtered = buildTableSizeSql({ chunks: "prefix", filter: "AND c.relname = ANY($1::text[])" });
    // The filter must sit on `parents`, so chunks join through it rather than
    // being scanned for every hypertable in the database.
    const parentsBlock = filtered.slice(filtered.indexOf("WITH parents"), filtered.indexOf("owned AS"));
    expect(parentsBlock).toContain("ANY($1::text[])");
  });

  it("is public-schema-scoped and ordinary-table-scoped", () => {
    for (const sql of [modern, parentOnly]) {
      expect(sql).toContain("n.nspname = 'public'");
      expect(sql).toContain("c.relkind = 'r'");
    }
  });
});

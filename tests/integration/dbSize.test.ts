/**
 * tests/integration/dbSize.test.ts
 *
 * The sizing SQL against a real database. The unit test pins the arithmetic and
 * the query's shape; only a live catalog can prove the parts that actually broke
 * the Database card:
 *
 *   1. the buckets sum to the same total as the card's old whole-database
 *      `SUM(relpages)` — nothing is dropped or double-counted by attributing
 *      indexes, TOAST and chunks to their owning table;
 *   2. the sum of the table list plus the unlisted buckets IS that total, which
 *      is the property the card now claims to the operator;
 *   3. a TOASTed column's bytes reach the table's row (they used to be counted
 *      in the total and in no row);
 *   4. chunk bytes land on the hypertable, not in the residual.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/db.js";
import { getTableSizes, getDatabaseSizeBreakdown } from "../../src/services/dbSizeService.js";
import { detectTimescale, isTimescaleAvailable } from "../../src/services/timescaleService.js";
import { dbDescribe, dbReachable } from "./_helpers.js";

const d = dbDescribe;

const TOAST_TABLE = "polaris_dbsize_toast_probe";

/** The card's pre-fix total: every relation in the database, no attribution. */
async function flatTotalBytes(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ size: bigint }[]>(
    `SELECT (current_setting('block_size')::bigint * SUM(relpages::bigint))::bigint AS size
       FROM pg_class WHERE relkind IN ('r', 'i', 't', 'm')`,
  );
  return Number(rows[0]?.size ?? 0);
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  // isTimescaleAvailable() is a cached probe result; without this the service
  // takes its no-timescale path and the chunk assertions test nothing.
  await detectTimescale();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.$queryRawUnsafe(`DROP TABLE IF EXISTS "${TOAST_TABLE}"`);
  await prisma.$disconnect();
});

d("dbSizeService against a real catalog", () => {
  it("attributes every relation exactly once — buckets sum to the whole-database total", async () => {
    const [breakdown, flat] = await Promise.all([getDatabaseSizeBreakdown(), flatTotalBytes()]);
    expect(breakdown.totalBytes).toBe(flat);
    expect(breakdown.polarisBytes).toBeGreaterThan(0);
    expect(breakdown.catalogBytes).toBeGreaterThan(0);
  });

  it("accounts for the total: table list + unlisted buckets = current size", async () => {
    // This is the claim the Maintenance card makes to an operator. Before the
    // fix the list summed to ~3% of the total on prod.
    const [{ tables }, breakdown] = await Promise.all([getTableSizes(), getDatabaseSizeBreakdown()]);
    const tablesBytes = tables.reduce((sum, t) => sum + t.bytes, 0);
    const listed = tablesBytes + breakdown.pgbossBytes + breakdown.catalogBytes + breakdown.otherBytes;

    // Exact equality is not available: the two queries run as separate
    // statements, and an autovacuum landing between them moves relpages. Tie
    // the tolerance to the total so this doesn't flake on a busy dev database.
    const tolerance = Math.max(4 * 1024 * 1024, breakdown.totalBytes * 0.02);
    expect(Math.abs(listed - breakdown.totalBytes)).toBeLessThan(tolerance);
    // The table list must account for essentially all of the polaris bucket —
    // a large residual here is the parent-only fallback in disguise.
    expect(Math.abs(breakdown.polarisBytes - tablesBytes)).toBeLessThan(tolerance);
  });

  it("counts a TOASTed column's bytes on the owning table's row", async () => {
    await prisma.$queryRawUnsafe(`DROP TABLE IF EXISTS "${TOAST_TABLE}"`);
    await prisma.$queryRawUnsafe(`CREATE TABLE "${TOAST_TABLE}" (id serial primary key, blob text)`);
    // 40 rows × ~1 MB of incompressible text: pg_toast is the only place this
    // can live (a page is 8 kB), so the heap stays tiny and the table's real
    // size is essentially all TOAST.
    await prisma.$queryRawUnsafe(
      `INSERT INTO "${TOAST_TABLE}" (blob)
       SELECT string_agg(md5(random()::text || g || s), '')
         FROM generate_series(1, 40) g, generate_series(1, 32768) s
        GROUP BY g`,
    );
    await prisma.$queryRawUnsafe(`VACUUM ANALYZE "${TOAST_TABLE}"`);

    const [{ tables }, truth] = await Promise.all([
      getTableSizes([TOAST_TABLE]),
      prisma.$queryRawUnsafe<{ size: bigint }[]>(
        `SELECT pg_total_relation_size($1::regclass)::bigint AS size`,
        TOAST_TABLE,
      ),
    ]);
    const measured = tables.find((t) => t.name === TOAST_TABLE);
    const actual = Number(truth[0]?.size ?? 0);

    expect(measured).toBeDefined();
    expect(actual).toBeGreaterThan(8 * 1024 * 1024);
    // Within 5% of what the filesystem says. The old heap+index-only query
    // reported a few pages here — under 1% of the real size.
    expect(measured!.bytes).toBeGreaterThan(actual * 0.95);
    expect(measured!.bytes).toBeLessThan(actual * 1.05);
  });

  it("puts a hypertable's chunk bytes on the hypertable, not in the residual", async () => {
    if (!isTimescaleAvailable()) return; // plain-Postgres dev database
    const { sizing, tables } = await getTableSizes();
    expect(sizing).toBe("chunk-aware");

    const hypertables = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `SELECT table_name AS name FROM _timescaledb_catalog.hypertable WHERE schema_name = 'public'`,
    );
    const withChunks = tables.filter(
      (t) => hypertables.some((h) => h.name === t.name) && t.chunkCount > 0,
    );
    if (withChunks.length === 0) return; // no samples written yet on this database

    // A hypertable parent holds ~0 pages of its own, so any byte reported here
    // came from the chunk fold.
    for (const t of withChunks) expect(t.bytes).toBeGreaterThan(0);

    // Cross-check the largest against TimescaleDB's own accounting, which does
    // it the slow way (stat() per chunk) and sees compressed chunks too.
    const biggest = withChunks.reduce((a, b) => (a.bytes > b.bytes ? a : b));
    const truth = await prisma.$queryRawUnsafe<{ size: bigint }[]>(
      `SELECT hypertable_size(format('%I.%I', 'public', $1::text)::regclass)::bigint AS size`,
      biggest.name,
    );
    const actual = Number(truth[0]?.size ?? 0);
    expect(biggest.bytes).toBeGreaterThan(actual * 0.9);
    expect(biggest.bytes).toBeLessThan(actual * 1.1);
  });
});

/**
 * tests/unit/timescaleTables.test.ts
 *
 * Drift guards for the TimescaleDB-managed table inventory. The 2026-06
 * whole-app review found the SD-WAN sample tables written by
 * sampleRollupService and pruned by monitoringService but missing from
 * timescaleService's SAMPLE_TABLES / ROLLUP_TABLES — leaving them plain
 * Postgres tables (no hypertable conversion, no compression, seq-scanning
 * deleteMany pruning; the same failure family as the 2026-06-08 chunk-bloat
 * incident). These tests make that drift class mechanical: any sample-shaped
 * table referenced by the rollup writer, the prune layer, or declared in
 * prisma/schema.prisma must be in the managed inventory (or on the explicit
 * exemption list below).
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// timescaleService / sampleRetentionService import prisma at module load;
// stub it so importing the constants doesn't open a DB connection.
vi.mock("../../src/db.js", () => ({
  prisma: { setting: { findUnique: vi.fn(), upsert: vi.fn() } },
}));

import {
  SAMPLE_TABLES,
  ROLLUP_TABLES,
  STANDALONE_SAMPLE_TABLES,
  ALL_HYPERTABLE_CANDIDATES,
} from "../../src/services/timescaleService.js";
import { RETENTION_ENTITIES } from "../../src/services/sampleRetentionService.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Sample-shaped tables that intentionally are NOT Timescale-managed. Empty
 * today — asset_custom_widget_samples was the last holdout and is now a
 * STANDALONE_SAMPLE_TABLES hypertable. Add a name here only with a comment
 * justifying why it can't be a hypertable.
 */
const EXEMPT = new Set<string>([]);

/**
 * Managed hypertables deliberately left OUT of capacityService's steady-state
 * projection. Empty, and it should stay that way: a table in
 * ALL_HYPERTABLE_CANDIDATES holds sample data on a retention window, which is
 * exactly what the projection exists to forecast. Adding a name here means its
 * bytes sit in the projection's `baseBytes` term and are carried into the
 * steady-state figure unchanged, so justify it in a comment — "it's small" is
 * not a justification (asset_service_log_samples reached 13 GB on that
 * reasoning, 2026-09).
 */
const PROJECTION_EXEMPT = new Set<string>([]);

const managed = new Set<string>(ALL_HYPERTABLE_CANDIDATES);

/** Every double-quoted sample-table string literal in a source file. */
function tablesReferencedIn(relPath: string): string[] {
  const src = readFileSync(join(ROOT, relPath), "utf8");
  const re = /"(asset_[a-z_]+_samples(?:_hourly|_daily)?)"/g;
  const found = new Set<string>();
  for (const m of src.matchAll(re)) found.add(m[1]);
  return [...found].sort();
}

describe("timescaleService managed-table inventory", () => {
  it("covers one detail + hourly + daily table per retention entity, plus standalones", () => {
    // 7 retention entities × 3 tiers = 21 tiered hypertables, + the four
    // STANDALONE_SAMPLE_TABLES = 25 ALL_HYPERTABLE_CANDIDATES. A new tiered
    // sample stream must land in
    // SAMPLE_TABLES + ROLLUP_TABLES alongside its RETENTION_ENTITIES entry, or
    // this count diverges. Detail-only streams with no rollups live in
    // STANDALONE_SAMPLE_TABLES instead. (SD-WAN rules became a current-state
    // plain table — asset_sdwan_rules — and are NOT a managed hypertable.)
    expect(SAMPLE_TABLES.length).toBe(RETENTION_ENTITIES.length);
    expect(ROLLUP_TABLES.length).toBe(RETENTION_ENTITIES.length * 2);
    expect(ALL_HYPERTABLE_CANDIDATES.length).toBe(
      RETENTION_ENTITIES.length * 3 + STANDALONE_SAMPLE_TABLES.length,
    );
  });

  it("every table the rollup writer touches is Timescale-managed", () => {
    const referenced = tablesReferencedIn("src/services/sampleRollupService.ts");
    expect(referenced.length).toBeGreaterThan(0);
    const unmanaged = referenced.filter((t) => !managed.has(t) && !EXEMPT.has(t));
    expect(unmanaged).toEqual([]);
  });

  it("every hypertable name the prune layer passes to dropChunks is Timescale-managed", () => {
    const referenced = tablesReferencedIn("src/services/monitoringService.ts");
    expect(referenced.length).toBeGreaterThan(0);
    const unmanaged = referenced.filter((t) => !managed.has(t) && !EXEMPT.has(t));
    expect(unmanaged).toEqual([]);
  });

  it("capacityService projects EVERY managed hypertable, tiered and standalone", () => {
    // This is the guard that was missing when asset_service_log_samples was
    // added to STANDALONE_SAMPLE_TABLES (2026-09). capacityService keeps its own
    // per-table projection list, and projectSteadyStateSize() subtracts the
    // measured bytes of exactly that list from the database size before adding
    // the projection back — so a managed hypertable absent from it does not
    // merely go unprojected: its bytes stay inside `baseBytes` and ride into the
    // steady-state figure at face value. The card then tracks the live database
    // size instead of forecasting it, which is how a 13 GB table hid for a
    // release (89 GB database reporting a 71 GB "steady state").
    //
    // The old version of this test scoped itself to the TIERED tables and
    // rationalised the standalones as "small" — which is precisely the
    // assumption a log table breaks. It also matched any MENTION of a table
    // name anywhere in the file, so a name appearing only in a comment satisfied
    // it. Parse the actual list entries instead: `{ name: "asset_x", entity: ...`.
    const src = readFileSync(join(ROOT, "src", "services", "capacityService.ts"), "utf8");
    const re = /\{\s*name:\s*"(asset_[a-z_]+)"\s*,\s*entity:/g;
    const projected = new Set<string>();
    for (const m of src.matchAll(re)) projected.add(m[1]);
    expect(projected.size).toBeGreaterThan(0);

    const missing = [...managed].filter((t) => !projected.has(t) && !PROJECTION_EXEMPT.has(t)).sort();
    expect(missing).toEqual([]);

    const unmanaged = [...projected].filter((t) => !managed.has(t) && !EXEMPT.has(t)).sort();
    expect(unmanaged).toEqual([]);

    // DEFAULT_ROWS_PER_ASSET_PER_DAY is dereferenced without a fallback
    // (`DEFAULT_ROWS_PER_ASSET_PER_DAY[def.name](intervals)`), so a tiered table
    // missing from that map throws inside the capacity snapshot. The map uses
    // unquoted identifier keys, so match bare words.
    const tiered = new Set<string>([...SAMPLE_TABLES, ...ROLLUP_TABLES]);
    const rowsMapKeys = new Set<string>();
    for (const m of src.matchAll(/^\s{2}(asset_[a-z_]+):\s*\(/gm)) rowsMapKeys.add(m[1]);
    const noRowModel = [...tiered].filter((t) => !rowsMapKeys.has(t)).sort();
    expect(noRowModel).toEqual([]);
  });

  it("every sample-shaped table in prisma/schema.prisma is Timescale-managed or explicitly exempt", () => {
    const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
    const re = /@@map\("(asset_[a-z_]+_samples(?:_hourly|_daily)?)"\)/g;
    const declared = new Set<string>();
    for (const m of schema.matchAll(re)) declared.add(m[1]);
    expect(declared.size).toBeGreaterThanOrEqual(ALL_HYPERTABLE_CANDIDATES.length);

    const unmanaged = [...declared].filter((t) => !managed.has(t) && !EXEMPT.has(t)).sort();
    expect(unmanaged).toEqual([]);

    // Reverse direction: a typo'd name in SAMPLE_TABLES / ROLLUP_TABLES would
    // fail at runtime only as a logged-and-swallowed per-table error. Catch it
    // here instead — every managed name must exist in the schema.
    const phantom = [...managed].filter((t) => !declared.has(t)).sort();
    expect(phantom).toEqual([]);
  });
});

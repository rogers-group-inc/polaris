/**
 * tests/unit/capacitySteadyState.test.ts
 *
 * Guards the steady-state size projection against the 2026-06 capacity-card
 * bug, where it multiplied in a LIVE-MEASURED per-row size (relpages / pg_stat
 * tuples) that was wildly unreliable for compressed/bloated TimescaleDB
 * hypertables — producing phantom 14–218 TB steady-states that flip-flopped
 * between snapshots as autovacuum/ANALYZE churned the tuple estimates. The fix:
 * the projection uses the calibrated DEFAULT_BYTES_PER_ROW and ignores the
 * measured value, so it's a stable workload model.
 */

import { describe, it, expect, vi } from "vitest";

// capacityService imports prisma at module load; stub it so importing the pure
// projection helper doesn't open a DB connection.
vi.mock("../../src/db.js", () => ({
  prisma: { $queryRawUnsafe: vi.fn(), $queryRaw: vi.fn() },
  getDirectStatsPool: () => null,
}));

import {
  projectSteadyStateSize,
  measuredRateUsable,
  effectiveRetentionDays,
  prunesExpiredRows,
  footprintDaysAt,
  peakCombinedBytes,
  isStaleVacuumTable,
  AUTOVACUUM_BLOAT_DEAD_TUP_RATIO,
} from "../../src/services/capacityService.js";
import { defaultSampleRetention } from "../../src/services/sampleRetentionService.js";

const monitor = {
  intervalSeconds: 60,
  telemetryIntervalSeconds: 60,
  systemInfoIntervalSeconds: 600,
} as any;

// What the projection actually uses for a 7-day tier when no chunk interval is
// supplied: the configured 7 days plus one prune cadence (the prune runs every
// 24 h, so a cutoff is reached up to a day late). Chunk slack is 0 here, which
// is what a plain Postgres table gets.
const EFF7 = effectiveRetentionDays({ retentionDays: 7, chunkIntervalDays: 0 });

const baseArgs = {
  currentDbBytes: 50_000_000_000, // 50 GB
  monitoredCount: 2000,
  telemetryEligibleCount: 2000,
  systemInfoEligibleCount: 2000,
  monitor,
  retention: defaultSampleRetention(),
};

// One real source table name + one rollup, with a SANE measured per-row size.
const saneTables = [
  { name: "asset_monitor_samples",        rows: 1000, bytes: 1_000_000, avgBytesPerRow: 310, deadTupRatio: 0, lastAutovacuum: null },
  { name: "asset_monitor_samples_hourly", rows: 1000, bytes: 1_000_000, avgBytesPerRow: 280, deadTupRatio: 0, lastAutovacuum: null },
];

// Same tables, but with the absurd measured per-row size the bug fed in
// (≈176 kB/row was observed in prod).
const absurdTables = saneTables.map((t) => ({ ...t, avgBytesPerRow: 200_000 }));

describe("projectSteadyStateSize — stable against measured per-row noise", () => {
  it("ignores the live-measured avgBytesPerRow entirely", () => {
    const sane = projectSteadyStateSize({ ...baseArgs, sampleTables: saneTables });
    const absurd = projectSteadyStateSize({ ...baseArgs, sampleTables: absurdTables });
    expect(absurd).toBe(sane);
  });

  it("projects a bounded, plausible steady-state (not TB-scale) for a 2000-asset fleet", () => {
    const projected = projectSteadyStateSize({ ...baseArgs, sampleTables: saneTables });
    // Must exceed the non-sample base but stay far below the absurd TB-scale
    // numbers the bug produced. With only 2 tables modeled here it's modest;
    // the ceiling is a sanity bound, not a tight assertion.
    expect(projected).toBeGreaterThan(baseArgs.currentDbBytes - 1_000_000); // ~base, minus subtracted sample bytes
    expect(projected).toBeLessThan(2_000_000_000_000); // < 2 TB — was 218 TB
  });

  it("uses the calibrated default for the per-row size (formula lock)", () => {
    // asset_monitor_samples: countKey "all" → monitoredCount; rate 86400/60;
    // retention detail 7d; default 310 bytes/row.
    const onlyDetail = [saneTables[0]];
    const projected = projectSteadyStateSize({ ...baseArgs, sampleTables: onlyDetail });
    const rowsPerDay = 86400 / 60;
    const expectedSample = 2000 * rowsPerDay * EFF7 * 310;
    const base = baseArgs.currentDbBytes - onlyDetail[0].bytes;
    expect(projected).toBe(base + expectedSample);
  });

  it("returns current size unchanged when nothing is monitored", () => {
    const projected = projectSteadyStateSize({ ...baseArgs, monitoredCount: 0, sampleTables: saneTables });
    expect(projected).toBe(baseArgs.currentDbBytes);
  });
});

describe("measuredRateUsable — when the measured daily rate may be trusted", () => {
  const DAILY = 12_000_000_000;

  it("is usable when retention ≤ compress-after (tier never compresses)", () => {
    expect(measuredRateUsable({ measuredDailyBytes: DAILY, configuredRetentionDays: 7, compressAfterDays: 7 })).toBe(true);
  });

  it("is usable when compression is disabled (compressAfter 0)", () => {
    expect(measuredRateUsable({ measuredDailyBytes: DAILY, configuredRetentionDays: 30, compressAfterDays: 0 })).toBe(true);
  });

  it("is NOT usable when retention reaches PAST the compress frontier", () => {
    // retention 7 > compress 3 → part of the data is compressed; the
    // uncompressed daily rate would over-project.
    expect(measuredRateUsable({ measuredDailyBytes: DAILY, configuredRetentionDays: 7, compressAfterDays: 3 })).toBe(false);
  });

  it("is NOT usable without a measurement (null / zero)", () => {
    expect(measuredRateUsable({ measuredDailyBytes: null, configuredRetentionDays: 7, compressAfterDays: 7 })).toBe(false);
    expect(measuredRateUsable({ measuredDailyBytes: 0, configuredRetentionDays: 7, compressAfterDays: 7 })).toBe(false);
  });

  // The gate reads the CONFIGURED window; chunk slack must not reach it. Gating
  // on the widened number would kick every 7d/7d detail table onto the
  // workload fallback — silently undoing the measured-rate path on the largest
  // tables in the database.
  it("keeps a 7d/7d detail table on the measured path at projection level", () => {
    const DAILY_M = 1_000_000_000;
    const table = [{ name: "asset_monitor_samples", rows: 1000, bytes: 5_000_000_000, avgBytesPerRow: 310, deadTupRatio: 0, lastAutovacuum: null }];
    const projected = projectSteadyStateSize({
      ...baseArgs,
      sampleTables: table,
      measuredDetailDailyBytes: { asset_monitor_samples: DAILY_M },
      compressAfterByTable: { asset_monitor_samples: 7 },
      chunkIntervalByTable: { asset_monitor_samples: 7 },
    });
    expect(projected).toBe(baseArgs.currentDbBytes - 5_000_000_000 + DAILY_M * 15);
  });
});

/**
 * The 2026-09 prod finding: the Maintenance card's steady-state figure sat
 * ~18 GB BELOW the live database size and tracked it, instead of forecasting.
 * Two independent causes, one test group each.
 */
describe("effectiveRetentionDays — drop_chunks granularity slack", () => {
  it("adds the chunk interval and the prune cadence to the configured window", () => {
    // asset_monitor_samples on prod: 7d retention, TimescaleDB's default 7d
    // chunk interval → 12.58 days of data were actually on disk.
    expect(effectiveRetentionDays({ retentionDays: 7, chunkIntervalDays: 7, pruneCadenceDays: 1 })).toBe(15);
  });

  it("gives a plain (non-hypertable) table only the prune cadence", () => {
    expect(effectiveRetentionDays({ retentionDays: 7, chunkIntervalDays: 0, pruneCadenceDays: 1 })).toBe(8);
  });

  it("is the DROP-ONLY bound, which a short tier on long chunks does not follow", () => {
    // 3d retention on 7d chunks would keep up to 11 days IF only drop_chunks
    // pruned it. It doesn't — its prune row-deletes the uncompressed residue —
    // so the projection models it with footprintDaysAt, not this bound.
    expect(effectiveRetentionDays({ retentionDays: 3, chunkIntervalDays: 7, pruneCadenceDays: 1 })).toBe(11);
    expect(prunesExpiredRows({ entity: "hardware", tier: "detail", retentionDays: 3, compressAfterDays: 7 })).toBe(true);
  });

  it("returns 0 for a tier that is off (0) or FOREVER (-1)", () => {
    expect(effectiveRetentionDays({ retentionDays: 0, chunkIntervalDays: 7 })).toBe(0);
    expect(effectiveRetentionDays({ retentionDays: -1, chunkIntervalDays: 7 })).toBe(0);
  });

  it("never projects below what is already on disk for a table past its window", () => {
    // The regression in one assertion: a table holding 12.58 days of data at a
    // measured rate D, with 7d retention on 7d chunks, must not forecast 7×D.
    const DAILY = 1_200_000_000;
    const onDiskBytes = Math.round(DAILY * 12.58);
    const table = [{ name: "asset_monitor_samples", rows: 1000, bytes: onDiskBytes, avgBytesPerRow: 310, deadTupRatio: 0, lastAutovacuum: null }];
    const projected = projectSteadyStateSize({
      ...baseArgs,
      sampleTables: table,
      measuredDetailDailyBytes: { asset_monitor_samples: DAILY },
      compressAfterByTable: { asset_monitor_samples: 7 },
      chunkIntervalByTable: { asset_monitor_samples: 7 },
    });
    const base = baseArgs.currentDbBytes - onDiskBytes;
    expect(projected).toBe(base + DAILY * 15);
    // And the part that was visibly wrong on the card: the sample projection
    // exceeds the bytes the table already holds.
    expect(projected - base).toBeGreaterThan(onDiskBytes);
  });
});

describe("projectSteadyStateSize — standalone hypertables (countKey null)", () => {
  // asset_service_log_samples was 13 GB of an 89 GB prod database and had no
  // projection entry at all, so its bytes stayed in baseBytes and every byte it
  // grew raised the steady-state figure 1:1.
  const logTable = [
    { name: "asset_service_log_samples", rows: 5000, bytes: 13_000_000_000, avgBytesPerRow: 300, deadTupRatio: 0, lastAutovacuum: null },
  ];

  it("projects a standalone table from its measured daily rate × effective retention", () => {
    const DAILY = 1_000_000_000;
    const projected = projectSteadyStateSize({
      ...baseArgs,
      sampleTables: logTable,
      measuredDetailDailyBytes: { asset_service_log_samples: DAILY },
      compressAfterByTable: { asset_service_log_samples: 7 },
      chunkIntervalByTable: { asset_service_log_samples: 7 },
    });
    // process.detail default is 7d; + 7d chunk + 1d prune = 15d.
    const base = baseArgs.currentDbBytes - 13_000_000_000;
    expect(projected).toBe(base + DAILY * 15);
  });

  it("leaves a standalone table at its current size when it cannot be measured", () => {
    // Neutral, not zero and not a guess: the fallback cancels the same table's
    // contribution to sampleBytesNow, so an unmeasurable table neither inflates
    // nor deflates the forecast.
    const projected = projectSteadyStateSize({ ...baseArgs, sampleTables: logTable });
    expect(projected).toBe(baseArgs.currentDbBytes);
  });

  it("has no per-asset row model, so fleet size does not move it", () => {
    const small = projectSteadyStateSize({ ...baseArgs, monitoredCount: 100, telemetryEligibleCount: 100, systemInfoEligibleCount: 100, sampleTables: logTable });
    const large = projectSteadyStateSize({ ...baseArgs, sampleTables: logTable });
    expect(small).toBe(large);
  });
});

describe("projectSteadyStateSize — measured detail daily rate", () => {
  // One interface-detail table; default interfaces.detail retention is 7d.
  const ifaceTable = [
    { name: "asset_interface_samples", rows: 1000, bytes: 2_000_000, avgBytesPerRow: 395, deadTupRatio: 0, lastAutovacuum: null },
  ];

  it("projects measured uncompressed daily bytes × full retention (not the 24h-capped workload guess)", () => {
    const projected = projectSteadyStateSize({
      ...baseArgs,
      sampleTables: ifaceTable,
      measuredDetailDailyBytes: { asset_interface_samples: 12_000_000_000 },
      compressAfterByTable: { asset_interface_samples: 7 },
      chunkIntervalByTable: { asset_interface_samples: 1 },
    });
    const base = baseArgs.currentDbBytes - 2_000_000;
    // 7d configured + 1d chunk interval + 1d prune cadence = 9 days on disk.
    expect(projected).toBe(base + 12_000_000_000 * 9);
  });

  // Post pinned-only cutover: interface detail carries PINNED rows only, so it
  // keeps FULL retention (no unselected bulk to cap at 24h), and the row rate
  // is driven by pinned count across BOTH cadences — the full system-info pass
  // and the fast pinned re-walk.
  it("without a measurement, uses the pinned-count workload model at full retention", () => {
    const projected = projectSteadyStateSize({ ...baseArgs, sampleTables: ifaceTable });
    const base = baseArgs.currentDbBytes - 2_000_000;
    // No pinnedInterfaceCount supplied → conservative default of 2/asset.
    // rowsPerAssetPerDay = (86400/600 + 86400/60) * 2 = (144 + 1440) * 2 = 3168
    // interfaces.detail retention = 7d; 395 B/row.
    const fallback = 2000 * 3168 * EFF7 * 395;
    expect(projected).toBe(base + fallback);
  });

  it("scales interface detail with the fleet's actual pinned-interface count", () => {
    // 2000 assets, 20 000 pinned interfaces → 10 per asset, i.e. 5× the default.
    const projected = projectSteadyStateSize({
      ...baseArgs,
      sampleTables: ifaceTable,
      pinnedInterfaceCount: 20_000,
    });
    const base = baseArgs.currentDbBytes - 2_000_000;
    const fallback = 2000 * ((86400 / 600 + 86400 / 60) * 10) * EFF7 * 395;
    expect(projected).toBe(base + fallback);
  });

  // The whole point of the cutover: pinning fewer interfaces must project less
  // disk. Before it, every interface was sampled regardless, so the forecast
  // was insensitive to what operators actually pinned.
  it("projects strictly less disk when fewer interfaces are pinned", () => {
    const few = projectSteadyStateSize({ ...baseArgs, sampleTables: ifaceTable, pinnedInterfaceCount: 2_000 });
    const many = projectSteadyStateSize({ ...baseArgs, sampleTables: ifaceTable, pinnedInterfaceCount: 40_000 });
    expect(few).toBeLessThan(many);
  });
});

describe("isStaleVacuumTable — Critical autovacuum_stale gating", () => {
  const NOW = Date.parse("2026-06-25T12:00:00Z");
  const EIGHT_DAYS_AGO = new Date(NOW - 8 * 86400 * 1000).toISOString();
  const ONE_DAY_AGO = new Date(NOW - 1 * 86400 * 1000).toISOString();
  const BLOATED = AUTOVACUUM_BLOAT_DEAD_TUP_RATIO + 0.05;

  const table = (over: Partial<any> = {}) => ({
    name: "asset_interface_samples_daily",
    rows: 5000,
    bytes: 5_000_000,
    avgBytesPerRow: 300,
    deadTupRatio: BLOATED,
    lastAutovacuum: EIGHT_DAYS_AGO,
    ...over,
  });

  it("fires when a populated plain table is bloated AND >7d stale", () => {
    expect(isStaleVacuumTable(table(), false, NOW)).toBe(true);
  });

  it("does NOT fire on a low-churn table with negligible dead tuples (the small-instance false positive)", () => {
    // The reported case: asset_interface_samples_daily on a 6-asset, non-Timescale
    // install — vacuumed once long ago, almost no dead tuples since.
    expect(isStaleVacuumTable(table({ deadTupRatio: 0 }), false, NOW)).toBe(false);
    expect(isStaleVacuumTable(table({ deadTupRatio: 0.05 }), false, NOW)).toBe(false);
  });

  it("does NOT fire when bloated but recently autovacuumed (that is amber lag, not critical)", () => {
    expect(isStaleVacuumTable(table({ lastAutovacuum: ONE_DAY_AGO }), false, NOW)).toBe(false);
  });

  it("exempts TimescaleDB hypertables regardless of staleness/bloat", () => {
    expect(isStaleVacuumTable(table(), true, NOW)).toBe(false);
  });

  it("does NOT fire when never autovacuumed (null) or barely populated", () => {
    expect(isStaleVacuumTable(table({ lastAutovacuum: null }), false, NOW)).toBe(false);
    expect(isStaleVacuumTable(table({ rows: 1000 }), false, NOW)).toBe(false);
  });
});

describe("prunesExpiredRows — mirrors the prune layer", () => {
  it("row-deletes when the cutoff is newer than the compression frontier", () => {
    expect(prunesExpiredRows({ entity: "hardware", tier: "detail", retentionDays: 3, compressAfterDays: 7 })).toBe(true);
  });

  it("leaves a tier at or past the frontier to drop_chunks", () => {
    expect(prunesExpiredRows({ entity: "assets", tier: "detail", retentionDays: 7, compressAfterDays: 7 })).toBe(false);
    expect(prunesExpiredRows({ entity: "assets", tier: "hourly", retentionDays: 30, compressAfterDays: 7 })).toBe(false);
  });

  it("row-deletes everything when compression is off", () => {
    expect(prunesExpiredRows({ entity: "assets", tier: "detail", retentionDays: 7, compressAfterDays: 0 })).toBe(true);
  });

  it("always row-deletes a selection-aware DETAIL tier (fast rows), but not its rollups", () => {
    expect(prunesExpiredRows({ entity: "interfaces", tier: "detail", retentionDays: 30, compressAfterDays: 7 })).toBe(true);
    expect(prunesExpiredRows({ entity: "interfaces", tier: "hourly", retentionDays: 30, compressAfterDays: 7 })).toBe(false);
  });
});

describe("footprintDaysAt — one table's sawtooth over the chunk cycle", () => {
  const P = 1;
  const EPS = 1e-6;

  it("drop-only 7d on 7d chunks swings between 7 and 15 days", () => {
    const f = { dailyBytes: 1, retentionDays: 7, chunkIntervalDays: 7, rowDelete: false };
    // The oldest chunk drops 1 day into each cycle (range_end + 7 + 1).
    expect(footprintDaysAt(f, 7 + 1 - EPS, P)).toBeCloseTo(15, 4);
    expect(footprintDaysAt(f, 7 + 1, P, true)).toBe(15); // exact left limit
    expect(footprintDaysAt(f, 7 + 1, P)).toBeCloseTo(8, 4);
    expect(footprintDaysAt(f, 7 + 7 - EPS, P)).toBeCloseTo(14, 4);
  });

  it("row-deleting 3d on 7d chunks caps each chunk at 4 days and peaks at 8", () => {
    const f = { dailyBytes: 1, retentionDays: 3, chunkIntervalDays: 7, rowDelete: true };
    // Previous chunk (capped at 4) drops 4 days into the cycle; the current
    // one has grown to 4 by then.
    expect(footprintDaysAt(f, 7 + 4 - EPS, P)).toBeCloseTo(8, 4);
    expect(footprintDaysAt(f, 7 + 4, P)).toBeCloseTo(4, 4);
    expect(footprintDaysAt(f, 7 + 6.5, P)).toBeCloseTo(4, 4);
  });

  it("gives a plain table a flat retention + prune", () => {
    const f = { dailyBytes: 1, retentionDays: 7, chunkIntervalDays: 0, rowDelete: true };
    expect(footprintDaysAt(f, 3.3, P)).toBe(8);
  });
});

describe("peakCombinedBytes — the largest simultaneous total", () => {
  const GB = 1_000_000_000;

  it("equals a lone table's own peak", () => {
    expect(peakCombinedBytes([{ dailyBytes: GB, retentionDays: 7, chunkIntervalDays: 7, rowDelete: false }], 1)).toBeCloseTo(15 * GB, -3);
    expect(peakCombinedBytes([{ dailyBytes: GB, retentionDays: 7, chunkIntervalDays: 1, rowDelete: true }], 1)).toBeCloseTo(9 * GB, -3);
  });

  it("does not add peaks that land on different days of the cycle", () => {
    // 7d drop-only peaks at φ=1 (15 + the 3d table's 5); the 3d row-delete
    // table peaks at φ=4 (8 + the 7d table's 11). Max 20, not 15 + 8 = 23.
    const peak = peakCombinedBytes([
      { dailyBytes: GB, retentionDays: 7, chunkIntervalDays: 7, rowDelete: false },
      { dailyBytes: GB, retentionDays: 3, chunkIntervalDays: 7, rowDelete: true },
    ], 1);
    expect(peak).toBeCloseTo(20 * GB, -3);
  });

  it("does add peaks that coincide", () => {
    const f = { dailyBytes: GB, retentionDays: 7, chunkIntervalDays: 7, rowDelete: false };
    expect(peakCombinedBytes([f, f, f], 1)).toBeCloseTo(45 * GB, -3);
  });

  it("returns 0 for nothing, and ignores OFF tiers", () => {
    expect(peakCombinedBytes([], 1)).toBe(0);
    expect(peakCombinedBytes([{ dailyBytes: GB, retentionDays: 0, chunkIntervalDays: 7, rowDelete: false }], 1)).toBe(0);
  });
});

/**
 * The 2026-09 over-projection: prod read a 145 GB steady state for a database
 * that never passed ~110 GB. Rates below are the prod card's (2026-09-28),
 * derived from table size ÷ days held. The old model summed per-table peaks
 * and gave the 3d hardware table 11 days.
 */
describe("projectSteadyStateSize — prod-shaped mixed retentions", () => {
  const GB = 1_000_000_000;
  const rates: Record<string, number> = {
    asset_monitor_samples:          1.20 * GB, // 7d, drop-only
    asset_telemetry_samples:        0.46 * GB, // 7d, drop-only
    asset_service_log_samples:      1.34 * GB, // 7d, drop-only
    asset_perf_sla_samples:         0.65 * GB, // 7d, drop-only
    asset_hardware_sensor_samples:  3.85 * GB, // 3d on 7d chunks, row-delete
    asset_interface_samples:        5.60 * GB, // 3d on 1d chunks, row-delete
  };
  const retention = defaultSampleRetention();
  retention.hardware.detail = 3;
  retention.interfaces.detail = 3;
  const names = Object.keys(rates);
  const tables = names.map((name) => ({ name, rows: 1000, bytes: 10 * GB, avgBytesPerRow: 300, deadTupRatio: 0, lastAutovacuum: null }));
  const args = {
    ...baseArgs,
    currentDbBytes: 72 * GB, // 60 GB of these tables + 12 GB everything else
    retention,
    sampleTables: tables,
    measuredDetailDailyBytes: rates,
    compressAfterByTable: Object.fromEntries(names.map((n) => [n, 7])),
    chunkIntervalByTable: Object.fromEntries(names.map((n) => [n, n === "asset_interface_samples" ? 1 : 7])),
  };

  it("projects the joint peak, not the sum of each table's own peak", () => {
    const a = (1.20 + 0.46 + 1.34 + 0.65) * GB;
    const hw = 3.85 * GB;
    const ifc = 5.60 * GB;
    // φ=1: 7d tables at 15, hardware at 5, interfaces at 5.
    // φ=4: 7d tables at 11, hardware at 8, interfaces at 5.
    const expected = 12 * GB + Math.max(15 * a + 5 * hw + 5 * ifc, 11 * a + 8 * hw + 5 * ifc);
    expect(projectSteadyStateSize(args)).toBeCloseTo(expected, -4);
    // The old model: every table at its own peak, hardware at 11 days.
    const old = 12 * GB + 15 * a + 11 * hw + 5 * ifc;
    expect(old - projectSteadyStateSize(args)).toBeGreaterThan(20 * GB);
  });

  it("measured tables project the same at 100 and 2000 assets", () => {
    const small = projectSteadyStateSize({ ...args, monitoredCount: 100, telemetryEligibleCount: 100, systemInfoEligibleCount: 100 });
    expect(small).toBeCloseTo(projectSteadyStateSize(args), -4);
  });
});

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
  projectDetailBytes,
  effectiveRetentionDays,
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

describe("projectDetailBytes — measured daily rate vs fallback", () => {
  const FALLBACK = 2_270_000_000;
  const DAILY = 12_000_000_000;

  it("uses measured daily × retention when retention ≤ compress-after (tier never compresses)", () => {
    expect(projectDetailBytes({ measuredDailyBytes: DAILY, retentionDays: 7, compressAfterDays: 7, fallbackBytes: FALLBACK }))
      .toBe(DAILY * 7);
  });

  it("uses measured when compression is disabled (compressAfter 0)", () => {
    expect(projectDetailBytes({ measuredDailyBytes: DAILY, retentionDays: 30, compressAfterDays: 0, fallbackBytes: FALLBACK }))
      .toBe(DAILY * 30);
  });

  it("falls back when retention reaches PAST the compress frontier", () => {
    // retention 7 > compress 3 → part of the data is compressed; the
    // uncompressed daily rate would over-project, so use the fallback.
    expect(projectDetailBytes({ measuredDailyBytes: DAILY, retentionDays: 7, compressAfterDays: 3, fallbackBytes: FALLBACK }))
      .toBe(FALLBACK);
  });

  // The gate reads the CONFIGURED window; the multiplier is the effective one.
  // Both the compression policy and the retention policy fire off a chunk's
  // range_end, so chunk slack changes how long data sits on disk but not which
  // policy reaches the chunk first. Gating on the widened number instead would
  // kick every 7d/7d detail table onto the workload fallback — silently undoing
  // the measured-rate path on the largest tables in the database.
  it("gates on the configured window while multiplying by the effective one", () => {
    expect(projectDetailBytes({
      measuredDailyBytes: DAILY,
      retentionDays: 15,          // 7 configured + 7 chunk + 1 prune
      configuredRetentionDays: 7, // still dropped before compression reaches it
      compressAfterDays: 7,
      fallbackBytes: FALLBACK,
    })).toBe(DAILY * 15);
  });

  it("falls back when there is no measurement (null / zero)", () => {
    expect(projectDetailBytes({ measuredDailyBytes: null, retentionDays: 7, compressAfterDays: 7, fallbackBytes: FALLBACK })).toBe(FALLBACK);
    expect(projectDetailBytes({ measuredDailyBytes: 0, retentionDays: 7, compressAfterDays: 7, fallbackBytes: FALLBACK })).toBe(FALLBACK);
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

  it("is worst for a table whose retention is SHORTER than its chunk interval", () => {
    // asset_hardware_sensor_samples on prod: 3d retention, 7d chunks → keeps
    // up to 11 days, i.e. 3.7x the configured window.
    expect(effectiveRetentionDays({ retentionDays: 3, chunkIntervalDays: 7, pruneCadenceDays: 1 })).toBe(11);
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

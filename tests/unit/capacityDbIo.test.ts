/**
 * tests/unit/capacityDbIo.test.ts
 *
 * Coverage for the pure disk-read-pressure rate math in capacityDbIo.ts — the
 * replacement for the old size-based `ram_insufficient` heuristic. No DB; the
 * function is fed synthetic pg_stat_database readings.
 */

import { describe, it, expect } from "vitest";
import {
  deriveDbIoVerdict,
  MIN_IO_WINDOW_MS,
  DB_IO_WATCH_BACKENDS,
  DB_IO_WARNING_BACKENDS,
  DB_IO_BOOT_GRACE_MS,
  DB_IO_LOW_AVAILABLE_RATIO,
  ioWindowInBootGrace,
  dbIoPressureAdvice,
  type DbIoReading,
} from "../../src/services/capacityDbIo.js";

function reading(over: Partial<DbIoReading> = {}): DbIoReading {
  return {
    nowMs: 1_000_000,
    blksRead: 1000,
    blksHit: 100_000,
    blkReadTime: 5000,
    trackIoTiming: true,
    ...over,
  };
}

describe("deriveDbIoVerdict", () => {
  it("returns unmeasured when there is no previous reading (first call)", () => {
    const v = deriveDbIoVerdict(null, reading());
    expect(v.measured).toBe(false);
    expect(v.avgBackendsBlockedOnDisk).toBeNull();
    expect(v.windowSeconds).toBeNull();
  });

  it("returns unmeasured when the window is shorter than the minimum", () => {
    const prev = reading({ nowMs: 0, blkReadTime: 0 });
    const cur = reading({ nowMs: MIN_IO_WINDOW_MS - 1, blkReadTime: 999_999 });
    expect(deriveDbIoVerdict(prev, cur).measured).toBe(false);
  });

  it("returns unmeasured on a counter reset (any counter goes backwards)", () => {
    const prev = reading({ nowMs: 0, blksRead: 5000, blksHit: 500_000, blkReadTime: 9000 });
    // 60s later but blk_read_time dropped — pg_stat_reset / crash recovery.
    const cur = reading({ nowMs: 60_000, blksRead: 10, blksHit: 10, blkReadTime: 1 });
    expect(deriveDbIoVerdict(prev, cur).measured).toBe(false);
  });

  it("computes avgBackendsBlockedOnDisk = Δblk_read_time / Δelapsed over the window", () => {
    // 600s window, +300_000ms of read time => 0.5 backends continuously blocked.
    const prev = reading({ nowMs: 0, blkReadTime: 0 });
    const cur = reading({ nowMs: 600_000, blkReadTime: 300_000 });
    const v = deriveDbIoVerdict(prev, cur);
    expect(v.measured).toBe(true);
    expect(v.avgBackendsBlockedOnDisk).toBeCloseTo(0.5, 6);
    expect(v.windowSeconds).toBe(600);
  });

  it("reports ~0 read-wait when storage is fast / served from cache (NVMe-like)", () => {
    // Same 600s window, only 60ms of read time across all backends.
    const prev = reading({ nowMs: 0, blkReadTime: 1000 });
    const cur = reading({ nowMs: 600_000, blkReadTime: 1060 });
    const v = deriveDbIoVerdict(prev, cur);
    expect(v.measured).toBe(true);
    expect(v.avgBackendsBlockedOnDisk!).toBeLessThan(DB_IO_WATCH_BACKENDS);
  });

  it("crosses the watch and warning thresholds as read-wait climbs", () => {
    const prev = reading({ nowMs: 0, blkReadTime: 0 });
    // 100s window. 0.5 → watch boundary; 2.0 → warning boundary.
    const atWatch = deriveDbIoVerdict(prev, reading({ nowMs: 100_000, blkReadTime: 0.5 * 100_000 }));
    const atWarning = deriveDbIoVerdict(prev, reading({ nowMs: 100_000, blkReadTime: 2.0 * 100_000 }));
    expect(atWatch.avgBackendsBlockedOnDisk).toBeCloseTo(DB_IO_WATCH_BACKENDS, 6);
    expect(atWarning.avgBackendsBlockedOnDisk).toBeCloseTo(DB_IO_WARNING_BACKENDS, 6);
  });
});

describe("ioWindowInBootGrace", () => {
  it("drops a window that started during startup maintenance", () => {
    // 1 min window ending 2 min after boot — the prod 2026-10-15 shape.
    expect(ioWindowInBootGrace(2 * 60_000, 60)).toBe(true);
  });

  it("drops a window that began just inside the grace even when it ends well after", () => {
    expect(ioWindowInBootGrace(DB_IO_BOOT_GRACE_MS + 5 * 60_000, 6 * 60)).toBe(true);
  });

  it("keeps a window that started at or after the grace boundary", () => {
    expect(ioWindowInBootGrace(DB_IO_BOOT_GRACE_MS + 10 * 60_000, 10 * 60)).toBe(false);
    expect(ioWindowInBootGrace(24 * 3_600_000, 10 * 60)).toBe(false);
  });
});

describe("dbIoPressureAdvice", () => {
  const GB = 1024 ** 3;
  const base = {
    avgBackendsBlockedOnDisk: 0.7,
    windowSeconds: 600,
    databaseBytes: 104 * GB,
    totalMemoryBytes: 62 * GB,
    availableMemoryBytes: 37 * GB,
    dbColocated: true,
    formatBytes: (n: number) => `${Math.round(n / GB)} GB`,
  };

  it("does not recommend RAM when plenty is available, and says so", () => {
    const a = dbIoPressureAdvice(base);
    expect(a.suggestion).not.toMatch(/adding RAM/i);
    expect(a.suggestion).toMatch(/RAM isn't the constraint — 37 GB of 62 GB is available/);
    expect(a.message).toMatch(/host RAM 62 GB, 37 GB available, database 104 GB/);
    expect(a.message).toMatch(/over the last 10 min/);
  });

  it("recommends RAM when available memory is below the low-available ratio", () => {
    const a = dbIoPressureAdvice({ ...base, availableMemoryBytes: 62 * GB * (DB_IO_LOW_AVAILABLE_RATIO - 0.01) });
    expect(a.suggestion).toMatch(/^Consider adding RAM/);
  });

  it("treats exactly the ratio as not low", () => {
    const a = dbIoPressureAdvice({ ...base, availableMemoryBytes: 62 * GB * DB_IO_LOW_AVAILABLE_RATIO });
    expect(a.suggestion).not.toMatch(/adding RAM/i);
  });

  it("with a remote database, points at the database host instead of this host's memory", () => {
    const a = dbIoPressureAdvice({ ...base, dbColocated: false, availableMemoryBytes: 1 * GB });
    expect(a.message).toMatch(/database on a separate host/);
    expect(a.message).not.toMatch(/available/);
    expect(a.suggestion).toMatch(/can't see the database host's memory/);
    expect(a.suggestion).not.toMatch(/^Consider adding RAM/);
  });

  it("omits the window text for a sub-minute or unknown window", () => {
    expect(dbIoPressureAdvice({ ...base, windowSeconds: 20 }).message).not.toMatch(/over the last/);
    expect(dbIoPressureAdvice({ ...base, windowSeconds: null }).message).not.toMatch(/over the last/);
  });
});

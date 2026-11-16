/**
 * tests/unit/memoryForecastService.test.ts — own unit suite (CQ-T010) for
 * src/services/memoryForecastService.ts.
 *
 * No real database: the two raw queries are checked by their TEXT and their
 * positional parameters, and the JS tails (row mapping, reboot handling, the
 * pure fit and level helpers) are driven with synthetic fit rows.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import {
  computeMemoryForecast,
  computeMemoryForecastDetail,
  computeMemoryProjection,
  forecastLevelReading,
  loadMemoryForecastSeries,
  memoryForecastFromDailyPoints,
  nextForecastLevel,
  projectMemoryPct,
  MEMORY_FORECAST_MAX_DAYS,
  MEMORY_FORECAST_MIN_POINTS,
} from "../../src/services/memoryForecastService.js";
import type { ForecastLevel } from "../../src/services/notificationTypes.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const DAY = 86_400_000;
const raw = () => stubbed(prisma.$queryRawUnsafe);
const sqlOf = (call = 0): string => String(raw().mock.calls[call]![0]);
const series = (n: number, start: number, slope: number) =>
  Array.from({ length: n }, (_, i) => ({ t: (20_000 + i) * DAY, v: start + slope * i }));

const lvl = (threshold: number, severity: string, strict = false): ForecastLevel => ({ threshold, severity, strict });

beforeEach(() => resetDbStub());

describe("constants", () => {
  it("match the storage forecast's 7 points / 365 days", () => {
    expect(MEMORY_FORECAST_MIN_POINTS).toBe(7);
    expect(MEMORY_FORECAST_MAX_DAYS).toBe(365);
  });
});

describe("projectMemoryPct", () => {
  it("adds slope × horizon to the newest day, rounded to 0.1", () => {
    expect(projectMemoryPct(50, 1.234, 10)).toBe(62.3);
  });

  it("caps at 100", () => {
    expect(projectMemoryPct(90, 5, 30)).toBe(100);
  });

  it("is null for a flat or shrinking trend", () => {
    expect(projectMemoryPct(50, 0, 30)).toBeNull();
    expect(projectMemoryPct(50, -1, 30)).toBeNull();
  });

  it("is null for non-finite inputs", () => {
    expect(projectMemoryPct(Number.NaN, 1, 30)).toBeNull();
    expect(projectMemoryPct(50, Number.POSITIVE_INFINITY, 30)).toBeNull();
  });

  it("floors a negative used % and a negative horizon at 0", () => {
    expect(projectMemoryPct(-5, 1, 10)).toBe(10);
    expect(projectMemoryPct(40, 1, -10)).toBe(40);
  });
});

describe("nextForecastLevel", () => {
  const levels = [lvl(95, "critical"), lvl(85, "serious"), lvl(70, "warning")];

  it("picks the lowest level not yet reached, whatever the input order", () => {
    expect(nextForecastLevel(50, levels)?.severity).toBe("warning");
    expect(nextForecastLevel(75, levels)?.severity).toBe("serious");
    expect(nextForecastLevel(90, levels)?.severity).toBe("critical");
  });

  it("is null once every level is passed, and for no levels", () => {
    expect(nextForecastLevel(99, levels)).toBeNull();
    expect(nextForecastLevel(50, [])).toBeNull();
  });

  it("honours each level's own comparison at its threshold", () => {
    // >= 85 is reached AT 85; > 85 is not.
    expect(nextForecastLevel(85, [lvl(85, "serious"), lvl(95, "critical")])?.severity).toBe("critical");
    expect(nextForecastLevel(85, [lvl(85, "serious", true), lvl(95, "critical")])?.severity).toBe("serious");
  });

  it("does not reorder the caller's array", () => {
    const input = [lvl(95, "critical"), lvl(85, "serious")];
    nextForecastLevel(50, input);
    expect(input.map((l) => l.threshold)).toEqual([95, 85]);
  });
});

describe("forecastLevelReading", () => {
  const levels = [lvl(85, "serious"), lvl(95, "critical")];

  it("is null when memory is not growing", () => {
    expect(forecastLevelReading(80, 0, 14, levels)).toBeNull();
    expect(forecastLevelReading(80, -1, 14, levels)).toBeNull();
  });

  it("is null when every level is already passed", () => {
    expect(forecastLevelReading(97, 1, 14, levels)).toBeNull();
  });

  it("is null when the next level is out of reach inside the horizon", () => {
    // 60 + 0.5 × 14 = 67 < 85.
    expect(forecastLevelReading(60, 0.5, 14, levels)).toBeNull();
  });

  it("returns the projection when it reaches the next level but not the one after", () => {
    // 80 + 0.5 × 14 = 87.
    expect(forecastLevelReading(80, 0.5, 14, levels)).toBe(87);
  });

  it("caps just below a >= following level so the next level stays the most severe met", () => {
    // 80 + 2 × 14 → 100, capped at 95 - 0.001.
    expect(forecastLevelReading(80, 2, 14, levels)).toBeCloseTo(94.999, 6);
  });

  it("caps AT a strict (>) following level, which is not met there", () => {
    expect(forecastLevelReading(80, 2, 14, [lvl(85, "serious"), lvl(95, "critical", true)])).toBe(95);
  });

  it("returns the uncapped projection when the next level is the last one", () => {
    // Past serious, counting down to critical: 90 + 1 × 14 → 100 (capped by projectMemoryPct only).
    expect(forecastLevelReading(90, 1, 14, levels)).toBe(100);
  });

  it("is null with no levels at all", () => {
    expect(forecastLevelReading(80, 2, 14, [])).toBeNull();
  });
});

describe("memoryForecastFromDailyPoints", () => {
  it("projects days until 100% from the newest point and the fitted slope", () => {
    const fc = memoryForecastFromDailyPoints(series(10, 50, 2));
    // newest 68 → 32 / 2 = 16 days.
    expect(fc.slopePerDay).toBeCloseTo(2, 9);
    expect(fc.daysUntilFull).toBe(16);
    expect(fc.minPoints).toBe(7);
    expect(fc.lookbackDays).toBe(30);
    expect(fc.restartedAt).toBeNull();
  });

  it("keeps a flat or shrinking slope but gives no fill date", () => {
    const shrinking = memoryForecastFromDailyPoints(series(8, 70, -1));
    expect(shrinking.slopePerDay).toBeCloseTo(-1, 9);
    expect(shrinking.daysUntilFull).toBeNull();
    const flat = memoryForecastFromDailyPoints(series(8, 70, 0));
    expect(flat.slopePerDay).toBeCloseTo(0, 9);
    expect(flat.daysUntilFull).toBeNull();
  });

  it("has no slope below minPoints", () => {
    const fc = memoryForecastFromDailyPoints(series(6, 50, 2));
    expect(fc.slopePerDay).toBeNull();
    expect(fc.daysUntilFull).toBeNull();
    expect(fc.points).toHaveLength(6);
  });

  it("honours a custom minPoints / lookback / restartedAt", () => {
    const fc = memoryForecastFromDailyPoints(series(3, 50, 2), 3, 14, "2026-11-05T00:00:00.000Z");
    expect(fc.slopePerDay).toBeCloseTo(2, 9);
    expect(fc.lookbackDays).toBe(14);
    expect(fc.restartedAt).toBe("2026-11-05T00:00:00.000Z");
  });

  it("has no slope when every point shares one timestamp", () => {
    const pts = Array.from({ length: 8 }, (_, i) => ({ t: 1000, v: 50 + i }));
    expect(memoryForecastFromDailyPoints(pts).slopePerDay).toBeNull();
  });

  it("drops a fill date beyond 365 days and reads an already-full host as 0", () => {
    expect(memoryForecastFromDailyPoints(series(10, 50, 0.1)).daysUntilFull).toBeNull();
    expect(memoryForecastFromDailyPoints(series(10, 95, 1)).daysUntilFull).toBe(0);
  });

  it("rounds the fill date to 0.1 day", () => {
    // newest 50 + 3×6 = 68 → 32 / 3 = 10.666… → 10.7.
    expect(memoryForecastFromDailyPoints(series(7, 50, 3)).daysUntilFull).toBe(10.7);
  });
});

describe("computeMemoryForecastDetail / computeMemoryForecast", () => {
  it("short-circuits an empty asset list without a query", async () => {
    expect(await computeMemoryForecastDetail([])).toEqual({ rows: [], restartedWithoutForecast: [] });
    expect(await computeMemoryForecast([])).toEqual([]);
    expect(raw()).not.toHaveBeenCalled();
  });

  it("maps growing fits to rows, soonest-full first, rounded", async () => {
    raw().mockResolvedValueOnce([
      { assetId: "a", slope_per_day: 2.12345, points: 30, last_pct: 60.04, restarted_at: null },
      { assetId: "b", slope_per_day: 10, points: 12, last_pct: 90, restarted_at: null },
    ]);
    const { rows, restartedWithoutForecast } = await computeMemoryForecastDetail(null);
    expect(rows.map((r) => r.assetId)).toEqual(["b", "a"]);
    expect(rows[1]).toEqual({ assetId: "a", daysUntilFull: 18.8, usedPct: 60, slopePctPerDay: 2.123, points: 30 });
    expect(restartedWithoutForecast).toEqual([]);
  });

  it("drops rows beyond the horizon, flat, null-slope or null-pct", async () => {
    raw().mockResolvedValueOnce([
      { assetId: "far", slope_per_day: 0.05, points: 30, last_pct: 50, restarted_at: null },
      { assetId: "flat", slope_per_day: 0, points: 30, last_pct: 50, restarted_at: null },
      { assetId: "nofit", slope_per_day: null, points: 30, last_pct: 50, restarted_at: null },
      { assetId: "nopct", slope_per_day: 1, points: 30, last_pct: null, restarted_at: null },
    ]);
    expect(await computeMemoryForecast(null)).toEqual([]);
  });

  it("drops a row with fewer than minPoints even if growing", async () => {
    raw().mockResolvedValueOnce([{ assetId: "few", slope_per_day: 2, points: 3, last_pct: 50, restarted_at: null }]);
    expect(await computeMemoryForecast(null)).toEqual([]);
  });

  it("lists a rebooted host with no forecast (too few points, not growing, or beyond the horizon)", async () => {
    const boot = new Date("2026-11-10T00:00:00Z");
    raw().mockResolvedValueOnce([
      { assetId: "r0", slope_per_day: null, points: 0, last_pct: null, restarted_at: boot },
      { assetId: "rflat", slope_per_day: -0.2, points: 9, last_pct: 40, restarted_at: boot },
      { assetId: "rfar", slope_per_day: 0.01, points: 9, last_pct: 40, restarted_at: boot },
      { assetId: "rok", slope_per_day: 1, points: 9, last_pct: 90, restarted_at: boot },
    ]);
    const d = await computeMemoryForecastDetail(null);
    expect(d.restartedWithoutForecast).toEqual(["r0", "rflat", "rfar"]);
    expect(d.rows.map((r) => r.assetId)).toEqual(["rok"]);
  });

  it("coerces numeric strings from the driver", async () => {
    raw().mockResolvedValueOnce([{ assetId: "s", slope_per_day: "2", points: 10, last_pct: "80", restarted_at: null }]);
    const rows = await computeMemoryForecast(null);
    expect(rows[0]).toMatchObject({ daysUntilFull: 10, usedPct: 80, slopePctPerDay: 2 });
  });

  it("sends the lookback as a string, minPoints, and the id array as $3 when narrowed", async () => {
    raw().mockResolvedValueOnce([]);
    await computeMemoryForecast(["a1", "a2"], 14, 5);
    const call = raw().mock.calls[0]!;
    expect(call.slice(1)).toEqual(["14", 5, ["a1", "a2"]]);
    expect(sqlOf()).toContain(`AND r."assetId" = ANY($3::text[])`);
    expect(sqlOf()).toContain(`AND a.id = ANY($3::text[])`);
  });

  it("sends only two params and no id filter for the whole fleet", async () => {
    raw().mockResolvedValueOnce([]);
    await computeMemoryForecast(null);
    expect(raw().mock.calls[0]!.slice(1)).toEqual(["30", 7]);
    expect(sqlOf()).not.toContain("$3");
  });

  it("gates growing-only in SQL, but always keeps rebooted hosts", async () => {
    raw().mockResolvedValueOnce([]);
    await computeMemoryForecastDetail(null);
    expect(sqlOf()).toContain(`COALESCE(f.points, 0) >= $2 AND f.slope_per_day > 0`);
    expect(sqlOf()).toContain(`OR b."assetId" IS NOT NULL`);
    expect(sqlOf()).toContain("FULL JOIN boot b");
  });
});

describe("computeMemoryProjection", () => {
  it("short-circuits an empty asset list", async () => {
    expect(await computeMemoryProjection([], 14)).toEqual([]);
    expect(raw()).not.toHaveBeenCalled();
  });

  it("has NO growing-only gate in SQL", async () => {
    raw().mockResolvedValueOnce([]);
    await computeMemoryProjection(null, 14);
    expect(sqlOf()).not.toContain("f.slope_per_day > 0");
    expect(sqlOf()).toContain(`COALESCE(f.points, 0) >= $2`);
  });

  it("projects growing hosts and gives flat/shrinking ones projectedPct null", async () => {
    raw().mockResolvedValueOnce([
      { assetId: "g", slope_per_day: 0.5, points: 20, last_pct: 80, restarted_at: null },
      { assetId: "s", slope_per_day: -0.3333, points: 20, last_pct: 60.06, restarted_at: null },
      { assetId: "n", slope_per_day: null, points: 20, last_pct: 50, restarted_at: null },
    ]);
    const r = await computeMemoryProjection(null, 14);
    expect(r).toEqual([
      { assetId: "g", projectedPct: 87, usedPct: 80, slopePctPerDay: 0.5 },
      { assetId: "s", projectedPct: null, usedPct: 60.1, slopePctPerDay: -0.333 },
      { assetId: "n", projectedPct: null, usedPct: 50, slopePctPerDay: 0 },
    ]);
  });

  it("gives a rebooted host still rebuilding history a null projection (so a live alert ends)", async () => {
    raw().mockResolvedValueOnce([
      { assetId: "r", slope_per_day: 5, points: 2, last_pct: 44.44, restarted_at: new Date() },
      { assetId: "r0", slope_per_day: null, points: 0, last_pct: null, restarted_at: new Date() },
    ]);
    const r = await computeMemoryProjection(null, 14);
    expect(r).toEqual([
      { assetId: "r", projectedPct: null, usedPct: 44.4, slopePctPerDay: 0 },
      { assetId: "r0", projectedPct: null, usedPct: 0, slopePctPerDay: 0 },
    ]);
  });

  it("skips a fitted row with no newest pct", async () => {
    raw().mockResolvedValueOnce([{ assetId: "x", slope_per_day: 1, points: 20, last_pct: null, restarted_at: null }]);
    expect(await computeMemoryProjection(null, 14)).toEqual([]);
  });

  it("passes custom lookback / minPoints and the id filter", async () => {
    raw().mockResolvedValueOnce([]);
    await computeMemoryProjection(["z"], 7, 21, 4);
    expect(raw().mock.calls[0]!.slice(1)).toEqual(["21", 4, ["z"]]);
  });
});

describe("the shared daily-points SQL", () => {
  beforeEach(async () => {
    raw().mockResolvedValueOnce([]);
    await computeMemoryForecast(null);
  });

  it("reads the hourly + daily rollups, never the detail table", () => {
    expect(sqlOf()).toContain(`"asset_telemetry_samples_hourly"`);
    expect(sqlOf()).toContain(`"asset_telemetry_samples_daily"`);
    expect(sqlOf()).not.toMatch(/"asset_telemetry_samples"(?!_)/);
  });

  it("fits memory in use as a %: bytes first, else the source's own %", () => {
    expect(sqlOf()).toContain(`r."avgMemUsedBytes" IS NOT NULL AND r."lastMemTotalBytes" > 0`);
    expect(sqlOf()).toContain(`ELSE r."avgMemPct" END`);
    expect(sqlOf()).toContain("LEAST(GREATEST(pct, 0), 100)");
  });

  it("lets the hourly-derived day win the DISTINCT ON over the daily bucket", () => {
    expect(sqlOf()).toContain(`DISTINCT ON ("assetId", day)`);
    expect(sqlOf()).toContain(`ORDER BY "assetId", day, prio`);
    expect(sqlOf()).toMatch(/0 AS prio[\s\S]*1 AS prio/);
  });

  it("weights the hourly tail by sample count", () => {
    expect(sqlOf()).toContain("SUM(pct * n) / NULLIF(SUM(n), 0)");
  });

  it("anchors every window to UTC wall clock, never a bare now()", () => {
    expect(sqlOf()).not.toMatch(/now\(\)(?! AT TIME ZONE 'UTC')/);
  });

  it("restarts the fit at the last boot inside the lookback", () => {
    expect(sqlOf()).toContain(`LEAST(a."lastRebootAt", a."lastMonitorAt" - a."lastUptimeSec" * interval '1 second')`);
    expect(sqlOf()).toContain(`a."lastRebootAt" > (now() AT TIME ZONE 'UTC') - ($1 || ' days')::interval`);
    expect(sqlOf()).toContain(`(b.at IS NULL OR r."bucketStart" >= b.at)`);
    expect(sqlOf()).toContain(`(b.at IS NULL OR r."bucketStart" > date_trunc('day', b.at))`);
  });

  // Was a bug until 2026-11-14: the hourly tail is meant to re-derive the last HOURLY_TAIL_DAYS (2)
  // whole days — today and yesterday — and the result WINS over yesterday's
  // daily bucket. The filter is `bucketStart > date_trunc('day', now) - 1 day`,
  // a strict `>` against yesterday's midnight, so yesterday's 00:00–01:00
  // hourly bucket is excluded and yesterday's point is averaged over 23 hours
  // instead of 24 (and replaces the complete daily bucket). Right: `>=`.
  it("re-derives yesterday from ALL of its hourly buckets, midnight included", () => {
    expect(sqlOf()).toContain(`r."bucketStart" >= date_trunc('day', (now() AT TIME ZONE 'UTC')) - interval '1 days'`);
  });
});

describe("loadMemoryForecastSeries", () => {
  it("narrows both arms and the boot CTE to the asset as $2", async () => {
    raw().mockResolvedValueOnce([]);
    await loadMemoryForecastSeries("asset-1", 21);
    expect(raw().mock.calls[0]!.slice(1)).toEqual(["21", "asset-1"]);
    expect(sqlOf()).toContain(`AND r."assetId" = $2`);
    expect(sqlOf()).toContain(`AND a.id = $2`);
    expect(sqlOf()).toContain("SELECT NULL, NULL, at FROM boot");
  });

  it("fits the points, skipping null days and pcts, and carries the boot", async () => {
    const boot = new Date("2026-11-01T06:00:00Z");
    raw().mockResolvedValueOnce([
      { day: null, pct: null, restarted_at: boot },
      ...series(8, 50, 2).map((p) => ({ day: new Date(p.t), pct: p.v, restarted_at: null })),
      { day: new Date(30_000 * DAY), pct: null, restarted_at: null },
    ]);
    const fc = await loadMemoryForecastSeries("a");
    expect(fc.points).toHaveLength(8);
    expect(fc.points[0]).toEqual({ t: 20_000 * DAY, v: 50 });
    expect(fc.slopePerDay).toBeCloseTo(2, 9);
    expect(fc.daysUntilFull).toBe(18);
    expect(fc.restartedAt).toBe("2026-11-01T06:00:00.000Z");
    expect(fc.lookbackDays).toBe(30);
  });

  it("reports a reboot with no points yet as restarted and unfitted", async () => {
    raw().mockResolvedValueOnce([{ day: null, pct: null, restarted_at: new Date("2026-11-13T00:00:00Z") }]);
    const fc = await loadMemoryForecastSeries("a");
    expect(fc).toMatchObject({ points: [], slopePerDay: null, daysUntilFull: null, restartedAt: "2026-11-13T00:00:00.000Z" });
  });

  it("propagates a failed read", async () => {
    raw().mockRejectedValueOnce(new Error("db down"));
    await expect(loadMemoryForecastSeries("a")).rejects.toThrow("db down");
  });
});

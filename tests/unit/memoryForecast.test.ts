/**
 * tests/unit/memoryForecast.test.ts — the memory-forecast stack: the pure
 * memoryForecastFromDailyPoints fit, computeMemoryForecast's SQL-row →
 * forecast mapping (mocked $queryRawUnsafe), and the metric's registration
 * (label, cadence stream, alert charts, process ranking).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: { $queryRawUnsafe: vi.fn() },
}));

import {
  computeMemoryForecast,
  memoryForecastFromDailyPoints,
  loadMemoryForecastSeries,
  MEMORY_FORECAST_MAX_DAYS,
  MEMORY_FORECAST_MIN_POINTS,
} from "../../src/services/memoryForecastService.js";
import { ASSET_METRICS, METRIC_META } from "../../src/services/notificationTypes.js";
import { chartTokenForMetric, isResourceScopedAlert } from "../../src/services/alertChartService.js";
import { processRankingForMetric } from "../../src/services/alertProcessService.js";
import { prisma } from "../../src/db.js";

const rawUnsafe = prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>;
const DAY = 86_400_000;

beforeEach(() => {
  vi.clearAllMocks();
});

const series = (n: number, start: number, perDay: number) =>
  Array.from({ length: n }, (_, d) => ({ t: d * DAY, v: start + d * perDay }));

describe("memoryForecastFromDailyPoints", () => {
  it("projects days until 100% for a growing host", () => {
    // 50% → 59% over 10 days at 1 point/day: 41 points left at 1/day.
    const fc = memoryForecastFromDailyPoints(series(10, 50, 1));
    expect(fc.slopePerDay).toBeCloseTo(1, 6);
    expect(fc.daysUntilFull).toBe(41);
  });

  it("keeps the slope of a shrinking or flat host but gives it no fill date", () => {
    const shrinking = memoryForecastFromDailyPoints(series(10, 80, -0.5));
    expect(shrinking.slopePerDay).toBeCloseTo(-0.5, 6);
    expect(shrinking.daysUntilFull).toBeNull();
    const flat = memoryForecastFromDailyPoints(series(10, 40, 0));
    expect(flat.daysUntilFull).toBeNull();
  });

  it("needs the minimum number of daily points before it fits at all", () => {
    const fc = memoryForecastFromDailyPoints(series(MEMORY_FORECAST_MIN_POINTS - 1, 50, 5));
    expect(fc.slopePerDay).toBeNull();
    expect(fc.daysUntilFull).toBeNull();
    expect(fc.points).toHaveLength(MEMORY_FORECAST_MIN_POINTS - 1);
    expect(fc.minPoints).toBe(MEMORY_FORECAST_MIN_POINTS);
  });

  it("drops a fill date beyond the horizon, and calls a host already at 100% full now", () => {
    // 0.1 points/day from 50% → 500 days.
    expect(memoryForecastFromDailyPoints(series(10, 50, 0.1)).daysUntilFull).toBeNull();
    expect(memoryForecastFromDailyPoints(series(10, 91, 1)).daysUntilFull).toBe(0);
  });
});

describe("computeMemoryForecast", () => {
  it("maps SQL fit rows to forecasts, soonest-full first, dropping beyond-horizon rows", async () => {
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "a", slope_per_day: 2, points: 30, last_pct: 60 },    // 20 days
      { assetId: "b", slope_per_day: 10, points: 12, last_pct: 90 },   // 1 day
      { assetId: "c", slope_per_day: 0.05, points: 30, last_pct: 50 }, // 1000 days → dropped
      { assetId: "d", slope_per_day: null, points: 30, last_pct: 50 }, // no fit → dropped
    ]);
    const r = await computeMemoryForecast(null);
    expect(r.map((x) => [x.assetId, x.daysUntilFull])).toEqual([["b", 1], ["a", 20]]);
    expect(r[1].usedPct).toBe(60);
    expect(r[1].slopePctPerDay).toBe(2);
    expect(r.every((x) => x.daysUntilFull <= MEMORY_FORECAST_MAX_DAYS)).toBe(true);
  });

  it("reads the rollups (never the detail table), filtered to the asset ids", async () => {
    rawUnsafe.mockResolvedValueOnce([]);
    await computeMemoryForecast(["a1", "a2"], 30, 7);
    const [sql, lookback, minPoints, ids] = rawUnsafe.mock.calls[0];
    expect(sql).toContain("asset_telemetry_samples_daily");
    expect(sql).toContain("asset_telemetry_samples_hourly");
    expect(sql).not.toMatch(/"asset_telemetry_samples"(?!_)/);
    expect(sql).toContain("regr_slope");
    expect(sql).toContain(`= ANY($3::text[])`);
    expect(lookback).toBe("30");
    expect(minPoints).toBe(7);
    expect(ids).toEqual(["a1", "a2"]);
  });

  it("does not query at all for an empty asset list", async () => {
    expect(await computeMemoryForecast([])).toEqual([]);
    expect(rawUnsafe).not.toHaveBeenCalled();
  });
});

describe("loadMemoryForecastSeries", () => {
  it("fits the asset's daily points in JS, skipping null days", async () => {
    rawUnsafe.mockResolvedValueOnce([
      ...series(8, 50, 2).map((p) => ({ day: new Date(p.t), pct: p.v })),
      { day: new Date(9 * DAY), pct: null },
    ]);
    const fc = await loadMemoryForecastSeries("x");
    expect(fc.points).toHaveLength(8);
    expect(fc.slopePerDay).toBeCloseTo(2, 6);
    // Newest day at 64% → 18 days.
    expect(fc.daysUntilFull).toBe(18);
    expect(rawUnsafe.mock.calls[0][2]).toBe("x");
  });
});

describe("memDaysUntilFull registration", () => {
  it("is an asset metric with a days unit", () => {
    expect(ASSET_METRICS).toContain("memDaysUntilFull");
    expect(METRIC_META.memDaysUntilFull).toEqual({ label: "Days until memory full", unit: "days" });
  });

  it("charts and ranks like the other memory alerts", () => {
    expect(chartTokenForMetric("memDaysUntilFull")).toBe("chart.memory");
    expect(isResourceScopedAlert("memDaysUntilFull")).toBe(true);
    expect(processRankingForMetric("memDaysUntilFull")).toBe("memory");
  });
});

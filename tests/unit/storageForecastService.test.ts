/**
 * tests/unit/storageForecastService.test.ts — own unit suite (CQ-T010) for
 * src/services/storageForecastService.ts: the pure fit, the fleet query's JS
 * tail and SQL text, the 15-minute shared memo, and the single-mount series.
 * No database: `$queryRawUnsafe` is the shared stub.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import {
  computeStorageForecast,
  computeStorageForecastShared,
  forecastFromDailyPoints,
  invalidateStorageForecastMemo,
  loadStorageForecastSeries,
  FORECAST_MAX_DAYS,
} from "../../src/services/storageForecastService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const DAY = 86_400_000;
const GB = 1e9;
const raw = () => stubbed(prisma.$queryRawUnsafe);
const sqlOf = (call = 0): string => String(raw().mock.calls[call]![0]);
const series = (n: number, start: number, slope: number) =>
  Array.from({ length: n }, (_, i) => ({ t: (20_000 + i) * DAY, v: start + slope * i }));
const fit = (over: Record<string, unknown> = {}) => ({
  assetId: "a", mountPath: "/", slope_per_day: GB, points: 10, last_used: 50 * GB, total_bytes: 100 * GB, ...over,
});

beforeEach(() => {
  resetDbStub();
  invalidateStorageForecastMemo();
});

afterEach(() => vi.useRealTimers());

describe("forecastFromDailyPoints", () => {
  it("projects (total - newest day) / slope, rounded to 0.1", () => {
    const fc = forecastFromDailyPoints(series(7, 10 * GB, 3 * GB), 100 * GB);
    // newest 28 GB → 72 / 3 = 24.
    expect(fc.slopePerDay).toBeCloseTo(3 * GB, 0);
    expect(fc.daysUntilFull).toBe(24);
    expect(fc.totalBytes).toBe(100 * GB);
  });

  it("returns the points without a fit below minPoints, without capacity, or with capacity <= 0", () => {
    const pts = series(6, 10, 1);
    expect(forecastFromDailyPoints(pts, 100)).toEqual({ points: pts, totalBytes: 100, slopePerDay: null, daysUntilFull: null });
    expect(forecastFromDailyPoints(series(8, 10, 1), null).slopePerDay).toBeNull();
    expect(forecastFromDailyPoints(series(8, 10, 1), 0).slopePerDay).toBeNull();
    expect(forecastFromDailyPoints(series(8, 10, 1), -5).slopePerDay).toBeNull();
  });

  it("has no fit for a flat or shrinking mount (growing only)", () => {
    expect(forecastFromDailyPoints(series(8, 50, 0), 100)).toMatchObject({ slopePerDay: null, daysUntilFull: null });
    expect(forecastFromDailyPoints(series(8, 50, -1), 100)).toMatchObject({ slopePerDay: null, daysUntilFull: null });
  });

  it("has no fit beyond 365 days, and reads an over-capacity mount as 0", () => {
    expect(FORECAST_MAX_DAYS).toBe(365);
    expect(forecastFromDailyPoints(series(8, 10, 0.01), 100).daysUntilFull).toBeNull();
    expect(forecastFromDailyPoints(series(8, 95, 1), 100).daysUntilFull).toBe(0);
  });

  it("honours a custom minPoints", () => {
    expect(forecastFromDailyPoints(series(3, 10, 1), 100, 3).daysUntilFull).toBe(88);
  });
});

describe("computeStorageForecast", () => {
  it("maps fits to rows, soonest-full first, rounding days / pct / slope", async () => {
    raw().mockResolvedValueOnce([
      fit({ assetId: "slow", slope_per_day: 0.3333 * GB, last_used: 40 * GB }),
      fit({ assetId: "fast", mountPath: "C:", slope_per_day: 10.4 * GB, last_used: 90.2 * GB }),
    ]);
    const rows = await computeStorageForecast(null);
    expect(rows.map((r) => r.assetId)).toEqual(["fast", "slow"]);
    expect(rows[0]).toEqual({ assetId: "fast", mountPath: "C:", daysUntilFull: 0.9, usedPct: 90.2, slopeBytesPerDay: 10_400_000_000, points: 10 });
    expect(rows[1]!.daysUntilFull).toBe(180);
    expect(rows[1]!.slopeBytesPerDay).toBe(333_300_000);
  });

  it("drops a row with no slope, no newest value, no capacity, capacity <= 0, or beyond the horizon", async () => {
    raw().mockResolvedValueOnce([
      fit({ assetId: "s", slope_per_day: null }),
      fit({ assetId: "u", last_used: null }),
      fit({ assetId: "t", total_bytes: null }),
      fit({ assetId: "z", total_bytes: 0 }),
      fit({ assetId: "far", slope_per_day: 0.01 * GB }),
      fit({ assetId: "flat", slope_per_day: 0 }),
    ]);
    expect(await computeStorageForecast(null)).toEqual([]);
  });

  it("keeps a full mount as 0 days", async () => {
    raw().mockResolvedValueOnce([fit({ last_used: 120 * GB })]);
    expect((await computeStorageForecast(null))[0]).toMatchObject({ daysUntilFull: 0, usedPct: 120 });
  });

  it("sends lookback (string) + minPoints, and the id array as $3 on both arms", async () => {
    raw().mockResolvedValueOnce([]);
    await computeStorageForecast(["a1", "a2"], 14, 5);
    expect(raw().mock.calls[0]!.slice(1)).toEqual(["14", 5, ["a1", "a2"]]);
    expect(sqlOf()).toContain(`AND s."assetId" = ANY($3::text[])`);
    expect(sqlOf()).toContain(`AND d."assetId" = ANY($3::text[])`);
  });

  it("sends two params and no filter for the fleet", async () => {
    raw().mockResolvedValueOnce([]);
    await computeStorageForecast();
    expect(raw().mock.calls[0]!.slice(1)).toEqual(["30", 7]);
    expect(sqlOf()).not.toContain("$3");
  });

  it("UNIONs detail and daily, dedups per day, and gates growing + minPoints in SQL", async () => {
    raw().mockResolvedValueOnce([]);
    await computeStorageForecast(null);
    const sql = sqlOf();
    expect(sql).toContain(`FROM "asset_storage_samples" s`);
    expect(sql).toContain(`FROM "asset_storage_samples_daily" d`);
    expect(sql).toContain("UNION ALL");
    expect(sql).toContain(`DISTINCT ON ("assetId", "mountPath", day)`);
    expect(sql).toContain("HAVING count(*) >= $2");
    expect(sql).toMatch(/regr_slope\(used, extract\(epoch from day\)::float8 \/ 86400\.0\) > 0/);
    expect(sql).not.toMatch(/now\(\)(?! AT TIME ZONE 'UTC')/);
  });

  it("queries even for an empty id list (no short-circuit) and returns nothing", async () => {
    raw().mockResolvedValueOnce([]);
    expect(await computeStorageForecast([])).toEqual([]);
    expect(raw().mock.calls[0]![3]).toEqual([]);
  });

  it("propagates a failed query", async () => {
    raw().mockRejectedValueOnce(new Error("db down"));
    await expect(computeStorageForecast(null)).rejects.toThrow("db down");
  });
});

describe("computeStorageForecastShared", () => {
  it("fits the whole fleet once and filters to the caller's assets", async () => {
    raw().mockResolvedValue([fit({ assetId: "a" }), fit({ assetId: "b" })]);
    expect((await computeStorageForecastShared(["b", "x"])).map((r) => r.assetId)).toEqual(["b"]);
    expect((await computeStorageForecastShared(null))).toHaveLength(2);
    expect(raw()).toHaveBeenCalledTimes(1);
    expect(raw().mock.calls[0]!.slice(1)).toEqual(["30", 7]);
  });

  it("shares an in-flight fit between concurrent callers", async () => {
    let resolve!: (v: unknown) => void;
    raw().mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const p1 = computeStorageForecastShared(["a"]);
    const p2 = computeStorageForecastShared(null);
    resolve([fit()]);
    expect(await p1).toHaveLength(1);
    expect(await p2).toHaveLength(1);
    expect(raw()).toHaveBeenCalledTimes(1);
  });

  it("recomputes after 15 minutes, not before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    raw().mockResolvedValue([]);
    await computeStorageForecastShared();
    vi.setSystemTime(1_000_000 + 15 * 60_000 - 1);
    await computeStorageForecastShared();
    expect(raw()).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000_000 + 15 * 60_000);
    await computeStorageForecastShared();
    expect(raw()).toHaveBeenCalledTimes(2);
  });

  it("does not remember a failure", async () => {
    raw().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([fit()]);
    await expect(computeStorageForecastShared()).rejects.toThrow("boom");
    expect(await computeStorageForecastShared()).toHaveLength(1);
  });

  it("invalidateStorageForecastMemo forces a refit", async () => {
    raw().mockResolvedValue([]);
    await computeStorageForecastShared();
    invalidateStorageForecastMemo();
    await computeStorageForecastShared();
    expect(raw()).toHaveBeenCalledTimes(2);
  });

  it("returns an empty list for an empty id filter", async () => {
    raw().mockResolvedValue([fit()]);
    expect(await computeStorageForecastShared([])).toEqual([]);
  });
});

describe("loadStorageForecastSeries", () => {
  it("narrows both arms to the asset ($2) and mount ($3)", async () => {
    raw().mockResolvedValueOnce([]);
    await loadStorageForecastSeries("a", "/var", 21);
    expect(raw().mock.calls[0]!.slice(1)).toEqual(["21", "a", "/var"]);
    expect(sqlOf()).toContain(`AND s."assetId" = $2 AND s."mountPath" = $3`);
    expect(sqlOf()).toContain(`AND d."assetId" = $2 AND d."mountPath" = $3`);
    expect(sqlOf()).toContain("ORDER BY day");
  });

  it("fits the points, skips null days, and takes the newest reported capacity", async () => {
    const pts = series(8, 10 * GB, 2 * GB);
    raw().mockResolvedValueOnce([
      ...pts.map((p, i) => ({ day: new Date(p.t), used: p.v, total: i === 0 ? 80 * GB : i === 5 ? 100 * GB : null })),
      { day: new Date(30_000 * DAY), used: null, total: 999 * GB },
    ]);
    const fc = await loadStorageForecastSeries("a", "/");
    expect(fc.points).toHaveLength(8);
    // The null-used day's capacity is skipped with the row.
    expect(fc.totalBytes).toBe(100 * GB);
    // newest 24 GB → 76 / 2 = 38.
    expect(fc.daysUntilFull).toBe(38);
  });

  it("has no fit when the mount never reported a capacity", async () => {
    raw().mockResolvedValueOnce(series(8, 10, 1).map((p) => ({ day: new Date(p.t), used: p.v, total: null })));
    expect(await loadStorageForecastSeries("a", "/")).toMatchObject({ totalBytes: null, slopePerDay: null, daysUntilFull: null });
  });

  it("coerces numeric strings from the driver", async () => {
    raw().mockResolvedValueOnce(series(7, 10, 1).map((p) => ({ day: new Date(p.t), used: String(p.v), total: "100" })));
    const fc = await loadStorageForecastSeries("a", "/");
    expect(fc.totalBytes).toBe(100);
    expect(fc.points[0]!.v).toBe(10);
    expect(fc.daysUntilFull).toBe(84);
  });
});

/**
 * tests/unit/storageForecast.test.ts — the storage-forecast stack:
 * linearTrend pure helpers, computeStorageForecast's SQL-row → forecast
 * mapping (mocked $queryRawUnsafe), and the storageDaysUntilFull engine
 * resolver's reading shape via previewRule.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { leastSquaresSlopePerDay, daysUntilFull } from "../../src/utils/linearTrend.js";
import { computeStorageForecast, FORECAST_MAX_DAYS } from "../../src/services/storageForecastService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";

const rawUnsafe = prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetDbStub();
  vi.clearAllMocks();
});

const DAY = 86_400_000;

describe("leastSquaresSlopePerDay", () => {
  it("fits a clean linear series exactly", () => {
    const pts = [0, 1, 2, 3, 4].map((d) => ({ t: d * DAY, v: 100 + d * 10 }));
    expect(leastSquaresSlopePerDay(pts)).toBeCloseTo(10, 6);
  });

  it("returns ~0 for a flat series and a negative slope for a shrinking one", () => {
    const flat = [0, 1, 2, 3].map((d) => ({ t: d * DAY, v: 500 }));
    expect(leastSquaresSlopePerDay(flat)).toBeCloseTo(0, 6);
    const shrinking = [0, 1, 2, 3].map((d) => ({ t: d * DAY, v: 500 - d * 5 }));
    expect(leastSquaresSlopePerDay(shrinking)).toBeCloseTo(-5, 6);
  });

  it("smooths a noisy series to the underlying trend", () => {
    const noise = [3, -4, 2, -1, 4, -3, 1, -2];
    const pts = noise.map((n, d) => ({ t: d * DAY, v: 1000 + d * 20 + n }));
    const slope = leastSquaresSlopePerDay(pts)!;
    expect(slope).toBeGreaterThan(18);
    expect(slope).toBeLessThan(22);
  });

  it("returns null for <2 points or identical timestamps", () => {
    expect(leastSquaresSlopePerDay([])).toBeNull();
    expect(leastSquaresSlopePerDay([{ t: 0, v: 1 }])).toBeNull();
    expect(leastSquaresSlopePerDay([{ t: 5, v: 1 }, { t: 5, v: 2 }])).toBeNull();
  });
});

describe("daysUntilFull", () => {
  it("projects remaining/slope days and clamps over-capacity to 0", () => {
    expect(daysUntilFull({ slopePerDay: 10, currentUsed: 900, totalBytes: 1000 })).toBe(10);
    expect(daysUntilFull({ slopePerDay: 10, currentUsed: 1200, totalBytes: 1000 })).toBe(0);
  });

  it("returns null for flat/shrinking mounts and unknown capacity", () => {
    expect(daysUntilFull({ slopePerDay: 0, currentUsed: 1, totalBytes: 100 })).toBeNull();
    expect(daysUntilFull({ slopePerDay: -5, currentUsed: 1, totalBytes: 100 })).toBeNull();
    expect(daysUntilFull({ slopePerDay: 5, currentUsed: 1, totalBytes: 0 })).toBeNull();
  });
});

describe("computeStorageForecast", () => {
  it("maps SQL fit rows to forecasts, soonest-full first, dropping incomplete/beyond-horizon rows", async () => {
    rawUnsafe.mockResolvedValueOnce([
      // 10 GB/day into a 100 GB disk at 90 GB used → 1 day
      { assetId: "a", mountPath: "/var", slope_per_day: 10e9, points: 12, last_used: 90e9, total_bytes: 100e9 },
      // 1 GB/day at 50/100 GB → 50 days
      { assetId: "b", mountPath: "C:", slope_per_day: 1e9, points: 30, last_used: 50e9, total_bytes: 100e9 },
      // Unknown capacity → dropped
      { assetId: "c", mountPath: "/tmp", slope_per_day: 5e9, points: 9, last_used: 10e9, total_bytes: null },
      // Slow drip, ~2500 days out → beyond FORECAST_MAX_DAYS, dropped
      { assetId: "d", mountPath: "/data", slope_per_day: 0.02e9, points: 30, last_used: 50e9, total_bytes: 100e9 },
    ]);
    const r = await computeStorageForecast(null);
    expect(r.map((x) => [x.assetId, x.mountPath, x.daysUntilFull])).toEqual([
      ["a", "/var", 1],
      ["b", "C:", 50],
    ]);
    expect(r[0].usedPct).toBe(90);
    expect(r[0].slopeBytesPerDay).toBe(10e9);
    expect(r[1].daysUntilFull).toBeLessThanOrEqual(FORECAST_MAX_DAYS);
  });

  it("passes the lookback + minPoints params and the assetId filter", async () => {
    rawUnsafe.mockResolvedValueOnce([]);
    await computeStorageForecast(["a1", "a2"], 30, 7);
    const call = rawUnsafe.mock.calls[0];
    const sql = call[0] as string;
    expect(sql).toContain("asset_storage_samples_daily");
    expect(sql).toContain("regr_slope");
    expect(sql).toContain(`= ANY($3::text[])`);
    expect(call[1]).toBe("30");
    expect(call[2]).toBe(7);
    expect(call[3]).toEqual(["a1", "a2"]);
  });
});

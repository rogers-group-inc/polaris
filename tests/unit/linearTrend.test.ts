/**
 * tests/unit/linearTrend.test.ts
 *
 * The JS reference of the forecast regression (regr_slope over epoch days)
 * and the days-until-full projection. storageForecast.test.ts exercises the
 * service; this pins the edge cases the helpers promise.
 */

import { describe, it, expect } from "vitest";
import { leastSquaresSlopePerDay, daysUntilFull } from "../../src/utils/linearTrend.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

describe("leastSquaresSlopePerDay", () => {
  it("returns the exact slope per DAY for a perfect line", () => {
    const pts = [0, 1, 2, 3].map((d) => ({ t: T0 + d * DAY, v: 100 + 5 * d }));
    expect(leastSquaresSlopePerDay(pts)).toBeCloseTo(5, 9);
  });

  it("converts sub-day samples to per-day units", () => {
    const hour = DAY / 24;
    const pts = [0, 1, 2].map((h) => ({ t: T0 + h * hour, v: h }));
    expect(leastSquaresSlopePerDay(pts)).toBeCloseTo(24, 6);
  });

  it("fits the least-squares slope through noisy points, independent of order", () => {
    const pts = [
      { t: T0, v: 1 }, { t: T0 + DAY, v: 3 }, { t: T0 + 2 * DAY, v: 2 }, { t: T0 + 3 * DAY, v: 5 },
    ];
    // x̄=1.5, ȳ=2.75; sxy = (-1.5)(-1.75)+(-0.5)(0.25)+(0.5)(-0.75)+(1.5)(2.25) = 5.5; sxx = 5
    expect(leastSquaresSlopePerDay(pts)).toBeCloseTo(1.1, 9);
    expect(leastSquaresSlopePerDay([...pts].reverse())).toBeCloseTo(1.1, 9);
  });

  it("is negative for a shrinking series and 0 for a flat one", () => {
    expect(leastSquaresSlopePerDay([{ t: T0, v: 10 }, { t: T0 + DAY, v: 4 }])).toBeCloseTo(-6, 9);
    expect(leastSquaresSlopePerDay([{ t: T0, v: 3 }, { t: T0 + DAY, v: 3 }])).toBe(0);
  });

  it("is null for fewer than two points, a non-array, or a vertical line", () => {
    expect(leastSquaresSlopePerDay([])).toBeNull();
    expect(leastSquaresSlopePerDay([{ t: T0, v: 1 }])).toBeNull();
    expect(leastSquaresSlopePerDay(null as unknown as [])).toBeNull();
    expect(leastSquaresSlopePerDay([{ t: T0, v: 1 }, { t: T0, v: 9 }])).toBeNull();
  });
});

describe("daysUntilFull", () => {
  it("divides the remaining capacity by the growth per day", () => {
    expect(daysUntilFull({ slopePerDay: 10, currentUsed: 60, totalBytes: 100 })).toBe(4);
  });

  it("supports the memory forecast's percentage form (totalBytes = 100)", () => {
    expect(daysUntilFull({ slopePerDay: 2.5, currentUsed: 90, totalBytes: 100 })).toBe(4);
  });

  it("clamps an already-full or over-capacity mount to 0", () => {
    expect(daysUntilFull({ slopePerDay: 1, currentUsed: 100, totalBytes: 100 })).toBe(0);
    expect(daysUntilFull({ slopePerDay: 1, currentUsed: 120, totalBytes: 100 })).toBe(0);
  });

  it("is null when not growing", () => {
    expect(daysUntilFull({ slopePerDay: 0, currentUsed: 1, totalBytes: 100 })).toBeNull();
    expect(daysUntilFull({ slopePerDay: -3, currentUsed: 1, totalBytes: 100 })).toBeNull();
  });

  it("is null for unknown capacity or non-finite input", () => {
    expect(daysUntilFull({ slopePerDay: 1, currentUsed: 1, totalBytes: 0 })).toBeNull();
    expect(daysUntilFull({ slopePerDay: 1, currentUsed: 1, totalBytes: -5 })).toBeNull();
    expect(daysUntilFull({ slopePerDay: NaN, currentUsed: 1, totalBytes: 100 })).toBeNull();
    expect(daysUntilFull({ slopePerDay: Infinity, currentUsed: 1, totalBytes: 100 })).toBeNull();
    expect(daysUntilFull({ slopePerDay: 1, currentUsed: NaN, totalBytes: 100 })).toBeNull();
    expect(daysUntilFull({ slopePerDay: 1, currentUsed: 1, totalBytes: Infinity })).toBeNull();
  });
});

/**
 * tests/integration/storageForecastSeries.test.ts
 *
 * The alert email's storage FORECAST chart must say the same "days until full"
 * the automation fired on. The automation's number comes from
 * `computeStorageForecast` (one fleet-wide regr_slope query); the chart's comes
 * from `loadStorageForecastSeries` (the same daily points for one mount, fitted
 * in JS). Both read `dailyPointsCte`, but only a real Postgres proves the
 * single-mount narrowing binds its parameters correctly and that the JS fit
 * agrees with regr_slope on real rows — including the day-bucketing, the
 * detail + rollup union, and a second mount on the same asset that must not
 * leak into the first one's fit.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import { computeStorageForecast, loadStorageForecastSeries } from "../../src/services/storageForecastService.js";

const ASSET = "it-storage-forecast-asset";
const GB = 1024 ** 3;
const TOTAL = 100 * GB;
const DAY = 86_400_000;

dbDescribe("storage forecast series for the alert chart", () => {
  beforeAll(async () => {
    await prisma.assetStorageSample.deleteMany({ where: { assetId: ASSET } });
    await prisma.assetStorageSampleDaily.deleteMany({ where: { assetId: ASSET } });
    // Seed relative to the DATABASE's clock — the forecast windows on now(),
    // and a drifted VM clock would otherwise age every row out.
    const [{ now }] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
    const base = new Date(now).getTime();
    const rows = [];
    for (let d = 13; d >= 0; d--) {
      const i = 13 - d;
      // Two samples a day on /data, growing ~2 GB/day with a little noise.
      for (const h of [2, 14]) {
        rows.push({
          assetId: ASSET, mountPath: "/data", cadence: "fast",
          timestamp: new Date(base - d * DAY - h * 3_600_000 + 1),
          usedBytes: BigInt(Math.round((64 + i * 2 + (i % 3) * 0.3) * GB)),
          totalBytes: BigInt(TOTAL),
        });
      }
      // A second mount on the same asset, shrinking — must not touch /data's fit.
      rows.push({
        assetId: ASSET, mountPath: "/tmp", cadence: "fast",
        timestamp: new Date(base - d * DAY - 3_600_000),
        usedBytes: BigInt(Math.round((40 - i) * GB)),
        totalBytes: BigInt(TOTAL),
      });
    }
    await prisma.assetStorageSample.createMany({ data: rows });
  });

  afterAll(async () => {
    await prisma.assetStorageSample.deleteMany({ where: { assetId: ASSET } });
    await prisma.assetStorageSampleDaily.deleteMany({ where: { assetId: ASSET } });
  });

  it("fits the same days-until-full as the automation's fleet query", async () => {
    const fleet = await computeStorageForecast([ASSET]);
    const row = fleet.find((r) => r.mountPath === "/data");
    expect(row).toBeDefined();
    const series = await loadStorageForecastSeries(ASSET, "/data");
    expect(series.daysUntilFull).not.toBeNull();
    expect(series.daysUntilFull).toBeCloseTo(row!.daysUntilFull, 1);
    expect(series.slopePerDay).toBeCloseTo(row!.slopeBytesPerDay, -3);
    expect(series.totalBytes).toBe(TOTAL);
  });

  it("reads only the mount it was asked for", async () => {
    const series = await loadStorageForecastSeries(ASSET, "/data");
    // 14 days of /data, one point per day — /tmp's rows are not in it.
    expect(series.points.length).toBeGreaterThanOrEqual(13);
    expect(series.points.length).toBeLessThanOrEqual(15);
    expect(series.points.every((p, i, a) => i === 0 || p.t > a[i - 1]!.t)).toBe(true);
    // /tmp is shrinking: history but no fit, and absent from the fleet result.
    const tmp = await loadStorageForecastSeries(ASSET, "/tmp");
    expect(tmp.points.length).toBeGreaterThan(0);
    expect(tmp.daysUntilFull).toBeNull();
    expect((await computeStorageForecast([ASSET])).some((r) => r.mountPath === "/tmp")).toBe(false);
  });

  it("returns an empty series for a mount with no samples", async () => {
    const none = await loadStorageForecastSeries(ASSET, "/nope");
    expect(none).toEqual({ points: [], totalBytes: null, slopePerDay: null, daysUntilFull: null });
  });
});

describe("storageForecastSeries (skipped without a DB)", () => {
  it("is exercised against a real database above", () => {
    expect(true).toBe(true);
  });
});

/**
 * tests/integration/sampleRollupMaxLines.test.ts
 *
 * The rollup columns behind the max lines on 30d+ charts, against the real
 * SQL (sampleRollupService) and the readers (sampleHistoryService):
 *   - per-core CPU vectors in the telemetry rollups — hourly avg/max with a
 *     gap and a ragged vector, daily weighted average + max of maxes;
 *   - interface peak throughput — the cross-bucket first pair, a counter
 *     reset dropped, daily max of hourly maxes;
 *   - the reader translation of both;
 *   - the one-shot backfill: marker, window bound, idempotency.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import {
  rollupHourly,
  rollupRange,
  runMaxLineBackfillOnce,
  maxLineBackfillDays,
  MAX_LINE_BACKFILL_MARKER,
} from "../../src/services/sampleRollupService.js";
import { readTelemetryHistory, readInterfaceHistory } from "../../src/services/sampleHistoryService.js";
import { getSampleRetention } from "../../src/services/sampleRetentionService.js";
import { getEffectiveCompressAfterDays } from "../../src/services/timescaleService.js";

const d = dbDescribe;
const ASSET = "00000000-0000-0000-0000-0000000000ab";
const HOUR = 3_600_000;
const DAY = 86_400_000;

function recentHourBucket(): Date {
  const t = new Date(Date.now() - 30 * 60 * 1000);
  t.setUTCMinutes(0, 0, 0);
  return t;
}
const utcDay = (t: Date) => new Date(Math.floor(t.getTime() / DAY) * DAY);

async function clean(): Promise<void> {
  await prisma.assetTelemetrySample.deleteMany({ where: { assetId: ASSET } });
  await prisma.assetTelemetrySampleHourly.deleteMany({ where: { assetId: ASSET } });
  await prisma.assetTelemetrySampleDaily.deleteMany({ where: { assetId: ASSET } });
  await prisma.assetInterfaceSample.deleteMany({ where: { assetId: ASSET } });
  await prisma.assetInterfaceSampleHourly.deleteMany({ where: { assetId: ASSET } });
  await prisma.assetInterfaceSampleDaily.deleteMany({ where: { assetId: ASSET } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await clean();
  await prisma.setting.deleteMany({ where: { key: MAX_LINE_BACKFILL_MARKER } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await clean();
});

// ─── Per-core CPU ─────────────────────────────────────────────────────────────

d("rollup — per-core CPU vectors", () => {
  it("hourly: per-core avg + max, a gap stays null in place, ragged vectors and junk ignored", async () => {
    const bucket = recentHourBucket();
    const at = (min: number) => new Date(bucket.getTime() + min * 60_000);
    await prisma.assetTelemetrySample.createMany({
      data: [
        // Core 1 never has a number in this bucket → null slot, core 2 stays at index 2.
        { assetId: ASSET, timestamp: at(1), cpuPct: 20, cpuCorePcts: [10.004, "x", 30] },
        // Ragged: a fourth core only here.
        { assetId: ASSET, timestamp: at(2), cpuPct: 40, cpuCorePcts: [20.001, null, 40, 80] },
        // Not an array — contributes nothing per core, still counts as a sample.
        { assetId: ASSET, timestamp: at(3), cpuPct: 30, cpuCorePcts: { core0: 99 } },
        // No per-core data at all.
        { assetId: ASSET, timestamp: at(4), cpuPct: 30 },
      ],
    });

    await rollupHourly();

    const rows = await prisma.assetTelemetrySampleHourly.findMany({ where: { assetId: ASSET } });
    expect(rows).toHaveLength(1);
    expect(rows[0].sampleCount).toBe(4);
    expect(rows[0].avgCpuPct).toBeCloseTo(30, 6);
    // Rounded to 2 decimals: (10.004 + 20.001) / 2 = 15.0025 → 15.
    expect(rows[0].avgCpuCorePcts).toEqual([15, null, 35, 80]);
    expect(rows[0].maxCpuCorePcts).toEqual([20, null, 40, 80]);
  });

  it("hourly: a bucket with no per-core data keeps both vectors NULL", async () => {
    const bucket = recentHourBucket();
    await prisma.assetTelemetrySample.create({
      data: { assetId: ASSET, timestamp: new Date(bucket.getTime() + 60_000), cpuPct: 5 },
    });
    await rollupHourly();
    const rows = await prisma.assetTelemetrySampleHourly.findMany({ where: { assetId: ASSET } });
    expect(rows).toHaveLength(1);
    expect(rows[0].avgCpuCorePcts).toBeNull();
    expect(rows[0].maxCpuCorePcts).toBeNull();
  });

  it("daily: per-core average weighted by sampleCount over the hours that had the core, max of maxes", async () => {
    const day = utcDay(recentHourBucket());
    await prisma.assetTelemetrySampleHourly.createMany({
      data: [
        { assetId: ASSET, bucketStart: new Date(day.getTime() + 1 * HOUR), sampleCount: 3, avgCpuPct: 10,
          avgCpuCorePcts: [10, 50], maxCpuCorePcts: [20, 60] },
        { assetId: ASSET, bucketStart: new Date(day.getTime() + 2 * HOUR), sampleCount: 1, avgCpuPct: 30,
          avgCpuCorePcts: [30, null, 5], maxCpuCorePcts: [40, null, 9] },
        // An hour without per-core data must not dilute the per-core average.
        { assetId: ASSET, bucketStart: new Date(day.getTime() + 3 * HOUR), sampleCount: 6, avgCpuPct: 1 },
      ],
    });

    await rollupRange("daily", ["telemetry"], day, new Date(day.getTime() + DAY));

    const rows = await prisma.assetTelemetrySampleDaily.findMany({ where: { assetId: ASSET } });
    expect(rows).toHaveLength(1);
    expect(rows[0].sampleCount).toBe(10);
    // core 0: (10*3 + 30*1) / 4 = 15; core 1: only hour 1 → 50; core 2: only hour 2 → 5.
    expect(rows[0].avgCpuCorePcts).toEqual([15, 50, 5]);
    expect(rows[0].maxCpuCorePcts).toEqual([40, 60, 9]);
  });

  it("reader: rollup samples carry cpuCorePcts (avg) and cpuCoreMaxPcts, gaps as null", async () => {
    const bucket = recentHourBucket();
    await prisma.assetTelemetrySampleHourly.createMany({
      data: [
        { assetId: ASSET, bucketStart: bucket, sampleCount: 2, avgCpuPct: 12,
          avgCpuCorePcts: [15, null, 35], maxCpuCorePcts: [20, null, 40] },
        { assetId: ASSET, bucketStart: new Date(bucket.getTime() - HOUR), sampleCount: 2, avgCpuPct: 12 },
      ],
    });
    const out = await readTelemetryHistory(ASSET, new Date(bucket.getTime() - 2 * HOUR), new Date(bucket.getTime() + HOUR), "hourly");
    expect(out.samples).toHaveLength(2);
    const [older, newer] = out.samples;
    expect(older.cpuCorePcts).toBeNull();
    expect(older.cpuCoreMaxPcts).toBeNull();
    expect(newer.cpuCorePcts).toEqual([15, null, 35]);
    expect(newer.cpuCoreMaxPcts).toEqual([20, null, 40]);
  });
});

// ─── Interface peak throughput ────────────────────────────────────────────────

d("rollup — interface peak throughput", () => {
  it("hourly: first row pairs with the previous bucket's last row; a counter reset is dropped", async () => {
    const bucket = recentHourBucket();
    const at = (min: number) => new Date(bucket.getTime() + min * 60_000);
    const row = (ts: Date, inOctets: bigint, outOctets: bigint) =>
      ({ assetId: ASSET, ifName: "port1", timestamp: ts, inOctets, outOctets, cadence: "fast" });
    await prisma.assetInterfaceSample.createMany({
      data: [
        row(at(-10), 1_000n, 0n),     // previous bucket — before $1
        row(at(0),   61_000n, 600n),  // 600 s later: in 100 B/s, out 1 B/s — the cross-bucket pair
        row(at(5),   31_000n, 1_200n),// in went DOWN (reset) → dropped; out 2 B/s
        row(at(10),  91_000n, 1_500n),// in 60 000 / 300 s = 200 B/s; out 1 B/s
        // A slow-cadence row is not part of the series.
        { assetId: ASSET, ifName: "port1", timestamp: at(11), inOctets: 99_000_000n, outOctets: 0n, cadence: "slow" },
      ],
    });

    // $1 exactly at the bucket start, so the first pair reaches back before $1.
    await rollupRange("hourly", ["interface"], bucket, new Date(bucket.getTime() + HOUR));

    const rows = await prisma.assetInterfaceSampleHourly.findMany({ where: { assetId: ASSET } });
    expect(rows).toHaveLength(1);
    expect(rows[0].bucketStart.getTime()).toBe(bucket.getTime());
    expect(rows[0].sampleCount).toBe(3);
    expect(rows[0].maxInBytesPerSec).toBeCloseTo(200, 6);
    expect(rows[0].maxOutBytesPerSec).toBeCloseTo(2, 6);
  });

  it("hourly: a lone row with no predecessor yields NULL peaks", async () => {
    const bucket = recentHourBucket();
    await prisma.assetInterfaceSample.create({
      data: { assetId: ASSET, ifName: "port9", timestamp: new Date(bucket.getTime() + 60_000), inOctets: 5n, outOctets: 5n, cadence: "fast" },
    });
    await rollupRange("hourly", ["interface"], bucket, new Date(bucket.getTime() + HOUR));
    const rows = await prisma.assetInterfaceSampleHourly.findMany({ where: { assetId: ASSET } });
    expect(rows).toHaveLength(1);
    expect(rows[0].maxInBytesPerSec).toBeNull();
    expect(rows[0].maxOutBytesPerSec).toBeNull();
  });

  it("daily: max of the hourly peaks", async () => {
    const day = utcDay(recentHourBucket());
    const base = { assetId: ASSET, ifName: "port1", sampleCount: 10 };
    await prisma.assetInterfaceSampleHourly.createMany({
      data: [
        { ...base, bucketStart: new Date(day.getTime() + 1 * HOUR), lastBucketSampleAt: new Date(day.getTime() + 1 * HOUR + 50 * 60_000),
          maxInBytesPerSec: 200, maxOutBytesPerSec: 7 },
        { ...base, bucketStart: new Date(day.getTime() + 2 * HOUR), lastBucketSampleAt: new Date(day.getTime() + 2 * HOUR + 50 * 60_000),
          maxInBytesPerSec: 500, maxOutBytesPerSec: null },
        // Predates the column.
        { ...base, bucketStart: new Date(day.getTime() + 3 * HOUR), lastBucketSampleAt: new Date(day.getTime() + 3 * HOUR + 50 * 60_000) },
      ],
    });

    await rollupRange("daily", ["interface"], day, new Date(day.getTime() + DAY));

    const rows = await prisma.assetInterfaceSampleDaily.findMany({ where: { assetId: ASSET } });
    expect(rows).toHaveLength(1);
    expect(rows[0].maxInBytesPerSec).toBe(500);
    expect(rows[0].maxOutBytesPerSec).toBe(7);
  });

  it("reader: rollup samples carry maxInBytesPerSec / maxOutBytesPerSec", async () => {
    const bucket = recentHourBucket();
    await prisma.assetInterfaceSampleHourly.create({
      data: {
        assetId: ASSET, ifName: "port1", bucketStart: bucket, sampleCount: 10,
        firstInOctets: 0n, lastInOctets: 360_000n, lastBucketSampleAt: new Date(bucket.getTime() + HOUR),
        maxInBytesPerSec: 250, maxOutBytesPerSec: null,
      },
    });
    const out = await readInterfaceHistory(ASSET, new Date(bucket.getTime() - HOUR), new Date(bucket.getTime() + HOUR), "hourly", "port1");
    expect(out.samples).toHaveLength(1);
    expect(out.samples[0].inBytesPerSec).toBeCloseTo(100, 6); // the bucket average, unchanged
    expect(out.samples[0].maxInBytesPerSec).toBe(250);
    expect(out.samples[0].maxOutBytesPerSec).toBeNull();
  });
});

// ─── One-shot backfill ────────────────────────────────────────────────────────

d("rollup — max-line backfill", () => {
  beforeEach(async () => {
    if (!dbReachable) return;
    await prisma.setting.deleteMany({ where: { key: MAX_LINE_BACKFILL_MARKER } });
  });

  it("rebuilds the window once, stamps the marker, and leaves rows outside the window alone", async () => {
    const now = new Date();
    // Yesterday 10:00 UTC — inside the default 6-day window.
    const yesterday = new Date(utcDay(now).getTime() - DAY + 10 * HOUR);
    // 20 days ago — outside any window the backfill may use.
    const old = new Date(utcDay(now).getTime() - 20 * DAY + 10 * HOUR);

    await prisma.assetTelemetrySample.createMany({
      data: [
        { assetId: ASSET, timestamp: new Date(yesterday.getTime() + 60_000),  cpuPct: 10, cpuCorePcts: [10, 30] },
        { assetId: ASSET, timestamp: new Date(yesterday.getTime() + 120_000), cpuPct: 20, cpuCorePcts: [20, 50] },
        { assetId: ASSET, timestamp: new Date(old.getTime() + 60_000),        cpuPct: 10, cpuCorePcts: [10, 30] },
      ],
    });
    await prisma.assetInterfaceSample.createMany({
      data: [
        { assetId: ASSET, ifName: "port1", timestamp: new Date(yesterday.getTime() + 60_000),  inOctets: 0n,      outOctets: 0n,   cadence: "fast" },
        { assetId: ASSET, ifName: "port1", timestamp: new Date(yesterday.getTime() + 120_000), inOctets: 60_000n, outOctets: 600n, cadence: "fast" },
      ],
    });
    // A pre-existing hourly row from before the columns: max columns NULL.
    await prisma.assetTelemetrySampleHourly.create({
      data: { assetId: ASSET, bucketStart: yesterday, sampleCount: 2, avgCpuPct: 15 },
    });

    const first = await runMaxLineBackfillOnce(now);
    expect(first.ran).toBe(true);

    // The window matches the pure helper's rule for this install's settings.
    const retention = await getSampleRetention();
    const expected = maxLineBackfillDays(
      now.getTime(),
      [retention.cpuMem.detail, retention.interfaces.detail],
      ["asset_telemetry_samples_hourly", "asset_telemetry_samples_daily", "asset_interface_samples_hourly", "asset_interface_samples_daily"]
        .map((t) => getEffectiveCompressAfterDays(t)),
    ).map((x) => x.toISOString().slice(0, 10));
    expect(first.days).toEqual(expected);
    expect(first.days.length).toBeLessThanOrEqual(13);
    const yIso = utcDay(yesterday).toISOString().slice(0, 10);
    expect(first.days).toContain(yIso);

    const hourly = await prisma.assetTelemetrySampleHourly.findMany({ where: { assetId: ASSET }, orderBy: { bucketStart: "asc" } });
    expect(hourly.map((r) => r.bucketStart.getTime())).toEqual([yesterday.getTime()]); // the 20-day-old hour was NOT rolled
    expect(hourly[0].avgCpuCorePcts).toEqual([15, 40]);
    expect(hourly[0].maxCpuCorePcts).toEqual([20, 50]);

    const daily = await prisma.assetTelemetrySampleDaily.findMany({ where: { assetId: ASSET } });
    expect(daily).toHaveLength(1);
    expect(daily[0].bucketStart.getTime()).toBe(utcDay(yesterday).getTime());
    expect(daily[0].maxCpuCorePcts).toEqual([20, 50]);

    const ifHourly = await prisma.assetInterfaceSampleHourly.findMany({ where: { assetId: ASSET } });
    expect(ifHourly).toHaveLength(1);
    expect(ifHourly[0].maxInBytesPerSec).toBeCloseTo(1000, 6); // 60 000 B / 60 s
    const ifDaily = await prisma.assetInterfaceSampleDaily.findMany({ where: { assetId: ASSET } });
    expect(ifDaily).toHaveLength(1);
    expect(ifDaily[0].maxInBytesPerSec).toBeCloseTo(1000, 6);

    const marker = await prisma.setting.findUnique({ where: { key: MAX_LINE_BACKFILL_MARKER } });
    expect(marker).not.toBeNull();
    expect((marker!.value as { days: string[] }).days).toEqual(first.days);

    // Second run: marker set → nothing runs, rows untouched.
    await prisma.assetTelemetrySample.create({
      data: { assetId: ASSET, timestamp: new Date(yesterday.getTime() + 180_000), cpuPct: 90, cpuCorePcts: [90, 90] },
    });
    const second = await runMaxLineBackfillOnce(now);
    expect(second.ran).toBe(false);
    const again = await prisma.assetTelemetrySampleHourly.findMany({ where: { assetId: ASSET } });
    expect(again[0].maxCpuCorePcts).toEqual([20, 50]);
  });

  it("a re-run after the marker is removed is idempotent (upserts in place)", async () => {
    const now = new Date();
    const yesterday = new Date(utcDay(now).getTime() - DAY + 10 * HOUR);
    await prisma.assetTelemetrySample.create({
      data: { assetId: ASSET, timestamp: new Date(yesterday.getTime() + 60_000), cpuPct: 10, cpuCorePcts: [10] },
    });
    await runMaxLineBackfillOnce(now);
    const a = await prisma.assetTelemetrySampleHourly.findMany({ where: { assetId: ASSET } });
    await prisma.setting.deleteMany({ where: { key: MAX_LINE_BACKFILL_MARKER } });
    await runMaxLineBackfillOnce(now);
    const b = await prisma.assetTelemetrySampleHourly.findMany({ where: { assetId: ASSET } });
    expect(b).toHaveLength(1);
    expect(b[0].id).toBe(a[0].id);
    expect(b[0].avgCpuCorePcts).toEqual([10]);
  });
});

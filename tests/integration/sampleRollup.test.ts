/**
 * tests/integration/sampleRollup.test.ts
 *
 * Integration tests for src/services/sampleRollupService.ts —
 * `rollupHourly` / `rollupDaily`. The rollup writer is entirely DB-driven
 * (one INSERT...ON CONFLICT DO UPDATE per source per tier aggregating detail
 * samples into hourly buckets, then hourly into daily), so this exercises the
 * real SQL against a live Postgres rather than mocking.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 *
 * Coverage:
 *   - GAUGE table (asset_monitor_samples): sampleCount + success/failure split +
 *     avg/min/max over successful samples within one hour bucket.
 *   - COUNTER table (asset_ipsec_tunnel_samples): first/last byte counter
 *     endpoints + lastBucketSampleAt (the rate-derivation contract), status
 *     counts, and the cadence='fast' gate.
 *   - IDEMPOTENCY: re-running the same window rewrites buckets in place
 *     (ON CONFLICT DO UPDATE) — no duplicate rows.
 *   - rollupDaily reads from *_hourly (not detail) and aggregates a day bucket
 *     from seeded hourly rows.
 */

import { it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { rollupHourly, rollupDaily } from "../../src/services/sampleRollupService.js";

const d = dbDescribe;

// A fixed asset id keeps the rollup GROUP BY deterministic. The sample tables
// carry assetId but no FK to Asset (TimescaleDB hypertables — see polaris-domain-model -> samples-rollups.md
// tiered-sample-retention), so we don't need a real Asset row.
const ASSET = "00000000-0000-0000-0000-0000000000aa";

// Anchor bucket: top of an hour, ~30 min ago, so it sits inside both the 2-hour
// hourly lookback and the 2-day daily lookback windows used by the service.
function recentHourBucket(): Date {
  const d = new Date(Date.now() - 30 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  return d;
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  // Only the tables these tests touch. Detail + both rollup tiers, scoped to
  // our synthetic asset so we never collide with anything else in the DB.
  await prisma.assetMonitorSample.deleteMany({ where: { assetId: ASSET } });
  await prisma.assetMonitorSampleHourly.deleteMany({ where: { assetId: ASSET } });
  await prisma.assetMonitorSampleDaily.deleteMany({ where: { assetId: ASSET } });
  await prisma.assetIpsecTunnelSample.deleteMany({ where: { assetId: ASSET } });
  await prisma.assetIpsecTunnelSampleHourly.deleteMany({ where: { assetId: ASSET } });
  await prisma.assetIpsecTunnelSampleDaily.deleteMany({ where: { assetId: ASSET } });
});

// ─── GAUGE: asset_monitor_samples → hourly ─────────────────────────────────────

d("rollup — ICMP burst packet totals", () => {
  it("sums packets from sweep rows, and leaves the row counts primary-only", async () => {
    // The two column families describe different transports and must not bleed
    // into each other. sampleCount / successCount / failureCount are about the
    // operator's configured status poll (probeOutageService reads them to decide
    // what an outage looked like); packetsSent / packetsReceived are about the
    // ICMP sweep. Before this, the rollup excluded probeKind='icmp' from the
    // scan entirely, so the packet columns had nothing to sum.
    const bucket = recentHourBucket();
    await prisma.assetMonitorSample.createMany({
      data: [
        // Status poll: 2 samples, 1 failed.
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 1 * 60_000), success: true,  responseTimeMs: 12 },
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 2 * 60_000), success: false, responseTimeMs: null },
        // Sweep: three bursts, 15 sent / 9 received.
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 3 * 60_000), success: true, responseTimeMs: null, probeKind: "icmp", packetsSent: 5, packetsReceived: 5 },
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 4 * 60_000), success: true, responseTimeMs: null, probeKind: "icmp", packetsSent: 5, packetsReceived: 3 },
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 5 * 60_000), success: true, responseTimeMs: null, probeKind: "icmp", packetsSent: 5, packetsReceived: 1 },
      ],
    });

    await rollupHourly();

    const row = (await prisma.assetMonitorSampleHourly.findMany({ where: { assetId: ASSET } }))[0]!;
    // Row counts see ONLY the status poll — three sweep rows did not inflate them.
    expect(row.sampleCount).toBe(2);
    expect(row.successCount).toBe(1);
    expect(row.failureCount).toBe(1);
    // ...and the sweep's NULL response times did not touch the RTT aggregates.
    expect(row.avgResponseTimeMs).toBeCloseTo(12, 6);
    // Packets see ONLY the sweep: 40% loss, which no row-count ratio here shows.
    expect(row.packetsSent).toBe(15);
    expect(row.packetsReceived).toBe(9);
  });

  it("leaves packet columns NULL when the bucket held no sweep rows", async () => {
    // NULL rather than 0 is load-bearing: 0 sent would read as a 0%-loss bucket
    // instead of a bucket with no packet data, and a reader has to be able to
    // fall back to the row ratio.
    const bucket = recentHourBucket();
    await prisma.assetMonitorSample.createMany({
      data: [
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 1 * 60_000), success: true, responseTimeMs: 10 },
      ],
    });

    await rollupHourly();

    const row = (await prisma.assetMonitorSampleHourly.findMany({ where: { assetId: ASSET } }))[0]!;
    expect(row.packetsSent).toBeNull();
    expect(row.packetsReceived).toBeNull();
  });

  it("reads a fully-dark sweep as every packet lost, not as no data", async () => {
    const bucket = recentHourBucket();
    await prisma.assetMonitorSample.createMany({
      data: [
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 1 * 60_000), success: false, responseTimeMs: null, probeKind: "icmp", packetsSent: 5, packetsReceived: 0 },
      ],
    });

    await rollupHourly();

    const row = (await prisma.assetMonitorSampleHourly.findMany({ where: { assetId: ASSET } }))[0]!;
    expect(row.packetsSent).toBe(5);
    expect(row.packetsReceived).toBe(0);
  });

  it("daily SUMs the packet totals across hourly buckets", async () => {
    const bucket = recentHourBucket();
    await prisma.assetMonitorSample.createMany({
      data: [
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 1 * 60_000), success: true, responseTimeMs: null, probeKind: "icmp", packetsSent: 10, packetsReceived: 7 },
      ],
    });
    await rollupHourly();
    await rollupDaily();

    const day = (await prisma.assetMonitorSampleDaily.findMany({ where: { assetId: ASSET } }))[0]!;
    expect(day.packetsSent).toBe(10);
    expect(day.packetsReceived).toBe(7);
  });

  it("keeps a day NULL when every hourly bucket predates the sweep", async () => {
    // Deliberately NOT coalesced to 0 the way dependencyFailureCount is: there
    // 0 is a truthful "no dependency failures", here it would claim a 0%-loss
    // day for a day nobody measured.
    const bucket = recentHourBucket();
    await prisma.assetMonitorSample.createMany({
      data: [
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 1 * 60_000), success: true, responseTimeMs: 10 },
      ],
    });
    await rollupHourly();
    await rollupDaily();

    const day = (await prisma.assetMonitorSampleDaily.findMany({ where: { assetId: ASSET } }))[0]!;
    expect(day.packetsSent).toBeNull();
    expect(day.packetsReceived).toBeNull();
  });
});

d("rollupHourly — gauge table (asset_monitor_samples)", () => {
  it("aggregates sampleCount + success/failure + avg/min/max over successes", async () => {
    const bucket = recentHourBucket();
    // Four samples in one hour bucket: three successes (10/20/30ms) + one failure.
    // avg over successes = 20, min = 10, max = 30. The failure carries a
    // responseTimeMs that must be EXCLUDED from avg/min/max (success-only).
    await prisma.assetMonitorSample.createMany({
      data: [
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 1 * 60_000), success: true,  responseTimeMs: 10 },
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 2 * 60_000), success: true,  responseTimeMs: 20 },
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 3 * 60_000), success: true,  responseTimeMs: 30 },
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 4 * 60_000), success: false, responseTimeMs: 9999 },
      ],
    });

    await rollupHourly();

    const rows = await prisma.assetMonitorSampleHourly.findMany({ where: { assetId: ASSET } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.bucketStart.getTime()).toBe(bucket.getTime());
    expect(row.sampleCount).toBe(4);
    expect(row.successCount).toBe(3);
    expect(row.failureCount).toBe(1);
    expect(row.avgResponseTimeMs).toBeCloseTo(20, 6);
    expect(row.minResponseTimeMs).toBe(10); // failure's 9999 excluded
    expect(row.maxResponseTimeMs).toBe(30); // failure's 9999 excluded
  });

  it("counts dependency-suppressed failures separately, hourly and daily", async () => {
    // Two failures in one bucket: one taken while the parent was dark, one not.
    // The bucket is NOT a dependency outage — a chart greys a bucket only when
    // every failure in it was explained — but the count has to survive both
    // rollup tiers, and the daily re-aggregate has to COALESCE the NULLs that
    // pre-column hourly buckets carry.
    const bucket = recentHourBucket();
    await prisma.assetMonitorSample.createMany({
      data: [
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 1 * 60_000), success: true,  responseTimeMs: 10 },
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 2 * 60_000), success: false, dependencyDown: true },
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 3 * 60_000), success: false },
      ],
    });

    await rollupHourly();
    const hourly = await prisma.assetMonitorSampleHourly.findMany({ where: { assetId: ASSET } });
    expect(hourly).toHaveLength(1);
    expect(hourly[0].failureCount).toBe(2);
    expect(hourly[0].dependencyFailureCount).toBe(1);

    // A neighbouring bucket left at NULL (what every bucket rolled up before
    // this column looks like) must not wipe the day's count.
    await prisma.$executeRawUnsafe(
      `UPDATE "asset_monitor_samples_hourly" SET "dependencyFailureCount" = NULL
       WHERE "assetId" = $1 AND "bucketStart" <> $2`,
      ASSET, bucket,
    );
    await rollupDaily();
    const daily = await prisma.assetMonitorSampleDaily.findMany({ where: { assetId: ASSET } });
    expect(daily.length).toBeGreaterThan(0);
    expect(daily.reduce((n, r) => n + (r.dependencyFailureCount ?? 0), 0)).toBe(1);
  });

  it("is idempotent — re-running rewrites the bucket in place, no duplicate rows", async () => {
    const bucket = recentHourBucket();
    await prisma.assetMonitorSample.createMany({
      data: [
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 1 * 60_000), success: true, responseTimeMs: 40 },
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 2 * 60_000), success: true, responseTimeMs: 60 },
      ],
    });

    await rollupHourly();
    const first = await prisma.assetMonitorSampleHourly.findMany({ where: { assetId: ASSET } });
    expect(first).toHaveLength(1);
    const firstId = first[0].id;

    // Second run over the same window: ON CONFLICT DO UPDATE must rewrite the
    // same logical bucket — exactly one row, same aggregate values. (The id
    // column is gen_random_uuid() in the INSERT but ON CONFLICT keeps the
    // existing row's id, so the surviving row's id is unchanged.)
    await rollupHourly();
    const second = await prisma.assetMonitorSampleHourly.findMany({ where: { assetId: ASSET } });
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(firstId);
    expect(second[0].sampleCount).toBe(2);
    expect(second[0].avgResponseTimeMs).toBeCloseTo(50, 6);
  });
});

// ─── COUNTER: asset_ipsec_tunnel_samples → hourly ──────────────────────────────

d("rollupHourly — counter table (asset_ipsec_tunnel_samples)", () => {
  it("captures first/last counter endpoints + lastBucketSampleAt + status counts", async () => {
    const bucket = recentHourBucket();
    const t1 = new Date(bucket.getTime() + 1 * 60_000);
    const t2 = new Date(bucket.getTime() + 2 * 60_000);
    const t3 = new Date(bucket.getTime() + 3 * 60_000); // last sample in bucket

    // Increasing cumulative byte counters across the bucket. first = earliest
    // (t1), last = latest (t3). cadence MUST be 'fast' — the rollup gates on it.
    await prisma.assetIpsecTunnelSample.createMany({
      data: [
        { assetId: ASSET, tunnelName: "tun0", timestamp: t1, status: "up",   incomingBytes: 1000n, outgoingBytes: 500n,  cadence: "fast" },
        { assetId: ASSET, tunnelName: "tun0", timestamp: t2, status: "up",   incomingBytes: 1500n, outgoingBytes: 750n,  cadence: "fast" },
        { assetId: ASSET, tunnelName: "tun0", timestamp: t3, status: "down", incomingBytes: 2000n, outgoingBytes: 1000n, cadence: "fast" },
      ],
    });

    await rollupHourly();

    const rows = await prisma.assetIpsecTunnelSampleHourly.findMany({ where: { assetId: ASSET } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.tunnelName).toBe("tun0");
    expect(row.bucketStart.getTime()).toBe(bucket.getTime());
    expect(row.sampleCount).toBe(3);
    // Counter endpoints — first = earliest timestamp, last = latest timestamp.
    expect(row.firstIncomingBytes).toBe(1000n);
    expect(row.lastIncomingBytes).toBe(2000n);
    expect(row.firstOutgoingBytes).toBe(500n);
    expect(row.lastOutgoingBytes).toBe(1000n);
    // lastBucketSampleAt = MAX(timestamp) — the right edge for rate denominator.
    expect(row.lastBucketSampleAt.getTime()).toBe(t3.getTime());
    // Status counts: 2 up + 1 down.
    expect(row.statusUpCount).toBe(2);
    expect(row.statusDownCount).toBe(1);
  });

  it("ignores non-fast cadence rows (cadence gate)", async () => {
    const bucket = recentHourBucket();
    // All slow/null cadence → rollup gate excludes them → no hourly row.
    await prisma.assetIpsecTunnelSample.createMany({
      data: [
        { assetId: ASSET, tunnelName: "tun-slow", timestamp: new Date(bucket.getTime() + 1 * 60_000), status: "up", incomingBytes: 10n, cadence: "slow" },
        { assetId: ASSET, tunnelName: "tun-null", timestamp: new Date(bucket.getTime() + 2 * 60_000), status: "up", incomingBytes: 20n, cadence: null },
      ],
    });

    await rollupHourly();

    const rows = await prisma.assetIpsecTunnelSampleHourly.findMany({ where: { assetId: ASSET } });
    expect(rows).toHaveLength(0);
  });
});

// ─── DAILY: reads from *_hourly, not detail ────────────────────────────────────

d("rollupDaily — builds the day bucket from seeded hourly rows", () => {
  it("monitor daily SUMs counts + weighted-avgs + MIN/MAX across hourly buckets", async () => {
    // Two hourly buckets on the same day. Seed the HOURLY tier directly — the
    // daily rollup must read these, not the (empty) detail table.
    const day = recentHourBucket();
    day.setUTCHours(0, 0, 0, 0); // start of the UTC day (date_trunc('day') is UTC)
    const h1 = new Date(day.getTime() + 1 * 3600_000);
    const h2 = new Date(day.getTime() + 2 * 3600_000);

    await prisma.assetMonitorSampleHourly.createMany({
      data: [
        // bucket h1: 3 samples, 3 successes, avg 10, min 5, max 15
        { assetId: ASSET, bucketStart: h1, sampleCount: 3, successCount: 3, failureCount: 0, avgResponseTimeMs: 10, minResponseTimeMs: 5, maxResponseTimeMs: 15 },
        // bucket h2: 1 sample, 1 success, avg 30, min 30, max 30
        { assetId: ASSET, bucketStart: h2, sampleCount: 1, successCount: 1, failureCount: 0, avgResponseTimeMs: 30, minResponseTimeMs: 30, maxResponseTimeMs: 30 },
      ],
    });

    await rollupDaily();

    const rows = await prisma.assetMonitorSampleDaily.findMany({ where: { assetId: ASSET } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.bucketStart.getTime()).toBe(day.getTime());
    expect(row.sampleCount).toBe(4);     // 3 + 1
    expect(row.successCount).toBe(4);
    expect(row.failureCount).toBe(0);
    // Weighted avg by successCount: (10*3 + 30*1) / 4 = 15.
    expect(row.avgResponseTimeMs).toBeCloseTo(15, 6);
    expect(row.minResponseTimeMs).toBe(5);  // MIN across buckets
    expect(row.maxResponseTimeMs).toBe(30); // MAX across buckets
  });

  it("is idempotent at the daily tier too", async () => {
    const day = recentHourBucket();
    day.setUTCHours(0, 0, 0, 0);
    const h1 = new Date(day.getTime() + 1 * 3600_000);
    await prisma.assetMonitorSampleHourly.create({
      data: { assetId: ASSET, bucketStart: h1, sampleCount: 2, successCount: 2, failureCount: 0, avgResponseTimeMs: 100, minResponseTimeMs: 50, maxResponseTimeMs: 150 },
    });

    await rollupDaily();
    const first = await prisma.assetMonitorSampleDaily.findMany({ where: { assetId: ASSET } });
    expect(first).toHaveLength(1);
    const firstId = first[0].id;

    await rollupDaily();
    const second = await prisma.assetMonitorSampleDaily.findMany({ where: { assetId: ASSET } });
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(firstId);
    expect(second[0].sampleCount).toBe(2);
    expect(second[0].avgResponseTimeMs).toBeCloseTo(100, 6);
  });
});

// ─── EVERY statement runs ──────────────────────────────────────────────────────
//
// runOne() logs a failed statement and carries on with the next table, so a
// broken builder fails silently: from 2026-10-21 (380b56ee3) the interface
// hourly INSERT listed one more expression than target columns and every
// hourly tick dropped it, leaving 30-day interface charts with nothing to read.
// Each statement is executed here against the real schema; any error log fails.

d("rollup statements — every source, both tiers", () => {
  it("runs every hourly and daily statement without an error", async () => {
    const { logger } = await import("../../src/utils/logger.js");
    const spy = vi.spyOn(logger, "error");
    try {
      await rollupHourly();
      await rollupDaily();
      const failures = spy.mock.calls.map((c) => (c[0] as { source?: string; tier?: string }) ?? {});
      expect(failures.map((f) => `${f.tier}:${f.source}`)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("rolls interface counters into an hourly bucket", async () => {
    await prisma.assetInterfaceSample.deleteMany({ where: { assetId: ASSET } });
    await prisma.assetInterfaceSampleHourly.deleteMany({ where: { assetId: ASSET } });
    const bucket = recentHourBucket();
    const t1 = new Date(bucket.getTime() + 1 * 60_000);
    const t2 = new Date(bucket.getTime() + 2 * 60_000);
    await prisma.assetInterfaceSample.createMany({
      data: [
        { assetId: ASSET, ifName: "port1", timestamp: t1, inOctets: 1000n, outOctets: 100n, ipv6Address: "2001:db8::1", macAddress: "00:11:22:33:44:55", cadence: "fast" },
        { assetId: ASSET, ifName: "port1", timestamp: t2, inOctets: 7000n, outOctets: 400n, ipv6Address: "2001:db8::1", macAddress: "00:11:22:33:44:55", cadence: "fast" },
      ],
    });

    await rollupHourly();

    const rows = await prisma.assetInterfaceSampleHourly.findMany({ where: { assetId: ASSET } });
    expect(rows).toHaveLength(1);
    expect(rows[0].firstInOctets).toBe(1000n);
    expect(rows[0].lastInOctets).toBe(7000n);
    // The two columns the duplicated expression had shifted out of place.
    expect(rows[0].lastIpv6Address).toBe("2001:db8::1");
    expect(rows[0].lastMacAddress).toBe("00:11:22:33:44:55");
    await prisma.assetInterfaceSample.deleteMany({ where: { assetId: ASSET } });
    await prisma.assetInterfaceSampleHourly.deleteMany({ where: { assetId: ASSET } });
  });
});

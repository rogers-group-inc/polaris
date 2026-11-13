/**
 * tests/unit/sampleHistoryService.test.ts — the chart history readers no
 * other suite reaches, and the rollup-tier translations (CQ-T010).
 *
 * Complements, does not repeat:
 *   - sampleHistoryAnchor.test.ts — the detail-tier row anchor
 *     (readDetailWithAnchor) through the interface / storage / sensor /
 *     telemetry / monitor readers
 *   - monitorHistoryLoss.test.ts — readMonitorHistory's loss line,
 *     rollupLossSeries, monitorLossBucketMs
 *   - lastMonitorSuccessAt.test.ts — readLastMonitorSuccessAt
 *   - pollingHistorySummary.test.ts — readPollingHistorySummary's stitch
 *   - sdwanMembersCollectedAt.test.ts — readSdwanMembers + sdwanMemberLinkState
 *   - integration/sampleRollupMaxLines + sdwanMembersStrip — against a real DB
 *
 * What was unreached: readProcessHistory, readIpsecHistory, readPerfSlaHistory
 * and readPathCheckHistory (no test at all), and the rollup tier of every
 * reader: which table each tier reads, the fetchSince overflow in the bound
 * parameters, BigInt → number at the boundary, the bucket verdicts (IPsec's
 * worst-status tie-break, SD-WAN's down-only-on-majority, a path check's
 * ok-on-tie and rounded hop count), counter-reset rates, and the sensor
 * stats' sample-weighted average over the VISIBLE buckets only.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  ANCHOR_ROWS_GAUGE,
  ANCHOR_ROWS_RATE,
  DETAIL_ANCHOR_CAP_MS,
  readHardwareSensorHistory,
  readIpsecHistory,
  readPathCheckHistory,
  readPerfSlaHistory,
  readProcessHistory,
  readStorageHistory,
} from "../../src/services/sampleHistoryService.js";

const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const at = (min: number) => new Date(T0 + min * 60_000);
const since = at(0);
const until = at(60);

const raw = () => stubbed(prisma.$queryRawUnsafe);
const sqlOf = (i = 0) => String(raw().mock.calls[i]![0]);
const paramsOf = (i = 0) => raw().mock.calls[i]!.slice(1);

beforeEach(() => {
  resetDbStub();
  raw().mockResolvedValue([]);
});

it("the anchor constants are what the readers promise", () => {
  expect(DETAIL_ANCHOR_CAP_MS).toBe(2 * 60 * 60 * 1000);
  expect(ANCHOR_ROWS_RATE).toBe(2);
  expect(ANCHOR_ROWS_GAUGE).toBe(1);
});

describe("readProcessHistory", () => {
  it("detail: one program's rows, RSS as a number, the instance count kept", async () => {
    stubbed(prisma.assetProcessSample.findMany).mockResolvedValue([
      { timestamp: at(1), cpuPct: 12.5, memRssBytes: 1048576n, instanceCount: 3 },
      { timestamp: at(2), cpuPct: null, memRssBytes: null, instanceCount: null },
    ]);
    const r = await readProcessHistory("a1", since, until, "detail", "postgres");
    expect(r.samples).toEqual([
      { timestamp: at(1), cpuPct: 12.5, memRssBytes: 1048576, instanceCount: 3 },
      { timestamp: at(2), cpuPct: null, memRssBytes: null, instanceCount: null },
    ]);
    expect(prisma.assetProcessSample.findMany).toHaveBeenCalledTimes(1);
    expect(stubbed(prisma.assetProcessSample.findMany).mock.calls[0]![0]).toMatchObject({
      where: { assetId: "a1", name: "postgres", timestamp: { gte: since, lte: until } },
      orderBy: { timestamp: "asc" },
    });
  });

  it("detail with a lookback: one anchor row, prepended", async () => {
    const fetchSince = at(-5);
    stubbed(prisma.assetProcessSample.findMany).mockImplementation(async (args: any) =>
      args.take ? [{ timestamp: at(-30), cpuPct: 1, memRssBytes: 1n, instanceCount: 1 }] : [{ timestamp: at(1), cpuPct: 2, memRssBytes: 2n, instanceCount: 1 }]);
    const r = await readProcessHistory("a1", since, until, "detail", "nginx", fetchSince);
    expect(r.samples.map((s) => s.cpuPct)).toEqual([1, 2]);
    const anchorCall = stubbed(prisma.assetProcessSample.findMany).mock.calls.find((c) => c[0].take)![0];
    expect(anchorCall).toMatchObject({ take: 1, orderBy: { timestamp: "desc" }, where: { timestamp: { lt: fetchSince, gte: new Date(since.getTime() - DETAIL_ANCHOR_CAP_MS) } } });
  });

  it("hourly: reads the hourly rollup from fetchSince, averages as the value, spread alongside", async () => {
    raw().mockResolvedValue([{
      bucketStart: at(0), sampleCount: 60, avgCpuPct: 10, minCpuPct: 2, maxCpuPct: 40,
      avgMemRssBytes: 2000n, minMemRssBytes: 1000n, maxMemRssBytes: 3000n,
    }]);
    const r = await readProcessHistory("a1", since, until, "hourly", "java", at(-60));
    expect(sqlOf()).toContain('"asset_process_samples_hourly"');
    expect(paramsOf()).toEqual(["a1", "java", at(-60), until]);
    expect(r.samples).toEqual([{
      timestamp: at(0), cpuPct: 10, memRssBytes: 2000, sampleCount: 60,
      minCpuPct: 2, maxCpuPct: 40, minMemRssBytes: 1000, maxMemRssBytes: 3000,
    }]);
  });

  it("daily: reads the daily rollup from since when there is no lookback", async () => {
    await readProcessHistory("a1", since, until, "daily", "java");
    expect(sqlOf()).toContain('"asset_process_samples_daily"');
    expect(paramsOf()).toEqual(["a1", "java", since, until]);
  });
});

describe("readIpsecHistory", () => {
  it("detail: cumulative byte counters as numbers, anchored on TWO rows (a rate stream)", async () => {
    stubbed(prisma.assetIpsecTunnelSample.findMany).mockImplementation(async (args: any) => (args.take ? [] : [
      { timestamp: at(1), status: "up", remoteGateway: "203.0.113.1", incomingBytes: 10n, outgoingBytes: 20n, proxyIdCount: 2 },
    ]));
    const r = await readIpsecHistory("a1", since, until, "detail", "HQ-VPN", at(-5));
    expect(r.samples).toEqual([{ timestamp: at(1), status: "up", remoteGateway: "203.0.113.1", incomingBytes: 10, outgoingBytes: 20, proxyIdCount: 2 }]);
    const anchorCall = stubbed(prisma.assetIpsecTunnelSample.findMany).mock.calls.find((c) => c[0].take)![0];
    expect(anchorCall.take).toBe(2);
  });

  const bucket = (over: Record<string, unknown> = {}) => ({
    bucketStart: at(0), sampleCount: 6,
    statusUpCount: 6, statusDownCount: 0, statusPartialCount: 0, statusDynamicCount: 0,
    firstIncomingBytes: 1000n, lastIncomingBytes: 61000n,
    firstOutgoingBytes: 500n, lastOutgoingBytes: 500n,
    lastRemoteGateway: "198.51.100.7", lastProxyIdCount: 4,
    lastBucketSampleAt: at(1),
    ...over,
  });

  it("rollup: rates from the bucket endpoints, counters omitted", async () => {
    raw().mockResolvedValue([bucket()]);
    const [s] = (await readIpsecHistory("a1", since, until, "hourly", "HQ-VPN")).samples;
    expect(sqlOf()).toContain('"asset_ipsec_tunnel_samples_hourly"');
    expect(s).toMatchObject({ status: "up", incomingBytesPerSec: 1000, outgoingBytesPerSec: 0, remoteGateway: "198.51.100.7", proxyIdCount: 4, sampleCount: 6 });
    expect(s).not.toHaveProperty("incomingBytes");
  });

  it("rollup: a counter reset reads null, a missing endpoint reads null, a zero-length bucket reads 0", async () => {
    raw().mockResolvedValue([
      bucket({ lastIncomingBytes: 10n }),
      bucket({ firstOutgoingBytes: null }),
      bucket({ lastBucketSampleAt: at(0) }),
    ]);
    const s = (await readIpsecHistory("a1", since, until, "daily", "t")).samples;
    expect(sqlOf()).toContain('"asset_ipsec_tunnel_samples_daily"');
    expect(s[0]!.incomingBytesPerSec).toBeNull();
    expect(s[1]!.outgoingBytesPerSec).toBeNull();
    expect(s[2]!.incomingBytesPerSec).toBe(0);
  });

  it("rollup: the bucket's status is the most-seen one, and a tie goes to the WORSE status", async () => {
    raw().mockResolvedValue([
      bucket({ statusUpCount: 5, statusDownCount: 1 }),
      bucket({ statusUpCount: 3, statusDownCount: 3 }),
      bucket({ statusUpCount: 2, statusPartialCount: 2 }),
      bucket({ statusUpCount: 1, statusDynamicCount: 1 }),
      bucket({ statusUpCount: 0, statusDownCount: 2, statusPartialCount: 2 }),
      bucket({ statusUpCount: 0 }),
    ]);
    const s = (await readIpsecHistory("a1", since, until, "hourly", "t")).samples;
    expect(s.map((x) => x.status)).toEqual(["up", "down", "partial", "dynamic", "down", "down"]);
  });
});

describe("readPerfSlaHistory", () => {
  it("detail: one health-check/member pair", async () => {
    stubbed(prisma.assetPerfSlaSample.findMany).mockResolvedValue([
      { timestamp: at(1), state: "up", latencyMs: 12, jitterMs: 1.5, packetLoss: 0 },
    ]);
    const r = await readPerfSlaHistory("a1", since, until, "detail", "VPN-SLA", "wan1");
    expect(r.samples).toEqual([{ timestamp: at(1), state: "up", latencyMs: 12, jitterMs: 1.5, packetLoss: 0 }]);
    expect(stubbed(prisma.assetPerfSlaSample.findMany).mock.calls[0]![0].where).toMatchObject({ assetId: "a1", healthCheck: "VPN-SLA", link: "wan1" });
  });

  it("rollup: averages as the value, spread alongside; down only when down outnumbers up", async () => {
    const b = (up: number, down: number) => ({
      bucketStart: at(0), sampleCount: up + down, stateUpCount: up, stateDownCount: down,
      avgLatencyMs: 20, minLatencyMs: 10, maxLatencyMs: 90,
      avgJitterMs: 2, minJitterMs: 1, maxJitterMs: 5,
      avgPacketLoss: 0.5, minPacketLoss: 0, maxPacketLoss: 3,
    });
    raw().mockResolvedValue([b(5, 1), b(3, 3), b(1, 5)]);
    const r = await readPerfSlaHistory("a1", since, until, "daily", "HC", "wan2", at(-1440));
    expect(sqlOf()).toContain('"asset_perf_sla_samples_daily"');
    expect(paramsOf()).toEqual(["a1", "HC", "wan2", at(-1440), until]);
    expect(r.samples.map((s) => s.state)).toEqual(["up", "up", "down"]);
    expect(r.samples[0]).toMatchObject({ latencyMs: 20, maxLatencyMs: 90, jitterMs: 2, packetLoss: 0.5, maxPacketLoss: 3, stateUpCount: 5, sampleCount: 6 });
  });
});

describe("readPathCheckHistory", () => {
  it("detail: selects the per-run columns and returns the rows as read", async () => {
    const rows = [{ timestamp: at(1), ok: false, latencyMs: null, dnsMs: 3, connectMs: null, tlsMs: null, ttfbMs: null, httpStatus: 503, hopCount: 7, error: "HTTP 503" }];
    stubbed(prisma.assetPathCheckSample.findMany).mockResolvedValue(rows);
    const r = await readPathCheckHistory("a1", since, until, "detail", "chk-1");
    expect(r.samples).toEqual(rows);
    const args = stubbed(prisma.assetPathCheckSample.findMany).mock.calls[0]![0];
    expect(args.where).toMatchObject({ assetId: "a1", checkId: "chk-1" });
    expect(args.select).toMatchObject({ timestamp: true, ok: true, error: true, hopCount: true });
  });

  it("rollup: ok on a majority or a tie, the hop count rounded, the mode status kept", async () => {
    const b = (ok: number, fail: number, hops: number | null) => ({
      bucketStart: at(0), sampleCount: ok + fail, okCount: ok, failCount: fail,
      avgLatencyMs: 40, minLatencyMs: 30, maxLatencyMs: 80,
      avgDnsMs: 2, avgConnectMs: 5, avgTlsMs: 9, avgTtfbMs: 20,
      avgHopCount: hops, modeHttpStatus: 200,
    });
    raw().mockResolvedValue([b(4, 2, 6.6), b(3, 3, 6.4), b(1, 2, null)]);
    const r = await readPathCheckHistory("a1", since, until, "hourly", "chk-1");
    expect(sqlOf()).toContain('"asset_path_check_samples_hourly"');
    expect(r.samples.map((s) => s.ok)).toEqual([true, true, false]);
    expect(r.samples.map((s) => s.hopCount)).toEqual([7, 6, null]);
    expect(r.samples[0]).toMatchObject({ latencyMs: 40, dnsMs: 2, connectMs: 5, tlsMs: 9, ttfbMs: 20, httpStatus: 200, okCount: 4, failCount: 2, sampleCount: 6, minLatencyMs: 30, maxLatencyMs: 80 });
  });
});

describe("readHardwareSensorHistory — rollup tiers", () => {
  const b = (min: number, n: number, avg: number | null, lo: number | null, hi: number | null) => ({
    bucketStart: at(min), sensorName: "CPU", sensorClass: "temperature", unit: "°C",
    sampleCount: n, avgValue: avg, minValue: lo, maxValue: hi,
  });

  it("stats are sample-weighted over the VISIBLE buckets; the overflow bucket is drawn but not counted", async () => {
    raw().mockResolvedValue([
      b(-60, 100, 99, 99, 99), // overflow — must not move the stats
      b(0, 10, 40, 35, 50),
      b(30, 30, 60, 55, 70),
    ]);
    const r = await readHardwareSensorHistory("a1", since, until, "hourly", "CPU", at(-60));
    expect(r.samples).toHaveLength(3);
    expect(r.stats).toEqual({ total: 40, avgValue: (40 * 10 + 60 * 30) / 40, minValue: 35, maxValue: 70 });
    expect(r.samples[1]).toMatchObject({ value: 40, sampleCount: 10, minValue: 35, maxValue: 50, unit: "°C" });
  });

  it("filters by sensor only when one is named, and binds it as $4", async () => {
    await readHardwareSensorHistory("a1", since, until, "daily", null);
    expect(sqlOf(0)).toContain('"asset_hardware_sensor_samples_daily"');
    expect(sqlOf(0)).not.toContain('"sensorName" = $4');
    expect(paramsOf(0)).toEqual(["a1", since, until]);
    await readHardwareSensorHistory("a1", since, until, "hourly", "Fan 1");
    expect(sqlOf(1)).toContain('"sensorName" = $4');
    expect(paramsOf(1)).toEqual(["a1", since, until, "Fan 1"]);
  });

  it("buckets with no readings give null stats, never 0", async () => {
    raw().mockResolvedValue([b(0, 5, null, null, null)]);
    const r = await readHardwareSensorHistory("a1", since, until, "hourly", "CPU");
    expect(r.stats).toEqual({ total: 5, avgValue: null, minValue: null, maxValue: null });
  });

  it("detail: non-numeric values are left out of the stats", async () => {
    stubbed(prisma.assetHardwareSensorSample.findMany).mockResolvedValue([
      { timestamp: at(1), sensorName: "PSU", sensorClass: "power", unit: null, value: null, alarmStatus: "alarm" },
      { timestamp: at(2), sensorName: "PSU", sensorClass: "power", unit: "W", value: 120, alarmStatus: "ok" },
    ]);
    const r = await readHardwareSensorHistory("a1", since, until, "detail", "PSU");
    expect(r.stats).toEqual({ total: 2, avgValue: 120, minValue: 120, maxValue: 120 });
    expect(r.samples[0]).toMatchObject({ alarmStatus: "alarm", value: null });
  });
});

describe("readStorageHistory — rollup tiers", () => {
  it("the average used bytes is the value and the bucket's LAST total is the total", async () => {
    raw().mockResolvedValue([{ bucketStart: at(0), sampleCount: 12, avgUsedBytes: 500n, minUsedBytes: 400n, maxUsedBytes: 600n, lastTotalBytes: 1000n }]);
    const r = await readStorageHistory("a1", since, until, "daily", "/var", at(-1440));
    expect(sqlOf()).toContain('"asset_storage_samples_daily"');
    expect(paramsOf()).toEqual(["a1", "/var", at(-1440), until]);
    expect(r.samples).toEqual([{ timestamp: at(0), totalBytes: 1000, usedBytes: 500, sampleCount: 12, minUsedBytes: 400, maxUsedBytes: 600 }]);
  });

  it("null byte columns stay null", async () => {
    raw().mockResolvedValue([{ bucketStart: at(0), sampleCount: 1, avgUsedBytes: null, minUsedBytes: null, maxUsedBytes: null, lastTotalBytes: null }]);
    const r = await readStorageHistory("a1", since, until, "hourly", "/");
    expect(r.samples[0]).toMatchObject({ totalBytes: null, usedBytes: null, minUsedBytes: null, maxUsedBytes: null });
  });
});

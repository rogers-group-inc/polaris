/**
 * tests/unit/sampleHistoryAnchor.test.ts — the detail tier's row-anchored
 * lookback (sampleHistoryService → readDetailWithAnchor).
 *
 * The route's fixed `fetchSince` overflow is a time window, and a stream
 * polled less often than it has nothing in it, so the chart line started
 * minutes into the window. Each detail reader now also fetches the newest
 * rows older than `fetchSince` — one for a gauge, two for a counter whose rate
 * needs a pair — capped at DETAIL_ANCHOR_CAP_MS before `since`. Pins:
 *  - the anchor query's shape (lt fetchSince, gte the cap, newest first, take N);
 *  - anchor rows are prepended oldest-first ahead of the main read;
 *  - no `fetchSince` means no lookback and no second query;
 *  - an all-sensors hardware read is not anchored (one sensor's newest row
 *    would leave the rest unanchored);
 *  - the monitor anchor takes response-time polls only, not sweep rows;
 *  - server-side stats still describe only rows at or after `since`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    assetMonitorSample: { findMany: vi.fn(), findFirst: vi.fn() },
    assetTelemetrySample: { findMany: vi.fn() },
    assetHardwareSensorSample: { findMany: vi.fn() },
    assetStorageSample: { findMany: vi.fn() },
    assetInterfaceSample: { findMany: vi.fn() },
    $queryRawUnsafe: vi.fn(),
  },
}));

import {
  readInterfaceHistory, readStorageHistory, readHardwareSensorHistory,
  readTelemetryHistory, readMonitorHistory,
  DETAIL_ANCHOR_CAP_MS, ANCHOR_ROWS_RATE, ANCHOR_ROWS_GAUGE,
} from "../../src/services/sampleHistoryService.js";
import { prisma } from "../../src/db.js";

type Mock = ReturnType<typeof vi.fn>;
const p = prisma as unknown as Record<string, { findMany: Mock }>;

const T0 = Date.parse("2026-10-16T12:00:00Z");
const min = (n: number) => new Date(T0 + n * 60_000);
const since = min(0);
const until = min(60);
const fetchSince = min(-5);

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(p)) p[k]?.findMany?.mockResolvedValue?.([]);
});

/** Route each findMany call to the main or the anchor result by its shape. */
function respond(m: Mock, main: unknown[], anchorNewestFirst: unknown[]) {
  m.mockImplementation(async (args: { where: { timestamp: { lt?: Date } } }) =>
    args.where.timestamp.lt ? anchorNewestFirst : main);
}

describe("readDetailWithAnchor via the detail readers", () => {
  it("anchors a counter stream on two rows, prepended oldest first", async () => {
    const m = p.assetInterfaceSample!.findMany;
    const row = (n: number) => ({ timestamp: min(n), ifName: "port1", inOctets: BigInt(n * 1000), outOctets: BigInt(0) });
    respond(m, [row(0), row(10)], [row(-10), row(-20)]);

    const r = await readInterfaceHistory("a1", since, until, "detail", "port1", fetchSince);

    expect(m).toHaveBeenCalledTimes(2);
    const anchor = m.mock.calls.map((c) => c[0]).find((a) => a.where.timestamp.lt)!;
    expect(anchor.where.timestamp).toEqual({ lt: fetchSince, gte: new Date(since.getTime() - DETAIL_ANCHOR_CAP_MS) });
    expect(anchor.orderBy).toEqual({ timestamp: "desc" });
    expect(anchor.take).toBe(ANCHOR_ROWS_RATE);
    expect(anchor.where).toMatchObject({ assetId: "a1", ifName: "port1" });

    const main = m.mock.calls.map((c) => c[0]).find((a) => !a.where.timestamp.lt)!;
    expect(main.where.timestamp).toEqual({ gte: fetchSince, lte: until });
    expect(main.orderBy).toEqual({ timestamp: "asc" });
    expect(main.take).toBeUndefined();

    expect(r.samples.map((s) => new Date(s.timestamp).getTime())).toEqual(
      [min(-20), min(-10), min(0), min(10)].map((d) => d.getTime()),
    );
  });

  it("anchors a gauge stream on one row", async () => {
    const m = p.assetStorageSample!.findMany;
    const row = (n: number) => ({ timestamp: min(n), mountPath: "/", totalBytes: BigInt(100), usedBytes: BigInt(n + 50) });
    respond(m, [row(30)], [row(-40)]);

    const r = await readStorageHistory("a1", since, until, "detail", "/", fetchSince);

    const anchor = m.mock.calls.map((c) => c[0]).find((a) => a.where.timestamp.lt)!;
    expect(anchor.take).toBe(ANCHOR_ROWS_GAUGE);
    expect(r.samples).toHaveLength(2);
    expect(new Date(r.samples[0]!.timestamp).getTime()).toBe(min(-40).getTime());
  });

  it("runs no lookback query without a fetchSince", async () => {
    const m = p.assetStorageSample!.findMany;
    await readStorageHistory("a1", since, until, "detail", "/");
    expect(m).toHaveBeenCalledTimes(1);
    expect(m.mock.calls[0]![0].where.timestamp).toEqual({ gte: since, lte: until });
  });

  it("anchors one hardware sensor, never an all-sensors read", async () => {
    const m = p.assetHardwareSensorSample!.findMany;
    await readHardwareSensorHistory("a1", since, until, "detail", null, fetchSince);
    expect(m).toHaveBeenCalledTimes(1);

    m.mockClear();
    await readHardwareSensorHistory("a1", since, until, "detail", "CPU Temp", fetchSince);
    expect(m).toHaveBeenCalledTimes(2);
    const anchor = m.mock.calls.map((c) => c[0]).find((a) => a.where.timestamp.lt)!;
    expect(anchor.where.sensorName).toBe("CPU Temp");
    expect(anchor.take).toBe(ANCHOR_ROWS_GAUGE);
  });

  it("anchors the response-time chart on a poll, not a sweep row", async () => {
    const m = p.assetMonitorSample!.findMany;
    await readMonitorHistory("a1", since, until, "detail", fetchSince);
    const calls = m.mock.calls.map((c) => c[0]);
    const anchor = calls.find((a) => a.where.timestamp.lt)!;
    expect(anchor.where.OR).toEqual([{ probeKind: null }, { probeKind: "primary" }]);
    // The main read still takes every probe kind — the loss line needs the sweep.
    expect(calls.find((a) => !a.where.timestamp.lt)!.where).not.toHaveProperty("OR");
  });

  it("keeps anchor rows out of the server-side stats", async () => {
    const m = p.assetTelemetrySample!.findMany;
    const row = (n: number, cpu: number) => ({ timestamp: min(n), cpuPct: cpu, memPct: 10 });
    respond(m, [row(1, 20), row(2, 40)], [row(-30, 99)]);

    const r = await readTelemetryHistory("a1", since, until, "detail", fetchSince);

    expect(r.samples).toHaveLength(3);
    expect(r.stats.total).toBe(2);
    expect(r.stats.maxCpuPct).toBe(40);
  });
});
